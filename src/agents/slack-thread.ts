'use agent';

import {
  bash,
  type AgentProps,
  type AgentRuntimeConfig,
  type SandboxFactory,
  useInitialData,
  useInstruction,
  useMcpConnection,
  useModel,
  useSandbox,
  useSkill,
  useTool,
} from '@flue/runtime';
import { Bash, InMemoryFs, type NetworkConfig, type SecureFetch } from 'just-bash';
import * as v from 'valibot';

import {
  connectingActivityStatus,
  registerActivityContext,
  type ApiConnectionActivity,
} from '../activity/status.ts';
import {
  ApiOAuthError,
  resolveApiOAuthAccessToken,
  type ApiOAuthProvider,
  type ApiOAuthRef,
} from '../config/api-oauth.ts';
import {
  googleWorkspaceServicePolicies,
  isValidApiOAuthConnectionPolicy,
} from '../config/api-oauth-policy.ts';
import { resolveConnectorCredential } from '../config/connector-secrets.ts';
import { connectorSkillsForConnections } from '../config/connector-skills.ts';
import {
  buildEgressPlan,
  createScopedFetch,
  resolveEgressPolicy,
  type ResolvedApiConnection,
  type ScopedDelegate,
} from '../config/egress.ts';
import {
  resolveEffectiveSlackConfig,
  type EffectiveSlackConfig,
} from '../config/effective-config.ts';
import {
  getCachedInstallationToken,
  getGithubConnection,
  githubErrorStatus,
  isGithubAppManagedHost,
  type GithubConnection,
} from '../config/github-app.ts';
import {
  isProfileMcpServerEligible,
  resolveRuntimePlanMcpConnections,
  resolveProfileMcpTools,
} from '../config/profile-mcp.ts';
import { resolveProfileSkills } from '../config/profile-skills.ts';
import {
  resolveRuntimeModel,
  type ResolvedRuntimeModel,
} from '../config/runtime-model.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import { SEED_CLOUDFLARE_MODEL_PIN } from '../config/seed.ts';
import { surfaceForChannelId } from '../config/resolver.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { getOrCreateSnapshot } from '../config/snapshot-store.ts';
import {
  getAgentSnapshotStore,
  getConfigStore,
  getSettingsStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type {
  ApiConnectionConfig,
  CustomAgentConfig,
  RepositoryGrant,
  SkillConfig,
} from '../config/types.ts';
import {
  isDeniedRepositoryEndpoint,
  matchesGrantedCodeSearch,
  REPOSITORY_METHODS,
  REPOSITORY_PERMISSIONS,
  validEnabledRepositoryGrants,
} from '../sandbox/egress-handler.ts';
import { githubAuthorizationHeader } from '../sandbox/github-auth.ts';

import type {
  SandboxCredentialMode,
  SandboxEgressPolicyInput,
} from '../sandbox/cloudflare-policy.ts';
import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  SandboxLifecycleRegistry,
  serializeSandboxActivation,
  type DestroyableSandbox,
} from '../sandbox/lifecycle.ts';
import { SandboxSessionCapError } from '../sandbox/errors.ts';
import { selectSandbox, type SandboxSelection } from '../sandbox/select.ts';
import { reserveMonthlySandboxSession } from '../sandbox/session-cap.ts';
import { sandboxThreadKey } from '../sandbox/thread-key.ts';
import {
  requireSandboxTurnId,
  type SandboxTurnContext,
} from '../sandbox/turn-context.ts';
import { createWorkspaceArtifactCapability } from '../sandbox/artifact-tool.ts';
import { createWorkspaceArtifactTool } from '../sandbox/artifact-tool.ts';
import { workspaceSkillForSandbox } from '../sandbox/workspace-skill.ts';
import { publishActivityStatus } from '../slack/activity-publisher.ts';
import { parseSlackThreadKey } from '../slack/thread-key.ts';
import { getClient } from '../slack/run-turn.ts';
import { WebClientPresenter } from '../slack/web-client-presenter.ts';
import { useChickpeaResponseMetadata } from '../usage/response-metadata.ts';
import { bootstrapRuntimeProviders } from '../runtime-bootstrap.ts';
import {
  parseRuntimePlanV2,
  type RuntimePlanApiConnectionV2,
  type RuntimePlanRepositoryV2,
  type RuntimePlanV2,
} from './runtime-plan.ts';

