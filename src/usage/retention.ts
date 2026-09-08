export const USAGE_RAW_RETENTION_DAYS = 90;
export const USAGE_AGGREGATE_RETENTION_MONTHS = 13;
export const USAGE_RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

interface UsageRetentionCutoffs {
  rawBefore: number;
  aggregatesBefore: number;
}
export function usageRetentionCutoffs(at: number): UsageRetentionCutoffs {
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new Error('Usage retention time must be a non-negative safe integer.');
  }
  const date = new Date(at);
  const aggregateBoundary = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() - USAGE_AGGREGATE_RETENTION_MONTHS,
    date.getUTCDate(),
  );
  return {
    rawBefore: at - USAGE_RAW_RETENTION_DAYS * DAY_MS,
    aggregatesBefore: aggregateBoundary,
  };
}
