import {
  bash,
  defineAgent,
  type AgentRouteHandler,
  type SandboxFactory,
} from '@flue/runtime';
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
import {
  getCachedInstallationToken,
  getGithubConnection,
  githubErrorStatus,
  type GithubConnection,
} from '../config/github-app.ts';
import { resolveProfileMcpTools } from '../config/profile-mcp.ts';
import { resolveProfileSkills } from '../config/profile-skills.ts';
import { applyResolvedProviderKeys } from '../config/provider-keys.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import { surfaceForChannelId } from '../config/resolver.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { getOrCreateSnapshot } from '../config/snapshot-store.ts';
import {
  getAgentSnapshotStore,
  getConfigStore,
  getSettingsStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ApiConnectionConfig, RepositoryGrant, SkillConfig } from '../config/types.ts';
import {
  isDeniedRepositoryEndpoint,
  matchesGrantedCodeSearch,
  REPOSITORY_METHODS,
  REPOSITORY_PERMISSIONS,
  validEnabledRepositoryGrants,
} from '../sandbox/egress-handler.ts';
import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  SandboxLifecycleRegistry,
  serializeSandboxActivation,
  type DestroyableSandbox,
} from '../sandbox/lifecycle.ts';
import {
  applySandboxSessionCap,
  selectSandbox,
  type SandboxSelection,
} from '../sandbox/select.ts';
import { reserveMonthlySandboxSession } from '../sandbox/session-cap.ts';
import {
  activeSlackArtifactThreadTs,
  activeSandboxTurnId,
  clearActiveSandboxTurn,
  SANDBOX_TURN_ID_HEADER,
  setActiveSandboxTurn,
  SLACK_ARTIFACT_THREAD_TS_HEADER,
} from '../sandbox/turn-context.ts';
import { createWorkspaceArtifactCapability } from '../sandbox/artifact-tool.ts';
import {
  WORKSPACE_SESSION_CAP_DECLINE,
  workspaceSkillForSandbox,
} from '../sandbox/workspace-skill.ts';
import { INTERNAL_AGENT_TOKEN_HEADER, isValidInternalAgentToken } from '../slack/internal-auth.ts';
import { parseSlackThreadKey } from '../slack/thread-key.ts';
import { getClient } from '../slack/run-turn.ts';
import { WebClientPresenter } from '../slack/web-client-presenter.ts';

export { resolveAgentModel } from '../config/model-policy.ts';

const cloudflareSandboxLifecycle = new SandboxLifecycleRegistry<DestroyableSandbox>();

export function suppressProfileNamedConnectorSkills(
  connectorSkills: readonly SkillConfig[],
  profileSkills: readonly SkillConfig[],
): SkillConfig[] {
  const profileSkillNames = new Set(profileSkills.map((skill) => skill.name));
  // Any profile row owns its name even when disabled: a disabled row is the
  // operator's off-switch for an otherwise auto-attached connector skill.
  return connectorSkills.filter((skill) => !profileSkillNames.has(skill.name));
}

const REPOSITORY_HOSTS = ['api.github.com', 'github.com'];

export interface ResolvedRepositoryAccess {
  grants: RepositoryGrant[];
  connectors: ResolvedApiConnection[];
  /**
   * True whenever the profile has enabled grants, even if no credential
   * resolved this turn. Grants make repository routing authoritative for the
   * GitHub hosts: a mint failure must degrade to NO GitHub access, never fall
   * open to a legacy broad connector.
   */
  governsGithubHosts: boolean;
}

/**
 * Resolve repository credentials live for one turn. Grants are policy and may
 * come from a frozen channel snapshot; tokens never join that snapshot or the
 * skill input and exist only in credential-bearing egress connector rows.
 * Accepts undefined because snapshots persisted before repository grants
 * existed rehydrate without the field.
 */
