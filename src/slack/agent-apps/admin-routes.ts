/**
 * The Owner-only parts of Chickpea Admin for Agents' own Slack apps: the
 * workspace's JSON API (the mode, the configuration token, and each Agent's
 * Slack state with Start and Cancel), and the older token page under one
 * Agent. Mounted behind Admin's sign-in and request protection; 404 without
 * the port.
 */
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import { invalidRequest, noStore, readJson } from '../../admin/api-support.ts';
import { renderSlackJourneyPage } from '../../admin/page.ts';
import { isOwnerSession } from '../../auth/permissions.ts';
import type { AuthPrincipal } from '../../auth/types.ts';
import { UnknownAgentError } from '../../config/errors.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { AgentChannelGrant, CustomAgentConfig } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import { requestOrigin } from '../../http/request-origin.ts';
import { escapeHtml } from '../../security/html-escape.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from '../agent-presence/avatar-assets.ts';
import { agentSlackAppsHost, type AgentSlackAppsHost } from './host.ts';
import { type AgentSlackState, agentSlackState, placedNowhere } from './lifecycle.ts';
import { liveAgentSlackApps } from './live.ts';
import { ADMIN_PATH, permissionNeededCopy, tokenApiPath, YOUR_APPS_URL } from './pages.ts';
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

const TOKEN_PAGE_PATH = '/admin/agents/:agentId/slack-app';
const TOKEN_API_PATH = '/admin/api/agents/:agentId/slack-app/token';

export function isAgentSlackAppTokenApiPath(path: string): boolean {
  return /^\/admin\/api\/agents\/[^/]+\/slack-app\/token$/.test(path);
}

export interface AgentSlackAppAdminDeps {
  actor(c: Context): Promise<{ principal: AuthPrincipal; slackUserId: string; slackTeamId: string }>;
  getAgent(c: Context, agentId: string): Promise<CustomAgentConfig | undefined>;
  /**
   * Give each of these Agents a user group and finish the Channels its
   * creator asked for, as creation in `shared` mode would have; each one's
   * failure is kept on it and the rest go on.
   */
  placeInSlack(c: Context, agentIds: readonly string[]): Promise<void>;
  /** Where each change is recorded as an audit event. */
  identity(c: Context): IdentityStore;
  /** Test seam: the service for an env; live stores and the main bot otherwise. */
  service?: (env: PlatformEnv | undefined, host: AgentSlackAppsHost) => Promise<AgentSlackApps>;
}

type TokenPageError =
  | 'not_refresh_token'
  | 'rejected'
  | 'other_workspace'
  | 'slack_down'
  | 'app_limit'
  | 'already_started';

const ERRORS: Record<Exclude<TokenPageError, 'already_started'>, string> = {
  not_refresh_token: "That isn't a refresh token. Copy the Refresh Token, which starts with xoxe-.",
  rejected: "Slack didn't accept that token. Generate a new one and paste its Refresh Token.",
  other_workspace: 'That token is for a different Slack workspace. Generate one for this workspace.',
  slack_down: "Slack didn't answer. Try again in a minute.",
  app_limit:
    "Slack wouldn't create another app for this workspace, which may have reached Slack's limit on apps. Deleting an app you no longer need in Slack and trying again may help.",
};

