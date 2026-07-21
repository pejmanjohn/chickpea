import { bash, defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { Bash, InMemoryFs, type NetworkConfig, type SecureFetch } from 'just-bash';

import { resolveConnectorCredential } from '../config/connector-secrets.ts';
import { connectorSkillsForConnections } from '../config/connector-skills.ts';
import {
  buildEgressPlan,
  createScopedFetch,
  resolveEgressPolicy,
  type ResolvedApiConnection,
  type ScopedDelegate,
} from '../config/egress.ts';
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
import type { SkillConfig } from '../config/types.ts';
import { INTERNAL_AGENT_TOKEN_HEADER, isValidInternalAgentToken } from '../slack/internal-auth.ts';
import { parseSlackThreadKey } from '../slack/thread-key.ts';

export { resolveAgentModel } from '../config/model-policy.ts';

export function suppressProfileNamedConnectorSkills(
  connectorSkills: readonly SkillConfig[],
  profileSkills: readonly SkillConfig[],
): SkillConfig[] {
  const profileSkillNames = new Set(profileSkills.map((skill) => skill.name));
  // Any profile row owns its name even when disabled: a disabled row is the
  // operator's off-switch for an otherwise auto-attached connector skill.
  return connectorSkills.filter((skill) => !profileSkillNames.has(skill.name));
}

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

  const egressPolicy = await resolveEgressPolicy(env);
  // API connection policy inherits the agent snapshot contract, while its
  // credential resolves live every turn. Missing credentials degrade by
  // skipping that connection rather than aborting the turn.
  const resolvedConnectors = (
    await Promise.all(
      (config.agent.apiConnections ?? [])
        .filter((connection) => connection.enabled)
        .map(async (connection): Promise<ResolvedApiConnection | undefined> => {
          const credential = await resolveConnectorCredential(
            { agentId: config.agent.id, connectionId: connection.id },
            env,
          );
          if (!credential) return undefined;

          return {
            allowedHosts: connection.allowedHosts,
            pathPrefixes: connection.pathPrefixes,
            headerName: connection.headerName,
            headerValue: (connection.headerValuePrefix ?? '') + credential,
            allowedMethods: connection.allowedMethods,
          };
        }),
    )
  ).filter((connection): connection is ResolvedApiConnection => connection !== undefined);
  // Project resolved connectors into credential-free scope before skill
  // construction. Connector skills come first so the existing last-writer-wins
  // dedupe lets a profile-authored skill deliberately override the built-in.
  const connectorSkills = suppressProfileNamedConnectorSkills(
    connectorSkillsForConnections(
      resolvedConnectors.map(({ allowedHosts, pathPrefixes, allowedMethods }) => ({
        allowedHosts,
        pathPrefixes,
        allowedMethods,
      })),
    ),
    config.agent.skills,
  );
  // Skills ride inside the resolved agent — frozen in the snapshot for channel
  // threads, live-resolved for DMs — so they inherit the same freeze contract
  // as instructions. resolveProfileSkills dedupes names and skips invalid rows.
  const skills = resolveProfileSkills([...connectorSkills, ...config.agent.skills]);

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

  const { scopes, baseNetwork, baseMethods, fallbackNetwork } = buildEgressPlan(
    egressPolicy,
    { cloudflare: isCloudflareTarget() },
    resolvedConnectors,
  );
  const secureFetchOf = (network: NetworkConfig): SecureFetch | undefined =>
    (
      new Bash({ fs: new InMemoryFs(), network }) as unknown as {
        secureFetch?: SecureFetch;
      }
    ).secureFetch;
  let sandbox;
  const baseDelegate = secureFetchOf(baseNetwork);
  const scopeDelegates = scopes.map((scope) => ({
    prefixes: scope.prefixes,
    methods: scope.methods,
    delegate: secureFetchOf(scope.network),
  }));
  if (
    typeof baseDelegate === 'function' &&
    scopeDelegates.every((scope) => typeof scope.delegate === 'function')
  ) {
    // Each connector rides its own secure-fetch scoped to just its hosts and
    // methods, so a redirect off a connector host cannot carry an elevated
    // method to any other allow-listed host.
    const scopedFetch = createScopedFetch({
      scopes: scopeDelegates as ScopedDelegate[],
      baseDelegate,
      baseMethods,
    });
    sandbox = bash(() => new Bash({ fs: new InMemoryFs(), fetch: scopedFetch }));
  } else {
    // just-bash stopped exposing secureFetch; fall back to the supported network
    // path at the fail-closed baseline (connector write methods not granted).
    sandbox = bash(() => new Bash({ fs: new InMemoryFs(), network: fallbackNetwork }));
  }

  return {
    model: config.model,
    instructions: config.instructions,
    tools: mcpTools,
    sandbox,
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