export async function resolveRepositoryAccess(
  repositories: readonly RepositoryGrant[] | undefined,
  env?: PlatformEnv,
): Promise<ResolvedRepositoryAccess> {
  const configured = (repositories ?? []).filter((grant) => grant.enabled);
  // Defense in depth against rows persisted before (or around) schema
  // validation: a malformed name would become an egress URL prefix, where a
  // dot segment normalizes into a broader match than the grant. Dropped
  // grants still count as configured — they must fail closed, not fall open
  // to a legacy connector.
  const enabled = validEnabledRepositoryGrants(configured);
  const none = (governs: boolean): ResolvedRepositoryAccess => ({
    grants: [],
    connectors: [],
    governsGithubHosts: governs,
  });
  if (configured.length === 0) return none(false);
  if (enabled.length === 0) return none(true);

  let connection: GithubConnection;
  try {
    connection = await getGithubConnection(getSettingsStore(env));
  } catch {
    console.warn('[chickpea] GitHub repository access skipped for this turn');
    return none(true);
  }

  if (connection.mode === 'none') return none(true);
  if (connection.mode === 'pat') {
    // An App-era allRepos grant meant "every repo in that INSTALLATION" — a
    // PAT may reach far more of the account, so honoring it here would widen
    // scope on a credential-mode switch. Explicit repo names keep an
    // identical scope under either credential and stay honored; allRepos
    // needs a PAT-native reselection.
    const patGrants = enabled.filter((grant) => grant.allRepos !== true);
    if (patGrants.length === 0) return none(true);
    return {
      grants: patGrants,
      connectors: repositoryConnectors(connection.pat, patGrants),
      governsGithubHosts: true,
    };
  }

  const byInstallation = new Map<number, RepositoryGrant[]>();
  for (const grant of enabled) {
    if (grant.installationId === null) continue;
    const grouped = byInstallation.get(grant.installationId) ?? [];
    grouped.push(grant);
    byInstallation.set(grant.installationId, grouped);
  }

  const resolved = await Promise.all(
    [...byInstallation].map(async ([installationId, grants]) => {
      const allRepositories = grants.some((grant) => grant.allRepos === true);
      const repositoryNames = allRepositories
        ? undefined
        : [
            ...new Set(
              grants.map((grant) => grant.fullName.slice(grant.fullName.indexOf('/') + 1)),
            ),
          ].sort();
      try {
        const { token } = await getCachedInstallationToken(connection, installationId, {
          ...(repositoryNames ? { repositories: repositoryNames } : {}),
          permissions: REPOSITORY_PERMISSIONS,
        });
        return {
          installationId,
          grants,
          connectors: repositoryConnectors(token, grants),
        };
      } catch (mintError) {
        // Deliberately omit the caught message: a hostile/custom fetch error can
        // echo request headers. The installation id is enough to diagnose which
        // capability degraded without risking JWT or installation-token logs.
        console.warn(
          `[chickpea] GitHub repository installation ${installationId} skipped for this turn`,
        );
        // Salvage only a validation rejection (422 = some listed repository is
        // stale). A timeout, auth failure, rate limit, or 5xx would turn one
        // outage into a per-repo request storm for nothing.
        if (githubErrorStatus(mintError) !== 422) return undefined;
      }
      // GitHub 422s the WHOLE grouped mint when any listed repository was
      // renamed, deleted, or removed from the installation — one stale grant
      // must not disable its healthy siblings. Isolate by minting per repo
      // (each result caches, so this costs one turn, not every turn). Bounded
      // so an oversized grant list cannot fan out into an API storm.
      if (allRepositories || grants.length < 2 || grants.length > 25) return undefined;
      const salvaged = await Promise.all(
        grants.map(async (grant) => {
          try {
            const { token } = await getCachedInstallationToken(connection, installationId, {
              repositories: [grant.fullName.slice(grant.fullName.indexOf('/') + 1)],
              permissions: REPOSITORY_PERMISSIONS,
            });
            return { grant, connectors: repositoryConnectors(token, [grant]) };
          } catch {
            console.warn(
              `[chickpea] GitHub repository grant ${grant.fullName} skipped for this turn`,
            );
            return undefined;
          }
        }),
      );
      const kept = salvaged.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      );
      if (kept.length === 0) return undefined;
      return {
        installationId,
        grants: kept.map((entry) => entry.grant),
        connectors: kept.flatMap((entry) => entry.connectors),
      };
    }),
  );
  const grantedIds = new Set(
    resolved.flatMap((entry) => (entry ? entry.grants.map((grant) => grant.id) : [])),
  );
  return {
    grants: enabled.filter((grant) => grantedIds.has(grant.id)),
    connectors: resolved.flatMap((entry) => entry?.connectors ?? []),
    governsGithubHosts: true,
  };
}

