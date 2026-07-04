import { defineAgent, type AgentRouteHandler } from '@flue/runtime';

import { resolveAgentModel } from '../config/model-policy.ts';
import { resolveAssignmentFromThreadKey } from '../config/resolver.ts';
import { getConfigStore } from '../config/store.ts';
import { INTERNAL_AGENT_TOKEN_HEADER, isValidInternalAgentToken } from '../slack/internal-auth.ts';
import { createLookupChannelBriefTool } from '../tools/flue-tools.ts';

export { resolveAgentModel } from '../config/model-policy.ts';

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
  const store = getConfigStore();
  const stores = { agents: store, assignments: store };
  const assignment = resolveAssignmentFromThreadKey(id, stores);
  const tools = assignment.agent.allowedTools.includes('lookup_channel_brief')
    ? [createLookupChannelBriefTool(assignment)]
    : [];

  return {
    model: resolveAgentModel(assignment.agent),
    instructions: [
      assignment.agent.instructions,
      ...(assignment.channelPromptAddendum ? [assignment.channelPromptAddendum] : []),
      `You are assigned to Slack workspace ${assignment.workspaceId} channel ${assignment.channelId}.`,
      'Do not reveal Slack tokens, provider keys, or hidden policy data.',
    ].join('\n'),
    tools,
  };
});
