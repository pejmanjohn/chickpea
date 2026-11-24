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
import { tagStateStub } from '../../config/state-rpc.ts';
import type { AgentChannelGrant, CustomAgentConfig } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import { requestOrigin } from '../../http/request-origin.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from '../agent-presence/avatar-assets.ts';
import { agentSlackAppsHost, type AgentSlackAppsHost } from './host.ts';
import { type AgentSlackState, agentSlackState, waitsForOwnApp } from './lifecycle.ts';
import { liveAgentSlackApps } from './live.ts';
import { TOKEN_PAGE_PATH } from './pages.ts';
import type { AgentSlackApps } from './service.ts';
import { AGENT_SLACK_APPS_MODES, type AgentSlackAppsSetting } from './setting.ts';
import { SlackUnavailable } from './slack-api.ts';

/**
 * Whether the installation's state store, which applies every change made
 * through Chickpea in Slack, runs code that knows the mode. A deploy leaves it
 * on the code before for minutes, and code from before the mode refuses the
 * question; a store that cannot be asked counts as not yet. Node has no state
 * store binding and one process.
 */
async function stateStoreKnowsMode(env: PlatformEnv | undefined): Promise<boolean> {
  if (!env?.TAG_STATE) return true;
  try {
    return (await tagStateStub(env).threadRunnerTurn({ kind: 'knowsAgentAppsMode' })).ok;
  } catch {
    return false;
  }
}

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
  /**
   * Give each of these Agents a user group and finish the Channels its
   * creator asked for, as creation in `shared` mode would have. The mode is
   * already `shared`, so each one's failure is recorded on it, with the
   * recovery that names the cause, and the rest go on.
   */
  placeInSlack(c: Context, agentIds: readonly string[]): Promise<void>;
  /** Where each change is recorded as an audit event. */
  identity(c: Context): IdentityStore;
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

/** The audit action each change is recorded under. */
type SlackAppsAuditAction =
  | 'agent_apps.mode_changed'
  | 'agent_apps.token_pasted'
  | 'agent_apps.token_removed'
  | 'agent_apps.started'
  | 'agent_apps.cancelled';

/**
 * Routes, each Owner-only (an Owner signed in as themselves, never a token)
 * and 404 without the port; changes carry Admin's JSON request protection:
 *
 * - `GET /admin/api/slack-apps` → `{ setting: { mode, changedBy, changedAt }, token: { stored: false } |
 *   { stored: true, pastedBy, pastedAt }, agents: SlackAppsAgentRow[] }`.
 * - `PUT /admin/api/slack-apps/mode` `{ mode: 'shared' | 'own_app' }` → `{ setting }`; with `shared`, every such PUT
 *   also gives each Agent in Slack nowhere a user group and answers `{ setting, waiting: SlackAppsAgentRow[] }`, the
 *   Agents still not in Slack after it, so pressing again repairs a reconcile that stopped partway. Turning
 *   `own_app` on answers 503 `{ error: 'updating' }` while the state store runs code from before the mode.
 * - `PUT /admin/api/slack-apps/token` `{ refreshToken }` → `{ token }`; 400 `{ error: 'not_refresh_token' | 'rejected' |
 *   'other_workspace' }`; 503 `{ error: 'slack_down' }`.
 * - `DELETE /admin/api/slack-apps/token` → `{ token: { stored: false }, removed: 'discarded' | 'unconfirmed' | 'none' }`.
 * - `POST /admin/api/slack-apps/agents/:agentId/start` → 200 `{ next: 'authorize', authorizeUrl, agent }`; 202
 *   `{ next: 'creating', agent }`; 409 `{ error: 'token_needed' | 'permission_needed' | 'app_limit' }` or
 *   `{ error: 'needs_attention' | 'already_own_app' | 'cancelling' | 'handle_taken', agent }`; 404. Slack's Allow then
 *   lands the Owner back on Admin's Slack connection section.
 * - `POST /admin/api/slack-apps/agents/:agentId/cancel` → `{ agent, app: 'deleted' | 'left_for_owner' | 'not_found' | 'none' }`:
 *   `none` when the start stopped before Slack made any app, `left_for_owner` too when one may exist after a create
 *   Slack never answered, `not_found` when Slack refused the delete and says the app does not exist; 409 `{ error: 'not_waiting' }`; 503 `{ error: 'slack_unavailable' }`; 404. A row whose start
 *   stopped before any app reads `{ state: 'needs_attention', reason, cancellable: true }`.
 *
 * Each change is recorded as an audit event; a failed record is logged and never fails the request.
 */
