/**
 * The paths a host forwards into Core for an Agent's own Slack app. Each is
 * served only with the matching handoff and an installed port, and answers
 * 404 otherwise, so nothing here exists on a deployment without the feature.
 */
import { type Context, Hono } from 'hono';

import { type PlatformEnv, resolveStores } from '../../config/state-backend.ts';
import {
  type AgentSlackAppHandoff,
  agentSlackAppHandoffOf,
  agentSlackAppsHost,
  type AgentSlackAppsHost,
} from './host.ts';
import { liveAgentSlackApps } from './live.ts';
import type { AgentSlackApps } from './service.ts';

const AGENT_APPS_PATH = '/channels/slack/agent-apps';

type AgentSlackAppDelivery = Extract<AgentSlackAppHandoff, { kind: 'delivery' }>;

export interface AgentSlackAppRoutesDeps {
  /** Serves one verified delivery as the Agent's bot; injected, so this module never imports the channel. */
  serveDelivery?: (c: Context, handoff: AgentSlackAppDelivery) => Promise<Response>;
  /** Test seam: the service for an env; live stores and the main bot otherwise. */
  service?: (env: PlatformEnv, host: AgentSlackAppsHost) => Promise<AgentSlackApps>;
  /** Test seam: records an Owner's press as an audit event; the installation's identity store otherwise. */
  audit?: (env: PlatformEnv, slackUserId: string, outcome: string) => Promise<void>;
}

export function createAgentSlackAppRoutes(deps: AgentSlackAppRoutesDeps = {}): Hono {
  const app = new Hono();
  const service = deps.service ?? liveAgentSlackApps;
  const audit = deps.audit ?? auditPress;

  const deliver = async (c: Context): Promise<Response> => {
    const env = c.env as PlatformEnv | undefined;
    const handoff = agentSlackAppHandoffOf(env);
    if (!env || !agentSlackAppsHost() || handoff?.kind !== 'delivery' || !deps.serveDelivery) return c.notFound();
    return deps.serveDelivery(c, handoff);
  };
  app.post(`${AGENT_APPS_PATH}/events`, deliver);
  app.post(`${AGENT_APPS_PATH}/interactions`, deliver);

  app.get(`${AGENT_APPS_PATH}/allow/:agentId`, async (c) => {
    const env = c.env as PlatformEnv | undefined;
    const host = agentSlackAppsHost();
    const handoff = agentSlackAppHandoffOf(env);
    if (!env || !host || handoff?.kind !== 'owner') return c.notFound();
    return (await service(env, host)).allow(c.req.param('agentId'), handoff.slackUserId);
  });

  // The hand-off from Chickpea's messages in Slack. GET only reads, so a link preview or a prefetch creates nothing;
  // its page makes the press by POSTing to the same address. Anyone the host forwards without an Owner sees who can.
  app.get(`${AGENT_APPS_PATH}/add/:agentId`, async (c) => {
    const env = c.env as PlatformEnv | undefined;
    const host = agentSlackAppsHost();
    if (!env || !host) return c.notFound();
    const handoff = agentSlackAppHandoffOf(env);
    if (handoff?.kind !== 'owner') return (await import('./journey.ts')).ownerNeededPage();
    return (await service(env, host)).addPage(c.req.param('agentId'));
  });

  app.post(`${AGENT_APPS_PATH}/add/:agentId`, async (c) => {
    const env = c.env as PlatformEnv | undefined;
    const host = agentSlackAppsHost();
    if (!env || !host) return c.notFound();
    const handoff = agentSlackAppHandoffOf(env);
    if (handoff?.kind !== 'owner') return (await import('./journey.ts')).ownerNeededPage();
    const apps = await service(env, host);
    const agentId = c.req.param('agentId');
    // The page posts to itself. A press from another site presses nothing: it gets the page, where only Continue does.
    if (crossSite(c)) return apps.addPage(agentId, { pressOnOpen: false });
    try {
      const { response, pressed } = await apps.addPress(agentId, handoff.slackUserId);
      if (pressed && pressed !== 'not_eligible') await audit(env, handoff.slackUserId, pressed);
      return response;
    } catch (error) {
      // What was done is recorded, so the page's Try again picks it up where it stopped.
      console.error(JSON.stringify({
        component: 'agent_apps', event: 'add_press_failed', agentId, error: error instanceof Error ? error.name : 'unknown',
      }));
      return apps.addPressFailedPage(agentId);
    }
  });

  app.get(`${AGENT_APPS_PATH}/callback`, async (c) => {
    const env = c.env as PlatformEnv | undefined;
    const host = agentSlackAppsHost();
    const handoff = agentSlackAppHandoffOf(env);
    if (!env || !host || handoff?.kind !== 'owner') return c.notFound();
    return (await service(env, host)).completeConsent(new URL(c.req.url).searchParams, handoff.slackUserId);
  });

  return app;
}

/** Only a browser says where a request came from; a request without the header is not refused on its account. */
function crossSite(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

/** The same change as Admin's Start, through another door, recorded the same way; a failed record never fails the press. */
async function auditPress(env: PlatformEnv, slackUserId: string, outcome: string): Promise<void> {
  try {
    const { config, identity } = resolveStores(env);
    const workspace = (await config.listWorkspaceInstallations())[0];
    const teamId = workspace?.teamId ?? workspace?.workspaceId;
    const who = teamId ? await identity.resolveSlackIdentity(teamId, slackUserId) : undefined;
    await identity.recordAuthAudit({
      event: 'authorization', outcome: 'success', action: 'agent_apps.started', reasonCode: outcome,
      correlationId: crypto.randomUUID(), authenticatorKind: 'agent_app_owner_handoff',
      userId: who?.user.id ?? null, membershipId: who?.membership.id ?? null,
    });
  } catch {
    console.warn(JSON.stringify({ component: 'agent_apps', event: 'audit_unavailable', action: 'agent_apps.started' }));
  }
}
