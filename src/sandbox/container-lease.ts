/**
 * Running containers and monthly container time of one installation, on a
 * deployment serving many installations. Standalone has neither.
 *
 * A container holds a lease in the installation's own store while it runs,
 * keyed by its Sandbox Durable Object ID. Starting a container that holds no
 * lease is admitted only while fewer than the host's running limit hold one
 * and the month's container time is under the host's cap; a warm container
 * renews its lease, under the cap only. The Sandbox renews the lease when its
 * container starts and when a turn ends, and releases it when the container
 * stops, adding the run to the month's meter. A lease whose renewal lapsed is
 * closed by work maintenance once its Sandbox says the container is not
 * running, charged up to its lapse.
 *
 * Both rows change together under compare-and-set fences on both, so
 * concurrent starts in one installation cannot pass the running limit and a
 * run is never metered twice.
 */
import { utcMonthKey } from '../config/monthly-counter.ts';
import type { SandboxContainerLimits } from '../config/sandbox-settings.ts';
import type { SettingsStore } from '../config/settings-store.ts';

export const SANDBOX_CONTAINER_LEASES_KEY = 'sandbox.containerLeases';
export const SANDBOX_CONTAINER_SECONDS_PREFIX = 'sandbox.monthlyContainerSeconds.';
/** A lease stands this long after its last renewal: the 30-minute warm window and some slack. */
export const SANDBOX_CONTAINER_LEASE_MS = 35 * 60_000;
const MAX_CAS_ATTEMPTS = 12;

type LeaseStore = Pick<SettingsStore, 'getSettings' | 'applySettingsPatch'>;

interface ContainerLease {
  startedAt: number;
  leaseUntil: number;
}

type Leases = Record<string, ContainerLease>;

export type SandboxContainerAdmission = 'admitted' | 'running_limit' | 'hours_cap';

/**
 * Admit a container start or warm reuse for the Sandbox `key`. `running`
 * says whether its container already runs. Takes or renews the lease when
 * admitted; a lease left by a run that stopped unseen is charged and dropped
 * either way.
 */
export async function admitSandboxContainer(input: {
  store: LeaseStore;
  key: string;
  running: boolean;
  limits: SandboxContainerLimits;
  now: number;
}): Promise<SandboxContainerAdmission> {
  const { key, running, limits, now } = input;
  return updateLeases(input.store, now, (leases, meteredSeconds) => {
    let charged = 0;
    const existing = leases[key];
    if (existing && !running) {
      // Its last run stopped without a release: charge it up to its lapse.
      charged += runSeconds(existing, Math.min(now, existing.leaseUntil));
      delete leases[key];
    }
    const used = meteredSeconds + charged + Object.values(leases)
      .reduce((total, lease) => total + runSeconds(lease, now), 0);
    let admission: SandboxContainerAdmission = 'admitted';
    if (!(limits.monthlyContainerHours > 0) || used >= limits.monthlyContainerHours * 3_600) {
      admission = 'hours_cap';
    } else if (!leases[key] && !running &&
      Object.keys(leases).length >= Math.max(0, Math.floor(limits.maxRunningContainers))) {
      admission = 'running_limit';
    }
    if (admission === 'admitted') {
      leases[key] = { startedAt: leases[key]?.startedAt ?? now, leaseUntil: now + SANDBOX_CONTAINER_LEASE_MS };
    }
    return { charged, result: admission };
  });
}

/**
 * Hold the lease of a container that runs, without admission: when it has
 * started, or a turn on it ended. A lease that already lapsed belonged to an
 * earlier run, which is charged up to its lapse; this run starts now.
 */
export async function holdSandboxContainerLease(input: { store: LeaseStore; key: string; now: number }): Promise<void> {
  const { key, now } = input;
  await updateLeases(input.store, now, (leases) => {
    let charged = 0;
    const existing = leases[key];
    if (existing && existing.leaseUntil < now) {
      charged = runSeconds(existing, existing.leaseUntil);
      delete leases[key];
    }
    leases[key] = { startedAt: leases[key]?.startedAt ?? now, leaseUntil: now + SANDBOX_CONTAINER_LEASE_MS };
    return { charged, result: undefined };
  });
}

/** Release the lease of a container that stopped, metering its run. Returns the seconds charged. */
export async function releaseSandboxContainerLease(input: { store: LeaseStore; key: string; now: number }): Promise<number> {
  const { key, now } = input;
  return updateLeases(input.store, now, (leases) => {
    const existing = leases[key];
    if (!existing) return { charged: 0, result: 0, unchanged: true };
    delete leases[key];
    const charged = runSeconds(existing, now);
    return { charged, result: charged };
  });
}

