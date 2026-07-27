import { Cron } from 'croner';

import { ROUTINE_LIMITS } from './limits.ts';
import { RoutineStateError, type RoutineScheduleReservation } from './types.ts';
import { isIanaTimeZone } from './validation.ts';

const PROJECTION_DAYS = 370;
const PROJECTION_MS = PROJECTION_DAYS * 24 * 60 * 60 * 1_000;
const ROLLING_DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_ENUMERATED_OCCURRENCES =
  PROJECTION_DAYS * Math.ceil(ROLLING_DAY_MS / ROUTINE_LIMITS.minimumIntervalMs) + 2;

export interface CanonicalRoutineSchedule {
  version: 1;
  kind: 'cron';
  expression: string;
}

export interface RoutineScheduleProjection {
  schedule: CanonicalRoutineSchedule;
  scheduleJson: string;
  nextRunAt: number;
  preview: number[];
  projectedDailyStarts: number;
  reservations: RoutineScheduleReservation[];
}

/**
 * Validate a deliberately small, deterministic schedule language: five-field
 * Vixie cron plus an explicit IANA time zone. Natural-language interpretation
 * belongs at the conversational boundary; persisted schedules never depend on
 * reparsing model prose.
 */
export function normalizeRoutineSchedule(
  expression: string,
  timezone: string,
  from: number = Date.now(),
): RoutineScheduleProjection {
  if (!Number.isSafeInteger(from) || from < 0 || !isIanaTimeZone(timezone)) {
    throw scheduleError('routine_invalid_timezone', 'Routine time zone must be a valid IANA time zone.');
  }
  const canonicalExpression = canonicalCronExpression(expression);
  const schedule: CanonicalRoutineSchedule = {
    version: 1,
    kind: 'cron',
    expression: canonicalExpression,
  };
  const occurrences = enumerateRoutineSchedule(schedule, timezone, from, from + PROJECTION_MS);
  if (occurrences.length === 0) {
    throw scheduleError('routine_schedule_out_of_range', 'Routine schedule has no occurrence in the next 370 days.');
  }
  assertMinimumInterval(occurrences);
  const projectedDailyStarts = maximumInRollingWindow(occurrences, ROLLING_DAY_MS);
  if (projectedDailyStarts > ROUTINE_LIMITS.scheduledStartsPerDay) {
    throw scheduleError('routine_scheduled_capacity', 'This schedule exceeds deployment capacity.');
  }
  return {
    schedule,
    scheduleJson: JSON.stringify(schedule),
    nextRunAt: occurrences[0]!,
    preview: occurrences.slice(0, 3),
    projectedDailyStarts,
    reservations: occurrences.map((windowStart) => ({ windowStart, count: 1 })),
  };
}

export function parseRoutineSchedule(scheduleJson: string): CanonicalRoutineSchedule {
  try {
    const value = JSON.parse(scheduleJson) as Partial<CanonicalRoutineSchedule>;
    if (
      value.version !== 1 ||
      value.kind !== 'cron' ||
      typeof value.expression !== 'string' ||
      canonicalCronExpression(value.expression) !== value.expression
    ) {
      throw new Error('invalid');
    }
    return value as CanonicalRoutineSchedule;
  } catch (error) {
    if (error instanceof RoutineStateError) throw error;
    throw scheduleError('routine_invalid_schedule', 'Normalized routine schedule is invalid.');
  }
}

export function nextRoutineOccurrence(
  scheduleJson: string,
  timezone: string,
  after: number,
): number {
  const schedule = parseRoutineSchedule(scheduleJson);
  const job = cron(schedule, timezone);
  try {
    const next = job.nextRun(new Date(after));
    if (!next) throw scheduleError('routine_schedule_exhausted', 'Routine schedule has no future occurrence.');
    return next.getTime();
  } finally {
    job.stop();
  }
}

export function enumerateRoutineSchedule(
  schedule: CanonicalRoutineSchedule,
  timezone: string,
  after: number,
  through: number,
): number[] {
  if (!isIanaTimeZone(timezone)) {
    throw scheduleError('routine_invalid_timezone', 'Routine time zone must be a valid IANA time zone.');
  }
  const job = cron(schedule, timezone);
  const occurrences: number[] = [];
  let cursor = after;
  try {
    while (occurrences.length <= MAX_ENUMERATED_OCCURRENCES) {
      const next = job.nextRun(new Date(cursor));
      if (!next || next.getTime() > through) break;
      const timestamp = next.getTime();
      occurrences.push(timestamp);
      cursor = timestamp;
    }
  } finally {
    job.stop();
  }
  if (occurrences.length > MAX_ENUMERATED_OCCURRENCES) {
    throw scheduleError(
      'routine_schedule_too_frequent',
      'Routine schedules must be at least one hour apart.',
    );
  }
  return occurrences;
}

function canonicalCronExpression(value: string): string {
  if (typeof value !== 'string' || value.trim().startsWith('@')) {
    throw scheduleError('routine_invalid_schedule', 'Routine schedule must be a five-field cron expression.');
  }
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw scheduleError('routine_invalid_schedule', 'Routine schedule must be a five-field cron expression.');
  }
  const expression = parts.map((part) => part.toUpperCase()).join(' ');
  const job = cron({ version: 1, kind: 'cron', expression }, 'UTC');
  job.stop();
  return expression;
}

function cron(schedule: CanonicalRoutineSchedule, timezone: string): Cron {
  try {
    return new Cron(schedule.expression, {
      timezone,
      paused: true,
      mode: '5-part',
      domAndDow: false,
    });
  } catch {
    throw scheduleError('routine_invalid_schedule', 'Routine schedule is invalid.');
  }
}

function assertMinimumInterval(occurrences: readonly number[]): void {
  for (let index = 1; index < occurrences.length; index += 1) {
    if (occurrences[index]! - occurrences[index - 1]! < ROUTINE_LIMITS.minimumIntervalMs) {
      throw scheduleError(
        'routine_schedule_too_frequent',
        'Routine schedules must be at least one hour apart.',
      );
    }
  }
}

function maximumInRollingWindow(values: readonly number[], width: number): number {
  let maximum = 0;
  let left = 0;
  for (let right = 0; right < values.length; right += 1) {
    while (values[right]! - values[left]! >= width) left += 1;
    maximum = Math.max(maximum, right - left + 1);
  }
  return maximum;
}

function scheduleError(code: string, message: string): RoutineStateError {
  return new RoutineStateError(code, message);
}
