import type { SettingsStore } from './settings-store.ts';

const MAX_COUNTED_IDS = 1_000;
const MAX_CAS_ATTEMPTS = 12;

/** The UTC calendar month a monthly counter row belongs to, as `YYYY-MM`. */
export function utcMonthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface MonthlyCounterOptions<T extends object, R> {
  /** Settings-key prefix; the row lives at `${prefix}${YYYY-MM}`. */
  prefix: string;
  /** Idempotency id: a counted id is never counted twice in a month. */
  id: string;
  now?: Date;
  /** The row's field that holds the counted ids, written last. */
  idsField: string;
  /**
   * Reads a stored row. Missing or unparseable JSON arrives as undefined, and
   * a malformed row must recover to the empty counter: the CAS still
   * requires that exact stored value, so no concurrent write is lost.
   */
  parse: (stored: Record<string, unknown> | undefined) => { counter: T; ids: string[] };
  /**
   * Decides the update. `seen` is true when `id` was already counted.
   * Return `counter` to write it with `id` appended; omit it to leave the
   * row unchanged.
   */
  next: (current: T, context: { month: string; seen: boolean }) => { counter?: T; result: R };
  /** Error message once concurrent writers keep winning the race. */
  contendedMessage: string;
}

/**
 * Compare-and-set update of one month's counter row, idempotent per id. The
 * row keeps a ring of the last 1,000 counted ids, so a retried turn cannot
 * count twice; concurrent writers retry on a lost race.
 */
export async function updateMonthlyCounter<T extends object, R>(
  store: SettingsStore,
  options: MonthlyCounterOptions<T, R>,
): Promise<R> {
  const month = utcMonthKey(options.now ?? new Date());
  const key = `${options.prefix}${month}`;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await store.getSetting(key);
    const { counter, ids } = options.parse(parseRow(raw));
    const step = options.next(counter, { month, seen: ids.includes(options.id) });
    if (!step.counter) return step.result;
    const row = { ...step.counter, [options.idsField]: [...ids, options.id].slice(-MAX_COUNTED_IDS) };
    const applied = await store.applySettingsPatch({
      expected: { key, value: raw ?? null },
      set: [{ key, value: JSON.stringify(row) }],
    });
    if (applied) return step.result;
  }
  throw new Error(options.contendedMessage);
}

/** Reads one month's row without changing it. */
export async function readMonthlyCounter<T extends object>(
  store: SettingsStore,
  options: Pick<MonthlyCounterOptions<T, unknown>, 'prefix' | 'now' | 'parse'>,
): Promise<{ month: string; counter: T }> {
  const month = utcMonthKey(options.now ?? new Date());
  const { counter } = options.parse(parseRow(await store.getSetting(`${options.prefix}${month}`)));
  return { month, counter };
}

function parseRow(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
