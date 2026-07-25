import type { SettingsStore } from '../config/settings-store.ts';

export const RECOMMENDED_SANDBOX_MONTHLY_SESSION_CAP = 200;
export const SANDBOX_MONTHLY_SESSION_USAGE_PREFIX = 'sandbox.monthlySessions.';

const MAX_RESERVATION_IDS = 1_000;
const MAX_CAS_ATTEMPTS = 12;

interface MonthlySessionUsage {
  count: number;
  reservationIds: string[];
}

export interface MonthlySessionReservation {
  allowed: boolean;
  cap: number;
  count: number;
  month: string;
  alreadyReserved: boolean;
}

export function parseMonthlySessionCap(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return RECOMMENDED_SANDBOX_MONTHLY_SESSION_CAP;
  }
  return value;
}

export function sandboxSessionMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Atomically reserve one counted session. A retry carrying the same durable
 * turn id reuses its reservation, so MAX_TURN_ATTEMPTS cannot consume the cap
 * twice. Cap 0 disables refusal while retaining usage visibility.
 */
export async function reserveMonthlySandboxSession(options: {
  store: SettingsStore;
  cap: number;
  reservationId: string;
  now?: Date;
}): Promise<MonthlySessionReservation> {
  const month = sandboxSessionMonth(options.now ?? new Date());
  const key = `${SANDBOX_MONTHLY_SESSION_USAGE_PREFIX}${month}`;

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await options.store.getSetting(key);
    const usage = parseMonthlySessionUsage(raw);
    if (usage.reservationIds.includes(options.reservationId)) {
      return {
        allowed: true,
        cap: options.cap,
        count: usage.count,
        month,
        alreadyReserved: true,
      };
    }
    if (options.cap > 0 && usage.count >= options.cap) {
      return {
        allowed: false,
        cap: options.cap,
        count: usage.count,
        month,
        alreadyReserved: false,
      };
    }

    const next: MonthlySessionUsage = {
      count: usage.count + 1,
      reservationIds: [...usage.reservationIds, options.reservationId].slice(
        -MAX_RESERVATION_IDS,
      ),
    };
    const applied = await options.store.applySettingsPatch({
      expected: { key, value: raw ?? null },
      set: [{ key, value: JSON.stringify(next) }],
    });
    if (applied) {
      return {
        allowed: true,
        cap: options.cap,
        count: next.count,
        month,
        alreadyReserved: false,
      };
    }
  }

  throw new Error('Could not reserve a sandbox session after concurrent updates');
}

function parseMonthlySessionUsage(raw: string | undefined): MonthlySessionUsage {
  if (raw === undefined) return { count: 0, reservationIds: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<MonthlySessionUsage>;
    if (
      Number.isSafeInteger(parsed.count) &&
      (parsed.count ?? -1) >= 0 &&
      Array.isArray(parsed.reservationIds) &&
      parsed.reservationIds.every((value) => typeof value === 'string')
    ) {
      return {
        count: parsed.count as number,
        reservationIds: [...new Set(parsed.reservationIds)],
      };
    }
  } catch {
    // Recover a malformed counter to an empty usage record; the CAS still
    // requires that exact malformed value, so no concurrent write is lost.
  }
  return { count: 0, reservationIds: [] };
}
