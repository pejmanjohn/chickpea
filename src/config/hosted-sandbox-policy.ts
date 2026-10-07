/**
 * The coding sandbox policy of a deployment serving many installations.
 *
 * On standalone the operator's own settings decide whether the coding
 * workspace is on, which package registries it reaches and how many sessions
 * a month it may start. On a deployment serving many installations the host
 * decides instead, per installation, and the tenant's `sandbox.*` settings
 * are never read: the host installs one reader at module scope, Core asks it
 * per installation and keeps each answer 30 seconds in the isolate.
 *
 * Fail closed. With no reader installed, or an answer that is not a complete
 * policy, the installation has no coding workspace. When the reader fails,
 * the last answer stands while it is under ten minutes old; after that the
 * workspace is off until the reader answers again.
 */
export interface HostedSandboxPolicy {
  enabled: boolean;
  /** Package registries the container may reach; resolveSandboxSettings keeps only the curated set. */
  allowedHosts: readonly string[];
  /** Container starts a month; at least 1. */
  monthlySessionCap: number;
  /** Container run time a month, in hours; above 0, fractions allowed. */
  monthlyContainerHours: number;
  /** Containers running at once; at least 1. */
  maxRunningContainers: number;
  /**
   * How long an idle workspace stays warm after a turn, in minutes: 1 to 30.
   * Absent or null, Core's 30 (src/sandbox/lifecycle.ts). A host shortens it only
   * where waiting out the idle stop costs more than a follow-up's cold start,
   * such as a staging deployment's live verification.
   */
  warmWindowMinutes?: number;
}

/** The host's policy for one installation, from its registry. */
export type HostedSandboxPolicyReader = (installationId: string) => Promise<unknown> | unknown;

/** A host's warm window is at most Core's own, the Sandbox SDK's `sleepAfter`. */
const MAX_WARM_WINDOW_MINUTES = 30;
/** How long one answer serves an installation in this isolate. */
export const HOSTED_SANDBOX_POLICY_TTL_MS = 30_000;
/** How long a last known answer stands while the reader fails. */
export const HOSTED_SANDBOX_POLICY_LAST_KNOWN_MS = 10 * 60_000;
const MAX_CACHED_INSTALLATIONS = 1_024;
const LOG_INTERVAL_MS = 60_000;

/**
 * No coding workspace: what an installation gets without a valid policy. Its
 * limits admit nothing either, should anything read them past `enabled`.
 */
export const HOSTED_SANDBOX_POLICY_OFF: HostedSandboxPolicy = Object.freeze({
  enabled: false,
  allowedHosts: Object.freeze([]) as readonly string[],
  monthlySessionCap: 1,
  monthlyContainerHours: 0,
  maxRunningContainers: 0,
});

interface CachedPolicy {
  readonly policy: HostedSandboxPolicy;
  /** When this answer was cached: it serves until the TTL passes. */
  readonly at: number;
  /** When the reader last answered; a fallback during an outage keeps the earlier time. */
  readonly answeredAt: number | undefined;
}

let reader: HostedSandboxPolicyReader | undefined;
let clock: () => number = Date.now;
const answers = new Map<string, CachedPolicy>();
const pending = new Map<string, Promise<HostedSandboxPolicy>>();
const loggedAt = new Map<string, number>();

/** The composition seam: the host's reader, installed once at module scope; undefined removes it. */
export function configureHostedSandboxPolicy(next: HostedSandboxPolicyReader | undefined): void {
  reader = next;
  answers.clear();
  pending.clear();
}

/** Whether a host installed its reader, for a readiness probe or a boot check. */
export function hostedSandboxPolicyConfigured(): boolean {
  return reader !== undefined;
}

/** The installation's coding sandbox policy, cached per isolate for 30 seconds. Never throws. */
export async function hostedSandboxPolicy(installationId: string): Promise<HostedSandboxPolicy> {
  const current = reader;
  if (!current) {
    logAtMostEachMinute('sandbox_policy_missing', 'error');
    return HOSTED_SANDBOX_POLICY_OFF;
  }
  const cached = answers.get(installationId);
  if (cached && clock() - cached.at < HOSTED_SANDBOX_POLICY_TTL_MS) return cached.policy;
  const inFlight = pending.get(installationId);
  if (inFlight) return inFlight;
  const read = readPolicy(current, installationId, cached);
  pending.set(installationId, read);
  try {
    return await read;
  } finally {
    if (pending.get(installationId) === read) pending.delete(installationId);
  }
}

/** A complete policy, or undefined: every field present and in range. */
export function parseHostedSandboxPolicy(value: unknown): HostedSandboxPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const { enabled, allowedHosts, monthlySessionCap, monthlyContainerHours, maxRunningContainers, warmWindowMinutes } = candidate;
  if (typeof enabled !== 'boolean') return undefined;
  if (!Array.isArray(allowedHosts) || !allowedHosts.every((host) => typeof host === 'string')) return undefined;
  if (!positiveInteger(monthlySessionCap) || !positiveInteger(maxRunningContainers)) return undefined;
  if (typeof monthlyContainerHours !== 'number' || !Number.isFinite(monthlyContainerHours) ||
    monthlyContainerHours <= 0) return undefined;
  const warmWindowGiven = warmWindowMinutes !== undefined && warmWindowMinutes !== null;
  if (warmWindowGiven && (!positiveInteger(warmWindowMinutes) || warmWindowMinutes > MAX_WARM_WINDOW_MINUTES)) return undefined;
  return Object.freeze({
    enabled,
    allowedHosts: Object.freeze([...allowedHosts]),
    monthlySessionCap,
    monthlyContainerHours,
    maxRunningContainers,
    ...(warmWindowGiven ? { warmWindowMinutes } : {}),
  });
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

async function readPolicy(
  current: HostedSandboxPolicyReader,
  installationId: string,
  cached: CachedPolicy | undefined,
): Promise<HostedSandboxPolicy> {
  let policy: HostedSandboxPolicy;
  let answeredAt: number | undefined = clock();
  try {
    const parsed = parseHostedSandboxPolicy(await current(installationId));
    if (!parsed) logAtMostEachMinute('sandbox_policy_invalid', 'error');
    policy = parsed ?? HOSTED_SANDBOX_POLICY_OFF;
  } catch {
    logAtMostEachMinute('sandbox_policy_unavailable', 'warn');
    answeredAt = cached?.answeredAt;
    policy = cached && answeredAt !== undefined && clock() - answeredAt < HOSTED_SANDBOX_POLICY_LAST_KNOWN_MS
      ? cached.policy
      : HOSTED_SANDBOX_POLICY_OFF;
  }
  // A reader replaced while this read was in flight does not answer for it.
  if (reader !== current) return policy;
  answers.delete(installationId);
  answers.set(installationId, { policy, at: clock(), answeredAt });
  if (answers.size > MAX_CACHED_INSTALLATIONS) {
    const oldest = answers.keys().next();
    if (!oldest.done) answers.delete(oldest.value);
  }
  return policy;
}

/** Content-free: names no installation. */
function logAtMostEachMinute(event: string, level: 'error' | 'warn'): void {
  const at = clock();
  if (at - (loggedAt.get(event) ?? Number.NEGATIVE_INFINITY) < LOG_INTERVAL_MS) return;
  loggedAt.set(event, at);
  console[level](JSON.stringify({ component: 'hosted_sandbox_policy', event }));
}

export function resetHostedSandboxPolicyForTests(options: { now?: () => number } = {}): void {
  configureHostedSandboxPolicy(undefined);
  clock = options.now ?? Date.now;
  loggedAt.clear();
}