function errorText(error: TokenPageError, name: string): string {
  return error === 'already_started' ? `${name} already has its own Slack app.` : ERRORS[error];
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
 *   Agents still not in Slack after it, so pressing again repairs a reconcile that stopped partway.
 * - `PUT /admin/api/slack-apps/token` `{ refreshToken }` → `{ token }`; 400 `{ error: 'not_refresh_token' | 'rejected' |
 *   'other_workspace' }`; 503 `{ error: 'slack_down' }`.
 * - `DELETE /admin/api/slack-apps/token` → `{ token: { stored: false }, removed: 'discarded' | 'unconfirmed' | 'none' }`.
 * - `POST /admin/api/slack-apps/agents/:agentId/start` → 200 `{ next: 'authorize', authorizeUrl, agent }`; 202
 *   `{ next: 'creating', agent }`; 409 `{ error: 'token_needed' | 'permission_needed' | 'app_limit' }` or
 *   `{ error: 'needs_attention' | 'already_own_app' | 'cancelling', agent }`; 404.
 * - `POST /admin/api/slack-apps/agents/:agentId/cancel` → `{ agent, app: 'deleted' | 'left_for_owner' }`; 409
 *   `{ error: 'not_waiting' }`; 503 `{ error: 'slack_unavailable' }`; 404.
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
    const { setting, changed } = await gated.apps.setMode(parsed.output.mode, gated.slackUserId);
    if (changed) await audit(c, gated.principal, 'agent_apps.mode_changed', setting.mode);
    if (setting.mode !== 'shared') return c.json({ setting: settingJson(setting) });
    // Shared: each Agent in Slack nowhere gets a user group. Agents with an app, or one on its way, keep it.
    const unplaced = async () => (await gated.apps.userAgents()).filter((agent) => placedNowhere(agent.slackPresence));
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
    const pressed = await known(() => apps.press(c.req.param('agentId'), gated.slackUserId));
    if (pressed && pressed.kind !== 'not_eligible') await audit(c, gated.principal, 'agent_apps.started', pressed.kind);
    switch (pressed?.kind) {
      case 'authorize':
        return c.json({ next: 'authorize', authorizeUrl: pressed.url, agent: await rowOf(c, apps, pressed.agent) });
      case 'creating':
        return c.json({ next: 'creating', agent: await rowOf(c, apps, pressed.agent) }, 202);
      case 'needs_attention':
      case 'already_own_app':
      case 'cancelling':
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

  const gate = async (c: Context): Promise<
    | { ok: true; host: AgentSlackAppsHost; agent: CustomAgentConfig; slackUserId: string; principal: AuthPrincipal }
    | { ok: false; response: Response }
  > => {
    const host = agentSlackAppsHost();
    if (!host) return { ok: false, response: await c.notFound() };
    const actor = await deps.actor(c);
    if (!isOwnerSession(actor.principal)) {
      return { ok: false, response: c.json({ error: 'forbidden' }, 403) };
    }
    const agent = await deps.getAgent(c, c.req.param('agentId') ?? '');
    if (!agent || agent.kind !== 'user') return { ok: false, response: await c.notFound() };
    return { ok: true, host, agent, slackUserId: actor.slackUserId, principal: actor.principal };
  };

  app.get(TOKEN_PAGE_PATH, async (c) => {
    const gated = await gate(c);
    if (!gated.ok) return gated.response;
    const apps = await service(c.env as PlatformEnv | undefined, gated.host);
    return c.html(tokenPage(gated.agent, await apps.hasConfigurationToken()));
  });

  app.post(TOKEN_API_PATH, async (c) => {
    const gated = await gate(c);
    if (!gated.ok) return gated.response;
    const body = await c.req.parseBody();
    const action = typeof body.action === 'string' ? body.action : 'paste';
    const apps = await service(c.env as PlatformEnv | undefined, gated.host);
    const { agent } = gated;
    if (action === 'remove') {
      const removed = await apps.removeConfigurationToken();
      await audit(c, gated.principal, 'agent_apps.token_removed', removed);
      return c.html(removedPage(removed));
    }
    if (action === 'paste') {
      const token = typeof body.refreshToken === 'string' ? body.refreshToken : '';
      let saved;
      try {
        saved = await apps.pasteConfigurationToken(token, gated.slackUserId);
      } catch (error) {
        if (!(error instanceof SlackUnavailable)) throw error;
        return c.html(tokenPage(agent, false, 'slack_down'), 503);
      }
      if (saved !== 'saved') return c.html(tokenPage(agent, false, saved), 400);
      await audit(c, gated.principal, 'agent_apps.token_pasted');
    }
    const started = await apps.start(agent.id, gated.slackUserId);
    if (started.kind !== 'not_eligible') await audit(c, gated.principal, 'agent_apps.started', started.kind);
    if (started.kind === 'token_needed') return c.html(tokenPage(agent, false), 400);
    if (started.kind === 'permission_needed') return c.html(permissionPage(agent), 409);
    if (started.kind === 'already_started') return c.html(tokenPage(agent, true, 'already_started'), 409);
    if (started.kind === 'app_limit') return c.html(tokenPage(agent, true, 'app_limit'), 409);
    if (started.kind === 'not_eligible') return c.notFound();
    return c.html(creatingPage(agent));
  });

  return app;
}

const yourApps = `<p><a href="${YOUR_APPS_URL}" target="_blank" rel="noopener">Open Your Apps in Slack</a></p>`;

function tokenPage(agent: CustomAgentConfig, tokenStored: boolean, error?: TokenPageError): string {
  const name = escapeHtml(agent.name);
  const action = tokenApiPath(agent.id);
  const body = tokenStored
    ? `<form method="post" action="${action}">
        <input type="hidden" name="action" value="create">
        <button class="auth-button" type="submit">Create ${name}'s Slack app</button>
      </form>
      <form method="post" action="${action}">
        <input type="hidden" name="action" value="remove">
        <button class="auth-button" type="submit">Remove the configuration token</button>
      </form>`
    : `<p>In Slack, open Your Apps. Under Your App Configuration Tokens, choose Generate Token, pick this workspace, then copy the Refresh Token.</p>
      <p>If Slack doesn't offer this workspace when you choose Generate Token, you already hold as many tokens as Slack allows there. Delete one you no longer use under Your App Configuration Tokens, or ask another Owner to do this step.</p>
      ${yourApps}
      <form method="post" action="${action}">
        <input type="hidden" name="action" value="paste">
        <label for="refresh-token">Refresh token</label>
        <input id="refresh-token" name="refreshToken" type="password" required maxlength="512" autocomplete="off" aria-describedby="refresh-token-help">
        <p id="refresh-token-help" class="auth-help">Starts with xoxe-</p>
        <button class="auth-button" type="submit">Create ${name}'s Slack app</button>
      </form>
      <p class="auth-help">Chickpea stores this token encrypted. Slack lets it manage the Slack apps you created in this workspace; Chickpea only changes the apps it creates for your Agents.</p>`;
  return renderSlackJourneyPage({
    surface: 'agent-slack-app',
    eyebrow: 'Chickpea',
    title: 'Let Chickpea create Slack apps for your Agents',
    intro: `To give ${agent.name} its own Slack app, Chickpea needs a Slack app configuration token for this workspace. You only do this once.`,
    body,
    alert: error ? errorText(error, agent.name) : undefined,
  });
}

function creatingPage(agent: CustomAgentConfig): string {
  return renderSlackJourneyPage({
    surface: 'agent-slack-app',
    eyebrow: 'Chickpea',
    title: `Creating ${agent.name}'s Slack app`,
    titleSuccess: true,
    body: '<p>Go back to Slack. Chickpea will message you in a moment so you can allow it.</p>',
  });
}

function permissionPage(agent: CustomAgentConfig): string {
  const handle = agent.slackPresence?.normalizedHandle ?? agent.id;
  return renderSlackJourneyPage({
    surface: 'agent-slack-app',
    eyebrow: 'Chickpea',
    title: 'Let Chickpea create Slack apps for your Agents',
    body: `<p>${escapeHtml(permissionNeededCopy({ handle }))}</p><div class="auth-actions"><a class="auth-link" href="${ADMIN_PATH}">Open Chickpea</a></div>`,
  });
}

/** Slack stops listing a token while it still works, so the page never sends the Owner to Your Apps to check. */
function removedPage(removed: 'discarded' | 'unconfirmed' | 'none'): string {
  return renderSlackJourneyPage({
    surface: 'agent-slack-app',
    eyebrow: 'Chickpea',
    title: 'Let Chickpea create Slack apps for your Agents',
    body: `<p>${escapeHtml(REMOVED_COPY[removed])}</p>`,
  });
}

/** Each sentence claims only what this removal did; `none` says nothing about Slack. */
const REMOVED_COPY = {
  discarded: 'Chickpea deleted its copy of your configuration token and retired that token at Slack.',
  unconfirmed: "Chickpea deleted its copy of your configuration token, but Slack didn't confirm the token stopped working, so Slack may still accept it.",
  none: 'Chickpea holds no configuration token for this workspace.',
} as const;

/** An Agent that is not there reads as not found, as Admin answers for any other missing Agent. */
async function known<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnknownAgentError) return undefined;
    throw error;
  }
}
