/**
 * Browsers running and browser time metered for one installation, on a
 * deployment serving many installations. Standalone has neither; it keeps
 * `browser.monthlyUsage.*` for its usage card.
 *
 * Every session the hosted wrapper creates holds a lease in the
 * installation's own store, from just before the create until the session
 * ends, keyed by a reservation id Core mints. The provider bills a session
 * until it is released or its timeout passes, so a lease stands until that
 * timeout and is never renewed. Admission refuses past the host's running
 * limit, its monthly hours, or its creations a minute, and refuses a context
 * another lease holds: two sessions on one context can sign a site out.
 * Ending a session releases its lease and meters the run in whole minutes,
 * at least one, as the provider bills. A lease past its timeout (an Agent
 * evicted mid-turn, an end that failed) is charged up to its timeout by the
 * next admission or by work maintenance.
 *
 * Both rows change together under compare-and-set fences on both, as the
 * coding sandbox's container leases do (sandbox/container-lease.ts), so
 * concurrent creates in one installation cannot pass a limit and a run is
 * never metered twice.
 */
import { utcMonthKey } from '../config/monthly-counter.ts';
import type { HostedBrowserPolicy } from '../config/hosted-browser.ts';
import { deploymentTenancy } from '../config/installation-scope.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';

export const BROWSER_SESSION_LEASES_KEY = 'browser.sessionLeases';
export const BROWSER_SECONDS_PREFIX = 'browser.monthlyBrowserSeconds.';
const RATE_WINDOW_MS = 60_000;
const MAX_CAS_ATTEMPTS = 12;

type LeaseStore = Pick<SettingsStore, 'getSettings' | 'applySettingsPatch'>;

export interface BrowserSessionLease {
  startedAt: number;
  /** The session's own timeout. */
  leaseUntil: number;
  /** Attached once the provider created the session. */
  sessionId?: string;
  contextId?: string;
}

interface LeaseRow {
  leases: Record<string, BrowserSessionLease>;
  /** When each session of the last minute was created, for the creations-a-minute limit. */
  recentCreations: number[];
}

export type BrowserSessionAdmission = 'admitted' | 'hours_cap' | 'context_in_use' | 'running_limit' | 'rate_limit';

/**
 * Admit a session about to be created and hold its lease under
 * `reservationId` until `timeoutSeconds` from now, in one compare-and-set.
 * Leases past their timeout are charged and dropped first, admitted or not.
 */
export async function admitBrowserSession(input: {
  store: LeaseStore;
  policy: Pick<HostedBrowserPolicy, 'monthlyBrowserHours' | 'maxRunningBrowsers' | 'sessionsPerMinute'>;
  reservationId: string;
  contextId?: string;
  timeoutSeconds: number;
  now: number;
}): Promise<BrowserSessionAdmission> {
  const { policy, now } = input;
  return updateLeases(input.store, now, (row, meteredSeconds) => {
    const charged = chargeLapsed(row, now);
    const running = Object.values(row.leases);
    const used = meteredSeconds + charged + running.reduce((total, lease) => total + Math.max(0, now - lease.startedAt) / 1_000, 0);
    let admission: BrowserSessionAdmission = 'admitted';
    if (used >= policy.monthlyBrowserHours * 3_600) admission = 'hours_cap';
    else if (input.contextId && running.some((lease) => lease.contextId === input.contextId)) admission = 'context_in_use';
    else if (running.length >= policy.maxRunningBrowsers) admission = 'running_limit';
    else if (row.recentCreations.length >= policy.sessionsPerMinute) admission = 'rate_limit';
    if (admission === 'admitted') {
      row.leases[input.reservationId] = {
        startedAt: now,
        leaseUntil: now + input.timeoutSeconds * 1_000,
        ...(input.contextId ? { contextId: input.contextId } : {}),
      };
      row.recentCreations.push(now);
    }
    return { charged, result: admission };
  });
}

/** Record which provider session holds the reservation's lease. */
export async function attachBrowserSession(input: {
  store: LeaseStore;
  reservationId: string;
  sessionId: string;
  now: number;
}): Promise<void> {
  await updateLeases(input.store, input.now, (row) => {
    const lease = row.leases[input.reservationId];
    if (lease) lease.sessionId = input.sessionId;
    return { charged: 0, result: undefined };
  });
}

/** Drop the lease of a session the provider did not create; nothing ran, so nothing is metered. */
export async function releaseBrowserReservation(input: { store: LeaseStore; reservationId: string; now: number }): Promise<void> {
  await updateLeases(input.store, input.now, (row) => {
    delete row.leases[input.reservationId];
    return { charged: 0, result: undefined };
  });
}

/** Release the lease of a session that ended and meter its run. Returns the seconds charged. */
export async function closeBrowserSessionLease(input: { store: LeaseStore; sessionId: string; now: number }): Promise<number> {
  const { now } = input;
  return updateLeases(input.store, now, (row) => {
    const held = Object.entries(row.leases).find(([, lease]) => lease.sessionId === input.sessionId);
    if (!held) return { charged: 0, result: 0 };
    const [reservationId, lease] = held;
    delete row.leases[reservationId];
    const charged = billedSeconds(lease, Math.min(now, lease.leaseUntil));
    return { charged, result: charged };
  });
}

