'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const config = require('../src/config');

const silent = { log() {}, warn() {}, error() {} };

// Deterministic stand-in for the LLM: extraction parses simple phrases, replies are canned.
function fakeLlm({ failExtract = false, failReply = false } = {}) {
  return async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) {
      if (failExtract) throw new Error('llm down');
      const text = (o.messages[0].content.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '';
      const out = { refused: [] };
      if (/full home|2bhk|3bhk/i.test(text)) out.project_type = 'Full home';
      if (/office/i.test(text)) out.project_type = 'Office';
      const city = text.match(/\bin ([A-Z][a-z]+)/);
      if (city) out.city = city[1];
      const lakh = text.match(/(\d+(?:\.\d+)?)\s*lakh/i);
      if (lakh) out.budget_amount = Number(lakh[1]) * 100000;
      const months = text.match(/(\d+)\s*months?/i);
      if (months) { out.timeline_months = Number(months[1]); out.timeline_text = `${months[1]} months`; }
      if (/human|real person/i.test(text)) out.wants_human = true;
      if (/not interested/i.test(text)) out.not_interested = true;
      if (/prefer not|rather not/i.test(text)) out.refused = ['budget'];
      return out;
    }
    if (failReply) throw new Error('llm down');
    const first = sys.match(/FIRST message to (\S+)/);
    if (first) return `Hi ${first[1]}, thanks for your enquiry. What kind of space are you planning?`;
    return 'Thanks, noted. What else can you tell me?';
  };
}

function build(opts = {}) {
  const sent = [];
  const app = createApp({ ...config, telegramToken: '', demoMode: true }, {
    store: new Store(':memory:'), llmOverride: fakeLlm(opts.llm), debounceMs: opts.debounceMs ?? 0, log: silent,
  });
  app.engine.transports.telegram = {
    send: opts.send || (async (lead, text) => { sent.push({ chat: lead.chat_id, text }); }),
    typing: async () => {},
    sendRaw: async (chat, text) => { sent.push({ chat, text, raw: true }); },
  };
  return { app, sent };
}

const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 20)); await app.engine.idle(id); };

test('form lead links to Telegram by token, greets, qualifies and gets a designer', async () => {
  const { app, sent } = build();
  const lead = app.engine.createLeadFromIntake({ name: 'Asha Rao', phone: '+91 98000 11111', city: 'Pune', source: 'form' });
  const { lead: bound } = app.engine.bindChat('555', { first_name: 'Asha' }, { token: lead.start_token });
  assert.strictEqual(bound.id, lead.id, 'chat binds to the form lead, not a new one');
  await app.engine.start(lead.id);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Asha/);

  app.engine.receive({ channel: 'telegram', chatId: '555', text: 'Full home please', updateId: 1 });
  await settle(app, lead.id);
  app.engine.receive({ channel: 'telegram', chatId: '555', text: 'budget is 12 lakh', updateId: 2 });
  await settle(app, lead.id);
  app.engine.receive({ channel: 'telegram', chatId: '555', text: 'want to start in 2 months', updateId: 3 });
  await settle(app, lead.id);

  const l = app.store.getLead(lead.id);
  assert.strictEqual(l.stage, 'active');
  assert.strictEqual(l.budget_amount, 1200000);
  assert.ok(l.designer_id, 'designer assigned on qualification');
  assert.ok(l.qualified_at);
  assert.ok(sent.length >= 4, 'a reply for each turn');
  const stageEvents = app.store.getEvents(lead.id).filter((e) => e.type === 'stage_changed');
  assert.ok(stageEvents.length >= 1);
});

test('duplicate Telegram updates are ignored (idempotent inbox)', async () => {
  const { app, sent } = build();
  const lead = app.engine.bindChat('9', { first_name: 'Dup' }).lead;
  const a = app.engine.receive({ chatId: '9', text: 'hello', updateId: 77 });
  const b = app.engine.receive({ chatId: '9', text: 'hello', updateId: 77 });
  assert.strictEqual(a.duplicate, false);
  assert.strictEqual(b.duplicate, true);
  await settle(app, lead.id);
  assert.strictEqual(app.store.all("SELECT * FROM messages WHERE direction='in'").length, 1);
  assert.strictEqual(sent.length, 1);
});