function repositoryConnectors(
  token: string,
  grants: readonly RepositoryGrant[],
): ResolvedApiConnection[] {
  const apiPrefixes = repositoryPrefixes(grants, '/repos/');
  const gitPrefixes = [
    ...new Set(
      grants.flatMap((grant) =>
        grant.allRepos === true
          ? [`/${grant.accountLogin}`]
          : grant.fullName
            ? [`/${grant.fullName}`, `/${grant.fullName}.git`]
            : [],
      ),
    ),
  ].sort();
  const credential = {
    headerName: 'Authorization',
    headerValue: `Bearer ${token}`,
    allowedMethods: [...REPOSITORY_METHODS],
  };
  return [
    {
      allowedHosts: ['api.github.com'],
      pathPrefixes: apiPrefixes,
      ...credential,
      matchesRequest: (url: string) => !isDeniedRepositoryEndpoint(url),
    },
    {
      allowedHosts: ['github.com'],
      pathPrefixes: gitPrefixes,
      ...credential,
    },
    {
      allowedHosts: ['api.github.com'],
      pathPrefixes: ['/search/code'],
      ...credential,
      matchesRequest: (url: string) => matchesGrantedCodeSearch(url, grants),
    },
  ].filter((connector) => connector.pathPrefixes.length > 0);
}

function repositoryPrefixes(grants: readonly RepositoryGrant[], prefix: string): string[] {
  return [
    ...new Set(
      grants.flatMap((grant) => {
        const repository = grant.allRepos === true ? grant.accountLogin : grant.fullName;
        return repository ? [`${prefix}${repository}`] : [];
      }),
    ),
  ].sort();
}

/**
 * Repository credentials are authoritative for GitHub while repository grants
 * are active. Remove those hosts from generic API connections so a narrower
 * legacy prefix cannot override the down-scoped installation-token route.
 * Stripping keys off CONFIGURED grants (`governsGithubHosts`), not resolved
 * connectors: a failed token mint must not fall open to a legacy broad
 * GitHub connection.
 */
export function mergeRepositoryAndApiConnectors(
  repositoryConnectors: readonly ResolvedApiConnection[],
  apiConnectors: readonly ResolvedApiConnection[],
  governsGithubHosts = repositoryConnectors.length > 0,
): ResolvedApiConnection[] {
  if (!governsGithubHosts) return [...apiConnectors];
  const repositoryHosts = new Set(REPOSITORY_HOSTS);
  const remainingApiConnectors = apiConnectors.flatMap((connector) => {
    const allowedHosts = connector.allowedHosts.filter(
      (host) => !repositoryHosts.has(host.toLowerCase()),
    );
    return allowedHosts.length > 0 ? [{ ...connector, allowedHosts }] : [];
  });
  return [...repositoryConnectors, ...remainingApiConnectors];
}

