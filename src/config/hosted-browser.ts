/**
 * The browser of a deployment serving many installations.
 *
 * On standalone the operator connects their own Browserbase project in
 * Settings › Browser. On a deployment serving many installations the host
 * holds one project and key for the whole deployment instead, and neither an
 * installation's `browser.browserbase.*` settings nor a `BROWSERBASE_*`
 * variable is ever read: the host installs one port at module scope, and Core
 * reads its policy on every session it creates and its access each time it
 * builds a provider.
 *
 * Fail closed. With no port, or a policy that is not complete, the browser is
 * off; with access that is not complete, it is unavailable.
 */
export interface HostedBrowserPolicy {
  readonly enabled: boolean;
  /** Browser time a month per installation, in hours; above 0, fractions allowed. */
  readonly monthlyBrowserHours: number;
  /** Browsers running at once per installation; at least 1. */
  readonly maxRunningBrowsers: number;
  /** Session creations a minute, per installation; at least 1. */
  readonly sessionsPerMinute: number;
}

export interface HostedBrowserAccess {
  readonly apiKey: string;
  readonly projectId: string;
}

export interface HostedBrowserPort {
  /** One policy for the deployment, from the Worker's `vars`. Read on every session create. */
  policy(): HostedBrowserPolicy;
  /** Read at call time from the Worker's env. Never persisted, logged, or exposed to tools. */
  access(): HostedBrowserAccess;
}

/** The browser off: what a deployment gets without a valid policy. Its limits admit nothing either. */
export const HOSTED_BROWSER_POLICY_OFF: HostedBrowserPolicy = Object.freeze({
  enabled: false,
  monthlyBrowserHours: 0,
  maxRunningBrowsers: 0,
  sessionsPerMinute: 0,
});

const LOG_INTERVAL_MS = 60_000;

let port: HostedBrowserPort | undefined;
const loggedAt = new Map<string, number>();

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configureHostedBrowser(next: HostedBrowserPort | undefined): void {
  port = next;
}

/** Whether a host installed its port, for a boot check. */
export function hostedBrowserConfigured(): boolean {
  return port !== undefined;
}

/** The deployment's browser policy, read again on each call. Never throws. */
export function hostedBrowserPolicy(): HostedBrowserPolicy {
  if (!port) return HOSTED_BROWSER_POLICY_OFF;
  try {
    const parsed = parseHostedBrowserPolicy(port.policy());
    if (!parsed) logAtMostEachMinute('policy_invalid');
    return parsed ?? HOSTED_BROWSER_POLICY_OFF;
  } catch {
    logAtMostEachMinute('policy_unavailable');
    return HOSTED_BROWSER_POLICY_OFF;
  }
}

/** The deployment's Browserbase access, or undefined without a port or with incomplete access. Never throws. */
export function hostedBrowserAccess(): HostedBrowserAccess | undefined {
  if (!port) return undefined;
  let value: unknown;
  try {
    value = port.access();
  } catch {
    logAtMostEachMinute('access_unavailable');
    return undefined;
  }
  const { apiKey, projectId } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const project = typeof projectId === 'string' ? projectId.trim() : '';
  if (!key || !project) {
    logAtMostEachMinute('access_invalid');
    return undefined;
  }
  return { apiKey: key, projectId: project };
}

/** A complete policy, or undefined: every field present and in range. */
export function parseHostedBrowserPolicy(value: unknown): HostedBrowserPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { enabled, monthlyBrowserHours, maxRunningBrowsers, sessionsPerMinute } = value as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return undefined;
  if (typeof monthlyBrowserHours !== 'number' || !Number.isFinite(monthlyBrowserHours) || monthlyBrowserHours <= 0) {
    return undefined;
  }
  if (!positiveInteger(maxRunningBrowsers) || !positiveInteger(sessionsPerMinute)) return undefined;
  return Object.freeze({ enabled, monthlyBrowserHours, maxRunningBrowsers, sessionsPerMinute });
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Content-free: names no installation and nothing the port returned. */
function logAtMostEachMinute(event: string): void {
  const at = Date.now();
  if (at - (loggedAt.get(event) ?? Number.NEGATIVE_INFINITY) < LOG_INTERVAL_MS) return;
  loggedAt.set(event, at);
  console.error(JSON.stringify({ component: 'hosted_browser', event }));
}

export function resetHostedBrowserForTests(): void {
  configureHostedBrowser(undefined);
  loggedAt.clear();
}
