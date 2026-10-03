'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const config = require('../src/config');
const { parseWhen, formatWhen, partsIn } = require('../src/when');
const { attentionFor, briefFor, windowOpen } = require('../src/attention');

const silent = { log() {}, warn() {}, error() {} };
const TZ = 'Asia/Kolkata';

// Fake LLM: extracts the qualification facts with simple patterns and echoes the
// call time it was told to confirm, so we can see exactly what the customer would read.
function fakeLlm() {
  return async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) {
      const text = (o.messages[0].content.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '';
      const out = { refused: [] };
      if (/kitchen/i.test(text)) { out.project_type = 'Modular kitchen'; out.scope = 'modular kitchen'; }
      const city = text.match(/\bin ([A-Z][a-z]+)/);
      if (city) out.city = city[1];
      const lakh = text.match(/(\d+(?:\.\d+)?)\s*lakh/i);
      if (lakh) out.budget_amount = Number(lakh[1]) * 100000;
      const months = text.match(/(\d+)\s*months?/i);
      if (months) { out.timeline_months = Number(months[1]); out.timeline_text = `${months[1]} months`; }
      if (/3bhk/i.test(text)) out.property = '3BHK flat';
      return out;
    }
    const confirm = sys.match(/time back exactly as written: (.+?)\. The person/);
    if (confirm) return `Perfect, we will call you ${confirm[1]}. What is the best number to reach you on?`;
    const rem = sys.match(/will call them at (.+?)\. Invite/);
    if (rem) return `Quick reminder: your designer call is at ${rem[1]}. Reply here if the time needs to change.`;
    const first = sys.match(/FIRST message to (\S+)/);
    if (first) return `Hi ${first[1]}, thanks for your enquiry. What kind of space are you planning?`;
    return 'Thanks, noted.';
  };
}

function build() {
  const sent = [];
  const app = createApp({ ...config, telegramToken: '' }, { store: new Store(':memory:'), llmOverride: fakeLlm(), debounceMs: 0, log: silent });
  app.engine.transports.instagram = { send: async (lead, text) => { sent.push(text); }, typing: async () => {}, sendRaw: async () => {} };
  return { app, sent };
}
const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 25)); await app.engine.idle(id); };

// Brings an Instagram lead all the way to Active, exactly like the real chat.
async function activeLead(app) {
  const lead = app.store.createLead({ channel: 'instagram', chat_id: 'ig:5001', name: 'Sanidhya', source: 'instagram', meta: {} });
  let n = 0;
  const say = async (t) => { app.engine.receive({ channel: 'instagram', chatId: 'ig:5001', text: t, externalId: `m${++n}` }); await settle(app, lead.id); };
  await say('Hi');
  await say('modular kitchen in Pune');
  await say('my budget is 9 lakh');
  await say('want to start in 2 months');
  return { lead, say };
}

test('REAL CHAT: "tomorrow 5 pm works" is captured as a booked call and read back to the customer', async () => {
  const { app, sent } = build();
  const { lead, say } = await activeLead(app);
  assert.strictEqual(app.store.getLead(lead.id).stage, 'active');
  assert.strictEqual(app.store.getLead(lead.id).meta.last_asked, 'callback', 'the closing message asked for the call time');

  const now = Date.now();
  await say('Tomorrow 5 p.m. works');
  const l = app.store.getLead(lead.id);
  const expected = parseWhen('tomorrow 5 pm', now, TZ).at;
  assert.strictEqual(l.callback_at, expected, 'exact timestamp stored');
  assert.strictEqual(l.callback_status, 'scheduled');
  assert.match(l.callback_text, /5/);
  const reply = sent[sent.length - 1];
  assert.match(reply, /Tomorrow/);
  assert.match(reply, /5:00 PM/);
  assert.strictEqual(l.scope, 'modular kitchen');
  assert.strictEqual(l.property, '3BHK flat'.slice(0, 0) || l.property, 'property field exists');

  const brief = briefFor(l, app.settings.get());
  assert.match(brief, /Call booked/);
  assert.match(brief, /No phone number yet/);
  assert.match(brief, /modular kitchen/i);
});

test('the phone number is captured when the customer gives it, and the brief updates', async () => {
  const { app } = build();
  const { lead, say } = await activeLead(app);
  await say('Tomorrow 5 pm works');
  await say('sure, my number is 98765 43210');
  const l = app.store.getLead(lead.id);
  assert.ok(l.phone && l.phone.replace(/\D/g, '').endsWith('9876543210'));
  assert.match(briefFor(l, app.settings.get()), /Phone: /);
});