test('a burst of messages is coalesced into one turn', async () => {
  const { app, sent } = build({ debounceMs: 150 });
  const lead = app.engine.bindChat('11', { first_name: 'Burst' }).lead;
  app.engine.receive({ chatId: '11', text: 'hi', updateId: 1 });
  app.engine.receive({ chatId: '11', text: 'looking at a full home', updateId: 2 });
  app.engine.receive({ chatId: '11', text: 'in Pune', updateId: 3 });
  await new Promise((r) => setTimeout(r, 700));
  await settle(app, lead.id);
  assert.strictEqual(sent.length, 1, 'one reply for three quick messages');
  const l = app.store.getLead(lead.id);
  assert.strictEqual(l.project_type, 'Full home');
  assert.strictEqual(l.city, 'Pune');
});

test('LLM outage: regex still captures budget and templated replies keep the chat moving', async () => {
  const { app, sent } = build({ llm: { failExtract: true, failReply: true } });
  const lead = app.engine.bindChat('21', { first_name: 'Down' }).lead;
  app.engine.receive({ chatId: '21', text: 'my budget is 2 lakh, call me on 9876543210', updateId: 1 });
  await settle(app, lead.id);
  const l = app.store.getLead(lead.id);
  assert.strictEqual(l.budget_amount, 200000);
  assert.ok(l.phone);
  assert.strictEqual(l.stage, 'disqualified');
  assert.ok(sent.length === 1 && sent[0].text.length > 20, 'fallback closing message sent');
  assert.ok(app.engine.stats.llmFallbacks >= 1);
});

test('crash recovery: unprocessed inbound messages are replayed on boot', async () => {
  const { app, sent } = build();
  const lead = app.engine.bindChat('31', { first_name: 'Crash' }).lead;
  app.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: 'full home in Pune', tg_update_id: 5 });
  assert.strictEqual(app.engine.recover(), 1);
  await settle(app, lead.id);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(app.store.getLead(lead.id).city, 'Pune');
});

