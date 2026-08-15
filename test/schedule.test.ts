import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule, parseCivil, formatCivil, IG_DAILY_POST_LIMIT } from '../src/schedule.ts';
import { UserError } from '../src/log.ts';

const base = {
  start: '2026-08-16T09:00',
  gapMinutes: 240,
  dailyCap: 6,
  windowStartHour: 9,
  windowEndHour: 21,
};

test('round-trips a civil timestamp without shifting it', () => {
  assert.equal(formatCivil(parseCivil('2026-08-16T09:30')), '2026-08-16T09:30:00');
});

test('spaces posts by the requested gap', () => {
  const times = planSchedule({ ...base, count: 3 });
  assert.deepEqual(times, ['2026-08-16T09:00:00', '2026-08-16T13:00:00', '2026-08-16T17:00:00']);
});

test('rolls to the next day when the posting window closes', () => {
  const times = planSchedule({ ...base, count: 4 });
  assert.equal(times[3], '2026-08-17T09:00:00');
});

test('rolls to the next day when the daily cap is reached', () => {
  const times = planSchedule({ ...base, count: 3, gapMinutes: 60, dailyCap: 2 });
  assert.deepEqual(times, ['2026-08-16T09:00:00', '2026-08-16T10:00:00', '2026-08-17T09:00:00']);
});

test('pulls a start before the window forward to the window opening', () => {
  const times = planSchedule({ ...base, count: 1, start: '2026-08-16T03:00' });
  assert.equal(times[0], '2026-08-16T09:00:00');
});

test('pushes a start after the window to the next day', () => {
  const times = planSchedule({ ...base, count: 1, start: '2026-08-16T23:00' });
  assert.equal(times[0], '2026-08-17T09:00:00');
});

test('returns an empty plan for a count of zero', () => {
  assert.deepEqual(planSchedule({ ...base, count: 0 }), []);
});

test('produces strictly increasing times across a long batch', () => {
  const times = planSchedule({ ...base, count: 20 });
  assert.equal(times.length, 20);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok((times[i] as string) > (times[i - 1] as string), `${times[i]} must follow ${times[i - 1]}`);
  }
});

test('rejects a daily cap above the Instagram API limit', () => {
  assert.throws(
    () => planSchedule({ ...base, count: 1, dailyCap: IG_DAILY_POST_LIMIT + 1 }),
    UserError,
  );
});

test('rejects a gap that cannot fit twice in the window', () => {
  assert.throws(
    () => planSchedule({ ...base, count: 2, gapMinutes: 900, windowStartHour: 9, windowEndHour: 12 }),
    UserError,
  );
});

test('rejects an inverted posting window', () => {
  assert.throws(
    () => planSchedule({ ...base, count: 1, windowStartHour: 21, windowEndHour: 9 }),
    UserError,
  );
});

test('rejects an unparseable start', () => {
  assert.throws(() => planSchedule({ ...base, count: 1, start: 'tomorrow' }), UserError);
});
