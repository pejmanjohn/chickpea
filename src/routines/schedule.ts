import { Cron } from 'croner';

import { ROUTINE_LIMITS } from './limits.ts';
import { RoutineStateError, type RoutineScheduleReservation } from './types.ts';
import { isIanaTimeZone } from './validation.ts';

const PROJECTION_DAYS = 370;
const PROJECTION_MS = PROJECTION_DAYS * 24 * 60 * 60 * 1_000;
const ROLLING_DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_ENUMERATED_OCCURRENCES =
  PROJECTION_DAYS * Math.ceil(ROLLING_DAY_MS / ROUTINE_LIMITS.minimumIntervalMs) + 2;

export interface CanonicalRecurringRoutineSchedule {
  version: 1;
  kind: 'cron';
  expression: string;
}

export interface CanonicalOneTimeRoutineSchedule {
  version: 1;
  kind: 'once';
  localDateTime: string;
  at: number;
}

export type CanonicalRoutineSchedule =
  | CanonicalRecurringRoutineSchedule
  | CanonicalOneTimeRoutineSchedule;

export interface RoutineScheduleProjection<T extends CanonicalRoutineSchedule = CanonicalRoutineSchedule> {
  schedule: T;
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
): RoutineScheduleProjection<CanonicalRecurringRoutineSchedule> {
  if (!Number.isSafeInteger(from) || from < 0 || !isIanaTimeZone(timezone)) {
    throw scheduleError('routine_invalid_timezone', 'Routine time zone must be a valid IANA time zone.');
  }
  const canonicalExpression = canonicalCronExpression(expression);
  const schedule: CanonicalRecurringRoutineSchedule = {
    version: 1,
    kind: 'cron',
    expression: canonicalExpression,
  };
  const fixedMinuteInterval = simpleMinuteInterval(canonicalExpression);
  if (
    fixedMinuteInterval &&
    fixedMinuteInterval.minimumGapMinutes * 60_000 < ROUTINE_LIMITS.minimumIntervalMs
  ) {
    throw scheduleError(
      'routine_schedule_too_frequent',
      'Routine schedules must be at least five minutes apart.',
    );
  }
  const occurrences = enumerateRoutineSchedule(
    schedule,
    timezone,
    from,
    from + (fixedMinuteInterval
      ? ROUTINE_LIMITS.reservationLookaheadMs + 24 * 60 * 60 * 1_000
      : PROJECTION_MS),
  );
  if (occurrences.length === 0) {
    throw scheduleError('routine_schedule_out_of_range', 'Routine schedule has no occurrence in the next 370 days.');
  }
  assertMinimumInterval(occurrences);
  const projectedDailyStarts = fixedMinuteInterval
    ? fixedMinuteInterval.startsPerDay
    : maximumInRollingWindow(occurrences, ROLLING_DAY_MS);
  if (projectedDailyStarts > ROUTINE_LIMITS.scheduledStartsPerRoutinePerDay) {
    throw scheduleError('routine_scheduled_capacity', 'This schedule exceeds deployment capacity.');
  }
  return {
    schedule,
    scheduleJson: JSON.stringify(schedule),
    nextRunAt: occurrences[0]!,
    preview: occurrences.slice(0, 3),
    projectedDailyStarts,
    reservations: compactReservationOccurrences(occurrences).map((windowStart) => ({
      windowStart,
      count: 1,
    })),
  };
}

/**
 * Exact fast path for the common "every N minutes" cron. Five-minute work
 * would otherwise ask Croner to materialize more than 100,000 occurrences for
 * the 370-day irregular-schedule proof. Minute steps reset at each hour, so the
 * hour-boundary remainder is part of the real minimum gap (for example a
 * seven-minute step has a four-minute 00:56 -> 01:00 gap and is rejected).
 */
function simpleMinuteInterval(expression: string): {
  minimumGapMinutes: number;
  startsPerDay: number;
} | undefined {
  const match = /^\*\/(\d+) \* \* \* \*$/.exec(expression);
  if (!match) return undefined;
  const step = Number(match[1]);
  if (!Number.isInteger(step) || step <= 0) return undefined;
  const startsPerHour = Math.ceil(60 / step);
  const lastMinute = Math.floor(59 / step) * step;
  return {
    minimumGapMinutes: Math.min(step, 60 - lastMinute),
    startsPerDay: startsPerHour * 24,
  };
}

