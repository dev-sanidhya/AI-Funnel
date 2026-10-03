'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mapIntake, budgetOptions, TIMELINE_OPTIONS } = require('../src/formoptions');
const { nextStepFor, briefFor } = require('../src/attention');
const { DEFAULTS, merge, sanitize } = require('../src/settings');
const { evaluate } = require('../src/qualify');

const S = () => sanitize(merge(DEFAULTS, {}));
const NOW = Date.now();

test('the detailed form maps onto lead fields (scope, property, city, budget, timing)', () => {
  const m = mapIntake({
    scope: ['Modular kitchen', 'Wardrobes and storage'], property_type: 'Apartment', size: '3 BHK', sqft: '1,450',
    city: 'Pune', locality: 'Kharadi', budget: '₹5 to 10 lakh', timeline: 'In 1 to 3 months', contact_pref: 'Evening', notes: ' Light woods ',
  }, S());
  assert.strictEqual(m.project_type, 'Modular kitchen');
  assert.strictEqual(m.scope, 'modular kitchen, wardrobes and storage');
  assert.strictEqual(m.property, '3BHK apartment, 1450 sq ft');
  assert.strictEqual(m.city, 'Kharadi, Pune');
  assert.strictEqual(m.budget_amount, 1000000);
  assert.strictEqual(m.timeline_months, 3);
  assert.strictEqual(m.contact_pref, 'evening');
  assert.strictEqual(m.notes, 'Light woods');
});

test('"Not sure" budget leaves the budget unknown so the assistant asks; low ranges still hit the bar', () => {
  const s = S();
  const unsure = mapIntake({ scope: ['Full home interiors'], budget: 'Not sure yet' }, s);
  assert.strictEqual(unsure.budget_amount, null);
  const low = mapIntake({ scope: ['Full home interiors'], budget: 'Under ₹3 lakh' }, s);
  assert.strictEqual(low.budget_amount, 300000);
  assert.strictEqual(evaluate({ meta: { turns: 1 }, ...low, stage: 'new' }, s).stage, 'disqualified');
  assert.ok(budgetOptions('INR').length === 7 && budgetOptions('USD').length === 6);
  assert.ok(TIMELINE_OPTIONS.some((t) => t.months === 12), 'a "just exploring" option exists and is treated as far away');
});

test('unknown or hostile form values are ignored, not stored', () => {
  const m = mapIntake({ scope: ['<script>'], budget: 'one billion', timeline: 'never', property_type: 'x'.repeat(500), city: 'Pune' }, S());
  assert.strictEqual(m.budget_amount, null);
  assert.strictEqual(m.timeline_months, null);
  assert.ok(m.property.length <= 80 + 20);
});

test('every lead gets a plain next step', () => {
  const s = S();
  const base = { meta: {}, stage: 'active', designer: 'Priya', qualified_at: NOW - 3600000 };
  assert.match(nextStepFor({ ...base, phone: null }, s, NOW).text, /phone number/i);
  assert.match(nextStepFor({ ...base, phone: '98765 43210' }, s, NOW).text, /call time|time for the designer call/i);
  const booked = nextStepFor({ ...base, phone: '98765', callback_at: NOW + 3 * 3600000, callback_status: 'scheduled' }, s, NOW);
  assert.match(booked.text, /Priya to call/);
  assert.strictEqual(booked.tone, 'ok');
  const overdue = nextStepFor({ ...base, phone: '98765', callback_at: NOW - 3 * 3600000, callback_status: 'scheduled' }, s, NOW);
  assert.strictEqual(overdue.tone, 'urgent');
  assert.strictEqual(nextStepFor({ meta: { flags: { wants_human: true } }, stage: 'human' }, s, NOW).tone, 'urgent');
  assert.strictEqual(nextStepFor({ meta: {}, stage: 'disqualified', stage_reason: 'Budget is below the minimum' }, s, NOW).tone, 'idle');
  assert.match(nextStepFor({ meta: {}, stage: 'new', chat_id: null }, s, NOW).text, /open the chat/i);
});

test('the brief reads naturally from form answers', () => {
  const s = S();
  const b = briefFor({ meta: {}, scope: 'modular kitchen', property: '3BHK apartment', city: 'Pune', budget_amount: 1000000, timeline_text: 'in 1 to 3 months', phone: '98765' }, s, NOW);
  assert.match(b, /Wants modular kitchen for a 3BHK apartment in Pune/);
  assert.match(b, /Budget about/);
  assert.doesNotMatch(b, /want to start we/i);
});