bootstrapRuntimeProviders();

export { resolveAgentModel } from '../config/model-policy.ts';

interface ConfigurableCloudflareSandbox extends DestroyableSandbox, SandboxTurnContext {
  configureEgress(
    input: SandboxEgressPolicyInput,
    turnId: string,
  ): Promise<void>;
}

const cloudflareSandboxLifecycle =
  new SandboxLifecycleRegistry<ConfigurableCloudflareSandbox>();

export function suppressProfileNamedConnectorSkills(
  connectorSkills: readonly SkillConfig[],
  profileSkills: readonly SkillConfig[],
): SkillConfig[] {
  const profileSkillNames = new Set(profileSkills.map((skill) => skill.name));
  // Any profile row owns its name even when disabled: a disabled row is the
  // operator's off-switch for an otherwise auto-attached connector skill.
  return connectorSkills.filter((skill) => !profileSkillNames.has(skill.name));
}

export interface ResolvedRepositoryAccess {
  grants: RepositoryGrant[];
  connectors: ResolvedApiConnection[];
  credentialMode?: SandboxCredentialMode;
  /**
   * True whenever the profile has enabled grants, even if no credential
   * resolved this turn. Grants make repository routing authoritative for the
   * GitHub hosts: a mint failure must degrade to NO GitHub access, never fall
   * open to a legacy broad connector.
   */
  governsGithubHosts: boolean;
}

export interface ResolvedApiConnectionForTurn {
  connectors: ResolvedApiConnection[];
  displayName: string;
  policy: ApiConnectionConfig;
}

export interface ApiConnectionResolutionDependencies {
  resolveCredential?: typeof resolveConnectorCredential;
  resolveOAuthToken?: (input: {
    ref: ApiOAuthRef;
    provider: ApiOAuthProvider;
  }) => Promise<string>;
}

/**
 * Preserve a channel thread's frozen repository ceiling while applying live
 * revocations. The frozen row remains authoritative for additions; the live
 * row is authoritative for removals. A matching id is the primary identity,
 * with scope equality required so editing an id onto another repository also
 * revokes the old scope. Legacy/recreated rows can fall back to the immutable
 * repository + installation pair.
 */
