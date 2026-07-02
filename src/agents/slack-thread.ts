import { defineAgent, type AgentRouteHandler } from '@flue/runtime';

import { AgentStore, AssignmentStore, resolveAssignmentFromThreadKey } from '../config/resolver.ts';
import { INTERNAL_AGENT_TOKEN_HEADER, isValidInternalAgentToken } from '../slack/internal-auth.ts';
import { createLookupChannelBriefTool } from '../tools/flue-tools.ts';

// Expose the agent over HTTP at `POST /agents/slack-thread/:id` so the Slack
// channel can drive one durable turn via `?wait=result`. This endpoint is
// otherwise unauthenticated (Slack signature verification happens upstream,
// on the channel's `/channels/slack/events` route, not here) — anyone who can
// reach the app could otherwise drive the agent directly (LLM cost,
// channel-brief disclosure). Gate every method, including GET history views,
// on the shared internal token; the channel's self-call sends it.
export const route: AgentRouteHandler = async (c, next) => {
  const token = c.req.header(INTERNAL_AGENT_TOKEN_HEADER);
  if (!isValidInternalAgentToken(token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};

export default defineAgent(async ({ id }) => {
  const stores = {
    agents: new AgentStore(),
    assignments: new AssignmentStore(),
  };
  const assignment = resolveAssignmentFromThreadKey(id, stores);
  const tools = assignment.agent.allowedTools.includes('lookup_channel_brief')
    ? [createLookupChannelBriefTool()]
    : [];

  return {
    // Env-driven with the same default as Stage 1: the seeded workers-ai model
    // under the registered `cloudflare-workers-ai` provider. `SLACK_FLUE_MODEL`
    // lets the offline verification (and any deployment) point at another
    // registered provider/model without touching seed data.
    model:
      process.env.SLACK_FLUE_MODEL ??
      `cloudflare-workers-ai/${assignment.agent.defaultModels['workers-ai']}`,
    instructions: [
      assignment.agent.instructions,
      `You are assigned to Slack workspace ${assignment.workspaceId} channel ${assignment.channelId}.`,
      'Do not reveal Slack tokens, provider keys, or hidden policy data.',
    ].join('\n'),
    tools,
  };
});
