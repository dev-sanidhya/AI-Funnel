'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const { Llm } = require('../src/llm');
const { attentionFor } = require('../src/attention');
const config = require('../src/config');

const silent = { log() {}, warn() {}, error() {} };
const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 25)); await app.engine.idle(id); };

function downApp() {
  const sent = [];
  const app = createApp({ ...config, telegramToken: '' }, {
    store: new Store(':memory:'), debounceMs: 0, log: silent,
    llmOverride: async () => { throw new Error('LLM 429: you have used up your daily free allocation'); },
  });
  app.engine.transports.instagram = { send: async (lead, text) => { sent.push(text); }, typing: async () => {}, sendRaw: async () => {} };
  return { app, sent };
}

test('REAL CHAT with the AI completely down: answers are understood, no question repeats, the owner is alerted', async () => {
  const { app, sent } = downApp();
  const lead = app.store.createLead({ channel: 'instagram', chat_id: 'ig:900', name: 'Sanidhya', source: 'instagram', meta: {} });
  let n = 0;
  const say = async (t) => { app.engine.receive({ channel: 'instagram', chatId: 'ig:900', text: t, externalId: `m${++n}` }); await settle(app, lead.id); };

  await say('hi');
  const q1 = sent[sent.length - 1];
  await say('a full homw');                       // the exact typo from the real chat
  assert.strictEqual(app.store.getLead(lead.id).project_type, 'Full home');
  await say('Delhi');
  assert.strictEqual(app.store.getLead(lead.id).city, 'Delhi');
  const questions = sent.filter((s) => /\?/.test(s));
  assert.strictEqual(new Set(questions).size, questions.length, 'never the same question twice');
  assert.notStrictEqual(sent[sent.length - 1], q1);

  const l = app.store.getLead(lead.id);
  assert.ok(l.meta.fu.ai_failed_at, 'the failure is recorded');
  const items = attentionFor(l, app.settings.get());
  assert.strictEqual(items[0].kind, 'ai_down');
  assert.strictEqual(items[0].level, 'urgent');
});

test('the long message the form writes is read in full even with no AI', async () => {
  const { app } = downApp();
  const lead = app.store.createLead({ channel: 'instagram', chat_id: 'ig:901', name: 'Sanidhya', source: 'instagram', meta: {} });
  app.engine.receive({ channel: 'instagram', chatId: 'ig:901', externalId: 'f1', text: "Hi! I'm Sanidhya. I'd like help with full home interiors, bedrooms and bathrooms for my 2BHK apartment in Rohini, Delhi. My budget is around ₹10 to 20 lakh. I'd like to get started within a month. Afternoon is the best time to reach me. I like Premium interior designing." });
  await settle(app, lead.id);
  const l = app.store.getLead(lead.id);
  assert.strictEqual(l.project_type, 'Full home');
  assert.strictEqual(l.city, 'Rohini, Delhi');
  assert.strictEqual(l.budget_amount, 2000000);
  assert.strictEqual(l.timeline_months, 1);
  assert.match(l.property, /2BHK/);
  assert.strictEqual(l.stage, 'active', 'enough to qualify without a single AI call');
});

function res(status, body, headers = {}) {
  return { ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body, text: async () => JSON.stringify(body) };
}

test('provider failover: quota on the main provider moves to the backup, then skips the dead one', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('main.example')) return res(429, { errors: [{ message: 'you have used up your daily free allocation of 10,000 neurons' }] });
    return res(200, { choices: [{ message: { content: 'hello from backup' } }], usage: { total_tokens: 20 } });
  };
  const llm = new Llm({
    maxRpm: 0, timeoutMs: 2000, providers: [
      { name: 'main', baseUrl: 'https://main.example/v1', apiKey: 'k1', models: ['m1'], tpm: 0 },
      { name: 'backup', baseUrl: 'https://backup.example/v1', apiKey: 'k2', models: ['b1'], tpm: 0 },
    ],
  }, { fetchImpl });
  assert.strictEqual(await llm.complete({ messages: [{ role: 'user', content: 'hi' }] }), 'hello from backup');
  assert.strictEqual(llm.stats.lastProvider, 'backup:b1');
  assert.strictEqual(llm.providerStatus()[0].cooling, true);
  const before = calls.length;
  await llm.complete({ messages: [{ role: 'user', content: 'again' }] });
  assert.ok(calls.slice(before).every((u) => u.includes('backup.example')), 'the exhausted provider is not retried on every message');
});

test('if every provider is exhausted the call fails fast so the fallbacks take over', async () => {
  const fetchImpl = async () => res(429, { errors: [{ message: 'daily free allocation used up' }] });
  const llm = new Llm({ maxRpm: 0, timeoutMs: 2000, providers: [{ name: 'only', baseUrl: 'https://x.example/v1', apiKey: 'k', models: ['m'], tpm: 0 }] }, { fetchImpl });
  await assert.rejects(() => llm.complete({ messages: [{ role: 'user', content: 'hi' }] }));
  const t = Date.now();
  await assert.rejects(() => llm.complete({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.ok(Date.now() - t < 500, 'no waiting around while the provider is cooling down');
});