export function intersectFrozenRepositoryGrants(
  frozen: readonly RepositoryGrant[] | undefined,
  live: readonly RepositoryGrant[] | undefined,
): RepositoryGrant[] {
  const liveEnabled = (live ?? []).filter((grant) => grant.enabled);
  const sameScope = (left: RepositoryGrant, right: RepositoryGrant): boolean =>
    left.installationId === right.installationId &&
    left.fullName.toLowerCase() === right.fullName.toLowerCase() &&
    left.allRepos === right.allRepos;

  return (frozen ?? []).filter((grant) => {
    if (!grant.enabled) return false;
    const idMatch = liveEnabled.find((candidate) => candidate.id === grant.id);
    if (idMatch) return sameScope(grant, idMatch);
    return liveEnabled.some((candidate) => sameScope(grant, candidate));
  });
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
    credentialMode: 'app',
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
  const credential = (url: string) => ({
    headerName: 'Authorization',
    headerValue: githubAuthorizationHeader(url, token),
    allowedMethods: [...REPOSITORY_METHODS],
  });
  return [
    {
      allowedHosts: ['api.github.com'],
      pathPrefixes: apiPrefixes,
      ...credential('https://api.github.com'),
      matchesRequest: (url: string) => !isDeniedRepositoryEndpoint(url),
    },
    {
      allowedHosts: ['github.com'],
      pathPrefixes: gitPrefixes,
      ...credential('https://github.com'),
    },
    {
      allowedHosts: ['api.github.com'],
      pathPrefixes: ['/search/code'],
      ...credential('https://api.github.com'),
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
 * GitHub hosts are reserved for the dedicated App integration. Always remove
 * them from generic API connections, including already-saved rows and profiles
 * with zero repository grants, so a pasted bearer credential can never create
 * an unscoped GitHub route. Repository connectors are the sole GitHub source.
 */
export function mergeRepositoryAndApiConnectors(
  repositoryConnectors: readonly ResolvedApiConnection[],
  apiConnectors: readonly ResolvedApiConnection[],
): ResolvedApiConnection[] {
  const remainingApiConnectors = apiConnectors.flatMap((connector) => {
    const withoutGithub = withoutGithubManagedHosts(connector);
    return withoutGithub ? [withoutGithub] : [];
  });
  return [...repositoryConnectors, ...remainingApiConnectors];
}

function withoutGithubManagedHosts(
  connector: ResolvedApiConnection,
): ResolvedApiConnection | undefined {
  const allowedHosts = connector.allowedHosts.filter(
    (host) => !isGithubAppManagedHost(host),
  );
  return allowedHosts.length > 0 ? { ...connector, allowedHosts } : undefined;
}

export async function resolveApiConnectionsForTurn(
  agentId: string,
  connections: readonly ApiConnectionConfig[],
  env?: PlatformEnv,
  dependencies: ApiConnectionResolutionDependencies = {},
): Promise<ResolvedApiConnectionForTurn[]> {
  const resolveCredential = dependencies.resolveCredential ?? resolveConnectorCredential;
  const resolveOAuthToken = dependencies.resolveOAuthToken ?? (async (input) => {
    const configStore = getConfigStore(env);
    return resolveApiOAuthAccessToken(input, {
      settings: getSettingsStore(env),
      validateConnection: async (ref, provider) => {
        try {
          const current = (await configStore.getAgent(ref.agentId)).apiConnections.find(
            (connection) => connection.id === ref.connectionId,
          );
          return !!current &&
            current.authMode === 'oauth' &&
            current.oauthProvider === provider &&
            isValidApiOAuthConnectionPolicy(current);
        } catch {
          return false;
        }
      },
      onReauthorizationRequired: async (ref, provider) => {
        await configStore.markOAuthReauthorizationRequired({
          lane: 'api',
          ...ref,
          provider,
        });
      },
    });
  });
  const resolved = await Promise.all(
    connections
      .filter((connection) => connection.enabled)
      .map(async (connection): Promise<ResolvedApiConnectionForTurn | undefined> => {
        let credential: string | undefined;
        if (connection.authMode === 'oauth') {
          if (
            connection.lifecycleStatus !== 'ready' ||
            connection.oauthProvider !== 'google' ||
            !isValidApiOAuthConnectionPolicy(connection)
          ) {
            return undefined;
          }
          try {
            credential = await resolveOAuthToken({
              ref: { agentId, connectionId: connection.id },
              provider: connection.oauthProvider,
            });
          } catch (error) {
            console.warn(
              `[chickpea] API OAuth unavailable (${connection.id}): ` +
                (error instanceof ApiOAuthError ? error.code : 'oauth_unavailable'),
            );
            return undefined;
          }
        } else {
          credential = await resolveCredential(
            { agentId, connectionId: connection.id },
            env,
          );
        }
        if (!credential) return undefined;

        const policies = connection.authMode === 'oauth'
          ? googleWorkspaceServicePolicies(connection.oauthScopes ?? [])
          : [connection];
        return {
          connectors: policies.map((policy) => ({
            allowedHosts: policy.allowedHosts,
            pathPrefixes: policy.pathPrefixes,
            headerName: policy.headerName,
            headerValue: (policy.headerValuePrefix ?? '') + credential,
            allowedMethods: policy.allowedMethods,
          })),
          displayName: connection.displayName,
          policy: connection,
        };
      }),
  );
  return resolved.filter(
    (connection): connection is ResolvedApiConnectionForTurn => connection !== undefined,
  );
}

export interface SlackAgentRuntimeInput {
  id: string;
  platformEnv?: PlatformEnv;
  workspaceId?: string;
  channelId?: string;
  liveConfig?: EffectiveSlackConfig;
  runtimeModel?: ResolvedRuntimeModel;
  freezeChannel?: boolean;
  artifactThreadTs?: string | null;
  threadTs?: string;
  declarationsOwnedByHooks?: boolean;
  forcedSandbox?: SandboxSelection;
}

/** Shared interactive/routine agent assembly. Credentials always resolve here, live. */
export async function createSlackAgentRuntime(
  input: SlackAgentRuntimeInput,
): Promise<AgentRuntimeConfig> {
  const id = input.id;
  const env = input.platformEnv ?? (await resolveAgentPlatformEnv());
  const store = getConfigStore(env);
  const settingsStore = getSettingsStore(env);
  const stores = { agents: store, assignments: store };
  const adapterContext = await resolveSlackAgentAdapterContext(input, env);
  const { workspaceId, channelId } = adapterContext;
  const artifactThreadTs = input.artifactThreadTs === null
    ? undefined
    : (input.artifactThreadTs ?? adapterContext.threadTs);
  const resolve = () => resolveEffectiveSlackConfig(workspaceId, channelId, stores);

  // Channel threads are frozen (the channel handler wrote the snapshot at the
  // first turn; getOrCreateSnapshot serves that row). Direct conversations
  // (DMs, App Home) are one continuous session, not a discrete thread, so they
  // resolve the current config every turn instead of freezing — admin edits to
  // the DM profile reach existing DM users.
  const isDirect = surfaceForChannelId(channelId) === 'direct';
  const config = input.liveConfig ?? (
    isDirect || input.freezeChannel === false
      ? await resolve()
      : await getOrCreateSnapshot(
        getAgentSnapshotStore(env),
        adapterContext.threadKey,
        resolve,
      )
  );
  const runtimeModel = input.runtimeModel ?? await resolveRuntimeModel(
    config.agentId,
    config.model,
    {
      settings: settingsStore,
      ...(env ? { env } : {}),
    },
  );

  // A channel snapshot is a ceiling, not a revocation lease. Intersect its
  // frozen grants with the current profile once, before repository access
  // produces either worker-side connectors or Sandbox DO policy. A missing
  // live profile fails closed. Direct conversations already resolved the live
  // profile above and need no second lookup.
  let repositoryGrants = config.agent.repositories;
  if (!isDirect && input.freezeChannel !== false) {
    try {
      const liveAgent = await store.getAgent(config.agent.id);
      repositoryGrants = intersectFrozenRepositoryGrants(
        config.agent.repositories,
        liveAgent.repositories,
      );
    } catch {
      repositoryGrants = [];
    }
  }

  // API connection policy inherits the agent snapshot contract, while its
  // credential resolves live every turn. Missing credentials degrade by
  // skipping that connection rather than aborting the turn.
  const [
    egressPolicy,
    repositoryAccess,
    resolvedApiConnections,
    sandboxSettings,
    githubAppConnected,
  ] =
    await Promise.all([
      resolveEgressPolicy(env),
      resolveRepositoryAccess(repositoryGrants, env),
      resolveApiConnectionsForTurn(config.agent.id, config.agent.apiConnections ?? [], env),
      resolveSandboxSettings(settingsStore),
      getGithubConnection(settingsStore).then(
        (connection) => connection.mode === 'app',
        () => false,
      ),
    ]);
  const sandboxSelection = input.forcedSandbox ?? selectSandbox({
    target: isCloudflareTarget() ? 'cloudflare' : 'node',
    enabled: sandboxSettings.enabled,
    appConnected: githubAppConnected,
    repositoryGrants: repositoryAccess.grants,
  });
  const workspaceSkill = workspaceSkillForSandbox(sandboxSelection);

  // Repository credentials take precedence over legacy/custom GitHub
  // connections. Down-scoped installation tokens are authoritative whenever
  // grants are active, including for narrower legacy path prefixes.
  const resolvedConnectors = mergeRepositoryAndApiConnectors(
    repositoryAccess.connectors,
    resolvedApiConnections.flatMap(({ connectors }) => connectors),
  );
  // Project resolved connectors into credential-free scope before skill
  // construction. Connector skills come first so the existing last-writer-wins
  // dedupe lets a profile-authored skill deliberately override the built-in.
  const connectorSkills = suppressProfileNamedConnectorSkills(
    connectorSkillsForConnections(
      [
        ...repositoryAccess.connectors.map(({ allowedHosts, pathPrefixes, allowedMethods }) => ({
          allowedHosts,
          pathPrefixes,
          allowedMethods,
        })),
        ...resolvedApiConnections.flatMap(({ policy }) => {
          const allowedHosts = policy.allowedHosts.filter(
            (host) => !isGithubAppManagedHost(host),
          );
          return allowedHosts.length > 0
            ? [{
                allowedHosts,
                pathPrefixes: policy.pathPrefixes,
                allowedMethods: policy.allowedMethods,
                ...(policy.presetId ? { presetId: policy.presetId } : {}),
                ...(policy.oauthScopes ? { oauthScopes: policy.oauthScopes } : {}),
              }]
            : [];
        }),
      ],
      repositoryAccess.grants,
    ),
    config.agent.skills,
  );
  // The install/runtime-derived workspace judge comes last so a stored
  // same-named profile row cannot hide the live workspace security contract.
  const skills = resolveProfileSkills([
    ...connectorSkills,
    ...config.agent.skills,
    ...(workspaceSkill ? [workspaceSkill] : []),
  ]);

  const apiConnectionActivities: ApiConnectionActivity[] = [
    ...repositoryAccess.connectors.map(({ allowedHosts, pathPrefixes, allowedMethods, matchesRequest }) => ({
      displayName: 'GitHub repositories',
      allowedHosts,
      pathPrefixes,
      allowedMethods,
      ...(matchesRequest ? { matchesRequest } : {}),
    })),
    ...resolvedApiConnections.flatMap(({ connectors, displayName }) =>
      connectors.flatMap((connector) => {
        const withoutGithub = withoutGithubManagedHosts(connector);
        return withoutGithub
          ? [{
              displayName,
              allowedHosts: withoutGithub.allowedHosts,
              pathPrefixes: withoutGithub.pathPrefixes,
              allowedMethods: withoutGithub.allowedMethods,
              ...(withoutGithub.matchesRequest
                ? { matchesRequest: withoutGithub.matchesRequest }
                : {}),
            }]
          : [];
      }),
    ),
  ];
  registerActivityContext(id, {
    skills: skills.map((skill) => ({ name: skill.name })),
    mcpConnections: (config.agent.mcpServers ?? [])
      .filter(isProfileMcpServerEligible)
      .map(({ id: connectionId, displayName }) => ({ id: connectionId, displayName })),
    apiConnections: apiConnectionActivities,
  });

  // MCP connection tools join at the same seam and inherit the same freeze
  // contract (mcpServers frozen in the snapshot for channels, live for DMs;
  // secrets always resolve live). The resolver degrades gracefully — a dead or
  // slow server is skipped, never aborting the turn — and drops any tool whose
  // name collides with a built-in or skill (a duplicate name kills the turn).
  const mcpTools = input.declarationsOwnedByHooks
    ? []
    : await resolveProfileMcpTools(config.agent.mcpServers, {
        agentId: config.agent.id,
        env,
        existingToolNames: skills.map((s) => s.name),
        onConnectionStart: ({ displayName }) => {
          publishActivityStatus(id, connectingActivityStatus(displayName), env);
        },
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
    grants: repositoryAccess.grants,
    ...(repositoryAccess.credentialMode
      ? { credentialMode: repositoryAccess.credentialMode }
      : {}),
    settingsStore,
    monthlySessionCap: sandboxSettings.monthlySessionCap,
  });
  let tools = mcpTools;
  if (sandboxSelection !== 'bash' && artifactThreadTs) {
    let presenter: Promise<WebClientPresenter> | undefined;
    const artifactCapability = createWorkspaceArtifactCapability({
      sandbox,
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

  const thinkingLevel = thinkingLevelForModel(config.model);
  return {
    model: runtimeModel.model,
    // Flue defaults reasoning-capable models to medium effort. The keyless
    // GLM-5.2 binding can reach Workers AI's response deadline before its first
    // tool call even at low effort, so disable extra reasoning only for this
    // exact binding-backed model specifier. Other models keep Flue's policy.
    ...(thinkingLevel ? { thinkingLevel } : {}),
    instructions: config.instructions,
    tools,
    sandbox,
    ...(skills.length > 0 ? { skills } : {}),
  };
}

/**
 * Transitional access to the existing async assembler for focused policy
 * tests and the U5 routine path. It is not registered with Flue 2 and is
 * removed when RuntimePlanV2 becomes the single pre-dispatch compiler.
 */
export const legacySlackThreadAgent = {
  initialize({ id, env }: { id: string; env?: PlatformEnv }) {
    return createSlackAgentRuntime({ id, ...(env ? { platformEnv: env } : {}) });
  },
};

interface SlackAgentAdapterContext {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  threadKey: string;
}

async function resolveSlackAgentAdapterContext(
  input: SlackAgentRuntimeInput,
  _env: PlatformEnv | undefined,
): Promise<SlackAgentAdapterContext> {
  if (input.workspaceId && input.channelId && input.threadTs) {
    return {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      threadKey: `${input.workspaceId}:${input.channelId}:${input.threadTs}`,
    };
  }
  let parsed: { workspaceId: string; channelId: string; threadTs: string };
  try {
    parsed = parseSlackThreadKey(input.id);
  } catch {
    throw new Error('Legacy Slack agent initialization requires a Slack thread key.');
  }
  const workspaceId = input.workspaceId ?? parsed.workspaceId;
  const channelId = input.channelId ?? parsed.channelId;
  if (
    (input.workspaceId && input.workspaceId !== parsed.workspaceId) ||
    (input.channelId && input.channelId !== parsed.channelId)
  ) {
    throw new Error('Agent execution context does not match the requested Slack binding.');
  }
  return {
    workspaceId,
    channelId,
    threadTs: parsed.threadTs,
    threadKey: `${workspaceId}:${channelId}:${parsed.threadTs}`,
  };
}

/** Flue 2 hook-authored Slack agent. Every declaration comes from validated,
 * secret-free creation data; live credentials stay behind lazy resolvers. */
export function ChickpeaSlack({ id }: AgentProps) {
  const initialData = useInitialData<RuntimePlanV2>();
  if (!initialData) throw new Error('ChickpeaSlack requires RuntimePlanV2 creation data.');
  const plan = parseRuntimePlanV2(initialData);
  useRuntimePlanAgent(plan, id, { responseMetadataModel: plan.model });
  return plan.instructions;
}

/** Compose the declarations shared by Slack and fresh routine agents. */
export function useRuntimePlanAgent(
  plan: RuntimePlanV2,
  id: string,
  options: { responseMetadataModel?: string } = {},
): void {
  const thinkingLevel = thinkingLevelForModel(plan.model);
  useModel(plan.model, thinkingLevel ? { thinkingLevel } : {});
  if (options.responseMetadataModel) {
    useChickpeaResponseMetadata(options.responseMetadataModel);
  }
  useInstruction('Never invent facts or claim access to context and tools you do not have.');
  for (const skill of resolveProfileSkills(
    plan.skills.map((entry) => ({ ...entry, enabled: true })),
  )) {
    useSkill(skill);
  }
  for (const connection of resolveRuntimePlanMcpConnections(
    plan.agentId,
    plan.mcpConnections,
    ({ displayName }) => {
      publishActivityStatus(id, connectingActivityStatus(displayName));
    },
  )) {
    useMcpConnection(connection);
  }
  useSandbox(createRuntimePlanSandbox(plan));
  if (plan.sandbox.mode === 'cloudflare') {
    useTool(createRuntimePlanArtifactTool(plan));
  }
}

ChickpeaSlack.agentName = 'chickpea-slack-v2';
ChickpeaSlack.initialData = v.custom<RuntimePlanV2>((value) => {
  try {
    parseRuntimePlanV2(value);
    return true;
  } catch {
    return false;
  }
}, 'RuntimePlanV2 is invalid.');

function createRuntimePlanSandbox(plan: RuntimePlanV2): SandboxFactory {
  return {
    async createSessionEnv({ id }) {
      const env = await resolveAgentPlatformEnv();
      const current = await getConfigStore(env).getAgent(plan.agentId);
      const agent = projectRuntimePlanAgent(plan, current);
      const runtime = await createSlackAgentRuntime({
        id,
        ...(env ? { platformEnv: env } : {}),
        workspaceId: plan.conversation.workspaceId,
        channelId: plan.conversation.channelId,
        threadTs: plan.conversation.threadTs,
        liveConfig: {
          workspaceId: plan.conversation.workspaceId,
          channelId: plan.conversation.channelId,
          agentId: plan.agentId,
          agent,
          model: plan.model,
          provider: plan.model.split('/', 1)[0] ?? plan.model,
          instructions: plan.instructions,
          instructionLayers: [],
        },
        freezeChannel: false,
        artifactThreadTs: null,
        declarationsOwnedByHooks: true,
        forcedSandbox: plan.sandbox.mode,
      });
      if (!runtime.sandbox) throw new Error('RuntimePlanV2 sandbox is unavailable.');
      return runtime.sandbox.createSessionEnv({ id });
    },
  };
}

function projectRuntimePlanAgent(
  plan: RuntimePlanV2,
  current: CustomAgentConfig,
): CustomAgentConfig {
  // A channel thread owns its frozen RuntimePlan even if the profile is later
  // disabled. Individual live grants still intersect below, so disabling a
  // connection or repository revokes that capability without breaking the
  // already-started conversation.
  if (current.id !== plan.agentId) {
    throw new Error('RuntimePlanV2 profile is unavailable.');
  }
  const apiConnections = plan.apiConnections.map((declaration) => {
    const live = current.apiConnections.find((candidate) =>
      candidate.id === declaration.id && runtimeApiConnectionMatches(candidate, declaration)
    );
    if (!live) throw new Error('RuntimePlanV2 API connection policy changed.');
    return live;
  });
  const repositories = plan.repositories.map((declaration) => {
    const live = current.repositories.find((candidate) =>
      candidate.id === declaration.id && runtimeRepositoryMatches(candidate, declaration)
    );
    if (!live) throw new Error('RuntimePlanV2 repository policy changed.');
    return live;
  });
  const mcpServers = plan.mcpConnections.flatMap((declaration) => {
    const live = current.mcpServers.find((candidate) =>
      candidate.id === declaration.id &&
      candidate.enabled &&
      candidate.lifecycleStatus === 'ready' &&
      candidate.url === declaration.url &&
      candidate.transport === declaration.transport &&
      candidate.authMode === declaration.authMode &&
      declaration.allowedTools.every((tool) => candidate.allowedTools.includes(tool))
    );
    return live ? [live] : [];
  });
  return {
    id: current.id,
    name: current.name,
    instructions: plan.instructions,
    enabled: true,
    model: plan.model,
    skills: plan.skills.map((skill) => ({ ...skill, enabled: true })),
    mcpServers,
    apiConnections,
    repositories,
  };
}

function runtimeApiConnectionMatches(
  current: ApiConnectionConfig,
  planned: RuntimePlanApiConnectionV2,
): boolean {
  return current.enabled &&
    (current.lifecycleStatus === undefined || current.lifecycleStatus === 'ready') &&
    sameStringSet(current.allowedHosts.map((host) => host.toLowerCase()), planned.allowedHosts) &&
    sameStringSet(current.pathPrefixes, planned.pathPrefixes) &&
    sameStringSet(current.allowedMethods.map((method) => method.toUpperCase()), planned.allowedMethods) &&
    current.headerName.toLowerCase() === planned.headerName &&
    (current.headerValuePrefix ?? undefined) === planned.headerValuePrefix &&
    (current.authMode ?? 'credential') === planned.authMode &&
    current.oauthProvider === planned.oauthProvider &&
    sameStringSet(current.oauthScopes ?? [], planned.oauthScopes ?? []);
}

function runtimeRepositoryMatches(
  current: RepositoryGrant,
  planned: RuntimePlanRepositoryV2,
): boolean {
  return current.enabled &&
    current.fullName.toLowerCase() === planned.fullName.toLowerCase() &&
    Boolean(current.allRepos) === Boolean(planned.allRepos);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function createRuntimePlanArtifactTool(plan: RuntimePlanV2) {
  let presenter: Promise<WebClientPresenter> | undefined;
  return createWorkspaceArtifactTool({
    channel: plan.artifactDestination.channelId,
    threadTs: plan.conversation.threadTs,
    async postArtifact(input) {
      presenter ??= (async () => {
        const env = await resolveAgentPlatformEnv();
        const profile = await getConfigStore(env).getAgent(plan.agentId);
        return new WebClientPresenter(await getClient(env), {
          channelId: plan.conversation.channelId,
          threadTs: plan.conversation.threadTs,
          agentName: profile.name,
          agentId: plan.agentId,
          workspaceId: plan.conversation.workspaceId,
        });
      })();
      return (await presenter).postArtifact(input);
    },
  });
}

export function thinkingLevelForModel(model: string): 'off' | undefined {
  return model === SEED_CLOUDFLARE_MODEL_PIN ? 'off' : undefined;
}

interface AgentSandboxOptions {
  selection: SandboxSelection;
  fallback: SandboxFactory;
  env: PlatformEnv | undefined;
  id: string;
  grants: readonly RepositoryGrant[];
  credentialMode?: SandboxCredentialMode;
  settingsStore: ReturnType<typeof getSettingsStore>;
  monthlySessionCap: number;
}

async function resolveAgentSandbox(options: AgentSandboxOptions): Promise<SandboxFactory> {
  if (options.selection === 'bash') return options.fallback;

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
  const sandboxKey = sandboxThreadKey(options.id);
  let turnId: string | undefined;
  const sandbox = await cloudflareSandboxLifecycle.acquire(
    sandboxKey,
    async () =>
      getSandbox(
        binding as Parameters<typeof getSandbox>[0],
        sandboxKey,
        CLOUDFLARE_SANDBOX_OPTIONS,
      ) as ReturnType<typeof getSandbox> & ConfigurableCloudflareSandbox,
    async (candidate) => {
      turnId = await requireSandboxTurnId(candidate);
      if (!options.credentialMode) {
        throw new Error('Sandbox repository credential mode is unavailable');
      }
      await candidate.configureEgress(
        {
          grants: validEnabledRepositoryGrants(options.grants),
          mode: options.credentialMode,
        },
        turnId,
      );
    },
  );
  const serialized = serializeSandboxActivation(
    sandbox as unknown as Parameters<typeof cloudflareSandbox>[0],
    '/workspace',
    async () => {
      if (!turnId) {
        throw new Error('Sandbox turn context is unavailable at activation');
      }
      const reservation = await reserveMonthlySandboxSession({
        store: options.settingsStore,
        cap: options.monthlySessionCap,
        reservationId: turnId,
      });
      if (!reservation.allowed) {
        throw new SandboxSessionCapError();
      }
    },
  );
  return cloudflareSandbox(serialized, { cwd: '/workspace' });
}

/**
 * The platform env the store factories need on Cloudflare (the TAG_STATE
 * binding). This module executes inside the Flue-generated agent Durable
 * Object there, where the bindings come from the runtime's ALS-scoped
 * Cloudflare context — populated ONLY inside DO handlers, which is exactly
 * where the Flue agent function runs. Imported dynamically and only on the CF
 * target: '@flue/runtime/cloudflare' has no business in the node lane's
 * runtime graph, and on node the factories ignore the env anyway.
 */
export async function resolveAgentPlatformEnv(): Promise<PlatformEnv | undefined> {
  if (!isCloudflareTarget()) {
    return undefined;
  }
  const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
  return getCloudflareContext().env as PlatformEnv;
}
