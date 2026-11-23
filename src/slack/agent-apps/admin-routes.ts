/**
 * The Owner-only parts of Chickpea Admin for Agents' own Slack apps: the
 * workspace's JSON API (the mode, the configuration token, and each Agent's
 * Slack state with Start and Cancel), and the redirect from the older token
 * page under one Agent to Admin's. Mounted behind Admin's sign-in and request
 * protection; 404 without the port.
 */
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import { invalidRequest, noStore, readJson } from '../../admin/api-support.ts';
import { isOwnerSession } from '../../auth/permissions.ts';
import type { AuthPrincipal } from '../../auth/types.ts';
import { UnknownAgentError } from '../../config/errors.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { AgentChannelGrant, CustomAgentConfig } from '../../config/types.ts';
import { requestOrigin } from '../../http/request-origin.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from '../agent-presence/avatar-assets.ts';
import { AgentPresenceError } from '../agent-presence/errors.ts';
import { agentSlackAppsHost, type AgentSlackAppsHost } from './host.ts';
import { type AgentSlackState, agentSlackState } from './lifecycle.ts';
import { liveAgentSlackApps } from './live.ts';
import { TOKEN_PAGE_PATH } from './pages.ts';
import type { AgentSlackApps } from './service.ts';
import { AGENT_SLACK_APPS_MODES, type AgentSlackAppsSetting } from './setting.ts';
import { SlackUnavailable } from './slack-api.ts';

/** The workspace API's root; see `createAgentSlackAppAdminRoutes` for each route and its JSON. */
const API = '/admin/api/slack-apps';
/** A refresh token is well under this; anything longer is refused before it is read. */
const MAX_TOKEN_BODY_BYTES = 1_024;
const MAX_BODY_BYTES = 256;
const modeSchema = v.strictObject({ mode: v.picklist(AGENT_SLACK_APPS_MODES) });
const tokenSchema = v.strictObject({ refreshToken: v.pipe(v.string(), v.maxLength(512)) });

const OLD_TOKEN_PAGE_PATH = '/admin/agents/:agentId/slack-app';

export interface AgentSlackAppAdminDeps {
  actor(c: Context): Promise<{ principal: AuthPrincipal; slackUserId: string; slackTeamId: string }>;
  /** Test seam: the service for an env; live stores and the main bot otherwise. */
  service?: (env: PlatformEnv | undefined, host: AgentSlackAppsHost) => Promise<AgentSlackApps>;
}

/** One user Agent as the workspace API lists it. */
export interface SlackAppsAgentRow {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  slack: AgentSlackState;
  channels: Array<{ id: string; name: string | null; private: boolean; status: AgentChannelGrant['status'] }>;
}

/** The avatar is the URL Admin shows it at elsewhere. */
function agentRow(c: Context, agent: CustomAgentConfig, grants: readonly AgentChannelGrant[]): SlackAppsAgentRow {
  const presence = agent.slackPresence!;
  const installationId = agentAvatarInstallation(c.env as PlatformEnv | undefined);
  return {
    id: agent.id,
    name: agent.name,
    handle: presence.normalizedHandle,
    avatarUrl: agentAvatarUrlForPresentation(agent, requestOrigin(c), installationId) ?? null,
    slack: agentSlackState(presence),
    channels: grants.filter((grant) => grant.agentId === agent.id).map((grant) => ({
      id: grant.channelId, name: grant.channelLabel ?? null, private: grant.channelIsPrivate === true, status: grant.status,
    })),
  };
}

const settingJson = (setting: AgentSlackAppsSetting) => ({
  mode: setting.mode, changedBy: setting.changedBy ?? null, changedAt: setting.changedAt ?? null,
});

/**
 * Routes, each Owner-only (an Owner signed in as themselves, never a token)
 * and 404 without the port; changes carry Admin's JSON request protection:
 *
 * - `GET /admin/api/slack-apps` → `{ setting: { mode, changedBy, changedAt }, token: { stored: false } |
 *   { stored: true, pastedBy, pastedAt }, agents: SlackAppsAgentRow[] }`.
 * - `PUT /admin/api/slack-apps/mode` `{ mode: 'shared' | 'own_app' }` → `{ setting }`.
 * - `PUT /admin/api/slack-apps/token` `{ refreshToken }` → `{ token }`; 400 `{ error: 'not_refresh_token' | 'rejected' |
 *   'other_workspace' }`; 503 `{ error: 'slack_down' }`.
 * - `DELETE /admin/api/slack-apps/token` → `{ token: { stored: false }, slackMayStillAccept }`.
 * - `POST /admin/api/slack-apps/agents/:agentId/start` → 200 `{ next: 'authorize', authorizeUrl, agent }`; 202
 *   `{ next: 'creating', agent }`; 409 `{ error: 'token_needed' | 'permission_needed' }` or
 *   `{ error: 'needs_attention' | 'already_own_app', agent }`; 404.
 * - `POST /admin/api/slack-apps/agents/:agentId/cancel` → `{ agent }`; 409 `{ error: 'not_waiting' }`; 503
 *   `{ error: 'slack_unavailable' }`; 404.
 */
