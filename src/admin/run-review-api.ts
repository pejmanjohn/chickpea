import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { requestPrincipal } from '../auth/service.ts';
import { installationScopeOf } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { runReview, type RunReviewPort } from '../review/port.ts';
import { invalidRequest, noStore, readJson } from './api-support.ts';

/** The Settings and onboarding row text a change was made under; bump it with the copy in admin.js. */
export const HELP_IMPROVE_TEXT_VERSION = 'help-improve-setting.2026-10-25';

const HELP_IMPROVE_PATH = '/settings/help-improve';
const MAX_BODY_BYTES = 256;
const changeSchema = v.strictObject({ enabled: v.boolean() });

interface RunReviewAdminApiOptions {
  identity: (c: Context) => IdentityStore;
}

/**
 * "Help improve Chickpea" in Settings and onboarding. The routes exist only
 * where the host installed a run review port and the request names an
 * installation; elsewhere both are not found. The host keeps the setting and
 * its history, so these routes only read and change it through the port.
 */
export function createRunReviewAdminApi(options: RunReviewAdminApiOptions): Hono {
  const app = new Hono();

  app.use(HELP_IMPROVE_PATH, noStore);

  app.get(HELP_IMPROVE_PATH, (c) => withRunReview(c, async (port, installationId) =>
    c.json({ enabled: await port.enabled(installationId) })));

  app.put(HELP_IMPROVE_PATH, (c) => withRunReview(c, async (port, installationId) => {
    const principal = requestPrincipal(c.req.raw);
    // The host records each change as a person's authorization, which a token cannot give.
    if (!principal || principal.machine) return c.json({ error: 'forbidden' }, 403);
    const parsed = v.safeParse(changeSchema, await readJson(c, MAX_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    const identity = options.identity(c);
    const user = await identity.getUser(principal.userId);
    if (!user?.slackUserId) return c.json({ error: 'forbidden' }, 403);
    const enabled = await port.setEnabled(installationId, {
      enabled: parsed.output.enabled,
      actor: { slackUserId: user.slackUserId, membershipId: principal.membershipId },
      textVersion: HELP_IMPROVE_TEXT_VERSION,
    });
    await identity.recordAuthAudit({
      event: 'authorization',
      outcome: 'success',
      action: parsed.output.enabled ? 'run_review.enabled' : 'run_review.disabled',
      correlationId: principal.correlationId,
      authenticatorKind: principal.authenticatorKind,
      userId: principal.userId,
      membershipId: principal.membershipId,
    }).catch(() => {
      console.warn(JSON.stringify({ component: 'run_review', event: 'audit_unavailable' }));
    });
    return c.json({ enabled });
  }));

  return app;
}

async function withRunReview(
  c: Context,
  handle: (port: RunReviewPort, installationId: string) => Promise<Response>,
): Promise<Response> {
  const port = runReview();
  const installationId = installationScopeOf(c.env as PlatformEnv | undefined)?.installationId;
  if (!port || !installationId) return c.json({ error: 'not_found' }, 404);
  try {
    return await handle(port, installationId);
  } catch {
    console.warn(JSON.stringify({ component: 'run_review', event: 'setting_unavailable', method: c.req.method }));
    return c.json({ error: 'run_review_unavailable' }, 503);
  }
}