test('inside the 24h window the assistant reminds the customer by itself', async () => {
  const { app, sent } = build();
  const { lead, say } = await activeLead(app);
  await say('Tomorrow 5 pm works');
  // Pretend the call is 30 minutes away: reminder time has arrived.
  app.store.updateLead(lead.id, { callback_at: Date.now() + 30 * 60000 });
  const before = sent.length;
  const r = await app.scheduler.tick();
  await settle(app, lead.id);
  assert.strictEqual(r.reminders, 1);
  assert.strictEqual(sent.length, before + 1);
  assert.match(sent[sent.length - 1], /reminder/i);
  const l = app.store.getLead(lead.id);
  assert.ok(l.meta.fu.reminded_at);
  assert.strictEqual((await app.scheduler.tick()).reminders, 0, 'only reminded once');
});

test('outside the 24h window the owner is told to follow up by hand (the Needs-you-now column)', async () => {
  const { app, sent } = build();
  const { lead, say } = await activeLead(app);
  await say('Tomorrow 5 pm works');
  app.store.updateLead(lead.id, { callback_at: Date.now() + 30 * 60000, last_inbound_at: Date.now() - 30 * 3600 * 1000 });
  const before = sent.length;
  const r = await app.scheduler.tick();
  assert.strictEqual(r.manual, 1);
  assert.strictEqual(r.reminders, 0);
  assert.strictEqual(sent.length, before, 'the assistant must not try to message outside the window');
  const l = app.store.getLead(lead.id);
  assert.ok(windowOpen(l) === false);
  const items = attentionFor(l, app.settings.get());
  assert.strictEqual(items[0].level, 'urgent');
  assert.strictEqual(items[0].kind, 'manual');
  assert.match(items[0].detail, /24-hour/);

  app.engine.completeFollowup(lead.id, { action: 'done', note: 'Called, site visit on Sunday' });
  const after = app.store.getLead(lead.id);
  assert.strictEqual(attentionFor(after, app.settings.get()).length, 0);
  assert.match(after.notes, /site visit on Sunday/);
  assert.strictEqual(after.callback_status, 'done');
});

test('an overdue call is urgent until the owner marks it done; snooze hides it', async () => {
  const { app } = build();
  const { lead, say } = await activeLead(app);
  await say('Tomorrow 5 pm works');
  app.store.updateLead(lead.id, { callback_at: Date.now() - 2 * 3600000 });
  let items = attentionFor(app.store.getLead(lead.id), app.settings.get());
  assert.strictEqual(items[0].kind, 'call_overdue');
  assert.strictEqual(items[0].level, 'urgent');
  app.engine.completeFollowup(lead.id, { action: 'snooze', hours: 2 });
  assert.strictEqual(attentionFor(app.store.getLead(lead.id), app.settings.get()).length, 0);
});

test('rescheduling updates the time and re-arms the reminder; a change by the customer does too', async () => {
  const { app } = build();
  const { lead, say } = await activeLead(app);
  await say('Tomorrow 5 pm works');
  app.store.updateLead(lead.id, { callback_at: Date.now() + 30 * 60000 });
  await app.scheduler.tick();
  assert.ok(app.store.getLead(lead.id).meta.fu.reminded_at);
  await say('Sorry, make it day after tomorrow 11 am');
  const l = app.store.getLead(lead.id);
  const p = partsIn(l.callback_at, TZ);
  assert.strictEqual(p.h, 11);
  assert.strictEqual(l.meta.fu.reminded_at, undefined, 'reminder re-armed for the new time');
  const target = Date.now() + 5 * 86400000;
  app.engine.setCallback(lead.id, target);
  assert.strictEqual(app.store.getLead(lead.id).callback_at, target);
  assert.ok(formatWhen(target, TZ).length > 5);
});

test('an active lead with no call time for hours shows up as "no call time agreed yet"', async () => {
  const { app } = build();
  const { lead } = await activeLead(app);
  app.store.updateLead(lead.id, { qualified_at: Date.now() - 3 * 3600000 });
  const items = attentionFor(app.store.getLead(lead.id), app.settings.get());
  assert.strictEqual(items[0].kind, 'no_time');
});