async function resolveApiConnectionsForTurn(
  agentId: string,
  connections: readonly ApiConnectionConfig[],
  env?: PlatformEnv,
): Promise<ResolvedApiConnection[]> {
  const resolved = await Promise.all(
    connections
      .filter((connection) => connection.enabled)
      .map(async (connection): Promise<ResolvedApiConnection | undefined> => {
        const credential = await resolveConnectorCredential(
          { agentId, connectionId: connection.id },
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
  );
  return resolved.filter(
    (connection): connection is ResolvedApiConnection => connection !== undefined,
  );
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
  const threadId = c.req.param('id');
  const turnId = c.req.header(SANDBOX_TURN_ID_HEADER);
  const artifactThreadTs = c.req.header(SLACK_ARTIFACT_THREAD_TS_HEADER);
  if (threadId && turnId) {
    setActiveSandboxTurn(threadId, turnId, artifactThreadTs);
  }
  try {
    return await next();
  } finally {
    if (threadId && turnId) {
      clearActiveSandboxTurn(threadId, turnId);
    }
    if (threadId && c.req.method === 'POST' && isCloudflareTarget()) {
      await cloudflareSandboxLifecycle.destroy(threadId);
    }
  }
};

export default defineAgent(async ({ id }) => {
  const env = await resolveAgentPlatformEnv();
  await applyResolvedProviderKeys(env);
  const store = getConfigStore(env);
  const settingsStore = getSettingsStore(env);
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

  // API connection policy inherits the agent snapshot contract, while its
  // credential resolves live every turn. Missing credentials degrade by
  // skipping that connection rather than aborting the turn.
  const [egressPolicy, repositoryAccess, resolvedApiConnectors, sandboxSettings] =
    await Promise.all([
      resolveEgressPolicy(env),
      resolveRepositoryAccess(config.agent.repositories, env),
      resolveApiConnectionsForTurn(config.agent.id, config.agent.apiConnections ?? [], env),
      resolveSandboxSettings(settingsStore),
    ]);
  const requestedSandboxSelection = selectSandbox({
    target: isCloudflareTarget() ? 'cloudflare' : 'node',
    enabled: sandboxSettings.enabled,
    localEnabled: sandboxSettings.localEnabled,
    repositoryGrants: repositoryAccess.grants,
  });
  const turnId = activeSandboxTurnId(id) ?? id;
  const artifactThreadTs = activeSlackArtifactThreadTs(id);
  const sessionReservation =
    requestedSandboxSelection === 'cloudflare'
      ? await reserveMonthlySandboxSession({
          store: settingsStore,
          cap: sandboxSettings.monthlySessionCap,
          reservationId: turnId,
        })
      : undefined;
  const sandboxSelection = applySandboxSessionCap(
    requestedSandboxSelection,
    sessionReservation?.allowed,
  );
  const workspaceSkill = workspaceSkillForSandbox(
    requestedSandboxSelection,
    sessionReservation?.allowed === false ? WORKSPACE_SESSION_CAP_DECLINE : undefined,
  );

  // Repository credentials take precedence over legacy/custom GitHub
  // connections. Down-scoped installation tokens are authoritative whenever
  // grants are active, including for narrower legacy path prefixes.
  const resolvedConnectors = mergeRepositoryAndApiConnectors(
    repositoryAccess.connectors,
    resolvedApiConnectors,
    repositoryAccess.governsGithubHosts,
  );
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
      repositoryAccess.grants,
    ),
    config.agent.skills,
  );
  // The install/runtime-derived workspace judge comes last so a stored
  // same-named profile row cannot hide a live security or cap signal.
  const skills = resolveProfileSkills([
    ...connectorSkills,
    ...config.agent.skills,
    ...(workspaceSkill ? [workspaceSkill] : []),
  ]);

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
  let virtualSandbox: SandboxFactory;
  const baseDelegate = secureFetchOf(baseNetwork);
  const scopeDelegates = scopes.map((scope) => ({
    prefixes: scope.prefixes,
    methods: scope.methods,
    delegate: secureFetchOf(scope.network),
    ...(scope.matchesRequest ? { matchesRequest: scope.matchesRequest } : {}),
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
    virtualSandbox = bash(() => new Bash({ fs: new InMemoryFs(), fetch: scopedFetch }));
  } else {
    // just-bash stopped exposing secureFetch; fall back to the supported network
    // path at the fail-closed baseline (connector write methods not granted).
    virtualSandbox = bash(() => new Bash({ fs: new InMemoryFs(), network: fallbackNetwork }));
  }
  let sandbox = await resolveAgentSandbox({
    selection: sandboxSelection,
    fallback: virtualSandbox,
    env,
    id,
    turnId,
    grants: repositoryAccess.grants,
  });
  let tools = mcpTools;
  if (sandboxSelection !== 'bash' && artifactThreadTs) {
    let presenter: Promise<WebClientPresenter> | undefined;
    const artifactCapability = createWorkspaceArtifactCapability({
      sandbox,
      selection: sandboxSelection,
      channel: channelId,
      threadTs: artifactThreadTs,
      postArtifact: async (input) => {
        presenter ??= getClient(env).then(
          (client) =>
            new WebClientPresenter(client, {
              channelId,
              threadTs: artifactThreadTs,
              agentName: config.agent.name,
              agentId: config.agent.id,
              workspaceId,
            }),
        );
        return (await presenter).postArtifact(input);
      },
    });
    sandbox = artifactCapability.sandbox;
    tools = [...mcpTools, artifactCapability.tool];
  }

  return {
    model: config.model,
    instructions: config.instructions,
    tools,
    sandbox,
    ...(skills.length > 0 ? { skills } : {}),
  };
});

interface AgentSandboxOptions {
  selection: SandboxSelection;
  fallback: SandboxFactory;
  env: PlatformEnv | undefined;
  id: string;
  turnId: string;
  grants: readonly RepositoryGrant[];
}

async function resolveAgentSandbox(options: AgentSandboxOptions): Promise<SandboxFactory> {
  if (options.selection === 'bash') return options.fallback;

  if (options.selection === 'local') {
    const [{ local }, { mkdir }, { resolve }] = await Promise.all([
      import('@flue/runtime/node'),
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const cwd = resolve(
      process.cwd(),
      'tmp',
      'sandbox-workspaces',
      encodeURIComponent(options.id),
    );
    await mkdir(cwd, { recursive: true });
    return local({ cwd });
  }

  // Both Workers-only modules stay below the runtime target gate. getSandbox
  // mints a lazy DO stub; configureEgress persists policy without booting the
  // container, whose first exec remains the creation boundary.
  if (!isCloudflareTarget()) return options.fallback;
  const [{ cloudflareSandbox }, { getSandbox }] = await Promise.all([
    import('@flue/runtime/cloudflare'),
    import('@cloudflare/sandbox'),
  ]);
  const binding = options.env?.SANDBOX ?? options.env?.Sandbox;
  if (!binding) {
    throw new Error('SANDBOX Durable Object binding is unavailable');
  }
  const sandbox = await cloudflareSandboxLifecycle.create(options.id, async () => {
    const candidate = getSandbox(
      binding as Parameters<typeof getSandbox>[0],
      options.id,
      CLOUDFLARE_SANDBOX_OPTIONS,
    );
    try {
      await (
        candidate as typeof candidate & {
          configureEgress(
            grants: readonly RepositoryGrant[],
            turnId: string,
          ): Promise<void>;
        }
      ).configureEgress(validEnabledRepositoryGrants(options.grants), options.turnId);
      return candidate;
    } catch (err) {
      await candidate.destroy().catch(() => undefined);
      throw err;
    }
  });
  const serialized = serializeSandboxActivation(
    sandbox as unknown as Parameters<typeof cloudflareSandbox>[0],
  );
  return cloudflareSandbox(serialized, { cwd: '/workspace' });
}

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
