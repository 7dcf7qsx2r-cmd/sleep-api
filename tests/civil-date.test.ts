import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCivilDays,
  shanghaiToday,
  shanghaiYesterday,
  toDateOnly,
} from '../src/utils/civilDate.js';

test('shanghai calendar stays on the local date before UTC midnight', () => {
  const beforeUtcMidnight = new Date('2026-08-19T20:30:00.000Z');
  assert.equal(shanghaiToday(beforeUtcMidnight), '2026-08-20');
  assert.equal(shanghaiYesterday(beforeUtcMidnight), '2026-08-19');
});

test('civil date arithmetic does not use UTC toISOString', () => {
  assert.equal(addCivilDays('2026-03-01', -1), '2026-02-28');
});

test('DATE-looking values stay YYYY-MM-DD', () => {
  assert.equal(toDateOnly('2026-08-20T00:00:00.000Z'), '2026-08-20');
  assert.equal(toDateOnly(new Date('2026-08-20T00:00:00.000Z')), '2026-08-20');
});