test('outbox: transient send failures retry, permanent ones are recorded', async () => {
  let n = 0;
  const { app } = build({ send: async () => { if (++n < 3) throw new Error('network blip'); } });
  const lead = app.engine.bindChat('41', { first_name: 'Retry' }).lead;
  app.engine.receive({ chatId: '41', text: 'hello', updateId: 1 });
  await settle(app, lead.id);
  await new Promise((r) => setTimeout(r, 2500));
  const out = app.store.all("SELECT * FROM messages WHERE direction='out'")[0];
  assert.strictEqual(out.status, 'sent');
  assert.ok(n >= 3);

  const b = build({ send: async () => { const e = new Error('Forbidden: bot was blocked by the user'); e.permanent = true; throw e; } });
  const l2 = b.app.engine.bindChat('42', { first_name: 'Blocked' }).lead;
  b.app.engine.receive({ chatId: '42', text: 'hello', updateId: 1 });
  await settle(b.app, l2.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(b.app.store.all("SELECT * FROM messages WHERE direction='out'")[0].status, 'failed');
  assert.strictEqual(b.app.store.getLead(l2.id).opted_out, 1);
});

test('paused AI stays silent and wants_human hands off then pauses', async () => {
  const { app, sent } = build();
  const lead = app.engine.bindChat('51', { first_name: 'Hand' }).lead;
  app.engine.receive({ chatId: '51', text: 'can I talk to a real person?', updateId: 1 });
  await settle(app, lead.id);
  let l = app.store.getLead(lead.id);
  assert.strictEqual(l.stage, 'human');
  assert.strictEqual(l.ai_paused, 1);
  assert.strictEqual(sent.length, 1, 'one handoff message');
  app.engine.receive({ chatId: '51', text: 'hello?', updateId: 2 });
  await settle(app, lead.id);
  assert.strictEqual(sent.length, 1, 'AI stays silent while paused');
  assert.strictEqual(app.store.all("SELECT * FROM messages WHERE direction='in' AND processed=0").length, 0);
  app.engine.setPaused(lead.id, false);
  l = app.store.getLead(lead.id);
  assert.notStrictEqual(l.stage, 'human');
});

test('re-qualification: a disqualified lead who later raises their budget becomes active', async () => {
  const { app, sent } = build();
  const lead = app.engine.bindChat('61', { first_name: 'Grow' }).lead;
  const say = async (t, id) => { app.engine.receive({ chatId: '61', text: t, updateId: id }); await settle(app, lead.id); };
  await say('full home in Pune, 3 lakh, 1 months', 1);
  assert.strictEqual(app.store.getLead(lead.id).stage, 'disqualified');
  await say('actually my budget is 15 lakh', 2);
  const l = app.store.getLead(lead.id);
  assert.strictEqual(l.stage, 'active');
  assert.ok(sent.length >= 2);
});

test('scheduler fast-forward: nudges silent leads, then moves them to nurture', async () => {
  const { app, sent } = build();
  const lead = app.engine.bindChat('71', { first_name: 'Quiet' }).lead;
  await app.engine.start(lead.id);
  await settle(app, lead.id);
  const before = sent.length;
  await app.scheduler.tick({ force: true });
  await settle(app, lead.id);
  await app.scheduler.tick({ force: true });
  await settle(app, lead.id);
  assert.strictEqual(sent.length, before + 2, 'two nudges');
  await app.scheduler.tick({ force: true });
  assert.strictEqual(app.store.getLead(lead.id).stage, 'nurture');
});

test('what-if preview does not change data, reevaluateAll applies it', async () => {
  const { app } = build();
  for (const [i, amt] of [[1, 600000], [2, 900000], [3, 300000]]) {
    app.store.createLead({ channel: 'sim', chat_id: `x${i}`, name: `L${i}`, project_type: 'Full home', city: 'Pune', budget_amount: amt, timeline_months: 1, stage: amt >= 500000 ? 'active' : 'disqualified', meta: { turns: 3 } });
  }
  const p = app.engine.preview({ qualification: { min_budget: 800000 } });
  assert.strictEqual(p.moved.length, 1);
  assert.strictEqual(app.store.listLeads().filter((l) => l.stage === 'active').length, 2, 'preview is read-only');
  app.settings.update({ qualification: { min_budget: 800000 } });
  assert.strictEqual(app.engine.reevaluateAll(), 1);
  assert.strictEqual(app.store.listLeads().filter((l) => l.stage === 'active').length, 1);
});

test('telegram layer: /start token and gform phone matching', async () => {
  const { app } = build();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    calls.push({ method, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const { Telegram } = require('../src/telegram');
  const tg = new Telegram({ token: 'x', engine: app.engine, store: app.store, settings: app.settings, config, log: silent, fetchImpl });
  app.engine.transports.telegram = tg.transport;

  const formLead = app.engine.createLeadFromIntake({ name: 'Token Person', phone: '+91 90000 22222', source: 'form' });
  await tg.handleUpdate({ update_id: 1, message: { chat: { id: 700, type: 'private' }, from: { id: 700, first_name: 'T' }, text: `/start ${formLead.start_token}` } });
  await new Promise((r) => setTimeout(r, 300)); await settle(app, formLead.id);
  assert.strictEqual(app.store.getLeadByChat('700').id, formLead.id);
  assert.ok(calls.some((c) => c.method === 'sendMessage' && /Token/.test(c.body.text)), 'greeted by form name');

  const gLead = app.engine.createLeadFromIntake({ name: 'GForm Person', phone: '98111 33333', source: 'google-form' });
  await tg.handleUpdate({ update_id: 2, message: { chat: { id: 701, type: 'private' }, from: { id: 701, first_name: 'G' }, text: '/start gform' } });
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.reply_markup && c.body.reply_markup.keyboard), 'asks to share contact');
  await tg.handleUpdate({ update_id: 3, message: { chat: { id: 701, type: 'private' }, from: { id: 701, first_name: 'G' }, contact: { phone_number: '919811133333', user_id: 701 } } });
  await new Promise((r) => setTimeout(r, 300)); await settle(app, gLead.id);
  assert.strictEqual(app.store.getLeadByChat('701').id, gLead.id, 'matched the form lead by phone');
  assert.strictEqual(app.store.all('SELECT * FROM leads').filter((l) => l.chat_id === '701').length, 1, 'placeholder lead was merged away');
});
