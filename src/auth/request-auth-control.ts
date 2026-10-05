import type { Context, MiddlewareHandler } from 'hono';

import { ENVIRONMENT_AUTHORITY_PATH } from '../admin/environment-authority.ts';
import { isPublicAssetPath } from '../assets/public-assets.ts';
import { SLACK_RECOVERY_CALLBACK_PATH } from '../slack/app-manifest.ts';
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
 * Paths that answer to their own short-lived bearer capability and are never
 * gated, so they read no auth control: deployment activation and its gateway
 * delivery recovery, which must stay callable while an older release left the
 * installation recovery-only, and a QA lane's environment attestation.
 */
const CAPABILITY_PATHS: ReadonlySet<string> = new Set([
  '/internal/deployment/ready',
  '/internal/deployment/recover-delivery',
  ENVIRONMENT_AUTHORITY_PATH,
]);

/**
 * Slack credential recovery, the way out of recovery-only
 * (docs/runbooks/slack-auth-recovery.md): its page and form, the Slack
 * handoff page's script, and Slack's bot authorization callback.
 */
const RECOVERY_PATHS: ReadonlySet<string> = new Set([
  '/admin/recovery',
  '/auth/slack/continue.js',
  SLACK_RECOVERY_CALLBACK_PATH,
]);

/** Answers what a path may serve while recovery-only, or undefined for not found. */
type RecoveryResponder = (c: Context) => Promise<Response | undefined>;

/**
 * Answers not found while the installation's auth control is recovery-only,
 * for every request but Slack credential recovery, the capability paths and
 * public assets (which a Worker serves before it runs). A path in
 * `responders` that recovery needs Slack to reach, such as the Events URL,
 * serves only what its responder answers. The application and Admin both
 * mount this gate, so they keep one list of exceptions. It opens the
 * request's timing window, so Admin's Server-Timing covers this read too.
 */
export function recoveryOnlyGate(
  identity: (c: Context) => IdentityStore,
  responders: ReadonlyMap<string, RecoveryResponder> = new Map(),
): MiddlewareHandler {
  return (c, next) => runWithRequestTiming(async () => {
    const path = c.req.path;
    if (CAPABILITY_PATHS.has(path) || isPublicAssetPath(path.slice(1))) return next();
    const control = await requestAuthControl(c, () => timed('authctl', () => identity(c).getAuthControl()));
    if (control?.healthGate !== 'recovery_only' || RECOVERY_PATHS.has(path)) return next();
    return await responders.get(path)?.(c) ?? c.notFound();
  });
}
