/**
 * Tells a deployment serving many installations each time an interactive
 * turn for one of them settles as succeeded, so the host can record that
 * activity in its own registry. Standalone never has one.
 *
 * The host installs one port once, at module scope. Core awaits each report
 * after the delivery is recorded and never skips a repeat, so the port must
 * answer quickly and keep any cache it needs itself. A port that fails never
 * fails the turn.
 */
export interface HostedActivityPort {
  interactiveDelivered(installationId: string): Promise<void> | void;
}

const LOG_INTERVAL_MS = 60_000;

let port: HostedActivityPort | undefined;
let clock: () => number = Date.now;
let loggedAt = Number.NEGATIVE_INFINITY;

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configureHostedActivity(next: HostedActivityPort | undefined): void {
  port = next;
}

/** Whether a host installed its port, for a readiness probe or a boot check. */
export function hostedActivityConfigured(): boolean {
  return port !== undefined;
}

/** Never throws. */
export async function reportInteractiveDelivery(installationId: string): Promise<void> {
  const current = port;
  if (!current) return;
  try {
    await current.interactiveDelivered(installationId);
  } catch {
    logAtMostEachMinute();
  }
}

function logAtMostEachMinute(): void {
  const at = clock();
  if (at - loggedAt < LOG_INTERVAL_MS) return;
  loggedAt = at;
  console.warn(JSON.stringify({ component: 'hosted_activity', event: 'interactive_delivery_failed' }));
}

export function resetHostedActivityForTests(options: { now?: () => number } = {}): void {
  configureHostedActivity(undefined);
  clock = options.now ?? Date.now;
  loggedAt = Number.NEGATIVE_INFINITY;
}
