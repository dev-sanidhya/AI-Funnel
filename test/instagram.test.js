'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const { createServer } = require('../src/server');
const { chunk } = require('../src/instagram');
const baseConfig = require('../src/config');

const silent = { log() {}, warn() {}, error() {} };
const IG_ID = '17841400000000000';

function fakeLlm() {
  return async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) {
      const text = (o.messages[0].content.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '';
      const out = { refused: [] };
      if (/full home/i.test(text)) out.project_type = 'Full home';
      const lakh = text.match(/(\d+(?:\.\d+)?)\s*lakh/i);
      if (lakh) out.budget_amount = Number(lakh[1]) * 100000;
      return out;
    }
    const first = sys.match(/FIRST message to (\S+)/);
    if (first) return `Hi ${first[1]}, thanks for your enquiry. What kind of space are you planning?`;
    return 'Thanks, noted. What else can you tell me?';
  };
}

function build() {
  const graph = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    graph.push({ url, method: init.method, body, auth: init.headers && init.headers.Authorization });
    let data = { message_id: 'm_out', recipient_id: 'x' };
    if (/\/me\?/.test(url)) data = { user_id: IG_ID, username: 'brandstudio' };
    else if (/\/\d+\?fields=name/.test(url)) data = { name: 'Riya Kapoor', username: 'riya.k' };
    return { ok: true, status: 200, json: async () => data };
  };
  const config = {
    ...baseConfig, telegramToken: '', demoMode: true, adminPassword: 'pw', intakeSecret: 's3cret',
    instagram: { accessToken: 'tok', appSecret: 'appsecret', verifyToken: 'verify-me', handle: 'brandstudio', apiVersion: 'v23.0' },
  };
  const app = createApp(config, { store: new Store(':memory:'), llmOverride: fakeLlm(), fetchImpl, debounceMs: 0, log: silent });
  return { app, graph, config };
}

const sends = (graph) => graph.filter((g) => /\/me\/messages$/.test(g.url) && g.body && g.body.message);
const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 30)); await app.engine.idle(id); };
const msgEvent = (sender, text, mid, extra = {}) => ({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid, text }, ...extra }] }] });
const refEvent = (sender, ref) => ({ object: 'instagram', entry: [{ id: IG_ID, messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }] });

