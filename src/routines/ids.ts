import { createHash, randomBytes, randomUUID } from 'node:crypto';

const OPAQUE_ROUTINE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function createRoutineId(): string {
  return `routine_${randomUUID().replaceAll('-', '')}`;
}

export function createRoutineRunId(): string {
  return `rrun_${randomUUID().replaceAll('-', '')}`;
}

export function createConfirmationId(): string {
  return `rconfirm_${randomUUID().replaceAll('-', '')}`;
}

export function createConfirmationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRoutineValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function scheduledOccurrenceKey(routineId: string, scheduledFor: number): string {
  return hashRoutineValue(`routine-slot\0${routineId}\0${scheduledFor}`);
}

export function runNowOccurrenceKey(routineId: string, nonce: string): string {
  return hashRoutineValue(`routine-run-now\0${routineId}\0${nonce}`);
}

export function routineAuditId(idempotencyKey: string): string {
  return `audit_${hashRoutineValue(idempotencyKey).slice(0, 32)}`;
}

export function isOpaqueRoutineId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ROUTINE_ID.test(value);
}
