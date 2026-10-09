/**
 * The paths a host forwards into Core for an Agent's own Slack app. Each is
 * served only with the matching handoff and an installed port, and answers
 * 404 otherwise, so nothing here exists on a deployment without the feature.
 */
import { Hono } from 'hono';

import type { PlatformEnv } from '../../config/state-backend.ts';
import { agentSlackAppHandoffOf, agentSlackAppsHost, type AgentSlackAppsHost } from './host.ts';
import { liveAgentSlackApps } from './live.ts';
import type { AgentSlackApps } from './service.ts';

export const AGENT_APPS_PATH = '/channels/slack/agent-apps';

export interface AgentSlackAppRoutesDeps {
  /** Test seam: the service for an env; live stores and the main bot otherwise. */
  service?: (env: PlatformEnv, host: AgentSlackAppsHost) => Promise<AgentSlackApps>;
}

export function createAgentSlackAppRoutes(deps: AgentSlackAppRoutesDeps = {}): Hono {
  const app = new Hono();
  const service = deps.service ?? liveAgentSlackApps;

  app.get(`${AGENT_APPS_PATH}/allow/:agentId`, async (c) => {
    const env = c.env as PlatformEnv | undefined;
    const host = agentSlackAppsHost();
    const handoff = agentSlackAppHandoffOf(env);
    if (!env || !host || handoff?.kind !== 'owner') return c.notFound();
    return (await service(env, host)).allow(c.req.param('agentId'), handoff.slackUserId);
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