test('webhook verification and signature checking', () => {
  const { app } = build();
  const ig = app.instagram;
  assert.strictEqual(ig.verifyChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' })), '42');
  assert.strictEqual(ig.verifyChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' })), null);
  const raw = Buffer.from('{"a":1}');
  const good = `sha256=${crypto.createHmac('sha256', 'appsecret').update(raw).digest('hex')}`;
  assert.strictEqual(ig.validSignature(raw, good), true);
  assert.strictEqual(ig.validSignature(raw, 'sha256=deadbeef'), false);
  assert.strictEqual(ig.validSignature(raw, undefined), false);
  ig.cfg.appSecret = '';
  assert.strictEqual(ig.validSignature(raw, good), false, 'unsigned deployments reject everything rather than trust forged leads');
});

test('form lead + ig.me referral: lead is linked, greeted by name, then qualified', async () => {
  const { app, graph } = build();
  const lead = app.engine.createLeadFromIntake({ name: 'Riya Kapoor', phone: '+91 97000 11111', city: 'Pune', source: 'form' });
  await app.instagram.handleWebhook(refEvent('9001', lead.start_token));
  await app.instagram.handleWebhook(msgEvent('9001', 'Hi', 'mid.1'));
  await settle(app, lead.id);
  let l = app.store.getLead(lead.id);
  assert.strictEqual(l.chat_id, 'ig:9001');
  assert.strictEqual(l.channel, 'instagram');
  const first = sends(graph)[0];
  assert.strictEqual(first.body.recipient.id, '9001');
  assert.match(first.body.message.text, /Riya/, 'greets with the form name on the first inbound message');
  assert.strictEqual(first.auth, 'Bearer tok');

  await app.instagram.handleWebhook(msgEvent('9001', 'full home, budget is 12 lakh', 'mid.2'));
  await settle(app, lead.id);
  l = app.store.getLead(lead.id);
  assert.strictEqual(l.project_type, 'Full home');
  assert.strictEqual(l.budget_amount, 1200000);
  assert.ok(sends(graph).length >= 2);
});

test('referral arriving after the first message merges the organic placeholder into the form lead', async () => {
  const { app } = build();
  const lead = app.engine.createLeadFromIntake({ name: 'Late Ref', phone: '+91 97000 22222', source: 'form' });
  await app.instagram.handleWebhook(msgEvent('9002', 'hello there', 'mid.a'));
  const organic = app.store.getLeadByChat('ig:9002');
  assert.ok(organic && organic.id !== lead.id);
  await settle(app, organic.id);
  await app.instagram.handleWebhook(refEvent('9002', lead.start_token));
  await settle(app, lead.id);
  assert.strictEqual(app.store.getLeadByChat('ig:9002').id, lead.id);
  assert.strictEqual(app.store.getLead(organic.id), null, 'placeholder removed');
  assert.ok(app.store.getMessages(lead.id).some((m) => m.text === 'hello there'), 'their first message moved over');
});

test('duplicate message ids, echoes and non-text messages are handled', async () => {
  const { app, graph } = build();
  await app.instagram.handleWebhook(msgEvent('9003', 'hi', 'mid.dup'));
  await app.instagram.handleWebhook(msgEvent('9003', 'hi', 'mid.dup'));
  const lead = app.store.getLeadByChat('ig:9003');
  await settle(app, lead.id);
  assert.strictEqual(app.store.all("SELECT * FROM messages WHERE direction='in'").length, 1);
  const before = sends(graph).length;
  await app.instagram.handleWebhook(msgEvent('9003', 'echo of our own message', 'mid.echo', {}));
  const echo = msgEvent('9003', 'ignored', 'mid.e2'); echo.entry[0].messaging[0].message.is_echo = true;
  await app.instagram.handleWebhook(echo);
  await app.instagram.handleWebhook({ entry: [{ id: IG_ID, messaging: [{ sender: { id: IG_ID }, recipient: { id: '9003' }, message: { mid: 'mid.self', text: 'from us' } }] }] });
  await settle(app, lead.id);
  assert.ok(!app.store.getMessages(lead.id).some((m) => m.text === 'ignored' || m.text === 'from us'));
  const att = msgEvent('9003', '', 'mid.att'); delete att.entry[0].messaging[0].message.text; att.entry[0].messaging[0].message.attachments = [{ type: 'image' }];
  await app.instagram.handleWebhook(att);
  assert.ok(sends(graph).length > before, 'asks them to type instead');
});

test('24 hour window: AI replies are blocked after it closes, humans may use the HUMAN_AGENT tag', async () => {
  const { app, graph } = build();
  const old = Date.now() - 30 * 3600 * 1000;
  const lead = app.store.createLead({ channel: 'instagram', chat_id: 'ig:9004', name: 'Old', last_inbound_at: old });
  await assert.rejects(() => app.instagram.sendText(lead, 'hello', { role: 'assistant' }), /24 hour/);
  await app.instagram.sendText(lead, 'a human follow-up', { role: 'admin' });
  const m = sends(graph).pop();
  assert.strictEqual(m.body.messaging_type, 'MESSAGE_TAG');
  assert.strictEqual(m.body.tag, 'HUMAN_AGENT');
  const ancient = app.store.createLead({ channel: 'instagram', chat_id: 'ig:9005', name: 'Ancient', last_inbound_at: Date.now() - 9 * 24 * 3600 * 1000 });
  await assert.rejects(() => app.instagram.sendText(ancient, 'hi', { role: 'admin' }), /window/);
});

test('long messages are split under the 1000 character limit', () => {
  const parts = chunk(('This is a sentence that goes on. ').repeat(80));
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 1000);
});

test('scheduler never nudges Instagram leads outside the 24h window', async () => {
  const { app, graph } = build();
  const lead = app.store.createLead({ channel: 'instagram', chat_id: 'ig:9006', name: 'Quiet', stage: 'qualifying', last_inbound_at: Date.now() - 26 * 3600 * 1000, last_outbound_at: Date.now() - 25 * 3600 * 1000, meta: { turns: 1 } });
  const before = sends(graph).length;
  const r = await app.scheduler.tick({ force: true });
  assert.strictEqual(r.followups, 0);
  assert.strictEqual(sends(graph).length, before);
  assert.strictEqual(app.store.getLead(lead.id).stage, 'nurture', 'goes to nurture for a human to pick up');
});

test('HTTP: form intake points at Instagram, and the signed webhook works end to end', async () => {
  const { app, graph, config } = build();
  await app.instagram.start();
  assert.strictEqual(app.instagram.handle, 'brandstudio');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const intake = await (await fetch(`${base}/api/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Web Form', phone: '+91 96000 33333', city: 'Pune' }) })).json();
    assert.strictEqual(intake.primary, 'instagram');
    assert.match(intake.chat_url, /^https:\/\/ig\.me\/m\/brandstudio\?ref=[A-Za-z0-9_-]+$/);
    const token = new URL(intake.chat_url).searchParams.get('ref');
    const lead = app.store.getLeadByToken(token);
    assert.ok(lead);

    const ch = await fetch(`${base}/webhook/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777`);
    assert.strictEqual(await ch.text(), '777');
    assert.strictEqual((await fetch(`${base}/webhook/instagram?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1`)).status, 403);

    const payload = JSON.stringify(refEventWithMessage('9100', token, 'Hello!', 'mid.http'));
    const bad = await fetch(`${base}/webhook/instagram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body: payload });
    assert.strictEqual(bad.status, 401);
    const sig = `sha256=${crypto.createHmac('sha256', 'appsecret').update(payload).digest('hex')}`;
    const ok = await fetch(`${base}/webhook/instagram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: payload });
    assert.strictEqual(ok.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    await settle(app, lead.id);
    assert.strictEqual(app.store.getLeadByChat('ig:9100').id, lead.id);
    assert.ok(sends(graph).some((g) => g.body.recipient.id === '9100'));
  } finally {
    server.close();
  }
  void config;
});

function refEventWithMessage(sender, ref, text, mid) {
  return { object: 'instagram', entry: [{ id: IG_ID, messaging: [
    { sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } },
    { sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid, text } },
  ] }] };
}
