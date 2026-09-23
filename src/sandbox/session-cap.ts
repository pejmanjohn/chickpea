import { updateMonthlyCounter } from '../config/monthly-counter.ts';
import type { SettingsStore } from '../config/settings-store.ts';

export const RECOMMENDED_SANDBOX_MONTHLY_SESSION_CAP = 200;
const SANDBOX_MONTHLY_SESSION_USAGE_PREFIX = 'sandbox.monthlySessions.';

interface MonthlySessionReservation {
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
  return updateMonthlyCounter<{ count: number }, MonthlySessionReservation>(options.store, {
    prefix: SANDBOX_MONTHLY_SESSION_USAGE_PREFIX,
    id: options.reservationId,
    ...(options.now ? { now: options.now } : {}),
    idsField: 'reservationIds',
    parse: parseMonthlySessionUsage,
    next: ({ count }, { month, seen }) => {
      const reservation = { cap: options.cap, month };
      if (seen) return { result: { ...reservation, allowed: true, count, alreadyReserved: true } };
      if (options.cap > 0 && count >= options.cap) {
        return { result: { ...reservation, allowed: false, count, alreadyReserved: false } };
      }
      return {
        counter: { count: count + 1 },
        result: { ...reservation, allowed: true, count: count + 1, alreadyReserved: false },
      };
    },
    contendedMessage: 'Could not reserve a sandbox session after concurrent updates',
  });
}

function parseMonthlySessionUsage(
  stored: Record<string, unknown> | undefined,
): { counter: { count: number }; ids: string[] } {
  const count = stored?.count;
  const ids = stored?.reservationIds;
  if (
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 &&
    Array.isArray(ids) && ids.every((value) => typeof value === 'string')
  ) {
    return { counter: { count }, ids: [...new Set(ids)] };
  }
  return { counter: { count: 0 }, ids: [] };
}
