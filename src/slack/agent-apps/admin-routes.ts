/**
 * The Owner-only token page and its form: paste the workspace's Slack app
 * configuration token once, start an Agent's app, or remove the stored token.
 * Mounted inside Chickpea Admin behind its sign-in; 404 without the port.
 */
import { type Context, Hono } from 'hono';

import { renderSlackJourneyPage } from '../../admin/page.ts';
import type { AuthPrincipal } from '../../auth/types.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { CustomAgentConfig } from '../../config/types.ts';
import { escapeHtml } from '../../security/html-escape.ts';
import { agentSlackAppsHost, type AgentSlackAppsHost } from './host.ts';
import { liveAgentSlackApps } from './live.ts';
import { YOUR_APPS_URL } from './pages.ts';
import type { AgentSlackApps } from './service.ts';
import { SlackUnavailable } from './slack-api.ts';

export const TOKEN_PAGE_PATH = '/admin/agents/:agentId/slack-app';
export const TOKEN_API_PATH = '/admin/api/agents/:agentId/slack-app/token';

export function isAgentSlackAppTokenApiPath(path: string): boolean {
  return /^\/admin\/api\/agents\/[^/]+\/slack-app\/token$/.test(path);
}

export interface AgentSlackAppAdminDeps {
  actor(c: Context): Promise<{ principal: AuthPrincipal; slackUserId: string; slackTeamId: string }>;
  getAgent(c: Context, agentId: string): Promise<CustomAgentConfig | undefined>;
  /** Test seam: the service for an env; live stores and the main bot otherwise. */
  service?: (env: PlatformEnv | undefined, host: AgentSlackAppsHost) => Promise<AgentSlackApps>;
}

type TokenPageError =
  | 'not_refresh_token'
  | 'rejected'
  | 'other_workspace'
  | 'slack_down'
  | 'already_started';

const ERRORS: Record<TokenPageError, string> = {
  not_refresh_token: "That isn't a refresh token. Copy the Refresh Token, which starts with xoxe-.",
  rejected: "Slack didn't accept that token. Generate a new one and paste its Refresh Token.",
  other_workspace: 'That token is for a different Slack workspace. Generate one for this workspace.',
  slack_down: "Slack didn't answer. Try again in a minute.",
  already_started: (name: string) => `${name} already has its own Slack app.`,
} as unknown as Record<TokenPageError, string>;

function errorText(error: TokenPageError, name: string): string {
  return error === 'already_started' ? `${name} already has its own Slack app.` : ERRORS[error];
}

export function createAgentSlackAppAdminRoutes(deps: AgentSlackAppAdminDeps): Hono {
  const app = new Hono();
  const service = deps.service ?? liveAgentSlackApps;

  const gate = async (c: Context): Promise<
    | { ok: true; host: AgentSlackAppsHost; agent: CustomAgentConfig; slackUserId: string }
    | { ok: false; response: Response }
  > => {
    const host = agentSlackAppsHost();
    if (!host) return { ok: false, response: await c.notFound() };
    const actor = await deps.actor(c);
    if (actor.principal.machine || actor.principal.role !== 'owner') {
      return { ok: false, response: c.json({ error: 'forbidden' }, 403) };
    }
    const agent = await deps.getAgent(c, c.req.param('agentId') ?? '');
    if (!agent || agent.kind !== 'user') return { ok: false, response: await c.notFound() };
    return { ok: true, host, agent, slackUserId: actor.slackUserId };
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
      await apps.removeConfigurationToken();
      return c.html(removedPage(agent));
    }
    if (action === 'paste') {
      const token = typeof body.refreshToken === 'string' ? body.refreshToken : '';
      let saved;
      try {
        saved = await apps.pasteConfigurationToken(token);
      } catch (error) {
        if (!(error instanceof SlackUnavailable)) throw error;
        return c.html(tokenPage(agent, false, 'slack_down'), 503);
      }
      if (saved !== 'saved') return c.html(tokenPage(agent, false, saved), 400);
    }
    const started = await apps.start(agent.id, gated.slackUserId);
    if (started.kind === 'token_needed') return c.html(tokenPage(agent, false), 400);
    if (started.kind === 'already_started') return c.html(tokenPage(agent, true, 'already_started'), 409);
    if (started.kind === 'not_eligible') return c.notFound();
    return c.html(creatingPage(agent));
  });

  return app;
}

const yourApps = `<p><a href="${YOUR_APPS_URL}" target="_blank" rel="noopener">Open Your Apps in Slack</a></p>`;

function tokenPage(agent: CustomAgentConfig, tokenStored: boolean, error?: TokenPageError): string {
  const name = escapeHtml(agent.name);
  const action = `/admin/api/agents/${encodeURIComponent(agent.id)}/slack-app/token`;
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
      <p>Slack lets each person hold one configuration token per workspace. If you already use one for your own Slack apps, ask another Owner to do this step, or Chickpea and your tools will keep replacing each other's token.</p>
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

function removedPage(_agent: CustomAgentConfig): string {
  return renderSlackJourneyPage({
    surface: 'agent-slack-app',
    eyebrow: 'Chickpea',
    title: 'Let Chickpea create Slack apps for your Agents',
    body: `<p>Chickpea deleted its copy of your configuration token. To revoke it in Slack too, open Your Apps and choose Delete token under Your App Configuration Tokens.</p>${yourApps}`,
  });
}