/**
 * Work maintenance: close each lapsed lease whose Sandbox says its container
 * is not running, charged up to its lapse, and renew those whose container
 * runs. A Sandbox that cannot say keeps its lease, as it was, for the next
 * sweep: a failed call must not free a running container's slot or lose its
 * time. Starts no container.
 */
export async function closeLapsedSandboxContainerLeases(input: {
  store: LeaseStore;
  now: number;
  running: (key: string) => Promise<boolean>;
}): Promise<{ closed: number; renewed: number }> {
  const [raw] = await input.store.getSettings([SANDBOX_CONTAINER_LEASES_KEY]);
  const lapsed = Object.entries(parseLeases(raw)).filter(([, lease]) => lease.leaseUntil < input.now);
  if (lapsed.length === 0) return { closed: 0, renewed: 0 };
  const stillRunning = new Set<string>();
  const stopped = new Set<string>();
  for (const [key] of lapsed) {
    const running = await input.running(key).catch(() => undefined);
    if (running === true) stillRunning.add(key);
    else if (running === false) stopped.add(key);
  }
  return updateLeases(input.store, input.now, (leases) => {
    let charged = 0;
    let closed = 0;
    let renewed = 0;
    for (const [key, lease] of Object.entries(leases)) {
      if (lease.leaseUntil >= input.now) continue;
      if (stillRunning.has(key)) {
        lease.leaseUntil = input.now + SANDBOX_CONTAINER_LEASE_MS;
        renewed += 1;
      } else if (stopped.has(key)) {
        charged += runSeconds(lease, lease.leaseUntil);
        delete leases[key];
        closed += 1;
      }
    }
    return { charged, result: { closed, renewed }, unchanged: closed === 0 && renewed === 0 };
  });
}

/** The month's metered seconds and the leases now held, for an operator readback. */
export async function readSandboxContainerUsage(input: { store: LeaseStore; now: number }): Promise<{
  month: string;
  meteredSeconds: number;
  running: number;
}> {
  const month = utcMonthKey(new Date(input.now));
  const [rawLeases, rawMonth] = await input.store.getSettings([
    SANDBOX_CONTAINER_LEASES_KEY,
    `${SANDBOX_CONTAINER_SECONDS_PREFIX}${month}`,
  ]);
  return { month, meteredSeconds: parseMeteredSeconds(rawMonth), running: Object.keys(parseLeases(rawLeases)).length };
}

/**
 * One compare-and-set update of the leases and the month's meter. `change`
 * edits the leases in place and says how many seconds to add to the meter.
 */
async function updateLeases<R>(
  store: LeaseStore,
  now: number,
  change: (leases: Leases, meteredSeconds: number) => { charged: number; result: R; unchanged?: boolean },
): Promise<R> {
  const monthKey = `${SANDBOX_CONTAINER_SECONDS_PREFIX}${utcMonthKey(new Date(now))}`;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const [rawLeases, rawMonth] = await store.getSettings([SANDBOX_CONTAINER_LEASES_KEY, monthKey]);
    const leases = parseLeases(rawLeases);
    const meteredSeconds = parseMeteredSeconds(rawMonth);
    const before = JSON.stringify(leases);
    const step = change(leases, meteredSeconds);
    const charged = Math.max(0, Math.round(step.charged));
    if (step.unchanged || (charged === 0 && JSON.stringify(leases) === before)) return step.result;
    const applied = await store.applySettingsPatch({
      expectedAll: [
        { key: SANDBOX_CONTAINER_LEASES_KEY, value: rawLeases ?? null },
        { key: monthKey, value: rawMonth ?? null },
      ],
      set: [
        { key: SANDBOX_CONTAINER_LEASES_KEY, value: JSON.stringify(leases) },
        ...(charged > 0
          ? [{ key: monthKey, value: JSON.stringify({ seconds: meteredSeconds + charged }) }]
          : []),
      ],
    });
    if (applied) return step.result;
  }
  throw new Error('Could not update the coding workspace container leases after concurrent updates');
}

function runSeconds(lease: ContainerLease, until: number): number {
  return Math.max(0, (until - lease.startedAt) / 1_000);
}

function parseLeases(raw: string | undefined): Leases {
  const leases: Leases = {};
  if (raw === undefined) return leases;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return leases;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return leases;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const lease = value as Partial<ContainerLease> | null;
    if (
      typeof lease === 'object' && lease !== null &&
      Number.isFinite(lease.startedAt) && Number.isFinite(lease.leaseUntil)
    ) {
      leases[key] = { startedAt: lease.startedAt!, leaseUntil: lease.leaseUntil! };
    }
  }
  return leases;
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
