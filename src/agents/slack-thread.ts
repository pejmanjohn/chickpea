'use agent';

import { SLACK_MEMORY_UPDATE_DATA_NAME, SlackMemoryUpdateSchema, type SlackMemoryUpdate } from '../slack/memory-update-terminal.ts';

import {
  bash,
  type AgentProps,
  type AgentRuntimeConfig,
  type SandboxFactory,
  useDataWriter,
  useDelivery,
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
  buildSemanticActivityContext,
  connectingActivityStatus,
  registerActivityContext,
  type ActivityToolDescriptor,
} from '../activity/status.ts';
import {
  genericSemanticDescriptor,
  semanticDescriptorForCoreTool,
  unknownSemanticDescriptor,
} from '../activity/semantic.ts';
import {
  ApiOAuthError,
  connectionAccountIdFromOAuthRef,
  connectionAccountOAuthRef,
  resolveApiOAuthAccessToken,
  type ApiOAuthProvider,
  type ApiOAuthRef,
} from '../config/api-oauth.ts';
import {
  googleWorkspaceServicePolicies,
  isValidApiOAuthConnectionPolicy,
} from '../config/api-oauth-policy.ts';
import { resolveConnectorCredential } from '../config/connector-secrets.ts';
import { revalidateModelCredentialAttribution } from '../config/model-credential-refs.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
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
  resolveRuntimePlanMcpConnections,
  resolveProfileMcpTools,
} from '../config/profile-mcp.ts';
import { resolveMcpOAuthAccessToken } from '../config/mcp-oauth.ts';
import { resolveProfileSkills } from '../config/profile-skills.ts';
import {
  registerFrozenRuntimeModelRoute,
  resolveRuntimeModel,
  type ResolvedRuntimeModel,
} from '../config/runtime-model.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import { isWorkersAiGlmModel } from '../config/workers-ai-models.ts';
import { surfaceForChannelId } from '../config/resolver.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { getOrCreateSnapshot } from '../config/snapshot-store.ts';
import {
  getAgentSnapshotStore,
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
  getUsageStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  type ApiConnectionConfig,
  type CustomAgentConfig,
  type RepositoryGrant,
  type SkillConfig,
} from '../config/types.ts';
import { agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';
import { resolveSlackPublicUrl } from '../slack/credentials.ts';
import { SLACK_ACTION_LINK_INSTRUCTION } from '../slack/message-format.ts';
import {
  isDeniedRepositoryEndpoint,
  matchesGrantedCodeSearch,
  REPOSITORY_METHODS,
  REPOSITORY_PERMISSIONS,
  validEnabledRepositoryGrants,
} from '../sandbox/egress-handler.ts';
import { githubAuthorizationHeader } from '../sandbox/github-auth.ts';
import {
  projectEffectiveApiConnections,
  projectEffectiveManagedConnections,
  projectEffectiveMcpConnections,
  resolveConnectionSecretForInvocation,
  resolveEffectiveConnectionAccounts,
  isActiveConnectionActor,
} from '../connections/runtime.ts';
import { semanticDescriptorForManagedTool } from '../connections/catalog/index.ts';
import {
  createManagedConnectionTools,
  MANAGED_CONNECTION_RESULT_INSTRUCTION,
  useManagedConnectionTools,
} from '../connections/managed-tools.ts';
import { usePersonalConnectionAuthorizationSlackTool } from '../connections/slack-authorization.ts';

import type {
  SandboxCredentialMode,
  SandboxEgressPolicyInput,
} from '../sandbox/cloudflare-policy.ts';
import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  SandboxLifecycleRegistry,
  contentFreeSandboxExec,
  serializeSandboxActivation,
  type DestroyableSandbox,
} from '../sandbox/lifecycle.ts';
import { SandboxSessionCapError } from '../sandbox/errors.ts';
import {
  resolveSandboxSelection,
  sandboxBindingInstalled,
  selectSandbox,
  type SandboxSelection,
} from '../sandbox/select.ts';
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
import { parseCurrentRequestEnvelope } from '../memory/tool-policy.ts';
import {
  parseSlackAttachmentIntake,
  slackAttachmentTurnIsReadOnly,
  useSlackAttachmentContext,
} from '../slack/attachment-context.ts';
import { resolveSlackInstallationExecutionContext } from '../slack/installation-execution.ts';
import { slackPresentationIntentCapability } from '../slack/presentation-intent.ts';
import {
  createSlackPresentTableTool,
  SLACK_PRESENT_TABLE_INSTRUCTION,
  SLACK_PRESENT_TABLE_TOOL_NAME,
  SLACK_TABLE_PRESENTATION_DATA_NAME,
  SlackTablePresentationSchema,
  type SlackTablePresentation,
} from '../slack/table-presentation.ts';
import {
  SLACK_AGENT_CREATION_TERMINAL_DATA_NAME,
  SlackAgentCreationTerminalIntentSchema,
  type SlackAgentCreationTerminalIntent,
} from '../slack/agent-creation-terminal.ts';
import { parseSlackThreadKey } from '../slack/thread-key.ts';
import { WebClientPresenter } from '../slack/web-client-presenter.ts';
import {
  parseSlackManagementSignal,
  useWorkspaceManagementSlackTools,
} from '../management/slack-tools.ts';
import {
  WORKSPACE_MANAGEMENT_TOOL_NAMES,
  workspaceManagementSemanticDescriptor,
} from '../management/tool-adapter.ts';
import {
  AGENT_AUTHORING_SKILL_NAME,
  useAgentAuthoring,
} from '../management/agent-authoring/index.ts';
import { useChickpeaResponseMetadata } from '../usage/response-metadata.ts';
import { bootstrapRuntimeProviders } from '../runtime-bootstrap.ts';
import {
  buildRuntimePlanActivityContext,
  parseRuntimePlanV2,
  type RuntimePlanModelCredentialV3,
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

export class SealedAgentThreadError extends Error {
  constructor(readonly agentId: string) {
    super('This thread’s Agent is no longer available. Start a new thread with an active Agent.');
    this.name = 'SealedAgentThreadError';
  }
}

export function suppressProfileNamedConnectorSkills(
  connectorSkills: readonly SkillConfig[],
  profileSkills: readonly SkillConfig[],
): SkillConfig[] {
  const profileSkillNames = new Set(profileSkills.map((skill) => skill.name));
  // Any Agent row owns its name even when disabled: a disabled row is the
  // operator's off-switch for an otherwise auto-attached connector skill.
  return connectorSkills.filter((skill) => !profileSkillNames.has(skill.name));
}

export interface ResolvedRepositoryAccess {
  grants: RepositoryGrant[];
  connectors: ResolvedApiConnection[];
  credentialMode?: SandboxCredentialMode;
  /**
   * True whenever the Agent has enabled grants, even if no credential
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

export async function resolveSandboxScopedRepositoryAccess(input: {
  repositories: readonly RepositoryGrant[];
  env?: PlatformEnv;
  unavailableFallback: boolean;
  resolve?: typeof resolveRepositoryAccess;
}): Promise<ResolvedRepositoryAccess> {
  if (input.unavailableFallback) {
    return {
      grants: [],
      connectors: [],
      governsGithubHosts: input.repositories.some((grant) => grant.enabled),
    };
  }
  return (input.resolve ?? resolveRepositoryAccess)(input.repositories, input.env);
}

export interface ApiConnectionResolutionDependencies {
  resolveCredential?: typeof resolveConnectorCredential;
  resolveOAuthToken?: (input: {
    ref: ApiOAuthRef;
    provider: ApiOAuthProvider;
  }) => Promise<string>;
  accountContext?: {
    config: Pick<ConfigStore, 'listConnectionAccounts' | 'listAgentConnectionBindings'>;
    settings?: SettingsStore;
    workspaceId: string;
    actorMembershipId: string;
  };
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
 * them from generic API connections, including already-saved rows and Agents
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
  const accountContext = dependencies.accountContext;
  if (accountContext && !(await isActiveConnectionActor({
    identity: getIdentityStore(env),
    workspaceId: accountContext.workspaceId,
    actorMembershipId: accountContext.actorMembershipId,
  }))) return [];
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
            const oauthInput = {
              ref: accountContext
                ? connectionAccountOAuthRef(connection.id)
                : { agentId, connectionId: connection.id },
              provider: connection.oauthProvider,
            };
            credential = accountContext && !dependencies.resolveOAuthToken
              ? await resolveApiOAuthAccessToken(oauthInput, {
                  settings: accountContext.settings ?? getSettingsStore(env),
                  validateConnection: async (ref, provider, _accountRevision, oauthAttemptId) => {
                    const current = await resolveEffectiveConnectionAccounts({
                      config: accountContext.config,
                      workspaceId: accountContext.workspaceId,
                      agentId,
                      actorMembershipId: accountContext.actorMembershipId,
                    });
                    const account = current.find(({ account }) => account.id === ref.agentId)?.account;
                    return ref.connectionId === 'account' &&
                      account?.providerId === provider &&
                      account.policy.kind === 'api' &&
                      account.policy.authMode === 'oauth' &&
                      (oauthAttemptId === undefined ||
                        account.policy.oauthAttemptId === oauthAttemptId);
                  },
                })
              : await resolveOAuthToken(oauthInput);
          } catch (error) {
            console.warn(
              `[chickpea] API OAuth unavailable (${connection.id}): ` +
                (error instanceof ApiOAuthError ? error.code : 'oauth_unavailable'),
            );
            return undefined;
          }
        } else {
          credential = accountContext
            ? await resolveConnectionSecretForInvocation({
                config: accountContext.config,
                ...(accountContext.settings ? { settings: accountContext.settings } : {}),
                ...(env ? { env } : {}),
                workspaceId: accountContext.workspaceId,
                agentId,
                actorMembershipId: accountContext.actorMembershipId,
                connectionAccountId: connection.id,
              })
            : await resolveCredential({ agentId, connectionId: connection.id }, env);
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
  frozenModelCredential?: RuntimePlanModelCredentialV3;
  freezeChannel?: boolean;
  artifactThreadTs?: string | null;
  threadTs?: string;
  actorMembershipId?: string;
  declarationsOwnedByHooks?: boolean;
  forcedSandbox?: SandboxSelection;
  sandboxConversationKey?: string;
  /** RuntimePlan hooks already own the exact frozen activity registration. */
  registerActivityContext?: boolean;
}

/** Shared interactive/routine agent assembly. Credentials always resolve here, live. */
export async function createSlackAgentRuntime(
  input: SlackAgentRuntimeInput,
): Promise<AgentRuntimeConfig> {
  const id = input.id;
  const env = input.platformEnv ?? (await resolveAgentPlatformEnv());
  const store = getConfigStore(env);
  const settingsStore = getSettingsStore(env);
  const stores = { agents: store, grants: store };
  const adapterContext = await resolveSlackAgentAdapterContext(input, env);
  const { workspaceId, channelId } = adapterContext;
  const effectiveConnectionAccounts = input.actorMembershipId
    ? await resolveEffectiveConnectionAccounts({
        config: store,
        workspaceId,
        agentId: input.liveConfig?.agentId ?? input.id,
        actorMembershipId: input.actorMembershipId,
      })
    : [];
  const artifactThreadTs = input.artifactThreadTs === null
    ? undefined
    : (input.artifactThreadTs ?? adapterContext.threadTs);
  const resolve = () => resolveEffectiveSlackConfig(
    workspaceId,
    channelId,
    stores,
    process.env,
    input.liveConfig?.agentId ?? input.id,
  );

  // Channel threads are frozen (the channel handler wrote the snapshot at the
  // first turn; getOrCreateSnapshot serves that row). Direct conversations
  // Direct messages are one continuous session, not a discrete thread, so they
  // resolve the current config every turn instead of freezing — admin edits to
  // the DM Agent reach existing DM users.
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
  const frozenLiveAgent = !isDirect && input.freezeChannel !== false
    ? await requireLiveFrozenAgent(store, config.agent.id)
    : undefined;
  const frozenModelCredential = input.frozenModelCredential ?? config.modelCredential;
  if (frozenModelCredential) {
    await revalidateModelCredentialAttribution(
      config.model,
      frozenModelCredential,
      env,
      settingsStore,
      getUsageStore(env),
    );
  }
  const runtimeModel = input.runtimeModel ?? await resolveRuntimeModel(
    config.agentId,
    config.model,
    {
      settings: settingsStore,
      ...(env ? { env } : {}),
    },
  );

  // A Channel snapshot freezes additions while the live Agent remains the
  // revocation authority. Disabled or deleted Agents seal the old root; a
  // reassignment alone keeps that root on its frozen, still-enabled Agent.
  let repositoryGrants = config.agent.repositories;
  if (frozenLiveAgent) {
    repositoryGrants = intersectFrozenRepositoryGrants(
      config.agent.repositories,
      frozenLiveAgent.repositories,
    );
  }

  // API connection policy inherits the agent snapshot contract, while its
  // credential resolves live every turn. Missing credentials degrade by
  // skipping that connection rather than aborting the turn.
  const [
    egressPolicy,
    resolvedApiConnections,
    sandboxSettings,
    githubAppConnected,
  ] =
    await Promise.all([
      resolveEgressPolicy(env),
      resolveApiConnectionsForTurn(
        config.agent.id,
        projectEffectiveApiConnections(effectiveConnectionAccounts),
        env,
        input.actorMembershipId
          ? {
              accountContext: {
                config: store,
                settings: settingsStore,
                workspaceId,
                actorMembershipId: input.actorMembershipId,
              },
            }
          : {},
      ),
      resolveSandboxSettings(settingsStore),
      getGithubConnection(settingsStore).then(
        (connection) => connection.mode === 'app',
        () => false,
      ),
    ]);
  const installed = sandboxBindingInstalled(env);
  const configuredSandbox = resolveSandboxSelection({
    target: isCloudflareTarget() ? 'cloudflare' : 'node',
    installed,
    enabled: sandboxSettings.enabled,
    appConnected: githubAppConnected,
    repositoryGrants,
  });
  const unavailableFallback =
    configuredSandbox.unavailableFallback ||
    (input.forcedSandbox === 'cloudflare' && !installed);
  const repositoryAccess = await resolveSandboxScopedRepositoryAccess({
    repositories: repositoryGrants,
    ...(env ? { env } : {}),
    unavailableFallback,
  });
  const sandboxSelection = input.forcedSandbox
    ? input.forcedSandbox === 'cloudflare' && installed ? 'cloudflare' : 'bash'
    : selectSandbox({
        target: isCloudflareTarget() ? 'cloudflare' : 'node',
        installed,
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
  // dedupe lets an Agent-authored skill deliberately override the built-in.
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
  // same-named Agent row cannot hide the live workspace security contract.
  const skills = resolveProfileSkills([
    ...connectorSkills,
    ...config.agent.skills,
    ...(workspaceSkill ? [workspaceSkill] : []),
  ], { reservedNames: [AGENT_AUTHORING_SKILL_NAME] });

  const managedTools = input.actorMembershipId
    ? createManagedConnectionTools({
        connections: projectEffectiveManagedConnections(effectiveConnectionAccounts),
        workspaceId,
        agentId: config.agent.id,
        actorMembershipId: input.actorMembershipId,
        resolvePlatformEnv: async () => env,
        reservedToolNames: [
          AGENT_AUTHORING_SKILL_NAME,
          ...skills.map(({ name }) => name),
        ],
      })
    : [];

  // MCP connection tools join at the same seam and inherit the same freeze
  // contract (mcpServers frozen in the snapshot for channels, live for DMs;
  // secrets always resolve live). The resolver degrades gracefully — a dead or
  // slow server is skipped, never aborting the turn — and drops any tool whose
  // name collides with a built-in or skill (a duplicate name kills the turn).
  const mcpTools = input.declarationsOwnedByHooks
    ? []
    : await resolveProfileMcpTools(
        projectEffectiveMcpConnections(effectiveConnectionAccounts),
      {
        agentId: config.agent.id,
        env,
        existingToolNames: [
          AGENT_AUTHORING_SKILL_NAME,
          ...skills.map((skill) => skill.name),
          ...managedTools.map((tool) => tool.name),
        ],
        ...(input.actorMembershipId
          ? {
              resolveBearerCredential: (connectionAccountId: string) =>
                resolveConnectionSecretForInvocation({
                  config: store,
                  settings: settingsStore,
                  ...(env ? { env } : {}),
                  workspaceId,
                  agentId: config.agent.id,
                  actorMembershipId: input.actorMembershipId!,
                  connectionAccountId,
                }),
              resolveOAuthAccessToken: async (oauthInput) => {
                if (!(await isActiveConnectionActor({
                  identity: getIdentityStore(env),
                  workspaceId,
                  actorMembershipId: input.actorMembershipId!,
                }))) throw new Error('Connection account is not available to this actor');
                return resolveMcpOAuthAccessToken(
                  {
                    ...oauthInput,
                    ref: connectionAccountOAuthRef(oauthInput.ref.connectionId),
                  },
                  {
                    settings: settingsStore,
                    validateConnection: async (ref, serverUrl, _accountRevision, oauthAttemptId) => {
                      const current = await resolveEffectiveConnectionAccounts({
                        config: store,
                        workspaceId,
                        agentId: config.agent.id,
                        actorMembershipId: input.actorMembershipId!,
                      });
                      const accountId = connectionAccountIdFromOAuthRef(ref);
                      const account = current.find(({ account }) => account.id === accountId)?.account;
                      return !!accountId && account?.policy.kind === 'mcp' &&
                        account.policy.authMode === 'oauth' && account.policy.url === serverUrl &&
                        (oauthAttemptId === undefined ||
                          account.policy.oauthAttemptId === oauthAttemptId);
                    },
                  },
                );
              },
            }
          : {}),
        onConnectionStart: () => {
          publishActivityStatus(id, connectingActivityStatus('a connected service'), env);
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
    conversationKey: input.sandboxConversationKey ?? adapterContext.threadKey,
    grants: repositoryAccess.grants,
    ...(repositoryAccess.credentialMode
      ? { credentialMode: repositoryAccess.credentialMode }
      : {}),
    settingsStore,
    monthlySessionCap: sandboxSettings.monthlySessionCap,
  });
  let tools = [...mcpTools, ...managedTools];
  if (sandboxSelection !== 'bash' && artifactThreadTs) {
    let presenter: Promise<WebClientPresenter> | undefined;
    const artifactCapability = createWorkspaceArtifactCapability({
      sandbox,
      channel: channelId,
      threadTs: artifactThreadTs,
      postArtifact: async (input) => {
        presenter ??= Promise.all([
          resolveSlackInstallationExecutionContext(
            workspaceId,
            env,
            { settings: settingsStore },
          ),
          resolveSlackPublicUrl(env, settingsStore).catch(() => undefined),
        ]).then(([installation, publicUrl]) => {
          const agentAvatarUrl = agentAvatarUrlForPresentation(config.agent, publicUrl);
          return new WebClientPresenter(installation.client, {
            channelId,
            threadTs: artifactThreadTs,
            agentName: config.agent.name,
            ...(agentAvatarUrl
              ? { agentAvatarUrl }
              : {}),
            agentId: config.agent.id,
            workspaceId,
          });
        });
        return (await presenter).postArtifact(input);
      },
    });
    sandbox = artifactCapability.sandbox;
    tools = [...mcpTools, ...managedTools, artifactCapability.tool];
  }

  if (input.registerActivityContext !== false) {
    const activityDescriptors: ActivityToolDescriptor[] = [];
    for (const tool of managedTools) {
      const descriptor = semanticDescriptorForManagedTool(tool.name);
      if (descriptor) activityDescriptors.push({ toolName: tool.name, descriptor });
    }
    if (skills.length > 0) {
      const skill = genericSemanticDescriptor('skill');
      activityDescriptors.push(
        { toolName: 'activate_skill', descriptor: skill },
        { toolName: 'read_skill_resource', descriptor: skill },
      );
    }
    const sandboxDescriptor = unknownSemanticDescriptor();
    for (const toolName of ['bash', 'read', 'write', 'edit', 'grep', 'glob']) {
      activityDescriptors.push({ toolName, descriptor: sandboxDescriptor });
    }
    if (tools.some(({ name }) => name === 'post_artifact')) {
      activityDescriptors.push({
        toolName: 'post_artifact',
        descriptor: genericSemanticDescriptor('artifact'),
      });
    }
    registerActivityContext(id, buildSemanticActivityContext(activityDescriptors, [
      ...(managedTools.length > 0 ? ['managed_connector' as const] : []),
      ...(mcpTools.length > 0 || resolvedApiConnections.length > 0
        ? ['custom_connection' as const]
        : []),
      ...(skills.length > 0 ? ['skill' as const] : []),
      ...(repositoryAccess.grants.length > 0 ? ['repository' as const] : []),
      ...(tools.some(({ name }) => name === 'post_artifact') ? ['artifact' as const] : []),
    ]));
  }

  const thinkingLevel = thinkingLevelForModel(config.model);
  return {
    model: runtimeModel.model,
    // Flue defaults reasoning-capable models to medium effort. The keyless
    // GLM bindings can reach Workers AI's response deadline before their first
    // tool call even at low effort, so disable extra reasoning only for the
    // Workers AI GLM family. Other models keep Flue's policy.
    ...(thinkingLevel ? { thinkingLevel } : {}),
    instructions: managedTools.length > 0
      ? `${config.instructions}\n\n${MANAGED_CONNECTION_RESULT_INSTRUCTION}`
      : config.instructions,
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
  const delivery = useDelivery();
  const currentRequest = parseCurrentRequestEnvelope(delivery.body);
  const presentationIntent = slackPresentationIntentCapability(currentRequest);
  const writeTablePresentation = useDataWriter(SLACK_TABLE_PRESENTATION_DATA_NAME, {
    schema: SlackTablePresentationSchema,
  });
  const writeAgentCreationTerminal = useDataWriter(SLACK_AGENT_CREATION_TERMINAL_DATA_NAME, {
    schema: SlackAgentCreationTerminalIntentSchema,
  });
  const writeMemoryUpdate = useDataWriter(SLACK_MEMORY_UPDATE_DATA_NAME, { schema: SlackMemoryUpdateSchema });
  const attachmentReadOnly = slackAttachmentTurnIsReadOnly(
    parseSlackAttachmentIntake(delivery, plan),
  );
  const managementEnabled = !!parseSlackManagementSignal(delivery, plan);
  useChickpeaSlackRuntimeCapabilities(
    plan,
    id,
    attachmentReadOnly,
    presentationIntent,
    writeTablePresentation,
    writeAgentCreationTerminal,
    managementEnabled,
    writeMemoryUpdate,
  );
  useSlackAttachmentContext(
    plan,
    resolveAgentPlatformEnv,
    async (env) => plan.runtimeModel ?? (await prepareRuntimePlanModel(plan, env)).model,
  );
  return plan.instructions;
}

/** Register the exact main-turn capability set after trusted attachment intake is known. */
export function useChickpeaSlackRuntimeCapabilities(
  plan: RuntimePlanV2,
  id: string,
  attachmentReadOnly: boolean,
  presentationIntent: ReturnType<typeof slackPresentationIntentCapability>,
  writeTablePresentation: (presentation: SlackTablePresentation) => void,
  writeAgentCreationTerminal: (intent: SlackAgentCreationTerminalIntent) => void,
  managementEnabled: boolean,
  writeMemoryUpdate?: (receipt: SlackMemoryUpdate) => void,
): void {
  useRuntimePlanAgent(plan, id, {
    responseMetadataModel: plan.model,
    toolsDisabled: attachmentReadOnly,
    includeAgentAuthoringSkill: !attachmentReadOnly,
    additionalActivityToolDescriptors: slackActivityToolDescriptors({
      plan,
      managementEnabled: managementEnabled && !attachmentReadOnly,
      ...(!attachmentReadOnly && presentationIntent
        ? { presentationToolName: presentationIntent.tool.name }
        : {}),
      ...(!attachmentReadOnly ? { tablePresentationToolName: SLACK_PRESENT_TABLE_TOOL_NAME } : {}),
    }),
  });
  if (!attachmentReadOnly) {
    useAgentAuthoring();
    useWorkspaceManagementSlackTools(plan, resolveAgentPlatformEnv, writeAgentCreationTerminal, writeMemoryUpdate);
    usePersonalConnectionAuthorizationSlackTool(plan, resolveAgentPlatformEnv);
    useInstruction(SLACK_PRESENT_TABLE_INSTRUCTION);
    useTool(createSlackPresentTableTool(writeTablePresentation));
    if (presentationIntent) {
      useInstruction(presentationIntent.instruction);
      useTool(presentationIntent.tool);
    }
  }
}

/** Compose the declarations shared by Slack and fresh routine agents. */
export function useRuntimePlanAgent(
  plan: RuntimePlanV2,
  id: string,
  options: {
    responseMetadataModel?: string;
    sandboxConversationKey?: string;
    connectorUsageCorrelation?: import('../connections/managed-tools.ts').ManagedToolUsageCorrelation;
    toolsDisabled?: boolean;
    includeAgentAuthoringSkill?: boolean;
    additionalActivityToolDescriptors?: readonly ActivityToolDescriptor[];
  } = {},
): void {
  registerActivityContext(id, buildRuntimePlanActivityContext(plan, {
    ...(options.toolsDisabled === undefined ? {} : { toolsDisabled: options.toolsDisabled }),
    ...(options.includeAgentAuthoringSkill === undefined
      ? {}
      : { includeAgentAuthoringSkill: options.includeAgentAuthoringSkill }),
    reservedToolNames: [AGENT_AUTHORING_SKILL_NAME],
    ...(options.additionalActivityToolDescriptors === undefined
      ? {}
      : { additionalToolDescriptors: options.additionalActivityToolDescriptors }),
  }));
  registerFrozenRuntimeModelRoute(
    plan.model,
    plan.runtimeModel ?? plan.model,
    plan.runtimeModelRoute,
  );
  const thinkingLevel = thinkingLevelForModel(plan.model);
  useModel(plan.runtimeModel ?? plan.model, thinkingLevel ? { thinkingLevel } : {});
  if (options.responseMetadataModel) {
    useChickpeaResponseMetadata(options.responseMetadataModel);
  }
  useInstruction('Never invent facts or claim access to context and tools you do not have.');
  useInstruction('Sandbox files are temporary working data, not durable Agent memory. They do not follow this Agent into a fresh conversation. A successful file or shell write cannot establish that a fact was remembered. Never promise future recall from a sandbox file.');
  useInstruction(SLACK_ACTION_LINK_INSTRUCTION);
  if (options.toolsDisabled) {
    useInstruction(
      'This attachment-bearing Slack turn is read-only. No tools, connectors, sandboxes, or workspace-management actions are available. Answer only from the authoritative Slack request and the attachment evidence signal. If the request also asks for an external action, analyze the attachments, state the exact proposed action inputs separately, and ask the user to restate those exact inputs in a new text-only message. A vague follow-up such as "go ahead" is not authorization.',
    );
  } else {
    useManagedConnectionTools(
      plan,
      resolveAgentPlatformEnv,
      options.connectorUsageCorrelation,
      [AGENT_AUTHORING_SKILL_NAME],
    );
  }
  if (!options.toolsDisabled) {
    for (const skill of resolveProfileSkills(
      plan.skills.map((entry) => ({ ...entry, enabled: true })),
      { reservedNames: [AGENT_AUTHORING_SKILL_NAME] },
    )) {
      useSkill(skill);
    }
  }
  if (!options.toolsDisabled && !plan.actorMembershipId) {
    for (const connection of resolveRuntimePlanMcpConnections(
      plan.agentId,
      plan.mcpConnections,
      () => {
        publishActivityStatus(id, connectingActivityStatus('a connected service'));
      },
    )) {
      useMcpConnection(connection);
    }
  }
  if (options.toolsDisabled) {
    // Attachment turns expose no sandbox tools, but still initialize a tiny
    // environment so provider authority is rebound on every Flue recovery
    // attempt, including one whose durable start hook already committed.
    useSandbox(createRuntimePlanPreparationSandbox(plan));
  } else {
    useSandbox(createRuntimePlanSandbox(plan, options.sandboxConversationKey));
    if (plan.sandbox.mode === 'cloudflare') {
      useTool(createRuntimePlanArtifactTool(plan));
    }
  }
}

function slackActivityToolDescriptors(input: {
  plan: RuntimePlanV2;
  managementEnabled: boolean;
  presentationToolName?: string;
  tablePresentationToolName?: string;
}): ActivityToolDescriptor[] {
  const descriptors: ActivityToolDescriptor[] = [];
  if (input.managementEnabled) {
    descriptors.push({
      toolName: 'update_agent_memory',
      descriptor: workspaceManagementSemanticDescriptor('apply_workspace_changes'),
    });
    descriptors.push(...WORKSPACE_MANAGEMENT_TOOL_NAMES.map((toolName) => ({
      toolName,
      descriptor: workspaceManagementSemanticDescriptor(toolName),
    })));
    descriptors.push({
      toolName: 'request_chickpea_handoff',
      descriptor: semanticDescriptorForCoreTool('request_chickpea_handoff'),
    });
    if (input.plan.actorMembershipId && input.plan.connectionAuthorizations?.length) {
      descriptors.push({
        toolName: 'authorize_personal_connection',
        descriptor: genericSemanticDescriptor('connection_setup'),
      });
    }
  }
  if (input.presentationToolName) {
    descriptors.push({
      toolName: input.presentationToolName,
      descriptor: semanticDescriptorForCoreTool(input.presentationToolName),
    });
  }
  if (input.tablePresentationToolName) {
    descriptors.push({
      toolName: input.tablePresentationToolName,
      descriptor: semanticDescriptorForCoreTool(input.tablePresentationToolName),
    });
  }
  return descriptors;
}

// Must stay a static literal — see the note on ChickpeaRoutineExecution.
ChickpeaSlack.agentName = 'chickpea-slack-v2';
ChickpeaSlack.initialData = v.custom<RuntimePlanV2>((value) => {
  try {
    parseRuntimePlanV2(value);
    return true;
  } catch {
    return false;
  }
}, 'RuntimePlanV2 is invalid.');

function createRuntimePlanSandbox(
  plan: RuntimePlanV2,
  sandboxConversationKey?: string,
): SandboxFactory {
  // RuntimePlanV2 has already frozen the sandbox decision and stripped legacy
  // arbitrary API connections from the Agent projection. A bash-only plan
  // therefore needs only Flue's local, content-free workspace. Rebuilding the
  // full live Agent runtime here is both semantically redundant and, on
  // Cloudflare, creates a deep Agent DO -> state DO call chain before the
  // provider can even start. Repository-backed plans retain the live
  // revocation and credential checks below.
  if (plan.sandbox.mode === 'bash') {
    const localSandbox = bash(() => new Bash({ fs: new InMemoryFs() }));
    return {
      async createSessionEnv(options) {
        const env = await resolveAgentPlatformEnv();
        await prepareRuntimePlanModel(plan, env);
        return localSandbox.createSessionEnv(options);
      },
    };
  }
  return {
    async createSessionEnv({ id }) {
      const env = await resolveAgentPlatformEnv();
      const current = await requireLiveFrozenAgent(getConfigStore(env), plan.agentId);
      const agent = projectRuntimePlanAgent(plan, current);
      const runtime = await createSlackAgentRuntime({
        id,
        ...(env ? { platformEnv: env } : {}),
        workspaceId: plan.conversation.workspaceId,
        channelId: plan.conversation.channelId,
        threadTs: plan.conversation.threadTs,
        ...(plan.modelCredential ? { frozenModelCredential: plan.modelCredential } : {}),
        liveConfig: {
          workspaceId: plan.conversation.workspaceId,
          channelId: plan.conversation.channelId,
          agentId: plan.agentId,
          agent,
          model: plan.model,
          provider: plan.model.split('/', 1)[0] ?? plan.model,
          modelAttribution: plan.modelAttribution ?? {
            source: 'legacy_environment',
            providerId: plan.model.split('/', 1)[0] ?? plan.model,
          },
          instructions: plan.instructions,
          instructionLayers: [],
        },
        freezeChannel: false,
        artifactThreadTs: null,
        registerActivityContext: false,
        declarationsOwnedByHooks: !plan.actorMembershipId,
        forcedSandbox: plan.sandbox.mode,
        ...(plan.actorMembershipId ? { actorMembershipId: plan.actorMembershipId } : {}),
        ...(sandboxConversationKey ? { sandboxConversationKey } : {}),
      });
      if (!runtime.sandbox) throw new Error('RuntimePlanV2 sandbox is unavailable.');
      return runtime.sandbox.createSessionEnv({ id });
    },
  };
}

function createRuntimePlanPreparationSandbox(plan: RuntimePlanV2): SandboxFactory {
  const localSandbox = bash(() => new Bash({ fs: new InMemoryFs() }));
  return {
    async createSessionEnv(options) {
      const env = await resolveAgentPlatformEnv();
      await prepareRuntimePlanModel(plan, env);
      return localSandbox.createSessionEnv(options);
    },
    tools: () => [],
  };
}

/** Bind the frozen model lane before any model call, including tool-free attachment turns. */
async function prepareRuntimePlanModel(
  plan: RuntimePlanV2,
  env: PlatformEnv | undefined,
) {
  // Runtime plans freeze behavior, but they do not preserve execution
  // authority after an Agent is disabled or archived.
  await requireLiveFrozenAgent(getConfigStore(env), plan.agentId);
  const settings = getSettingsStore(env);
  if (plan.modelCredential) {
    await revalidateModelCredentialAttribution(
      plan.model,
      plan.modelCredential,
      env,
      settings,
      getUsageStore(env),
    );
  }
  // Keep the canonical model as the public/audit identity. Resolve and bind its
  // live billing lane immediately before the call, then verify that it still
  // matches the secret-free internal route frozen when the turn was admitted.
  const resolved = await resolveRuntimeModel(plan.agentId, plan.model, {
    settings,
    ...(env ? { env } : {}),
  });
  if (plan.runtimeModel && resolved.model !== plan.runtimeModel) {
    throw new Error('Runtime model route changed after this Slack turn was admitted.');
  }
  return resolved;
}

function projectRuntimePlanAgent(
  plan: RuntimePlanV2,
  current: CustomAgentConfig,
): CustomAgentConfig {
  if (current.id !== plan.agentId || !current.enabled) {
    throw new SealedAgentThreadError(plan.agentId);
  }
  const apiConnections: CustomAgentConfig['apiConnections'] = [];
  const repositories = plan.repositories.map((declaration) => {
    const live = current.repositories.find((candidate) =>
      candidate.id === declaration.id && runtimeRepositoryMatches(candidate, declaration)
    );
    if (!live) throw new Error('RuntimePlanV2 repository policy changed.');
    return live;
  });
  const mcpServers: CustomAgentConfig['mcpServers'] = [];
  return {
    id: current.id,
    kind: current.kind,
    revision: current.revision,
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

async function requireLiveFrozenAgent(
  store: ReturnType<typeof getConfigStore>,
  agentId: string,
): Promise<CustomAgentConfig> {
  try {
    const current = await store.getAgent(agentId);
    if (!current.enabled) throw new SealedAgentThreadError(agentId);
    return current;
  } catch (error) {
    if (error instanceof SealedAgentThreadError) throw error;
    throw new SealedAgentThreadError(agentId);
  }
}

function runtimeRepositoryMatches(
  current: RepositoryGrant,
  planned: RuntimePlanRepositoryV2,
): boolean {
  return current.enabled &&
    current.fullName.toLowerCase() === planned.fullName.toLowerCase() &&
    Boolean(current.allRepos) === Boolean(planned.allRepos);
}

function createRuntimePlanArtifactTool(plan: RuntimePlanV2) {
  let presenter: Promise<WebClientPresenter> | undefined;
  return createWorkspaceArtifactTool({
    channel: plan.artifactDestination.channelId,
    threadTs: plan.conversation.threadTs,
    async postArtifact(input) {
      presenter ??= (async () => {
        const env = await resolveAgentPlatformEnv();
        const config = getConfigStore(env);
        const [profile, installation, publicUrl] = await Promise.all([
          config.getAgent(plan.agentId),
          resolveSlackInstallationExecutionContext(
            plan.conversation.workspaceId,
            env,
            { config, settings: getSettingsStore(env) },
          ),
          resolveSlackPublicUrl(env).catch(() => undefined),
        ]);
        const agentAvatarUrl = agentAvatarUrlForPresentation(profile, publicUrl);
        return new WebClientPresenter(installation.client, {
          channelId: plan.conversation.channelId,
          threadTs: plan.conversation.threadTs,
          agentName: profile.name,
          ...(agentAvatarUrl
            ? { agentAvatarUrl }
            : {}),
          agentId: plan.agentId,
          workspaceId: plan.conversation.workspaceId,
        });
      })();
      return (await presenter).postArtifact(input);
    },
  });
}

export function thinkingLevelForModel(model: string): 'off' | undefined {
  const slash = model.indexOf('/');
  const provider = model.slice(0, slash);
  return slash > 0 &&
    (provider === 'cloudflare' || provider === 'cloudflare-workers-ai') &&
    isWorkersAiGlmModel(model.slice(slash + 1))
    ? 'off'
    : undefined;
}

interface AgentSandboxOptions {
  selection: SandboxSelection;
  fallback: SandboxFactory;
  env: PlatformEnv | undefined;
  conversationKey: string;
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
    return options.fallback;
  }
  const sandboxKey = sandboxThreadKey(options.conversationKey);
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
  return cloudflareSandbox(contentFreeSandboxExec(serialized), { cwd: '/workspace' });
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
