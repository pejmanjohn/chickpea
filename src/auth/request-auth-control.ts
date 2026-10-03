import type { Context, MiddlewareHandler } from 'hono';

import { runWithRequestTiming, timed } from '../http/request-timing.ts';
import type { AuthControl, IdentityStore } from '../identity/types.ts';

const controlByContext = new WeakMap<Context, Promise<AuthControl | undefined>>();

/**
 * This request's auth control, read once. Each read is a state-store round
 * trip, and one request asks several times: the application's recovery gate,
 * Admin's, the Better Auth context and authentication. The first reader's
 * `read` runs and the rest share its result through the request's context,
 * so every reader in one request must name the same installation's store.
 * A later request reads again. A failed read is not kept: the next reader in
 * the same request retries it.
 */
export function requestAuthControl(
  c: Context,
  read: () => Promise<AuthControl | undefined>,
): Promise<AuthControl | undefined> {
  const shared = controlByContext.get(c);
  if (shared) return shared;
  const pending = read();
  controlByContext.set(c, pending);
  pending.catch(() => {
    if (controlByContext.get(c) === pending) controlByContext.delete(c);
  });
  return pending;
}

/**
 * Answers not found for every request while the installation's auth control
 * is recovery-only. It opens the request's timing window, so Admin's
 * Server-Timing covers this read too.
 */
export function recoveryOnlyGate(identity: (c: Context) => IdentityStore): MiddlewareHandler {
  return (c, next) => runWithRequestTiming(async () => {
    const control = await requestAuthControl(c, () => timed('authctl', () => identity(c).getAuthControl()));
    if (control?.healthGate === 'recovery_only') return c.notFound();
    return next();
  });
}
