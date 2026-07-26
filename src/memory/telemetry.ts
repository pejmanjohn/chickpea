export type MemoryMetricValue = boolean | number | string;

const MEMORY_METRIC_FIELDS = new Set([
  'action',
  'candidateCount',
  'crossChannelCount',
  'inject',
  'outcome',
  'reason',
  'selectedCount',
  'serializedBytes',
  'truncated',
]);

/**
 * Emit one log-safe memory metric envelope. String values are limited to
 * machine tokens so entry text, prompts, Slack IDs, and actor IDs cannot leak
 * through an accidentally reused field.
 */
export function emitMemoryMetric(
  event: string,
  fields: Readonly<Record<string, MemoryMetricValue>> = {},
): void {
  const payload: Record<string, MemoryMetricValue> = { event: safeToken(event) };
  for (const [key, value] of Object.entries(fields)) {
    if (!MEMORY_METRIC_FIELDS.has(key)) continue;
    payload[key] = typeof value === 'string' ? safeToken(value) : value;
  }
  console.info('[chickpea] memory_metric', JSON.stringify(payload));
}

function safeToken(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value) ? value : 'other';
}
