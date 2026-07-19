import { defineAgent, type AgentRouteHandler } from '@flue/runtime';

import { resolveEffectiveSlackConfig } from '../config/effective-config.ts';
import { resolveProfileMcpTools } from '../config/profile-mcp.ts';
import { resolveProfileSkills } from '../config/profile-skills.ts';
import { applyResolvedProviderKeys } from '../config/provider-keys.ts';
import { surfaceForChannelId } from '../config/resolver.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { getOrCreateSnapshot } from '../config/snapshot-store.ts';
import {
  getAgentSnapshotStore,
  getConfigStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { INTERNAL_AGENT_TOKEN_HEADER, isValidInternalAgentToken } from '../slack/internal-auth.ts';
import { parseSlackThreadKey } from '../slack/thread-key.ts';

export { resolveAgentModel } from '../config/model-policy.ts';

// Expose the agent over HTTP at `POST /agents/slack-thread/:id` so the Slack
// channel can drive one durable turn via `?wait=result`. This endpoint is
// otherwise unauthenticated (Slack signature verification happens upstream,
// on the channel's `/channels/slack/events` route, not here) — anyone who can
// reach the app could otherwise drive the agent directly (LLM cost,
// channel-brief disclosure). Gate every method, including GET history views,
// on the shared internal token; the channel's in-process dispatch sends it.
export const route: AgentRouteHandler = async (c, next) => {
  const token = c.req.header(INTERNAL_AGENT_TOKEN_HEADER);
  if (!isValidInternalAgentToken(token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};

export default defineAgent(async ({ id }) => {
  const env = await resolveAgentPlatformEnv();
  await applyResolvedProviderKeys(env);
  const store = getConfigStore(env);
  const stores = { agents: store, assignments: store };
  const { workspaceId, channelId } = parseSlackThreadKey(id);
  const resolve = () => resolveEffectiveSlackConfig(workspaceId, channelId, stores);

  // Channel threads are frozen (the channel handler wrote the snapshot at the
  // first turn; getOrCreateSnapshot serves that row). Direct conversations
  // (DMs, App Home) are one continuous session, not a discrete thread, so they
  // resolve the current config every turn instead of freezing — admin edits to
  // the DM profile reach existing DM users.
  const config =
    surfaceForChannelId(channelId) === 'direct'
      ? await resolve()
      : await getOrCreateSnapshot(getAgentSnapshotStore(env), id, resolve);

  // Skills ride inside the resolved agent — frozen in the snapshot for channel
  // threads, live-resolved for DMs — so they inherit the same freeze contract
  // as instructions. resolveProfileSkills dedupes names and skips invalid rows.
  const skills = resolveProfileSkills(config.agent.skills);

  // MCP connection tools join at the same seam and inherit the same freeze
  // contract (mcpServers frozen in the snapshot for channels, live for DMs;
  // secrets always resolve live). The resolver degrades gracefully — a dead or
  // slow server is skipped, never aborting the turn — and drops any tool whose
  // name collides with a built-in or skill (a duplicate name kills the turn).
  const mcpTools = await resolveProfileMcpTools(config.agent.mcpServers, {
    agentId: config.agent.id,
    env,
    existingToolNames: skills.map((s) => s.name),
  });

  return {
    model: config.model,
    instructions: config.instructions,
    tools: mcpTools,
    ...(skills.length > 0 ? { skills } : {}),
  };
});

/**
 * The platform env the store factories need on Cloudflare (the TAG_STATE
 * binding). This module executes inside the Flue-generated agent Durable
 * Object there, where the bindings come from the runtime's ALS-scoped
 * Cloudflare context — populated ONLY inside DO handlers, which is exactly
 * where defineAgent's factory runs. Imported dynamically and only on the CF
 * target: '@flue/runtime/cloudflare' has no business in the node lane's
 * runtime graph, and on node the factories ignore the env anyway.
 */
async function resolveAgentPlatformEnv(): Promise<PlatformEnv | undefined> {
  if (!isCloudflareTarget()) {
    return undefined;
  }
  const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
  return getCloudflareContext().env as PlatformEnv;
}
