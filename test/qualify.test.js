'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, pickDesigner } = require('../src/qualify');
const { parseAmount, formatMoney } = require('../src/budget');
const { DEFAULTS, merge, sanitize } = require('../src/settings');

const S = () => sanitize(merge(DEFAULTS, {}));
const lead = (o = {}) => ({ meta: {}, stage: 'qualifying', ...o });

test('parseAmount handles lakh, crore, k, ranges and commas', () => {
  assert.strictEqual(parseAmount('8 lakh'), 800000);
  assert.strictEqual(parseAmount('around 12L'), 1200000);
  assert.strictEqual(parseAmount('8-10 lakhs'), 1000000);
  assert.strictEqual(parseAmount('1.5 cr'), 15000000);
  assert.strictEqual(parseAmount('50k'), 50000);
  assert.strictEqual(parseAmount('Rs 8,00,000'), 800000);
  assert.strictEqual(parseAmount('3 bhk'), null);
  assert.strictEqual(parseAmount('my budget is 2 lakh, call me on 9876543210'), 200000);
  assert.strictEqual(parseAmount('8', { allowBare: true }), 800000);
  assert.strictEqual(parseAmount('800000', { allowBare: true }), 800000);
});

test('times, sizes and durations are never mistaken for money', () => {
  const { amountSupportedByText, isBareNumberAnswer } = require('../src/budget');
  assert.strictEqual(parseAmount('how about next Wednesday at 10 am?', { allowBare: true }), null);
  assert.strictEqual(parseAmount('3 bhk, start in 2 months', { allowBare: true }), null);
  assert.strictEqual(isBareNumberAnswer('next Wednesday at 10 am'), false);
  assert.strictEqual(isBareNumberAnswer('8-10'), true);
  assert.strictEqual(isBareNumberAnswer('Rs 8,00,000'), true);
  // An LLM-reported budget must be explained by a number in the customer's own text.
  assert.strictEqual(amountSupportedByText(1000000, 'tomorrow at 10 am please'), false);
  assert.strictEqual(amountSupportedByText(1000000, 'about 10 lakh'), true);
  assert.strictEqual(amountSupportedByText(1000000, 'ten lakh'), true);
  assert.strictEqual(amountSupportedByText(1000000, 'my budget is unlimited'), false);
});

test('applyFacts rejects hallucinated budgets and keeps explicit ones', () => {
  const { applyFacts } = require('../src/facts');
  const s = S();
  const base = { meta: {}, stage: 'qualifying' };
  const bogus = applyFacts(base, { budget_amount: 1000000 }, 'Lets schedule it, Wednesday at 10 am works', { lastAsked: 'budget', settings: s });
  assert.strictEqual(bogus.patch.budget_amount, undefined);
  const good = applyFacts(base, { budget_amount: 1200000 }, 'around 12 lakh', { lastAsked: 'budget', settings: s });
  assert.strictEqual(good.patch.budget_amount, 1200000);
  const bare = applyFacts(base, {}, '8', { lastAsked: 'budget', settings: s });
  assert.strictEqual(bare.patch.budget_amount, 800000);
  const regexWins = applyFacts(base, { budget_amount: 80000000 }, '8 lakh', { lastAsked: null, settings: s });
  assert.strictEqual(regexWins.patch.budget_amount, 800000);
});

test('formatMoney', () => {
  assert.strictEqual(formatMoney(500000), '₹5L');
  assert.strictEqual(formatMoney(12000000), '₹1.2Cr');
  assert.strictEqual(formatMoney(null), 'unknown');
});

test('below the minimum budget disqualifies immediately, even mid-conversation', () => {
  const r = evaluate(lead({ budget_amount: 200000 }), S());
  assert.strictEqual(r.stage, 'disqualified');
  assert.match(r.reason, /below/);
});

test('exactly the minimum qualifies on budget', () => {
  const r = evaluate(lead({ budget_amount: 500000, project_type: 'Full home', city: 'Pune', timeline_months: 1 }), S());
  assert.strictEqual(r.stage, 'active');
});

test('borderline band sends near-miss budgets to nurture, not disqualified', () => {
  const s = S();
  s.qualification.borderline_pct = 10;
  assert.strictEqual(evaluate(lead({ budget_amount: 460000 }), s).stage, 'nurture');
  assert.strictEqual(evaluate(lead({ budget_amount: 400000 }), s).stage, 'disqualified');
});

test('qualified budget but far timeline is nurtured', () => {
  const r = evaluate(lead({ budget_amount: 900000, project_type: 'Office', city: 'Pune', timeline_months: 8, timeline_text: 'next year' }), S());
  assert.strictEqual(r.stage, 'nurture');
});

test('missing fields keep the lead qualifying and report the next field', () => {
  const r = evaluate(lead({ project_type: 'Full home' }), S());
  assert.strictEqual(r.stage, 'qualifying');
  assert.strictEqual(r.nextField, 'city');
});

test('declined budget after other fields are done goes to nurture', () => {
  const l = lead({ project_type: 'Full home', city: 'Pune', timeline_months: 2, meta: { declined: { budget: true } } });
  assert.strictEqual(evaluate(l, S()).stage, 'nurture');
});

test('human request and manual lock win', () => {
  assert.strictEqual(evaluate(lead({ meta: { flags: { wants_human: true } }, budget_amount: 100 }), S()).stage, 'human');
  const locked = evaluate(lead({ stage: 'active', stage_locked: 1, stage_reason: 'Manual', budget_amount: 100 }), S());
  assert.strictEqual(locked.stage, 'active');
});

test('service area check', () => {
  const s = S();
  s.qualification.service_cities = ['Pune', 'Mumbai'];
  assert.strictEqual(evaluate(lead({ city: 'Dubai' }), s).stage, 'disqualified');
  assert.notStrictEqual(evaluate(lead({ city: 'Kharadi, Pune' }), s).stage, 'disqualified');
});

test('raising the minimum re-categorises previously active leads', () => {
  const l = lead({ budget_amount: 700000, project_type: 'Full home', city: 'Pune', timeline_months: 1 });
  const s = S();
  assert.strictEqual(evaluate(l, s).stage, 'active');
  s.qualification.min_budget = 1000000;
  assert.strictEqual(evaluate(l, s).stage, 'disqualified');
});

test('designer matching prefers specialty and city, balances load', () => {
  const ds = [
    { id: 1, name: 'A', active: 1, specialties: 'Office', cities: 'Pune', min_budget: 0 },
    { id: 2, name: 'B', active: 1, specialties: 'Full home', cities: 'Pune', min_budget: 0 },
    { id: 3, name: 'C', active: 1, specialties: '', cities: '', min_budget: 2000000 },
  ];
  assert.strictEqual(pickDesigner(ds, { project_type: 'Full home', city: 'Pune', budget_amount: 900000 }).id, 2);
  assert.strictEqual(pickDesigner(ds, { project_type: 'Office', city: 'Pune', budget_amount: 900000 }).id, 1);
  assert.strictEqual(pickDesigner(ds, { project_type: 'Retail', city: 'Goa', budget_amount: 3000000 }).id, 3);
});
