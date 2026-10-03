'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyFacts } = require('../src/facts');
const { DEFAULTS, merge, sanitize } = require('../src/settings');

const settings = sanitize(merge(DEFAULTS, {}));
const run = (f, text) => applyFacts({ meta: {}, stage: 'qualifying' }, f, text, { lastAsked: null, settings });

test('a model slip cannot flag "wants a human" without the customer asking', () => {
  assert.strictEqual(run({ wants_human: true }, 'hi bhai, 2bhk ka interior karwana hai').meta.flags.wants_human, undefined);
  assert.strictEqual(run({ wants_human: true }, 'Tomorrow 5 pm works for a call').meta.flags.wants_human, undefined);
  assert.strictEqual(run({ wants_human: true }, 'is this a bot? I want to talk to a real person').meta.flags.wants_human, true);
  assert.strictEqual(run({ wants_human: true }, 'I want to speak to someone please').meta.flags.wants_human, true);
});

test('a model slip cannot end the chat without the customer saying so', () => {
  assert.strictEqual(run({ not_interested: true }, 'my budget is 8 lakh').meta.flags.not_interested, undefined);
  assert.strictEqual(run({ not_interested: true }, 'actually I am not interested any more, please stop').meta.flags.not_interested, true);
  assert.strictEqual(run({ not_interested: true }, 'nahi chahiye bhai').meta.flags.not_interested, true);
});
