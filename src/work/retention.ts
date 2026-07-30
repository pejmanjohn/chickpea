export const DEFAULT_RUN_BODY_RETENTION_DAYS = 30;
export const MIN_RUN_BODY_RETENTION_DAYS = 1;
export const MAX_RUN_BODY_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1_000;

export function resolveRunBodyRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.TAG_RUN_BODY_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RUN_BODY_RETENTION_DAYS;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('TAG_RUN_BODY_RETENTION_DAYS must be an integer from 1 to 365');
  }
  const days = Number(raw);
  if (
    !Number.isSafeInteger(days) ||
    days < MIN_RUN_BODY_RETENTION_DAYS ||
    days > MAX_RUN_BODY_RETENTION_DAYS
  ) {
    throw new Error('TAG_RUN_BODY_RETENTION_DAYS must be an integer from 1 to 365');
  }
  return days;
}

export function runBodyExpiry(
  createdAt: number,
  env: Record<string, string | undefined> = process.env,
): number {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('Ledger content creation time is invalid');
  }
  return createdAt + resolveRunBodyRetentionDays(env) * DAY_MS;
}
