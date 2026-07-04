import { defineAgent, type AgentRouteHandler } from '@flue/runtime';

import { resolveEffectiveSlackConfig } from '../config/effective-config.ts';
import { resolveAgentModel } from '../config/model-policy.ts';
import { surfaceForChannelId } from '../config/resolver.ts';
import { getAgentSnapshotStore } from '../config/snapshot-store.ts';
import { getConfigStore } from '../config/store.ts';
import { INTERNAL_AGENT_TOKEN_HEADER, isValidInternalAgentToken } from '../slack/internal-auth.ts';
import { parseSlackThreadKey } from '../slack/thread-key.ts';
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
  const { workspaceId, channelId } = parseSlackThreadKey(id);
  const resolve = () => resolveEffectiveSlackConfig(workspaceId, channelId, stores);

  // Channel threads are frozen (the channel handler wrote the snapshot at the
  // first turn; getOrCreate serves that row). Direct conversations (DMs, App
  // Home) are one continuous session, not a discrete thread, so they resolve the
  // current config every turn instead of freezing — admin edits to the DM
  // profile reach existing DM users.
  const config =
    surfaceForChannelId(channelId) === 'direct'
      ? resolve()
      : getAgentSnapshotStore().getOrCreate(id, resolve);

  const tools = config.allowedTools.includes('lookup_channel_brief')
    ? [createLookupChannelBriefTool(config)]
    : [];

  return {
    model: config.model,
    instructions: config.instructions,
    tools,
  };
});
