/** Bounded-range guards shared by managed connector input schemas. `index.ts`
 * imports every connector module, so these live in a sibling to stay acyclic. */

export function boundedDateRange(start: string, end: string, maxDays: number): boolean {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(startMs) && Number.isFinite(endMs) &&
    new Date(startMs).toISOString().slice(0, 10) === start &&
    new Date(endMs).toISOString().slice(0, 10) === end && endMs >= startMs &&
    (endMs - startMs) / 86_400_000 <= maxDays;
}

export function boundedTimestampRange(start: string, end: string, maxDays: number): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs &&
    (endMs - startMs) / 86_400_000 <= maxDays;
}

/** Absent bounds leave the range unconstrained. */
export function boundedOptionalTimestampRange(
  start: string | undefined,
  end: string | undefined,
  maxDays: number,
): boolean {
  if (!start || !end) return true;
  return boundedTimestampRange(start, end, maxDays);
}
