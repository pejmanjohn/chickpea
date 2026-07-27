import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  nextRoutineOccurrence,
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

test('rejects schedules with any sub-hour occurrence across the projection horizon', () => {
  for (const expression of ['*/30 * * * *', '0,30 9 * * *']) {
    assert.throws(
      () => normalizeRoutineSchedule(expression, 'UTC', Date.UTC(2026, 0, 1)),
      (error: unknown) =>
        error instanceof RoutineStateError && error.code === 'routine_schedule_too_frequent',
    );
  }
  assert.equal(
    normalizeRoutineSchedule('0 * * * *', 'UTC', Date.UTC(2026, 0, 1)).projectedDailyStarts,
    24,
  );
  assert.equal(
    normalizeRoutineSchedule('0 * * * *', 'UTC', Date.UTC(2026, 0, 1)).reservations.length,
    49,
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