export function normalizeOneTimeSchedule(
  localDateTime: string,
  timezone: string,
  from: number = Date.now(),
): RoutineScheduleProjection<CanonicalOneTimeRoutineSchedule> {
  if (!Number.isSafeInteger(from) || from < 0 || !isIanaTimeZone(timezone)) {
    throw scheduleError('routine_invalid_timezone', 'Routine time zone must be a valid IANA time zone.');
  }
  const canonicalLocal = canonicalLocalDateTime(localDateTime);
  const at = resolveLocalDateTime(canonicalLocal, timezone);
  if (at <= from) {
    throw scheduleError('routine_schedule_in_past', 'A one-time routine must be scheduled in the future.');
  }
  const schedule: CanonicalOneTimeRoutineSchedule = {
    version: 1,
    kind: 'once',
    localDateTime: canonicalLocal,
    at,
  };
  return {
    schedule,
    scheduleJson: JSON.stringify(schedule),
    nextRunAt: at,
    preview: [at],
    projectedDailyStarts: 0,
    reservations: [{ windowStart: at, count: 1 }],
  };
}

/**
 * Rebuild the small, rolling collision-preview window after a due slot advances.
 * Full-year enumeration is retained only for validation and daily-rate
 * calculation; it is never persisted on each routine.
 */
export function projectRoutineReservationWindows(
  scheduleJson: string,
  timezone: string,
  after: number,
): RoutineScheduleReservation[] {
  if (!Number.isSafeInteger(after) || after < 0 || !isIanaTimeZone(timezone)) {
    throw scheduleError('routine_invalid_timezone', 'Routine time zone must be a valid IANA time zone.');
  }
  const schedule = parseRoutineSchedule(scheduleJson);
  if (schedule.kind === 'once') {
    return schedule.at > after ? [{ windowStart: schedule.at, count: 1 }] : [];
  }
  const job = cron(schedule, timezone);
  const occurrences: number[] = [];
  let cursor = after;
  let through: number | undefined;
  try {
    while (true) {
      const next = job.nextRun(new Date(cursor));
      if (!next) break;
      const timestamp = next.getTime();
      through ??= timestamp + ROUTINE_LIMITS.reservationLookaheadMs;
      if (occurrences.length >= 3 && timestamp > through) break;
      occurrences.push(timestamp);
      cursor = timestamp;
    }
  } finally {
    job.stop();
  }
  if (occurrences.length === 0) {
    throw scheduleError('routine_schedule_exhausted', 'Routine schedule has no future occurrence.');
  }
  return occurrences.map((windowStart) => ({ windowStart, count: 1 }));
}

export function parseRoutineSchedule(scheduleJson: string): CanonicalRoutineSchedule {
  try {
    const value = JSON.parse(scheduleJson) as Partial<CanonicalRoutineSchedule>;
    if (
      value.version === 1 &&
      value.kind === 'once' &&
      typeof value.localDateTime === 'string' &&
      canonicalLocalDateTime(value.localDateTime) === value.localDateTime &&
      Number.isSafeInteger(value.at) &&
      Number(value.at) >= 0
    ) {
      return value as CanonicalOneTimeRoutineSchedule;
    }
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
  if (schedule.kind === 'once') {
    if (schedule.at <= after) {
      throw scheduleError('routine_schedule_exhausted', 'One-time routine has no future occurrence.');
    }
    return schedule.at;
  }
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
  schedule: CanonicalRecurringRoutineSchedule,
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
      'Routine schedules must be at least five minutes apart.',
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

function cron(schedule: CanonicalRecurringRoutineSchedule, timezone: string): Cron {
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

function canonicalLocalDateTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw scheduleError(
      'routine_invalid_schedule',
      'A one-time routine must use a local date and time like 2026-07-28T09:30.',
    );
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const roundTrip = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month! - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) {
    throw scheduleError('routine_invalid_schedule', 'The one-time routine date and time is invalid.');
  }
  return value.trim();
}

function resolveLocalDateTime(localDateTime: string, timezone: string): number {
  const [date, time] = localDateTime.split('T');
  const [year, month, day] = date!.split('-').map(Number);
  const [hour, minute] = time!.split(':').map(Number);
  const center = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (
    let candidate = center - 16 * 60 * 60 * 1_000;
    candidate <= center + 16 * 60 * 60 * 1_000;
    candidate += 60_000
  ) {
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    if (
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      Number(parts.hour) === hour &&
      Number(parts.minute) === minute
    ) {
      return candidate;
    }
  }
  throw scheduleError(
    'routine_nonexistent_local_time',
    'That local time does not exist in the selected time zone. Choose another time.',
  );
}

function assertMinimumInterval(occurrences: readonly number[]): void {
  for (let index = 1; index < occurrences.length; index += 1) {
    if (occurrences[index]! - occurrences[index - 1]! < ROUTINE_LIMITS.minimumIntervalMs) {
      throw scheduleError(
        'routine_schedule_too_frequent',
        'Routine schedules must be at least five minutes apart.',
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

function compactReservationOccurrences(occurrences: readonly number[]): number[] {
  const through = occurrences[0]! + ROUTINE_LIMITS.reservationLookaheadMs;
  let count = 0;
  while (count < occurrences.length && (count < 3 || occurrences[count]! <= through)) {
    count += 1;
  }
  return occurrences.slice(0, count);
}

function scheduleError(code: string, message: string): RoutineStateError {
  return new RoutineStateError(code, message);
}
