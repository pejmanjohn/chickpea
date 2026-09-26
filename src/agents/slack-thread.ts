'use agent';

import { apiOAuthLifecycleDependencies } from '../connections/api-oauth-lifecycle.ts';
import { SLACK_MEMORY_UPDATE_DATA_NAME, SlackMemoryUpdateSchema, type SlackMemoryUpdate } from '../slack/memory-update-terminal.ts';
import {
  CODING_WORKER_RUN_DATA_NAME,
  CODING_WORKER_USAGE_DATA_NAME,
  CodingWorkerRunSchema,
  CodingWorkerUsageSchema,
  WORKSPACE_MILESTONE_DATA_NAME,
  WorkspaceMilestoneSchema,
} from '../slack/coding-worker-run.ts';

import {
  bash,
  FlueError,
  type AgentProps,
  type SandboxFactory,
  useDataWriter,
  useDelivery,
  useInitialData,
  useInstruction,
  useMcpConnection,
  useModel,
  usePersistentState,
  useSandbox,
  useSkill,
  useTool,
} from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import * as v from 'valibot';

import {
  connectingActivityStatus,
  registerActivityContext,
  type ActivityToolDescriptor,
} from '../activity/status.ts';
import {
  activityStatus,
  genericSemanticDescriptor,
  semanticDescriptorForCoreTool,
} from '../activity/semantic.ts';
import {
  ApiOAuthError,
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
  createConnectorScopedBash,
  matchesEgressPrefix,
  type ResolvedApiConnection,
} from '../config/egress.ts';
import {
  getCachedInstallationToken,
  getGithubConnection,
  githubErrorStatus,
  isGithubAppManagedHost,
  type GithubConnection,
} from '../config/github-app.ts';
import {
  resolveRuntimePlanMcpConnections,
} from '../config/profile-mcp.ts';
import {
  projectMcpPolicyInstructions,
} from '../config/mcp-policy-instructions.ts';
import { isMetaAdsMcpConnection } from '../config/meta-ads-policy.ts';
import { resolveProfileSkills } from '../config/profile-skills.ts';
import {
  registerFrozenRuntimeModelRoute,
  resolveRuntimeModel,
} from '../config/runtime-model.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import { thinkingLevelForModel } from '../config/workers-ai-models.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import {
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
  getSlackCredentialResolutionDependencies,
  getSlackStateStore,
  getUsageStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  type ApiConnectionConfig,
  type CustomAgentConfig,
  type RepositoryGrant,
  type SkillConfig,
} from '../config/types.ts';
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
  resolveConnectionSecretForInvocation,
  resolveEffectiveConnectionAccounts,
  isActiveConnectionActor,
} from '../connections/runtime.ts';
import {
  useManagedConnectionTools,
} from '../connections/managed-tools.ts';
import { usePersonalConnectionAuthorizationSlackTool } from '../connections/slack-authorization.ts';

import type { SandboxCredentialMode } from '../sandbox/cloudflare-policy.ts';
import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  contentFreeSandboxExec,
} from '../sandbox/lifecycle.ts';
import {
  codingWorkspaceCapability,
  resolveCodingWorkspaceCapability,
  sandboxBindingInstalled,
} from '../sandbox/select.ts';
import { reserveMonthlySandboxSession } from '../sandbox/session-cap.ts';
import { currentWorkspaceRegistry, workspaceRegistryKey } from '../sandbox/workspace-registry.ts';
import { CODING_WORKSPACE_USE_DATA_NAME } from '../sandbox/workspace-use.ts';
import {
  DEFAULT_WORKSPACE_NAME,
  EMPTY_WORKSPACE_ROSTER,
  createWorkspaceRoster,
  defaultOnlyWorkspaceRoster,
  normalizeWorkspaceName,
  type WorkspaceRoster,
  type WorkspaceRosterState,
  type WorkspaceRosterStore,
} from '../sandbox/workspace-limits.ts';
import {
  WorkspaceSession,
  defaultWorkspaceId,
  workspaceIdFor,
  workspaceReservationId,
  type WorkspaceSandboxStub,
} from '../sandbox/workspace-session.ts';
import { createWorkspaceTools, type WorkspaceResolver } from '../sandbox/workspace-tools.ts';
import { SandboxUnavailableError } from '../sandbox/errors.ts';
import { reconnectingSandboxStub } from '../sandbox/reconnect.ts';
import {
  CHICKPEA_SUBMISSION_DURABILITY,
  WORKSPACE_TASK_INSTRUCTION,
  createRuntimePlanWorkspaceTaskTool,
  workspaceTaskRunning,
} from './coding-worker-task.ts';
import {
  buildArtifactToolsInstruction,
  createWorkspaceArtifactTool,
  type SlackArtifactStageInput,
  type SlackArtifactStageOutcome,
  type WorkspaceArtifactSource,
} from '../sandbox/artifact-tool.ts';
import {
  createImageArtifactTool,
  createRecoverImageTool,
  useImageCallBudget,
  type ImageCallReservation,
  type ImageClientResolution,
  type ImageToolTransport,
} from '../sandbox/image-tool.ts';
import { createImageOutputStore } from '../images/output-store.ts';
import { inspectImageOutput, type ImageInspectionInput } from '../images/inspect-output.ts';
import { answerScreenshotQuestion } from '../browser/look.ts';
import { createLazyBrowserProvider, useBrowserSession } from '../browser/runtime.ts';
import { recordBrowserSessionUsage, resolveBrowserSettings } from '../browser/settings.ts';
import { browserSkillForPlan } from '../browser/skill.ts';
import { listWebsiteLogins, websiteLoginDependencies } from '../browser/logins.ts';
import { createSlackRequesterNotifier, type SlackRequester } from '../browser/requester.ts';
import type { BrowserApprovalOptions } from '../browser/approval.ts';
import type { BrowserLoginOptions } from '../browser/binding.ts';
import { BROWSER_APPROVAL_ACTIVITY } from '../browser/messages.ts';
import { createBrowserTools, openRecordingDownload } from '../browser/tools.ts';
import { createRecordingHandleStore, resolveUploadFile } from '../connections/file-handles.ts';
import { buildConnectionAccess, type ConnectionAccess } from '../connections/access.ts';
import {
  CONNECTION_REQUEST_TIMEOUT_MS,
  createConnectionRequestTool,
  planAllowsConnectionRequests,
} from '../connections/request-tool.ts';
import {
  allowsConnectionFileUpload,
  ATTACH_FILE_TO_CONNECTION_TOOL_NAME,
  CONNECTION_UPLOAD_TIMEOUT_MS,
  planAllowsConnectionFileUpload,
  createAttachFileToConnectionTool,
  type ConnectionUploadFetch,
} from '../connections/file-upload-tool.ts';
import { BrowserTurnSession } from '../browser/turn-session.ts';
import { resolveModelApiKeyForStatelessCall } from '../config/provider-keys.ts';
import {
  CODING_WORKSPACE_INSTRUCTION,
  codingWorkspaceSkill,
} from '../sandbox/workspace-skill.ts';
import { publishActivityStatus } from '../slack/activity-publisher.ts';
import {
  bindCurrentRequestConversation,
  parseCurrentRequestEnvelope,
} from '../memory/tool-policy.ts';
import { useSlackAttachmentContext } from '../slack/attachment-context.ts';
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
import {
  createArtifactReceiptAccumulator,
  useSlackArtifactReceipts,
  type SlackArtifactReceipts,
} from '../slack/artifact-receipts.ts';
import { stageArtifactWithReceipt, reuseImageWithReceipt } from '../slack/artifact-staging.ts';
import { FILE_COMPLETION_INSTRUCTION, useFileDeliveryCompletion, type FileDeliveryCompletion } from '../slack/file-delivery-completion.ts';
import { createSlackAttachmentClient } from '../slack/attachment-client.ts';
import {
  buildThreadImageInventory,
  createThreadImageReader,
  parseThreadImageRecords,
  slackThreadImageConversationKey,
  type ThreadImageInventory,
  type ThreadImageRecord,
} from '../slack/thread-images.ts';
import { resolveAgentModelRoleFromStore } from '../config/model-policy.ts';
import { resolveImageProvider } from '../images/provider.ts';
import { createSlackFileTransport, type SlackFileTransport } from '../slack/file-transport.ts';
import { SLACK_LIST_TOOL_NAMES, useSlackListsTools } from '../slack/lists/tools.ts';
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
  compileWebsiteLogins,
  parseRuntimePlanV2,
  runtimePlanConversationKey,
  type RuntimePlanApiConnectionV2,
  type RuntimePlanRepositoryV2,
  type RuntimePlanV2,
  type RuntimePlanWebsiteLoginV1,
} from './runtime-plan.ts';
import {
  TurnEnvelopeContext,
  TurnSettingsView,
  type TurnEnvelopeAgentFacts,
} from './turn-envelope.ts';

bootstrapRuntimeProviders();