/** Work maintenance: charge each lease past its timeout up to it and drop it. Returns how many. */
export async function chargeLapsedBrowserSessionLeases(input: { store: LeaseStore; now: number }): Promise<number> {
  const { now } = input;
  return updateLeases(input.store, now, (row) => {
    const before = Object.keys(row.leases).length;
    const charged = chargeLapsed(row, now);
    return { charged, result: before - Object.keys(row.leases).length };
  });
}

/** One installation's sweep. Standalone holds no leases. */
export async function maintainBrowserSessionLeases(env: PlatformEnv | undefined, now: number): Promise<void> {
  if (deploymentTenancy(env) !== 'installation') return;
  await chargeLapsedBrowserSessionLeases({ store: getSettingsStore(env), now });
}

/** The leases held and the month's metered seconds, for a census. */
export async function readBrowserSessionUsage(input: { store: LeaseStore; now: number }): Promise<{
  month: string;
  meteredSeconds: number;
  leases: BrowserSessionLease[];
}> {
  const month = utcMonthKey(new Date(input.now));
  const [rawLeases, rawMonth] = await input.store.getSettings([BROWSER_SESSION_LEASES_KEY, `${BROWSER_SECONDS_PREFIX}${month}`]);
  return { month, meteredSeconds: parseMeteredSeconds(rawMonth), leases: Object.values(parseLeaseRow(rawLeases).leases) };
}

/** What the provider bills for a run: whole minutes, at least one. */
export function billedSeconds(lease: Pick<BrowserSessionLease, 'startedAt'>, until: number): number {
  return Math.max(1, Math.ceil(Math.max(0, until - lease.startedAt) / 60_000)) * 60;
}

/** Charge and drop every lease past its timeout, up to that timeout. */
function chargeLapsed(row: LeaseRow, now: number): number {
  let charged = 0;
  for (const [reservationId, lease] of Object.entries(row.leases)) {
    if (lease.leaseUntil >= now) continue;
    charged += billedSeconds(lease, lease.leaseUntil);
    delete row.leases[reservationId];
  }
  return charged;
}

/**
 * One compare-and-set update of the lease row and the month's meter.
 * `change` edits the row in place and says how many seconds to add to the
 * meter. It never sees a creation time older than a minute.
 */
async function updateLeases<R>(
  store: LeaseStore,
  now: number,
  change: (row: LeaseRow, meteredSeconds: number) => { charged: number; result: R },
): Promise<R> {
  const monthKey = `${BROWSER_SECONDS_PREFIX}${utcMonthKey(new Date(now))}`;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const [rawLeases, rawMonth] = await store.getSettings([BROWSER_SESSION_LEASES_KEY, monthKey]);
    const row = parseLeaseRow(rawLeases);
    row.recentCreations = row.recentCreations.filter((at) => now - at < RATE_WINDOW_MS);
    const meteredSeconds = parseMeteredSeconds(rawMonth);
    const before = JSON.stringify(row);
    const step = change(row, meteredSeconds);
    const after = JSON.stringify(row);
    if (step.charged === 0 && after === before) return step.result;
    const applied = await store.applySettingsPatch({
      expectedAll: [
        { key: BROWSER_SESSION_LEASES_KEY, value: rawLeases ?? null },
        { key: monthKey, value: rawMonth ?? null },
      ],
      set: [
        { key: BROWSER_SESSION_LEASES_KEY, value: after },
        ...(step.charged > 0 ? [{ key: monthKey, value: JSON.stringify({ seconds: meteredSeconds + step.charged }) }] : []),
      ],
    });
    if (applied) return step.result;
  }
  throw new Error('Could not update the browser session leases after concurrent updates');
}

function parseLeaseRow(raw: string | undefined): LeaseRow {
  const row: LeaseRow = { leases: {}, recentCreations: [] };
  if (raw === undefined) return row;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return row;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return row;
  const { leases, recentCreations } = parsed as Record<string, unknown>;
  if (typeof leases === 'object' && leases !== null && !Array.isArray(leases)) {
    for (const [reservationId, value] of Object.entries(leases as Record<string, unknown>)) {
      const lease = value as Partial<BrowserSessionLease> | null;
      if (typeof lease !== 'object' || lease === null) continue;
      if (!Number.isFinite(lease.startedAt) || !Number.isFinite(lease.leaseUntil)) continue;
      row.leases[reservationId] = {
        startedAt: lease.startedAt!,
        leaseUntil: lease.leaseUntil!,
        ...(typeof lease.sessionId === 'string' ? { sessionId: lease.sessionId } : {}),
        ...(typeof lease.contextId === 'string' ? { contextId: lease.contextId } : {}),
      };
    }
  }
  if (Array.isArray(recentCreations)) {
    row.recentCreations = recentCreations.filter((at): at is number => typeof at === 'number' && Number.isFinite(at));
  }
  return row;
}

function parseMeteredSeconds(raw: string | undefined): number {
  if (raw === undefined) return 0;
  try {
    const seconds = (JSON.parse(raw) as { seconds?: unknown } | null)?.seconds;
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  } catch {
    return 0;
  }
}
