'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { quickFacts } = require('../src/quickfacts');
const { DEFAULTS, merge, sanitize } = require('../src/settings');

const S = sanitize(merge(DEFAULTS, {}));

test('reads the message our own form writes, with no AI at all', () => {
  const msg = "Hi! I'm Sanidhya. I'd like help with full home interiors, bedrooms and bathrooms for my 2BHK apartment in Rohini, Delhi. My budget is around ₹10 to 20 lakh. I'd like to get started within a month. Afternoon is the best time to reach me. I like Premium interior designing.";
  const f = quickFacts(msg, null, S);
  assert.strictEqual(f.project_type, 'Full home');
  assert.match(f.scope, /full home interiors/);
  assert.match(f.scope, /bedrooms/);
  assert.strictEqual(f.property, '2BHK apartment');
  assert.strictEqual(f.city, 'Rohini, Delhi');
  assert.strictEqual(f.timeline_months, 1);
});

test('short answers to the question just asked are understood', () => {
  assert.strictEqual(quickFacts('a full homw', 'project_type', S).project_type, 'Full home', 'the typo from the real chat');
  assert.strictEqual(quickFacts('A full home', 'project_type', S).project_type, 'Full home');
  assert.strictEqual(quickFacts('modular kitchen please', 'project_type', S).project_type, 'Modular kitchen');
  assert.strictEqual(quickFacts('Delhi', 'city', S).city, 'Delhi');
  assert.strictEqual(quickFacts("it's in Pune", 'city', S).city, 'Pune');
  assert.strictEqual(quickFacts('Kharadi, Pune', 'city', S).city, 'Kharadi, Pune');
  assert.strictEqual(quickFacts('yes', 'city', S).city, undefined);
  assert.strictEqual(quickFacts('2 months', 'timeline', S).timeline_months, 2);
  assert.strictEqual(quickFacts('asap', 'timeline', S).timeline_months, 0);
  assert.strictEqual(quickFacts('next year', 'timeline', S).timeline_months, 12);
});

test('does not invent facts from unrelated text', () => {
  const f = quickFacts('what is the price of a sofa', null, S);
  assert.strictEqual(f.project_type, undefined);
  assert.strictEqual(f.city, undefined);
  assert.strictEqual(f.timeline_months, undefined);
});
