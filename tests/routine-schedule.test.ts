import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  nextRoutineOccurrence,
  normalizeOneTimeSchedule,
  normalizeRelativeOneTimeSchedule,
  normalizeRoutineSchedule,
  parseRoutineSchedule,
} from '../src/routines/schedule.ts';
import { RoutineStateError } from '../src/routines/types.ts';

test('normalizes only five-field cron with an explicit IANA time zone', () => {
  const from = Date.UTC(2026, 6, 27, 12);
  const projection = normalizeRoutineSchedule(' 0   9 * * mon-fri ', 'America/Los_Angeles', from);

  assert.deepEqual(projection.schedule, {
    version: 1,
    kind: 'cron',
    expression: '0 9 * * MON-FRI',
  });
  assert.deepEqual(parseRoutineSchedule(projection.scheduleJson), projection.schedule);
  assert.equal(projection.nextRunAt, Date.UTC(2026, 6, 27, 16));
  assert.equal(projection.preview.length, 3);
  assert.equal(projection.projectedDailyStarts, 1);
  assert.equal(projection.reservations.length, 3);

  for (const expression of ['@daily', '0 0 9 * * *', '0 9 * *']) {
    assert.throws(
      () => normalizeRoutineSchedule(expression, 'UTC', from),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_invalid_schedule',
    );
  }
  assert.throws(
    () => normalizeRoutineSchedule('0 9 * * *', 'Pacific/Chickpea', from),
    (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_invalid_timezone',
  );
});

test('normalizes one-time local schedules to one future instant', () => {
  const from = Date.UTC(2026, 6, 27, 12);
  const projection = normalizeOneTimeSchedule(
    '2026-07-28T09:30',
    'America/Los_Angeles',
    from,
  );
  assert.deepEqual(projection.schedule, {
    version: 1,
    kind: 'once',
    localDateTime: '2026-07-28T09:30',
    at: Date.UTC(2026, 6, 28, 16, 30),
  });
  assert.deepEqual(projection.preview, [Date.UTC(2026, 6, 28, 16, 30)]);
  assert.equal(projection.projectedDailyStarts, 0);
  assert.deepEqual(projection.reservations, [{ windowStart: Date.UTC(2026, 6, 28, 16, 30), count: 1 }]);
  assert.deepEqual(parseRoutineSchedule(projection.scheduleJson), projection.schedule);

  assert.throws(
    () => normalizeOneTimeSchedule('2026-07-27T05:00', 'America/Los_Angeles', from),
    (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_schedule_in_past',
  );
});

test('relative one-time schedules land on a future server-clock minute every time', () => {
  const midMinute = Date.UTC(2026, 7, 27, 18, 46, 30);
  const projection = normalizeRelativeOneTimeSchedule(5, 'America/Los_Angeles', midMinute);

  assert.equal(projection.nextRunAt, Date.UTC(2026, 7, 27, 18, 52));
  assert.deepEqual(projection.schedule, {
    version: 1,
    kind: 'once',
    localDateTime: '2026-08-27T11:52',
    at: Date.UTC(2026, 7, 27, 18, 52),
  });
  assert.deepEqual(parseRoutineSchedule(projection.scheduleJson), projection.schedule);
  assert.deepEqual(projection.reservations, [{ windowStart: projection.nextRunAt, count: 1 }]);

  const exactMinute = normalizeRelativeOneTimeSchedule(5, 'UTC', Date.UTC(2026, 7, 27, 18, 46));
  assert.equal(exactMinute.nextRunAt, Date.UTC(2026, 7, 27, 18, 51));
  assert.equal(exactMinute.schedule.localDateTime, '2026-08-27T18:51');

  // The observed live failure: a repeated identical follow-up must never depend
  // on wall-clock arithmetic, so the same relative request later still lands in
  // the future instead of rejecting with routine_schedule_in_past.
  const repeated = normalizeRelativeOneTimeSchedule(5, 'UTC', Date.UTC(2026, 7, 27, 19, 12, 7));
  assert.equal(repeated.nextRunAt, Date.UTC(2026, 7, 27, 19, 18));
  assert.ok(repeated.nextRunAt > Date.UTC(2026, 7, 27, 19, 12, 7));

  for (const minutes of [0, -5, 2.5, 370 * 24 * 60 + 1, Number.NaN]) {
    assert.throws(
      () => normalizeRelativeOneTimeSchedule(minutes, 'UTC', midMinute),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_invalid_schedule',
    );
  }
  assert.throws(
    () => normalizeRelativeOneTimeSchedule(5, 'Not/AZone', midMinute),
    (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_invalid_timezone',
  );
});

test('normalizes ISO local timestamps with seconds without scheduling early', () => {
  const from = Date.UTC(2026, 6, 27, 12);
  const exactMinute = normalizeOneTimeSchedule(
    '2026-07-28T09:30:00.000',
    'America/Los_Angeles',
    from,
  );
  const partialMinute = normalizeOneTimeSchedule(
    '2026-07-28T09:30:15.250',
    'America/Los_Angeles',
    from,
  );

  assert.equal(exactMinute.schedule.localDateTime, '2026-07-28T09:30');
  assert.equal(exactMinute.nextRunAt, Date.UTC(2026, 6, 28, 16, 30));
  assert.equal(partialMinute.schedule.localDateTime, '2026-07-28T09:31');
  assert.equal(partialMinute.nextRunAt, Date.UTC(2026, 6, 28, 16, 31));
});

test('one-time schedules choose the first fold instant and reject nonexistent local time', () => {
  const fall = normalizeOneTimeSchedule(
    '2026-11-01T01:30',
    'America/Los_Angeles',
    Date.UTC(2026, 10, 1, 0),
  );
  assert.equal(new Date(fall.nextRunAt).toISOString(), '2026-11-01T08:30:00.000Z');
  assert.throws(
    () => normalizeOneTimeSchedule(
      '2026-03-08T02:30',
      'America/Los_Angeles',
      Date.UTC(2026, 2, 7, 12),
    ),
    (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_nonexistent_local_time',
  );
});

test('accepts five-minute schedules and rejects any shorter interval', () => {
  for (const expression of ['*/4 * * * *', '*/7 * * * *', '0,4 9 * * *']) {
    assert.throws(
      () => normalizeRoutineSchedule(expression, 'UTC', Date.UTC(2026, 0, 1)),
      (error: unknown) =>
        error instanceof RoutineStateError && error.code === 'routine_schedule_too_frequent',
    );
  }
  assert.equal(
    normalizeRoutineSchedule('*/5 * * * *', 'UTC', Date.UTC(2026, 0, 1)).projectedDailyStarts,
    288,
  );
  assert.equal(
    normalizeRoutineSchedule('*/30 * * * *', 'UTC', Date.UTC(2026, 0, 1)).projectedDailyStarts,
    48,
  );
});

test('DST behavior is stable for spring gaps and fall folds', () => {
  const spring = normalizeRoutineSchedule(
    '30 2 * * *',
    'America/Los_Angeles',
    Date.UTC(2026, 2, 7, 12),
  );
  assert.equal(new Date(spring.nextRunAt).toISOString(), '2026-03-08T10:30:00.000Z');

  const fall = normalizeRoutineSchedule(
    '30 1 * * *',
    'America/Los_Angeles',
    Date.UTC(2026, 10, 1, 0),
  );
  assert.deepEqual(
    fall.preview.slice(0, 2).map((timestamp) => new Date(timestamp).toISOString()),
    ['2026-11-01T08:30:00.000Z', '2026-11-02T09:30:00.000Z'],
  );
  assert.equal(
    nextRoutineOccurrence(fall.scheduleJson, 'America/Los_Angeles', fall.nextRunAt),
    fall.preview[1],
  );
});

test('corrupt or non-canonical persisted schedules fail closed', () => {
  for (const value of [
    '{}',
    '{"version":2,"kind":"cron","expression":"0 9 * * *"}',
    '{"version":1,"kind":"cron","expression":"0  9 * * *"}',
  ]) {
    assert.throws(
      () => parseRoutineSchedule(value),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_invalid_schedule',
    );
  }
});
