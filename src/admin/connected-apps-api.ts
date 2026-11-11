import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { displayMcpClientName, returnAppName } from '../auth/mcp-client-name.ts';
import { requestPrincipal } from '../auth/service.ts';
import type { WorkspaceManagementService } from '../management/service.ts';
import { ManagementError, type ManagementActorContext } from '../management/types.ts';
import { invalidRequest, readJson } from './api-support.ts';

const disconnectBody = v.strictObject({
  appId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});

/**
 * Settings → Connected apps: the apps the signed-in person connected to
 * Chickpea, and Disconnect. The service reads and revokes only that person's
 * own apps, as `list_connected_apps` and `disconnect_app` do.
 */
export function createConnectedAppsAdminApi(
  management: (c: Context) => WorkspaceManagementService,
): Hono {
  const app = new Hono();
  app.onError((error, c) => connectedAppsError(c, error));

  app.get('/connected-apps', async (c) => {
    c.header('Cache-Control', 'no-store');
    const { clients } = await management(c).listMcpClients(actorContext(c));
    return c.json({
      apps: clients.map((client) => ({
        appId: client.clientId,
        ...appName(client.clientId, client.name),
        connectedAt: client.connectedAt,
        lastActiveAt: client.lastUsedAt,
      })),
    });
  });

  app.post('/connected-apps/disconnect', async (c) => {
    c.header('Cache-Control', 'no-store');
    const parsed = v.safeParse(disconnectBody, await readJson(c));
    if (!parsed.success) return invalidRequest(c);
    const revoked = await management(c).revokeMcpClient(actorContext(c), parsed.output.appId);
    return c.json(appName(revoked.clientId, revoked.name));
  });

  return app;
}

/** A known app in Chickpea's words; any other name is the app's own claim, and the page says so, as consent does. */
function appName(clientId: string, registeredName: string | null): { name: string | null; nameFromApp?: true } {
  const known = returnAppName(clientId, registeredName ?? undefined);
  if (known) return { name: known };
  const claimed = displayMcpClientName(registeredName ?? undefined);
  return claimed ? { name: claimed, nameFromApp: true } : { name: null };
}

class MissingPrincipalError extends Error {}

function actorContext(c: Context): ManagementActorContext {
  const principal = requestPrincipal(c.req.raw);
  if (!principal) throw new MissingPrincipalError();
  return {
    userId: principal.userId,
    membershipId: principal.membershipId,
    organizationId: principal.organizationId,
    origin: { kind: 'admin', sessionId: principal.correlationId },
  };
}

function connectedAppsError(c: Context, error: unknown): Response {
  if (error instanceof MissingPrincipalError) return c.json({ error: 'forbidden' }, 403);
  if (error instanceof ManagementError) {
    if (error.code === 'mcp_client_not_found') return c.json({ error: 'not_found' }, 404);
    if (error.code === 'invalid_request') return c.json({ error: 'connected_apps_unavailable' }, 409);
    return c.json({ error: 'forbidden' }, 403);
  }
  console.error('[chickpea] connected apps API failure:', error instanceof Error ? error.message : String(error));
  return c.json({ error: 'internal_error' }, 500);
}