export function createAgentSlackAppAdminRoutes(deps: AgentSlackAppAdminDeps): Hono {
  const app = new Hono();
  const service = deps.service ?? liveAgentSlackApps;

  const owner = async (c: Context): Promise<
    | { ok: true; apps: AgentSlackApps; slackUserId: string }
    | { ok: false; response: Response }
  > => {
    const host = agentSlackAppsHost();
    if (!host) return { ok: false, response: c.json({ error: 'not_found' }, 404) };
    const actor = await deps.actor(c);
    if (!isOwnerSession(actor.principal)) return { ok: false, response: c.json({ error: 'forbidden' }, 403) };
    return { ok: true, apps: await service(c.env as PlatformEnv | undefined, host), slackUserId: actor.slackUserId };
  };

  const rowOf = async (c: Context, apps: AgentSlackApps, agent: CustomAgentConfig) => agentRow(c, agent, await apps.agentChannelGrants());

  app.use(API, noStore);
  app.use(`${API}/*`, noStore);

  app.get(API, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const { apps } = gated;
    const [setting, token, agents, grants] = await Promise.all([
      apps.setting(), apps.configurationToken(), apps.userAgents(), apps.agentChannelGrants(),
    ]);
    return c.json({ setting: settingJson(setting), token, agents: agents.map((agent) => agentRow(c, agent, grants)) });
  });

  app.put(`${API}/mode`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const parsed = v.safeParse(modeSchema, await readJson(c, MAX_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    return c.json({ setting: settingJson(await gated.apps.setMode(parsed.output.mode, gated.slackUserId)) });
  });

  app.put(`${API}/token`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const parsed = v.safeParse(tokenSchema, await readJson(c, MAX_TOKEN_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    let saved;
    try {
      saved = await gated.apps.pasteConfigurationToken(parsed.output.refreshToken, gated.slackUserId);
    } catch (error) {
      if (!(error instanceof SlackUnavailable)) throw error;
      return c.json({ error: 'slack_down' }, 503);
    }
    if (saved !== 'saved') return c.json({ error: saved }, 400);
    return c.json({ token: await gated.apps.configurationToken() });
  });

  app.delete(`${API}/token`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const removed = await gated.apps.removeConfigurationToken();
    return c.json({ token: { stored: false }, slackMayStillAccept: removed === 'unconfirmed' });
  });

  app.post(`${API}/agents/:agentId/start`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const { apps } = gated;
    const pressed = await known(() => apps.press(c.req.param('agentId'), gated.slackUserId));
    switch (pressed?.kind) {
      case 'authorize':
        return c.json({ next: 'authorize', authorizeUrl: pressed.url, agent: await rowOf(c, apps, pressed.agent) });
      case 'creating':
        return c.json({ next: 'creating', agent: await rowOf(c, apps, pressed.agent) }, 202);
      case 'needs_attention':
      case 'already_own_app':
        return c.json({ error: pressed.kind, agent: await rowOf(c, apps, pressed.agent) }, 409);
      case 'token_needed':
      case 'permission_needed':
        return c.json({ error: pressed.kind }, 409);
      default:
        return c.json({ error: 'not_found' }, 404);
    }
  });

  app.post(`${API}/agents/:agentId/cancel`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const { apps } = gated;
    let cancelled;
    try {
      cancelled = await known(() => apps.cancel(c.req.param('agentId')));
    } catch (error) {
      if (!(error instanceof AgentPresenceError)) throw error;
      return c.json({ error: 'slack_unavailable' }, 503);
    }
    if (cancelled?.kind === 'cancelled') return c.json({ agent: await rowOf(c, apps, cancelled.agent) });
    if (cancelled?.kind === 'not_waiting') return c.json({ error: 'not_waiting' }, 409);
    return c.json({ error: 'not_found' }, 404);
  });

  // The token page moved into Admin; an older link, such as one in a DM, lands there.
  app.get(OLD_TOKEN_PAGE_PATH, (c) => (agentSlackAppsHost() ? c.redirect(TOKEN_PAGE_PATH, 302) : c.notFound()));

  return app;
}

/** An Agent that is not there reads as not found, as Admin answers for any other missing Agent. */
async function known<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnknownAgentError) return undefined;
    throw error;
  }
}