export function createAgentSlackAppAdminRoutes(deps: AgentSlackAppAdminDeps): Hono {
  const app = new Hono();
  const service = deps.service ?? liveAgentSlackApps;

  const owner = async (c: Context): Promise<
    | { ok: true; apps: AgentSlackApps; slackUserId: string; principal: AuthPrincipal }
    | { ok: false; response: Response }
  > => {
    const host = agentSlackAppsHost();
    if (!host) return { ok: false, response: c.json({ error: 'not_found' }, 404) };
    const actor = await deps.actor(c);
    if (!isOwnerSession(actor.principal)) return { ok: false, response: c.json({ error: 'forbidden' }, 403) };
    return {
      ok: true, apps: await service(c.env as PlatformEnv | undefined, host), slackUserId: actor.slackUserId, principal: actor.principal,
    };
  };

  /** `reasonCode` is an outcome or a mode, never anything taken from a token. */
  const audit = async (c: Context, principal: AuthPrincipal, action: SlackAppsAuditAction, reasonCode?: string): Promise<void> => {
    await deps.identity(c).recordAuthAudit({
      event: 'authorization',
      outcome: 'success',
      action,
      correlationId: principal.correlationId,
      authenticatorKind: principal.authenticatorKind,
      userId: principal.userId,
      membershipId: principal.membershipId,
      ...(reasonCode ? { reasonCode } : {}),
    }).catch(() => {
      console.warn(JSON.stringify({ component: 'agent_apps', event: 'audit_unavailable', action }));
    });
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
    // Turned on while the store runs code without the mode, the setting would promise what the next Agent made in Slack never gets.
    if (parsed.output.mode === 'own_app' && (await gated.apps.setting()).mode !== 'own_app'
      && !await stateStoreKnowsMode(c.env as PlatformEnv | undefined)) {
      c.header('Retry-After', '60');
      return c.json({ error: 'updating' }, 503);
    }
    const { setting, changed } = await gated.apps.setMode(parsed.output.mode, gated.slackUserId);
    if (changed) await audit(c, gated.principal, 'agent_apps.mode_changed', setting.mode);
    if (setting.mode !== 'shared') return c.json({ setting: settingJson(setting) });
    // Shared: each Agent waiting for its own app gets a user group. Agents with an app, or one on its way, keep it.
    const unplaced = async () => (await gated.apps.userAgents()).filter(waitsForOwnApp);
    const before = await unplaced();
    if (before.length > 0) await deps.placeInSlack(c, before.map((agent) => agent.id));
    const grants = await gated.apps.agentChannelGrants();
    const waiting = before.length > 0 ? await unplaced() : [];
    return c.json({ setting: settingJson(setting), waiting: waiting.map((agent) => agentRow(c, agent, grants)) });
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
    await audit(c, gated.principal, 'agent_apps.token_pasted');
    return c.json({ token: await gated.apps.configurationToken() });
  });

  app.delete(`${API}/token`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const removed = await gated.apps.removeConfigurationToken();
    await audit(c, gated.principal, 'agent_apps.token_removed', removed);
    return c.json({ token: { stored: false }, removed });
  });

  app.post(`${API}/agents/:agentId/start`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const { apps } = gated;
    const pressed = await known(() => apps.press(c.req.param('agentId'), gated.slackUserId, 'admin'));
    if (pressed && pressed.kind !== 'not_eligible') await audit(c, gated.principal, 'agent_apps.started', pressed.kind);
    switch (pressed?.kind) {
      case 'authorize':
        return c.json({ next: 'authorize', authorizeUrl: pressed.url, agent: await rowOf(c, apps, pressed.agent) });
      case 'creating':
        return c.json({ next: 'creating', agent: await rowOf(c, apps, pressed.agent) }, 202);
      case 'needs_attention':
      case 'already_own_app':
      case 'cancelling':
      case 'handle_taken':
        return c.json({ error: pressed.kind, agent: await rowOf(c, apps, pressed.agent) }, 409);
      case 'token_needed':
      case 'permission_needed':
      case 'app_limit':
        return c.json({ error: pressed.kind }, 409);
      default:
        return c.json({ error: 'not_found' }, 404);
    }
  });

  app.post(`${API}/agents/:agentId/cancel`, async (c) => {
    const gated = await owner(c);
    if (!gated.ok) return gated.response;
    const { apps } = gated;
    const cancelled = await known(() => apps.cancel(c.req.param('agentId'), gated.slackUserId));
    if (cancelled && cancelled.kind !== 'not_eligible') {
      await audit(c, gated.principal, 'agent_apps.cancelled', cancelled.kind === 'cancelled' ? cancelled.app : cancelled.kind);
    }
    switch (cancelled?.kind) {
      case 'cancelled':
        return c.json({ agent: await rowOf(c, apps, cancelled.agent), app: cancelled.app });
      case 'unfinished':
        return c.json({ error: 'slack_unavailable' }, 503);
      case 'not_waiting':
        return c.json({ error: 'not_waiting' }, 409);
      default:
        return c.json({ error: 'not_found' }, 404);
    }
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
