'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseWhen, formatWhen, zonedEpoch, isoLocalToEpoch, partsIn } = require('../src/when');

const TZ = 'Asia/Kolkata';
// Friday 2 Oct 2026, 14:30 in India
const NOW = zonedEpoch(2026, 10, 2, 14, 30, TZ);
const at = (r) => { const p = partsIn(r.at, TZ); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };

test('zoned conversion is correct for India (UTC+5:30)', () => {
  assert.strictEqual(new Date(zonedEpoch(2026, 10, 3, 17, 0, TZ)).toISOString(), '2026-10-03T11:30:00.000Z');
  assert.strictEqual(isoLocalToEpoch('2026-10-03T17:00', TZ), zonedEpoch(2026, 10, 3, 17, 0, TZ));
});

test('the exact phrase from the real chat: "tomorrow 5 pm works"', () => {
  const r = parseWhen('Tomorrow 5 p.m. works', NOW, TZ);
  assert.strictEqual(at(r), '2026-10-03 17:00');
  assert.ok(r.hasTime);
  assert.strictEqual(at(parseWhen('tomorrow 5pm works for me', NOW, TZ)), '2026-10-03 17:00');
});

test('weekdays, times and relative phrases', () => {
  assert.strictEqual(at(parseWhen('Monday at 11am', NOW, TZ)), '2026-10-05 11:00');
  assert.strictEqual(at(parseWhen('saturday 4:30 pm', NOW, TZ)), '2026-10-03 16:30');
  assert.strictEqual(at(parseWhen('today at 6', NOW, TZ)), '2026-10-02 18:00');
  assert.strictEqual(at(parseWhen('day after tomorrow 10 am', NOW, TZ)), '2026-10-04 10:00');
  assert.strictEqual(at(parseWhen('in 2 hours', NOW, TZ)), '2026-10-02 16:30');
  assert.strictEqual(at(parseWhen('kal shaam 6 baje', NOW, TZ)), '2026-10-03 18:00');
  assert.strictEqual(at(parseWhen('tomorrow evening', NOW, TZ)), '2026-10-03 18:00');
  assert.strictEqual(parseWhen('tomorrow evening', NOW, TZ).approx, true);
});

test('time only rolls to tomorrow when already past; day only has no time', () => {
  assert.strictEqual(at(parseWhen('around 11 am', NOW, TZ)), '2026-10-03 11:00');
  assert.strictEqual(at(parseWhen('5:30 pm', NOW, TZ)), '2026-10-02 17:30');
  const d = parseWhen('sometime tomorrow', NOW, TZ);
  assert.strictEqual(d.at, null);
  assert.deepStrictEqual(d.day, { y: 2026, mo: 10, d: 3 });
});

test('money, sizes and unrelated text are not mistaken for a time', () => {
  assert.strictEqual(parseWhen('budget is 12 lakh', NOW, TZ), null);
  assert.strictEqual(parseWhen('3 bhk in pune', NOW, TZ), null);
  assert.strictEqual(parseWhen('modular kitchen and wardrobes', NOW, TZ), null);
});

test('formatWhen reads naturally', () => {
  assert.strictEqual(formatWhen(zonedEpoch(2026, 10, 3, 17, 0, TZ), TZ, NOW), 'Tomorrow, Sat 3 Oct, 5:00 pm'.replace('pm', 'PM'));
  assert.match(formatWhen(zonedEpoch(2026, 10, 9, 9, 15, TZ), TZ, NOW), /^Fri 9 Oct, 9:15 AM$/);
});