export { resolveAgentModel } from '../config/model-policy.ts';

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
    config: ConfigStore;
    settings?: SettingsStore;
    workspaceId: string;
    actorMembershipId: string;
  };
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
  const identity = accountContext ? getIdentityStore(env) : undefined;
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
                  ...apiOAuthLifecycleDependencies(
                    accountContext.config,
                    accountContext.settings ?? getSettingsStore(env),
                    accountContext.workspaceId,
                  ),
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
            ...(accountContext ? { authorize: async () => {
              if (!(await isActiveConnectionActor({ identity: identity!, workspaceId: accountContext.workspaceId, actorMembershipId: accountContext.actorMembershipId }))) return false;
              const current = projectEffectiveApiConnections(await resolveEffectiveConnectionAccounts({ ...accountContext, agentId }));
              const live = current.find(({ id }) => id === connection.id);
              // Credentials are resolved per session. Any policy change invalidates
              // its frozen delegate, including narrowing; rotation takes effect in
              // the next session. A revoked account disappears from this projection.
              return !!live && runtimeApiDeclarationStillAllowed(live, connection) &&
                runtimeApiDeclarationStillAllowed(connection, live);
            } } : {}),
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

/** Live authority can narrow a frozen plan but never expand or change its credential identity. */
export function runtimeApiDeclarationStillAllowed(
  live: ApiConnectionConfig | RuntimePlanApiConnectionV2,
  frozen: ApiConnectionConfig | RuntimePlanApiConnectionV2,
): boolean {
  const subset = (a: string[] = [], b: string[] = []) => a.every((value) => b.includes(value));
  return live.id === frozen.id &&
    (live.authMode ?? 'credential') === (frozen.authMode ?? 'credential') &&
    live.headerName.toLowerCase() === frozen.headerName.toLowerCase() &&
    (live.headerValuePrefix ?? '') === (frozen.headerValuePrefix ?? '') &&
    live.oauthProvider === frozen.oauthProvider &&
    subset(live.oauthScopes, frozen.oauthScopes) &&
    subset(live.allowedHosts.map((host) => host.toLowerCase()), frozen.allowedHosts.map((host) => host.toLowerCase())) &&
    subset(live.allowedMethods.map((method) => method.toUpperCase()), frozen.allowedMethods.map((method) => method.toUpperCase())) &&
    (live.pathPrefixes.length ? live.pathPrefixes : ['/']).every((path) =>
      (frozen.pathPrefixes.length ? frozen.pathPrefixes : ['/']).some((prefix) =>
        matchesEgressPrefix('https://policy.invalid' + path, 'https://policy.invalid' + prefix)));
}

async function resolveRuntimePlanApiConnections(plan: RuntimePlanV2, env?: PlatformEnv) {
  if (!plan.apiConnections.length || !plan.actorMembershipId) return [];
  const accountContext = { config: getConfigStore(env), settings: getSettingsStore(env), workspaceId: plan.conversation.workspaceId, actorMembershipId: plan.actorMembershipId };
  const current = projectEffectiveApiConnections(await resolveEffectiveConnectionAccounts({ ...accountContext, agentId: plan.agentId }));
  const connections = plan.apiConnections.flatMap((declaration) => {
    const live = current.find(({ id }) => id === declaration.id);
    if (!live || !runtimeApiDeclarationStillAllowed(live, declaration)) {
      console.warn(`[chickpea] API connection unavailable under frozen policy (${declaration.id})`);
      return [];
    }
    return [{ ...live, headerName: declaration.headerName, headerValuePrefix: declaration.headerValuePrefix ?? '' }];
  });
  return resolveApiConnectionsForTurn(plan.agentId, connections, env, { accountContext });
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
  const managementEnabled = !!parseSlackManagementSignal(delivery, plan);
  const turn = runtimePlanTurnContext(plan, delivery);
  useChickpeaSlackRuntimeCapabilities(
    plan,
    id,
    presentationIntent,
    writeTablePresentation,
    writeAgentCreationTerminal,
    managementEnabled,
    writeMemoryUpdate,
    slackDeliveryThreadImages(plan, delivery),
    turn,
  );
  useSlackAttachmentContext(
    plan,
    resolveAgentPlatformEnv,
    async (env) => plan.runtimeModel ?? (await prepareRuntimePlanModel(plan, env, turn)).model,
  );
  return plan.instructions;
}

/**
 * Register the exact main-turn capability set. A file upload no longer narrows
 * it: an upload turn runs with the same tools as any other message, on the
 * initial render and on the attachment-analysis re-render alike.
 */
export function useChickpeaSlackRuntimeCapabilities(
  plan: RuntimePlanV2,
  id: string,
  presentationIntent: ReturnType<typeof slackPresentationIntentCapability>,
  writeTablePresentation: (presentation: SlackTablePresentation) => void,
  writeAgentCreationTerminal: (intent: SlackAgentCreationTerminalIntent) => void,
  managementEnabled: boolean,
  writeMemoryUpdate?: (receipt: SlackMemoryUpdate) => void,
  threadImages?: readonly ThreadImageRecord[],
  turn?: TurnEnvelopeContext,
): void {
  useRuntimePlanAgent(plan, id, {
    responseMetadataModel: plan.model,
    ...(turn ? { turn } : {}),
    ...(threadImages?.length ? { threadImages } : {}),
    includeAgentAuthoringSkill: true,
    slackCapabilities: {
      slackListToolNames: managementEnabled && plan.actorMembershipId
        ? SLACK_LIST_TOOL_NAMES
        : [],
      workspaceManagementMounted: managementEnabled,
    },
    additionalActivityToolDescriptors: slackActivityToolDescriptors({
      plan,
      managementEnabled,
      ...(presentationIntent ? { presentationToolName: presentationIntent.tool.name } : {}),
      tablePresentationToolName: SLACK_PRESENT_TABLE_TOOL_NAME,
    }),
  });
  useAgentAuthoring();
  useWorkspaceManagementSlackTools(plan, resolveAgentPlatformEnv, writeAgentCreationTerminal, writeMemoryUpdate);
  usePersonalConnectionAuthorizationSlackTool(plan, resolveAgentPlatformEnv);
  useSlackListsTools(plan, resolveAgentPlatformEnv);
  useInstruction(SLACK_PRESENT_TABLE_INSTRUCTION);
  useTool(createSlackPresentTableTool(writeTablePresentation));
  if (presentationIntent) {
    useInstruction(presentationIntent.instruction);
    useTool(presentationIntent.tool);
  }
}

/**
 * This turn's thread images, recovered from the host-authored dispatch
 * attribute. The wire carries no conversation of its own: the frozen plan is
 * the only authority on which conversation these records belong to, and any
 * malformed attribute yields no inventory rather than a failed turn.
 */
export function slackDeliveryThreadImages(
  plan: RuntimePlanV2,
  delivery: ReturnType<typeof useDelivery>,
): ThreadImageRecord[] {
  return parseThreadImageRecords(
    delivery.kind === 'signal' ? delivery.attributes?.threadImages : undefined,
    slackThreadImageConversationKey({
      workspaceId: plan.conversation.workspaceId,
      channelId: plan.conversation.channelId,
      threadTs: plan.conversation.threadTs,
    }),
  );
}

/**
 * This Slack turn's settings envelope, frozen by the host when it prepared
 * the dispatch and fetched on first use. Only a Cloudflare Slack turn has
 * one: on Node the tools' stores are local, and a routine run has no TurnJob.
 */
export function runtimePlanTurnContext(
  plan: RuntimePlanV2,
  delivery: ReturnType<typeof useDelivery>,
): TurnEnvelopeContext | undefined {
  if (!isCloudflareTarget() || delivery.kind !== 'signal') return undefined;
  const turnJobId = delivery.attributes?.turnJobId;
  if (typeof turnJobId !== 'string' || turnJobId.length === 0 || turnJobId.length > 200) {
    return undefined;
  }
  return createTurnEnvelopeContext(turnJobId, plan.agentId);
}

/** A turn's envelope, fetched from the host by its TurnJob id (one read per turn). */
function createTurnEnvelopeContext(turnJobId: string, agentId: string): TurnEnvelopeContext {
  return new TurnEnvelopeContext(turnJobId, agentId, async (id) => {
    const env = await resolveAgentPlatformEnv();
    return getSlackStateStore(env).getTurnEnvelope?.(id);
  });
}

/** Declare only the connected-service accounts frozen into this execution plan. */
export function runtimePlanConnectedServicesInstruction(
  plan: Pick<
    RuntimePlanV2,
    'apiConnections' | 'mcpConnections' | 'managedConnections' | 'connectionChoices'
  > & Partial<Pick<RuntimePlanV2, 'repositories' | 'codingWorkspace'>>,
): string {
  const selected = [
    ...plan.apiConnections.map(({ id, displayName }) => ({
      kind: 'api' as const,
      id,
      name: displayName ?? id,
    })),
    ...plan.mcpConnections.map(({ id, displayName }) => ({
      kind: 'mcp' as const,
      id,
      name: displayName ?? id,
    })),
    ...(plan.managedConnections ?? []).map(({ id, toolkit }) => ({
      kind: 'managed' as const,
      id,
      name: toolkit,
    })),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  const pendingSelections = (plan.connectionChoices ?? []).map((choice) => ({
    providerId: choice.providerId,
    status: choice.choices.length > 0
      ? 'account_selection_required' as const
      : 'no_eligible_account' as const,
    ...(choice.previousAccountUnavailable ? { previousAccountUnavailable: true } : {}),
    choices: choice.choices.map(({ label, purpose, scope }) => ({
      label,
      ...(purpose ? { purpose } : {}),
      scope,
    })),
  })).sort((left, right) => left.providerId.localeCompare(right.providerId));
  const activeDeclaration = selected.length > 0 ? JSON.stringify(selected) : 'none';
  const pendingDeclaration = pendingSelections.length > 0
    ? JSON.stringify(pendingSelections)
    : 'none';
  return `Active connected-service access selected and configured for this turn: ${activeDeclaration}. ` +
    `Pending connected-service account selections: ${pendingDeclaration}. ` +
    'Providers marked account_selection_required are pending selection, not unavailable; ask the user to choose. ' +
    'Pending selections and setup or authorization options are not active tools or permissions. The active ' +
    'selection is the permission ceiling for connected-service actions in this turn, not a guarantee of remote ' +
    'service health; use only the connected tools or REST declarations actually mounted.' +
    runtimePlanRepositoriesDeclaration(plan);
}

/** Name frozen repository grants so the model does not guess at their absence. */
function runtimePlanRepositoriesDeclaration(
  plan: Partial<Pick<RuntimePlanV2, 'repositories' | 'codingWorkspace'>>,
): string {
  const repositories = plan.repositories ?? [];
  if (repositories.length === 0) return '';
  const names = JSON.stringify(
    [...new Set(repositories.map((repository) =>
      repository.allRepos
        ? `all repositories in ${runtimePlanRepositoryOwner(repository)}`
        : repository.fullName))].sort(),
  );
  const access = plan.codingWorkspace
    ? 'Use the GitHub REST recipes in the Repositories skill; GitHub credentials are injected automatically. ' +
      'Your own shell cannot clone them; for a real checkout, use the coding workspace tools (see the workspace skill).'
    : 'Use the GitHub REST recipes in the Repositories skill; GitHub credentials are injected automatically.';
  return ` Granted GitHub repositories for this turn: ${names}. ${access}`;
}

/** Declare the closed native Lists surface from the exact Slack mount decision. */
export function runtimePlanSlackCapabilitiesInstruction(input: {
  slackListToolNames: readonly (typeof SLACK_LIST_TOOL_NAMES)[number][];
  workspaceManagementMounted: boolean;
}): string {
  const listTools = input.slackListToolNames.length > 0
    ? JSON.stringify(input.slackListToolNames)
    : 'none';
  const listScope = input.slackListToolNames.length > 0
    ? 'This closed set has no action to delete a Slack task or whole List.'
    : 'No native Slack Lists action is available in this turn, including task or List deletion.';
  const managementScope = input.workspaceManagementMounted
    ? 'Workspace-management tools are also mounted, but they operate only within their typed ' +
      'Chickpea workspace-configuration and scheduled-routine scopes. Any deletion operation in ' +
      'those schemas applies only to the named Agent configuration or routine, never a Slack task ' +
      'or List. A proposal or approval cannot execute or unlock a native Slack Lists action.'
    : 'Workspace-management tools are not mounted for this turn.';
  return `Native Slack Lists action tools mounted for this turn (closed set): ${listTools}. ` +
    `${listScope} ${managementScope}`;
}

/**
 * Policy-only repository grants frozen into the plan. Installation tokens
 * resolve live at the egress boundary, never into skill text.
 */
function runtimePlanRepositoryGrants(
  plan: Pick<RuntimePlanV2, 'repositories'>,
): RepositoryGrant[] {
  return plan.repositories.map((repository) => ({
    id: repository.id,
    installationId: null,
    accountLogin: runtimePlanRepositoryOwner(repository),
    fullName: repository.fullName,
    ...(repository.allRepos ? { allRepos: true } : {}),
    enabled: true,
  }));
}

/**
 * An all-repositories grant names no repository, so its plan entry carries the
 * owner login; single-repository entries and older plans derive it from fullName.
 */
function runtimePlanRepositoryOwner(repository: RuntimePlanRepositoryV2): string {
  return repository.accountLogin ?? (repository.fullName.split('/', 1)[0] || repository.fullName);
}

/**
 * Mirror the legacy runtime's skill order: built-in connector skills (with the
 * Repositories skill for granted repositories) first so a same-named Agent
 * skill can deliberately override them, then Agent skills, then the
 * sandbox-derived workspace skill last so no stored Agent skill can hide it.
 */
export function runtimePlanSkills(
  plan: Pick<RuntimePlanV2, 'apiConnections' | 'repositories' | 'skills' | 'codingWorkspace' | 'browserCapability' | 'websiteLogins'>,
  options: { browser?: boolean } = {},
): ReturnType<typeof resolveProfileSkills> {
  const agentSkills = plan.skills.map((entry) => ({ ...entry, enabled: true }));
  // The Agent reaches its coding workspace through tools.
  const workspaceSkill = plan.codingWorkspace ? codingWorkspaceSkill() : undefined;
  // The browser skill rides with its tools, so it mounts only when the render
  // mounted them; like the workspace skill it comes last so a stored Agent
  // skill cannot hide it.
  const browserSkill = options.browser ? browserSkillForPlan(plan) : undefined;
  return resolveProfileSkills(
    [
      ...suppressProfileNamedConnectorSkills(
        connectorSkillsForConnections(plan.apiConnections, runtimePlanRepositoryGrants(plan)),
        agentSkills,
      ),
      ...agentSkills,
      ...(workspaceSkill ? [workspaceSkill] : []),
      ...(browserSkill ? [browserSkill] : []),
    ],
    { reservedNames: [AGENT_AUTHORING_SKILL_NAME] },
  );
}

/** Compose the declarations shared by Slack and fresh routine agents. */
export function useRuntimePlanAgent(
  plan: RuntimePlanV2,
  id: string,
  options: {
    responseMetadataModel?: string;
    sandboxConversationKey?: string;
    connectorUsageCorrelation?: import('../connections/managed-tools.ts').ManagedToolUsageCorrelation;
    artifactToolsDisabled?: boolean;
    includeAgentAuthoringSkill?: boolean;
    slackCapabilities?: {
      slackListToolNames: readonly (typeof SLACK_LIST_TOOL_NAMES)[number][];
      workspaceManagementMounted: boolean;
    };
    additionalActivityToolDescriptors?: readonly ActivityToolDescriptor[];
    /** Images already in this conversation, collected by the host fetch. */
    threadImages?: readonly ThreadImageRecord[];
    /**
     * Destroy a coding workspace this run opened when it settles, instead of
     * keeping it warm and checkpointed. Scheduled runs have no follow-up.
     */
    releaseCodingWorkspace?: boolean;
    /** This turn's frozen settings envelope; absent, tools read settings live. */
    turn?: TurnEnvelopeContext;
  } = {},
): void {
  const { accumulator: artifactAccumulator, writeReceipts: writeArtifactReceipts } = useSlackArtifactReceipts();
  const fileCompletion = useFileDeliveryCompletion(plan, (fileIds) => {
    writeArtifactReceipts({ schemaVersion: 1, receipts: artifactAccumulator.remove(fileIds) });
  }, !options.artifactToolsDisabled);
  const reserveImageCall = useImageCallBudget();
  const writeWorkspaceUse = useDataWriter(CODING_WORKSPACE_USE_DATA_NAME, {
    schema: v.object({ opened: v.literal(true) }),
  });
  const [workspaceRosterState, updateWorkspaceRoster] = usePersistentState<WorkspaceRosterState>(
    CODING_WORKSPACE_ROSTER_STATE_NAME,
    EMPTY_WORKSPACE_ROSTER,
  );
  const workspaceRoster = createWorkspaceRoster(
    workspaceRosterState,
    updateWorkspaceRoster,
    Date.now,
    runtimePlanWorkspaceRosterStore(plan, options.sandboxConversationKey),
  );
  const resolveWorkspace = runtimePlanWorkspaceResolver(plan, {
    ...(options.sandboxConversationKey ? { sandboxConversationKey: options.sandboxConversationKey } : {}),
    release: options.releaseCodingWorkspace === true,
    turnId: runtimePlanWorkspaceTurnId(),
    onOpen: () => writeWorkspaceUse({ opened: true }),
    roster: workspaceRoster,
    ...(options.turn ? { turn: options.turn } : {}),
  });
  // A connected browser mounts with the artifact tools, whose staging carries
  // its proof: the session, skill, tools, and activity all follow this one
  // predicate.
  const browserMounted = plan.browserCapability !== undefined &&
    !options.artifactToolsDisabled && !fileCompletion.repairing;
  // The delivery gate compares a re-stamped attachment-context envelope against
  // the host-owned conversation. Only the frozen plan can supply it.
  bindCurrentRequestConversation({
    workspaceId: plan.conversation.workspaceId,
    channelId: plan.conversation.channelId,
    threadTs: plan.conversation.threadTs,
  });
  registerActivityContext(id, buildRuntimePlanActivityContext(plan, {
    ...(options.includeAgentAuthoringSkill === undefined
      ? {}
      : { includeAgentAuthoringSkill: options.includeAgentAuthoringSkill }),
    reservedToolNames: [AGENT_AUTHORING_SKILL_NAME],
    browserMounted,
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
  useInstruction(runtimePlanConnectedServicesInstruction(plan));
  if (options.slackCapabilities) {
    useInstruction(runtimePlanSlackCapabilitiesInstruction(options.slackCapabilities));
  }
  useInstruction('Sandbox files are temporary working data, not durable Agent memory. They do not follow this Agent into a fresh conversation. A successful file or shell write cannot establish that a fact was remembered. Never promise future recall from a sandbox file.');
  if (plan.codingWorkspace && isCloudflareTarget() && !fileCompletion.repairing) {
    useInstruction(CODING_WORKSPACE_INSTRUCTION);
  }
  useInstruction('This virtual sandbox starts with a fresh filesystem for each new request, including a follow-up in the same Slack thread. Files from an earlier request are gone. When the current user asks to return or revise those files, recreate them from the available contents in this request before attaching them; do not assume an earlier path still exists. The internal file-delivery check continues the current request and may only read and export existing files.');
  useInstruction(SLACK_ACTION_LINK_INSTRUCTION);
  useInstruction('The final Slack answer must be self-contained. Earlier assistant steps are working narration. After an interrupted response, write the complete final answer again, not just the remaining words of the partial response.');
  useManagedConnectionTools(
    plan,
    resolveAgentPlatformEnv,
    options.connectorUsageCorrelation,
    [AGENT_AUTHORING_SKILL_NAME],
  );
  // Not an artifact tool: an old routine occurrence without a file
  // destination still calls its connections. Only a file-delivery repair,
  // which may not use connections, goes without.
  if (runtimePlanAllowsConnectionRequests(plan) && !fileCompletion.repairing) {
    useTool(createRuntimePlanConnectionRequestTool(plan));
    useInstruction([
      'API connections are declared for this turn. Call them with the connection_request tool, within the listed hosts, path prefixes, and methods, and report the service\'s answer including error messages. Credentials are added automatically; never supply, retrieve, or print authentication headers or credential values. The shell cannot reach these services.',
      'These declarations describe the frozen permission ceiling, not a guarantee of availability. The runtime rechecks current account authority on every request; if access is denied or unavailable, report that result without bypassing it or claiming success.',
      JSON.stringify(plan.apiConnections.map(({ id, displayName, allowedHosts, pathPrefixes, allowedMethods }) => ({ id, displayName, allowedHosts, pathPrefixes, allowedMethods }))),
    ].join('\n'));
  }
  const browserSession = browserMounted ? useBrowserSession(id, createRuntimePlanBrowserSession) : undefined;
  // The delivery's verified Slack signal, parsed once for the two uses below.
  const browserSignal = browserSession && plan.websiteLogins?.length
    ? runtimePlanSlackSignal(plan)
    : undefined;
  // A sign-in hand-off link goes privately to the verified Slack requester;
  // a turn without one (a scheduled run) cannot hand off.
  const browserRequester = browserSignal ? runtimePlanBrowserRequester(browserSignal) : undefined;
  // Data-changing steps on a login granted `act` wait for the verified Slack
  // requester's "approve"; a turn without one (a scheduled run) cannot ask.
  const browserApprovals = browserSignal && plan.websiteLogins?.some(({ level }) => level === 'act')
    ? runtimePlanBrowserApprovals(plan, browserSignal, () => {
        const [kind, action, object] = BROWSER_APPROVAL_ACTIVITY;
        publishActivityStatus(id, activityStatus(kind, action, object));
      })
    : undefined;
  for (const skill of runtimePlanSkills(plan, { browser: browserMounted })) {
    useSkill(skill);
  }
  const { restrictions, metaHelperScopes, metaWriteScopes } = projectMcpPolicyInstructions(plan.mcpConnections);
  if (restrictions.length > 0) {
    useInstruction(`The owner restricts these connection tool inputs. Use only the listed values; do not retry disallowed inputs: ${JSON.stringify(restrictions)}`);
  }
  if (metaHelperScopes.length > 0) {
    useInstruction(`The owner selected these Meta Ads helper tools with an approved-account scope: ${JSON.stringify(metaHelperScopes)}. The scope is enforced by Chickpea policy and is not a provider input. Do not invent or send an ad-account argument. Use only helper metadata inputs declared by the tool, including reporting field names when requested. Account discovery returns only approved accounts; field context provides global reporting-field metadata.`);
  }
  if (metaWriteScopes.length > 0) {
    useInstruction(`The owner restricts these Meta Ads audience tools to the listed ad accounts: ${JSON.stringify(metaWriteScopes)}. Chickpea verifies the target audience's owner before sending changes. This account scope is internal policy, not a provider input. Supply the actual audience ID using the tool's declared schema; do not invent an ad-account argument.`);
  }
  if (plan.mcpConnections.some(isMetaAdsMcpConnection)) {
    useInstruction('For Meta Ads replies, use campaign and ad-account names as the primary identifiers. Include IDs only when the user asks for them or when needed to distinguish entities with the same name. Format these names and IDs as ordinary text or bold text, not inline code. Describe outcomes in user language. Do not mention tool names or actions that were not taken unless the user asks. If a requested write fails or makes no change, say so plainly and do not imply success.');
  }
  if (plan.mcpConnections.some((connection) => isMetaAdsMcpConnection(connection) && connection.writeTools?.length)) {
    useInstruction('Selected Meta Ads write tools can change ads and audiences. Use them only for changes the user requested. Before activating ads or increasing spend, establish the exact ad account, entities, and budget the user authorized; ask for missing authorization. Campaign, ad set, and ad creation leave them paused. Activation starts spending; do not activate merely because creation succeeded. For ads_update_entity, include only fields the user requested and preserve the existing status during budget, name, targeting, or other ordinary edits. Never pause an entity to stage another edit. If the user explicitly requests a pause, make it a separate status-only update. After a successful entity write, read back both the requested values and status before reporting success. If the status changed unexpectedly, report it and do not automatically reactivate. Do not retry an uncertain write blindly: first read back whether it already happened.');
  }
  for (const connection of resolveRuntimePlanMcpConnections(
    plan.agentId,
    plan.mcpConnections,
    () => {
      publishActivityStatus(id, connectingActivityStatus('a connected service'));
    },
    plan.actorMembershipId ? { workspaceId: plan.conversation.workspaceId, actorMembershipId: plan.actorMembershipId } : undefined,
  )) {
    useMcpConnection(connection);
  }
  const sandbox = createRuntimePlanSandbox(plan, options.turn);
  useSandbox(options.artifactToolsDisabled ? sandbox : fileCompletion.wrapSandbox(sandbox));
  const writeCodingWorkerRun = useDataWriter(CODING_WORKER_RUN_DATA_NAME, { schema: CodingWorkerRunSchema });
  const writeCodingWorkerUsage = useDataWriter(CODING_WORKER_USAGE_DATA_NAME, {
    schema: CodingWorkerUsageSchema,
  });
  const writeWorkspaceMilestone = useDataWriter(WORKSPACE_MILESTONE_DATA_NAME, {
    schema: WorkspaceMilestoneSchema,
  });
  const workspaceToolsMounted = runtimePlanWorkspaceToolsMounted(plan, fileCompletion.repairing);
  if (workspaceToolsMounted) {
    for (const tool of createWorkspaceTools({
      resolve: resolveWorkspace,
      roster: workspaceRoster,
      taskRunning: workspaceTaskRunning,
    })) {
      useTool(tool);
    }
    useTool(createRuntimePlanWorkspaceTaskTool({
      plan,
      coordinatorId: id,
      resolve: resolveWorkspace,
      onWorkerStarted: writeCodingWorkerRun,
      onWorkerUsage: writeCodingWorkerUsage,
      onMilestone: writeWorkspaceMilestone,
    }));
    useInstruction(WORKSPACE_TASK_INSTRUCTION);
  }
  if (!options.artifactToolsDisabled) {
    // Built once per render: the tool resolves `img:N` handles against this
    // inventory, and `imageInventory.manifest` is the model-facing listing
    // the artifact-tools instruction renders beside the tool description.
    const imageInventory = runtimePlanThreadImageInventory(plan, options.threadImages);
    for (const tool of createRuntimePlanArtifactTools(
      plan,
      artifactAccumulator,
      writeArtifactReceipts,
      {
        imageInventory,
        reserveImageCall,
        fileCompletion,
        resolveWorkspace,
        ...(browserSession ? { browserSession } : {}),
        ...(browserRequester ? { browserRequester } : {}),
        ...(browserApprovals ? { browserApprovals } : {}),
        ...(options.turn ? { turn: options.turn } : {}),
      },
    )) {
      useTool(tool);
    }
    if (!fileCompletion.repairing) {
      useInstruction(buildArtifactToolsInstruction({
        imageTool: plan.imageCapability?.filled === true,
        canEdit: plan.imageCapability?.acceptsImageInput === true,
        ...(imageInventory.manifest ? { imageManifest: imageInventory.manifest } : {}),
      }));
      // Without an image model the artifact instruction lists no images, but
      // the upload tool still takes a conversation image by its handle.
      if (plan.imageCapability?.filled !== true && imageInventory.manifest &&
          runtimePlanAllowsConnectionFileUpload(plan)) {
        useInstruction(`To send one of these images to a connection, pass its handle to \`${ATTACH_FILE_TO_CONNECTION_TOOL_NAME}\`. Images already in this conversation:\n${imageInventory.manifest}`);
      }
    }
    useInstruction(FILE_COMPLETION_INSTRUCTION);
    if (fileCompletion.repairing) {
      useInstruction('This is an export-only file delivery repair. Only read, glob, grep, post_artifact, complete_file_delivery and final presentation tools can execute. Do not run shell commands, change files, use connections, or generate anything again.');
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
    descriptors.push(...SLACK_LIST_TOOL_NAMES.map(toolName => ({ toolName, descriptor: semanticDescriptorForCoreTool(toolName) })));
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
ChickpeaSlack.durability = CHICKPEA_SUBMISSION_DURABILITY;
ChickpeaSlack.initialData = v.custom<RuntimePlanV2>((value) => {
  try {
    parseRuntimePlanV2(value);
    return true;
  } catch {
    return false;
  }
}, 'RuntimePlanV2 is invalid.');

/**
 * The coding-workspace tools mount when the plan has the coding-workspace
 * capability. Only the Cloudflare target has one, and an export-only file
 * repair may not change or run anything in it.
 */
export function runtimePlanWorkspaceToolsMounted(
  plan: Pick<RuntimePlanV2, 'codingWorkspace'>,
  repairing: boolean,
): boolean {
  return plan.codingWorkspace !== undefined && isCloudflareTarget() && !repairing;
}

/** Persistent coordinator state: the thread's workspace names, open set, and retirements. */
export const CODING_WORKSPACE_ROSTER_STATE_NAME = 'codingWorkspaceRoster';

/**
 * The roster's durable copy, in the conversation's default Sandbox Durable
 * Object. The coordinator's persistent state belongs to one Flue instance,
 * and a changed harness revision (an Agent edit, a coding model change,
 * another actor) addresses a new one that starts empty; without this copy
 * the thread would forget its workspaces, its open set, and its retirement
 * generations. Keyed by the conversation's continuity key (thread plus owner
 * incarnation) and Agent: exactly the instance id without the revision.
 * Only the Cloudflare target has coding workspaces.
 */
function runtimePlanWorkspaceRosterStore(
  plan: RuntimePlanV2,
  sandboxConversationKey: string | undefined,
): WorkspaceRosterStore | undefined {
  if (!plan.codingWorkspace || !isCloudflareTarget()) return undefined;
  const rosterKey = `${plan.conversation.continuityKey}:${plan.agentId}`;
  const stub = reconnectingSandboxStub(async (): Promise<WorkspaceRosterStub> => {
    const env = await resolveAgentPlatformEnv();
    const binding = env?.SANDBOX ?? env?.Sandbox;
    if (!binding) throw new Error('No Sandbox binding');
    const { getSandbox } = await import('@cloudflare/sandbox');
    return getSandbox(
      binding as Parameters<typeof getSandbox>[0],
      defaultWorkspaceId(sandboxConversationKey ?? runtimePlanConversationKey(plan)),
      CLOUDFLARE_SANDBOX_OPTIONS,
    ) as unknown as WorkspaceRosterStub;
  });
  const unavailable = (error: unknown): never => {
    if (error instanceof FlueError) throw error;
    throw new SandboxUnavailableError(error);
  };
  return {
    load: () => stub.readWorkspaceRoster(rosterKey).catch(unavailable),
    save: (state, forget) => stub.saveWorkspaceRoster(rosterKey, state, [...forget]).catch(unavailable),
  };
}

interface WorkspaceRosterStub {
  readWorkspaceRoster(key: string): Promise<unknown>;
  saveWorkspaceRoster(key: string, state: WorkspaceRosterState, forget: string[]): Promise<void>;
}

/**
 * How the workspace tools find a workspace this submission. The session is
 * created on the first tool call; it prepares and ends its own workspace
 * turn, so a submission that never calls a workspace tool touches no Sandbox
 * Durable Object at all.
 */
interface RuntimePlanWorkspaceInput {
  sandboxConversationKey?: string;
  /** Destroy the workspace when the run settles instead of keeping it warm. */
  release: boolean;
  turnId?: string | undefined;
  onOpen?: () => void;
  /** The thread's workspace names; only the default workspace without one. */
  roster?: WorkspaceRoster;
  /** This turn's frozen settings envelope. */
  turn?: TurnEnvelopeContext;
}

export function runtimePlanWorkspaceResolver(
  plan: RuntimePlanV2,
  input: RuntimePlanWorkspaceInput,
): WorkspaceResolver {
  const roster = input.roster ?? defaultOnlyWorkspaceRoster();
  return async (name, access) => {
    const registry = currentWorkspaceRegistry();
    if (!registry) return undefined;
    await roster.ready();
    // Inspecting never brings a workspace into being: a name the thread has
    // never used has nothing to read or close.
    if (access === 'inspect' && !roster.knows(name)) return undefined;
    const before = roster.snapshot().workspaces[name];
    // A use opens the name (refused past the open cap); either way the
    // name's current retirement generation picks its workspace id.
    const generation = access === 'use' ? roster.admit(name) : roster.generation(name);
    const created = registry.resolve(
      workspaceRegistryKey(name, generation),
      () => createRuntimePlanWorkspace(plan, name, generation, input),
    );
    if (access === 'inspect') return created;
    if (before?.open) {
      await roster.flush();
      return created;
    }
    // A newly opened workspace that never came up must not hold a slot.
    const session = await created.catch(async (error: unknown) => {
      roster.restore(name, before);
      await roster.flush().catch(() => {});
      throw error;
    });
    if (!session) roster.restore(name, before);
    await roster.flush();
    return session;
  };
}

/**
 * The durable turn this submission binds a workspace to: the Slack TurnJob or
 * the routine occurrence, both host-authored signal attributes. The relay
 * reads pull-request progress back under the same id when it retries.
 */
function runtimePlanWorkspaceTurnId(): string | undefined {
  try {
    const delivery = useDelivery();
    if (delivery.kind !== 'signal') return undefined;
    const attributes = delivery.attributes ?? {};
    const turnId = attributes.turnJobId ?? attributes.occurrenceId;
    return typeof turnId === 'string' && turnId.length > 0 && turnId.length <= 200
      ? turnId
      : undefined;
  } catch {
    return undefined;
  }
}

async function createRuntimePlanWorkspace(
  plan: RuntimePlanV2,
  name: string,
  generation: number,
  input: RuntimePlanWorkspaceInput,
): Promise<{ session: WorkspaceSession; end: () => Promise<void> } | undefined> {
  if (!isCloudflareTarget() || !plan.codingWorkspace) {
    return undefined;
  }
  try {
    const env = await resolveAgentPlatformEnv();
    const binding = env?.SANDBOX ?? env?.Sandbox;
    if (!binding) return undefined;
    const settingsStore = getSettingsStore(env);
    const current = await requireTurnAgent(plan, env, input.turn);
    const repositories = liveRuntimePlanRepositories(plan, current);
    const { sandboxSettings, githubAppConnected } = await runtimePlanWorkspaceFacts(
      settingsStore,
      input.turn,
    );
    // Settings as of this turn's dispatch win over the capability frozen at
    // admission: a workspace disabled or disconnected since is unavailable.
    if (codingWorkspaceCapability({
      target: 'cloudflare',
      installed: true,
      enabled: sandboxSettings.enabled,
      appConnected: githubAppConnected,
      repositoryGrants: repositories,
    }) !== 'available') return undefined;
    const access = await resolveSandboxScopedRepositoryAccess({
      repositories,
      ...(env ? { env } : {}),
      unavailableFallback: false,
    });
    const session = await createCloudflareWorkspaceSession({
      binding,
      conversationKey: input.sandboxConversationKey ?? runtimePlanConversationKey(plan),
      name,
      generation,
      agentId: plan.agentId,
      grants: access.grants,
      ...(access.credentialMode ? { credentialMode: access.credentialMode } : {}),
      turnId: input.turnId ?? `workspace_${crypto.randomUUID()}`,
      ...(input.onOpen ? { onOpen: input.onOpen } : {}),
      settingsStore,
      monthlySessionCap: sandboxSettings.monthlySessionCap,
    });
    return {
      session: session.session,
      // Only a workspace this submission bound to its turn has a turn to end.
      end: async () => {
        if (!session.session.wasOpened) return;
        // Retried on a fresh stub if the Sandbox DO instance was replaced
        // during the turn: both calls are safe to repeat.
        const stub = reconnectingSandboxStub(session.mintStub);
        if (input.release) await stub.destroy();
        else await stub.endTurn();
      },
    };
  } catch (error) {
    if (error instanceof FlueError) throw error;
    throw new SandboxUnavailableError(error);
  }
}

function createRuntimePlanSandbox(
  plan: RuntimePlanV2,
  turn?: TurnEnvelopeContext,
): SandboxFactory {
  return {
    async createSandbox(options) {
      const env = await resolveAgentPlatformEnv();
      await prepareRuntimePlanModel(plan, env, turn);
      // Native plans grant only their frozen connector scopes; operator-wide
      // egress settings never become an incidental grant. Empty plans need no
      // account or egress setting reads.
      if (!plan.repositories.length) {
        return bash(() => new Bash({ fs: new InMemoryFs() })).createSandbox(options);
      }
      // API connections are called through connection_request, never the
      // shell; the sandbox mounts only repository scopes.
      const repositoryAccess = await resolveRuntimePlanBashRepositoryAccess(plan, env, turn);
      const sandbox = createConnectorScopedBash(
        { mode: 'allowlist', domains: [] }, isCloudflareTarget(),
        repositoryAccess.connectors,
      );
      return sandbox.createSandbox(options);
    },
  };
}

/**
 * Resolve GitHub App credentials for a bash-mode plan's frozen repository
 * grants, as the legacy runtime does for bash turns. Live revocations win, and
 * a configured Cloudflare workspace whose binding is missing fails closed.
 */
export async function resolveRuntimePlanBashRepositoryAccess(
  plan: RuntimePlanV2,
  env: PlatformEnv | undefined,
  turn?: TurnEnvelopeContext,
): Promise<ResolvedRepositoryAccess> {
  if (!plan.repositories.length) {
    return { grants: [], connectors: [], governsGithubHosts: false };
  }
  const current = await requireTurnAgent(plan, env, turn);
  const repositories = liveRuntimePlanRepositories(plan, current);
  let unavailableFallback = false;
  if (isCloudflareTarget()) {
    const { sandboxSettings, githubAppConnected } = await runtimePlanWorkspaceFacts(
      getSettingsStore(env),
      turn,
    );
    unavailableFallback = resolveCodingWorkspaceCapability({
      target: 'cloudflare',
      installed: sandboxBindingInstalled(env),
      enabled: sandboxSettings.enabled,
      appConnected: githubAppConnected,
      repositoryGrants: repositories,
    }).unavailableFallback;
  }
  return resolveSandboxScopedRepositoryAccess({
    repositories,
    ...(env ? { env } : {}),
    unavailableFallback,
  });
}

/**
 * Bind the frozen model lane before any model call. With a turn envelope the
 * work runs once per turn render and later callers (image and screenshot
 * checks, attachment analysis) share it.
 */
export async function prepareRuntimePlanModel(
  plan: RuntimePlanV2,
  env: PlatformEnv | undefined,
  turn?: TurnEnvelopeContext,
) {
  if (!turn) return prepareRuntimePlanModelOnce(plan, env);
  return turn.memo('runtime-model', () => prepareRuntimePlanModelOnce(plan, env, turn));
}

async function prepareRuntimePlanModelOnce(
  plan: RuntimePlanV2,
  env: PlatformEnv | undefined,
  turn?: TurnEnvelopeContext,
) {
  // Runtime plans freeze behavior, but they do not preserve execution
  // authority after an Agent is disabled or archived.
  await requireTurnAgent(plan, env, turn);
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
  // The provider key itself is always read live; only non-secret routing
  // settings come from the turn envelope.
  const resolved = await withTurnSettings(turn, settings, (turnSettings) =>
    resolveRuntimeModel(plan.agentId, plan.model, {
      settings: turnSettings,
      ...(env ? { env } : {}),
    }));
  if (plan.runtimeModel && resolved.model !== plan.runtimeModel) {
    throw new Error('Runtime model route changed after this Slack turn was admitted.');
  }
  return resolved;
}

function liveRuntimePlanRepositories(
  plan: RuntimePlanV2,
  current: Pick<CustomAgentConfig, 'repositories'>,
): RepositoryGrant[] {
  return plan.repositories.map((declaration) => {
    const live = current.repositories.find((candidate) =>
      candidate.id === declaration.id && runtimeRepositoryMatches(candidate, declaration)
    );
    if (!live) throw new Error('RuntimePlanV2 repository policy changed.');
    return live;
  });
}

/**
 * The Agent's execution authority for this turn: as of dispatch when the
 * turn has an envelope (a disable or archive takes effect at the next
 * dispatch), otherwise read live.
 */
async function requireTurnAgent(
  plan: Pick<RuntimePlanV2, 'agentId'>,
  env: PlatformEnv | undefined,
  turn?: TurnEnvelopeContext,
): Promise<TurnEnvelopeAgentFacts> {
  const envelope = await turn?.envelope();
  if (!envelope) return requireLiveFrozenAgent(getConfigStore(env), plan.agentId);
  if (!envelope.agent?.enabled) throw new SealedAgentThreadError(plan.agentId);
  return envelope.agent;
}

/** Run a settings read against this turn's envelope view, or live without one. */
function withTurnSettings<T>(
  turn: TurnEnvelopeContext | undefined,
  live: SettingsStore,
  operation: (settings: SettingsStore) => Promise<T>,
): Promise<T> {
  return turn ? turn.withSettings(live, operation) : operation(live);
}

/** Sandbox settings and GitHub App presence for opening a coding workspace. */
async function runtimePlanWorkspaceFacts(
  live: SettingsStore,
  turn: TurnEnvelopeContext | undefined,
): Promise<{
  sandboxSettings: Awaited<ReturnType<typeof resolveSandboxSettings>>;
  githubAppConnected: boolean;
}> {
  const envelope = await turn?.envelope();
  const [sandboxSettings, githubAppConnected] = await Promise.all([
    resolveSandboxSettings(envelope ? new TurnSettingsView(live, envelope) : live),
    envelope
      ? envelope.githubAppConnected
      : getGithubConnection(live).then(
          (connection) => connection.mode === 'app',
          () => false,
        ),
  ]);
  return { sandboxSettings, githubAppConnected };
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

export function runtimeRepositoryMatches(
  current: RepositoryGrant,
  planned: RuntimePlanRepositoryV2,
): boolean {
  if (!current.enabled || Boolean(current.allRepos) !== Boolean(planned.allRepos)) return false;
  // An all-repositories grant names no repository; its owner is the policy.
  if (planned.allRepos && planned.accountLogin !== undefined) {
    return current.accountLogin.toLowerCase() === planned.accountLogin.toLowerCase();
  }
  return current.fullName.toLowerCase() === planned.fullName.toLowerCase();
}

/**
 * Destination-bound artifact staging for hook-mounted runtime plans.
 * Files follow the frozen artifact destination, not the conversation key: a
 * scheduled run's conversation thread is a synthetic due-time stamp and a DM
 * session key is `dm`, neither of which Slack accepts as thread_ts. Staging
 * uploads bytes only; the host completes the upload with the final reply so
 * the file carries the Agent's identity and text in one message.
 */
export function createRuntimePlanArtifactTools(
  plan: RuntimePlanV2,
  accumulator: ReturnType<typeof createArtifactReceiptAccumulator>,
  writeArtifactReceipts: (receipts: SlackArtifactReceipts) => void,
  options: RuntimePlanArtifactToolOptions = {},
) {
  let transport: Promise<SlackFileTransport> | undefined;
  let installationClient: Promise<SlackInstallationClient> | undefined;
  const destination = {
    workspaceId: plan.conversation.workspaceId,
    agentId: plan.agentId,
    channelId: plan.artifactDestination.channelId,
    ...(plan.artifactDestination.threadTs ? { threadTs: plan.artifactDestination.threadTs } : {}),
  };
  const resolveInstallationClient = (): Promise<SlackInstallationClient> => {
    installationClient ??= (async () => {
      const env = await resolveAgentPlatformEnv();
      const installation = await resolveSlackInstallationExecutionContext(
        plan.conversation.workspaceId,
        env,
        {
          config: getConfigStore(env),
          settings: getSettingsStore(env),
          credentialDependencies: getSlackCredentialResolutionDependencies(env),
        },
      );
      return installation.client;
    })();
    // A failed resolve is retried by the next caller.
    installationClient.catch(() => {
      installationClient = undefined;
    });
    return installationClient;
  };
  const resolveFileTransport = (): Promise<SlackFileTransport> => {
    transport ??= (async () => createSlackFileTransport(await resolveInstallationClient()))();
    return transport;
  };
  const binding = {
    channel: destination.channelId,
    ...(destination.threadTs ? { threadTs: destination.threadTs } : {}),
    /**
     * The installation's upload cap, memoized beside staging. The image tool
     * awaits it before it can choose an output format; nothing else
     * distinguishes the direct and gateway transports up front.
     */
    resolveTransport: async (): Promise<ImageToolTransport> => resolveFileTransport(),
    async stageArtifact(artifact: SlackArtifactStageInput): Promise<SlackArtifactStageOutcome> {
      options.fileCompletion?.noteStagingAttempted();
      let fileId: string | undefined;
      const outcome = await stageArtifactWithReceipt({
        transport: await resolveFileTransport(),
        artifact,
        destination,
        accumulator,
        writeReceipts: writeArtifactReceipts,
        ...(options.fileCompletion ? { onReceipt: (receipt: { fileId: string }) => { fileId = receipt.fileId; } } : {}),
      });
      return outcome.attached && fileId ? { ...outcome, fileId } : outcome;
    },
  };
  // Only a plan whose image role resolved to a credentialed model carries the
  // image tool. The legacy assembler posts with app identity and keeps no
  // receipts, so it never mounts it.
  const reserveImageCall = options.reserveImageCall;
  const imageCapability = plan.imageCapability;
  let outputStore: ReturnType<typeof createImageOutputStore> | undefined;
  const resolveOutputStore = async () => outputStore ??= createImageOutputStore(
    getSettingsStore(await resolveAgentPlatformEnv()), destination,
  );
  // Recordings and screenshots share the image store's destination scope, so
  // a handle never resolves in another thread or for another Agent.
  let recordingStore: ReturnType<typeof createRecordingHandleStore> | undefined;
  const resolveRecordingStore = async () => recordingStore ??= createRecordingHandleStore(
    getSettingsStore(await resolveAgentPlatformEnv()), destination,
  );
  const imageInventory = options.imageInventory ?? runtimePlanThreadImageInventory(plan, options.threadImages);
  const imageOptions = imageCapability?.filled && reserveImageCall ? {
    acceptsImageInput: imageCapability.acceptsImageInput,
    ...(imageCapability.maxOutputsPerCall === undefined ? {} : {
      maxOutputsPerCall: imageCapability.maxOutputsPerCall,
    }),
    ...(imageCapability.supportsOutputControls === undefined ? {} : {
      supportsOutputControls: imageCapability.supportsOutputControls,
    }),
    inventory: imageInventory,
    reserveImageCall,
    resolveTransport: binding.resolveTransport,
    resolveClient: options.resolveImageClient ?? (() => resolveRuntimePlanImageClient(plan, options.turn)),
    inspectOutput: async (input: ImageInspectionInput) => {
      try {
        const env = await resolveAgentPlatformEnv();
        const model = await prepareRuntimePlanModel(plan, env, options.turn);
        const apiKey = await resolveModelApiKeyForStatelessCall(plan.model, env, getSettingsStore(env));
        return await inspectImageOutput(model.model, input, apiKey);
      } catch {
        return { status: 'unavailable' as const, observations: 'Visual inspection is unavailable with the configured chat model.' };
      }
    },
    outputStore: {
      save: async (bytes: Uint8Array, metadata: Record<string, unknown>) => (await resolveOutputStore()).save(bytes, metadata),
      read: async (id: string) => (await resolveOutputStore()).read(id),
      remove: async (id: string) => (await resolveOutputStore()).remove(id),
    },
    createImageReader: async (limits: { perFileLimitBytes: number; totalLimitBytes: number; signal?: AbortSignal }) => {
      const env = await resolveAgentPlatformEnv();
      return createThreadImageReader({ client: createSlackAttachmentClient(env), ...limits });
    },
    stageArtifact: binding.stageArtifact,
    reuseImage: async (input: { record: ThreadImageRecord; filename: string; byteLength: number }) =>
      reuseImageWithReceipt({ ...input, destination, accumulator, writeReceipts: writeArtifactReceipts }),
  } : undefined;
  // The render owns the response's browser session and supplies it only when
  // the browser is mounted, like the image quota above.
  const browserSession = plan.browserCapability && !options.fileCompletion?.repairing
    ? options.browserSession
    : undefined;
  const websiteLogins = plan.websiteLogins ?? [];
  const requester = options.browserRequester;
  const browserTools = browserSession
    ? createBrowserTools({
        session: browserSession,
        ...(websiteLogins.length > 0 ? { logins: runtimePlanBrowserLogins(plan, websiteLogins) } : {}),
        ...(requester && websiteLogins.length > 0
          ? {
              notifyRequester: createSlackRequesterNotifier({
                requester,
                surface: plan.conversation.surface,
                ...(plan.artifactDestination.threadTs ? { threadTs: plan.artifactDestination.threadTs } : {}),
                client: async () => {
                  const client = await resolveInstallationClient();
                  return {
                    postMessage: (args) => client.chat.postMessage(args as never),
                    postEphemeral: (args) => client.chat.postEphemeral(args as never),
                  };
                },
              }),
            }
          : {}),
        ...(options.browserApprovals ? { approvals: options.browserApprovals } : {}),
        stageArtifact: binding.stageArtifact,
        retainScreenshot: async (bytes) =>
          (await resolveOutputStore()).save(bytes, { format: 'png', source: 'browser_screenshot' }),
        retainRecording: async (input) => (await resolveRecordingStore()).save(input),
        transportMaxBytes: async () => (await resolveFileTransport()).maxBytes,
        // Same route as the image tool's inspection: the frozen chat model
        // with the provider key read at call time.
        inspectScreenshot: async (input) => {
          const env = await resolveAgentPlatformEnv();
          const model = await prepareRuntimePlanModel(plan, env, options.turn);
          const apiKey = await resolveModelApiKeyForStatelessCall(plan.model, env, getSettingsStore(env));
          return answerScreenshotQuestion(model.model, input, apiKey);
        },
        log: { warn: (message) => console.warn(`[chickpea] ${message}`) },
      })
    : [];
  const uploadTool = !options.fileCompletion?.repairing && runtimePlanAllowsConnectionFileUpload(plan)
    ? createAttachFileToConnectionTool({
        resolveFetch: options.resolveUploadFetch ?? (() => resolveRuntimePlanUploadFetch(plan)),
        resolveFile: (handle) => resolveUploadFile(handle, {
          images: { read: async (id) => (await resolveOutputStore()).read(id) },
          recordings: { read: async (id) => (await resolveRecordingStore()).read(id) },
          openRecording: (sessionId) => openRecordingDownload(
            options.browserSession?.provider ?? createRuntimePlanBrowserProvider(), sessionId),
          inventory: imageInventory,
          createImageReader: async () =>
            createThreadImageReader({ client: createSlackAttachmentClient(await resolveAgentPlatformEnv()) }),
        }),
        streamMode: isCloudflareTarget() ? 'stream' : 'file',
      })
    : undefined;
  // Reading a workspace file for delivery is export-only, so it stays
  // available during a file-delivery repair.
  const workspaceSource: WorkspaceArtifactSource | undefined = runtimePlanWorkspaceToolsMounted(plan, false)
    ? {
        sandbox: async (name) => {
          let normalized: string;
          try {
            normalized = normalizeWorkspaceName(name);
          } catch {
            return undefined;
          }
          const resolve = options.resolveWorkspace ??
            runtimePlanWorkspaceResolver(plan, { release: false });
          // Reading a file for delivery looks at a workspace the thread
          // already has; it never opens one.
          return (await resolve(normalized, 'inspect'))?.sandbox();
        },
      }
    : undefined;
  return [
    createWorkspaceArtifactTool(
      { ...binding, sandboxKind: plan.sandbox.mode },
      options.fileCompletion?.deliver,
      workspaceSource,
    ),
    ...(options.fileCompletion
      ? [options.fileCompletion.tool({ ...binding, sandboxKind: plan.sandbox.mode }, workspaceSource)]
      : []),
    ...(!options.fileCompletion?.repairing && imageOptions
      ? [createImageArtifactTool(imageOptions), createRecoverImageTool(imageOptions)] : []),
    ...browserTools,
    ...(uploadTool ? [uploadTool] : []),
  ];
}

type SlackInstallationClient = Awaited<ReturnType<typeof resolveSlackInstallationExecutionContext>>['client'];

type RuntimePlanSlackSignal = NonNullable<ReturnType<typeof parseSlackManagementSignal>>;

/**
 * The current delivery's host-authored Slack signal for this plan's
 * conversation, or undefined when there is none (a scheduled run) or it does
 * not verify.
 */
function runtimePlanSlackSignal(plan: RuntimePlanV2): RuntimePlanSlackSignal | undefined {
  try {
    return parseSlackManagementSignal(useDelivery(), plan) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The Slack person a browser hand-off link may reach: the verified requester of the delivery. */
function runtimePlanBrowserRequester(signal: RuntimePlanSlackSignal): SlackRequester {
  return {
    slackUserId: signal.slackUserId,
    channelId: signal.channelId,
    ...(signal.conversationKind ? { conversationKind: signal.conversationKind } : {}),
  };
}

/**
 * Where a data-changing browser step waits for approval: the verified Slack
 * requester, conversation, and Agent of the current delivery, and the
 * message it answers, which is what an admission-time "approve" binds to.
 */
function runtimePlanBrowserApprovals(
  plan: RuntimePlanV2,
  signal: RuntimePlanSlackSignal,
  onAwaitingApproval: () => void,
): BrowserApprovalOptions {
  return {
    scope: {
      workspaceId: signal.workspaceId,
      channelId: signal.channelId,
      threadTs: signal.threadTs,
      agentId: plan.agentId,
      actorSlackUserId: signal.slackUserId,
      ...(plan.actorMembershipId ? { actorMembershipId: plan.actorMembershipId } : {}),
    },
    messageTs: signal.messageTs,
    settings: async () => getSettingsStore(await resolveAgentPlatformEnv()),
    onAwaitingApproval,
  };
}

/**
 * The website-login seams for the browser tools. The plan's frozen logins are
 * the ceiling; the Agent's live grants, joined with current login metadata,
 * apply revocations at call time. Secrets stay in the login store until the
 * sign-in tool reads them.
 */
function runtimePlanBrowserLogins(
  plan: RuntimePlanV2,
  granted: readonly RuntimePlanWebsiteLoginV1[],
): BrowserLoginOptions {
  return {
    granted,
    readLive: async () => {
      const env = await resolveAgentPlatformEnv();
      const agent = await getConfigStore(env).getAgent(plan.agentId);
      if (!agent.enabled) return [];
      return compileWebsiteLogins(agent.websiteLogins, await listWebsiteLogins(getSettingsStore(env)));
    },
    dependencies: async () => websiteLoginDependencies(await resolveAgentPlatformEnv()),
  };
}

/**
 * A lazily connected browser session for one hook-mounted turn. The key is
 * read from current settings on first use, never from the plan, and each
 * ended session is tallied into the install's monthly browser usage.
 */
export function createRuntimePlanBrowserSession(): BrowserTurnSession {
  return new BrowserTurnSession({
    provider: createRuntimePlanBrowserProvider(),
    connect: async (connectUrl) => (await import('../browser/cdp.ts')).connectCdpSocket(connectUrl),
    onClosed: async ({ sessionId, seconds }) => {
      try {
        const env = await resolveAgentPlatformEnv();
        await recordBrowserSessionUsage({ store: getSettingsStore(env), sessionId, seconds });
      } catch {
        console.warn('[chickpea] Browser usage could not be recorded for a finished session');
      }
    },
  });
}

/**
 * The install's browser provider, keyed from current settings on first use.
 * The Browserbase client and CDP transport load only when a turn browses (or
 * re-reads a recording), which keeps them out of the Worker's startup graph.
 */
function createRuntimePlanBrowserProvider(): BrowserTurnSession['provider'] {
  return createLazyBrowserProvider(async () => {
    const env = await resolveAgentPlatformEnv();
    const settings = await resolveBrowserSettings(getSettingsStore(env), env);
    if (!settings.apiKey) return undefined;
    const { createBrowserbaseProvider } = await import('../browser/browserbase.ts');
    return createBrowserbaseProvider({
      apiKey: settings.apiKey,
      ...(settings.projectId ? { projectId: settings.projectId } : {}),
    });
  });
}

/**
 * The runtime plan's API connections for a Worker-side connection tool: its
 * frozen declarations, narrowed by live authority, each behind its own
 * per-connector egress scopes. Resolved per call, so a connection disabled or
 * narrowed mid-turn is gone or narrowed on the next call. GitHub hosts stay
 * with the repository integration.
 */
export async function resolveRuntimePlanConnectionAccess(
  plan: RuntimePlanV2,
  options: { timeoutMs: number; filter?: (connector: ResolvedApiConnection) => boolean },
): Promise<ConnectionAccess> {
  const env = await resolveAgentPlatformEnv();
  const resolved = (await resolveRuntimePlanApiConnections(plan, env)).map(({ policy, connectors }) => ({
    policy,
    connectors: mergeRepositoryAndApiConnectors([], connectors),
  }));
  return buildConnectionAccess(resolved, { cloudflare: isCloudflareTarget(), ...options });
}

async function resolveRuntimePlanUploadFetch(plan: RuntimePlanV2): Promise<ConnectionUploadFetch | undefined> {
  const access = await resolveRuntimePlanConnectionAccess(plan, {
    timeoutMs: CONNECTION_UPLOAD_TIMEOUT_MS,
    filter: (connector) => allowsConnectionFileUpload(connector.allowedMethods),
  });
  return access.fetchAll();
}

/** connection_request for a runtime plan, resolving the plan's connections per call. */
export function createRuntimePlanConnectionRequestTool(plan: RuntimePlanV2) {
  return createConnectionRequestTool({
    agentId: plan.agentId,
    resolveAccess: () => resolveRuntimePlanConnectionAccess(plan, { timeoutMs: CONNECTION_REQUEST_TIMEOUT_MS }),
  });
}

/** Mounted for a plan with any API connection its actor can use. */
export function runtimePlanAllowsConnectionRequests(plan: RuntimePlanV2): boolean {
  return planAllowsConnectionRequests(plan);
}

/** Mounted only for a plan with a writable API connection its actor can use. */
export function runtimePlanAllowsConnectionFileUpload(plan: RuntimePlanV2): boolean {
  return planAllowsConnectionFileUpload(plan);
}

export interface RuntimePlanArtifactToolOptions {
  fileCompletion?: FileDeliveryCompletion;
  /** Thread image records for this turn, collected by the host fetch. */
  threadImages?: readonly ThreadImageRecord[] | undefined;
  /** Prebuilt inventory; the render builds one so the instruction can read it. */
  imageInventory?: ThreadImageInventory | undefined;
  /** The response's image quota; supplied by `useImageCallBudget`. */
  reserveImageCall?: ImageCallReservation | undefined;
  /** Focused seam; production resolves the role and provider at call time. */
  resolveImageClient?: (() => Promise<ImageClientResolution>) | undefined;
  /** The response's browser session, from `useBrowserSession`; absent, no browser tools mount. */
  browserSession?: BrowserTurnSession | undefined;
  /** The verified Slack requester a browser sign-in hand-off link may reach. */
  browserRequester?: SlackRequester | undefined;
  /** Where data-changing browser steps wait for the requester's approval. */
  browserApprovals?: BrowserApprovalOptions | undefined;
  /** Focused seam; production resolves the plan's connections at call time. */
  resolveUploadFetch?: (() => Promise<ConnectionUploadFetch | undefined>) | undefined;
  /** This submission's coding-workspace lookup, shared with the workspace tools. */
  resolveWorkspace?: WorkspaceResolver | undefined;
  /** This turn's frozen settings envelope; absent, tools read settings live. */
  turn?: TurnEnvelopeContext | undefined;
}

/**
 * The per-turn `img:N` inventory for a plan. Built once per render so the
 * model-facing instruction and the tool address the same handles.
 */
export function runtimePlanThreadImageInventory(
  plan: RuntimePlanV2,
  threadImages?: readonly ThreadImageRecord[] | undefined,
): ThreadImageInventory {
  return buildThreadImageInventory({
    // The same key `runtimePlanConversationKey` derives, without re-validating
    // a plan the caller already parsed.
    conversationKey: slackThreadImageConversationKey({
      workspaceId: plan.conversation.workspaceId,
      channelId: plan.conversation.channelId,
      threadTs: plan.conversation.threadTs,
    }),
    ...(threadImages ? { threadRecords: threadImages } : {}),
  });
}

/**
 * Resolve the image role again inside the tool call, so a per-Agent override
 * saved after the plan was compiled still decides which model runs.
 * Any unresolved role, missing credential, or unsupported provider is one
 * `misconfigured` outcome: the tool never reports a model it did not call.
 */
async function resolveRuntimePlanImageClient(
  plan: RuntimePlanV2,
  turn?: TurnEnvelopeContext,
): Promise<ImageClientResolution> {
  const env = await resolveAgentPlatformEnv();
  const settings = getSettingsStore(env);
  // The role as of this turn's dispatch. If its model no longer resolves
  // (the frozen role went stale mid-turn), re-resolve the role live once.
  const envelope = await turn?.envelope();
  if (envelope?.imageModelId) {
    const frozen = await resolveImageProvider(
      envelope.imageModelId,
      env,
      new TurnSettingsView(settings, envelope),
    );
    if (frozen.ok) return { ok: true, client: frozen.client };
  }
  const config = getConfigStore(env);
  let modelId: string;
  try {
    const agent = await config.getAgent(plan.agentId);
    const resolution = await resolveAgentModelRoleFromStore({
      role: 'image',
      workspaceId: plan.conversation.workspaceId,
      agent: { id: agent.id, kind: agent.kind },
      reader: {
        getWorkspaceModelRole: (workspaceId, role) => config.getWorkspaceModelRole(workspaceId, role),
        getAgentModelRole: (agentId, role) => config.getAgentModelRole(agentId, role),
      },
      ...(env ? { env } : {}),
      settings,
    });
    if ('unset' in resolution) return { ok: false, reason: 'misconfigured' };
    modelId = resolution.modelId;
  } catch {
    return { ok: false, reason: 'misconfigured' };
  }
  const provider = await resolveImageProvider(modelId, env, settings);
  return provider.ok ? { ok: true, client: provider.client } : { ok: false, reason: 'misconfigured' };
}

/**
 * A coding workspace of a conversation. The default workspace keeps the
 * conversation's original Sandbox Durable Object, so warm containers and
 * checkpoints from before workspaces were tools carry over.
 */
async function createCloudflareWorkspaceSession(options: {
  binding: unknown;
  conversationKey: string;
  /** The workspace name and retirement generation; the default workspace when absent. */
  name?: string;
  generation?: number;
  agentId: string;
  grants: readonly RepositoryGrant[];
  credentialMode?: SandboxCredentialMode;
  turnId: string;
  onOpen?: () => void;
  settingsStore: ReturnType<typeof getSettingsStore>;
  monthlySessionCap: number;
}) {
  const [{ cloudflareSandbox }, { getSandbox }] = await Promise.all([
    import('@flue/runtime/cloudflare'),
    import('@cloudflare/sandbox'),
  ]);
  const name = options.name ?? DEFAULT_WORKSPACE_NAME;
  const workspaceId = workspaceIdFor(options.conversationKey, name, options.generation ?? 0);
  const provider = (stub: WorkspaceSandboxStub) =>
    cloudflareSandbox(
      contentFreeSandboxExec(stub as unknown as Parameters<typeof cloudflareSandbox>[0]),
      { cwd: '/workspace' },
    );
  // Never cache the stub in module state: it is bound to this agent DO's I/O
  // context, and the next turn in this thread may run in a different DO that
  // shares the isolate.
  const mintStub = async () =>
    getSandbox(
      options.binding as Parameters<typeof getSandbox>[0],
      workspaceId,
      CLOUDFLARE_SANDBOX_OPTIONS,
    ) as unknown as WorkspaceSandboxStub;
  const session = new WorkspaceSession({
    id: workspaceId,
    name,
    agentId: options.agentId,
    grants: options.grants,
    ...(options.credentialMode ? { credentialMode: options.credentialMode } : {}),
    turnId: options.turnId,
    ...(options.onOpen ? { onOpen: options.onOpen } : {}),
    mintStub,
    reserveSession: async (reservationId) =>
      (await reserveMonthlySandboxSession({
        store: options.settingsStore,
        cap: options.monthlySessionCap,
        reservationId: workspaceReservationId(options.conversationKey, workspaceId, reservationId),
      })).allowed,
    toSandbox: (stub) => provider(stub).createSandbox({ id: workspaceId }),
  });
  return { session, provider, mintStub };
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
