import { createHash, randomUUID } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';

import { isRecord } from '../security/content-validation.ts';
import {
  renderAdminPage,
  renderSlackAccessDeniedPage,
  renderSlackAuthorizationHandoffPage,
  renderSlackInvitationCompletePage,
  renderSlackInvitationMismatchPage,
  renderSlackInvitationPage,
  renderSlackInvitationUnavailablePage,
  renderSlackOwnerCompletePage,
  renderSlackRecoveryPage,
  renderSlackManualSetupPage,
  renderSlackSetupPage,
  renderSlackSignInPage,
} from './page.ts';
import { onboardingAssetBytes } from './onboarding-assets.ts';
import { createRoutineAdminApi } from './routines-api.ts';
import {
  RoutineContentAccessResolver,
  routineContentReadable,
} from './routine-content-access.ts';
import {
  readIdempotencyKey as readAdminIdempotencyKey,
  safeMutationRequest as safeAdminMutationRequest,
} from './api-support.ts';
import { createUsageAdminApi } from './usage-api.ts';
import { createWorkAdminApi } from './work-api.ts';
import { createTeamAdminApi } from './team-api.ts';
import {
  ConnectionScheduleConflictError,
  ConnectionAccountService,
  ManagedConnectionConflictError,
  ManagedConnectionProviderUnavailableError,
  ManagedResourceSelectionError,
  markManagedProviderAccountsUnavailable,
  reconcileManagedProviderAccounts,
  toConnectionAccountView,
} from '../connections/store.ts';
import {
  createDefaultManagedConnectionProviderRegistry,
  createManagedConnectionProviderRegistry,
  createResolvedManagedConnectionProviderRegistry,
  managedProviderAvailability,
  type ManagedConnectionProvider,
  type ManagedConnectionProviderRegistry,
} from '../connections/managed.ts';
import {
  ManagedAuthorizationAllocatedError,
  ManagedProviderRequestError,
} from '../connections/managed-errors.ts';
import {
  abandonManagedAuthorization,
  abandonManagedAuthorizationForRestart,
  abandonStaleManagedAuthorization,
  beginManagedAuthorization,
  finalizeManagedAuthorization,
  inspectManagedAuthorization,
  inspectManagedAuthorizationForCleanup,
  inspectStaleManagedAuthorization,
  managedAuthorizationAttemptId,
  ManagedAuthorizationError,
  recoverMalformedManagedAuthorization,
  type ManagedAuthorizationAttempt,
  recordManagedAuthorizationAccount,
  recordManagedAuthorizationRequest,
  assertManagedAuthorizationProvider,
} from '../connections/managed-authorization.ts';
import {
  completeComposioReconciliation,
  ComposioConfigurationMutationError,
  ComposioConfigurationStateError,
  composioConfigurationIsMutable,
  describeComposioConfiguration,
  disableStoredComposioConfiguration,
  resolveComposioConfiguration,
  saveStoredComposioProjectKey,
  type ComposioConfigurationOptions,
  type ResolvedComposioConfiguration,
} from '../config/composio-settings.ts';
import {
  prepareResolvedComposioManagedAuthConfigs,
  validateComposioProjectKey,
  ComposioProjectKeyValidationError,
  ComposioSetupInProgressError,
} from '../connections/composio-setup.ts';
import {
  inspectComposioConnectedAccount,
  type ComposioClientLike,
} from '../connections/providers/composio.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  type ManagedConnectorCatalog,
} from '../connections/catalog/index.ts';
import { verifyComposioWebhook } from '../connections/composio-webhook.ts';
import {
  authorizeOAuthContinuationFromProvider,
  cancelOAuthContinuationFromProvider,
  claimOAuthContinuationResume,
  createOAuthContinuation,
  inspectOAuthContinuationFromProvider,
  isOAuthContinuationActorActive,
  linkOAuthProviderState,
  OAuthContinuationError,
  takeOAuthContinuationForProviderState,
} from '../connections/oauth-continuation.ts';
import type { OAuthContinuation } from '../connections/types.ts';
import {
  safeSetupDestination,
  safeSlackLoginDestination,
  slackAuthorizationHandoffScript,
  slackManualSetupClientScript,
  slackSetupClientScript,
} from '../auth/setup-handoff.ts';
import {
  SETUP_CAPABILITY_DIGEST_BINDING,
  SETUP_CAPABILITY_ISSUED_AT_BINDING,
} from '../auth/setup-capability.mjs';
import {
  DEPLOYMENT_ACTIVATION_DIGEST_BINDING,
  DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING,
  verifyDeploymentActivation,
} from '../auth/deployment-activation.mjs';
// Build-time JSON import: the committed manifest is the single source of the
// Slack app identity; the wizard deep-link below substitutes the request host
// so users never hand-edit a request_url.
import slackAppManifest from '../../slack-app-manifest.json' with { type: 'json' };
import { AGENT_ID_PATTERN, CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import {
  apiOAuthSettingKeys,
  connectionAccountIdFromOAuthRef,
  connectionAccountOAuthRef,
  apiOAuthReturnRefFromState,
  ApiOAuthError,
  cancelApiOAuthAuthorization,
  completeApiOAuthAuthorization,
  deleteApiOAuthSettings,
  describeApiOAuthSources,
  invalidateApiOAuthAuthorization,
  saveApiOAuthClient,
  startApiOAuthAuthorization,
  type ApiOAuthDependencies,
  type ApiOAuthProvider,
  type ApiOAuthRef,
} from '../config/api-oauth.ts';
import { isValidApiOAuthConnectionPolicy } from '../config/api-oauth-policy.ts';
import {
  beginOnboardingJourney,
  completeOnboardingJourney,
  ONBOARDING_PROVIDER_IDS,
  readOnboardingJourney,
  selectOnboardingProvider,
  startOnboardingTry,
  type OnboardingProviderId,
  type OnboardingSnapshot,
} from '../config/onboarding-state.ts';
import {
  clearConnectorCredential,
  deleteConnectorSecrets,
  describeConnectorCredentialSource,
  finishConnectorSecretCleanup,
  saveConnectorCredential,
  stageConnectorSecretCleanup,
  stageConnectorSettingCleanup,
} from '../config/connector-secrets.ts';
import {
  computeSnapshotHash,
  resolveEffectiveSlackConfig,
  type EffectiveSlackConfig,
} from '../config/effective-config.ts';
import {
  AgentRevisionConflictError,
  AgentExistsError,
  AgentStillAssignedError,
  AgentStillReferencedError,
  ModelResolutionError,
  NoAssignmentError,
  UnknownAgentError,
  WorkspaceModelDefaultRevisionConflictError,
} from '../config/errors.ts';
import {
  EGRESS_SETTING_KEY,
  parseEgressPolicy,
  type EgressPolicy,
} from '../config/egress.ts';
import {
  createInstallationToken,
  consumeGithubSetupState,
  exchangeGithubAppManifest,
  getGithubConnection,
  getRepositoryInstallation,
  githubErrorIsRateLimited,
  githubErrorStatus,
  isGithubAppManagedHost,
  GITHUB_OWNER_PATTERN,
  GITHUB_SETTING_KEYS,
  isValidRepositoryFullName,
  listInstallationRepos,
  listInstallations,
  normalizePrivateKeyPem,
  saveGithubSetupState,
} from '../config/github-app.ts';
import { classifyMcpError, McpBlockedUrlError, mcpDebugText, safeMcpFailureText } from '../config/mcp-errors.ts';
import {
  discoverMcpConnectionIdentity,
  type McpIdentityInput,
} from '../config/mcp-identity.ts';
import {
  cancelMcpOAuthAuthorization,
  completeMcpOAuthAuthorization,
  createMcpOAuthClientMetadataDocument,
  deleteMcpOAuthSettings,
  isCurrentMcpOAuthConnection,
  McpOAuthError,
  mcpOAuthReturnRefFromState,
  mcpOAuthSettingKeys,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
  type CompleteMcpOAuthInput,
  type McpOAuthDependencies,
  type ResolveMcpOAuthAccessInput,
  type StartMcpOAuthInput,
} from '../config/mcp-oauth.ts';
import {
  buildMcpRequestHeaders,
  deleteMcpSecrets,
  describeMcpSecretSources,
  finishMcpSecretCleanup,
  mcpBearerSettingKey,
  mcpHeaderSettingKey,
  resolveMcpSecrets,
  saveMcpSecrets,
  stageMcpSecretCleanup,
  type ResolvedMcpSecrets,
} from '../config/mcp-secrets.ts';
import {
  clearRepointedMcpCredentials,
  safeUrlOrigin,
} from '../config/mcp-connection-lifecycle.ts';
import { discoverMcpTools, type McpConnectInput, type McpDiscoveryResult } from '../config/mcp-test.ts';
import { validateMcpUrl } from '../config/mcp-url.ts';
import {
  resolveAgentModel,
  resolveAgentModelPolicy,
  type ModelResolvableAgent,
} from '../config/model-policy.ts';
import {
  resolveOpenAiAuthMethod,
  saveOpenAiAuthMethod,
} from '../config/openai-auth.ts';
import {
  applyResolvedProviderKeys,
  deleteProviderApiKey,
  describeProviderKeySources,
  isProviderKeyId,
  PROVIDER_KEY_IDS,
  resolveProviderApiKey,
  saveProviderApiKey,
  type ProviderKeySource,
} from '../config/provider-keys.ts';
import {
  cachedProviderModelCount,
  getProviderFavorites,
  getWorkersAiEnabled,
  isAdminProviderId,
  isFavoriteProviderId,
  listProviderModels,
  primeProviderModelCache,
  ProviderKeyRejectedError,
  ProviderModelsUnavailableError,
  ProviderUnreachableError,
  putProviderFavorites,
  putWorkersAiEnabled,
  validateProviderApiKey,
  type AdminProviderId,
} from '../config/provider-models.ts';
import {
  knownProviderIds,
  listRuntimeModelProviders,
  type RuntimeModelProvider,
} from '../config/providers.ts';
import { resolveProviderRuntimeImpact } from '../config/provider-impact.ts';
import {
  resolveSandboxSettings,
  SANDBOX_PACKAGE_REGISTRY_HOSTS,
  SANDBOX_SETTING_KEYS,
} from '../config/sandbox-settings.ts';
import { validEnabledRepositoryGrants } from '../sandbox/egress-handler.ts';
import { sandboxBindingInstalled } from '../sandbox/select.ts';
import { parseSkillSource, resolveSkillSource, SkillImportError } from '../config/skill-import.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getAgentSnapshotStore,
  getConfigStore,
  getIdentityStore,
  getMemoryStateStore,
  getManagementStore,
  getRoutineStore,
  getSettingsStore,
  getSlackCredentialDependencies,
  getSlackCredentialResolutionDependencies,
  getSlackStateStore,
  getUsageStore,
  getWorkStore,
  isCloudflareTarget,
  readRuntimeDrainStatus,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { AgentSnapshotStore } from '../config/snapshot-store.ts';
import type { RuntimeDrainStatus } from '../config/state-rpc.ts';
import type { ConfigStore } from '../config/store.ts';
import type {
  AgentCreateInput,
  AgentScheduleState,
  WorkspaceModelDefault,
} from '../config/types.ts';
import { MemoryStateError, type MemoryStateStore } from '../memory/types.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineStore,
} from '../routines/types.ts';
import { RoutineService } from '../routines/service.ts';
import {
  requireRoutineScheduling,
  resolveRoutineCapability,
  type RoutineCapability,
} from '../routines/scheduler-adapter.ts';
import { hashRoutineValue } from '../routines/ids.ts';
import {
  reassignRoutineAgentAuthority,
  RoutineAuthorityError,
} from '../routines/agent-authority.ts';
import type { UsageStore } from '../usage/types.ts';
import type { WorkStore } from '../work/types.ts';
import { parseSlackThreadKey } from '../slack/thread-key.ts';
import { hasDeliveredOnboardingReply } from './onboarding-proof.ts';
import type {
  HumanIdentityDirectory,
  IdentityStore,
  SlackSetupTransaction,
} from '../identity/types.ts';
import type { SlackStateStore } from '../slack/claim-store.ts';
import {
  cancelOpenAiSubscriptionAuthorization,
  confirmOpenAiSubscriptionAccountChange,
  getOpenAiSubscriptionAuthorizationStatus,
  pollOpenAiSubscriptionAuthorization,
  startOpenAiSubscriptionAuthorization,
  type OpenAiSubscriptionAuthorizationDependencies,
  type OpenAiSubscriptionAuthorizationProtocol,
} from '../openai-subscription/device-auth.ts';
import { disconnectOpenAiSubscription } from '../openai-subscription/credentials.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import {
  MODEL_CATALOG_SETTING_KEYS,
  activateBundledModelCatalog,
  activeModelCatalogSnapshot,
  loadModelCatalog,
  readModelCatalogLkg,
  readModelCatalogMode,
  refreshModelCatalog,
  resolveActiveCatalogRoute,
  type ModelCatalogRefreshResult,
  type RefreshModelCatalogOptions,
} from '../model-catalog/index.ts';
import type {
  AgentChannelGrant,
  AgentConnectionBinding,
  AgentReferenceSummary,
  ConnectionAccount,
  CustomAgentConfig,
  McpConnectionConfig,
  McpConnectionIdentity,
  WorkspaceInstallation,
} from '../config/types.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import {
  envManagedSlackBehaviorKeys,
  resolveSlackBehaviorSettings,
  saveSlackBehaviorSettings,
  type SlackBehaviorPatch,
} from '../slack/behavior-settings.ts';
import { listSlackChannels, SlackChannelsError } from '../slack/channels.ts';
import {
  describeSlackCredentialSources,
  readSlackConnectionRevision,
  readStoredSlackTeamInfo,
  resolveSlackCredentials,
  resolveSlackTeamInfo,
  primeStoredSlackPublicUrl,
  slackAuthTest,
  slackConversationsInfo,
  SLACK_SETTING_KEYS,
  type SlackChannelSummary,
  type SlackTeamInfo,
} from '../slack/credentials.ts';
import {
  type SlackInstallationVerificationDeps,
} from '../slack/installation-verification.ts';
import {
  buildSlackAppManifest,
  slackManifestPrefillUrl,
} from '../slack/app-manifest.ts';
import {
  openSlackSetupTransaction,
  SlackAppCreationError,
  SlackAppCreationService,
} from '../slack/app-creation.ts';
import { missingRequiredSlackBotScopes } from '../slack/scopes.ts';
import {
  clearSlackInstallationCredentials,
  resolveSlackInstallationCredentials,
  SlackInstallationCredentialRevisionError,
  type SlackCredentialDependencies,
  type SlackCredentialResolutionDependencies,
} from '../slack/installation-credentials.ts';
import {
  AgentAvatarError,
  agentAvatarUrl,
  readAgentAvatarAsset,
  uploadAgentAvatar,
} from '../slack/agent-presence/avatar-assets.ts';
import {
  publishGeneratedAgentAvatar,
  type GeneratedAgentAvatarPublishInput,
} from '../slack/agent-presence/gateway-avatar.ts';
import { nextDefaultAgentAvatarSeed } from '../slack/agent-presence/default-avatar-pool.ts';
import {
  AgentPresenceError,
  agentPresenceRecovery,
  classifyAgentPresenceError,
} from '../slack/agent-presence/errors.ts';
import { normalizeAgentHandle } from '../slack/agent-presence/handles.ts';
import { reservedAgentIdentityField } from '../config/agent-id.ts';
import { AgentPresenceReconciler } from '../slack/agent-presence/reconciler.ts';
import {
  resolvePrivateAgentAudience,
  type PrivateAgentAudience,
} from '../slack/agent-access.ts';
import { createDirectSlackTransport } from '../slack/transport/direct.ts';
import { createGatewaySlackTransport } from '../slack/transport/gateway.ts';
import { createGatewayDeploymentClient } from '../slack/gateway/runtime.ts';
import { cloudflareWorkerVersionId } from '../config/cloudflare-version.ts';
import {
  GATEWAY_BINDING_SETTING,
  GATEWAY_CLAIM_SETTING,
} from '../slack/gateway/client.ts';
import {
  nodeGatewaySessionStatus,
  startNodeGatewaySession,
} from '../slack/gateway/node-runtime.ts';
import {
  reconcileGatewaySessionStatus,
  type GatewaySessionStatusSnapshot,
} from '../slack/gateway/session-runner.ts';
import { GatewaySlackOidcProvider } from '../auth/gateway-slack-oidc.ts';
import { SlackTransportError, type SlackTransport } from '../slack/transport/types.ts';
import { SLACK_PENDING_ENVELOPE_SETTING } from '../slack/installation-handshake.ts';
import {
  SlackInstallOAuthError,
  SlackInstallOAuthService,
  type SlackInstallOAuthResult,
} from '../slack/install-oauth.ts';
import { setCookieValues } from '../auth/cookies.ts';
import { AuthDeniedError, AuthService, setRequestPrincipal } from '../auth/service.ts';
import {
  BetterAuthDirectory,
  BetterAuthSessionAuthenticator,
} from '../auth/better-auth-principal.ts';
import {
  resolveBetterAuthEnvironment,
  resolveBetterAuthBootstrapEnvironment,
  type BetterAuthEnvironment,
} from '../auth/better-auth-environment.ts';
import { SlackAdmissionService } from '../auth/slack-admission.ts';
import { SlackOidcError } from '../auth/slack-oidc.ts';
import { createBetterAuthEnvironmentPublicHandler } from '../auth/better-auth-runtime.ts';
import {
  AuthorizationError,
  canEditAgent,
  permissionForRole,
  requireAgentEdit,
  requirePermission,
  type Permission,
} from '../auth/permissions.ts';
import { validateMutationProvenance } from '../auth/request-provenance.ts';
import { AuthRateLimitError, AuthRateLimiter } from '../auth/rate-limit.ts';
import { requestAuthSourceKey } from '../auth/source-key.ts';
import {
  SlackCredentialRecoveryError,
  SlackCredentialRecoveryService,
} from '../auth/recovery.ts';
import { PersonalTokenService } from '../auth/personal-token.ts';
import type { AdminAuthenticationService, AuthPrincipal } from '../auth/types.ts';
import { decodeRecoverySecret } from '../auth/recovery-secret.ts';
import type { ManagementStore } from '../management/store.ts';
import { createLiveWorkspaceManagementService } from '../management/live-service.ts';

const GATEWAY_RECONNECT_REQUIRED_DETAILS = new Set([
  'binding_mismatch',
  'binding_reconnect_required',
  'gateway_binding_missing',
  'gateway_binding_mismatch',
  'gateway_not_connected',
]);
const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BetterAuthContext {
  environment: BetterAuthEnvironment;
  directory: BetterAuthDirectory;
  organizationId: string;
}

interface AdminRoutesOptions {
  // Injection seam for tests/harnesses: any async ConfigStore serves the
  // routes; absent, the platform backend is resolved per request (c.env is the
  // Cloudflare bindings object there; Node ignores it).
  store?: ConfigStore | undefined;
  snapshots?: AgentSnapshotStore | undefined;
  // Same seam for the Slack-connection wizard's settings persistence.
  settings?: SettingsStore | undefined;
  memory?: MemoryStateStore | undefined;
  routines?: RoutineStore | undefined;
  usage?: UsageStore | undefined;
  work?: WorkStore | undefined;
  routineCapability?: ((c: Context) => RoutineCapability) | undefined;
  slackState?: SlackStateStore | undefined;
  runtimeDrain?: ((env?: PlatformEnv) => Promise<RuntimeDrainStatus>) | undefined;
  usageAdminUi?: boolean | undefined;
  authService?: AdminAuthenticationService | undefined;
  betterAuthEnvironment?: BetterAuthEnvironment | undefined;
  identity?: IdentityStore | undefined;
  management?: ManagementStore | undefined;
  managedConnectionProviders?: ManagedConnectionProviderRegistry | undefined;
  managedConnectorCatalog?: ManagedConnectorCatalog | undefined;
  composioConfiguration?: Omit<ComposioConfigurationOptions, 'env' | 'settings'> | undefined;
  composioCreateClient?: ((input: { apiKey: string }) => Promise<ComposioClientLike>) | undefined;
  composioInspectAccount?: ((input: {
    apiKey: string;
    accountRef: string;
    principalRef: string;
    toolkit: string;
    signal?: AbortSignal;
  }) => Promise<'match' | 'missing' | 'mismatch' | 'transient'>) | undefined;
  composioReconciliationTimeoutMs?: number | undefined;
  composioPreparationTimeoutMs?: number | undefined;
  /**
   * Explicit encrypted Slack credential realm for tests and embedded hosts.
   * Production resolves persistent TAG_STATE and its target keyring from the
   * request environment. Merely injecting an auth IdentityStore must never
   * cause an unrelated keyring file to be created.
   */
  slackCredentials?: SlackCredentialDependencies | undefined;
  slackAdmissionService?: SlackAdmissionService | undefined;
  gatewayAvatarPublish?: ((input: {
    workspaceId: string;
    agentId: string;
    revision: number;
    contentType: 'image/png';
    bytes: Uint8Array;
  }) => Promise<string>) | undefined;
  authSecret?: string | undefined;
  recoveryToken?: string | undefined;
  authRateLimiter?: AuthRateLimiter | undefined;
  knownProviders?: ReadonlySet<string> | undefined;
  // Injection seam for the MCP test-connection route, mirroring how the skills
  // resolve route takes a resolver: tests pass a mock so no real network
  // connect is attempted; production uses the shared discover routine.
  discoverMcp?: ((input: McpConnectInput) => Promise<McpDiscoveryResult>) | undefined;
  startMcpOAuth?: ((
    input: StartMcpOAuthInput,
    dependencies: McpOAuthDependencies,
  ) => ReturnType<typeof startMcpOAuthAuthorization>) | undefined;
  completeMcpOAuth?: ((
    input: CompleteMcpOAuthInput,
    dependencies: McpOAuthDependencies,
  ) => ReturnType<typeof completeMcpOAuthAuthorization>) | undefined;
  cancelMcpOAuth?: ((
    state: string,
    dependencies: McpOAuthDependencies,
  ) => ReturnType<typeof cancelMcpOAuthAuthorization>) | undefined;
  resolveMcpOAuthToken?: ((
    input: ResolveMcpOAuthAccessInput,
    dependencies: McpOAuthDependencies,
  ) => ReturnType<typeof resolveMcpOAuthAccessToken>) | undefined;
  identifyMcp?: ((input: McpIdentityInput) => Promise<McpConnectionIdentity | undefined>) | undefined;
  oauthFetch?: typeof fetch | undefined;
  startApiOAuth?: ((
    input: {
      ref: ApiOAuthRef;
      provider: ApiOAuthProvider;
      callbackUrl: string;
      scopes: readonly string[];
      returnAgentId?: string;
    },
    dependencies: ApiOAuthDependencies,
  ) => ReturnType<typeof startApiOAuthAuthorization>) | undefined;
  completeApiOAuth?: ((
    input: { code: string; state: string },
    dependencies: ApiOAuthDependencies,
  ) => ReturnType<typeof completeApiOAuthAuthorization>) | undefined;
  cancelApiOAuth?: ((
    state: string,
    dependencies: ApiOAuthDependencies,
  ) => ReturnType<typeof cancelApiOAuthAuthorization>) | undefined;
  /** Delivery seam for resuming the exact Slack task after OAuth succeeds. */
  onOAuthContinuationReady?: ((
    continuation: OAuthContinuation,
    env: PlatformEnv | undefined,
  ) => Promise<void>) | undefined;
  openAiSubscriptionProtocol?: OpenAiSubscriptionAuthorizationProtocol | undefined;
  openAiSubscriptionNow?: (() => number) | undefined;
  openAiSubscriptionRandomBytes?: ((length: number) => Uint8Array) | undefined;
  // Catalog refresh stays deterministic in route tests without weakening the
  // immutable production origin: tests inject the transport/clock, never a URL.
  modelCatalogRefresh?: ((
    options: RefreshModelCatalogOptions,
  ) => Promise<ModelCatalogRefreshResult>) | undefined;
  modelCatalogNow?: (() => number) | undefined;
  modelCatalogRandom?: (() => number) | undefined;
  modelCatalogOwnerId?: (() => string) | undefined;
  modelCatalogFetch?: typeof fetch | undefined;
  modelCatalogTimeoutMs?: number | undefined;
  slackInstallationVerification?: SlackInstallationVerificationDeps | undefined;
  slackConversationsInfo?: typeof slackConversationsInfo | undefined;
  slackAppCreationFetch?: typeof fetch | undefined;
  slackAppCreationNow?: (() => number) | undefined;
  slackInstallFetch?: typeof fetch | undefined;
  slackInstallNow?: (() => number) | undefined;
  slackInstallRandomBytes?: ((length: number) => Uint8Array) | undefined;
  /** Agent-facing Slack capability seam. Production resolves the direct app token. */
  slackTransport?: SlackTransport | ((workspaceId: string) => Promise<SlackTransport>) | undefined;
}

const MAX_SLACK_INSTALLATION_ADMIN_BODY_BYTES = 64 * 1_024;
const MAX_AUTH_SETUP_BODY_BYTES = 8_192;
const SLACK_INSTALL_BROWSER_COOKIE = '__Secure-chickpea_slack_install';
const SLACK_OIDC_BROWSER_COOKIE = '__Secure-chickpea_slack_oidc';
const SLACK_RECOVERY_BROWSER_COOKIE = '__Secure-chickpea_slack_recovery_browser';
const SLACK_RECOVERY_SESSION_COOKIE = '__Secure-chickpea_slack_recovery';
const MANAGED_AUTHORIZATION_BROWSER_COOKIE = '__Secure-chickpea_managed_authorization';
const MAX_ADMIN_MUTATION_BODY_BYTES = 1024 * 1024;


const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const modelSpecifier = v.pipe(v.string(), v.regex(/^[^/]+\/.+$/));
const MCP_CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const agentIdSchema = v.pipe(v.string(), v.regex(AGENT_ID_PATTERN));
const openAiSubscriptionAttemptSchema = v.object({
  attemptCapability: v.pipe(v.string(), v.minLength(32), v.maxLength(512)),
});
const openAiSubscriptionStartSchema = v.object({});
const openAiAuthMethodSchema = v.object({
  method: v.picklist(['api_key', 'subscription']),
});
const workersAiEnabledSchema = v.object({
  enabled: v.boolean(),
});
const workspaceModelDefaultSchema = v.strictObject({
  modelId: modelSpecifier,
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const chickpeaCutoverPrepareSchema = v.strictObject({
  confirm: v.literal('prepare-stage-1'),
});
const chickpeaCutoverActivateSchema = v.strictObject({
  confirm: v.literal('activate-chickpea-v1'),
  compatibilityTrafficConfirmed: v.literal(true),
  expectedInstallationRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  expectedDefaultRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const chickpeaCutoverRollbackSchema = v.strictObject({
  confirm: v.literal('rollback-to-legacy'),
  expectedInstallationRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const modelCatalogModeSchema = v.strictObject({
  mode: v.picklist(['hosted', 'bundled']),
});

// A profile skill. `name` must satisfy Flue's `defineSkill` rule so a stored
// row can never become a turn-killing validation throw at runtime; description
// and instructions are bounded to keep a skill focused and the prompt sane.
const skillName = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits, and single hyphens only'),
  v.maxLength(64),
);
const skillSchema = v.object({
  name: skillName,
  // Trim before the non-empty check so a whitespace-only value can't pass the
  // write boundary yet throw at defineSkill (which trims) and be silently
  // skipped at turn time. The stored value is the normalized one.
  description: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1024)),
  instructions: v.pipe(v.string(), v.trim(), v.minLength(1)),
  enabled: v.boolean(),
  suggestedSkillId: v.optional(skillName),
});
// Reject duplicate names at the write boundary — duplicates are a turn-killer
// downstream, so they must never reach the store.
const skillsSchema = v.pipe(
  v.array(skillSchema),
  v.check(
    (skills) => new Set(skills.map((skill) => skill.name)).size === skills.length,
    'skill names must be unique',
  ),
);

// A single discovered-tool record stored on a Connection's last successful
// test. Bounded to keep the profile row small (matches types.ts limits).
const mcpToolInfoSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  title: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(160))),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
});

const mcpIdentitySchema = v.object({
  workspaceName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160))),
  accountName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160))),
});

// A profile Connection (remote MCP server) — POLICY ONLY. No token/header-value
// fields exist by construction, so a secrets-shaped payload can never smuggle a
// value into the profile row. The v.check runs the same SSRF guard as turn time,
// so a private/blocked URL is refused at the write boundary too.
const mcpServerSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.regex(MCP_CONNECTION_ID_PATTERN)),
    displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
    url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
    transport: v.picklist(['streamable-http', 'sse']),
    authMode: v.picklist(['none', 'bearer', 'oauth']),
    headerNames: v.array(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/))),
    credentialHeaderName: v.optional(
      v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/)),
    ),
    credentialValuePrefix: v.optional(v.pipe(v.string(), v.maxLength(64))),
    credentialOptional: v.optional(v.boolean()),
    enabled: v.boolean(),
    lifecycleStatus: v.picklist(['pending', 'ready', 'failed']),
    statusText: v.pipe(v.string(), v.maxLength(300)),
    discoveredTools: v.pipe(v.array(mcpToolInfoSchema), v.maxLength(50)),
    allowedTools: v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
      v.maxLength(50),
    ),
    oauthScope: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4096))),
    lastCheckedAt: v.optional(v.number()),
    identity: v.optional(mcpIdentitySchema),
    presetId: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/), v.maxLength(64))),
  }),
  v.check((s) => validateMcpUrl(s.url).ok, 'URL not allowed'),
  v.check(
    (s) => s.credentialHeaderName === undefined ||
      s.headerNames.some((name) => name.toLowerCase() === s.credentialHeaderName!.toLowerCase()),
    'credential header must be declared in headerNames',
  ),
);

// Reject duplicate connection ids at the write boundary — a per-profile id must
// be unique because it becomes the `mcp__<id>__` tool prefix (and the
// profile-scoped secret-key suffix). Mirrors the unique-skill-names check.
const mcpServersSchema = v.pipe(
  v.array(mcpServerSchema),
  v.check(
    (servers) => new Set(servers.map((server) => server.id)).size === servers.length,
    'connection ids must be unique',
  ),
);

function isAllowedConnectorHost(host: string): boolean {
  // Wildcards need a custom SecureFetch wrapper (documented follow-up).
  // Exact hosts cover the target connectors: Asana app.asana.com, Zendesk
  // <subdomain>.zendesk.com, and GitHub api.github.com.
  if (host.includes('*')) return false;
  const hostname = host;

  const result = validateMcpUrl(`https://${hostname}`);
  if (!result.ok) return false;

  // `allowedHosts` stores hosts, not URLs. Keep the SSRF validation above as
  // the security boundary, then reject values that smuggle in URL components.
  const url = new URL(result.url);
  return (
    url.hostname.toLowerCase() === hostname.toLowerCase() &&
    url.port === '' &&
    url.pathname === '/' &&
    url.search === ''
  );
}

const connectorHost = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(253),
  v.check(isAllowedConnectorHost, 'Host not allowed'),
);

const GITHUB_API_CONNECTION_ERROR =
  'GitHub is managed by the GitHub App integration; connect it in Settings → GitHub';

const apiConnectionSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/)),
    displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
    allowedHosts: v.pipe(
      v.array(connectorHost),
      v.maxLength(20),
      v.check(
        (hosts) => hosts.every((host) => !isGithubAppManagedHost(host)),
        GITHUB_API_CONNECTION_ERROR,
      ),
    ),
    pathPrefixes: v.pipe(
      // Path-only: a `?query` or `#fragment` is silently dropped by both
      // matchesEgressPrefix and just-bash, which would broaden credential
      // injection and permitted methods to the whole path. Reject them here, as
      // the egress-domain validation already rejects smuggled URL components.
      v.array(v.pipe(v.string(), v.trim(), v.regex(/^\/[^\s?#]*$/), v.maxLength(512))),
      v.maxLength(20),
    ),
    headerName: v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/)),
    headerValuePrefix: v.optional(v.pipe(v.string(), v.maxLength(64))),
    allowedMethods: v.pipe(
      v.array(v.picklist(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])),
      v.minLength(1),
    ),
    enabled: v.boolean(),
    authMode: v.optional(v.picklist(['credential', 'oauth'])),
    oauthProvider: v.optional(v.literal('google')),
    oauthScopes: v.optional(
      v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256))), v.maxLength(12)),
    ),
    oauthAppType: v.optional(v.picklist(['workspace-internal', 'external'])),
    lifecycleStatus: v.optional(v.picklist(['pending', 'ready', 'failed'])),
    statusText: v.optional(v.pipe(v.string(), v.maxLength(300))),
    identity: v.optional(mcpIdentitySchema),
    presetId: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/), v.maxLength(64))),
  }),
  v.check((connection) => connection.allowedHosts.length > 0, 'allowed hosts must not be empty'),
  v.check(
    (connection) => {
      if (connection.authMode === 'oauth') {
        return isValidApiOAuthConnectionPolicy(connection) &&
          connection.oauthAppType !== undefined &&
          connection.lifecycleStatus !== undefined &&
          connection.statusText !== undefined;
      }
      return connection.oauthProvider === undefined &&
        connection.oauthScopes === undefined &&
        connection.oauthAppType === undefined &&
        connection.lifecycleStatus === undefined &&
        connection.statusText === undefined &&
        connection.identity === undefined;
    },
    'OAuth connection policy is invalid',
  ),
);

// just-bash applies EVERY allow-list transform whose prefix matches a request,
// so two connections that cover an overlapping URL space would inject both
// credentials into one request (or silently overwrite when the header names
// match), leaking one connection's secret to the other's endpoint. Reject
// overlapping scopes at the write boundary — the only place connection scopes
// are ever set — so each connection governs a distinct URL space.
type ConnectionScope = { allowedHosts: string[]; pathPrefixes: string[]; enabled: boolean };

function normalizePathPrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '');
}

// Two path prefixes overlap when they are equal or one is a segment-ancestor of
// the other (`/v1` vs `/v1/tasks`, but NOT `/v1` vs `/v10`). An empty prefix
// list means "whole host", which overlaps every path.
function pathPrefixesOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  return left.some((rawLeft) =>
    right.some((rawRight) => {
      const a = normalizePathPrefix(rawLeft);
      const b = normalizePathPrefix(rawRight);
      if (a === b) return true;
      const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
      return shorter === '' || longer.startsWith(shorter + '/');
    }),
  );
}

function connectionsOverlap(left: ConnectionScope, right: ConnectionScope): boolean {
  if (!left.enabled || !right.enabled) return false;
  const rightHosts = new Set(right.allowedHosts.map((host) => host.toLowerCase()));
  const sharesHost = left.allowedHosts.some((host) => rightHosts.has(host.toLowerCase()));
  return sharesHost && pathPrefixesOverlap(left.pathPrefixes, right.pathPrefixes);
}

function hasOverlappingConnections(connections: ConnectionScope[]): boolean {
  for (let i = 0; i < connections.length; i += 1) {
    const left = connections[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < connections.length; j += 1) {
      const right = connections[j];
      if (right !== undefined && connectionsOverlap(left, right)) return true;
    }
  }
  return false;
}

const apiConnectionsSchema = v.pipe(
  v.array(apiConnectionSchema),
  v.maxLength(50),
  v.check(
    (connections) =>
      new Set(connections.map((connection) => connection.id)).size === connections.length,
    'connection ids must be unique',
  ),
  v.check(
    (connections) => !hasOverlappingConnections(connections),
    'enabled connections must not cover overlapping URLs; narrow their hosts or path prefixes so each connection governs a distinct URL space',
  ),
);

const connectionAccountCreateSchema = v.pipe(
  v.object({
    workspaceId: v.pipe(v.string(), v.trim(), v.regex(/^[A-Z0-9_]{2,32}$/)),
    ownerKind: v.picklist(['team', 'member']),
    providerId: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/)),
    label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
    purpose: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
    credential: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32_768))),
    api: v.optional(apiConnectionSchema),
    mcp: v.optional(mcpServerSchema),
    allowedCapabilities: v.optional(v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256))),
      v.maxLength(128),
    )),
  }),
  v.check((input) =>
    Number(Boolean(input.api)) + Number(Boolean(input.mcp)) === 1,
    'exactly one connection policy is required'),
);

const MAX_MANAGED_PRINCIPAL_REF_LENGTH = 256;

function managedPrincipalRef(
  principal: AuthPrincipal,
  ownerKind: 'team' | 'member',
): string | undefined {
  // Composio's user ID identifies the Chickpea authorization principal, never
  // a caller-supplied label, email, or mutable external identity.
  const value = ownerKind === 'member'
    ? `chickpea:membership:${principal.membershipId}`
    : `chickpea:organization:${principal.organizationId}`;
  return value.length <= MAX_MANAGED_PRINCIPAL_REF_LENGTH ? value : undefined;
}

function managedAuthorizationRemoteRef(
  attempt: ManagedAuthorizationAttempt,
): string | undefined {
  return attempt.accountRef ?? attempt.authorizationRef;
}

const scheduleAuthorityReassignSchema = v.strictObject({
  runsAsMembershipId: v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_-]{1,200}$/)),
  expectedAuthorityRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const agentScheduleControlSchema = v.strictObject({
  action: v.picklist(['pause', 'resume', 'delete']),
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  acknowledgeIrreversible: v.optional(v.boolean()),
});

const repositoryGrantSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.regex(AGENT_ID_PATTERN)),
    installationId: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
    // Owner/repo names become egress URL prefixes — the strict patterns
    // exclude dot segments and metacharacters that URL normalization could
    // collapse into a broader prefix (see github-app.ts).
    accountLogin: v.pipe(v.string(), v.trim(), v.regex(GITHUB_OWNER_PATTERN)),
    fullName: v.pipe(v.string(), v.trim(), v.maxLength(201)),
    allRepos: v.optional(v.boolean()),
    enabled: v.boolean(),
  }),
  v.check(
    (grant) =>
      grant.allRepos === true
        ? grant.installationId !== null && grant.fullName === ''
        : isValidRepositoryFullName(grant.fullName),
    'repository grant must name one repository or one whole installation',
  ),
);

const repositoriesSchema = v.pipe(
  v.array(repositoryGrantSchema),
  v.maxLength(200),
  v.check(
    (repositories) =>
      new Set(repositories.map((repository) => repository.id)).size === repositories.length,
    'repository grant ids must be unique',
  ),
);

const agentSchema = v.object({
  id: agentIdSchema,
  name: nonEmptyString,
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  handle: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  editPolicy: v.optional(v.picklist(['creator_and_admins', 'all_workspace_members'])),
  instructions: nonEmptyString,
  enabled: v.boolean(),
  model: v.optional(modelSpecifier),
  skills: v.optional(skillsSchema, []),
  mcpServers: v.optional(mcpServersSchema, []),
  apiConnections: v.optional(apiConnectionsSchema, []),
  repositories: v.optional(repositoriesSchema, []),
});

const agentPatchSchema = v.object({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.optional(nonEmptyString),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  handle: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  editPolicy: v.optional(v.picklist(['creator_and_admins', 'all_workspace_members'])),
  instructions: v.optional(nonEmptyString),
  enabled: v.optional(v.boolean()),
  model: v.optional(v.nullable(modelSpecifier)),
  skills: v.optional(skillsSchema),
  mcpServers: v.optional(mcpServersSchema),
  apiConnections: v.optional(apiConnectionsSchema),
  repositories: v.optional(repositoriesSchema),
});

const agentMemorySchema = v.strictObject({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  body: v.pipe(v.string(), v.maxLength(64 * 1_024)),
});

const publishAgentSchema = v.strictObject({
  workspaceId: nonEmptyString,
  channelId: nonEmptyString,
});
const retryAgentPresenceSchema = v.strictObject({
  workspaceId: v.optional(nonEmptyString),
});
const archiveAgentSchema = v.strictObject({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  replacementDefaultAgentId: v.optional(agentIdSchema),
});
const restoreAgentSchema = v.strictObject({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  workspaceId: v.optional(nonEmptyString),
});
const agentAvatarUploadSchema = v.strictObject({
  contentType: v.picklist(['image/png', 'image/jpeg', 'image/webp']),
  base64: v.pipe(v.string(), v.minLength(4), v.maxLength(750_000)),
});

const githubOrgSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  v.maxLength(39),
);
const githubManifestSchema = v.object({ org: v.optional(githubOrgSchema) });
const githubCallbackSchema = v.object({
  code: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_024)),
});
const githubInstallationIdSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/),
  v.transform(Number),
  v.integer(),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const LEGACY_GITHUB_PAT_SETTING_KEY = 'github.pat';
const githubReposQuerySchema = v.object({
  q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  page: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[1-9]\d*$/),
      v.transform(Number),
      v.integer(),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
});

// Test-connection payload: the UNSAVED form. Secrets are transient (never
// persisted here) and merged over stored/env at handler time.
const mcpTestSchema = v.object({
  id: v.pipe(v.string(), v.regex(MCP_CONNECTION_ID_PATTERN)),
  url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
  transport: v.picklist(['streamable-http', 'sse']),
  authMode: v.picklist(['none', 'bearer', 'oauth']),
  bearerToken: v.optional(v.string()),
  // KEYS validated like headerNames — a raw key with ':' or CR/LF would throw
  // deep inside new Headers() and read as a misleading connect failure.
  headers: v.optional(v.record(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/)), v.string())),
  // The connection's known header names, so re-testing an existing connection
  // resolves STORED header values even when the operator didn't re-type them
  // (the client seeds those fields blank). Typed values in `headers` still win.
  headerNames: v.optional(v.array(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/)))),
});

// Secrets PUT payload — values plus the header NAMES they map to (the settings
// store has no prefix scan, so delete/describe need the name list).
const headerNameSchema = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/));

const mcpSecretsPutSchema = v.object({
  bearerToken: v.optional(v.string()),
  // Record KEYS are header names and get the same validation as headerNames —
  // an unvalidated key with ':' or CR/LF would explode later in new Headers().
  headers: v.optional(v.record(headerNameSchema, v.string())),
  headerNames: v.array(headerNameSchema),
  // Cleanup of orphans: header names removed/renamed in the editor, and a
  // bearer -> none switch, delete their stored settings instead of leaving
  // dead secrets behind under keys nothing references anymore.
  removeHeaderNames: v.optional(v.array(headerNameSchema)),
  clearBearer: v.optional(v.boolean()),
  clearOAuth: v.optional(v.boolean()),
});

const mcpOAuthStartSchema = v.object({
  scope: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1024))),
});

const mcpSecretsDeleteSchema = v.object({
  headerNames: v.array(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/))),
});

const connectorSecretsPutSchema = v.object({
  credential: v.optional(v.string()),
  clearCredential: v.optional(v.boolean()),
});

const apiOAuthClientSchema = v.object({
  provider: v.literal('google'),
  clientId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512)),
  clientSecret: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_048)),
});

const connectionAccountOAuthStartSchema = v.object({
  continuation: v.optional(v.object({
    workspaceId: v.pipe(v.string(), v.trim(), v.regex(/^[A-Z0-9_]{2,32}$/)),
    channelId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
    threadTs: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
    taskId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
  })),
});

const managedAuthorizationStartSchema = v.union([
  v.strictObject({
    workspaceId: v.pipe(v.string(), v.trim(), v.regex(/^[A-Z0-9_]{2,32}$/)),
    ownerKind: v.picklist(['team', 'member']),
    toolkit: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/)),
    access: v.picklist(['read', 'write']),
  }),
  v.strictObject({
    workspaceId: v.pipe(v.string(), v.trim(), v.regex(/^[A-Z0-9_]{2,32}$/)),
    connectionAccountId: v.pipe(
      v.string(),
      v.trim(),
      v.regex(/^connection_[A-Za-z0-9_-]{1,180}$/),
    ),
  }),
]);

const managedResourceSelectionSchema = v.strictObject({
  workspaceId: v.pipe(v.string(), v.trim(), v.regex(/^[A-Z0-9_]{2,32}$/)),
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  resourceConstraints: v.pipe(
    v.record(
      v.pipe(v.string(), v.regex(/^[a-z][A-Za-z0-9]{0,127}$/)),
      v.pipe(
        v.array(v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/))),
        v.maxLength(256),
      ),
    ),
    v.check((value) => Object.keys(value).length <= 32, 'Too many resource keys'),
  ),
});

const managedAuthorizationRecoverySchema = v.strictObject({
  actorMembershipId: v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_.:@-]{1,256}$/)),
});

const composioProjectSetupSchema = v.strictObject({
  projectKey: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(16_384)),
  continuation: v.optional(v.strictObject({
    agentId: agentIdSchema,
    toolkit: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/)),
  })),
});

const onboardingProviderSchema = v.strictObject({
  expectedRevision: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
  providerId: v.picklist(ONBOARDING_PROVIDER_IDS),
});

const onboardingTrySchema = v.strictObject({
  expectedRevision: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
  modelId: modelSpecifier,
  expectedDefaultRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const onboardingCompleteSchema = v.strictObject({
  expectedRevision: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
});

const egressDomain = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(253),
  v.check((domain) => validateMcpUrl(egressDomainUrl(domain)).ok, 'Domain not allowed'),
  // The egress allow-list is origin-scoped: `normalizeEgressDomain` keeps only
  // the hostname. Reject entries carrying a path/port/query/fragment/userinfo
  // rather than silently discarding them — otherwise `example.com/private`
  // would quietly widen access to the entire `example.com` origin. Mirrors the
  // bare-host rule already enforced for connector hosts.
  v.check(isBareEgressHost, 'Domain must be a bare host with no path, port, query, or fragment'),
);

const egressPolicySchema = v.object({
  mode: v.picklist(['allowlist', 'open', 'off']),
  domains: v.pipe(v.array(egressDomain), v.maxLength(100)),
});

const sandboxSettingsSchema = v.object({
  enabled: v.boolean(),
  readinessConfirmed: v.optional(v.boolean()),
  allowedHosts: v.array(v.picklist(SANDBOX_PACKAGE_REGISTRY_HOSTS)),
  monthlySessionCap: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)),
});

const sandboxAdvancedSettingsSchema = v.object({
  allowedHosts: v.array(v.picklist(SANDBOX_PACKAGE_REGISTRY_HOSTS)),
  monthlySessionCap: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)),
});

async function sandboxStatus(
  settingsStore: SettingsStore,
  configStore: ConfigStore,
  env: PlatformEnv | undefined,
) {
  const [resolved, github, agents] = await Promise.all([
    resolveSandboxSettings(settingsStore),
    getGithubConnection(settingsStore),
    configStore.listUserAgents(),
  ]);
  const cloudflare = isCloudflareTarget();
  const installed = cloudflare && sandboxBindingInstalled(env);
  const githubConnected = github.mode === 'app';
  const repositoryGrantReady = validEnabledRepositoryGrants(
    agents.flatMap((agent) => agent.repositories),
  ).length > 0;
  const unmetPrerequisites: string[] = [];
  if (!cloudflare) unmetPrerequisites.push('cloudflare_target');
  if (!installed) unmetPrerequisites.push('sandbox_binding');
  if (!githubConnected) unmetPrerequisites.push('github_app');
  if (!repositoryGrantReady) unmetPrerequisites.push('repository_grant');
  return {
    installRequested: resolved.installRequested,
    installed,
    storedEnabled: resolved.enabled,
    enabled: installed && resolved.enabled,
    instanceType: resolved.instanceType,
    allowedHosts: resolved.allowedHosts,
    monthlySessionCap: resolved.monthlySessionCap,
    monthlySessionCapConfigured: resolved.monthlySessionCapConfigured,
    target: cloudflare ? ('cloudflare' as const) : ('node' as const),
    githubConnected,
    repositoryGrantReady,
    unmetPrerequisites,
    workersPaidNote: cloudflare
      ? 'Requires Workers Paid. Real containers run on your Cloudflare account; a typical session costs about 1 cent.'
      : null,
  };
}

const slackBehaviorPatchSchema = v.pipe(
  v.partial(
    v.strictObject({
      unassignedHint: v.boolean(),
      welcomeOnJoin: v.boolean(),
    }),
  ),
  v.check((patch) => Object.keys(patch).length > 0),
);
const turnRecoveryResolveSchema = v.strictObject({
  confirm: v.literal('terminalize'),
});
export function createAdminRoutes(options: AdminRoutesOptions = {}): Hono {
  const app = new Hono();
  const principalByContext = new WeakMap<object, AuthPrincipal>();
  const betterAuthByContext = new WeakMap<object, Promise<BetterAuthContext | undefined>>();
  const managedProvidersByContext = new WeakMap<object, ManagedConnectionProviderRegistry>();
  type ResolvedManagedProviderContext = {
    providers: ManagedConnectionProviderRegistry;
    generation: number;
    lineage: string;
    readOnly: boolean;
  };
  const resolvedManagedProvidersByContext = new WeakMap<
    object,
    Promise<ResolvedManagedProviderContext>
  >();
  const managedCatalog = options.managedConnectorCatalog ?? MANAGED_CONNECTOR_CATALOG;
  const managedCatalogDescriptors = () => managedCatalog.list().map((connector) => ({
    id: connector.id,
    toolkit: connector.toolkit,
    providerId: connector.providerId,
    label: connector.label,
    description: connector.description,
  }));
  const store = (c: Context) => options.store ?? getConfigStore(c.env as PlatformEnv | undefined);
  const snapshots = (c: Context) =>
    options.snapshots ?? getAgentSnapshotStore(c.env as PlatformEnv | undefined);
  const identity = (c: Context) =>
    options.identity ?? getIdentityStore(c.env as PlatformEnv | undefined);
  const settings = (c: Context) =>
    options.settings ?? getSettingsStore(c.env as PlatformEnv | undefined);
  const composioConfiguration = (c: Context): ComposioConfigurationOptions => ({
    ...options.composioConfiguration,
    settings: settings(c),
    ...(c.env ? { env: c.env as PlatformEnv } : {}),
  });
  const managedProviders = (c: Context): ManagedConnectionProviderRegistry => {
    if (options.managedConnectionProviders) return options.managedConnectionProviders;
    const cached = managedProvidersByContext.get(c);
    if (cached) return cached;
    const created = createDefaultManagedConnectionProviderRegistry(
      c.env as PlatformEnv | undefined,
    );
    managedProvidersByContext.set(c, created);
    return created;
  };
  const resolvedManagedProviderContext = async (
    c: Context,
  ): Promise<ResolvedManagedProviderContext> => {
    if (options.managedConnectionProviders) {
      return {
        providers: options.managedConnectionProviders,
        generation: 1,
        lineage: '0'.repeat(24),
        readOnly: false,
      };
    }
    const cached = resolvedManagedProvidersByContext.get(c);
    if (cached) return cached;
    const resolving = (async (): Promise<ResolvedManagedProviderContext> => {
      let resolved: ResolvedComposioConfiguration;
      try {
        resolved = await resolveComposioConfiguration(composioConfiguration(c));
      } catch (error) {
        if (error instanceof ComposioConfigurationStateError) {
          return {
            providers: createManagedConnectionProviderRegistry([]),
            generation: 1,
            lineage: '0'.repeat(24),
            readOnly: false,
          };
        }
        throw error;
      }
      return {
        providers: createResolvedManagedConnectionProviderRegistry(
          resolved,
          c.env as PlatformEnv | undefined,
        ),
        generation: resolved.generation,
        lineage: resolved.keyFingerprint ?? resolved.lastKeyFingerprint ?? '0'.repeat(24),
        readOnly: resolved.readOnly,
      };
    })();
    resolvedManagedProvidersByContext.set(c, resolving);
    return resolving;
  };
  const resolvedConnectionAccounts = async (c: Context): Promise<ConnectionAccountService> => {
    const providerContext = await resolvedManagedProviderContext(c);
    return connectionAccounts(c, providerContext.providers);
  };
  const slackCredentialDependencies = (
    c: Context,
  ): SlackCredentialDependencies | undefined => {
    if (options.slackCredentials) return options.slackCredentials;
    // Existing route unit tests inject SettingsStore plus a narrow auth-only
    // IdentityStore. They stay on the test-only encrypted compatibility realm;
    // only an explicit credential realm may pair injected state with a keyring.
    if (options.settings) return undefined;
    return getSlackCredentialDependencies(c.env as PlatformEnv | undefined);
  };
  const slackCredentialWriteTarget = (c: Context) =>
    slackCredentialDependencies(c) ?? settings(c);
  const slackCredentialResolutionDependencies = (
    c: Context,
  ): SlackCredentialResolutionDependencies | undefined =>
    options.slackCredentials
      ? options.slackCredentials
      : options.settings
      ? undefined
      : getSlackCredentialResolutionDependencies(c.env as PlatformEnv | undefined);
  const memory = (c: Context) =>
    options.memory ?? getMemoryStateStore(c.env as PlatformEnv | undefined);
  const routines = (c: Context) =>
    options.routines ?? getRoutineStore(c.env as PlatformEnv | undefined);
  const usage = (c: Context) =>
    options.usage ?? getUsageStore(c.env as PlatformEnv | undefined);
  const work = (c: Context) =>
    options.work ?? getWorkStore(c.env as PlatformEnv | undefined);
  const management = (c: Context) =>
    options.management ?? getManagementStore(c.env as PlatformEnv | undefined);
  const managementService = (c: Context) => {
    const env = c.env as PlatformEnv | undefined;
    const identityStore = identity(c);
    const settingsStore = settings(c);
    return createLiveWorkspaceManagementService(env, {
      identity: identityStore,
      settings: settingsStore,
      usage: usage(c),
      overrides: {
        config: store(c),
        management: management(c),
        memory: memory(c),
        routines: routines(c),
        work: work(c),
        setupBaseUrl: requestOrigin(c),
      },
    });
  };
  const sharedManagementEnabled = (!options.store && !options.identity) || Boolean(options.management);
  const slackState = (c: Context) =>
    options.slackState ?? getSlackStateStore(c.env as PlatformEnv | undefined);
  app.use('*', async (c, next) => {
    // Deployment activation has its own short-lived bearer capability and
    // must remain callable while an older release left Admin in recovery.
    if (c.req.path === '/internal/deployment/ready') return next();
    const control = await identity(c).getAuthControl();
    if (control?.healthGate === 'recovery_only' &&
        c.req.path !== '/admin/recovery' &&
        c.req.path !== '/auth/slack/recovery/callback') return c.notFound();
    return next();
  });
  const runtimeDrain = options.runtimeDrain ?? readRuntimeDrainStatus;
  const usageAdminUi = (c: Context): boolean => {
    if (options.usageAdminUi !== undefined) return options.usageAdminUi;
    const platformValue = (c.env as PlatformEnv | undefined)?.USAGE_ADMIN_UI;
    const value = platformValue ?? process.env.USAGE_ADMIN_UI;
    return value === undefined || value === '1' || value === 'true';
  };
  const recoveryToken = (c: Context): string | undefined => {
    if (Object.hasOwn(options, 'recoveryToken')) return options.recoveryToken;
    const bound = (c.env as PlatformEnv | undefined)?.CHICKPEA_RECOVERY_TOKEN;
    return typeof bound === 'string' ? bound : process.env.CHICKPEA_RECOVERY_TOKEN;
  };
  const setupCapability = (c: Context): { digest: string; issuedAt: number } | undefined => {
    const env = c.env as PlatformEnv | undefined;
    const digestValue = env?.[SETUP_CAPABILITY_DIGEST_BINDING] ??
      process.env[SETUP_CAPABILITY_DIGEST_BINDING];
    const issuedValue = env?.[SETUP_CAPABILITY_ISSUED_AT_BINDING] ??
      process.env[SETUP_CAPABILITY_ISSUED_AT_BINDING];
    const digest = typeof digestValue === 'string' ? digestValue : undefined;
    const issuedAt = typeof issuedValue === 'string' || typeof issuedValue === 'number'
      ? Number(issuedValue)
      : Number.NaN;
    return digest && Number.isSafeInteger(issuedAt) ? { digest, issuedAt } : undefined;
  };
  const deploymentActivation = (
    c: Context,
  ): { digest: string; issuedAt: number } | undefined => {
    const env = c.env as PlatformEnv | undefined;
    const digestValue = env?.[DEPLOYMENT_ACTIVATION_DIGEST_BINDING] ??
      process.env[DEPLOYMENT_ACTIVATION_DIGEST_BINDING];
    const issuedValue = env?.[DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING] ??
      process.env[DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING];
    const digest = typeof digestValue === 'string' ? digestValue : undefined;
    const issuedAt = typeof issuedValue === 'string' || typeof issuedValue === 'number'
      ? Number(issuedValue)
      : Number.NaN;
    return digest && Number.isSafeInteger(issuedAt) ? { digest, issuedAt } : undefined;
  };

  // A deploy is not ready merely because one edge serves the new module. For
  // an installed shared Slack gateway, its long-lived Durable Object must also
  // report the same Worker version before the deploy wrapper announces success.
  app.post('/internal/deployment/ready', async (c) => {
    c.header('Cache-Control', 'no-store');
    const authority = deploymentActivation(c);
    const authorization = c.req.header('authorization') ?? '';
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!authority || !match || !await verifyDeploymentActivation({
      capability: match[1]!,
      digest: authority.digest,
      issuedAt: authority.issuedAt,
    })) return c.notFound();

    const targetVersion = c.req.header('x-chickpea-target-version')?.trim();
    const currentVersion = cloudflareWorkerVersionId(c.env);
    if (!targetVersion || !WORKER_VERSION_ID_PATTERN.test(targetVersion)) {
      return c.json({ error: 'invalid_target_version' }, 400);
    }
    if (!currentVersion || currentVersion !== targetVersion) {
      c.header('Retry-After', '1');
      return c.json({ error: 'worker_version_pending' }, 409);
    }

    try {
      const gatewayConfigured = Boolean(
        await settings(c).getSetting(GATEWAY_BINDING_SETTING),
      );
      if (!gatewayConfigured) return c.body(null, 204);
      const gateway = await readGatewaySessionStatus(c.env);
      if (!gateway.healthy || gateway.versionId !== targetVersion) {
        c.header('Retry-After', '1');
        return c.json({ error: gateway.detail ?? 'gateway_session_offline' }, 503);
      }
      return c.body(null, 204);
    } catch {
      c.header('Retry-After', '1');
      return c.json({ error: 'deployment_readiness_unavailable' }, 503);
    }
  });
  const slackApiBaseUrl = (c: Context): string | undefined => {
    const bound = (c.env as PlatformEnv | undefined)?.SLACK_API_URL;
    const value = typeof bound === 'string' ? bound : process.env.SLACK_API_URL;
    const normalized = value?.trim().replace(/\/+$/, '');
    return normalized || undefined;
  };
  const slackInstallService = (c: Context): SlackInstallOAuthService | undefined => {
    const credentials = slackCredentialDependencies(c);
    if (!credentials) return undefined;
    const apiBaseUrl = slackApiBaseUrl(c);
    return new SlackInstallOAuthService({
      identity: identity(c),
      credentials,
      config: store(c),
      settings: settings(c),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(options.slackInstallFetch ? { fetch: options.slackInstallFetch } : {}),
      ...(options.slackInstallNow ? { now: options.slackInstallNow } : {}),
      ...(options.slackInstallRandomBytes ? { randomBytes: options.slackInstallRandomBytes } : {}),
      ...(options.slackInstallationVerification
        ? { verification: options.slackInstallationVerification }
        : {}),
    });
  };
  const slackRecoveryService = (c: Context): SlackCredentialRecoveryService | undefined => {
    const credentials = slackCredentialDependencies(c);
    const token = recoveryToken(c);
    if (!credentials || !token || !isValidRecoveryConfiguration(token)) return undefined;
    return new SlackCredentialRecoveryService({
      identity: identity(c),
      credentials,
      config: store(c),
      settings: settings(c),
      expectedRecoveryToken: token,
      ...(options.slackInstallFetch ? { fetch: options.slackInstallFetch } : {}),
      ...(options.slackInstallNow ? { now: options.slackInstallNow } : {}),
      ...(options.slackInstallRandomBytes ? { randomBytes: options.slackInstallRandomBytes } : {}),
      ...(options.slackInstallationVerification
        ? { verification: options.slackInstallationVerification }
        : {}),
    });
  };
  const slackAdmissionContext = async (c: Context): Promise<{
    service: SlackAdmissionService;
    limiterSecret: string;
  } | undefined> => {
    if (options.slackAdmissionService) {
      const limiterSecret = options.authSecret ?? options.recoveryToken;
      if (!limiterSecret) return undefined;
      return {
        service: options.slackAdmissionService,
        limiterSecret,
      };
    }
    const credentials = slackCredentialDependencies(c);
    if (!credentials) return undefined;
    const identityStore = identity(c);
    const control = await identityStore.getAuthControl();
    const environment = options.betterAuthEnvironment ?? (
      control?.authMode === 'slack_active'
        ? await resolveBetterAuthEnvironment({
            control,
            platformEnv: c.env as PlatformEnv | undefined,
            recoveryToken: recoveryToken(c),
            authSecret: options.authSecret,
          })
        : await resolveBetterAuthBootstrapEnvironment({
            canonicalOrigin: requestOrigin(c),
            platformEnv: c.env as PlatformEnv | undefined,
            recoveryToken: recoveryToken(c),
            authSecret: options.authSecret,
          })
    );
    if (!environment || environment.baseURL !== requestOrigin(c)) return undefined;
    const apiBaseUrl = slackApiBaseUrl(c);
    const gatewayInstallation = (await store(c).listWorkspaceInstallations()).find(
      (installation) => installation.transportMode === 'gateway',
    );
    const gatewayClient = gatewayInstallation
      ? createGatewayDeploymentClient(c.env as PlatformEnv | undefined)
      : undefined;
    const gatewayBinding = gatewayClient ? await gatewayClient.loadBinding() : undefined;
    return {
      service: new SlackAdmissionService({
        identity: identityStore,
        credentials,
        environment,
        onFirstOwnerActivated: async ({ workspaceId, slackUserId }) => {
          await Promise.allSettled([
            beginOnboardingJourney(settings(c)),
            (async () => {
              const resolution = await identityStore.resolveSlackIdentity(workspaceId, slackUserId);
              if (!resolution || resolution.membership.status !== 'active') return;
              await management(c).claimIntroduction({
                organizationId: resolution.membership.organizationId,
                userId: resolution.user.id,
                workspaceId,
                slackUserId,
                trigger: 'first_owner',
                at: Date.now(),
              });
            })(),
          ]);
        },
        ...(gatewayClient && gatewayBinding
          ? {
              gateway: new GatewaySlackOidcProvider(gatewayClient),
              credentialProvider: async () => ({
                appId: gatewayBinding.appId,
                clientId: gatewayBinding.clientId,
                teamId: gatewayBinding.workspaceId,
                connectionRevision: gatewayBinding.bindingId,
              }),
            }
          : {}),
        ...(apiBaseUrl ? { slackApiBaseUrl: apiBaseUrl } : {}),
      }),
      limiterSecret: environment.secret,
    };
  };
  const agentSlackTransport = async (
    c: Context,
    workspaceId: string,
  ): Promise<SlackTransport> => {
    if (typeof options.slackTransport === 'function') {
      return options.slackTransport(workspaceId);
    }
    if (options.slackTransport) return options.slackTransport;
    const installation = await store(c).getWorkspaceInstallation(workspaceId);
    if (!installation) {
      throw new AgentPresenceError(
        'slack_operation_failed',
        'Connect Chickpea to this Slack workspace before publishing an Agent.',
      );
    }
    if (installation.transportMode === 'gateway') {
      return createGatewaySlackTransport(
        createGatewayDeploymentClient(c.env as PlatformEnv | undefined),
      );
    }
    const credentials = await resolveSlackInstallationCredentials(
      WORKSPACE_SLACK_INSTALLATION_ID,
      c.env as PlatformEnv | undefined,
      slackCredentialResolutionDependencies(c) ?? settings(c),
    );
    if (!credentials.botToken) {
      throw new AgentPresenceError(
        'slack_operation_failed',
        'Connect Chickpea to Slack before publishing an Agent.',
      );
    }
    return createDirectSlackTransport(credentials.botToken);
  };
  const ensureGeneratedGatewayAvatar = async (
    c: Context,
    current: CustomAgentConfig,
    workspaceId: string,
  ): Promise<CustomAgentConfig> => {
    const avatar = current.slackPresence?.avatar;
    if (avatar?.kind !== 'generated') return current;
    const installation = await store(c).getWorkspaceInstallation(workspaceId);
    if (installation?.transportMode !== 'gateway') return current;
    const injectedPublish = options.gatewayAvatarPublish;
    let publish: (input: GeneratedAgentAvatarPublishInput) => Promise<string>;
    if (injectedPublish) {
      publish = (candidate) => injectedPublish({
        workspaceId: installation.workspaceId,
        ...candidate,
      });
    } else {
      const gateway = createGatewayDeploymentClient(c.env as PlatformEnv | undefined);
      publish = (candidate) => gateway.publishAvatar({
        workspaceId: installation.workspaceId,
        ...candidate,
      });
    }
    const published = await publishGeneratedAgentAvatar({
      agentId: current.id,
      revision: avatar.revision,
      seed: avatar.seed ?? current.id,
      publish,
    });
    if (avatar.revision === published.revision && avatar.url === published.url) return current;
    return store(c).updateAgent(current.id, {
      slackPresence: {
        ...current.slackPresence!,
        avatar: {
          ...avatar,
          revision: published.revision,
          url: published.url,
        },
      },
    }, current.revision);
  };
  const slackWorkspaceDescriptor = async (c: Context): Promise<{
    teamId: string;
    teamName?: string;
  } | undefined> => {
    const organization = await identity(c).getOrganization();
    if (!organization?.slackTeamId) return undefined;
    const teamId = organization.slackTeamId;
    if (options.slackAdmissionService && !options.slackCredentials && !options.slackTransport) {
      return { teamId };
    }
    const settingsStore = settings(c);
    const storedTeamName = (await settingsStore.getSetting(SLACK_SETTING_KEYS.teamName))?.trim();
    if (storedTeamName) return { teamId, teamName: storedTeamName };

    const installation = await store(c).getWorkspaceInstallation(teamId);
    if (installation || options.slackTransport) {
      try {
        const transport = await agentSlackTransport(c, teamId);
        const live = await transport.getWorkspaceInfo?.();
        if (live?.teamId === teamId && live.teamName?.trim()) {
          const teamName = live.teamName.trim().slice(0, 120);
          await settingsStore.setSetting(SLACK_SETTING_KEYS.teamName, teamName);
          return { teamId, teamName };
        }
      } catch {
        // Workspace metadata is presentation-only. Keep the connected install
        // usable when Slack or the private gateway cannot answer this backfill.
      }
    }

    const credentials = slackCredentialDependencies(c);
    if (!credentials) return { teamId };
    try {
      const resolved = await resolveSlackInstallationCredentials(
        WORKSPACE_SLACK_INSTALLATION_ID,
        c.env as PlatformEnv | undefined,
        credentials,
      );
      if (!resolved.botToken) return { teamId };
      const live = await slackAuthTest(resolved.botToken);
      if (live.ok && live.teamId === teamId && live.teamName?.trim()) {
        const teamName = live.teamName.trim().slice(0, 120);
        await settingsStore.setSetting(SLACK_SETTING_KEYS.teamName, teamName);
        return { teamId, teamName };
      }
      return { teamId };
    } catch {
      return { teamId };
    }
  };
  const discoverSlackChannels = async (
    c: Context,
  ): Promise<{
    channels: SlackChannelSummary[];
    truncated: boolean;
    connected: boolean;
    teamInfo: SlackTeamInfo;
  }> => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const [installations, credentials] = await Promise.all([
      store(c).listWorkspaceInstallations(),
      resolveSlackCredentials(
        platformEnv,
        settingsStore,
        slackCredentialResolutionDependencies(c),
      ),
    ]);
    let descriptor: { teamId: string; teamName?: string } | undefined;
    try {
      descriptor = await slackWorkspaceDescriptor(c);
    } catch {
      // Token-authenticated fixtures can predate organization metadata.
    }
    const installation = installations.find(({ workspaceId, health }) =>
      health !== 'revoked' && (!descriptor || workspaceId === descriptor.teamId)
    );
    const workspaceId = descriptor?.teamId ?? installation?.workspaceId;
    const connected = Boolean(
      (options.slackTransport && workspaceId) || installation || credentials.botToken,
    );

    if (workspaceId && (options.slackTransport || installation)) {
      try {
        const listed = await (await agentSlackTransport(c, workspaceId)).listChannels();
        return {
          channels: listed.channels
            .filter(({ archived }) => !archived)
            .map((channel) => ({
              id: channel.id,
              name: channel.name ?? channel.id,
              isPrivate: channel.private,
              isMember: channel.member,
            })),
          truncated: listed.truncated,
          connected,
          teamInfo: { teamId: workspaceId, teamName: descriptor?.teamName },
        };
      } catch (error) {
        // A legacy direct install can have a valid token before it has a
        // WorkspaceInstallation record. Keep that narrow fallback operational.
        if (!credentials.botToken) throw error;
      }
    }

    if (credentials.botToken) {
      const listed = await listSlackChannels(credentials.botToken, {
        refresh: c.req.query('refresh') === '1',
      });
      const teamInfo = await resolveTeamInfoSafely(
        platformEnv,
        settingsStore,
        slackCredentialResolutionDependencies(c),
      );
      return { ...listed, connected: true, teamInfo };
    }
    return {
      channels: [],
      truncated: false,
      connected,
      teamInfo: { teamId: workspaceId, teamName: descriptor?.teamName },
    };
  };
  const agentActor = async (c: Context): Promise<{
    principal: AuthPrincipal;
    slackUserId: string;
    slackTeamId: string;
  }> => {
    const principal = principalByContext.get(c);
    if (!principal) throw new AuthorizationError('principal_required');
    const membership = await identity(c).getMembership(principal.membershipId);
    const user = membership ? await identity(c).getUser(membership.userId) : undefined;
    if (!membership || membership.status !== 'active' || !user) throw new AuthorizationError();
    return { principal, slackUserId: user.slackUserId, slackTeamId: user.slackTeamId };
  };
  const privateAgentAudience = async (
    c: Context,
    agent: CustomAgentConfig,
  ): Promise<PrivateAgentAudience> => {
    try {
      const actor = await agentActor(c);
      const grants = await store(c).listAgentChannelGrants(actor.slackTeamId);
      const activeAgentGrants = grants.filter((grant) =>
        grant.agentId === agent.id && grant.status === 'active'
      );
      return resolvePrivateAgentAudience({
        agent,
        workspaceId: actor.slackTeamId,
        grants,
        ...(activeAgentGrants.length > 0
          ? { transport: await agentSlackTransport(c, actor.slackTeamId) }
          : {}),
      });
    } catch {
      console.warn('[chickpea] Agent private-use audience unavailable');
      return 'unavailable';
    }
  };
  const routineAccessByContext = new WeakMap<object, RoutineContentAccessResolver>();
  const routineContentAccess = (c: Context): RoutineContentAccessResolver => {
    const current = routineAccessByContext.get(c);
    if (current) return current;
    const created = new RoutineContentAccessResolver({
      work: work(c),
      actor: async () => {
        const actor = await agentActor(c);
        return { slackTeamId: actor.slackTeamId, slackUserId: actor.slackUserId };
      },
      transport: (workspaceId) => agentSlackTransport(c, workspaceId),
    });
    routineAccessByContext.set(c, created);
    return created;
  };
  const connectionAccounts = (
    c: Context,
    providers: ManagedConnectionProviderRegistry = managedProviders(c),
  ): ConnectionAccountService =>
    new ConnectionAccountService({
      config: store(c),
      settings: settings(c),
      managedProviders: providers,
      managedCatalog,
    });
  const resumeComposioReconciliation = async (
    c: Context,
    requestSignal?: AbortSignal,
  ) => {
    let resolved = await resolveComposioConfiguration(composioConfiguration(c));
    if (!resolved.reconciliationPending) return resolved;
    if (resolved.desiredState === 'disabled' || !resolved.apiKey) {
      const marked = await markManagedProviderAccountsUnavailable(
        store(c),
        { adapterId: 'composio' },
      );
      if (marked.retryable === 0) {
        await completeComposioReconciliation(resolved.generation, composioConfiguration(c));
        return resolveComposioConfiguration(composioConfiguration(c));
      }
      return resolved;
    }
    const reconciliationSignal = requestSignal ?? AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(options.composioReconciliationTimeoutMs ?? 30_000),
      ]);
    const inspect = options.composioInspectAccount
      ? ({ accountRef, principalRef, toolkit }: {
          accountRef: string;
          principalRef: string;
          toolkit: string;
        }) => inspectionWithinSignal(reconciliationSignal, () =>
          options.composioInspectAccount!({
            apiKey: resolved.apiKey!, accountRef, principalRef, toolkit,
            signal: reconciliationSignal,
          }))
      : async ({ accountRef, principalRef, toolkit }: {
          accountRef: string;
          principalRef: string;
          toolkit: string;
        }) => inspectionWithinSignal(reconciliationSignal, () =>
          inspectComposioConnectedAccount({
            apiKey: resolved.apiKey!, accountRef, principalRef, toolkit,
            signal: reconciliationSignal,
          }));
    while (!reconciliationSignal.aborted) {
      const inspected = await reconcileManagedProviderAccounts(store(c), {
        adapterId: 'composio',
        generation: resolved.generation,
        lineage: resolved.keyFingerprint ?? resolved.lastKeyFingerprint ?? '0'.repeat(24),
        inspect,
        maxInspections: 25,
      });
      if (inspected.retryable === 0) {
        await completeComposioReconciliation(resolved.generation, composioConfiguration(c));
        resolved = await resolveComposioConfiguration(composioConfiguration(c));
        break;
      }
      // A successful batch means more stale accounts may remain beyond the
      // cap. Continue inside the same bounded request. Zero progress means the
      // remaining work is transient or revision-conflicted and needs a retry.
      if (inspected.restored + inspected.needsAttention === 0) break;
    }
    return resolved;
  };
  const managedConnectionAccount = async (
    c: Context,
    agentId: string,
    connectionAccountId: string,
    requireEnabledBinding = true,
  ): Promise<{
    principal: AuthPrincipal;
    account: ConnectionAccount;
    binding?: AgentConnectionBinding;
  }> => {
    const principal = principalByContext.get(c);
    if (!principal) throw new AuthorizationError('principal_required');
    const agent = await store(c).getAgent(agentId);
    requireAgentEdit(principal, agent);
    const account = await connectionAccounts(c).getForManagement(principal, connectionAccountId);
    const binding = (await store(c).listAgentConnectionBindings(agentId)).find(
      (candidate) => candidate.connectionAccountId === account.id && candidate.enabled,
    );
    if (requireEnabledBinding && !binding) throw new AuthorizationError();
    const organization = await identity(c).getOrganization();
    if (organization?.slackTeamId !== account.workspaceId) throw new AuthorizationError();
    return { principal, account, ...(binding ? { binding } : {}) };
  };
  const agentPresenceFailureResponse = async (
    c: Context,
    agentId: string,
    error: unknown,
  ): Promise<Response> => {
    const classified = classifyAgentPresenceError(error);
    const agent = await store(c).getAgent(agentId);
    const handle = agent.slackPresence?.normalizedHandle ?? normalizeAgentHandle(agent.name);
    const status = classified.code === 'rate_limited'
      ? 429
      : classified.code === 'slack_unavailable'
      ? 503
      : 409;
    return c.json({
      error: classified.code,
      message: classified.message,
      retryable: classified.retryable,
      suggestions: classified.suggestions,
      recovery: agentPresenceRecovery(classified, handle),
      agent: await agentAdminProjection(agent, store(c), snapshots(c)),
    }, status);
  };
  const authRateLimiter = (c: Context, token: string): AuthRateLimiter =>
    options.authRateLimiter ?? new AuthRateLimiter(identity(c), { pepper: token });
  const recordSandboxAudit = async (
    c: Context,
    action: 'sandbox.install.request' | 'sandbox.install.cancel' |
      'sandbox.runtime.enable' | 'sandbox.runtime.disable' | 'sandbox.advanced.update',
    outcome: 'success' | 'denied',
    reasonCode?: string,
  ): Promise<void> => {
    const principal = principalByContext.get(c);
    await identity(c).recordAuthAudit({
      event: 'authorization',
      outcome,
      action,
      correlationId: principal?.correlationId ?? randomUUID(),
      authenticatorKind: principal?.authenticatorKind ?? 'unavailable',
      ...(principal
        ? { userId: principal.userId, membershipId: principal.membershipId }
        : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
  };
  const betterAuthContext = (c: Context): Promise<BetterAuthContext | undefined> => {
    const cached = betterAuthByContext.get(c);
    if (cached) return cached;
    const pending = (async () => {
      const identityStore = identity(c);
      const control = await identityStore.getAuthControl();
      if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
          !control.betterAuthOrganizationId ||
          !control.canonicalAdminOrigin) return undefined;
      const environment = options.betterAuthEnvironment ?? await resolveBetterAuthEnvironment({
          control,
          platformEnv: c.env as PlatformEnv | undefined,
          recoveryToken: recoveryToken(c),
        });
      if (!environment) return undefined;
      if (environment.baseURL !== control.canonicalAdminOrigin) return undefined;
      return {
        environment,
        directory: new BetterAuthDirectory({
          backend: environment.backend,
          access: identityStore,
          organizationId: control.betterAuthOrganizationId,
          canonicalAdminOrigin: control.canonicalAdminOrigin,
        }),
        organizationId: control.betterAuthOrganizationId,
      };
    })();
    betterAuthByContext.set(c, pending);
    return pending;
  };
  const humanDirectory = async (c: Context): Promise<HumanIdentityDirectory> =>
    (await betterAuthContext(c))?.directory ?? identity(c);
  const configuredAuthService = async (c: Context): Promise<AdminAuthenticationService | undefined> => {
    if (options.authService) return options.authService;
    const identityStore = identity(c);
    const context = await betterAuthContext(c);
    if (context) {
      const { environment, directory, organizationId } = context;
      return new AuthService({
        identity: identityStore,
        sessionAuthenticator: new BetterAuthSessionAuthenticator({
          ...environment,
          directory,
          organizationId,
        }),
        personalTokens: new PersonalTokenService(identityStore, { directory }),
      });
    }
    const organization = await identityStore.getOrganization();
    if (!organization) return undefined;
    const control = await identityStore.getAuthControl();
    console.error('[chickpea] Admin authentication is not configured:', JSON.stringify({
      authMode: control?.authMode ?? 'missing',
      healthGate: control?.healthGate ?? 'missing',
      canonicalOrigin: Boolean(control?.canonicalAdminOrigin),
      betterAuthOrganization: Boolean(control?.betterAuthOrganizationId),
    }));
    return undefined;
  };
  const modelProviders = () =>
    options.knownProviders
      ? listRuntimeModelProviders({ registeredProviders: options.knownProviders })
      : listRuntimeModelProviders();
  const providerIds = () => options.knownProviders ?? knownProviderIds();
  // Default to the shared connect+discover routine; tests inject a mock so no
  // real network connect is attempted (same seam idea as the store/settings).
  const discoverMcp = (input: McpConnectInput): Promise<McpDiscoveryResult> =>
    (options.discoverMcp ?? discoverMcpTools)(input);
  const startMcpOAuth = options.startMcpOAuth ?? startMcpOAuthAuthorization;
  const completeMcpOAuth =
    options.completeMcpOAuth ?? completeMcpOAuthAuthorization;
  const cancelMcpOAuth = options.cancelMcpOAuth ?? cancelMcpOAuthAuthorization;
  const resolveMcpOAuthToken =
    options.resolveMcpOAuthToken ?? resolveMcpOAuthAccessToken;
  const identifyMcp = options.identifyMcp ?? discoverMcpConnectionIdentity;
  const startApiOAuth = options.startApiOAuth ?? startApiOAuthAuthorization;
  const completeApiOAuth = options.completeApiOAuth ?? completeApiOAuthAuthorization;
  const cancelApiOAuth = options.cancelApiOAuth ?? cancelApiOAuthAuthorization;
  const oauthDependencies = (c: Context): McpOAuthDependencies => ({
    settings: settings(c),
    ...(options.oauthFetch ? { fetchFn: options.oauthFetch } : {}),
    validateConnection: async (ref, serverUrl, accountRevision, oauthAttemptId) => {
      const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
      if (connectionAccountId) {
        const account = await findConnectionAccount(store(c), connectionAccountId);
        if (!account || account.lifecycle === 'revoked' || !isMcpOAuthAccount(account, serverUrl)) {
          return false;
        }
        if (accountRevision !== undefined && account.revision !== accountRevision) {
          throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
        }
        if (oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId) {
          throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
        }
        return true;
      }
      return isCurrentMcpOAuthConnection(store(c), ref, serverUrl);
    },
    onReauthorizationRequired: async (ref, serverUrl) => {
      const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
      if (connectionAccountId) {
        const account = await findConnectionAccount(store(c), connectionAccountId);
        if (!account || account.lifecycle === 'revoked' ||
            !isMcpOAuthAccount(account, serverUrl)) return;
        await store(c).putConnectionAccount(
          { ...account, lifecycle: 'needs_attention' },
          account.revision,
        );
        return;
      }
      await store(c).markOAuthReauthorizationRequired({
        lane: 'mcp',
        ...ref,
        serverUrl,
      });
    },
  });
  const apiOAuthDependencies = (c: Context): ApiOAuthDependencies => ({
    settings: settings(c),
    ...(options.oauthFetch ? { fetchFn: options.oauthFetch } : {}),
    validateConnection: async (ref, provider, accountRevision, oauthAttemptId) => {
      const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
      if (connectionAccountId) {
        const account = await findConnectionAccount(store(c), connectionAccountId);
        if (!account || account.lifecycle === 'revoked' || !isApiOAuthAccount(account, provider)) {
          return false;
        }
        if (accountRevision !== undefined && account.revision !== accountRevision) {
          throw new ApiOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
        }
        if (oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId) {
          throw new ApiOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
        }
        return true;
      }
      return isCurrentApiOAuthConnection(store(c), ref, provider);
    },
    onReauthorizationRequired: async (ref, provider) => {
      const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
      if (connectionAccountId) {
        const account = await findConnectionAccount(store(c), connectionAccountId);
        if (!account || account.lifecycle === 'revoked' ||
            !isApiOAuthAccount(account, provider)) return;
        await store(c).putConnectionAccount(
          { ...account, lifecycle: 'needs_attention' },
          account.revision,
        );
        return;
      }
      await store(c).markOAuthReauthorizationRequired({
        lane: 'api',
        ...ref,
        provider,
      });
    },
  });
  const openAiSubscriptionDependencies = (
    c: Context,
  ): OpenAiSubscriptionAuthorizationDependencies => ({
    settings: settings(c),
    ...(options.openAiSubscriptionProtocol
      ? { protocol: options.openAiSubscriptionProtocol }
      : {}),
    ...(options.openAiSubscriptionNow ? { now: options.openAiSubscriptionNow } : {}),
    ...(options.openAiSubscriptionRandomBytes
      ? { randomBytes: options.openAiSubscriptionRandomBytes }
      : {}),
  });
  const refreshCatalog = async (
    c: Context,
    force: boolean,
  ): Promise<ModelCatalogRefreshResult> => {
    try {
      return await (options.modelCatalogRefresh ?? refreshModelCatalog)({
        settings: settings(c),
        force,
        ...(options.modelCatalogNow ? { now: options.modelCatalogNow } : {}),
        ...(options.modelCatalogRandom ? { random: options.modelCatalogRandom } : {}),
        ...(options.modelCatalogOwnerId ? { ownerId: options.modelCatalogOwnerId() } : {}),
        ...(options.modelCatalogFetch ? { fetch: options.modelCatalogFetch } : {}),
        ...(options.modelCatalogTimeoutMs !== undefined
          ? { timeoutMs: options.modelCatalogTimeoutMs }
          : {}),
      });
    } catch {
      return {
        status: 'failed',
        revision: activeModelCatalogSnapshot().revision,
        code: 'unavailable',
      };
    }
  };
  const slackInstallationAdminBodyLimit = bodyLimit({
    maxSize: MAX_SLACK_INSTALLATION_ADMIN_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  const authSetupBodyLimit = bodyLimit({
    maxSize: MAX_AUTH_SETUP_BODY_BYTES,
    onError: (c) => c.json({ error: 'invalid_request' }, 413),
  });
  const adminMutationBodyLimit = bodyLimit({
    maxSize: MAX_ADMIN_MUTATION_BODY_BYTES,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  });
  const requireAdminUserAgent = async (
    c: Context,
    agentId: string,
  ): Promise<CustomAgentConfig> => {
    const agent = await store(c).getAgent(agentId);
    if (agent.kind !== 'user') throw new UnknownAgentError(agentId);
    return agent;
  };
  const enforceAgentRouteAuthority = async (
    c: Context,
    principal: AuthPrincipal,
  ): Promise<void> => {
    const match = c.req.path.match(/^\/admin\/api\/agents\/([^/]+)/);
    if (!match) return;
    const agentId = decodeURIComponent(match[1]!);
    const agent = await requireAdminUserAgent(c, agentId);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      requireAgentEdit(principal, agent);
    }
  };
  const enforceAgentMemoryAuthority = async (
    c: Context,
    principal: AuthPrincipal,
  ): Promise<void> => {
    const match = c.req.path.match(
      /^\/admin\/api\/audit\/memory\/owners\/([^/]+)\/[^/]+\/([^/]+)(?:\/|$)/,
    );
    if (!match) return;
    const ownerKind = decodeURIComponent(match[1]!);
    if (ownerKind !== 'agent') {
      throw new AuthorizationError();
    }
    requireAgentEdit(
      principal,
      await requireAdminUserAgent(c, decodeURIComponent(match[2]!)),
    );
  };

  const adminGate = async (c: Context, next: Next) => {
    let authService: AdminAuthenticationService | undefined;
    try {
      authService = await configuredAuthService(c);
    } catch (error) {
      console.error(
        '[chickpea] Admin authentication initialization failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    if (authService) {
      try {
        const principal = await authService.authenticateRequest(c.req.raw);
        copyAuthResponseCookies(c, authService.takeResponseHeaders?.(c.req.raw));
        principalByContext.set(c, principal);
        setRequestPrincipal(c.req.raw, principal);
        const permission = permissionForAdminRequest(c, principal);
        try {
          if (principal.machine && !machinePrincipalAllowed(c)) throw new AuthorizationError();
          requirePermission(principal, permission);
          await enforceAgentRouteAuthority(c, principal);
          await enforceAgentMemoryAuthority(c, principal);
          await identity(c).recordAuthAudit({
            event: 'authorization',
            outcome: 'success',
            action: permission,
            correlationId: principal.correlationId,
            authenticatorKind: principal.authenticatorKind,
            userId: principal.userId,
            membershipId: principal.membershipId,
          });
        } catch (error) {
          if (error instanceof AuthorizationError) {
            await identity(c).recordAuthAudit({
              event: 'authorization',
              outcome: 'denied',
              action: permission,
              correlationId: principal.correlationId,
              authenticatorKind: principal.authenticatorKind,
              userId: principal.userId,
              membershipId: principal.membershipId,
              reasonCode: 'permission_denied',
            });
          }
          throw error;
        }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
          const origin = (await betterAuthContext(c))?.environment.baseURL ??
            (await identity(c).getOrganization())?.canonicalAdminOrigin;
          if (!origin) throw new AuthDeniedError();
          if (isHumanAuthFormMutation(c)) {
            const formFailure = authFormPostFailureReason(c, origin);
            if (formFailure) {
              if (formFailure === 'content_length') {
                return c.json({ error: 'request_too_large' }, 413);
              }
              if (formFailure === 'content_type') {
                return c.json({ error: 'unsupported_media_type' }, 415);
              }
              return c.json({ error: 'forbidden' }, 403);
            }
            return next();
          }
          const provenance = validateMutationProvenance(c.req.raw, principal, {
            canonicalOrigin: origin,
            maxBodyBytes: MAX_ADMIN_MUTATION_BODY_BYTES,
            requireJson: c.req.method !== 'DELETE',
          });
          if (!provenance.ok) {
            if (provenance.code === 'body_too_large') {
              return c.json({ error: 'request_too_large' }, 413);
            }
            if (provenance.code === 'content_type_denied') {
              return c.json({ error: 'unsupported_media_type' }, 415);
            }
            return c.json({ error: 'forbidden' }, 403);
          }
        }
        return next();
      } catch (error) {
        if (error instanceof UnknownAgentError) {
          return c.json({ error: 'not_found' }, 404);
        }
        if (error instanceof AuthorizationError) {
          return c.json({ error: 'forbidden' }, 403);
        }
        if (isAdminPageGet(c)) {
          authResponseHeaders(c);
          const query = new URLSearchParams({ destination: safeAdminReturnPath(c.req.path) });
          return c.redirect(`/auth/slack/sign-in?${query.toString()}`, 303);
        }
        return c.json({ error: 'unauthorized' }, 401);
      }
    }
    return c.json({ error: 'authentication_unavailable' }, 503);
  };

  const completeGithubSetupCallback = async (c: Context): Promise<Response> => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const parsed = v.safeParse(githubCallbackSchema, { code: c.req.query('code') });
    if (!parsed.success) return invalidRequest(c);
    try {
      const state = c.req.query('state')?.trim() ?? '';
      const setupState = await consumeGithubSetupState(settings(c), state);
      if (!setupState) return c.json({ error: 'invalid_setup_state' }, 403);
      if (setupState.membershipId) {
        const membership = (await (await humanDirectory(c)).listMemberships()).find(
          (candidate) => candidate.id === setupState.membershipId,
        );
        if (!membership || membership.status !== 'active' ||
            !['owner', 'admin'].includes(membership.role)) {
          return c.json({ error: 'invalid_setup_state' }, 403);
        }
      }
      const conversion = await exchangeGithubAppManifest(parsed.output.code);
      await settings(c).applySettingsPatch({
        set: [
          { key: GITHUB_SETTING_KEYS.appId, value: String(conversion.id) },
          { key: GITHUB_SETTING_KEYS.appSlug, value: conversion.slug },
          {
            key: GITHUB_SETTING_KEYS.privateKey,
            value: normalizePrivateKeyPem(conversion.privateKeyPem),
          },
          ...(conversion.webhookSecret
            ? [{ key: GITHUB_SETTING_KEYS.webhookSecret, value: conversion.webhookSecret }]
            : []),
        ],
        ...(conversion.webhookSecret ? {} : { delete: [GITHUB_SETTING_KEYS.webhookSecret] }),
      });
      return c.redirect(
        `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`,
        302,
      );
    } catch (error) {
      return internalError(c, error);
    }
  };

  const beginSlackInstall = async (c: Context, resume: boolean): Promise<Response> => {
    authResponseHeaders(c);
    const authority = setupCapability(c);
    const service = slackInstallService(c);
    if (!authority || !service) return c.notFound();
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, authority.digest);
    let setup: SlackSetupTransaction | undefined;
    try {
      await Promise.all([
        limiter.assertAllowed('slack_install_start_source', source),
        limiter.assertAllowed('slack_install_start_deployment', 'deployment'),
      ]);
      if (!validAuthFormPost(c, requestOrigin(c))) throw new AuthDeniedError();
      const form = await readForm(c);
      setup = await openSlackSetupTransaction(identity(c), {
        capability: boundedSetupField(form.capability, 512),
        authority,
        canonicalAdminOrigin: requestOrigin(c),
        ...(form.destination === undefined ? {} : { destination: form.destination }),
        ...(options.slackInstallNow ? { now: options.slackInstallNow } : {}),
      });
      await limiter.assertAllowed('slack_install_start_operation', setup.id);
      const browserBinding = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
      const startInput = {
        setupId: setup.id,
        expectedSetupRevision: setup.revision,
        browserBinding,
        redirectUri: `${requestOrigin(c)}/auth/slack/install/callback`,
        destination: setup.destination,
      };
      const started = resume
        ? await service.resume(startInput)
        : await service.start(startInput);
      setCookie(c, SLACK_INSTALL_BROWSER_COOKIE, browserBinding, {
        path: '/auth/slack/install',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: Math.max(
          1,
          Math.floor((started.expiresAt - (options.slackInstallNow?.() ?? Date.now())) / 1_000),
        ),
      });
      await Promise.all([
        limiter.recordSuccess('slack_install_start_source', source),
        limiter.recordSuccess('slack_install_start_operation', setup.id),
      ]);
      return c.html(renderSlackAuthorizationHandoffPage(started.authorizationUrl));
    } catch (error) {
      await limiter.recordFailure('slack_install_start_source', source);
      if (setup) await limiter.recordFailure('slack_install_start_operation', setup.id);
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
        return c.json({ error: 'rate_limited' }, 429);
      }
      return c.json({ error: slackInstallPublicError(error) }, slackInstallHttpStatus(error));
    }
  };

  // Slack redirects here without a Chickpea session. The callback's only
  // browser authority is the independent narrow cookie plus hashed OAuth
  // state; neither endpoint is routed through Better Auth or the Admin gate.
  app.use('/auth/slack/install/*', authSetupBodyLimit);
  app.get('/auth/slack/continue.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    return c.body(slackAuthorizationHandoffScript());
  });
  app.post('/auth/slack/install/start', (c) => beginSlackInstall(c, false));
  app.post('/auth/slack/install/resume', (c) => beginSlackInstall(c, true));
  app.post('/auth/slack/install/finalize', async (c) => {
    authResponseHeaders(c);
    const authority = setupCapability(c);
    const service = slackInstallService(c);
    if (!authority || !service) return c.notFound();
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, authority.digest);
    let setup: SlackSetupTransaction | undefined;
    try {
      await Promise.all([
        limiter.assertAllowed('slack_install_finalize_source', source),
        limiter.assertAllowed('slack_install_finalize_deployment', 'deployment'),
      ]);
      if (!validAuthFormPost(c, requestOrigin(c))) throw new AuthDeniedError();
      const form = await readForm(c);
      setup = await openSlackSetupTransaction(identity(c), {
        capability: boundedSetupField(form.capability, 512),
        authority,
        canonicalAdminOrigin: requestOrigin(c),
        ...(form.destination === undefined ? {} : { destination: form.destination }),
        ...(options.slackInstallNow ? { now: options.slackInstallNow } : {}),
      });
      await limiter.assertAllowed('slack_install_finalize_operation', setup.id);
      const result = await service.finalizeWaitingInstallation(setup.id);
      await Promise.all([
        limiter.recordSuccess('slack_install_finalize_source', source),
        limiter.recordSuccess('slack_install_finalize_operation', setup.id),
      ]);
      return c.redirect(slackInstallResultRedirect(result), 303);
    } catch (error) {
      await limiter.recordFailure('slack_install_finalize_source', source);
      if (setup) await limiter.recordFailure('slack_install_finalize_operation', setup.id);
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
        return c.json({ error: 'rate_limited' }, 429);
      }
      return c.json({ error: slackInstallPublicError(error) }, slackInstallHttpStatus(error));
    }
  });
  app.get('/auth/slack/install/callback', async (c) => {
    authResponseHeaders(c);
    const authority = setupCapability(c);
    const service = slackInstallService(c);
    if (!authority || !service) return c.notFound();
    const state = c.req.query('state')?.trim() ?? '';
    const code = c.req.query('code')?.trim();
    const providerError = c.req.query('error')?.trim();
    const browserBinding = getCookie(c, SLACK_INSTALL_BROWSER_COOKIE) ?? '';
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, authority.digest);
    if (state.length < 32 || state.length > 512 ||
        (code !== undefined && code.length > 2_048) ||
        (providerError !== undefined && providerError.length > 128) ||
        browserBinding.length > 512) {
      clearSlackInstallBrowserCookie(c);
      return c.json({ error: 'invalid_state' }, 400);
    }
    try {
      await Promise.all([
        limiter.assertAllowed('slack_install_callback_source', source),
        limiter.assertAllowed('slack_install_callback_operation', state),
        limiter.assertAllowed('slack_install_callback_deployment', 'deployment'),
      ]);
      const result = await service.callback({
        state,
        browserBinding,
        redirectUri: `${requestOrigin(c)}/auth/slack/install/callback`,
        ...(code === undefined ? {} : { code }),
        ...(providerError === undefined ? {} : { error: providerError }),
      });
      clearSlackInstallBrowserCookie(c);
      await Promise.all([
        limiter.recordSuccess('slack_install_callback_source', source),
        limiter.recordSuccess('slack_install_callback_operation', state),
      ]);
      return c.redirect(slackInstallResultRedirect(result), 303);
    } catch (error) {
      await Promise.all([
        limiter.recordFailure('slack_install_callback_source', source),
        limiter.recordFailure('slack_install_callback_operation', state),
      ]);
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
        return c.json({ error: 'rate_limited' }, 429);
      }
      if (!(error instanceof SlackInstallOAuthError) ||
          !['slack_unreachable', 'processing'].includes(error.code)) {
        clearSlackInstallBrowserCookie(c);
      }
      return c.json({ error: slackInstallPublicError(error) }, slackInstallHttpStatus(error));
    }
  });

  // Sign in with Slack is a separate confidential OIDC grant. Its cookie is
  // narrower than the bot-install cookie and carries only the raw nonce plus
  // an independent browser binding; TAG_STATE stores their hashes.
  app.use('/auth/slack/oidc/*', authSetupBodyLimit);
  app.use('/auth/slack/invite', authSetupBodyLimit);
  app.use('/auth/slack/invite/*', authSetupBodyLimit);
  app.get('/auth/slack/invite/client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    return c.body(slackInvitationClientScript());
  });
  app.get('/auth/slack/invite', async (c) => {
    authResponseHeaders(c);
    const context = await slackAdmissionContext(c).catch(() => undefined);
    const workspace = context
      ? await slackWorkspaceDescriptor(c).catch(() => undefined)
      : undefined;
    if (!context || !workspace) return c.notFound();
    return c.html(renderSlackInvitationPage(workspace));
  });
  app.get('/auth/slack/sign-in', async (c) => {
    authResponseHeaders(c);
    const context = await slackAdmissionContext(c).catch(() => undefined);
    if (!context) return c.notFound();
    return c.html(renderSlackSignInPage(safeSlackLoginDestination(c.req.query('destination'))), 401);
  });
  app.post('/auth/slack/oidc/start', async (c) => {
    authResponseHeaders(c);
    const context = await slackAdmissionContext(c).catch(() => undefined);
    if (!context) return c.notFound();
    if (!validAuthFormPost(c, requestOrigin(c))) return c.json({ error: 'forbidden' }, 403);
    const form = await readForm(c);
    const purpose = form.purpose === 'first_owner' ? 'first_owner' :
      form.purpose === 'login' ? 'login' :
      form.purpose === 'invitation' ? 'invitation' : undefined;
    if (!purpose) return c.json({ error: 'invalid_state' }, 400);
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, context.limiterSecret);
    const browserBinding = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    let operationKey = purpose;
    let retryDestination = '/admin';
    try {
      await Promise.all([
        limiter.assertAllowed('slack_oidc_start_source', source),
        limiter.assertAllowed('slack_oidc_start_deployment', 'deployment'),
      ]);
      let started;
      if (purpose === 'first_owner') {
        const authority = setupCapability(c);
        if (!authority) return c.notFound();
        const setup = await openSlackSetupTransaction(identity(c), {
          capability: boundedSetupField(form.capability, 512),
          authority,
          canonicalAdminOrigin: requestOrigin(c),
          ...(form.destination === undefined ? {} : { destination: form.destination }),
        });
        operationKey = setup.id;
        retryDestination = setup.destination;
        await limiter.assertAllowed('slack_oidc_start_operation', operationKey);
        started = await context.service.startFirstOwner({
          setupId: setup.id,
          expectedSetupRevision: setup.revision,
          browserBinding,
          redirectUri: `${requestOrigin(c)}/auth/slack/oidc/callback`,
          destination: setup.destination,
        });
      } else if (purpose === 'login') {
        operationKey = 'login';
        retryDestination = safeSlackLoginDestination(form.destination);
        await limiter.assertAllowed('slack_oidc_start_operation', operationKey);
        started = await context.service.startLogin({
          browserBinding,
          redirectUri: `${requestOrigin(c)}/auth/slack/oidc/callback`,
          destination: safeSlackLoginDestination(form.destination),
        });
      } else {
        const locator = form.invitation?.trim() ?? '';
        if (locator.length < 32 || locator.length > 512 || /\s/.test(locator)) {
          throw new SlackOidcError('invalid_state');
        }
        operationKey = createHash('sha256').update(locator).digest('hex');
        retryDestination = '/admin/team';
        await limiter.assertAllowed('slack_oidc_start_operation', operationKey);
        started = await context.service.startInvitation({
          locator,
          browserBinding,
          redirectUri: `${requestOrigin(c)}/auth/slack/oidc/callback`,
          destination: '/admin/team',
        });
      }
      setCookie(c, SLACK_OIDC_BROWSER_COOKIE,
        encodeSlackOidcCookie(purpose, browserBinding, started.nonce, retryDestination), {
          path: '/auth/slack/oidc', httpOnly: true, secure: true, sameSite: 'Lax',
          maxAge: Math.max(1, Math.floor((started.expiresAt - Date.now()) / 1_000)),
        });
      await Promise.all([
        limiter.recordSuccess('slack_oidc_start_source', source),
        limiter.recordSuccess('slack_oidc_start_operation', operationKey),
      ]);
      return c.html(renderSlackAuthorizationHandoffPage(started.authorizationUrl));
    } catch (error) {
      await Promise.all([
        limiter.recordFailure('slack_oidc_start_source', source),
        limiter.recordFailure('slack_oidc_start_operation', operationKey),
      ]);
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
        return c.json({ error: 'rate_limited' }, 429);
      }
      if (purpose === 'invitation' && error instanceof SlackOidcError &&
          ['invalid_state', 'invitation_unavailable'].includes(error.code)) {
        return c.html(renderSlackInvitationUnavailablePage(), 410);
      }
      return c.json({ error: slackOidcPublicError(error) }, slackOidcHttpStatus(error));
    }
  });
  app.get('/auth/slack/oidc/callback', async (c) => {
    authResponseHeaders(c);
    const context = await slackAdmissionContext(c).catch(() => undefined);
    if (!context) return c.notFound();
    const state = c.req.query('state')?.trim() ?? '';
    const code = c.req.query('code')?.trim();
    const providerError = c.req.query('error')?.trim();
    const cookie = decodeSlackOidcCookie(getCookie(c, SLACK_OIDC_BROWSER_COOKIE));
    if (!cookie || state.length < 32 || state.length > 512 ||
        (code !== undefined && code.length > 2_048) ||
        (providerError !== undefined && providerError.length > 128)) {
      clearSlackOidcBrowserCookie(c);
      return c.json({ error: 'invalid_state' }, 400);
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, context.limiterSecret);
    try {
      await Promise.all([
        limiter.assertAllowed('slack_oidc_callback_source', source),
        limiter.assertAllowed('slack_oidc_callback_operation', state),
        limiter.assertAllowed('slack_oidc_callback_deployment', 'deployment'),
      ]);
      const result = await context.service.callback({
        purpose: cookie.purpose,
        state,
        nonce: cookie.nonce,
        browserBinding: cookie.browserBinding,
        redirectUri: `${requestOrigin(c)}/auth/slack/oidc/callback`,
        request: c.req.raw,
        ...(code === undefined ? {} : { code }),
        ...(providerError === undefined ? {} : { error: providerError }),
      });
      copyAuthResponseCookies(c, result.sessionResponse.headers);
      clearSlackOidcBrowserCookie(c);
      await Promise.all([
        limiter.recordSuccess('slack_oidc_callback_source', source),
        limiter.recordSuccess('slack_oidc_callback_operation', state),
      ]);
      if (cookie.purpose === 'invitation') {
        return c.html(renderSlackInvitationCompletePage(result.destination));
      }
      if (cookie.purpose === 'first_owner') {
        return c.html(renderSlackOwnerCompletePage(result.destination));
      }
      return c.redirect(result.destination, 303);
    } catch (error) {
      await Promise.all([
        limiter.recordFailure('slack_oidc_callback_source', source),
        limiter.recordFailure('slack_oidc_callback_operation', state),
      ]);
      if (!(error instanceof SlackOidcError) ||
          !['slack_unreachable', 'processing', 'session_unavailable'].includes(error.code)) {
        clearSlackOidcBrowserCookie(c);
      }
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
        return c.json({ error: 'rate_limited' }, 429);
      }
      if (cookie.purpose === 'invitation' && error instanceof SlackOidcError &&
          ['inactive_user', 'user_mismatch', 'workspace_mismatch'].includes(error.code)) {
        const workspace = await slackWorkspaceDescriptor(c).catch(() => undefined);
        return c.html(renderSlackInvitationMismatchPage(workspace), 403);
      }
      if (cookie.purpose === 'invitation' && error instanceof SlackOidcError &&
          error.code === 'invitation_unavailable') {
        return c.html(renderSlackInvitationUnavailablePage(), 410);
      }
      if (cookie.purpose !== 'invitation' && error instanceof SlackOidcError &&
          !['slack_unreachable', 'processing', 'session_unavailable'].includes(error.code)) {
        const workspace = await slackWorkspaceDescriptor(c).catch(() => undefined);
        return c.html(renderSlackAccessDeniedPage({
          purpose: cookie.purpose,
          destination: cookie.destination,
          reason: error.code,
          ...(workspace ? { workspace } : {}),
        }), slackOidcHttpStatus(error));
      }
      return c.json({ error: slackOidcPublicError(error) }, slackOidcHttpStatus(error));
    }
  });

  // The deploy-time capability authorizes only the bounded Slack app bootstrap.
  // It is never a browser login, and the resumable transaction remains private
  // until Slack OIDC establishes the first Owner in the later setup step.
  app.use('/admin/setup', authSetupBodyLimit);
  app.use('/admin/setup/*', authSetupBodyLimit);
  app.use('/admin/recovery', authSetupBodyLimit);

  app.get('/admin/setup/client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    return c.body(slackSetupClientScript());
  });

  app.get('/admin/setup/manual/client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    return c.body(slackManualSetupClientScript());
  });

  // The pre-owner manual setup journey embeds these immutable historical
  // screenshots, so they must remain available before the Admin auth gate.
  app.get('/admin/assets/onboarding/:name', (c) => {
    const bytes = onboardingAssetBytes(c.req.param('name'));
    if (!bytes) return c.notFound();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Type', 'image/webp');
    return c.body(bytes);
  });

  app.get('/admin/setup/manual', async (c) => {
    authResponseHeaders(c);
    const capability = setupCapability(c);
    if (!capability) return c.notFound();
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: requestOrigin(c) });
    return c.html(renderSlackManualSetupPage({
      destination: safeSetupDestination(c.req.query('destination') ?? '/admin/onboarding'),
      manifest,
      manifestPrefillUrl: slackManifestPrefillUrl(manifest),
      autoResume: true,
    }));
  });

  app.post('/admin/setup/manual', async (c) => {
    authResponseHeaders(c);
    const capability = setupCapability(c);
    if (!capability) return c.notFound();
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, capability.digest);
    const origin = requestOrigin(c);
    let setup: SlackSetupTransaction | undefined;
    let action = 'open';
    try {
      await limiter.assertAllowed('slack_manual_setup_source', source);
      if (!validAuthFormPost(c, origin)) throw new AuthDeniedError();
      const rawForm = await readForm(c);
      action = boundedSetupField(rawForm.action ?? 'open', 32);
      setup = await openSlackSetupTransaction(identity(c), {
        capability: boundedSetupField(rawForm.capability, 512),
        authority: capability,
        canonicalAdminOrigin: origin,
        destination: rawForm.destination ?? '/admin/onboarding',
        ...(options.slackAppCreationNow ? { now: options.slackAppCreationNow } : {}),
      });
      await Promise.all([
        limiter.assertAllowed(`slack_manual_setup_operation_${action}`, setup.id),
        limiter.assertAllowed('slack_setup_deployment', 'deployment'),
      ]);
      const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin });
      if (action === 'adopt') {
        const credentials = slackCredentialDependencies(c);
        if (!credentials) return c.json({ error: 'slack_setup_unavailable' }, 503);
        const service = new SlackAppCreationService({
          identity: identity(c), credentials,
          ...(options.slackAppCreationNow ? { now: options.slackAppCreationNow } : {}),
        });
        setup = await service.adoptManual({
          setupId: setup.id,
          expectedRevision: setup.revision,
          appId: boundedSetupField(rawForm.appId, 64),
          clientId: boundedSetupField(rawForm.clientId, 256),
          clientSecret: boundedSetupField(rawForm.clientSecret, 4_096),
          signingSecret: boundedSetupField(rawForm.signingSecret, 4_096),
          expectedManifest: manifest,
          observedManifest: JSON.parse(boundedSetupField(rawForm.observedManifest, 7_500)),
        });
      } else if (action !== 'open') {
        throw new AuthDeniedError();
      }
      await Promise.all([
        limiter.recordSuccess('slack_manual_setup_source', source),
        limiter.recordSuccess(`slack_manual_setup_operation_${action}`, setup.id),
        limiter.recordSuccess('slack_setup_deployment', 'deployment'),
      ]);
      if (action === 'adopt') return c.redirect('/admin/setup', 303);
      return c.html(renderSlackManualSetupPage({
        setup,
        destination: setup.destination,
        manifest,
        manifestPrefillUrl: slackManifestPrefillUrl(manifest),
      }));
    } catch (error) {
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
      } else {
        await limiter.recordFailure('slack_manual_setup_source', source);
        if (setup) await Promise.all([
          limiter.recordFailure(`slack_manual_setup_operation_${action}`, setup.id),
          limiter.recordFailure('slack_setup_deployment', 'deployment'),
        ]);
      }
      const code = error instanceof AuthRateLimitError ? 'rate_limited'
        : error instanceof SlackAppCreationError ? error.code : 'setup_invalid';
      const status = error instanceof AuthRateLimitError ? 429
        : code === 'setup_expired' ? 410
          : code === 'setup_conflict' ? 409 : 400;
      const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin });
      return c.html(renderSlackManualSetupPage({
        ...(setup ? { setup } : {}),
        destination: setup?.destination ?? '/admin/onboarding',
        manifest,
        manifestPrefillUrl: slackManifestPrefillUrl(manifest),
        error: code,
      }), status);
    }
  });

  app.get('/admin/setup', async (c) => {
    authResponseHeaders(c);
    const capability = setupCapability(c);
    if (!capability) return c.notFound();
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const installStatus = safeSlackInstallStatus(c.req.query('slack_install'));
    let gatewayState: 'disconnected' | 'pending' | 'connected' | 'error' = 'disconnected';
    try {
      if (await settings(c).getSetting(GATEWAY_BINDING_SETTING)) {
        gatewayState = 'connected';
      } else if (await settings(c).getSetting(GATEWAY_CLAIM_SETTING)) {
        if (c.req.query('gateway_return') === '1') {
          const result = await createGatewayDeploymentClient(
            c.env as PlatformEnv | undefined,
          ).refreshClaim();
          gatewayState = result.state === 'bound' ? 'connected' : 'pending';
          if (gatewayState === 'connected') {
            startNodeGatewaySession(c.env as PlatformEnv | undefined);
          }
        } else {
          gatewayState = 'pending';
        }
      }
    } catch {
      gatewayState = 'error';
    }
    const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: requestOrigin(c) });
    return c.html(renderSlackSetupPage({
      destination: safeSetupDestination(c.req.query('destination') ?? '/admin/onboarding'),
      manifest,
      autoResume: true,
      gatewayState,
      ...(installStatus ? { notice: installStatus } : {}),
    }));
  });

  app.post('/admin/setup', async (c) => {
    authResponseHeaders(c);
    const capability = setupCapability(c);
    if (!capability) return c.notFound();
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, capability.digest);
    let setup: SlackSetupTransaction | undefined;
    let action = 'open';
    let notice: string | undefined;
    try {
      await limiter.assertAllowed('slack_setup_source', source);
      if (!validAuthFormPost(c, requestOrigin(c))) throw new AuthDeniedError();
      const rawForm = await readForm(c);
      action = boundedSetupField(rawForm.action ?? 'open', 32);
      notice = safeSlackInstallStatus(rawForm.notice);
      setup = await openSlackSetupTransaction(identity(c), {
        capability: boundedSetupField(rawForm.capability, 512),
        authority: capability,
        canonicalAdminOrigin: requestOrigin(c),
        destination: rawForm.destination ?? '/admin/onboarding',
        ...(options.slackAppCreationNow ? { now: options.slackAppCreationNow } : {}),
      });
      await Promise.all([
        limiter.assertAllowed(`slack_setup_operation_${action}`, setup.id),
        limiter.assertAllowed('slack_setup_deployment', 'deployment'),
      ]);
      const credentials = slackCredentialDependencies(c);
      if (!credentials) return c.json({ error: 'slack_setup_unavailable' }, 503);
      const apiBaseUrl = slackApiBaseUrl(c);
      const service = new SlackAppCreationService({
        identity: identity(c), credentials,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(options.slackAppCreationFetch ? { fetch: options.slackAppCreationFetch } : {}),
        ...(options.slackAppCreationNow ? { now: options.slackAppCreationNow } : {}),
      });
      const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: requestOrigin(c) });
      if (action === 'gateway_begin') {
        const claim = await createGatewayDeploymentClient(
          c.env as PlatformEnv | undefined,
        ).beginClaim(
          `${requestOrigin(c)}/admin/setup?gateway_return=1`,
          { setupId: setup.id, setupRevision: setup.revision },
        );
        await Promise.all([
          limiter.recordSuccess('slack_setup_source', source),
          limiter.recordSuccess(`slack_setup_operation_${action}`, setup.id),
          limiter.recordSuccess('slack_setup_deployment', 'deployment'),
        ]);
        return c.redirect(claim.authorizationUrl, 303);
      } else if (action === 'gateway_refresh') {
        const result = await createGatewayDeploymentClient(
          c.env as PlatformEnv | undefined,
        ).refreshClaim();
        if (result.state === 'bound') startNodeGatewaySession(c.env as PlatformEnv | undefined);
        return c.redirect('/admin/setup', 303);
      } else if (action === 'create') {
        setup = await service.create({
          setupId: setup.id, expectedRevision: setup.revision,
          configurationToken: boundedSetupField(rawForm.configurationToken, 512), manifest,
        });
      } else if (action === 'adopt') {
        setup = await service.adoptManual({
          setupId: setup.id, expectedRevision: setup.revision,
          appId: boundedSetupField(rawForm.appId, 64),
          clientId: boundedSetupField(rawForm.clientId, 256),
          clientSecret: boundedSetupField(rawForm.clientSecret, 4_096),
          signingSecret: boundedSetupField(rawForm.signingSecret, 4_096),
          expectedManifest: manifest,
          observedManifest: JSON.parse(boundedSetupField(rawForm.observedManifest, 7_500)),
        });
      } else if (action === 'restart') {
        setup = await service.restart({ setupId: setup.id, expectedRevision: setup.revision });
      } else if (action === 'inspect') {
        setup = await service.inspect(setup.id);
      } else if (action !== 'open') {
        throw new AuthDeniedError();
      }
      await Promise.all([
        limiter.recordSuccess('slack_setup_source', source),
        limiter.recordSuccess(`slack_setup_operation_${action}`, setup.id),
        limiter.recordSuccess('slack_setup_deployment', 'deployment'),
      ]);
      return c.html(renderSlackSetupPage({
        setup, destination: setup.destination, manifest,
        ...(notice ? { notice } : {}),
      }));
    } catch (error) {
      if (action === 'gateway_begin' || action === 'gateway_refresh') {
        const detail = error instanceof SlackTransportError
          ? `${error.operation}:${error.code}`
          : error instanceof Error
            ? error.message.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 240)
            : 'unknown';
        console.error('[chickpea] shared Slack gateway setup failed:', detail);
      }
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
        const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: requestOrigin(c) });
        return c.html(renderSlackSetupPage({
          ...(setup ? { setup } : {}),
          destination: setup?.destination ?? '/admin/onboarding',
          manifest,
          error: 'rate_limited',
        }), 429);
      }
      await limiter.recordFailure('slack_setup_source', source);
      if (setup) await Promise.all([
        limiter.recordFailure(`slack_setup_operation_${action}`, setup.id),
        limiter.recordFailure('slack_setup_deployment', 'deployment'),
      ]);
      const code = (action === 'gateway_begin' || action === 'gateway_refresh')
        && error instanceof SlackTransportError
        ? slackGatewaySetupPageError(error.code)
        : error instanceof SlackAppCreationError ? error.code : 'setup_invalid';
      const status = code === 'ambiguous_external_effect' ? 409
        : code === 'setup_expired' ? 410
        : code === 'setup_conflict' ? 409
        : code === 'gateway_not_configured' || code === 'gateway_unreachable' ? 503
        : code === 'gateway_redirect_rejected' || code === 'gateway_rejected' ? 502
        : 400;
      const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: requestOrigin(c) });
      return c.html(renderSlackSetupPage({
        ...(setup ? { setup } : {}),
        destination: setup?.destination ?? '/admin/onboarding',
        manifest,
        error: code,
      }), status);
    }
  });

  // Hidden deployment recovery is credential repair only. Its two cookies are
  // independent from Better Auth and carry no person, membership, or role.
  const recoveryBrowserBinding = (c: Context, create: boolean): string | undefined => {
    const existing = getCookie(c, SLACK_RECOVERY_BROWSER_COOKIE);
    if (existing && /^[A-Za-z0-9_-]{32,512}$/.test(existing)) return existing;
    if (!create) return undefined;
    const value = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    setCookie(c, SLACK_RECOVERY_BROWSER_COOKIE, value, recoveryCookieOptions());
    return value;
  };
  const recoveryAuthority = (c: Context) => {
    const browserBinding = recoveryBrowserBinding(c, false);
    const encoded = getCookie(c, SLACK_RECOVERY_SESSION_COOKIE) ?? '';
    const separator = encoded.indexOf('.');
    const recoveryId = separator > 0 ? encoded.slice(0, separator) : '';
    const sessionSecret = separator > 0 ? encoded.slice(separator + 1) : '';
    if (!browserBinding || !/^recovery_[A-Za-z0-9_-]{8,192}$/.test(recoveryId) ||
        !/^[A-Za-z0-9_-]{32,512}$/.test(sessionSecret)) return undefined;
    return { recoveryId, sessionSecret, browserBinding };
  };

  app.get('/admin/recovery', async (c) => {
    authResponseHeaders(c);
    if (!slackRecoveryService(c)) return c.notFound();
    const authority = recoveryAuthority(c);
    if (!authority) {
      const active = await identity(c).getActiveSlackCredentialRevision(
        WORKSPACE_SLACK_INSTALLATION_ID,
      );
      if (!active || active.purpose !== 'connected_credentials' || !active.teamId) return c.notFound();
      return c.html(renderSlackRecoveryPage());
    }
    try {
      const session = await slackRecoveryService(c)!.inspect(authority);
      const stage = session.status === 'waiting_events' ? 'waiting_events'
        : session.status === 'consumed' ? 'complete' : 'credentials';
      return c.html(renderSlackRecoveryPage({
        stage, expectedAppId: session.expectedAppId, expectedTeamId: session.expectedTeamId,
      }));
    } catch {
      clearSlackRecoveryCookies(c);
      return c.html(renderSlackRecoveryPage({ error: 'This recovery session expired or is unavailable.' }), 401);
    }
  });

  app.post('/admin/recovery', async (c) => {
    authResponseHeaders(c);
    const service = slackRecoveryService(c);
    const token = recoveryToken(c);
    if (!service || !token) return c.notFound();
    if (!recoveryAuthority(c)) {
      const active = await identity(c).getActiveSlackCredentialRevision(
        WORKSPACE_SLACK_INSTALLATION_ID,
      );
      if (!active || active.purpose !== 'connected_credentials' || !active.teamId) return c.notFound();
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    let action = 'invalid';
    try {
      await Promise.all([
        limiter.assertAllowed('slack_recovery_source', source),
        limiter.assertAllowed('slack_recovery_deployment', 'deployment'),
      ]);
      if (!validAuthFormPost(c, requestOrigin(c))) throw new AuthDeniedError();
      const form = await readForm(c);
      action = boundedSetupField(form.action, 32);
      await limiter.assertAllowed(`slack_recovery_${action}`, source);
      if (action === 'begin') {
        const browserBinding = recoveryBrowserBinding(c, true)!;
        const begun = await service.begin({
          recoveryToken: boundedSetupField(form.recoveryToken, 512), browserBinding,
        });
        setCookie(
          c,
          SLACK_RECOVERY_SESSION_COOKIE,
          `${begun.recoveryId}.${begun.sessionSecret}`,
          recoveryCookieOptions(),
        );
        await recoveryLimiterSuccess(limiter, source, action);
        return c.html(renderSlackRecoveryPage({
          stage: 'credentials', expectedAppId: begun.expectedAppId, expectedTeamId: begun.expectedTeamId,
        }));
      }
      const authority = recoveryAuthority(c);
      if (!authority) throw new SlackCredentialRecoveryError('invalid_session');
      if (action === 'stage') {
        const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: requestOrigin(c) });
        if (typeof form.configurationToken === 'string' && form.configurationToken.trim()) {
          await service.repairUrls({
            ...authority,
            configurationToken: boundedSetupField(form.configurationToken, 512),
            expectedManifest: manifest,
          });
        }
        await service.stageAppCredentials({
          ...authority,
          appId: boundedSetupField(form.appId, 64),
          teamId: boundedSetupField(form.teamId, 64),
          clientId: boundedSetupField(form.clientId, 256),
          clientSecret: boundedSetupField(form.clientSecret, 4_096),
          signingSecret: boundedSetupField(form.signingSecret, 4_096),
          manifest,
        });
        const started = await service.startBotOAuth({
          ...authority, redirectUri: `${requestOrigin(c)}/auth/slack/recovery/callback`,
        });
        await recoveryLimiterSuccess(limiter, source, action);
        return c.html(renderSlackAuthorizationHandoffPage(started.authorizationUrl));
      }
      if (action === 'finalize') {
        await service.finalize(authority);
        clearSlackRecoveryCookies(c);
        await recoveryLimiterSuccess(limiter, source, action);
        return c.html(renderSlackRecoveryPage({ stage: 'complete' }));
      }
      throw new SlackCredentialRecoveryError('invalid_session');
    } catch (error) {
      await Promise.all([
        limiter.recordFailure('slack_recovery_source', source),
        limiter.recordFailure('slack_recovery_deployment', 'deployment'),
        limiter.recordFailure(`slack_recovery_${action}`, source),
      ]);
      if (error instanceof AuthRateLimitError) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
        return c.html(renderSlackRecoveryPage({ error: 'Too many recovery attempts. Try again later.' }), 429);
      }
      const authority = recoveryAuthority(c);
      const session = authority ? await service.inspect(authority).catch(() => undefined) : undefined;
      const stage = session?.status === 'waiting_events' ? 'waiting_events'
        : session ? 'credentials' : 'token';
      return c.html(renderSlackRecoveryPage({
        stage,
        ...(session ? { expectedAppId: session.expectedAppId, expectedTeamId: session.expectedTeamId } : {}),
        error: slackRecoveryPublicMessage(error),
      }), slackRecoveryHttpStatus(error));
    }
  });

  app.get('/auth/slack/recovery/callback', async (c) => {
    authResponseHeaders(c);
    const service = slackRecoveryService(c);
    const token = recoveryToken(c);
    const authority = recoveryAuthority(c);
    if (!service || !token || !authority) return c.notFound();
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    try {
      await Promise.all([
        limiter.assertAllowed('slack_recovery_callback_source', source),
        limiter.assertAllowed('slack_recovery_deployment', 'deployment'),
      ]);
      await service.callback({
        ...authority,
        state: boundedSetupField(c.req.query('state'), 512),
        code: boundedSetupField(c.req.query('code'), 2_048),
        redirectUri: `${requestOrigin(c)}/auth/slack/recovery/callback`,
      });
      await Promise.all([
        limiter.recordSuccess('slack_recovery_callback_source', source),
        limiter.recordSuccess('slack_recovery_deployment', 'deployment'),
      ]);
      return c.html(renderSlackRecoveryPage({ stage: 'waiting_events' }));
    } catch (error) {
      await Promise.all([
        limiter.recordFailure('slack_recovery_callback_source', source),
        limiter.recordFailure('slack_recovery_deployment', 'deployment'),
      ]);
      return c.html(renderSlackRecoveryPage({
        stage: 'credentials', error: slackRecoveryPublicMessage(error),
      }), slackRecoveryHttpStatus(error));
    }
  });

  // GitHub calls this endpoint without a Chickpea or Access session. The
  // single-use state is the authorization boundary and is bound to the Admin
  // membership that initiated the manifest flow. Keep the old path public for
  // states minted before upgrade; both paths delegate to the same consumer.
  app.get('/oauth/github/setup/callback', completeGithubSetupCallback);
  app.get('/admin/api/github/setup/callback', completeGithubSetupCallback);

  // CIMD is fetched by the provider, not an administrator's browser. It is
  // intentionally public and contains client policy only — never a client
  // secret. The document's client_id is its exact HTTPS URL.
  app.get('/.well-known/oauth-client-metadata.json', (c) => {
    try {
      const documentUrl =
        `${requestOrigin(c)}/.well-known/oauth-client-metadata.json`;
      return c.json(createMcpOAuthClientMetadataDocument(documentUrl));
    } catch {
      return c.notFound();
    }
  });

  // The provider redirects here without an admin Authorization header. State is
  // the authorization boundary: the OAuth module validates and atomically
  // consumes it before exchange or cancellation. Neither codes nor error text
  // are reflected into the redirect.
  app.get('/oauth/callback', async (c) => {
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    const state = c.req.query('state');
    const code = c.req.query('code');
    const providerError = c.req.query('error');
    if (
      !state ||
      state.length > 2_048 ||
      (code !== undefined && code.length > 8_192) ||
      (providerError !== undefined && providerError.length > 256) ||
      (!code && !providerError) ||
      (code && providerError)
    ) {
      return invalidRequest(c);
    }
    let ref: { agentId: string; connectionId: string };
    let returnAgentId: string | undefined;
    let accountRevision: number | undefined;
    let oauthAttemptId: string | undefined;
    try {
      if (providerError) {
        const cancelled = await cancelMcpOAuth(state, oauthDependencies(c));
        const status = providerError === 'access_denied' ? 'cancelled' : 'failed';
        return c.redirect(mcpOAuthAdminRedirect(status, cancelled.ref, cancelled.returnAgentId), 303);
      }
      ({ ref, returnAgentId, accountRevision, oauthAttemptId } = await completeMcpOAuth(
        { code: code!, state },
        oauthDependencies(c),
      ));
    } catch (error) {
      if (error instanceof McpOAuthError && error.code === 'invalid_state') {
        return invalidRequest(c);
      }
      console.error(
        '[chickpea] MCP OAuth callback failed:',
        error instanceof McpOAuthError ? error.code : 'internal_error',
      );
      if (error instanceof McpOAuthError && error.callbackContext) {
        return c.redirect(
          mcpOAuthAdminRedirect(
            'failed',
            error.callbackContext.ref,
            error.callbackContext.returnAgentId,
          ),
          303,
        );
      }
      try {
        // This decoded ref selects only the admin status destination; it does
        // not authorize or mutate anything. Malformed state falls through to
        // the generic admin landing page.
        return c.redirect(
          mcpOAuthAdminRedirect('failed', mcpOAuthReturnRefFromState(state)),
          303,
        );
      } catch {
        // Keep malformed state out of the redirect path.
      }
      return c.redirect('/admin?oauth=failed', 303);
    }
    try {
      await verifyAndStoreMcpOAuthConnection({
        ref,
        configStore: store(c),
        ...((c.env as PlatformEnv | undefined) !== undefined
          ? { platformEnv: c.env as PlatformEnv }
          : {}),
        discoverMcp,
        identifyMcp,
        resolveMcpOAuthToken,
        oauthDependencies: oauthDependencies(c),
        ...(accountRevision !== undefined ? { accountRevision } : {}),
        ...(oauthAttemptId ? { oauthAttemptId } : {}),
      });
      return c.redirect(mcpOAuthAdminRedirect('connected', ref, returnAgentId), 303);
    } catch (error) {
      if (error instanceof McpOAuthError && error.code === 'connection_missing') {
        await deleteMcpOAuthSettings(ref, settings(c)).catch(() => undefined);
      }
      console.warn(
        `[chickpea] MCP OAuth verification failed (${ref.connectionId}): ` +
          mcpDebugText(error),
      );
      return c.redirect(mcpOAuthAdminRedirect('verification_failed', ref, returnAgentId), 303);
    }
  });

  // BYO REST OAuth uses its own fixed callback so provider-managed MCP OAuth
  // state and operator-supplied client credentials can never cross lanes.
  app.get('/oauth/api/callback', async (c) => {
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    const state = c.req.query('state');
    const code = c.req.query('code');
    const providerError = c.req.query('error');
    if (
      !state ||
      state.length > 2_048 ||
      (code !== undefined && code.length > 8_192) ||
      (providerError !== undefined && providerError.length > 256) ||
      (!code && !providerError) ||
      (code && providerError)
    ) {
      return invalidRequest(c);
    }
    let ref: ApiOAuthRef | undefined;
    let returnAgentId: string | undefined;
    try {
      if (providerError) {
        const cancelled = await cancelApiOAuth(state, apiOAuthDependencies(c));
        const continuationState = await takeOAuthContinuationForProviderState({
          settings: settings(c),
          providerState: state,
        });
        if (continuationState) {
          await cancelOAuthContinuationFromProvider({
            settings: settings(c),
            state: continuationState,
          });
        }
        const status = providerError === 'access_denied' ? 'cancelled' : 'failed';
        return c.redirect(apiOAuthAdminRedirect(status, cancelled.ref, cancelled.returnAgentId), 303);
      }
      const completed = await completeApiOAuth(
        { code: code!, state },
        apiOAuthDependencies(c),
      );
      ref = completed.ref;
      returnAgentId = completed.returnAgentId;
      const continuationState = await takeOAuthContinuationForProviderState({
        settings: settings(c),
        providerState: state,
      });
      if (continuationState) {
        const pendingContinuation = await inspectOAuthContinuationFromProvider({
          settings: settings(c),
          state: continuationState,
        });
        if (!(await isOAuthContinuationActorActive({
          continuation: pendingContinuation,
          identity: identity(c),
        }))) {
          await deleteApiOAuthSettings(completed.ref, settings(c));
          throw new OAuthContinuationError('wrong_actor');
        }
      }
      try {
        await replaceReadyApiOAuthConnection(
          store(c),
          completed.ref,
          completed.provider,
          completed.identity,
          completed.accountRevision,
          completed.oauthAttemptId,
        );
      } catch (error) {
        // Remove orphaned OAuth state only when the row truly disappeared or
        // changed. A transient config-store error must not destroy the
        // operator's write-only client and freshly minted tokens.
        if (error instanceof ApiOAuthError && error.code === 'connection_missing') {
          await deleteApiOAuthSettings(completed.ref, settings(c));
        }
        throw error;
      }
      if (continuationState) {
        const continuation = await authorizeOAuthContinuationFromProvider({
          settings: settings(c),
          state: continuationState,
        });
        if (options.onOAuthContinuationReady) {
          await options.onOAuthContinuationReady(
            continuation,
            c.env as PlatformEnv | undefined,
          );
          await claimOAuthContinuationResume({
            settings: settings(c),
            continuationId: continuation.id,
          });
        }
      }
      return c.redirect(apiOAuthAdminRedirect('connected', completed.ref, returnAgentId), 303);
    } catch (error) {
      if (error instanceof ApiOAuthError && error.code === 'invalid_state') {
        return invalidRequest(c);
      }
      console.error(
        '[chickpea] API OAuth callback failed:',
        error instanceof ApiOAuthError ? error.code : 'internal_error',
      );
      if (error instanceof ApiOAuthError && error.callbackContext) {
        return c.redirect(
          apiOAuthAdminRedirect(
            'failed',
            error.callbackContext.ref,
            error.callbackContext.returnAgentId,
          ),
          303,
        );
      }
      if (ref) {
        return c.redirect(apiOAuthAdminRedirect('failed', ref, returnAgentId), 303);
      }
      try {
        ref = apiOAuthReturnRefFromState(state);
        return c.redirect(apiOAuthAdminRedirect('failed', ref, returnAgentId), 303);
      } catch {
        return c.redirect('/admin?oauth=failed&lane=api', 303);
      }
    }
  });

  // Slack fetches persona images without a Chickpea browser session. Revisions
  // are immutable, so public caching cannot make a later upload appear stale.
  app.get('/assets/agents/:agentId/avatar/:revision', async (c) => {
    const agentId = c.req.param('agentId');
    const revision = Number(c.req.param('revision'));
    if (!AGENT_ID_PATTERN.test(agentId) || !Number.isSafeInteger(revision) || revision < 1) {
      return c.notFound();
    }
    try {
      const agent = await store(c).getAgent(agentId);
      const asset = await readAgentAvatarAsset({
        settings: settings(c),
        agentId,
        revision,
        ...(agent.slackPresence?.avatar.seed
          ? { seed: agent.slackPresence.avatar.seed }
          : {}),
      });
      if (!asset) return c.notFound();
      c.header('Content-Type', asset.contentType);
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(asset.bytes).buffer);
    } catch (error) {
      if (error instanceof UnknownAgentError) return c.notFound();
      return internalError(c, error);
    }
  });

  app.post(
    '/webhooks/composio',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
    async (c) => {
      const env = c.env as PlatformEnv | undefined;
      const boundSecret = env?.COMPOSIO_WEBHOOK_SECRET;
      const secret = (typeof boundSecret === 'string'
        ? boundSecret
        : process.env.COMPOSIO_WEBHOOK_SECRET)?.trim();
      if (!secret) return c.json({ error: 'not_configured' }, 503);
      let event: Awaited<ReturnType<typeof verifyComposioWebhook>>;
      try {
        event = await verifyComposioWebhook({
          rawBody: await c.req.text(),
          webhookId: c.req.header('webhook-id') ?? '',
          webhookTimestamp: c.req.header('webhook-timestamp') ?? '',
          webhookSignature: c.req.header('webhook-signature') ?? '',
          secret,
        });
      } catch {
        return c.json({ error: 'invalid_webhook' }, 401);
      }
      if (event.kind === 'ignored') {
        console.log(JSON.stringify({
          event: 'chickpea.managed_connection.webhook_ignored',
          adapterId: 'composio',
          type: event.type,
        }));
        return c.body(null, 204);
      }
      try {
        const changed = await connectionAccounts(c).markManagedAccountExpired({
          adapterId: 'composio',
          accountRef: event.accountRef,
        });
        console.log(JSON.stringify({
          event: 'chickpea.managed_connection.expired',
          adapterId: 'composio',
          toolkit: event.toolkit,
          affectedAccounts: changed,
        }));
        return c.body(null, 204);
      } catch {
        console.error(JSON.stringify({
          event: 'chickpea.managed_connection.expiry_processing_failed',
          adapterId: 'composio',
        }));
        return c.json({ error: 'webhook_processing_failed' }, 503);
      }
    },
  );

  // The worker's root is not a product surface — send visitors to the admin
  // (the gate/login there handles auth). Bare 404 at `/` read as a broken
  // install during live testing.
  app.get('/', (c) => c.redirect('/admin', 302));

  app.use('/admin', adminGate);
  // Retired human-auth endpoints are dark before authentication so callers
  // cannot use them as a session or deployment-state oracle.
  for (const path of [
    '/admin/login',
    '/admin/migrate',
    '/admin/account/password',
    '/admin/reset',
  ]) {
    app.all(path, (c) => c.notFound());
  }
  app.use('/admin/*', adminGate);
  app.use('/admin/api/*', (c, next) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)
      ? adminMutationBodyLimit(c, next)
      : next(),
  );
  app.use('/admin/api/*', async (c, next) => {
    // Body-limit middleware may replace the Request object while retaining the
    // Hono Context. Reattach the trusted principal to that exact Request so
    // routed sub-apps (work/memory/etc.) receive attribution, never a
    // caller-supplied identity header.
    const principal = principalByContext.get(c);
    if (principal) setRequestPrincipal(c.req.raw, principal);
    const platformEnv = c.env as PlatformEnv | undefined;
    // The cutover drain probe must be observational: do not let the general
    // admin middleware reconcile provider keys or pin request-origin state.
    if (c.req.method === 'GET' &&
        (c.req.path === '/admin/api/runtime/drain' ||
          c.req.path === '/admin/api/runtime/recovery-turns')) {
      return next();
    }
    const settingsStore = settings(c);
    await applyResolvedProviderKeys(platformEnv, settingsStore);
    // Opportunistically pin the resolved origin so the Slack "Configure" deep
    // link works even on a button deploy that never set SLACK_TAG_PUBLIC_URL.
    // No-op on the steady state.
    // The observational connection test must mutate NOTHING, and disconnect
    // promises to preserve the already-stored public URL, so those two
    // lifecycle operations deliberately skip the opportunistic write.
    const slackConnectionTest =
      c.req.method === 'POST' && c.req.path === '/admin/api/slack-connection/test';
    const slackDisconnect =
      c.req.method === 'DELETE' && c.req.path === '/admin/api/slack-connection';
    // Identity-authenticated installs pin their canonical Admin origin during
    // setup. Never let an arbitrary later request host rewrite it (or the
    // Slack public URL derived from it).
    if (!principal && !slackConnectionTest && !slackDisconnect) {
      await persistRequestOrigin(c, settingsStore);
    }
    return next();
  });
  const limitSlackInstallationMutation = (c: Context, next: Next) =>
    c.req.method === 'GET' || c.req.method === 'HEAD'
      ? next()
      : slackInstallationAdminBodyLimit(c, next);
  app.use('/admin/api/slack-connection', limitSlackInstallationMutation);

  app.get('/admin/api/settings/connectors/composio', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const principal = principalByContext.get(c);
      const canConfigure = Boolean(
        principal && permissionForRole(principal.role).has('admin.configure'),
      );
      const provider = (await resolvedManagedProviderContext(c)).providers.get('composio');
      const configuration = await describeComposioConfiguration(composioConfiguration(c));
      const { lastSetupResult: _lastSetupResult, ...memberConfiguration } = configuration;
      return c.json({
        provider: canConfigure ? configuration : memberConfiguration,
        canConfigure,
        ...(canConfigure ? { impact: await managedProviderImpact(store(c), 'composio') } : {}),
        catalog: managedCatalogDescriptors().map((connector) => ({
          ...connector,
          access: {
            read: managedProviderAvailability(provider, {
              toolkit: connector.toolkit,
              accessLane: 'read',
            }),
            write: managedProviderAvailability(provider, {
              toolkit: connector.toolkit,
              accessLane: 'write',
            }),
          },
        })),
      });
    } catch (error) {
      if (error instanceof ComposioConfigurationStateError) {
        const principal = principalByContext.get(c);
        const canAdminConfigure = Boolean(
          principal && permissionForRole(principal.role).has('admin.configure'),
        );
        return c.json({
          error: 'composio_configuration_unavailable',
          message: 'The managed connector configuration needs attention.',
          recovery: {
            canConfigure: canAdminConfigure,
            catalog: managedCatalogDescriptors(),
          },
        }, 503);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/settings/connectors/composio/setup', async (c) => {
    c.header('Cache-Control', 'no-store');
    const parsed = v.safeParse(composioProjectSetupSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    let projectKeyValidated = false;
    let projectKeySaved = false;
    const setupSignal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(Math.min(
        60_000,
        options.composioReconciliationTimeoutMs ?? 60_000,
        options.composioPreparationTimeoutMs ?? 60_000,
      )),
    ]);
    try {
      const principal = principalByContext.get(c);
      requirePermission(principal, 'admin.configure');
      if (!composioConfigurationIsMutable(composioConfiguration(c))) {
        throw new ComposioConfigurationMutationError();
      }
      if (parsed.output.continuation) {
        const agent = await store(c).getAgent(parsed.output.continuation.agentId);
        requireAgentEdit(principal, agent);
        if (!managedCatalog.connector(parsed.output.continuation.toolkit)) return invalidRequest(c);
      }
      await validateComposioProjectKey(parsed.output.projectKey, {
        ...(options.composioCreateClient ? { createClient: options.composioCreateClient } : {}),
        signal: setupSignal,
      });
      projectKeyValidated = true;
      await saveStoredComposioProjectKey(
        parsed.output.projectKey,
        composioConfiguration(c),
      );
      projectKeySaved = true;
      const reconciled = await resumeComposioReconciliation(c, setupSignal);
      if (reconciled.reconciliationPending) {
        return c.json({
          error: 'composio_reconciliation_incomplete',
          message: 'Chickpea is still reconciling managed accounts. Try again shortly.',
          provider: await describeComposioConfiguration(composioConfiguration(c)),
        }, 503);
      }
      await prepareResolvedComposioManagedAuthConfigs({
        ...composioConfiguration(c),
        ...(options.composioCreateClient ? { createClient: options.composioCreateClient } : {}),
        signal: setupSignal,
      });
      return c.json({
        provider: await describeComposioConfiguration(composioConfiguration(c)),
        ...(parsed.output.continuation
          ? {
              continuation: {
                ...parsed.output.continuation,
                action: 'authorize' as const,
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (isAbortOrTimeoutError(error)) {
        return c.json({
          error: 'composio_setup_unavailable',
          message: projectKeySaved
            ? 'The key was saved, but managed connectors could not be prepared. Retry setup.'
            : 'Composio could not be reached before setup timed out. Try again.',
        }, 503);
      }
      if (error instanceof ComposioProjectKeyValidationError) {
        return projectKeyValidated
          ? c.json({
              error: 'composio_setup_unavailable',
              message: 'The key was saved, but managed connectors could not be prepared. Retry setup.',
            }, 503)
          : c.json({ error: 'invalid_composio_project_key' }, 400);
      }
      if (error instanceof ComposioSetupInProgressError) {
        return c.json({
          error: 'composio_setup_in_progress',
          message: 'Managed connector setup is already in progress. Try again shortly.',
        }, 409);
      }
      if (error instanceof ComposioConfigurationMutationError) {
        return c.json({
          error: 'composio_configuration_deployment_managed',
          message: 'This Composio project is managed by deployment configuration and cannot be changed here.',
        }, 409);
      }
      if (error instanceof ComposioConfigurationStateError) {
        return c.json({
          error: 'composio_configuration_unavailable',
          message: 'The managed connector configuration needs attention. Repair it in Settings and try again.',
        }, 503);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/settings/connectors/composio/retry', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const principal = principalByContext.get(c);
      requirePermission(principal, 'admin.configure');
      const reconciled = await resumeComposioReconciliation(c);
      if (!reconciled.apiKey || reconciled.desiredState !== 'enabled') {
        return c.json({
          error: 'composio_configuration_missing',
          message: 'Add a Composio project key before preparing managed connectors.',
        }, 409);
      }
      if (reconciled.reconciliationPending) {
        return c.json({
          error: 'composio_reconciliation_incomplete',
          message: 'Chickpea is still reconciling managed accounts. Try again shortly.',
        }, 503);
      }
      await prepareResolvedComposioManagedAuthConfigs({
        ...composioConfiguration(c),
        ...(options.composioCreateClient ? { createClient: options.composioCreateClient } : {}),
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(45_000)]),
      });
      return c.json({ provider: await describeComposioConfiguration(composioConfiguration(c)) });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof ComposioSetupInProgressError) {
        return c.json({
          error: 'composio_setup_in_progress',
          message: 'Managed connector setup is already in progress. Try again shortly.',
        }, 409);
      }
      if (error instanceof ComposioConfigurationMutationError) {
        return c.json({
          error: 'composio_configuration_deployment_managed',
          message: 'This Composio project is managed by deployment configuration and cannot be changed here.',
        }, 409);
      }
      if (error instanceof ComposioConfigurationStateError) {
        return c.json({
          error: 'composio_configuration_unavailable',
          message: 'The managed connector configuration needs attention. Repair it in Settings and try again.',
        }, 503);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/settings/connectors/composio/disable', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const principal = principalByContext.get(c);
      requirePermission(principal, 'admin.configure');
      await disableStoredComposioConfiguration(composioConfiguration(c));
      await resumeComposioReconciliation(c);
      return c.json({ provider: await describeComposioConfiguration(composioConfiguration(c)) });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof ComposioConfigurationMutationError) {
        return c.json({
          error: 'composio_configuration_deployment_managed',
          message: 'This Composio project is managed by deployment configuration and cannot be changed here.',
        }, 409);
      }
      if (error instanceof ComposioConfigurationStateError) {
        return c.json({
          error: 'composio_configuration_unavailable',
          message: 'The managed connector configuration needs attention. Repair it in Settings and try again.',
        }, 503);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/connections/managed/recover', async (c) => {
    c.header('Cache-Control', 'no-store');
    const parsed = v.safeParse(managedAuthorizationRecoverySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c);
      requirePermission(principal, 'auth.recover');
      const membership = await identity(c).getMembership(parsed.output.actorMembershipId);
      if (!principal || !membership || membership.status !== 'active' ||
          membership.organizationId !== principal.organizationId) {
        throw new AuthorizationError();
      }
      const recovered = await recoverMalformedManagedAuthorization({
        settings: settings(c),
        actorMembershipId: membership.id,
        cleanupRemoteAccount: async ({ adapterId, accountRef }) => {
          if (await connectionAccounts(c).hasManagedRemoteRef({ adapterId, accountRef })) {
            return false;
          }
          const provider = (await resolvedManagedProviderContext(c)).providers.get(adapterId);
          if (!provider?.cleanupRemoteAccount) {
            throw new ManagedConnectionProviderUnavailableError(adapterId);
          }
          await provider.cleanupRemoteAccount({ accountRef });
          return true;
        },
      });
      console.info(JSON.stringify({
        event: 'chickpea.managed_connection.invalid_authorization_attempt_recovered',
        adapterId: recovered.adapterId,
        actorMembershipId: membership.id,
        deletedRemoteAccounts: recovered.deletedRemoteAccounts,
      }));
      return c.json({
        recovered: true,
        deletedRemoteAccounts: recovered.deletedRemoteAccounts,
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof ManagedConnectionProviderUnavailableError) return c.json({
        error: 'managed_provider_unavailable',
        message: `Restore the ${error.adapterId} provider credentials before recovery.`,
      }, 503);
      if (error instanceof ManagedAuthorizationError &&
          (error.code === 'in_progress' || error.code === 'recovery_required')) {
        return c.json({
          error: 'managed_authorization_recovery_required',
          message: 'The stored Google sign-in cannot be recovered automatically. Contact Chickpea support before retrying.',
        }, 409);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/connections/managed/start', async (c) => {
    c.header('Cache-Control', 'no-store');
    const parsed = v.safeParse(managedAuthorizationStartSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    let startedAttempt: Awaited<ReturnType<typeof beginManagedAuthorization>> | undefined;
    let startedAuthorizationRef: string | undefined;
    let startedAuthorizationRecorded = false;
    let authorizationProviders: ManagedConnectionProviderRegistry | undefined;
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const agent = await store(c).getAgent(c.req.param('id'));
      requireAgentEdit(principal, agent);
      const organization = await identity(c).getOrganization();
      if (organization?.slackTeamId !== parsed.output.workspaceId) throw new AuthorizationError();
      // This helper calls ConnectionAccountService.getForManagement before
      // any Connect Link is created, so reconnect consent is manager-only.
      const replacement = 'connectionAccountId' in parsed.output
        ? await managedConnectionAccount(c, agent.id, parsed.output.connectionAccountId, false)
        : undefined;
      if (!('connectionAccountId' in parsed.output)) {
        requirePermission(
          principal,
          parsed.output.ownerKind === 'team'
            ? 'connection.create_team'
            : 'connection.create_personal',
        );
      }
      const replacementPolicy = replacement?.account.policy.kind === 'managed'
        ? replacement.account.policy
        : undefined;
      const toolkit = replacementPolicy?.toolkit ??
        ('toolkit' in parsed.output ? parsed.output.toolkit : undefined);
      const connector = toolkit ? managedCatalog.connector(toolkit) : undefined;
      const ownerKind = replacement?.account.ownerKind ??
        ('ownerKind' in parsed.output ? parsed.output.ownerKind : undefined);
      const principalRef = ownerKind ? managedPrincipalRef(principal, ownerKind) : undefined;
      if (!connector || !ownerKind || !principalRef) return invalidRequest(c);
      if (replacement && (
        replacement.account.workspaceId !== parsed.output.workspaceId ||
        replacement.account.lifecycle === 'revoked' ||
        !replacementPolicy ||
        replacementPolicy.adapterId.trim().toLowerCase() !== 'composio' ||
        replacementPolicy.principalRef !== principalRef
      )) {
        throw new AuthorizationError();
      }
      if (!replacement) {
        const [accounts, bindings] = await Promise.all([
          store(c).listConnectionAccounts(parsed.output.workspaceId),
          store(c).listAgentConnectionBindings(agent.id),
        ]);
        const enabledAccountIds = new Set(
          bindings.filter((binding) => binding.enabled)
            .map((binding) => binding.connectionAccountId),
        );
        const existingOwnerLane = accounts.find((account) =>
          enabledAccountIds.has(account.id) &&
          account.lifecycle !== 'revoked' &&
          account.ownerKind === ownerKind &&
          (ownerKind === 'team' || account.ownerMembershipId === principal.membershipId) &&
          account.policy.kind === 'managed' &&
          account.policy.adapterId.trim().toLowerCase() === 'composio' &&
          account.policy.toolkit === connector.toolkit);
        if (existingOwnerLane) {
          return c.json({
            error: 'managed_connection_lane_exists',
            message: `This Agent already has a ${ownerKind === 'team' ? 'team' : 'personal'} ${connector.label} connection. Disconnect it before connecting another account or changing its access.`,
          }, 409);
        }
      }
      const capabilities = replacementPolicy
        ? [...replacementPolicy.allowedCapabilities]
        : managedCatalog.capabilities(
            connector.toolkit,
            'access' in parsed.output ? parsed.output.access : 'read',
          ).map(({ id }) => id);
      const providerContext = await resolvedManagedProviderContext(c);
      authorizationProviders = providerContext.providers;
      const provider = providerContext.providers.get('composio');
      const accessLane = connector.capabilities.some(({ id, accessLane }) =>
        accessLane === 'write' && capabilities.includes(id)) ? 'write' : 'read';
      if (!provider?.authorize || managedProviderAvailability(provider, {
        toolkit: connector.toolkit,
        accessLane,
      }).status !== 'ready') return c.json({
        error: 'managed_provider_unavailable',
        message: `${connector.label} managed access is not configured for this deployment.`,
      }, 503);
      const existingBrowserSecret = getCookie(c, MANAGED_AUTHORIZATION_BROWSER_COOKIE) ?? '';
      if (existingBrowserSecret) {
        let existingAttempt: ManagedAuthorizationAttempt | undefined;
        try {
          existingAttempt = await inspectManagedAuthorizationForCleanup({
            settings: settings(c),
            actorMembershipId: principal.membershipId,
            browserSecret: existingBrowserSecret,
          });
        } catch {
          // A malformed or foreign cookie cannot cancel another browser's attempt.
        }
        const existingRemoteRef = existingAttempt
          ? managedAuthorizationRemoteRef(existingAttempt)
          : undefined;
        if (existingAttempt && existingRemoteRef) {
          const alreadyImported = await connectionAccounts(c).hasManagedRemoteRef({
            adapterId: existingAttempt.adapterId,
            accountRef: existingRemoteRef,
          });
          if (!alreadyImported) {
            const cleanupProvider = providerContext.providers.get(existingAttempt.adapterId);
            if (!cleanupProvider) throw new Error('managed provider is unavailable');
            await cleanupProvider.revoke({
              policy: {
                kind: 'managed',
                adapterId: existingAttempt.adapterId,
                toolkit: existingAttempt.toolkit,
                principalRef: existingAttempt.principalRef,
                accountRef: existingRemoteRef,
                allowedCapabilities: [...existingAttempt.allowedCapabilities],
              },
            });
          }
        }
        if (existingAttempt) {
          // Returning from or closing consent leaves a browser-bound attempt.
          // A pending Connect Link already owns a revocable account reference;
          // discard either attempt state only after that exact remote grant is
          // imported or successfully revoked above. Cleanup failures block a
          // new flow so the remote grant cannot be orphaned.
          await abandonManagedAuthorizationForRestart({
            settings: settings(c),
            actorMembershipId: principal.membershipId,
            browserSecret: existingBrowserSecret,
          });
        }
      }
      let staleAttempt: ManagedAuthorizationAttempt | undefined;
      try {
        staleAttempt = await inspectStaleManagedAuthorization({
          settings: settings(c),
          actorMembershipId: principal.membershipId,
        });
      } catch (error) {
        // Let beginManagedAuthorization preserve malformed state, emit its
        // bounded reconciliation event, and return the normal in-progress 409.
        if (!(error instanceof ManagedAuthorizationError && error.code === 'invalid')) throw error;
      }
      const staleRemoteRef = staleAttempt
        ? managedAuthorizationRemoteRef(staleAttempt)
        : undefined;
      if (staleAttempt && staleRemoteRef) {
        const alreadyImported = await connectionAccounts(c).hasManagedRemoteRef({
          adapterId: staleAttempt.adapterId,
          accountRef: staleRemoteRef,
        });
        if (!alreadyImported) {
          const cleanupProvider = providerContext.providers.get(staleAttempt.adapterId);
          if (!cleanupProvider) throw new Error('managed provider is unavailable');
          await cleanupProvider.revoke({
            policy: {
              kind: 'managed',
              adapterId: staleAttempt.adapterId,
              toolkit: staleAttempt.toolkit,
              principalRef: staleAttempt.principalRef,
              accountRef: staleRemoteRef,
              allowedCapabilities: [...staleAttempt.allowedCapabilities],
            },
          });
        }
        // The compare-and-set delete happens only after the remote grant is
        // either known to Chickpea or successfully revoked. A failed cleanup
        // leaves the durable handle available for the next authenticated try.
        await abandonStaleManagedAuthorization({
          settings: settings(c),
          actorMembershipId: principal.membershipId,
        });
      }
      startedAttempt = await beginManagedAuthorization({
        settings: settings(c),
        input: {
          workspaceId: parsed.output.workspaceId,
          agentId: agent.id,
          actorMembershipId: principal.membershipId,
          ownerKind,
          providerId: replacement?.account.providerId ?? connector.providerId,
          adapterId: 'composio',
          toolkit: connector.toolkit,
          label: replacement?.account.label ??
            `${connector.label} · ${ownerKind === 'team' ? 'Team' : 'Personal'}`,
          principalRef,
          allowedCapabilities: capabilities,
          ...(replacement
            ? { connectionAccountId: replacement.account.id }
            : { bindingCapabilities: [...capabilities] }),
          providerGeneration: providerContext.generation,
          providerLineage: providerContext.lineage,
        },
      });
      const authorization = await provider.authorize({
        principalRef,
        toolkit: connector.toolkit,
        allowedCapabilities: capabilities,
      });
      startedAuthorizationRef = authorization.authorizationRef;
      await recordManagedAuthorizationRequest({
        settings: settings(c),
        actorMembershipId: principal.membershipId,
        browserSecret: startedAttempt.browserSecret,
        authorizationRef: authorization.authorizationRef,
      });
      startedAuthorizationRecorded = true;
      setCookie(c, MANAGED_AUTHORIZATION_BROWSER_COOKIE, startedAttempt.browserSecret, {
        path: '/admin',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: 30 * 60,
      });
      return c.json({
        authorizationUrl: authorization.authorizationUrl.toString(),
        pollUrl: `/admin/api/agents/${encodeURIComponent(agent.id)}/connections/managed/poll`,
      });
    } catch (error) {
      if (error instanceof ManagedAuthorizationAllocatedError) {
        startedAuthorizationRef = error.authorizationRef;
      }
      if (startedAttempt) {
        let remoteCleanupComplete = true;
        if (startedAuthorizationRef && !startedAuthorizationRecorded) {
          try {
            await recordManagedAuthorizationRequest({
              settings: settings(c),
              actorMembershipId: startedAttempt.attempt.actorMembershipId,
              browserSecret: startedAttempt.browserSecret,
              authorizationRef: startedAuthorizationRef,
            });
            startedAuthorizationRecorded = true;
          } catch {
            console.error(JSON.stringify({
              event: 'chickpea.managed_connection.authorization_start_reference_persist_failed',
              adapterId: startedAttempt.attempt.adapterId,
            }));
          }
        }
        if (startedAuthorizationRef) {
          try {
            const cleanupProvider = (authorizationProviders ?? managedProviders(c))
              .get(startedAttempt.attempt.adapterId);
            if (!cleanupProvider) throw new Error('managed provider is unavailable');
            await cleanupProvider.revoke({
              policy: {
                kind: 'managed',
                adapterId: startedAttempt.attempt.adapterId,
                toolkit: startedAttempt.attempt.toolkit,
                principalRef: startedAttempt.attempt.principalRef,
                accountRef: startedAuthorizationRef,
                allowedCapabilities: [...startedAttempt.attempt.allowedCapabilities],
              },
            });
          } catch {
            remoteCleanupComplete = false;
            console.error(JSON.stringify({
              event: 'chickpea.managed_connection.authorization_start_remote_cleanup_failed',
              adapterId: startedAttempt.attempt.adapterId,
            }));
          }
        }
        try {
          if (remoteCleanupComplete) {
            await abandonManagedAuthorization({
              settings: settings(c),
              actorMembershipId: startedAttempt.attempt.actorMembershipId,
              browserSecret: startedAttempt.browserSecret,
            });
          }
        } catch {
          console.error(JSON.stringify({
            event: 'chickpea.managed_connection.authorization_start_cleanup_failed',
            adapterId: startedAttempt.attempt.adapterId,
          }));
        }
      }
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof ManagedAuthorizationError && error.code === 'recovery_required') {
        return c.json({
          error: 'managed_authorization_recovery_required',
          message: 'This Google sign-in needs administrator cleanup before another connection can start. Contact your Chickpea workspace owner.',
        }, 409);
      }
      if (error instanceof ManagedAuthorizationError && error.code === 'in_progress') {
        return c.json({
          error: 'managed_authorization_in_progress',
          message: 'A Google sign-in is already in progress in another browser. Finish that sign-in before starting another.',
        }, 409);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/connections/managed/poll', async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await readJson(c.req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
      return invalidRequest(c);
    }
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const agent = await store(c).getAgent(c.req.param('id'));
      requireAgentEdit(principal, agent);
      const browserSecret = getCookie(c, MANAGED_AUTHORIZATION_BROWSER_COOKIE) ?? '';
      const poll = (async () => {
          let cleanupAttempt: ManagedAuthorizationAttempt | undefined;
          let cleanupService: ConnectionAccountService | undefined;
          let cleanupProvider: ManagedConnectionProvider | undefined;
          let remoteAccountObserved = false;
          try {
            let attempt = await inspectManagedAuthorization({
              settings: settings(c),
              actorMembershipId: principal.membershipId,
              browserSecret,
            });
            cleanupAttempt = attempt;
            const organization = await identity(c).getOrganization();
            if (organization?.slackTeamId !== attempt.workspaceId) throw new AuthorizationError();
            if (attempt.agentId !== agent.id || !attempt.authorizationRef) {
              throw new ManagedAuthorizationError('invalid');
            }
            if (attempt.connectionAccountId) {
              const binding = await store(c).getAgentConnectionBindingForAccount(
                attempt.connectionAccountId,
              );
              if (binding?.agentId !== agent.id) throw new AuthorizationError();
            }
          const providerContext = await resolvedManagedProviderContext(c);
          assertManagedAuthorizationProvider(attempt, {
            generation: providerContext.generation,
            lineage: providerContext.lineage,
          });
          const provider = providerContext.providers.get(attempt.adapterId);
          if (!provider?.pollAuthorization) {
            throw new ManagedConnectionProviderUnavailableError(attempt.adapterId);
          }
          cleanupProvider = provider;
          const result = await provider.pollAuthorization({
            authorizationRef: attempt.authorizationRef,
            principalRef: attempt.principalRef,
            toolkit: attempt.toolkit,
          });
          if (result.status === 'pending') return { status: 'pending' as const };
          if (result.status === 'terminal') {
            const service = connectionAccounts(c, providerContext.providers);
            const remoteRef = managedAuthorizationRemoteRef(attempt);
            if (remoteRef && !await service.hasManagedRemoteRef({
              adapterId: attempt.adapterId,
              accountRef: remoteRef,
            })) {
              if (provider.cleanupRemoteAccount) {
                await provider.cleanupRemoteAccount({ accountRef: remoteRef });
              } else {
                await provider.revoke({
                  policy: {
                    kind: 'managed',
                    adapterId: attempt.adapterId,
                    toolkit: attempt.toolkit,
                    principalRef: attempt.principalRef,
                    accountRef: remoteRef,
                    allowedCapabilities: [...attempt.allowedCapabilities],
                  },
                });
              }
            }
            await abandonManagedAuthorization({
              settings: settings(c),
              actorMembershipId: principal.membershipId,
              browserSecret,
            });
            return { status: 'terminal' as const, reason: result.reason };
          }
          remoteAccountObserved = true;
          attempt = await recordManagedAuthorizationAccount({
            settings: settings(c),
            actorMembershipId: principal.membershipId,
            browserSecret,
            accountRef: result.accountRef,
            toolkit: result.toolkit,
          });
          cleanupAttempt = attempt;
          assertManagedAuthorizationProvider(attempt, {
            generation: providerContext.generation,
            lineage: providerContext.lineage,
          });
          const service = connectionAccounts(c, providerContext.providers);
          cleanupService = service;
          if (!attempt.connectionAccountId) {
            await service.assertManagedLaneAvailable({
              principal,
              agentId: agent.id,
              ownerKind: attempt.ownerKind,
              adapterId: attempt.adapterId,
              toolkit: attempt.toolkit,
            });
          }
          const imported = await service.findManagedByRemoteRef({
            principal,
            workspaceId: attempt.workspaceId,
            adapterId: attempt.adapterId,
            accountRef: attempt.accountRef!,
          });
          let account: ConnectionAccount;
          if (attempt.connectionAccountId) {
            const current = await service.getForManagement(principal, attempt.connectionAccountId);
            if (current.policy.kind !== 'managed') throw new ManagedAuthorizationError('invalid');
            account = await service.replaceManagedAuthorization({
              principal,
              agentId: agent.id,
              connectionAccountId: current.id,
              expectedRevision: current.revision,
              adapterId: attempt.adapterId,
              toolkit: attempt.toolkit,
              principalRef: attempt.principalRef,
              expectedAllowedCapabilities: attempt.allowedCapabilities,
              allowedCapabilities: attempt.allowedCapabilities,
              accountRef: attempt.accountRef!,
              providerGeneration: providerContext.generation,
              providerLineage: providerContext.lineage,
            });
          } else if (imported) {
            const binding = await store(c).getAgentConnectionBindingForAccount(imported.id);
            if (
              imported.policy.kind !== 'managed' ||
              imported.policy.oauthAttemptId !== managedAuthorizationAttemptId(attempt) ||
              binding?.agentId !== agent.id
            ) {
              throw new ManagedConnectionConflictError(
                'Managed authorization returned an account that belongs to another setup',
              );
            }
            account = imported;
          } else {
            if (!attempt.bindingCapabilities) throw new ManagedAuthorizationError('invalid');
            const created = await service.createForAgent({
              principal,
              agentId: agent.id,
              workspaceId: attempt.workspaceId,
              ownerKind: attempt.ownerKind,
              providerId: attempt.providerId,
              label: attempt.label,
              policy: {
                kind: 'managed',
                adapterId: attempt.adapterId,
                toolkit: attempt.toolkit,
                principalRef: attempt.principalRef,
                accountRef: attempt.accountRef!,
                allowedCapabilities: [...attempt.allowedCapabilities],
                oauthAttemptId: managedAuthorizationAttemptId(attempt),
                providerGeneration: providerContext.generation,
                providerLineage: providerContext.lineage,
              },
              allowedCapabilities: [...attempt.bindingCapabilities],
            });
            account = created.account;
          }
          try {
            await finalizeManagedAuthorization({
              settings: settings(c),
              actorMembershipId: principal.membershipId,
              browserSecret,
            });
          } catch {
            // The account and optional Agent binding are already durable. A
            // competing poll may have consumed the attempt, so report the
            // working connection instead of deleting valid authorization.
            console.warn(JSON.stringify({
              event: 'chickpea.managed_connection.finalization_deferred',
              adapterId: attempt.adapterId,
              toolkit: attempt.toolkit,
            }));
          }
          return { status: 'connected' as const, account: toConnectionAccountView(account) };
          } catch (error) {
            if (error instanceof ManagedProviderRequestError &&
                error.metadata.definiteFailure !== true) {
              throw error;
            }
            if (!remoteAccountObserved) throw error;
            let cleanupComplete = true;
            let remoteIdentitySafe = false;
            const remoteRef = cleanupAttempt && managedAuthorizationRemoteRef(cleanupAttempt);
            if (!remoteIdentitySafe && cleanupComplete && remoteRef && cleanupService) {
              try {
                if (await cleanupService.hasManagedRemoteRef({
                  adapterId: cleanupAttempt!.adapterId,
                  accountRef: remoteRef,
                })) {
                  remoteIdentitySafe = true;
                } else if (cleanupProvider?.cleanupRemoteAccount) {
                  await cleanupProvider.cleanupRemoteAccount({ accountRef: remoteRef });
                  remoteIdentitySafe = true;
                } else {
                  cleanupComplete = false;
                }
              } catch {
                cleanupComplete = false;
              }
            }
            if (cleanupComplete && remoteIdentitySafe) {
              try {
                await abandonManagedAuthorizationForRestart({
                  settings: settings(c),
                  actorMembershipId: principal.membershipId,
                  browserSecret,
                });
              } catch {
                cleanupComplete = false;
              }
            }
            if (!cleanupComplete) {
              console.error(JSON.stringify({
                event: 'chickpea.managed_connection.poll_cleanup_failed',
                adapterId: cleanupAttempt?.adapterId ?? 'composio',
              }));
              throw error;
            }
            if (error instanceof ManagedProviderRequestError &&
                error.metadata.definiteFailure === true) {
              return { status: 'terminal' as const, reason: 'failed' as const };
            }
            if (error instanceof AuthorizationError || error instanceof UnknownAgentError ||
                error instanceof ManagedConnectionProviderUnavailableError ||
                error instanceof ManagedAuthorizationError) {
              throw error;
            }
            throw new ManagedAuthorizationError('invalid');
          }
        })();
      const result = await poll;
      if (result.status === 'pending') return c.json({ status: 'pending' }, 202);
      deleteCookie(c, MANAGED_AUTHORIZATION_BROWSER_COOKIE, { path: '/admin', secure: true });
      if (result.status === 'terminal') {
        return c.json({ error: 'managed_authorization_terminal', reason: result.reason }, 409);
      }
      return c.json({ status: 'connected', account: result.account });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return c.json({
          error: 'forbidden',
          message: 'You no longer have permission to finish this sign-in.',
        }, 403);
      }
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof ManagedAuthorizationError && error.code === 'stale_provider') {
        return c.json({
          error: 'managed_authorization_stale_provider',
          message: 'The connector configuration changed. Start this sign-in again.',
        }, 409);
      }
      if (error instanceof ManagedAuthorizationError) {
        deleteCookie(c, MANAGED_AUTHORIZATION_BROWSER_COOKIE, { path: '/admin', secure: true });
        return c.json({ error: 'managed_authorization_invalid' }, 409);
      }
      if (error instanceof ManagedConnectionProviderUnavailableError) {
        return c.json({
          error: 'managed_provider_unavailable',
          message: 'Managed sign-in is temporarily unavailable. Try again.',
        }, 503);
      }
      if (error instanceof ManagedProviderRequestError) {
        return c.json({
          error: 'managed_authorization_poll_unavailable',
          message: 'Managed sign-in could not be checked yet. Chickpea will keep trying.',
        }, 503);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/connections/managed/cancel', async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await readJson(c.req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
      return invalidRequest(c);
    }
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const agent = await store(c).getAgent(c.req.param('id'));
      requireAgentEdit(principal, agent);
      const browserSecret = getCookie(c, MANAGED_AUTHORIZATION_BROWSER_COOKIE) ?? '';
      const attempt = await inspectManagedAuthorization({
        settings: settings(c),
        actorMembershipId: principal.membershipId,
        browserSecret,
      });
      const organization = await identity(c).getOrganization();
      if (organization?.slackTeamId !== attempt.workspaceId) throw new AuthorizationError();
      if (attempt.agentId !== agent.id) throw new ManagedAuthorizationError('invalid');
      const remoteRef = managedAuthorizationRemoteRef(attempt);
      if (remoteRef) {
        const service = await resolvedConnectionAccounts(c);
        const imported = await service.hasManagedRemoteRef({
          adapterId: attempt.adapterId,
          accountRef: remoteRef,
        });
        if (!imported) {
          const provider = (await resolvedManagedProviderContext(c)).providers.get(attempt.adapterId);
          if (!provider) throw new ManagedConnectionProviderUnavailableError(attempt.adapterId);
          await provider.revoke({
            policy: {
              kind: 'managed',
              adapterId: attempt.adapterId,
              toolkit: attempt.toolkit,
              principalRef: attempt.principalRef,
              accountRef: remoteRef,
              allowedCapabilities: [...attempt.allowedCapabilities],
            },
          });
        }
      }
      await abandonManagedAuthorization({
        settings: settings(c),
        actorMembershipId: principal.membershipId,
        browserSecret,
      });
      deleteCookie(c, MANAGED_AUTHORIZATION_BROWSER_COOKIE, { path: '/admin', secure: true });
      return c.json({ cancelled: true });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof ManagedAuthorizationError) {
        return c.json({ error: 'managed_authorization_invalid' }, 409);
      }
      if (error instanceof ManagedConnectionProviderUnavailableError) {
        return c.json({ error: 'managed_provider_unavailable' }, 503);
      }
      return internalError(c, error);
    }
  });

  app.get(
    '/admin/api/agents/:agentId/connections/:connectionAccountId/managed/resources',
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const workspaceId = c.req.query('workspaceId')?.trim() ?? '';
      const resourceKey = c.req.query('resourceKey')?.trim() ?? '';
      const cursor = c.req.query('cursor')?.trim();
      if (!/^[A-Z0-9_]{2,32}$/.test(workspaceId) ||
          !/^[a-z][A-Za-z0-9]{0,127}$/.test(resourceKey) ||
          cursor && cursor.length > 2_000) return invalidRequest(c);
      try {
        const principal = principalByContext.get(c);
        if (!principal) throw new AuthorizationError('principal_required');
        const agent = await store(c).getAgent(c.req.param('agentId'));
        requireAgentEdit(principal, agent);
        const organization = await identity(c).getOrganization();
        if (organization?.slackTeamId !== workspaceId) throw new AuthorizationError();
        const service = await resolvedConnectionAccounts(c);
        const account = await service.getForManagement(
          principal,
          c.req.param('connectionAccountId'),
        );
        if (account.workspaceId !== workspaceId) throw new AuthorizationError();
        return c.json(await service.listManagedResources({
          principal,
          agentId: agent.id,
          connectionAccountId: account.id,
          resourceKey,
          ...(cursor ? { cursor } : {}),
        }));
      } catch (error) {
        if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
        if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
        if (error instanceof ManagedResourceSelectionError) return c.json({
          error: error.code === 'unavailable'
            ? 'managed_resources_unavailable'
            : 'invalid_managed_resource',
          message: error.message,
        }, error.code === 'unavailable' ? 503 : 400);
        return internalError(c, error);
      }
    },
  );

  app.post(
    '/admin/api/agents/:agentId/connections/:connectionAccountId/managed/resources',
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const parsed = v.safeParse(managedResourceSelectionSchema, await readJson(c.req));
      if (!parsed.success) return invalidRequest(c);
      try {
        const principal = principalByContext.get(c);
        if (!principal) throw new AuthorizationError('principal_required');
        const organization = await identity(c).getOrganization();
        if (organization?.slackTeamId !== parsed.output.workspaceId) {
          throw new AuthorizationError();
        }
        const service = await resolvedConnectionAccounts(c);
        const account = await service.getForManagement(
          principal,
          c.req.param('connectionAccountId'),
        );
        if (account.workspaceId !== parsed.output.workspaceId) throw new AuthorizationError();
        return c.json(await service.selectManagedResources({
          principal,
          agentId: c.req.param('agentId'),
          connectionAccountId: account.id,
          expectedRevision: parsed.output.expectedRevision,
          resourceConstraints: parsed.output.resourceConstraints,
        }));
      } catch (error) {
        if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
        if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
        if (error instanceof ManagedResourceSelectionError) {
          const status = error.code === 'stale' ? 409 : error.code === 'unavailable' ? 503 : 400;
          return c.json({
            error: error.code === 'stale'
              ? 'managed_resource_selection_stale'
              : error.code === 'unavailable'
              ? 'managed_resources_unavailable'
              : 'invalid_managed_resource',
            message: error.message,
          }, status);
        }
        return internalError(c, error);
      }
    },
  );

  app.post('/admin/api/agents/:agentId/mcp/oauth/:connectionId/start', async (c) => {
    c.header('Cache-Control', 'no-store');
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const parsed = v.safeParse(mcpOAuthStartSchema, await readJson(c.req));
    if (!parsed.success) {
      return invalidRequest(c);
    }
    let connection: McpConnectionConfig | undefined;
    try {
      connection = (await store(c).getAgent(agentId)).mcpServers.find(
        (server) => server.id === connectionId,
      );
    } catch (error) {
      if (error instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, error);
    }
    if (!connection) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (connection.authMode !== 'oauth') {
      return c.json({ error: 'oauth_not_enabled' }, 409);
    }
    try {
      const oauthScope = connection.oauthScope ?? parsed.output.scope;
      const result = await startMcpOAuth(
        {
          ref: { agentId, connectionId },
          serverUrl: connection.url,
          callbackUrl: `${requestOrigin(c)}/oauth/callback`,
          ...(oauthScope ? { scope: oauthScope } : {}),
        },
        oauthDependencies(c),
      );
      return c.json({ authorizationUrl: result.authorizationUrl.href });
    } catch (error) {
      if (error instanceof McpOAuthError && error.code === 'connection_missing') {
        return c.json({ error: 'not_found' }, 404);
      }
      console.error(
        '[chickpea] MCP OAuth start failed:',
        error instanceof McpOAuthError ? error.code : 'internal_error',
      );
      return c.json({ error: 'oauth_unavailable' }, 502);
    }
  });

  app.post('/admin/api/agents/:agentId/connections/:connectionAccountId/oauth/mcp/start', async (c) => {
    c.header('Cache-Control', 'no-store');
    const agentId = c.req.param('agentId');
    const connectionAccountId = c.req.param('connectionAccountId');
    if (!AGENT_ID_PATTERN.test(agentId) || !/^connection_[A-Za-z0-9_-]{1,180}$/.test(connectionAccountId)) {
      return invalidRequest(c);
    }
    const parsed = v.safeParse(connectionAccountOAuthStartSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const { account } = await managedConnectionAccount(c, agentId, connectionAccountId);
      if (account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth') {
        return c.json({ error: 'oauth_not_enabled' }, 409);
      }
      const ref = connectionAccountOAuthRef(account.id);
      const pendingAccount = await replacePendingMcpOAuthConnection(
        store(c), ref, account.policy.url,
      );
      const result = await startMcpOAuth(
        {
          ref,
          serverUrl: account.policy.url,
          callbackUrl: `${requestOrigin(c)}/oauth/callback`,
          ...(account.policy.oauthScope ? { scope: account.policy.oauthScope } : {}),
          returnAgentId: agentId,
          accountRevision: pendingAccount.revision,
          oauthAttemptId: pendingAccount.policy.oauthAttemptId!,
        },
        oauthDependencies(c),
      );
      return c.json({ authorizationUrl: result.authorizationUrl.href });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof McpOAuthError && error.code === 'connection_missing') {
        return c.json({ error: 'not_found' }, 404);
      }
      console.error(
        '[chickpea] Connection-account MCP OAuth start failed:',
        error instanceof McpOAuthError ? error.code : 'internal_error',
      );
      return c.json({ error: 'oauth_unavailable' }, 502);
    }
  });

  app.put('/admin/api/agents/:agentId/api-connections/oauth/:connectionId/client', async (c) => {
    c.header('Cache-Control', 'no-store');
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const parsed = v.safeParse(apiOAuthClientSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const ref = { agentId, connectionId };
    let connection: CustomAgentConfig['apiConnections'][number] | undefined;
    try {
      connection = (await store(c).getAgent(agentId)).apiConnections.find(
        (candidate) => candidate.id === connectionId,
      );
    } catch (error) {
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
    if (
      !connection ||
      connection.authMode !== 'oauth' ||
      connection.oauthProvider !== parsed.output.provider ||
      !isValidApiOAuthConnectionPolicy(connection)
    ) {
      return c.json({ error: 'not_found' }, 404);
    }
    try {
      await stageConnectorSecretCleanup(agentId, [connectionId], c.env as PlatformEnv | undefined, settings(c));
      await stageConnectorSettingCleanup(agentId, apiOAuthSettingKeys(ref), c.env as PlatformEnv | undefined, settings(c));
      await clearConnectorCredential(agentId, connectionId, c.env as PlatformEnv | undefined, settings(c));
      // A token bundle belongs to the client that minted it. Replacing the
      // BYO app must not leave old access/refresh tokens usable under a new
      // client id, or defer the mismatch until the next refresh.
      await deleteApiOAuthSettings(ref, settings(c));
      await saveApiOAuthClient(ref, parsed.output, settings(c));
      if (!(await isCurrentApiOAuthConnection(store(c), ref, parsed.output.provider))) {
        await deleteApiOAuthSettings(ref, settings(c));
        return c.json({ error: 'connection_changed' }, 409);
      }
      await replacePendingApiOAuthConnection(store(c), ref, parsed.output.provider);
      return c.json({ source: 'stored' });
    } catch (error) {
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:agentId/api-connections/oauth/:connectionId/start', async (c) => {
    c.header('Cache-Control', 'no-store');
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const body = await readJson(c.req);
    if (!isRecord(body) || Object.keys(body).length > 0) return invalidRequest(c);
    const ref = { agentId, connectionId };
    let connection: CustomAgentConfig['apiConnections'][number] | undefined;
    try {
      connection = (await store(c).getAgent(agentId)).apiConnections.find(
        (candidate) => candidate.id === connectionId,
      );
    } catch (error) {
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
    if (
      !connection ||
      connection.authMode !== 'oauth' ||
      connection.oauthProvider !== 'google' ||
      !connection.oauthScopes ||
      !isValidApiOAuthConnectionPolicy(connection)
    ) {
      return c.json({ error: 'oauth_not_enabled' }, 409);
    }
    try {
      const result = await startApiOAuth(
        {
          ref,
          provider: connection.oauthProvider,
          callbackUrl: `${requestOrigin(c)}/oauth/api/callback`,
          scopes: connection.oauthScopes,
        },
        apiOAuthDependencies(c),
      );
      return c.json({ authorizationUrl: result.authorizationUrl.href });
    } catch (error) {
      if (error instanceof ApiOAuthError && error.code === 'connection_missing') {
        return c.json({ error: 'not_found' }, 404);
      }
      if (error instanceof ApiOAuthError && error.code === 'client_missing') {
        return c.json({ error: 'oauth_client_missing' }, 409);
      }
      console.error(
        '[chickpea] API OAuth start failed:',
        error instanceof ApiOAuthError ? error.code : 'internal_error',
      );
      return c.json({ error: 'oauth_unavailable' }, 502);
    }
  });

  app.put('/admin/api/agents/:agentId/connections/:connectionAccountId/oauth/api/client', async (c) => {
    c.header('Cache-Control', 'no-store');
    const agentId = c.req.param('agentId');
    const connectionAccountId = c.req.param('connectionAccountId');
    if (!AGENT_ID_PATTERN.test(agentId) || !/^connection_[A-Za-z0-9_-]{1,180}$/.test(connectionAccountId)) {
      return invalidRequest(c);
    }
    const parsed = v.safeParse(apiOAuthClientSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const { account } = await managedConnectionAccount(c, agentId, connectionAccountId);
      if (!isApiOAuthAccount(account, parsed.output.provider)) {
        return c.json({ error: 'oauth_not_enabled' }, 409);
      }
      const ref = connectionAccountOAuthRef(account.id);
      await deleteApiOAuthSettings(ref, settings(c));
      await saveApiOAuthClient(ref, parsed.output, settings(c));
      if (!(await isCurrentApiOAuthConnection(store(c), ref, parsed.output.provider))) {
        await deleteApiOAuthSettings(ref, settings(c));
        return c.json({ error: 'connection_changed' }, 409);
      }
      await replacePendingApiOAuthConnection(store(c), ref, parsed.output.provider);
      return c.json({ source: 'stored' });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:agentId/connections/:connectionAccountId/oauth/api/start', async (c) => {
    c.header('Cache-Control', 'no-store');
    const agentId = c.req.param('agentId');
    const connectionAccountId = c.req.param('connectionAccountId');
    if (!AGENT_ID_PATTERN.test(agentId) || !/^connection_[A-Za-z0-9_-]{1,180}$/.test(connectionAccountId)) {
      return invalidRequest(c);
    }
    const parsed = v.safeParse(connectionAccountOAuthStartSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const { principal, account } = await managedConnectionAccount(c, agentId, connectionAccountId);
      if (!isApiOAuthAccount(account, 'google') || account.policy.kind !== 'api') {
        return c.json({ error: 'oauth_not_enabled' }, 409);
      }
      if (parsed.output.continuation?.workspaceId !== undefined &&
          parsed.output.continuation.workspaceId !== account.workspaceId) {
        throw new AuthorizationError();
      }
      const ref = connectionAccountOAuthRef(account.id);
      const pendingAccount = await replacePendingApiOAuthConnection(store(c), ref, 'google');
      if (!pendingAccount) throw new ApiOAuthError(
        'connection_missing', 'Agent-owned OAuth connection is missing',
      );
      const result = await startApiOAuth(
        {
          ref,
          provider: 'google',
          callbackUrl: `${requestOrigin(c)}/oauth/api/callback`,
          scopes: account.policy.oauthScopes!,
          returnAgentId: agentId,
          accountRevision: pendingAccount.revision,
          oauthAttemptId: pendingAccount.policy.oauthAttemptId!,
        },
        apiOAuthDependencies(c),
      );
      let continuationId: string | undefined;
      if (parsed.output.continuation) {
        const issued = await createOAuthContinuation({
          settings: settings(c),
          workspaceId: account.workspaceId,
          actorMembershipId: principal.membershipId,
          agentId,
          channelId: parsed.output.continuation.channelId,
          threadTs: parsed.output.continuation.threadTs,
          taskId: parsed.output.continuation.taskId,
          providerId: account.providerId,
          accountId: account.id,
        });
        await linkOAuthProviderState({
          settings: settings(c),
          providerState: result.state,
          continuationState: issued.state,
        });
        continuationId = issued.continuation.id;
      }
      return c.json({
        authorizationUrl: result.authorizationUrl.href,
        ...(continuationId ? { continuationId } : {}),
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof ApiOAuthError && error.code === 'client_missing') {
        return c.json({ error: 'oauth_client_missing' }, 409);
      }
      if (error instanceof ApiOAuthError && error.code === 'connection_missing') {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, error);
    }
  });

  const adminPage = (c: Context): Response => {
    // The shell contains the full inline application. Never let a browser keep
    // an older deployment's JavaScript after the Worker has been updated.
    c.header('Cache-Control', 'no-store');
    return c.html(renderAdminPage({ usageAdminUi: usageAdminUi(c) }));
  };

  app.get('/admin', adminPage);

  app.post('/admin/logout', async (c) => {
    authResponseHeaders(c);
    const context = await betterAuthContext(c);
    if (!context) return c.redirect('/auth/slack/sign-in?destination=%2Fadmin', 303);
    const handler = createBetterAuthEnvironmentPublicHandler({
      environment: context.environment,
    });
    const response = await handler(betterAuthJsonRequest(
      c.req.raw,
      context.environment.baseURL,
      '/api/auth/sign-out',
      {},
    ));
    copyAuthResponseCookies(c, response.headers);
    clearBetterAuthCookies(c);
    return c.redirect('/auth/slack/sign-in?destination=%2Fadmin', 303);
  });

  app.route('/admin/api', createTeamAdminApi({
    store: identity,
    memberProfile: async (c, slackTeamId, slackUserId) => {
      try {
        return await (await agentSlackTransport(c, slackTeamId)).lookupMember(slackUserId);
      } catch {
        return undefined;
      }
    },
    revokeBetterAuthSessions: async (c, betterAuthUserId) => {
      const context = await betterAuthContext(c);
      return context?.environment.backend.deleteSessionsForUser(betterAuthUserId) ?? 0;
    },
    rateLimiter: async (c) => {
      const context = await betterAuthContext(c);
      const secret = context?.environment.secret ?? options.authSecret;
      return secret ? authRateLimiter(c, secret) : undefined;
    },
    ...(sharedManagementEnabled
      ? { management: managementService }
      : {}),
  }));
  app.route('/admin/api', createRoutineAdminApi({
    store: routines,
    usage,
    work,
    contentAccess: routineContentAccess,
    ...(options.routineCapability ? { capability: options.routineCapability } : {}),
  }));
  app.route('/admin/api', createUsageAdminApi({ store: usage, work }));
  app.route('/admin/api', createWorkAdminApi({
    store: work,
    usage,
    privateWork: async (c, workId) =>
      (await routines(c).getRoutineByWorkId(workId))?.destination.kind === 'direct_thread',
  }));

  app.get('/admin/api/runtime/drain', async (c) => {
    try {
      const status = await runtimeDrain(c.env as PlatformEnv | undefined);
      c.header('Cache-Control', 'no-store');
      return c.json(status);
    } catch {
      console.error('[chickpea] runtime drain state unavailable');
      return c.json({ error: 'runtime_drain_unavailable' }, 503);
    }
  });

  app.get('/admin/api/runtime/slack-presentations', async (c) => {
    const workspaceId = c.req.query('workspaceId')?.trim();
    if (!workspaceId || !/^[A-Za-z0-9_-]{1,200}$/.test(workspaceId)) {
      return invalidRequest(c);
    }
    try {
      const connected = await readStoredSlackTeamInfo(
        c.env as PlatformEnv | undefined,
        settings(c),
        slackCredentialResolutionDependencies(c),
      );
      if (!connected.teamId || connected.teamId !== workspaceId) {
        c.header('Cache-Control', 'no-store');
        return c.json({ error: 'workspace_not_authorized' }, 403);
      }
      const presentationStore = slackState(c);
      const summarize = presentationStore.summarizeRunPresentations;
      if (!summarize) throw new Error('Slack presentation summary is unavailable.');
      c.header('Cache-Control', 'no-store');
      return c.json(await summarize.call(presentationStore, workspaceId));
    } catch {
      console.error('[chickpea] Slack presentation summary unavailable');
      return c.json({ error: 'slack_presentation_summary_unavailable' }, 503);
    }
  });

  app.get('/admin/api/runtime/recovery-turns', async (c) => {
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (rawLimit !== undefined && !/^\d+$/.test(rawLimit))) {
      return invalidRequest(c);
    }
    try {
      const recoveryStore = slackState(c);
      const list = recoveryStore.listTurnRecoveryRequired;
      if (!list) throw new Error('Turn recovery inventory is unavailable.');
      c.header('Cache-Control', 'no-store');
      return c.json({ turns: await list.call(recoveryStore, limit) });
    } catch {
      console.error('[chickpea] turn recovery inventory unavailable');
      return c.json({ error: 'turn_recovery_unavailable' }, 503);
    }
  });

  app.post('/admin/api/runtime/recovery-turns/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const idempotencyKey = c.req.header('idempotency-key')?.trim();
    const origin = c.req.header('origin');
    const bearerAuthenticated = c.req.header('authorization') !== undefined;
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(id) ||
        !idempotencyKey || idempotencyKey.length > 200 ||
        !/^[A-Za-z0-9_.:-]+$/.test(idempotencyKey) ||
        (!bearerAuthenticated && origin !== requestOrigin(c))) {
      return invalidRequest(c);
    }
    const parsed = v.safeParse(turnRecoveryResolveSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const recoveryStore = slackState(c);
      const resolve = recoveryStore.resolveTurnRecoveryRequired;
      if (!resolve) throw new Error('Turn recovery resolution is unavailable.');
      const resolved = await resolve.call(recoveryStore, id);
      c.header('Cache-Control', 'no-store');
      return c.json({ id, resolved });
    } catch {
      console.error('[chickpea] turn recovery resolution unavailable');
      return c.json({ error: 'turn_recovery_unavailable' }, 503);
    }
  });

  app.get('/admin/api/agents', async (c) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const configStore = store(c);
    const [allAgents, grants, installations] = await Promise.all([
      configStore.listUserAgents(),
      configStore.listAgentChannelGrants(),
      configStore.listWorkspaceInstallations(),
    ]);
    const principal = principalByContext.get(c);
    const rawAgents = principal
      ? allAgents.filter((agent) => canEditAgent(principal, agent))
      : allAgents;
    const agents = await Promise.all(
      rawAgents.map((agent) =>
        withApiConnectionSources(agent, platformEnv, settingsStore),
      ),
    );
    const roots = await Promise.all(
      agents.map((agent) => snapshots(c).listLiveRootsByAgent(agent.id)),
    );
    return c.json({
      agents: await Promise.all(agents.map((agent, index) =>
        agentAdminProjection(agent, configStore, snapshots(c), {
          references: {
            agentId: agent.id,
            channelGrants: [...new Map(
              grants
                .filter(({ agentId }) => agentId === agent.id)
                .map(({ workspaceId, channelId }) => ({ workspaceId, channelId }))
                .map((reference) => [
                `${reference.workspaceId}\u0000${reference.channelId}`,
                reference,
              ]),
            ).values()],
          },
          grants: grants.filter(({ agentId }) => agentId === agent.id),
          installations,
          snapshotRoots: roots[index]!,
        }, {
          canEdit: principal ? canEditAgent(principal, agent) : true,
        })
      )),
    });
  });

  app.get('/admin/api/model-catalog', async (c) => {
    await loadModelCatalog(settings(c));
    return c.json(await safeModelCatalogStatus(settings(c)));
  });

  app.post('/admin/api/model-catalog/refresh', async (c) => {
    const refresh = await refreshCatalog(c, true);
    return c.json({
      refresh,
      catalog: await safeModelCatalogStatus(settings(c)),
    });
  });

  app.put('/admin/api/model-catalog/mode', async (c) => {
    const parsed = v.safeParse(modelCatalogModeSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const settingsStore = settings(c);
    await settingsStore.setSetting(MODEL_CATALOG_SETTING_KEYS.mode, parsed.output.mode);
    const refresh = parsed.output.mode === 'bundled'
      ? ({
          status: 'bundled',
          revision: activateBundledModelCatalog().revision,
        } satisfies ModelCatalogRefreshResult)
      : await refreshCatalog(c, true);
    return c.json({
      refresh,
      catalog: await safeModelCatalogStatus(settingsStore),
    });
  });

  // The profile picker's single source of provider groups + suggestions.
  // Reviewed catalog entries augment the API-key providers. OpenRouter and the keyless
  // Workers AI binding show ONLY the user's starred favorites (curated in the
  // Settings managers), so this route folds those favorites into their
  // suggestions — the per-provider search/favorites endpoints stay the editors.
  app.get('/admin/api/models', async (c) => {
    const settingsStore = settings(c);
    await refreshCatalog(c, false);
    const [subscription, activeAuthMethod, workersAiEnabled] = await Promise.all([
      getOpenAiSubscriptionAuthorizationStatus(settingsStore),
      resolveOpenAiAuthMethod(settingsStore),
      getWorkersAiEnabled(settingsStore),
    ]);
    const openAiApiModels = activeCatalogModels('openai_api_key');
    const anthropicApiModels = activeCatalogModels('anthropic_api_key');
    const providers = await Promise.all(
      modelProviders()
        .filter((provider) => provider.id !== 'cloudflare' || workersAiEnabled)
        .map(async (provider) => {
        if (provider.id === 'openai') {
          return {
            ...provider,
            suggestions: uniqueStrings([
              ...openAiApiModels.map((model) => model.canonical),
              ...provider.suggestions,
            ]),
            authMethods: {
              activeMethod: activeAuthMethod,
              apiKeyConfigured: provider.configured,
              subscription,
            },
          };
        }
        if (provider.id === 'openrouter') {
          const favorites = await getProviderFavorites('openrouter', settingsStore);
          return { ...provider, suggestions: favorites.map((model) => `openrouter/${model}`) };
        }
        // The binding-backed CF provider surfaces as `cloudflare`; its favorites
        // live under the `workers-ai` key and pin as `cloudflare/<model>`.
        if (provider.id === 'cloudflare') {
          const favorites = await getProviderFavorites('workers-ai', settingsStore);
          return { ...provider, suggestions: favorites.map((model) => `cloudflare/${model}`) };
        }
        if (provider.id === 'anthropic') {
          return {
            ...provider,
            suggestions: uniqueStrings([
              ...anthropicApiModels.map((model) => model.canonical),
              ...provider.suggestions,
            ]),
          };
        }
        return provider;
        }),
    );
    return c.json({ providers });
  });

  app.get('/admin/api/workspace-model-default', async (c) => {
    const configStore = store(c);
    const installation = await modelDefaultInstallation(configStore);
    if (!installation) {
      return c.json({ error: 'workspace_installation_required' }, 409);
    }
    await loadModelCatalog(settings(c));
    return c.json({
      workspaceDefault: await workspaceModelDefaultProjection({
        installation,
        configStore,
        settingsStore: settings(c),
        platformEnv: c.env as PlatformEnv | undefined,
        runtimeProviders: modelProviders(),
      }),
    });
  });

  app.put('/admin/api/workspace-model-default', async (c) => {
    const parsed = v.safeParse(workspaceModelDefaultSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const configStore = store(c);
    const installation = await modelDefaultInstallation(configStore);
    if (!installation) {
      return c.json({ error: 'workspace_installation_required' }, 409);
    }
    const principal = principalByContext.get(c);
    if (!principal || (principal.role !== 'owner' && principal.role !== 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await loadModelCatalog(settings(c));
    const compatibilityError = activeCatalogCompatibilityError(
      parsed.output.modelId,
      await resolveOpenAiAuthMethod(settings(c)),
    );
    if (compatibilityError) return invalidRequest(c, compatibilityError);
    try {
      await configStore.putWorkspaceModelDefault({
        workspaceId: installation.workspaceId,
        modelId: parsed.output.modelId,
        provenance: 'admin_selected',
        lastChangedByMembershipId: principal.membershipId,
      }, parsed.output.expectedRevision);
      return c.json({
        workspaceDefault: await workspaceModelDefaultProjection({
          installation,
          configStore,
          settingsStore: settings(c),
          platformEnv: c.env as PlatformEnv | undefined,
          runtimeProviders: modelProviders(),
        }),
      });
    } catch (error) {
      if (error instanceof WorkspaceModelDefaultRevisionConflictError) {
        return c.json({
          error: 'workspace_model_default_revision_conflict',
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
          workspaceDefault: await workspaceModelDefaultProjection({
            installation,
            configStore,
            settingsStore: settings(c),
            platformEnv: c.env as PlatformEnv | undefined,
            runtimeProviders: modelProviders(),
          }),
        }, 409);
      }
      return internalError(c, error);
    }
  });

  app.get('/admin/api/chickpea-cutover/preflight', async (c) => {
    const principal = principalByContext.get(c);
    if (!principal || (principal.role !== 'owner' && principal.role !== 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const configStore = store(c);
    const installation = await modelDefaultInstallation(configStore);
    if (!installation) return c.json({ error: 'workspace_installation_required' }, 409);
    await loadModelCatalog(settings(c));
    const [cutover, workspaceDefault] = await Promise.all([
      configStore.preflightChickpeaCutover(installation.workspaceId),
      workspaceModelDefaultProjection({
        installation,
        configStore,
        settingsStore: settings(c),
        platformEnv: c.env as PlatformEnv | undefined,
        runtimeProviders: modelProviders(),
      }),
    ]);
    return c.json({
      cutover: {
        ...cutover,
        defaultHealth: workspaceDefault.health,
        readyForActivation: cutover.blockers.length === 0 &&
          workspaceDefault.health.status === 'ready',
      },
    });
  });

  app.post('/admin/api/chickpea-cutover/prepare', async (c) => {
    const parsed = v.safeParse(chickpeaCutoverPrepareSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const principal = principalByContext.get(c);
    if (!principal || (principal.role !== 'owner' && principal.role !== 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const configStore = store(c);
    const installation = await modelDefaultInstallation(configStore);
    if (!installation) return c.json({ error: 'workspace_installation_required' }, 409);
    const legacyEnvironmentModel = cutoverEnvironmentModel(c.env as PlatformEnv | undefined);
    const cutover = await configStore.prepareChickpeaCutover({
      workspaceId: installation.workspaceId,
      ...(legacyEnvironmentModel ? { legacyEnvironmentModel } : {}),
    });
    await loadModelCatalog(settings(c));
    const workspaceDefault = await workspaceModelDefaultProjection({
      installation,
      configStore,
      settingsStore: settings(c),
      platformEnv: c.env as PlatformEnv | undefined,
      runtimeProviders: modelProviders(),
    });
    return c.json({
      cutover: {
        ...cutover,
        defaultHealth: workspaceDefault.health,
        readyForActivation: cutover.blockers.length === 0 &&
          workspaceDefault.health.status === 'ready',
      },
    });
  });

  app.post('/admin/api/chickpea-cutover/activate', async (c) => {
    const parsed = v.safeParse(chickpeaCutoverActivateSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const principal = principalByContext.get(c);
    if (!principal || (principal.role !== 'owner' && principal.role !== 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const configStore = store(c);
    const installation = await modelDefaultInstallation(configStore);
    if (!installation) return c.json({ error: 'workspace_installation_required' }, 409);
    await loadModelCatalog(settings(c));
    const [cutover, workspaceDefault] = await Promise.all([
      configStore.preflightChickpeaCutover(installation.workspaceId),
      workspaceModelDefaultProjection({
        installation,
        configStore,
        settingsStore: settings(c),
        platformEnv: c.env as PlatformEnv | undefined,
        runtimeProviders: modelProviders(),
      }),
    ]);
    if (cutover.blockers.length > 0 || workspaceDefault.health.status !== 'ready') {
      return c.json({
        error: 'chickpea_cutover_preflight_failed',
        blockers: cutover.blockers,
        defaultHealth: workspaceDefault.health,
      }, 409);
    }
    if (cutover.installationRevision !== parsed.output.expectedInstallationRevision) {
      return c.json({
        error: 'chickpea_cutover_revision_conflict',
        expectedRevision: parsed.output.expectedInstallationRevision,
        actualRevision: cutover.installationRevision,
      }, 409);
    }
    if (cutover.defaultRevision !== parsed.output.expectedDefaultRevision) {
      return c.json({
        error: 'workspace_model_default_revision_conflict',
        expectedRevision: parsed.output.expectedDefaultRevision,
        actualRevision: cutover.defaultRevision,
      }, 409);
    }
    try {
      return c.json({
        activation: await configStore.activateChickpeaCutover({
          workspaceId: installation.workspaceId,
          expectedInstallationRevision: parsed.output.expectedInstallationRevision,
          expectedDefaultRevision: parsed.output.expectedDefaultRevision,
          defaultReady: true,
        }),
      });
    } catch (error) {
      if (error instanceof WorkspaceModelDefaultRevisionConflictError) {
        return c.json({
          error: 'workspace_model_default_revision_conflict',
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        }, 409);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/chickpea-cutover/rollback', async (c) => {
    const parsed = v.safeParse(chickpeaCutoverRollbackSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const principal = principalByContext.get(c);
    if (!principal || (principal.role !== 'owner' && principal.role !== 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const configStore = store(c);
    const installation = await modelDefaultInstallation(configStore);
    if (!installation) return c.json({ error: 'workspace_installation_required' }, 409);
    if (installation.revision !== parsed.output.expectedInstallationRevision) {
      return c.json({
        error: 'chickpea_cutover_revision_conflict',
        expectedRevision: parsed.output.expectedInstallationRevision,
        actualRevision: installation.revision,
      }, 409);
    }
    try {
      return c.json({
        cutover: await configStore.rollbackChickpeaCutover({
          workspaceId: installation.workspaceId,
          expectedInstallationRevision: parsed.output.expectedInstallationRevision,
        }),
      });
    } catch (error) {
      return internalError(c, error);
    }
  });

  app.get('/admin/api/providers', async (c) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const [sources, subscription, activeAuthMethod, workersAiEnabled] = await Promise.all([
      describeProviderKeySources(platformEnv, settingsStore),
      getOpenAiSubscriptionAuthorizationStatus(settingsStore),
      resolveOpenAiAuthMethod(settingsStore),
      getWorkersAiEnabled(settingsStore),
    ]);
    return c.json({
      providers: [
        ...PROVIDER_KEY_IDS.map((id) => ({
          ...providerSummary(id, sources[id]),
          ...(id === 'openai'
            ? { activeAuthMethod, subscription }
            : {}),
        })),
        {
          ...providerSummary('workers-ai', workersAiStatus(platformEnv)),
          enabled: workersAiEnabled,
        },
      ],
    });
  });

  app.put('/admin/api/providers/workers-ai/enabled', async (c) => {
    const parsed = v.safeParse(workersAiEnabledSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    return c.json({
      provider: 'workers-ai',
      enabled: await putWorkersAiEnabled(parsed.output.enabled, settings(c)),
    });
  });

  app.get('/admin/api/providers/openai/subscription', async (c) =>
    c.json({
      status: await getOpenAiSubscriptionAuthorizationStatus(settings(c)),
    }));

  app.put('/admin/api/providers/openai/auth-method', async (c) => {
    const parsed = v.safeParse(openAiAuthMethodSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const method = parsed.output.method;
    const settingsStore = settings(c);
    if (method !== 'api_key') {
      return c.json({
        error: 'openai_auth_method_unsupported',
        message: 'OpenAI now uses Platform API keys only.',
      }, 410);
    }
    const key = await resolveProviderApiKey(
      'openai',
      c.env as PlatformEnv | undefined,
      settingsStore,
    );
    if (key.source === 'missing') {
      return c.json({
        error: 'openai_api_key_missing',
        message: 'Add an OpenAI API key before selecting it.',
      }, 409);
    }
    return c.json({
      activeAuthMethod: await saveOpenAiAuthMethod(settingsStore, method),
    });
  });

  app.post('/admin/api/providers/openai/subscription/start', async (c) => {
    const parsed = v.safeParse(openAiSubscriptionStartSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      return c.json(await startOpenAiSubscriptionAuthorization(openAiSubscriptionDependencies(c)));
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.post('/admin/api/providers/openai/subscription/poll', async (c) => {
    const parsed = v.safeParse(openAiSubscriptionAttemptSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const result = await pollOpenAiSubscriptionAuthorization(
        parsed.output,
        openAiSubscriptionDependencies(c),
      );
      return c.json(result);
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.post('/admin/api/providers/openai/subscription/confirm-account', async (c) => {
    const parsed = v.safeParse(openAiSubscriptionAttemptSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const status = await confirmOpenAiSubscriptionAccountChange(
        parsed.output,
        openAiSubscriptionDependencies(c),
      );
      return c.json(status);
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.post('/admin/api/providers/openai/subscription/cancel', async (c) => {
    const parsed = v.safeParse(openAiSubscriptionAttemptSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      return c.json(await cancelOpenAiSubscriptionAuthorization(
        parsed.output,
        openAiSubscriptionDependencies(c),
      ));
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.delete('/admin/api/providers/openai/subscription', async (c) => {
    try {
      const settingsStore = settings(c);
      const status = await disconnectOpenAiSubscription(settingsStore, {
        ...(options.openAiSubscriptionNow ? { now: options.openAiSubscriptionNow } : {}),
      });
      const apiKey = await resolveProviderApiKey(
        'openai',
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
      if (apiKey.source !== 'missing') {
        await saveOpenAiAuthMethod(settingsStore, 'api_key');
      }
      return c.json({ status });
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.post('/admin/api/providers/:id/key', async (c) => {
    const id = c.req.param('id');
    if (!isProviderKeyId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    const apiKey = providerApiKeyFromBody(await readJson(c.req));
    if (!apiKey) {
      return invalidRequest(c);
    }

    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const current = await resolveProviderApiKey(id, platformEnv, settingsStore);
    if (current.source === 'env') {
      return c.json({ error: 'provider_key_read_only', provider: id }, 409);
    }

    try {
      const models = await validateProviderApiKey(id, apiKey);
      await saveProviderApiKey(id, apiKey, platformEnv, settingsStore, usage(c));
      if (id === 'openai' && current.source === 'missing') {
        await saveOpenAiAuthMethod(settingsStore, 'api_key');
      }
      primeProviderModelCache(id, models);
      return c.json({
        ok: true,
        provider: providerSummary(id, 'stored'),
        models,
      });
    } catch (err) {
      if (err instanceof ProviderKeyRejectedError) {
        return c.json(
          {
            error: 'provider_key_rejected',
            provider: err.provider,
            status: err.status,
            detail: err.detail,
          },
          422,
        );
      }
      if (err instanceof ProviderUnreachableError) {
        return c.json({ error: 'provider_unreachable', provider: err.provider }, 502);
      }
      if (err instanceof ProviderModelsUnavailableError) {
        return c.json({ error: err.code, provider: err.provider }, 502);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/providers/:id/key', async (c) => {
    const id = c.req.param('id');
    if (!isProviderKeyId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    if (sharedManagementEnabled) {
      const principal = principalByContext.get(c);
      if (!principal) return c.json({ error: 'forbidden' }, 403);
      const context = {
        userId: principal.userId,
        membershipId: principal.membershipId,
        organizationId: principal.organizationId,
        origin: { kind: 'admin' as const, sessionId: principal.correlationId },
      };
      const service = managementService(c);
      const proposed = await service.applyWorkspaceChanges({
        context,
        idempotencyKey: `admin:provider:remove:${principal.correlationId}:${id}`,
        operations: [{
          itemId: 'remove_provider',
          kind: 'remove_provider_credential',
          providerId: id,
        }],
      });
      if (proposed.status === 'clarification_required') {
        return c.json({ error: 'provider_key_unavailable' }, 409);
      }
      const proposalId = proposed.outcomes[0]?.proposalId;
      if (!proposalId) {
        return c.json({ error: proposed.outcomes[0]?.code ?? 'provider_key_unavailable' }, 409);
      }
      await service.confirmWorkspaceChange({ context, proposalId });
      const source = (await describeProviderKeySources(platformEnv, settingsStore))[id];
      const impact = await providerRemovalImpact(store(c), id);
      return c.json({
        ok: true,
        provider: providerSummary(id, source),
        ...impact,
      });
    }
    const resolved = await deleteProviderApiKey(
      id,
      platformEnv,
      settingsStore,
      usage(c),
    );
    const impact = await providerRemovalImpact(store(c), id);
    return c.json({
      ok: true,
      provider: providerSummary(id, resolved.source),
      ...impact,
    });
  });

  app.get('/admin/api/providers/:id/models', async (c) => {
    const id = c.req.param('id');
    if (!isAdminProviderId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    try {
      const platformEnv = c.env as PlatformEnv | undefined;
      const settingsStore = settings(c);
      if (id === 'openai' || id === 'anthropic') {
        await refreshCatalog(c, c.req.query('refresh') === '1');
      }
      const result = await listProviderModels(id, {
        store: settingsStore,
        refresh: c.req.query('refresh') === '1',
        ...(platformEnv !== undefined ? { env: platformEnv } : {}),
      });
      const models = id === 'openai' || id === 'anthropic'
        ? result.models.filter((model) => resolveActiveCatalogRoute(
            `${id}/${model.id}`,
            id === 'openai' ? 'openai_api_key' : 'anthropic_api_key',
          ) !== undefined)
        : result.models;
      return c.json({ provider: id, models, cached: result.cached });
    } catch (err) {
      if (err instanceof ProviderModelsUnavailableError) {
        return c.json({ error: err.code, provider: err.provider }, err.status as 409 | 502);
      }
      if (err instanceof ProviderUnreachableError) {
        return c.json({ error: 'provider_unreachable', provider: err.provider }, 502);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/providers/:id/favorites', async (c) => {
    const id = c.req.param('id');
    if (!isFavoriteProviderId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    return c.json({ provider: id, favorites: await getProviderFavorites(id, settings(c)) });
  });

  app.put('/admin/api/providers/:id/favorites', async (c) => {
    const id = c.req.param('id');
    if (!isFavoriteProviderId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    const favorites = providerFavoritesFromBody(await readJson(c.req));
    if (!favorites) {
      return invalidRequest(c);
    }
    return c.json({
      provider: id,
      favorites: await putProviderFavorites(id, favorites, settings(c)),
    });
  });

  app.get('/admin/api/egress', async (c) => {
    const raw = await settings(c).getSetting(EGRESS_SETTING_KEY);
    return c.json({ policy: parseEgressPolicy(raw) });
  });

  app.put('/admin/api/egress', async (c) => {
    const parsed = v.safeParse(egressPolicySchema, await readJson(c.req));
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const policy: EgressPolicy = {
      mode: parsed.output.mode,
      domains: [...new Set(parsed.output.domains.map(normalizeEgressDomain))],
    };
    await settings(c).setSetting(EGRESS_SETTING_KEY, JSON.stringify(policy));
    return c.json({ policy });
  });

  app.get('/admin/api/sandbox/status', async (c) => {
    return c.json(await sandboxStatus(
      settings(c),
      store(c),
      c.env as PlatformEnv | undefined,
    ));
  });

  app.post('/admin/api/sandbox/install', async (c) => {
    if (!isCloudflareTarget()) {
      await recordSandboxAudit(c, 'sandbox.install.request', 'denied', 'target_unsupported');
      return c.json({ error: 'sandbox_unsupported' }, 409);
    }
    await settings(c).setSetting(SANDBOX_SETTING_KEYS.installRequested, 'true');
    await recordSandboxAudit(c, 'sandbox.install.request', 'success');
    return c.json(await sandboxStatus(
      settings(c),
      store(c),
      c.env as PlatformEnv | undefined,
    ));
  });

  app.delete('/admin/api/sandbox/install', async (c) => {
    await settings(c).applySettingsPatch({
      delete: [SANDBOX_SETTING_KEYS.installRequested, SANDBOX_SETTING_KEYS.enabled],
    });
    await recordSandboxAudit(c, 'sandbox.install.cancel', 'success');
    return c.json(await sandboxStatus(
      settings(c),
      store(c),
      c.env as PlatformEnv | undefined,
    ));
  });

  app.put('/admin/api/sandbox/status', async (c) => {
    const parsed = v.safeParse(sandboxSettingsSchema, await readJson(c.req));
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const sandbox = parsed.output;
    if (sandbox.enabled && !isCloudflareTarget()) {
      await recordSandboxAudit(c, 'sandbox.runtime.enable', 'denied', 'target_unsupported');
      return c.json({ error: 'sandbox_unsupported' }, 409);
    }
    if (sandbox.enabled && !sandboxBindingInstalled(c.env as PlatformEnv | undefined)) {
      await recordSandboxAudit(c, 'sandbox.runtime.enable', 'denied', 'binding_missing');
      return c.json({ error: 'sandbox_not_installed' }, 409);
    }
    if (sandbox.enabled && sandbox.readinessConfirmed !== true) {
      await recordSandboxAudit(c, 'sandbox.runtime.enable', 'denied', 'readiness_unconfirmed');
      return c.json({ error: 'sandbox_readiness_confirmation_required' }, 409);
    }
    await settings(c).applySettingsPatch({
      set: [
        { key: SANDBOX_SETTING_KEYS.enabled, value: String(sandbox.enabled) },
        {
          key: SANDBOX_SETTING_KEYS.allowedHosts,
          value: JSON.stringify([...new Set(sandbox.allowedHosts)]),
        },
        {
          key: SANDBOX_SETTING_KEYS.monthlySessionCap,
          value: String(sandbox.monthlySessionCap),
        },
      ],
    });
    await recordSandboxAudit(
      c,
      sandbox.enabled ? 'sandbox.runtime.enable' : 'sandbox.runtime.disable',
      'success',
    );
    return c.json(await sandboxStatus(
      settings(c),
      store(c),
      c.env as PlatformEnv | undefined,
    ));
  });

  app.patch('/admin/api/sandbox/status', async (c) => {
    const parsed = v.safeParse(sandboxAdvancedSettingsSchema, await readJson(c.req));
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const sandbox = parsed.output;
    await settings(c).applySettingsPatch({
      set: [
        {
          key: SANDBOX_SETTING_KEYS.allowedHosts,
          value: JSON.stringify([...new Set(sandbox.allowedHosts)]),
        },
        {
          key: SANDBOX_SETTING_KEYS.monthlySessionCap,
          value: String(sandbox.monthlySessionCap),
        },
      ],
    });
    await recordSandboxAudit(c, 'sandbox.advanced.update', 'success');
    return c.json(await sandboxStatus(
      settings(c),
      store(c),
      c.env as PlatformEnv | undefined,
    ));
  });

  app.get('/admin/api/github/status', async (c) => {
    try {
      const connection = await getGithubConnection(settings(c));
      // Agents holding grants are reported up front so the UI can warn
      // before a disconnect, not after (DELETE also reports, but too late).
      const referencingAgents = (await store(c).listUserAgents())
        .filter((agent) => agent.repositories.length > 0)
        .map(({ id, name }) => ({ id, name }));
      if (connection.mode !== 'app') {
        return c.json({
          mode: connection.mode,
          referencingAgents,
        });
      }
      // A revoked/rejected App key must still yield a recoverable status: the
      // operator needs the Disconnect and re-setup controls, not a 500+Retry.
      let installations: Awaited<ReturnType<typeof listInstallations>>;
      try {
        installations = await listInstallations(connection);
      } catch {
        return c.json({
          mode: 'app' as const,
          ...(connection.appSlug ? { appSlug: connection.appSlug } : {}),
          installations: [],
          installationsUnavailable: true,
          referencingAgents,
        });
      }
      const withCounts = await Promise.all(
        installations.map(async (installation) => {
          // One suspended or stalling installation must not take down status
          // for the healthy ones; the UI renders a null count as unavailable.
          try {
            const repositories = await listInstallationRepos(
              connection,
              installation.id,
              { page: 1 },
            );
            return { ...installation, repoCount: repositories.totalCount };
          } catch {
            return { ...installation, repoCount: null };
          }
        }),
      );
      return c.json({
        mode: 'app' as const,
        ...(connection.appSlug ? { appSlug: connection.appSlug } : {}),
        installations: withCounts,
        referencingAgents,
      });
    } catch (err) {
      return internalError(c, err);
    }
  });

  app.post('/admin/api/github/manifest', async (c) => {
    const parsed = v.safeParse(githubManifestSchema, await readJson(c.req));
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const origin = requestOrigin(c);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 6).toLowerCase();
    const org = parsed.output.org;
    // Single-use CSRF state: GitHub echoes ?state= back to the callback, and
    // the callback refuses any code that does not carry the state minted by
    // this admin-authenticated request. Without it, an attacker could hand a
    // logged-in admin a callback URL carrying a code for an attacker-owned
    // App and silently overwrite this deployment's GitHub credentials.
    const setupState = randomUUID().replaceAll('-', '');
    await saveGithubSetupState(settings(c), {
      state: setupState,
      mintedAt: Date.now(),
      membershipId: principalByContext.get(c)?.membershipId ?? null,
    });
    const base = org
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : 'https://github.com/settings/apps/new';
    // GitHub validates the hook URL even when the hook is inactive and
    // rejects anything not publicly reachable (localhost dev, tunnels aside).
    // Webhooks are deferred anyway — only advertise one when the origin could
    // actually receive it.
    const originHost = new URL(origin).hostname;
    const publicOrigin =
      origin.startsWith('https://') &&
      originHost !== 'localhost' &&
      originHost !== '127.0.0.1' &&
      originHost !== '::1' &&
      !originHost.endsWith('.local');
    return c.json({
      target: `${base}?state=${setupState}`,
      manifest: {
        name: `chickpea-${suffix}`,
        url: origin,
        redirect_url: `${origin}/oauth/github/setup/callback`,
        // After the user finishes installing the app (picking repos), GitHub
        // returns them here — closing the create→install→back loop without a
        // manual "now go refresh Settings" step.
        setup_url: `${origin}/admin/settings`,
        ...(publicOrigin
          ? { hook_attributes: { active: false, url: `${origin}/github/webhook` } }
          : {}),
        public: false,
        default_permissions: {
          contents: 'write',
          pull_requests: 'write',
          issues: 'write',
          metadata: 'read',
          actions: 'write',
        },
      },
    });
  });

  app.delete('/admin/api/github', async (c) => {
    try {
      const referencingAgents = (await store(c).listUserAgents())
        .filter((agent) => agent.repositories.length > 0)
        .map(({ id, name }) => ({ id, name }));
      await settings(c).applySettingsPatch({
        delete: [
          ...Object.values(GITHUB_SETTING_KEYS),
          // Cleanup only: older installs may still have this now-ignored key.
          LEGACY_GITHUB_PAT_SETTING_KEY,
        ],
      });
      return c.json({ ok: true, referencingAgents });
    } catch (err) {
      return internalError(c, err);
    }
  });

  app.get('/admin/api/github/installations/:id/repos', async (c) => {
    const parsedId = v.safeParse(githubInstallationIdSchema, c.req.param('id'));
    const parsedQuery = v.safeParse(githubReposQuerySchema, {
      q: c.req.query('q'),
      page: c.req.query('page'),
    });
    if (!parsedId.success || !parsedQuery.success) {
      return invalidRequest(c);
    }
    try {
      const connection = await getGithubConnection(settings(c));
      if (connection.mode !== 'app') {
        return c.json({ error: 'github_not_configured' }, 409);
      }
      const page = await listInstallationRepos(
        connection,
        parsedId.output,
        {
          q: parsedQuery.output.q ?? '',
          page: parsedQuery.output.page ?? 1,
        },
      );
      return c.json({
        repos: page.repositories,
        totalCount: page.totalCount,
        truncated: page.truncated,
      });
    } catch (err) {
      return internalError(c, err);
    }
  });

  app.post('/admin/api/agents', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c, githubApiConnectionValidationMessage(parsed.issues));
    }
    const requestedHandle = parsed.output.handle ?? parsed.output.name;
    if (reservedAgentIdentityField({
      id: parsed.output.id,
      name: parsed.output.name,
      handle: requestedHandle,
    })) {
      return invalidRequest(c);
    }
    const principal = principalByContext.get(c);
    let agent: AgentCreateInput = {
      ...toAgentConfig(parsed.output),
      lifecycle: 'draft',
      ...(principal ? { creatorMembershipId: principal.membershipId } : {}),
      editPolicy: parsed.output.editPolicy ?? 'creator_and_admins',
      configurationGeneration: 1,
      slackPresence: {
        requestedHandle,
        normalizedHandle: normalizeAgentHandle(requestedHandle),
        desiredState: 'unpublished',
        health: 'unpublished',
        avatar: {
          kind: 'generated',
          revision: 1,
          seed: randomUUID(),
          url: agentAvatarUrl(requestOrigin(c), parsed.output.id, 1),
        },
      },
    };
    await loadModelCatalog(settings(c));
    const modelCompatibilityError = activeCatalogCompatibilityError(
      agent.model,
      await resolveOpenAiAuthMethod(settings(c)),
    );
    if (modelCompatibilityError) return invalidRequest(c, modelCompatibilityError);
    const modelError = await configuredModelResolutionError(store(c), {
      ...agent,
      kind: 'user',
    });
    if (modelError) {
      return modelNotResolvable(c, modelError);
    }
    try {
      const configStore = store(c);
      const existingGeneratedSeeds = (await configStore.listUserAgents()).flatMap((existing) => {
        const avatar = existing.slackPresence?.avatar;
        return avatar?.kind === 'generated' ? [avatar.seed ?? existing.id] : [];
      });
      const currentPresence = agent.slackPresence!;
      agent = {
        ...agent,
        slackPresence: {
          ...currentPresence,
          avatar: {
            ...currentPresence.avatar,
            seed: nextDefaultAgentAvatarSeed(
              existingGeneratedSeeds,
              currentPresence.avatar.seed ?? randomUUID(),
            ),
          },
        },
        apiConnections: await normalizeApiOAuthPatch(
          agent.id,
          [],
          agent.apiConnections,
          settings(c),
        ),
      };
      const created = await configStore.createAgent(agent);
      return c.json({
        agent: await agentAdminProjection(created, configStore, snapshots(c)),
        ...providerWarnings(agent.model, providerIds()),
      }, 201);
    } catch (err) {
      if (err instanceof AgentExistsError) {
        return c.json({ error: 'agent_exists' }, 409);
      }
      return internalError(c, err);
    }
  });

  // Resolve a pasted GitHub repo / skills.sh link into importable skill
  // candidates (Phase 3). Read-only: the operator picks in the UI and the
  // selected skills persist via the normal agent PATCH (the skills column).
  app.post('/admin/api/skills/resolve', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(v.object({ source: nonEmptyString }), body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const source = parseSkillSource(parsed.output.source);
    if (!source) {
      return c.json({ error: 'unrecognized_source' }, 400);
    }
    const fullName = `${source.owner}/${source.repo}`;
    if (!isValidRepositoryFullName(fullName)) {
      return c.json({ error: 'unrecognized_source' }, 400);
    }
    const repositoryUnavailable = () => c.json({
      error: 'repository_not_found_or_inaccessible',
      message: 'Repository not found or not accessible. Check the source and GitHub App access.',
    }, 404);
    const githubRateLimited = (message = 'GitHub rate limit reached. Try again after it resets.') =>
      c.json({ error: 'github_rate_limited', message }, 429);
    const githubAccessUnavailable = () => c.json({
      error: 'github_access_unavailable',
      message: 'GitHub App access could not be verified. Check GitHub settings and retry.',
    }, 502);
    const skillImportFailure = (error: SkillImportError) => {
      if (error.code === 'rate_limited') {
        return githubRateLimited(error.message);
      }
      if (error.code === 'access_candidate' || error.code === 'repository_inaccessible') {
        return repositoryUnavailable();
      }
      return c.json({
        error: 'github_unavailable',
        message: 'GitHub could not resolve that skill source. Try again.',
      }, 502);
    };
    try {
      try {
        const resolution = await resolveSkillSource(source, fetch);
        return c.json({ resolution });
      } catch (error) {
        if (!(error instanceof SkillImportError)) throw error;
        if (error.code !== 'access_candidate') return skillImportFailure(error);
      }

      const connection = await getGithubConnection(settings(c));
      if (connection.mode !== 'app') {
        return repositoryUnavailable();
      }

      let installation;
      try {
        installation = await getRepositoryInstallation(connection, fullName);
      } catch (error) {
        if (githubErrorIsRateLimited(error)) {
          return githubRateLimited();
        }
        return githubAccessUnavailable();
      }
      if (!installation) {
        return repositoryUnavailable();
      }

      let token: string;
      try {
        ({ token } = await createInstallationToken(
          connection,
          installation.id,
          {
            repositories: [source.repo],
            permissions: { contents: 'read' },
          },
        ));
      } catch (error) {
        const status = githubErrorStatus(error);
        if (githubErrorIsRateLimited(error)) {
          return githubRateLimited();
        }
        if (status === 403 || status === 404 || status === 422) {
          return repositoryUnavailable();
        }
        return githubAccessUnavailable();
      }

      try {
        const resolution = await resolveSkillSource(source, fetch, { token });
        return c.json({ resolution });
      } catch (error) {
        if (error instanceof SkillImportError) return skillImportFailure(error);
        throw error;
      }
    } catch (err) {
      return internalError(c, err);
    }
  });

  // Test an unsaved Connection form: connect + list tools without persisting
  // anything. A schema-invalid body is a 400; every OTHER outcome (blocked URL,
  // unauthorized, timeout, ...) is HTTP 200 with a classified `{ ok: false }`
  // envelope — the client renders the safe message inline, and a raw error
  // string (which could leak internals) never crosses this boundary.
  app.post('/admin/api/agents/:agentId/mcp/test', async (c) => {
    const agentId = c.req.param('agentId');
    if (!AGENT_ID_PATTERN.test(agentId)) {
      return invalidRequest(c);
    }
    const body = await readJson(c.req);
    const parsed = v.safeParse(mcpTestSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const input = parsed.output;
    const validated = validateMcpUrl(input.url);
    if (!validated.ok) {
      // Never even attempt a connect to a blocked target: classify the SSRF
      // rejection into the same envelope shape as a runtime failure.
      const err = new McpBlockedUrlError(validated.reason);
      return c.json({ ok: false, code: classifyMcpError(err), message: safeMcpFailureText(err) });
    }

    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    // Stored and env-supplied secrets belong to the connection's SAVED origin.
    // Backfilling them for an arbitrary tested URL turns this route into a
    // credential read-back: the values are write-only everywhere else, and
    // MCP_AGENT_*_BEARER cannot be written through the API at all, so an
    // operator could otherwise post their own host here and read them off the
    // wire. Resolve stored secrets only when the tested origin is the one they
    // were saved against; a new or redirected target must be typed in full.
    const storedOrigin = await savedMcpConnectionOrigin(store(c), agentId, input.id);
    const testsSavedOrigin =
      storedOrigin !== undefined && storedOrigin === safeUrlOrigin(validated.url);
    const resolved = testsSavedOrigin
      ? await resolveMcpSecrets(
          { agentId, connectionId: input.id },
          // Union of the connection's known header names and any typed this
          // session, so a stored value backs a header the operator didn't
          // re-enter.
          [...new Set([...(input.headerNames ?? []), ...Object.keys(input.headers ?? {})])],
          platformEnv,
          settingsStore,
        )
      : { headers: {} };
    const merged: ResolvedMcpSecrets = {
      ...(input.bearerToken !== undefined ? { bearer: input.bearerToken } : {}),
      headers: { ...resolved.headers, ...(input.headers ?? {}) },
    };
    if (input.bearerToken === undefined && resolved.bearer !== undefined) {
      merged.bearer = resolved.bearer;
    }
    if (input.authMode === 'oauth') {
      try {
        merged.bearer = await resolveMcpOAuthToken(
          {
            ref: { agentId, connectionId: input.id },
            serverUrl: validated.url,
          },
          oauthDependencies(c),
        );
      } catch (error) {
        const needsAuthorization =
          error instanceof McpOAuthError &&
          error.code === 'reauthorization_required';
        return c.json({
          ok: false,
          code: needsAuthorization ? 'unauthorized' : 'mcp_connection_failed',
          message: needsAuthorization
            ? 'This connection needs OAuth authorization.'
            : 'The OAuth connection could not be prepared.',
        });
      }
    }
    const headers = buildMcpRequestHeaders(input.authMode, merged);

    try {
      const result = await discoverMcp({
        id: input.id,
        url: validated.url,
        transport: input.transport,
        headers,
      });
      return c.json({ ok: true, tools: result.tools });
    } catch (err) {
      // Classify first — err.message may carry raw internals and must never be
      // returned to the client. The log line keeps the bounded debug text so a
      // failing Test connection is diagnosable from observability.
      console.warn(
        '[chickpea] MCP test failed (' +
          input.id +
          '): ' +
          mcpDebugText(err, { url: validated.url, headers }),
      );
      return c.json({ ok: false, code: classifyMcpError(err), message: safeMcpFailureText(err) });
    }
  });

  // Store a Connection's secrets by reference (never in the profile row). The
  // response reports source only (`env`/`stored`/`missing`) — values are never
  // echoed back. The profile PATCH path never touches settings; this is the one
  // secret-write choke point alongside DELETE below.
  app.put('/admin/api/agents/:agentId/mcp/secrets/:connectionId', async (c) => {
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const body = await readJson(c.req);
    const parsed = v.safeParse(mcpSecretsPutSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const input = parsed.output;
    const platformEnv = c.env as PlatformEnv | undefined;
    const configStore = store(c);
    const settingsStore = settings(c);
    const ref = { agentId, connectionId };
    let connection: CustomAgentConfig['mcpServers'][number] | undefined;
    try {
      connection = (await configStore.getAgent(agentId)).mcpServers.find(
        (server) => server.id === connectionId,
      );
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
    if (!connection) {
      return c.json({ error: 'not_found' }, 404);
    }

    const writtenHeaderNames = Object.keys(input.headers ?? {});
    const allowedHeaderNames = new Set(connection.headerNames);
    if (writtenHeaderNames.some((name) => !allowedHeaderNames.has(name))) {
      return invalidRequest(c);
    }
    const cleanupHeaderNames = [
      ...new Set([...connection.headerNames, ...(input.removeHeaderNames ?? [])]),
    ];
    await stageMcpSecretCleanup(
      agentId,
      [
        mcpBearerSettingKey(ref),
        ...cleanupHeaderNames.map((name) => mcpHeaderSettingKey(ref, name)),
      ],
      settingsStore,
    );
    await saveMcpSecrets(
      ref,
      {
        ...(input.bearerToken !== undefined ? { bearerToken: input.bearerToken } : {}),
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
      },
      platformEnv,
      settingsStore,
    );
    if (input.clearBearer) {
      await settingsStore.deleteSetting(mcpBearerSettingKey(ref));
    }
    if (input.clearOAuth) {
      await deleteMcpOAuthSettings(ref, settingsStore);
    }
    for (const name of input.removeHeaderNames ?? []) {
      await settingsStore.deleteSetting(mcpHeaderSettingKey(ref, name));
    }

    let currentConnection: CustomAgentConfig['mcpServers'][number] | undefined;
    try {
      currentConnection = (await configStore.getAgent(agentId)).mcpServers.find(
        (server) => server.id === connectionId,
      );
    } catch (err) {
      if (!(err instanceof UnknownAgentError)) {
        return internalError(c, err);
      }
      try {
        // The profile disappeared after the pre-write check. Remove this
        // connection explicitly in case a concurrent profile cleanup consumed
        // the marker just before these writes landed, then finish any marker
        // that remains for the rest of the deleted profile.
        await deleteMcpSecrets(ref, cleanupHeaderNames, platformEnv, settingsStore);
        await finishMcpSecretCleanup(agentId, settingsStore);
        return c.json({ error: 'not_found' }, 404);
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
    }
    if (!currentConnection) {
      try {
        await deleteMcpSecrets(ref, cleanupHeaderNames, platformEnv, settingsStore);
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
      return c.json({ error: 'not_found' }, 404);
    }
    const currentHeaderNames = new Set(currentConnection.headerNames);
    const headersRemovedDuringWrite = writtenHeaderNames.filter(
      (name) => !currentHeaderNames.has(name),
    );
    if (headersRemovedDuringWrite.length > 0) {
      for (const name of headersRemovedDuringWrite) {
        await settingsStore.deleteSetting(mcpHeaderSettingKey(ref, name));
      }
      return c.json({ error: 'connection_changed' }, 409);
    }

    const sources = await describeMcpSecretSources(ref, input.headerNames, platformEnv, settingsStore);
    return c.json(sources);
  });

  app.put('/admin/api/agents/:agentId/api-connections/secrets/:connectionId', async (c) => {
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const parsed = v.safeParse(connectorSecretsPutSchema, await readJson(c.req));
    if (!parsed.success) {
      return invalidRequest(c);
    }

    const input = parsed.output;
    const platformEnv = c.env as PlatformEnv | undefined;
    const configStore = store(c);
    const settingsStore = settings(c);
    let connection: CustomAgentConfig['apiConnections'][number] | undefined;
    try {
      connection = (await configStore.getAgent(agentId)).apiConnections.find(
        (candidate) => candidate.id === connectionId,
      );
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
    if (!connection || connection.authMode === 'oauth') {
      return c.json({ error: 'not_found' }, 404);
    }

    await stageConnectorSecretCleanup(
      agentId,
      [connectionId],
      platformEnv,
      settingsStore,
    );
    const oauthSources = await describeApiOAuthSources(
      { agentId, connectionId },
      settingsStore,
    );
    if (oauthSources.client === 'stored' || oauthSources.tokens === 'stored') {
      await stageConnectorSettingCleanup(
        agentId,
        apiOAuthSettingKeys({ agentId, connectionId }),
        platformEnv,
        settingsStore,
      );
      await deleteApiOAuthSettings({ agentId, connectionId }, settingsStore);
    }
    if (input.credential !== undefined && input.credential !== '') {
      await saveConnectorCredential(
        agentId,
        connectionId,
        input.credential,
        platformEnv,
        settingsStore,
      );
    }
    if (input.clearCredential) {
      await clearConnectorCredential(agentId, connectionId, platformEnv, settingsStore);
    }

    let currentConnection: CustomAgentConfig['apiConnections'][number] | undefined;
    try {
      currentConnection = (await configStore.getAgent(agentId)).apiConnections.find(
        (candidate) => candidate.id === connectionId,
      );
    } catch (err) {
      if (!(err instanceof UnknownAgentError)) {
        return internalError(c, err);
      }
      try {
        // The profile disappeared after the pre-write check. Remove this
        // credential explicitly in case profile cleanup consumed its marker
        // just before the write landed, then finish any marker still present.
        await deleteConnectorSecrets(
          agentId,
          [connectionId],
          platformEnv,
          settingsStore,
        );
        await finishConnectorSecretCleanup(agentId, platformEnv, settingsStore);
        return c.json({ error: 'not_found' }, 404);
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
    }
    if (!currentConnection) {
      try {
        await deleteConnectorSecrets(
          agentId,
          [connectionId],
          platformEnv,
          settingsStore,
        );
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
      return c.json({ error: 'not_found' }, 404);
    }

    return c.json({
      source: await describeConnectorCredentialSource(
        agentId,
        connectionId,
        platformEnv,
        settingsStore,
      ),
    });
  });

  app.delete('/admin/api/agents/:agentId/api-connections/secrets/:connectionId', async (c) => {
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    await clearConnectorCredential(agentId, connectionId, platformEnv, settingsStore);
    await deleteApiOAuthSettings({ agentId, connectionId }, settingsStore);
    return c.json({
      source: await describeConnectorCredentialSource(
        agentId,
        connectionId,
        platformEnv,
        settingsStore,
      ),
    });
  });

  app.delete('/admin/api/agents/:agentId/mcp/secrets/:connectionId', async (c) => {
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const body = await readJson(c.req);
    const parsed = v.safeParse(mcpSecretsDeleteSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const ref = { agentId, connectionId };
    await deleteMcpSecrets(
      ref,
      parsed.output.headerNames,
      platformEnv,
      settingsStore,
    );
    await deleteMcpOAuthSettings(ref, settingsStore);
    return c.json({ ok: true });
  });

  app.get('/admin/api/connections', async (c) => {
    const workspaceId = c.req.query('workspaceId')?.trim();
    if (!workspaceId || !/^[A-Z0-9_]{2,32}$/.test(workspaceId)) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const organization = await identity(c).getOrganization();
      if (organization?.slackTeamId !== workspaceId) throw new AuthorizationError();
      const [views, agents] = await Promise.all([
        connectionAccounts(c).listViews(workspaceId),
        store(c).listUserAgents(),
      ]);
      const visibleAccounts = views.filter(
        (account) => account.lifecycle !== 'revoked' && (
          account.ownerKind === 'team' ||
          account.ownerMembershipId === principal.membershipId
        ),
      );
      const visibleAgents = new Map(
        agents.filter((agent) => canEditAgent(principal, agent)).map((agent) => [agent.id, agent]),
      );
      const ownership = await Promise.all(visibleAccounts.map(async (account) => ({
        account,
        binding: await store(c).getAgentConnectionBindingForAccount(account.id),
      })));
      return c.json({
        accounts: ownership.map(({ account, binding }) => {
          const agent = binding ? visibleAgents.get(binding.agentId) : undefined;
          const accountAgents = agent ? [{ id: agent.id, name: agent.name }] : [];
          return {
            account,
            agents: accountAgents,
            reconnectAgentId: binding?.enabled ? accountAgents[0]?.id : undefined,
          };
        }),
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      return internalError(c, error);
    }
  });

  app.get('/admin/api/agents/:id/connections', async (c) => {
    const workspaceId = c.req.query('workspaceId')?.trim();
    if (!workspaceId || !/^[A-Z0-9_]{2,32}$/.test(workspaceId)) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const agent = await store(c).getAgent(c.req.param('id'));
      if (!canEditAgent(principal, agent)) throw new AuthorizationError();
      const organization = await identity(c).getOrganization();
      if (organization?.slackTeamId !== workspaceId) throw new AuthorizationError();
      const [views, bindings, providerContext] = await Promise.all([
        connectionAccounts(c).listViews(workspaceId),
        store(c).listAgentConnectionBindings(agent.id),
        resolvedManagedProviderContext(c),
      ]);
      const byId = new Map(views.map((account) => [account.id, account]));
      const provider = providerContext.providers.get('composio');
      const managedConnectorCatalog = managedCatalog.list().map((connector) => ({
        id: connector.id,
        toolkit: connector.toolkit,
        providerId: connector.providerId,
        label: connector.label,
        description: connector.description,
        securityDescription: connector.securityDescription,
        capabilities: connector.capabilities.map((capability) => ({
          id: capability.id,
          accessLane: capability.accessLane,
          description: capability.description,
        })),
        resources: (connector.resources ?? []).map((resource) => ({
          key: resource.key,
          label: resource.label,
          required: resource.required,
          multiple: resource.multiple,
        })),
        access: {
          read: managedProviderAvailability(provider, {
            toolkit: connector.toolkit,
            accessLane: 'read',
          }),
          write: managedProviderAvailability(provider, {
            toolkit: connector.toolkit,
            accessLane: 'write',
          }),
        },
      }));
      return c.json({
        attached: bindings.flatMap((binding) => {
          const account = byId.get(binding.connectionAccountId);
          if (!binding.enabled || !account || account.lifecycle === 'revoked') return [];
          if (account.ownerKind === 'member' &&
              account.ownerMembershipId !== principal.membershipId) return [];
          return [{ account, binding }];
        }),
        managedConnectors: {
          composio: managedConnectorCatalog.some((connector) => connector.access.read.status === 'ready'),
          canConfigure: permissionForRole(principal.role).has('admin.configure'),
          configurationReadOnly: providerContext.readOnly,
          catalog: managedConnectorCatalog,
        },
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/connections', async (c) => {
    const parsed = v.safeParse(connectionAccountCreateSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const organization = await identity(c).getOrganization();
      if (organization?.slackTeamId !== parsed.output.workspaceId) throw new AuthorizationError();
      const configStore = store(c);
      const agent = await configStore.getAgent(c.req.param('id'));
      requireAgentEdit(principal, agent);
      const source = parsed.output.api ?? parsed.output.mcp!;
      const policy = parsed.output.api
        ? {
            kind: 'api' as const,
            allowedHosts: [...parsed.output.api.allowedHosts],
            pathPrefixes: [...parsed.output.api.pathPrefixes],
            headerName: parsed.output.api.headerName,
            ...(parsed.output.api.headerValuePrefix
              ? { headerValuePrefix: parsed.output.api.headerValuePrefix }
              : {}),
            allowedMethods: [...parsed.output.api.allowedMethods],
            authMode: parsed.output.api.authMode ?? 'credential' as const,
            ...(parsed.output.api.oauthProvider
              ? { oauthProvider: parsed.output.api.oauthProvider }
              : {}),
            ...(parsed.output.api.oauthScopes
              ? { oauthScopes: [...parsed.output.api.oauthScopes] }
              : {}),
            ...(parsed.output.api.oauthAppType
              ? { oauthAppType: parsed.output.api.oauthAppType }
              : {}),
            ...(parsed.output.api.presetId ? { presetId: parsed.output.api.presetId } : {}),
          }
        : {
            kind: 'mcp' as const,
            url: parsed.output.mcp!.url,
            transport: parsed.output.mcp!.transport,
            authMode: parsed.output.mcp!.authMode,
            headerNames: [...parsed.output.mcp!.headerNames],
            ...(parsed.output.mcp!.credentialHeaderName
              ? { credentialHeaderName: parsed.output.mcp!.credentialHeaderName }
              : {}),
            ...(parsed.output.mcp!.credentialValuePrefix
              ? { credentialValuePrefix: parsed.output.mcp!.credentialValuePrefix }
              : {}),
            ...(parsed.output.mcp!.credentialOptional
              ? { credentialOptional: true }
              : {}),
            discoveredTools: parsed.output.mcp!.discoveredTools.map((tool) => ({
              name: tool.name,
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool.description ? { description: tool.description } : {}),
            })),
            allowedTools: [...parsed.output.mcp!.allowedTools],
            ...(parsed.output.mcp!.oauthScope ? { oauthScope: parsed.output.mcp!.oauthScope } : {}),
            ...(parsed.output.mcp!.presetId ? { presetId: parsed.output.mcp!.presetId } : {}),
          };
      const service = connectionAccounts(c);
      const created = await service.createForAgent({
        principal,
        agentId: agent.id,
        workspaceId: parsed.output.workspaceId,
        ownerKind: parsed.output.ownerKind,
        providerId: parsed.output.providerId,
        label: parsed.output.label,
        ...(parsed.output.purpose ? { purpose: parsed.output.purpose } : {}),
        ...(source.identity ? {
          identity: {
            ...(source.identity.workspaceName
              ? { workspaceName: source.identity.workspaceName }
              : {}),
            ...(source.identity.accountName
              ? { accountName: source.identity.accountName }
              : {}),
          },
        } : {}),
        policy,
        ...(parsed.output.credential ? { credential: parsed.output.credential } : {}),
        allowedCapabilities: parsed.output.allowedCapabilities ?? [],
      });
      const { account, binding } = created;
      const { secretRefId: _secretRefId, ...safeAccount } = account;
      return c.json({ account: safeAccount, binding }, 201);
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
  });

  app.delete('/admin/api/agents/:id/connections/:connectionAccountId', async (c) => {
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const account = await (await resolvedConnectionAccounts(c)).disconnectForAgent({
        principal,
        agentId: c.req.param('id'),
        connectionAccountId: c.req.param('connectionAccountId'),
      });
      return c.json({ account: toConnectionAccountView(account) });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof ConnectionScheduleConflictError) return c.json({
        error: 'connection_schedule_changed',
        message: error.message,
      }, 409);
      return internalError(c, error);
    }
  });

  app.post('/admin/api/connections/:connectionAccountId/revoke', async (c) => {
    const body = await readJson(c.req);
    if (!isRecord(body) || Object.keys(body).length > 0) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const account = await (await resolvedConnectionAccounts(c)).revoke({
        principal,
        connectionAccountId: c.req.param('connectionAccountId'),
      });
      const oauthRef = connectionAccountOAuthRef(account.id);
      if (account.policy.kind === 'mcp' && account.policy.authMode === 'oauth') {
        await stageMcpSecretCleanup(
          oauthRef.agentId,
          mcpOAuthSettingKeys(oauthRef),
          settings(c),
        );
        await deleteMcpOAuthSettings(oauthRef, settings(c));
        await finishMcpSecretCleanup(oauthRef.agentId, settings(c));
      } else if (account.policy.kind === 'api' && account.policy.authMode === 'oauth') {
        await stageConnectorSettingCleanup(
          oauthRef.agentId,
          apiOAuthSettingKeys(oauthRef),
          c.env as PlatformEnv | undefined,
          settings(c),
        );
        await deleteApiOAuthSettings(oauthRef, settings(c));
        await finishConnectorSecretCleanup(
          oauthRef.agentId,
          c.env as PlatformEnv | undefined,
          settings(c),
        );
      }
      return c.json({ account: toConnectionAccountView(account) });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof ManagedConnectionProviderUnavailableError) return c.json({
        error: 'managed_provider_unavailable',
        message: `Restore the ${error.adapterId} provider credentials before disconnecting this managed account so its remote account can also be removed.`,
      }, 503);
      if (error instanceof ConnectionScheduleConflictError) return c.json({
        error: 'connection_schedule_changed',
        message: error.message,
      }, 409);
      return internalError(c, error);
    }
  });

  app.get('/admin/api/agents/:id/schedules', async (c) => {
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const agent = await store(c).getAgent(c.req.param('id'));
      requireAgentEdit(principal, agent);
      const config = store(c);
      const references = (await config.listAgentScheduleReferences(agent.id))
        .filter((reference) =>
          reference.state !== 'archived' && reference.destinationKind !== 'direct_thread');
      return c.json({
        schedules: (await Promise.all(references.map(async (reference) => {
          const routine = await routines(c).getRoutine(reference.scheduleId);
          if (!routine || routine.deletedAt !== null ||
              routine.workspaceId !== reference.workspaceId ||
              routine.channelId !== reference.channelId) return null;
          const access = await routineContentAccess(c).resolve(routine);
          const readable = routineContentReadable(access);
          const channel = readable
            ? await config.getChannel(routine.workspaceId, routine.channelId)
            : undefined;
          const status = agentScheduleStatus(reference.state, routine.state);
          const actions = agentScheduleActions(readable, reference.state, routine.state);
          return {
            id: routine.id,
            name: readable ? routine.name : null,
            contentAccess: access,
            status,
            version: routine.version,
            cadence: readable
              ? {
                  triggerKind: routine.triggerKind,
                  scheduleInput: routine.scheduleInput,
                  timezone: routine.timezone,
                }
              : null,
            channelLabel: readable ? channel?.label ?? null : null,
            nextRunAt: routine.nextRunAt,
            lastFinishedAt: routine.lastFinishedAt,
            actions,
          };
        }))).filter((schedule) => schedule !== null),
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/schedules/:scheduleId/control', async (c) => {
    if (!safeAdminMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readAdminIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(agentScheduleControlSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const config = store(c);
      const agent = await config.getAgent(c.req.param('id'));
      requireAgentEdit(principal, agent);
      const reference = await config.getAgentScheduleReference(c.req.param('scheduleId'));
      if (!reference || reference.agentId !== agent.id ||
          reference.destinationKind === 'direct_thread') {
        return c.json({ error: 'not_found' }, 404);
      }
      const state = routines(c);
      const routine = await state.getRoutine(reference.scheduleId);
      if (!routine || routine.workspaceId !== reference.workspaceId ||
          routine.channelId !== reference.channelId) {
        return c.json({ error: 'not_found' }, 404);
      }
      const access = await routineContentAccess(c).resolve(routine);
      if (!routineContentReadable(access)) return c.json({ error: 'forbidden' }, 403);

      const action = parsed.output.action;
      const operationKey = `admin:agent:${agent.id}:schedule:${routine.id}:${action}:${idempotencyKey}`;
      if (action === 'delete') {
        if (parsed.output.acknowledgeIrreversible !== true) return invalidRequest(c);
        const token = createHash('sha256').update(`agent-schedule-delete\0${operationKey}`).digest('hex');
        const draft = {
          action: 'delete' as const,
          routineId: routine.id,
          expectedVersion: parsed.output.expectedVersion,
        };
        const service = new RoutineService(state, {
          confirmationId: () => `rconfirm_admin_${createHash('sha256').update(operationKey).digest('hex').slice(0, 32)}`,
          token: () => token,
        });
        const previewHash = hashRoutineValue(JSON.stringify(draft));
        if (routine.deletedAt === null) {
          const existingConfirmation = await state.getConfirmation(hashRoutineValue(token));
          if (!existingConfirmation) {
            await service.createConfirmation({
              action: 'delete',
              actorId: principal.membershipId,
              actorClass: 'operator',
              workspaceId: routine.workspaceId,
              channelId: routine.channelId,
              routineId: routine.id,
              expectedVersion: parsed.output.expectedVersion,
            });
          }
        }
        const deleted = await service.confirm({
          token,
          actorId: principal.membershipId,
          workspaceId: routine.workspaceId,
          channelId: routine.channelId,
          previewHash,
          idempotencyKey: operationKey,
        });
        return c.json({
          schedule: { id: deleted.id, status: 'deleted', version: deleted.version },
          irreversible: true,
        });
      }
      if (routine.deletedAt !== null || reference.state === 'archived') {
        return c.json({ error: 'not_found' }, 404);
      }
      const expectedVersion = parsed.output.expectedVersion;
      if (expectedVersion === routine.version) {
        const allowed = agentScheduleActions(true, reference.state, routine.state);
        if (!allowed[action]) {
          return c.json({ error: 'routine_action_unavailable' }, 409);
        }
      }
      if (action === 'resume') {
        requireRoutineScheduling(
          options.routineCapability?.(c) ??
            resolveRoutineCapability({ cloudflare: isCloudflareTarget() }),
        );
      }
      const updated = await new RoutineService(state).control({
        routineId: routine.id,
        expectedVersion,
        action,
        actorId: principal.membershipId,
        actorClass: 'operator',
        reasonCode: 'admin_control',
        idempotencyKey: operationKey,
      });
      return c.json({
        schedule: {
          id: updated.id,
          status: agentScheduleStatus(reference.state, updated.state),
          version: updated.version,
        },
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof RoutineStateError) {
        if (error.code === 'routine_not_found') return c.json({ error: 'not_found' }, 404);
        if (error.code === 'routine_version_conflict') {
          return c.json({ error: error.code, ...error.details }, 409);
        }
        return c.json({ error: error.code }, 400);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/schedules/:scheduleId/reassign', async (c) => {
    const parsed = v.safeParse(scheduleAuthorityReassignSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      const config = store(c);
      const agent = await config.getAgent(c.req.param('id'));
      requireAgentEdit(principal, agent);
      const current = await config.getAgentScheduleReference(c.req.param('scheduleId'));
      if (!current || current.agentId !== agent.id ||
          current.destinationKind === 'direct_thread') {
        return c.json({ error: 'not_found' }, 404);
      }
      if (current.revision !== parsed.output.expectedAuthorityRevision) {
        return c.json({ error: 'schedule_authority_conflict', currentRevision: current.revision }, 409);
      }
      // A Runs as grant is durable personal authority. An editor may take over
      // their own schedule, but cannot silently grant another member's identity
      // or personal connections. A future delegation flow must require that
      // target member's explicit acceptance.
      if (parsed.output.runsAsMembershipId !== principal.membershipId) {
        throw new AuthorizationError('forbidden');
      }
      const [membership, organization] = await Promise.all([
        identity(c).getMembership(parsed.output.runsAsMembershipId),
        identity(c).getOrganization(),
      ]);
      if (!membership || membership.status !== 'active' ||
          membership.organizationId !== organization?.id ||
          organization.slackTeamId !== current.workspaceId) {
        return c.json({ error: 'runs_as_unavailable' }, 409);
      }
      const reference = await reassignRoutineAgentAuthority({
        scheduleId: current.scheduleId,
        runsAsMembershipId: membership.id,
        config,
        identity: identity(c),
      });
      const routine = await routines(c).getRoutine(current.scheduleId);
      const repairedAuthorityPause = routine?.pausedReason === 'schedule_authority_missing' ||
        routine?.pausedReason === 'assignment_missing' ||
        routine?.pausedReason === 'creator_ineligible' ||
        routine?.pausedReason === 'credential_unavailable';
      const resumed = reference.state === 'active' && routine?.state === 'paused' &&
          repairedAuthorityPause
        ? await new RoutineService(routines(c)).control({
            routineId: routine.id,
            expectedVersion: routine.version,
            action: 'resume',
            actorId: principal.membershipId,
            actorClass: 'operator',
            reasonCode: 'authority_reassigned',
            idempotencyKey: `admin:schedule-reassign:${reference.authorityReceiptId}`,
          })
        : routine;
      return c.json({ reference, routine: resumed ?? null });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof RoutineAuthorityError) {
        return c.json({ error: 'runs_as_unavailable' }, 409);
      }
      return internalError(c, error);
    }
  });

  app.get('/admin/api/agents/:id', async (c) => {
    try {
      const agent = await store(c).getAgent(c.req.param('id'));
      const principal = principalByContext.get(c);
      const canEdit = principal ? canEditAgent(principal, agent) : true;
      if (!canEdit) return c.json({ error: 'not_found' }, 404);
      const enriched = await withApiConnectionSources(
        agent,
        c.env as PlatformEnv | undefined,
        settings(c),
      );
      return c.json({
        agent: await agentAdminProjection(
          enriched,
          store(c),
          snapshots(c),
          undefined,
          {
            canEdit,
            privateUseAudience: await privateAgentAudience(c, agent),
          },
        ),
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/agents/:id/memory', async (c) => {
    try {
      const agent = await store(c).getAgent(c.req.param('id'));
      const principal = principalByContext.get(c);
      if (principal) requireAgentEdit(principal, agent);
      return c.json({ memory: await memory(c).getAgentMemory(agent.id) });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
  });

  app.put('/admin/api/agents/:id/memory', async (c) => {
    const parsed = v.safeParse(agentMemorySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const agent = await store(c).getAgent(c.req.param('id'));
      const principal = principalByContext.get(c);
      if (principal) requireAgentEdit(principal, agent);
      const saved = await memory(c).putAgentMemory({
        agentId: agent.id,
        body: parsed.output.body,
        expectedRevision: parsed.output.expectedRevision,
      });
      return c.json({ memory: saved });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof MemoryStateError && error.code === 'memory_version_conflict') {
        const current = await memory(c).getAgentMemory(c.req.param('id'));
        return c.json({ error: error.code, currentVersion: current.revision }, 409);
      }
      return internalError(c, error);
    }
  });

  app.patch('/admin/api/agents/:id', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentPatchSchema, body);
    if (!parsed.success) {
      return invalidRequest(c, githubApiConnectionValidationMessage(parsed.issues));
    }
    if (reservedAgentIdentityField({
      id: c.req.param('id'),
      name: parsed.output.name ?? '',
      ...(parsed.output.handle !== undefined ? { handle: parsed.output.handle } : {}),
    })) {
      return invalidRequest(c);
    }
    try {
      const configStore = store(c);
      const agentId = c.req.param('id');
      const current = await configStore.getAgent(agentId);
      const principal = principalByContext.get(c);
      if (principal) requireAgentEdit(principal, current);
      if (current.revision !== parsed.output.expectedRevision) {
        throw new AgentRevisionConflictError(
          agentId,
          parsed.output.expectedRevision,
          current.revision,
        );
      }
      const patch = toAgentPatch(parsed.output);
      if (parsed.output.handle !== undefined) {
        const requestedHandle = parsed.output.handle;
        const presence = current.slackPresence;
        if (!presence) throw new Error(`Agent ${agentId} has no Slack presence`);
        patch.slackPresence = {
          ...presence,
          requestedHandle,
          normalizedHandle: normalizeAgentHandle(requestedHandle),
          health: presence.desiredState === 'active' ? 'pending' : presence.health,
        };
      }
      if (patch.apiConnections) {
        patch.apiConnections = await normalizeApiOAuthPatch(
          agentId,
          current.apiConnections,
          patch.apiConnections,
          settings(c),
        );
      }
      const next: ModelResolvableAgent = {
        ...current,
        ...patch,
        id: agentId,
      };
      await loadModelCatalog(settings(c));
      const modelCompatibilityError = activeCatalogCompatibilityError(
        next.model,
        await resolveOpenAiAuthMethod(settings(c)),
      );
      if (modelCompatibilityError) return invalidRequest(c, modelCompatibilityError);
      const modelError = await configuredModelResolutionError(configStore, {
        ...next,
        kind: current.kind,
      });
      if (modelError) {
        return modelNotResolvable(c, modelError);
      }
      // Repointing a connection at a new origin must not carry the previous
      // origin's credential across. Secrets are keyed by connection id and this
      // route deliberately never writes them, so drop the stale ones instead.
      //
      // Deliberately BEFORE the update: if the write then fails, the operator
      // re-enters a secret, which is recoverable and visible. Deleting after
      // the write would mean a failure there leaves the connection already
      // pointing at the new origin with the old credential still attached —
      // which is precisely the leak this closes, and no later PATCH would
      // detect it, because by then the stored URL already matches.
      await clearRepointedMcpCredentials({
        agentId,
        current: current.mcpServers,
        next: patch.mcpServers,
        ...(c.env ? { env: c.env as PlatformEnv } : {}),
        settings: settings(c),
      });
      let updated = await configStore.updateAgent(
        agentId,
        patch,
        parsed.output.expectedRevision,
      );
      let presenceRecovery = null;
      const reconcilePresence = updated.slackPresence?.desiredState === 'active' && (
        parsed.output.handle !== undefined ||
        parsed.output.name !== undefined ||
        parsed.output.description !== undefined
      );
      if (reconcilePresence) {
        try {
          const actor = await agentActor(c);
          const transport = await agentSlackTransport(c, actor.slackTeamId);
          updated = await new AgentPresenceReconciler({
            config: configStore,
            transport,
          }).retry(agentId);
        } catch (error) {
          const classified = classifyAgentPresenceError(error);
          updated = await configStore.getAgent(agentId);
          presenceRecovery = agentPresenceRecovery(
            classified,
            updated.slackPresence?.normalizedHandle ?? normalizeAgentHandle(updated.name),
          );
        }
      }
      return c.json({
        agent: await agentAdminProjection(updated, configStore, snapshots(c)),
        presenceRecovery,
        ...providerWarnings(next.model, providerIds()),
      });
    } catch (err) {
      if (err instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      if (err instanceof AgentRevisionConflictError) {
        return c.json({
          error: 'agent_revision_conflict',
          agentId: err.agentId,
          expectedRevision: err.expectedRevision,
          actualRevision: err.actualRevision,
        }, 409);
      }
      if (err instanceof AgentStillReferencedError) {
        return agentStillReferenced(c, err);
      }
      return internalError(c, err);
    }
  });

  app.put('/admin/api/agents/:id/avatar', async (c) => {
    const parsed = v.safeParse(agentAvatarUploadSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const agentId = c.req.param('id');
    try {
      const current = await store(c).getAgent(agentId);
      requireAgentEdit(principalByContext.get(c), current);
      let bytes: Uint8Array;
      try {
        const binary = atob(parsed.output.base64);
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      } catch {
        return invalidRequest(c, 'The avatar data is not valid base64.');
      }
      const gatewayInstallation = (await store(c).listWorkspaceInstallations()).find(
        (installation) => installation.transportMode === 'gateway',
      );
      const gatewayClient = gatewayInstallation
        ? createGatewayDeploymentClient(c.env as PlatformEnv | undefined)
        : undefined;
      const updated = await uploadAgentAvatar({
        config: store(c),
        settings: settings(c),
        agentId,
        bytes,
        contentType: parsed.output.contentType,
        publicOrigin: requestOrigin(c),
        ...(gatewayClient && gatewayInstallation
          ? {
              publish: (avatar) => gatewayClient.publishAvatar({
                workspaceId: gatewayInstallation.workspaceId,
                ...avatar,
              }),
            }
          : {}),
      });
      return c.json({
        agent: await agentAdminProjection(updated, store(c), snapshots(c)),
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof AgentAvatarError) {
        return c.json({ error: error.code }, error.code === 'too_large' ? 413 : 400);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/channels', async (c) => {
    const parsed = v.safeParse(publishAgentSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const agentId = c.req.param('id');
    try {
      const actor = await agentActor(c);
      if (actor.slackTeamId !== parsed.output.workspaceId) throw new AuthorizationError();
      let current = await store(c).getAgent(agentId);
      requireAgentEdit(actor.principal, current);
      current = await ensureGeneratedGatewayAvatar(
        c,
        current,
        parsed.output.workspaceId,
      );
      const reconciler = new AgentPresenceReconciler({
        config: store(c),
        transport: await agentSlackTransport(c, parsed.output.workspaceId),
      });
      const result = await reconciler.publish({
        workspaceId: parsed.output.workspaceId,
        agentId,
        channelId: parsed.output.channelId,
        actorMembershipId: actor.principal.membershipId,
        actorSlackUserId: actor.slackUserId,
      });
      return c.json({
        grant: result.grant,
        agent: await agentAdminProjection(result.agent, store(c), snapshots(c)),
      }, 201);
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return agentPresenceFailureResponse(c, agentId, error);
    }
  });

  app.delete('/admin/api/agents/:id/channels/:workspaceId/:channelId', async (c) => {
    const agentId = c.req.param('id');
    try {
      const actor = await agentActor(c);
      if (actor.slackTeamId !== c.req.param('workspaceId')) throw new AuthorizationError();
      const current = await store(c).getAgent(agentId);
      requireAgentEdit(actor.principal, current);
      const removed = await store(c).deleteAgentChannelGrant(
        c.req.param('workspaceId'),
        c.req.param('channelId'),
        agentId,
      );
      return c.json({ removed });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/slack/retry', async (c) => {
    const parsed = v.safeParse(retryAgentPresenceSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const agentId = c.req.param('id');
    try {
      const actor = await agentActor(c);
      const workspaceId = parsed.output.workspaceId ?? actor.slackTeamId;
      if (actor.slackTeamId !== workspaceId) throw new AuthorizationError();
      let current = await store(c).getAgent(agentId);
      requireAgentEdit(actor.principal, current);
      current = await ensureGeneratedGatewayAvatar(c, current, workspaceId);
      const reconciler = new AgentPresenceReconciler({
        config: store(c),
        transport: await agentSlackTransport(c, workspaceId),
      });
      const pendingGrants = (await store(c).listAgentChannelGrants()).filter(
        (grant) => grant.agentId === agentId && grant.workspaceId === workspaceId &&
          grant.status !== 'active',
      );
      let updated = current;
      if (pendingGrants.length > 0) {
        for (const pendingGrant of pendingGrants) {
          updated = (await reconciler.publish({
            workspaceId,
            agentId,
            channelId: pendingGrant.channelId,
            actorMembershipId: actor.principal.membershipId,
            actorSlackUserId: actor.slackUserId,
          })).agent;
        }
      } else {
        updated = await reconciler.retry(agentId);
      }
      return c.json({
        agent: await agentAdminProjection(updated, store(c), snapshots(c)),
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      return agentPresenceFailureResponse(c, agentId, error);
    }
  });

  app.post('/admin/api/agents/:id/archive', async (c) => {
    const parsed = v.safeParse(archiveAgentSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const agentId = c.req.param('id');
    try {
      const actor = await agentActor(c);
      const current = await store(c).getAgent(agentId);
      requireAgentEdit(actor.principal, current);
      if (current.revision !== parsed.output.expectedRevision) {
        throw new AgentRevisionConflictError(
          agentId,
          parsed.output.expectedRevision,
          current.revision,
        );
      }
      const isWorkspaceDefault = (await store(c).listWorkspaceInstallations()).some(
        (installation) => installation.defaultAgentId === agentId,
      );
      if (isWorkspaceDefault && !parsed.output.replacementDefaultAgentId) {
        return c.json({ error: 'replacement_default_agent_required' }, 409);
      }
      const archiveOptions = parsed.output.replacementDefaultAgentId
        ? { replacementDefaultAgentId: parsed.output.replacementDefaultAgentId }
        : {};
      const updated = current.slackPresence?.userGroupId
        ? await new AgentPresenceReconciler({
            config: store(c),
            transport: await agentSlackTransport(c, actor.slackTeamId),
          }).archive(agentId, archiveOptions)
        : await store(c).archiveAgent(agentId, {
            expectedRevision: current.revision,
            ...archiveOptions,
          });
      return c.json({ agent: await agentAdminProjection(updated, store(c), snapshots(c)) });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof AgentRevisionConflictError) {
        return c.json({ error: 'agent_revision_conflict' }, 409);
      }
      if (error instanceof AgentPresenceError) {
        return agentPresenceFailureResponse(c, agentId, error);
      }
      return internalError(c, error);
    }
  });

  app.post('/admin/api/agents/:id/restore', async (c) => {
    const parsed = v.safeParse(restoreAgentSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    const agentId = c.req.param('id');
    try {
      const actor = await agentActor(c);
      const current = await store(c).getAgent(agentId);
      requireAgentEdit(actor.principal, current);
      if (current.revision !== parsed.output.expectedRevision) {
        throw new AgentRevisionConflictError(
          agentId,
          parsed.output.expectedRevision,
          current.revision,
        );
      }
      const workspaceId = parsed.output.workspaceId ?? actor.slackTeamId;
      if (workspaceId !== actor.slackTeamId) throw new AuthorizationError();
      const updated = current.slackPresence?.userGroupId
        ? await new AgentPresenceReconciler({
            config: store(c),
            transport: await agentSlackTransport(c, workspaceId),
          }).restore(agentId)
        : await store(c).restoreAgent(agentId, current.revision);
      return c.json({ agent: await agentAdminProjection(updated, store(c), snapshots(c)) });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UnknownAgentError) return c.json({ error: 'not_found' }, 404);
      if (error instanceof AgentRevisionConflictError) {
        return c.json({ error: 'agent_revision_conflict' }, 409);
      }
      return agentPresenceFailureResponse(c, agentId, error);
    }
  });

  app.delete('/admin/api/agents/:id', async (c) => {
    const configStore = store(c);
    const agentId = c.req.param('id');
    let agent: CustomAgentConfig;
    try {
      agent = await configStore.getAgent(agentId);
    } catch (err) {
      if (!(err instanceof UnknownAgentError)) {
        return internalError(c, err);
      }
      try {
        const settingsStore = settings(c);
        const resumedMcp = await finishMcpSecretCleanup(agentId, settingsStore);
        const resumedConnector = await finishConnectorSecretCleanup(
          agentId,
          c.env as PlatformEnv | undefined,
          settingsStore,
        );
        return resumedMcp || resumedConnector
          ? c.body(null, 204)
          : c.json({ error: 'not_found' }, 404);
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
    }

    const references = await configStore.getAgentReferences(agentId);
    if (agentReferenceCount(references) > 0) {
      return c.json({ error: 'agent_still_referenced', references }, 409);
    }
    const liveSnapshotRoots = projectLiveSnapshotRoots(
      await snapshots(c).listLiveRootsByAgent(agentId),
    );
    if (liveSnapshotRoots.length > 0) {
      return c.json({
        error: 'agent_live_snapshot_roots',
        agentId,
        roots: liveSnapshotRoots,
      }, 409);
    }
    try {
      const principal = principalByContext.get(c);
      if (!principal) throw new AuthorizationError('principal_required');
      await (await resolvedConnectionAccounts(c)).prepareAgentDeletion({
        principal,
        agentId,
        expectedRevision: agent.revision,
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof AgentRevisionConflictError) {
        return c.json({ error: 'agent_revision_conflict' }, 409);
      }
      if (error instanceof AgentStillReferencedError) return agentStillReferenced(c, error);
      if (error instanceof ConnectionScheduleConflictError) return c.json({
        error: 'connection_schedule_changed',
        message: error.message,
      }, 409);
      return internalError(c, error);
    }
    // Persist the cleanup inventory before deleting the Agent. The marker is
    // independent of the config row, so settings cleanup can be retried after a
    // partial failure or an ambiguous DO/RPC response where the delete committed
    // but the caller only observed an error.
    const settingsStore = settings(c);
    const secretKeys = new Set<string>();
    for (const server of agent.mcpServers) {
      const ref = { agentId, connectionId: server.id };
      secretKeys.add(mcpBearerSettingKey(ref));
      for (const name of server.headerNames) {
        secretKeys.add(mcpHeaderSettingKey(ref, name));
      }
      for (const key of mcpOAuthSettingKeys(ref)) {
        secretKeys.add(key);
      }
    }
    try {
      await stageMcpSecretCleanup(agentId, [...secretKeys], settingsStore);
      await stageConnectorSecretCleanup(
        agentId,
        agent.apiConnections.map((connection) => connection.id),
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
      await stageConnectorSettingCleanup(
        agentId,
        agent.apiConnections.filter((connection) => connection.authMode === 'oauth').flatMap((connection) =>
          apiOAuthSettingKeys({ agentId, connectionId: connection.id }),
        ),
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
    } catch (err) {
      return internalError(c, err);
    }

    try {
      // Config and Agent-owned memory delete in one state transaction after
      // every durable reference and live frozen root has been cleared.
      await configStore.deleteAgentWithMemory(
        agentId,
        agentDeleteIdempotencyKey(c, agentId),
      );
    } catch (err) {
      try {
        await configStore.getAgent(agentId);
      } catch (inspectionError) {
        if (inspectionError instanceof UnknownAgentError) {
          // The delete committed but its response was lost. Continue using the
          // durable marker rather than restoring secrets into an orphaned scope.
          try {
            await finishMcpSecretCleanup(agentId, settingsStore);
            await finishConnectorSecretCleanup(
              agentId,
              c.env as PlatformEnv | undefined,
              settingsStore,
            );
            return c.body(null, 204);
          } catch (cleanupError) {
            return internalError(c, cleanupError);
          }
        }
        return internalError(c, inspectionError);
      }
      if (err instanceof AgentStillAssignedError) {
        return c.json({ error: 'agent_still_assigned' }, 409);
      }
      if (err instanceof AgentStillReferencedError) {
        return agentStillReferenced(c, err);
      }
      return internalError(c, err);
    }

    try {
      await finishMcpSecretCleanup(agentId, settingsStore);
      await finishConnectorSecretCleanup(
        agentId,
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
      return c.body(null, 204);
    } catch (err) {
      return internalError(c, err);
    }
  });

  const onboardingSlackContext = async (c: Context) => {
    const settingsStore = settings(c);
    const gatewayInstallation = (await store(c).listWorkspaceInstallations()).find(
      (installation) => installation.transportMode === 'gateway' &&
        installation.health !== 'revoked' && Boolean(installation.gatewayBindingId),
    );
    if (gatewayInstallation) {
      const descriptor = await slackWorkspaceDescriptor(c);
      return {
        connected: true,
        teamId: gatewayInstallation.teamId ?? gatewayInstallation.workspaceId,
        teamName: descriptor?.teamName ??
          await settingsStore.getSetting(SLACK_SETTING_KEYS.teamName) ?? undefined,
        appId: gatewayInstallation.appId,
      };
    }
    const [credentials, teamInfo, installations] = await Promise.all([
      describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settingsStore,
        slackCredentialResolutionDependencies(c),
      ),
      readStoredSlackTeamInfo(
        c.env as PlatformEnv | undefined,
        settingsStore,
        slackCredentialResolutionDependencies(c),
      ),
      store(c).listWorkspaceInstallations(),
    ]);
    const installation = teamInfo.teamId
      ? installations.find((candidate) => candidate.workspaceId === teamInfo.teamId)
      : installations.find((candidate) => candidate.transportMode === 'direct');
    const connected =
      Boolean(installation) && installation?.health !== 'revoked' &&
      credentials.botToken !== 'missing' &&
      credentials.signingSecret !== 'missing';
    return {
      connected,
      teamId: teamInfo.teamId ?? installation?.workspaceId,
      teamName: teamInfo.teamName,
      appId: installation?.appId,
    };
  };

  const onboardingProviderReady = async (
    c: Context,
    providerId: OnboardingProviderId,
  ): Promise<boolean> => {
    if (providerId === 'cloudflare') {
      return await getWorkersAiEnabled(settings(c)) &&
        workersAiStatus(c.env as PlatformEnv | undefined) !== 'missing';
    }
    if (!isProviderKeyId(providerId)) return false;
    return (await resolveProviderApiKey(
      providerId,
      c.env as PlatformEnv | undefined,
      settings(c),
    )).source !== 'missing';
  };

  const onboardingModelOptions = async (
    c: Context,
    providerId: OnboardingProviderId,
  ): Promise<string[]> => {
    await loadModelCatalog(settings(c));
    const runtime = modelProviders().find((provider) => provider.id === providerId);
    if (providerId === 'anthropic') {
      return uniqueStrings([
        ...activeCatalogModels('anthropic_api_key').map((model) => model.canonical),
        ...(runtime?.suggestions ?? []),
      ]);
    }
    if (providerId === 'openai') {
      return uniqueStrings([
        ...activeCatalogModels('openai_api_key').map((model) => model.canonical),
        ...(runtime?.suggestions ?? []),
      ]);
    }
    if (providerId === 'openrouter') {
      const favorites = await getProviderFavorites('openrouter', settings(c));
      return uniqueStrings([
        ...favorites.map((model) => `openrouter/${model}`),
        ...(runtime?.suggestions ?? []),
      ]);
    }
    const favorites = await getProviderFavorites('workers-ai', settings(c));
    return uniqueStrings([
      ...favorites.map((model) => `cloudflare/${model}`),
      ...(runtime?.suggestions ?? []),
    ]);
  };

  const onboardingResponse = async (
    c: Context,
    initial: OnboardingSnapshot,
  ): Promise<Response> => {
    c.header('Cache-Control', 'no-store');
    let snapshot = initial;
    const { journey } = snapshot;
    if (journey.state === 'complete') {
      const installation = journey.selectedWorkspaceId
        ? await store(c).getWorkspaceInstallation(journey.selectedWorkspaceId)
        : undefined;
      return c.json({
        stage: 'complete',
        revision: snapshot.revision,
        agentId: journey.agentId ?? null,
        redirectTo: '/admin/agents',
        workspace: journey.selectedWorkspaceId
          ? { id: journey.selectedWorkspaceId, name: null }
          : null,
        channel: journey.selectedChannelId
          ? { id: journey.selectedChannelId, name: journey.selectedChannelName }
          : null,
        providerId: journey.selectedProviderId ?? null,
        modelId: journey.selectedModelId ?? null,
        models: [],
        slackAppId: installation?.appId ?? null,
        tryStartedAt: journey.tryStartedAt ?? null,
        completedAt: journey.completedAt ?? null,
      });
    }

    const slack = await onboardingSlackContext(c);
    if (!slack.connected || !slack.teamId) {
      return c.json({
        stage: 'connect_slack',
        revision: snapshot.revision,
        agentId: null,
        redirectTo: null,
        workspace: null,
        channel: null,
        providerId: null,
        modelId: null,
        models: [],
        slackAppId: null,
        tryStartedAt: null,
        completedAt: null,
      });
    }

    if (journey.selectedWorkspaceId && journey.selectedProviderId &&
        journey.selectedModelId && journey.trySlackUserId && journey.tryStartedAt) {
      const delivered = await hasDeliveredOnboardingReply(work(c), {
          workspaceId: journey.selectedWorkspaceId,
          slackUserId: journey.trySlackUserId,
          tryStartedAt: journey.tryStartedAt,
        });
      if (delivered) {
        try {
          snapshot = await completeOnboardingJourney(settings(c), snapshot.revision);
        } catch (error) {
          const raced = await readOnboardingJourney(settings(c));
          if (!raced || raced.journey.state !== 'complete') throw error;
          snapshot = raced;
        }
      }
      return c.json({
        stage: snapshot.journey.state === 'complete' ? 'complete' : 'try',
        revision: snapshot.revision,
        agentId: journey.agentId ?? null,
        redirectTo: snapshot.journey.state === 'complete' ? '/admin/agents' : null,
        workspace: {
          id: journey.selectedWorkspaceId,
          name: slack.teamId === journey.selectedWorkspaceId ? (slack.teamName ?? null) : null,
        },
        channel: null,
        providerId: journey.selectedProviderId ?? null,
        modelId: journey.selectedModelId ?? null,
        models: [],
        slackAppId: slack.appId ?? null,
        tryStartedAt: journey.tryStartedAt,
        completedAt: snapshot.journey.completedAt ?? null,
      });
    }

    return c.json({
      stage: journey.selectedProviderId ? 'choose_model' : 'choose_provider',
      revision: snapshot.revision,
      agentId: journey.agentId ?? null,
      redirectTo: null,
      workspace: {
        id: journey.selectedWorkspaceId ?? slack.teamId,
        name: slack.teamId === (journey.selectedWorkspaceId ?? slack.teamId)
          ? (slack.teamName ?? null)
          : null,
      },
      channel: null,
      providerId: journey.selectedProviderId ?? null,
      modelId: null,
      models: journey.selectedProviderId
        ? await onboardingModelOptions(c, journey.selectedProviderId)
        : [],
      slackAppId: slack.appId ?? null,
      tryStartedAt: null,
      completedAt: null,
    });
  };

  app.get('/admin/api/onboarding', async (c) => {
    try {
      const snapshot = await readOnboardingJourney(settings(c));
      if (!snapshot) return c.json({ error: 'onboarding_not_found' }, 404);
      return onboardingResponse(c, snapshot);
    } catch (error) {
      return internalError(c, error);
    }
  });

  app.post('/admin/api/onboarding/provider', async (c) => {
    const parsed = v.safeParse(onboardingProviderSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const snapshot = await readOnboardingJourney(settings(c));
      if (!snapshot) return c.json({ error: 'onboarding_not_found' }, 404);
      if (snapshot.revision !== parsed.output.expectedRevision) {
        return c.json({ error: 'onboarding_changed' }, 409);
      }
      if (snapshot.journey.state === 'complete') return onboardingResponse(c, snapshot);
      const slack = await onboardingSlackContext(c);
      if (!slack.connected || !slack.teamId) {
        return c.json({ error: 'slack_not_connected' }, 409);
      }
      if (!await onboardingProviderReady(c, parsed.output.providerId)) {
        return c.json({ error: 'onboarding_provider_not_configured' }, 409);
      }
      const selected = await selectOnboardingProvider(settings(c), {
        expectedRevision: snapshot.revision,
        workspaceId: slack.teamId,
        providerId: parsed.output.providerId,
      });
      return onboardingResponse(c, selected);
    } catch (error) {
      return internalError(c, error);
    }
  });

  app.post('/admin/api/onboarding/try', async (c) => {
    const parsed = v.safeParse(onboardingTrySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const principal = principalByContext.get(c)!;
      const snapshot = await readOnboardingJourney(settings(c));
      if (!snapshot) return c.json({ error: 'onboarding_not_found' }, 404);
      if (snapshot.revision !== parsed.output.expectedRevision) {
        return c.json({ error: 'onboarding_changed' }, 409);
      }
      if (snapshot.journey.state === 'complete') return onboardingResponse(c, snapshot);
      const journey = snapshot.journey;
      const providerId = journey.selectedProviderId;
      const workspaceId = journey.selectedWorkspaceId;
      if (!providerId || !workspaceId) {
        return c.json({ error: 'onboarding_provider_required' }, 409);
      }
      const modelOptions = await onboardingModelOptions(c, providerId);
      if (!modelOptions.includes(parsed.output.modelId)) {
        return invalidRequest(c, 'Choose a model from the selected provider.');
      }
      if (!await onboardingProviderReady(c, providerId)) {
        return c.json({ error: 'onboarding_provider_not_configured' }, 409);
      }
      const compatibilityError = activeCatalogCompatibilityError(
        parsed.output.modelId,
        await resolveOpenAiAuthMethod(settings(c)),
      );
      if (compatibilityError) return invalidRequest(c, compatibilityError);
      const slack = await onboardingSlackContext(c);
      if (!slack.connected || !slack.teamId) {
        return c.json({ error: 'slack_not_connected' }, 409);
      }
      if (slack.teamId !== workspaceId) {
        return c.json({ error: 'workspace_mismatch' }, 400);
      }
      const actor = await agentActor(c);
      if (actor.slackTeamId !== workspaceId) {
        return c.json({ error: 'workspace_mismatch' }, 400);
      }
      const installation = await store(c).getWorkspaceInstallation(workspaceId);
      if (!installation) {
        return c.json({ error: 'workspace_installation_required' }, 409);
      }
      if (!(slack.appId ?? installation.appId)) {
        return c.json({ error: 'slack_app_id_required' }, 409);
      }
      try {
        await store(c).putWorkspaceModelDefault({
          workspaceId,
          modelId: parsed.output.modelId,
          provenance: 'admin_selected',
          lastChangedByMembershipId: principal.membershipId,
        }, parsed.output.expectedDefaultRevision);
      } catch (error) {
        if (!(error instanceof WorkspaceModelDefaultRevisionConflictError)) throw error;
        const current = await store(c).getWorkspaceModelDefault(workspaceId);
        if (current?.modelId !== parsed.output.modelId) {
          return c.json({
            error: 'workspace_model_default_revision_conflict',
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
            workspaceDefault: await workspaceModelDefaultProjection({
              installation,
              configStore: store(c),
              settingsStore: settings(c),
              platformEnv: c.env as PlatformEnv | undefined,
              runtimeProviders: modelProviders(),
            }),
          }, 409);
        }
      }
      const [currentInstallation, currentDefault] = await Promise.all([
        store(c).getWorkspaceInstallation(workspaceId),
        store(c).getWorkspaceModelDefault(workspaceId),
      ]);
      if (!currentInstallation || !currentDefault?.modelId) {
        return c.json({ error: 'workspace_installation_required' }, 409);
      }
      if (currentInstallation.runtimeContract !== 'chickpea-v1') {
        const preflight = await store(c).preflightChickpeaCutover(workspaceId);
        if (preflight.blockers.length) {
          return c.json({
            error: 'chickpea_cutover_preflight_failed',
            blockers: preflight.blockers,
          }, 409);
        }
        try {
          await store(c).activateChickpeaCutover({
            workspaceId,
            expectedInstallationRevision: currentInstallation.revision,
            expectedDefaultRevision: currentDefault.revision,
            defaultReady: true,
          });
        } catch (error) {
          if (error instanceof WorkspaceModelDefaultRevisionConflictError) {
            return c.json({ error: 'workspace_model_default_revision_conflict' }, 409);
          }
          throw error;
        }
      }
      const started = await startOnboardingTry(settings(c), {
        expectedRevision: snapshot.revision,
        agentId: CHICKPEA_AGENT_ID,
        modelId: parsed.output.modelId,
        slackUserId: actor.slackUserId,
      });
      return onboardingResponse(c, started);
    } catch (error) {
      return internalError(c, error);
    }
  });

  app.post('/admin/api/onboarding/complete', async (c) => {
    const parsed = v.safeParse(onboardingCompleteSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const snapshot = await readOnboardingJourney(settings(c));
      if (!snapshot) return c.json({ error: 'onboarding_not_found' }, 404);
      if (snapshot.revision !== parsed.output.expectedRevision) {
        return c.json({ error: 'onboarding_changed' }, 409);
      }
      if (snapshot.journey.state === 'complete') return onboardingResponse(c, snapshot);
      if (!snapshot.journey.tryStartedAt) {
        return c.json({ error: 'onboarding_try_required' }, 409);
      }
      return onboardingResponse(
        c,
        await completeOnboardingJourney(settings(c), snapshot.revision),
      );
    } catch (error) {
      return internalError(c, error);
    }
  });

  app.get('/admin/api/channels', async (c) => {
    const configStore = store(c);
    const [configuredChannels, grants, agents] = await Promise.all([
      configStore.listChannels(),
      configStore.listAgentChannelGrants(),
      configStore.listUserAgents(),
    ]);
    let discoveredChannels: Awaited<ReturnType<typeof listSlackChannels>>['channels'] = [];
    let discoveryError: string | null = null;
    let discoveryConnected = false;
    let teamInfo: SlackTeamInfo = { teamId: undefined, teamName: undefined };
    try {
      const discovery = await discoverSlackChannels(c);
      discoveredChannels = discovery.channels;
      discoveryConnected = discovery.connected;
      teamInfo = discovery.teamInfo;
    } catch (error) {
      discoveryConnected = true;
      discoveryError = error instanceof SlackChannelsError
        ? error.slackError
        : error instanceof SlackTransportError
          ? error.code
          : 'slack_list_failed';
    }
    const discoveredChannelsById = new Map(
      discoveredChannels.map((channel) => [channel.id, channel]),
    );
    const channelsByKey = new Map(
      configuredChannels.map((channel) => [
        `${channel.workspaceId}\u0000${channel.channelId}`,
        {
          channel,
          discovered: discoveredChannelsById.get(channel.channelId),
        },
      ]),
    );
    if (teamInfo.teamId) {
      for (const discovered of discoveredChannels) {
        const key = `${teamInfo.teamId}\u0000${discovered.id}`;
        if (!channelsByKey.has(key)) {
          channelsByKey.set(key, {
            channel: {
              workspaceId: teamInfo.teamId,
              channelId: discovered.id,
              label: discovered.name,
              lifecycle: 'active',
            },
            discovered,
          });
        }
      }
    }
    for (const grant of grants) {
      const key = `${grant.workspaceId}\u0000${grant.channelId}`;
      if (!channelsByKey.has(key)) {
        channelsByKey.set(key, {
          channel: {
            workspaceId: grant.workspaceId,
            channelId: grant.channelId,
            ...(grant.channelLabel ? { label: grant.channelLabel } : {}),
            lifecycle: 'active',
          },
          discovered: discoveredChannelsById.get(grant.channelId),
        });
      }
    }
    const grantsByChannel = new Map<string, AgentChannelGrant[]>();
    for (const grant of grants) {
      const key = `${grant.workspaceId}\u0000${grant.channelId}`;
      const current = grantsByChannel.get(key) ?? [];
      current.push(grant);
      grantsByChannel.set(key, current);
    }
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    return c.json({
      channels: [...channelsByKey.values()].map(({ channel, discovered }) => {
        const channelGrants = grantsByChannel.get(
          `${channel.workspaceId}\u0000${channel.channelId}`,
        ) ?? [];
        const projectedGrants = channelGrants.map((grant) => {
          const agent = agentsById.get(grant.agentId);
          return {
            agentId: grant.agentId,
            agentName: agent?.name ?? null,
            agentEnabled: agent?.enabled ?? false,
            agentLifecycle: agent?.lifecycle ?? null,
            status: grant.status,
          };
        });
        const readiness = channel.lifecycle === 'archived'
          ? { ready: false, code: 'channel_archived', reasons: ['Channel is archived.'] }
          : channelGrants.length === 0
            ? { ready: false, code: 'no_agents', reasons: ['No Agents are active in this Channel.'] }
            : projectedGrants.some(({ agentName }) => agentName === null)
              ? { ready: false, code: 'agent_missing', reasons: ['A granted Agent no longer exists.'] }
              : projectedGrants.some(({ agentEnabled, agentLifecycle }) =>
                  !agentEnabled || agentLifecycle === 'archived')
                ? { ready: false, code: 'agent_unavailable', reasons: ['A granted Agent is unavailable.'] }
                : channelGrants.some(({ status }) => status !== 'active')
                  ? { ready: false, code: 'grant_needs_attention', reasons: ['An Agent grant needs attention.'] }
                  : discovered?.isMember === false
                    ? { ready: false, code: 'membership_required', reasons: ['Invite Chickpea to this Channel.'] }
                    : { ready: true, code: 'ready', reasons: [] };
        return {
          workspaceId: channel.workspaceId,
          channelId: channel.channelId,
          channelName: channel.label ?? channel.channelId,
          source: discovered
            ? (channelGrants.length > 0
              ? 'granted_and_discovered'
              : 'discovered')
            : 'granted',
          isPrivate: discovered?.isPrivate ?? null,
          isMember: discovered?.isMember ?? null,
          grants: projectedGrants,
          readiness,
          links: {
            channel: `/admin/channels/${encodeURIComponent(channel.workspaceId)}/${encodeURIComponent(channel.channelId)}`,
          },
        };
      }),
      discovery: {
        connected: discoveryConnected,
        error: discoveryError,
      },
    });
  });

  // Server-side channel picker source for the Add-channel form: the browser
  // never touches a Slack token. Cursor-paginated + cached in-isolate (see
  // channels.ts); ?refresh=1 bypasses after the operator invites the bot to a
  // new channel. Fails closed with a clear envelope when Slack is not connected.
  app.get('/admin/api/slack-channels', async (c) => {
    try {
      const { channels, truncated, connected, teamInfo } = await discoverSlackChannels(c);
      if (!connected) return c.json({ error: 'slack_not_configured' }, 409);
      return c.json({
        channels,
        teamId: teamInfo.teamId ?? null,
        teamName: teamInfo.teamName ?? null,
        truncated,
      });
    } catch (err) {
      if (err instanceof SlackChannelsError) {
        // A live Slack rejection (invalid_auth, missing_scope, ...): surface it
        // as a clear 502 envelope rather than a bare internal error.
        return c.json({ error: 'slack_list_failed', detail: err.slackError }, 502);
      }
      if (err instanceof SlackTransportError) {
        return c.json({ error: 'slack_list_failed', detail: err.code }, 502);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/effective-config', async (c) => {
    const key = channelKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    try {
      const configStore = store(c);
      return c.json({
        config: effectiveConfigResponse(
          await resolveEffectiveSlackConfig(key.workspaceId, key.channelId, {
            agents: configStore,
            grants: configStore,
          }, process.env, c.req.query('agentId')),
        ),
      });
    } catch (err) {
      if (err instanceof NoAssignmentError || err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      if (err instanceof ModelResolutionError) {
        return modelNotResolvable(c, err);
      }
      return internalError(c, err);
    }
  });

  // First-run Slack-connection wizard state: one active encrypted bundle plus
  // the manifest deep-link with this install's events URL substituted
  // server-side. The canonical public revision supplies the team identity.
  app.get('/admin/api/slack-connection', async (c) => {
    try {
      const settingsStore = settings(c);
      const credentials = await describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settingsStore,
        slackCredentialResolutionDependencies(c),
      );
      // Prefer stored metadata. Shared-app installs that predate workspace-name
      // persistence do one best-effort gateway lookup, then cache the result.
      let teamInfo = await readStoredSlackTeamInfo(
        c.env as PlatformEnv | undefined,
        settingsStore,
        slackCredentialResolutionDependencies(c),
      );
      const installations = await store(c).listWorkspaceInstallations();
      const connectedTeamId = teamInfo.teamId;
      const installation = connectedTeamId
        ? installations.find((candidate) => candidate.workspaceId === connectedTeamId)
        : installations[0];
      const directConnected =
        credentials.botToken !== 'missing' && credentials.signingSecret !== 'missing';
      const gatewayConnected =
        installation?.transportMode === 'gateway' &&
        Boolean(installation.gatewayBindingId) &&
        installation.health !== 'revoked';
      if (gatewayConnected && !teamInfo.teamName) {
        const descriptor = await slackWorkspaceDescriptor(c);
        if (descriptor && (!teamInfo.teamId || descriptor.teamId === teamInfo.teamId)) {
          teamInfo = {
            teamId: teamInfo.teamId ?? descriptor.teamId,
            teamName: descriptor.teamName,
          };
        }
      }
      const requestUrl = `${requestOrigin(c)}/channels/slack/events`;
      return c.json({
        credentials,
        connected: Boolean(installation) && (directConnected || gatewayConnected),
        teamId: installation?.workspaceId ?? connectedTeamId ?? null,
        teamName: teamInfo.teamName ?? null,
        transportMode: installation?.transportMode ?? 'direct',
        health: installation?.health ?? 'pending',
        healthDetail: installation?.healthDetail ?? null,
        requestUrl,
        manifestUrl: slackManifestUrl(requestUrl),
      });
    } catch (err) {
      return internalError(c, err);
    }
  });

  // Re-check the CURRENT effective bot token without changing any stored
  // identity. This is deliberately separate from the paste-back wizard:
  // operators can diagnose an existing install without silently backfilling
  // metadata or rotating credentials.
  app.post('/admin/api/slack-connection/test', async (c) => {
    let botToken: string | undefined;
    try {
      botToken = (
        await resolveSlackCredentials(
          c.env as PlatformEnv | undefined,
          settings(c),
          slackCredentialResolutionDependencies(c),
        )
      ).botToken;
    } catch (err) {
      return internalError(c, err);
    }
    if (!botToken) {
      const installation = (await store(c).listWorkspaceInstallations()).find(
        (candidate) => candidate.transportMode === 'gateway' &&
          Boolean(candidate.gatewayBindingId) && candidate.health !== 'revoked',
      );
      if (!installation?.botUserId) {
        return c.json({ error: 'slack_not_configured' }, 409);
      }
      let inboundStatus = await readGatewaySessionStatus(c.env);
      if (!inboundStatus.healthy) {
        // An explicit Admin retry is also the recovery action. A stale or
        // needs-attention runner can otherwise remain observable-but-idle
        // after the gateway Worker is redeployed even though the binding and
        // outbound Slack credential are still healthy.
        await restartCloudflareGatewaySession(c.env);
        inboundStatus = await readGatewaySessionStatus(c.env);
      }
      try {
        const bot = await (await agentSlackTransport(c, installation.workspaceId))
          .lookupMember(installation.botUserId);
        if (
          bot.id !== installation.botUserId ||
          (bot.teamId !== undefined && bot.teamId !== installation.workspaceId) ||
          bot.deleted
        ) {
          return c.json({
            error: 'slack_auth_failed',
            detail: 'gateway_identity_mismatch',
          }, 422);
        }
        if (!inboundStatus.healthy) {
          const healthDetail = inboundStatus.detail ?? 'gateway_session_offline';
          try {
            const current = await store(c).getWorkspaceInstallation(installation.workspaceId);
            if (
              current &&
              (current.health !== 'needs_attention' ||
                current.healthDetail !== healthDetail)
            ) {
              await store(c).updateWorkspaceInstallation(installation.workspaceId, {
                health: 'needs_attention',
                healthDetail,
              }, current.revision);
            }
          } catch {
            // This response still reports current live health; reload reconciles
            // a concurrent installation write.
          }
          return c.json({
            error: 'slack_gateway_unreachable',
            detail: healthDetail,
          }, 502);
        }
        if (installation.health !== 'healthy' || installation.healthDetail) {
          const current = await store(c).getWorkspaceInstallation(installation.workspaceId);
          if (current && (current.health !== 'healthy' || current.healthDetail)) {
            await store(c).updateWorkspaceInstallation(installation.workspaceId, {
              health: 'healthy',
              healthDetail: null,
            }, current.revision);
          }
        }
        const teamInfo = await readStoredSlackTeamInfo(
          c.env as PlatformEnv | undefined,
          settings(c),
          slackCredentialResolutionDependencies(c),
        );
        return c.json({
          ok: true,
          teamId: installation.workspaceId,
          teamName: teamInfo.teamName ?? null,
          botName: bot.displayName ?? bot.name ?? null,
          botUserId: bot.id,
          transportMode: 'gateway',
        });
      } catch (error) {
        const detail = error instanceof SlackTransportError ? error.code : 'gateway_unreachable';
        if (GATEWAY_RECONNECT_REQUIRED_DETAILS.has(detail)) {
          try {
            const current = await store(c).getWorkspaceInstallation(installation.workspaceId);
            if (current && current.healthDetail !== detail) {
              await store(c).updateWorkspaceInstallation(installation.workspaceId, {
                health: 'needs_attention',
                healthDetail: detail,
              }, current.revision);
            }
          } catch {
            // The diagnostic response is still authoritative for this request;
            // a concurrent installation update will be reflected on reload.
          }
        }
        const diagnostic = error instanceof Error
          ? error.message.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 240)
          : 'unknown';
        console.error('[chickpea] shared Slack connection test failed:', detail, diagnostic);
        return c.json({ error: 'slack_gateway_unreachable', detail }, 502);
      }
    }

    let auth;
    try {
      auth = await slackAuthTest(botToken);
    } catch (err) {
      console.error(
        '[chickpea] connection auth.test unreachable:',
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: 'slack_unreachable' }, 502);
    }
    if (!auth.ok) {
      return c.json(
        { error: 'slack_auth_failed', ...(auth.error ? { detail: auth.error } : {}) },
        422,
      );
    }
    const missingScopes = missingRequiredSlackBotScopes(auth.grantedScopes);
    if (missingScopes?.length) {
      return c.json({ error: 'slack_missing_scopes', missingScopes }, 422);
    }
    return c.json({
      ok: true,
      teamId: auth.teamId ?? null,
      teamName: auth.teamName ?? null,
      botName: auth.botName ?? null,
      botUserId: auth.botUserId ?? null,
    });
  });

  // A shared-app grant can be revoked independently of the deployment. Let an
  // authenticated Admin replace that grant without reopening first-run setup
  // or recreating Agents and Channel grants. This is deliberately POST-only:
  // opening or prefetching an Admin page must never create a replacement claim.
  const beginSlackGatewayRefresh = async (c: Context): Promise<Response> => {
    try {
      const claim = await createGatewayDeploymentClient(
        c.env as PlatformEnv | undefined,
      ).beginClaim(
        `${requestOrigin(c)}/admin/slack-gateway/refresh/finish`,
        undefined,
        { reconnect: true },
      );
      if ((c.req.header('accept') ?? '').includes('application/json')) {
        return c.json({ authorizationUrl: claim.authorizationUrl });
      }
      return c.redirect(claim.authorizationUrl, 303);
    } catch (error) {
      console.error(
        '[chickpea] shared Slack reconnect failed to start:',
        error instanceof SlackTransportError ? error.code :
          error instanceof Error ? error.message : String(error),
      );
      if ((c.req.header('accept') ?? '').includes('application/json')) {
        return c.json({ error: 'slack_reconnect_start_failed' }, 502);
      }
      return c.redirect('/admin/settings/slack?slack_reconnect=failed', 303);
    }
  };
  // Keep the original endpoint as a compatibility alias for bookmarks and
  // already-rendered Admin tabs; the attached UI uses the neutral refresh URL.
  app.get('/admin/slack-gateway/reconnect', (c) =>
    c.json({ error: 'method_not_allowed' }, 405)
  );
  app.post('/admin/slack-gateway/reconnect', beginSlackGatewayRefresh);
  app.get('/admin/slack-gateway/refresh', (c) =>
    c.json({ error: 'method_not_allowed' }, 405)
  );
  app.post('/admin/slack-gateway/refresh', beginSlackGatewayRefresh);

  const finishSlackGatewayRefresh = async (c: Context): Promise<Response> => {
    try {
      const result = await createGatewayDeploymentClient(
        c.env as PlatformEnv | undefined,
      ).refreshClaim();
      if (result.state !== 'bound') {
        return c.redirect('/admin/settings/slack?slack_reconnect=pending', 303);
      }
      startNodeGatewaySession(c.env as PlatformEnv | undefined);
      await restartCloudflareGatewaySession(c.env);
      return c.redirect('/admin/settings/slack?slack_reconnect=connected', 303);
    } catch (error) {
      console.error(
        '[chickpea] shared Slack reconnect could not finish:',
        error instanceof SlackTransportError ? error.code :
          error instanceof Error ? error.message : String(error),
      );
      return c.redirect('/admin/settings/slack?slack_reconnect=failed', 303);
    }
  };
  app.get('/admin/slack-gateway/reconnect/finish', finishSlackGatewayRefresh);
  app.get('/admin/slack-gateway/refresh/finish', finishSlackGatewayRefresh);

  // Disconnect is a LOCAL credential removal, not a Slack uninstall/revoke.
  // Environment-managed credentials cannot be removed from a browser, and a
  // partial stored install is treated as read-only rather than implying the
  // app has been fully disconnected.
  app.delete('/admin/api/slack-connection', async (c) => {
    try {
      const settingsStore = settings(c);
      const configStore = store(c);
      const expectedRevision = await readSlackConnectionRevision(
        settingsStore,
        slackCredentialResolutionDependencies(c),
      );
      const sources = await describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settingsStore,
        slackCredentialResolutionDependencies(c),
      );
      const hasStoredCredentials =
        sources.botToken === 'stored' && sources.signingSecret === 'stored';
      if (!hasStoredCredentials) {
        return c.json({ error: 'slack_connection_read_only' }, 409);
      }

      // Clear non-authoritative presentation/setup metadata first. If this
      // store is unavailable, the active credential revision remains intact.
      // Once the credential tombstone wins, a retry may resume from the stale
      // connected lifecycle without restoring or regenerating secrets.
      const applied = await settingsStore.applySettingsPatch({
        delete: [
          SLACK_SETTING_KEYS.teamName,
          SLACK_PENDING_ENVELOPE_SETTING,
        ],
      });
      if (!applied) {
        return c.json(
          {
            error: 'slack_connection_changed',
            message: 'Slack connection changed before it could be disconnected. Try again.',
          },
          409,
        );
      }
      if (hasStoredCredentials) {
        await clearSlackInstallationCredentials(
          slackCredentialWriteTarget(c),
          WORKSPACE_SLACK_INSTALLATION_ID,
          expectedRevision,
        );
      }
      for (const installation of await configStore.listWorkspaceInstallations()) {
        if (installation.transportMode !== 'direct') continue;
        await configStore.updateWorkspaceInstallation(
          installation.workspaceId,
          { health: 'needs_attention', healthDetail: 'credentials_missing' },
          installation.revision,
        );
      }
      return c.json({
        ok: true,
        connected: false,
        slackAppUninstalled: false,
        slackAppRevoked: false,
        configurationPreserved: true,
        message:
          'Disconnected Chickpea locally. The Slack app was not uninstalled or revoked, and Agents, Channel grants, transcripts, and the public URL were preserved.',
      });
    } catch (err) {
      if (err instanceof SlackInstallationCredentialRevisionError) {
        return c.json(
          {
            error: 'slack_connection_changed',
            message: 'Slack connection changed before it could be disconnected. Try again.',
          },
          409,
        );
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/slack-behavior', async (c) => {
    try {
      return c.json(
        await resolveSlackBehaviorSettings(
          c.env as PlatformEnv | undefined,
          settings(c),
        ),
      );
    } catch (err) {
      return internalError(c, err);
    }
  });

  app.put('/admin/api/slack-behavior', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(slackBehaviorPatchSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const patch = parsed.output as SlackBehaviorPatch;
    const readOnly = envManagedSlackBehaviorKeys(patch);
    if (readOnly.length > 0) {
      return c.json({ error: 'slack_setting_read_only', settings: readOnly }, 409);
    }
    try {
      const settingsStore = settings(c);
      await saveSlackBehaviorSettings(settingsStore, patch);
      return c.json(
        await resolveSlackBehaviorSettings(
          c.env as PlatformEnv | undefined,
          settingsStore,
        ),
      );
    } catch (err) {
      return internalError(c, err);
    }
  });

  // SPA catch-all, registered LAST: every client-routed page path
  // (/admin/agents, /admin/channels/T/C, ...) serves the same page so deep
  // links and refreshes work. Unmatched /admin/api/* stays a 404, never HTML.
  app.get('/admin/sessions', (c) => c.redirect('/admin/channels'));
  app.get('/admin/sessions/*', (c) => c.redirect('/admin/channels'));
  app.get('/admin/profiles', (c) => c.notFound());
  app.get('/admin/profiles/*', (c) => c.notFound());
  app.get('/admin/*', (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/admin/api/')) return c.notFound();
    return adminPage(c);
  });

  return app;
}

function slackGatewaySetupPageError(code: string): string {
  switch (code) {
    case 'gateway_not_configured':
    case 'gateway_unreachable':
    case 'gateway_redirect_rejected':
    case 'gateway_rejected':
      return code;
    default:
      return 'gateway_rejected';
  }
}

function mcpOAuthAdminRedirect(
  status: 'connected' | 'cancelled' | 'failed' | 'verification_failed',
  ref: { agentId: string; connectionId: string },
  returnAgentId?: string,
): string {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (connectionAccountId) {
    const destination = returnAgentId && AGENT_ID_PATTERN.test(returnAgentId)
      ? `/admin/agents/${encodeURIComponent(returnAgentId)}`
      : '/admin';
    return `${destination}?oauth=${status}&connection=${encodeURIComponent(connectionAccountId)}&lane=mcp`;
  }
  return (
    `/admin/agents/${encodeURIComponent(ref.agentId)}` +
    `?oauth=${status}&connection=${encodeURIComponent(ref.connectionId)}`
  );
}

function apiOAuthAdminRedirect(
  status: 'connected' | 'cancelled' | 'failed',
  ref: ApiOAuthRef,
  returnAgentId?: string,
): string {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (connectionAccountId) {
    const destination = returnAgentId && AGENT_ID_PATTERN.test(returnAgentId)
      ? `/admin/agents/${encodeURIComponent(returnAgentId)}`
      : '/admin';
    return `${destination}?oauth=${status}&connection=${encodeURIComponent(connectionAccountId)}&lane=api`;
  }
  return (
    `/admin/agents/${encodeURIComponent(ref.agentId)}` +
    `?oauth=${status}&connection=${encodeURIComponent(ref.connectionId)}&lane=api`
  );
}

async function isCurrentApiOAuthConnection(
  configStore: ConfigStore,
  ref: ApiOAuthRef,
  provider: ApiOAuthProvider,
): Promise<boolean> {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (connectionAccountId) {
    const account = await findConnectionAccount(configStore, connectionAccountId);
    if (!account || account.lifecycle === 'revoked') return false;
    return isApiOAuthAccount(account, provider);
  }
  try {
    const connection = (await configStore.getAgent(ref.agentId)).apiConnections.find(
      (candidate) => candidate.id === ref.connectionId,
    );
    return !!connection &&
      connection.authMode === 'oauth' &&
      connection.oauthProvider === provider &&
      isValidApiOAuthConnectionPolicy(connection);
  } catch (error) {
    if (error instanceof UnknownAgentError) return false;
    throw error;
  }
}

async function replaceReadyApiOAuthConnection(
  configStore: ConfigStore,
  ref: ApiOAuthRef,
  provider: ApiOAuthProvider,
  identity: { accountName?: string } | undefined,
  accountRevision?: number,
  oauthAttemptId?: string,
): Promise<void> {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (connectionAccountId) {
    const account = await findConnectionAccount(configStore, connectionAccountId);
    if (!account || account.lifecycle !== 'pending' ||
        (accountRevision !== undefined && account.revision !== accountRevision) ||
        (oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId) ||
        !isApiOAuthAccount(account, provider)) {
      if (account && (
        (accountRevision !== undefined && account.revision !== accountRevision) ||
        (oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId)
      )) {
        throw new ApiOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
      }
      throw new ApiOAuthError('connection_missing', 'OAuth connection no longer exists');
    }
    await configStore.putConnectionAccount({
      ...account,
      lifecycle: 'ready',
      ...(identity ? { identity } : {}),
    }, account.revision);
    return;
  }
  const agent = await configStore.getAgent(ref.agentId);
  const index = agent.apiConnections.findIndex(
    (connection) => connection.id === ref.connectionId &&
      connection.authMode === 'oauth' &&
      connection.oauthProvider === provider &&
      isValidApiOAuthConnectionPolicy(connection),
  );
  if (index < 0) {
    throw new ApiOAuthError('connection_missing', 'OAuth connection no longer exists');
  }
  const apiConnections = agent.apiConnections.slice();
  const current = apiConnections[index]!;
  apiConnections[index] = {
    ...current,
    lifecycleStatus: 'ready',
    statusText: 'Connected',
    ...(identity ? { identity } : {}),
  };
  await configStore.updateAgent(ref.agentId, { apiConnections });
}

async function replacePendingApiOAuthConnection(
  configStore: ConfigStore,
  ref: ApiOAuthRef,
  provider: ApiOAuthProvider,
): Promise<ConnectionAccount | undefined> {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (connectionAccountId) {
    const account = await findConnectionAccount(configStore, connectionAccountId);
    if (!account || account.lifecycle === 'revoked' || !isApiOAuthAccount(account, provider)) {
      throw new ApiOAuthError('connection_missing', 'OAuth connection no longer exists');
    }
    const { identity: _identity, ...withoutIdentity } = account;
    return configStore.putConnectionAccount({
      ...withoutIdentity,
      lifecycle: 'pending',
      policy: { ...withoutIdentity.policy, oauthAttemptId: randomUUID() },
    }, account.revision);
  }
  const agent = await configStore.getAgent(ref.agentId);
  const index = agent.apiConnections.findIndex(
    (connection) => connection.id === ref.connectionId &&
      connection.authMode === 'oauth' &&
      connection.oauthProvider === provider &&
      isValidApiOAuthConnectionPolicy(connection),
  );
  if (index < 0) {
    throw new ApiOAuthError('connection_missing', 'OAuth connection no longer exists');
  }
  const apiConnections = agent.apiConnections.slice();
  const current = apiConnections[index]!;
  const { identity: _identity, ...withoutIdentity } = current;
  apiConnections[index] = {
    ...withoutIdentity,
    lifecycleStatus: 'pending',
    statusText: 'Not connected',
  };
  await configStore.updateAgent(ref.agentId, { apiConnections });
  return undefined;
}

async function replacePendingMcpOAuthConnection(
  configStore: ConfigStore,
  ref: { agentId: string; connectionId: string },
  serverUrl: string,
): Promise<ConnectionAccount> {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (!connectionAccountId) {
    throw new McpOAuthError('connection_missing', 'Agent-owned OAuth connection is missing');
  }
  const account = await findConnectionAccount(configStore, connectionAccountId);
  if (!account || account.lifecycle === 'revoked' || !isMcpOAuthAccount(account, serverUrl)) {
    throw new McpOAuthError('connection_missing', 'OAuth connection no longer exists');
  }
  const { identity: _identity, ...withoutIdentity } = account;
  return configStore.putConnectionAccount({
    ...withoutIdentity,
    lifecycle: 'pending',
    policy: { ...withoutIdentity.policy, oauthAttemptId: randomUUID() },
  }, account.revision);
}

async function findConnectionAccount(
  configStore: ConfigStore,
  connectionAccountId: string,
): Promise<ConnectionAccount | undefined> {
  for (const installation of await configStore.listWorkspaceInstallations()) {
    const account = (await configStore.listConnectionAccounts(installation.workspaceId)).find(
      (candidate) => candidate.id === connectionAccountId,
    );
    if (account) return account;
  }
  return undefined;
}

function isApiOAuthAccount(
  account: ConnectionAccount,
  provider: ApiOAuthProvider,
): boolean {
  return account.policy.kind === 'api' &&
    account.policy.authMode === 'oauth' &&
    account.policy.oauthProvider === provider &&
    Array.isArray(account.policy.oauthScopes) &&
    account.policy.oauthScopes.length > 0;
}

function isMcpOAuthAccount(account: ConnectionAccount, serverUrl?: string): boolean {
  if (account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth') return false;
  if (!serverUrl) return true;
  const validated = validateMcpUrl(account.policy.url);
  return validated.ok && validated.url === serverUrl;
}

async function normalizeApiOAuthPatch(
  agentId: string,
  currentConnections: readonly CustomAgentConfig['apiConnections'][number][],
  nextConnections: readonly CustomAgentConfig['apiConnections'][number][],
  settingsStore: SettingsStore,
): Promise<CustomAgentConfig['apiConnections']> {
  const currentById = new Map(currentConnections.map((connection) => [connection.id, connection]));
  const nextById = new Map(nextConnections.map((connection) => [connection.id, connection]));
  await Promise.all(currentConnections.map(async (current) => {
    if (current.authMode !== 'oauth' || current.oauthProvider !== 'google') return;
    const next = nextById.get(current.id);
    if (next?.authMode === 'oauth' && next.oauthProvider === current.oauthProvider) return;
    await deleteApiOAuthSettings(
      { agentId, connectionId: current.id },
      settingsStore,
    );
  }));
  return Promise.all(nextConnections.map(async (connection) => {
    if (connection.authMode !== 'oauth' || connection.oauthProvider !== 'google') {
      return connection;
    }
    const current = currentById.get(connection.id);
    const sameAuthorization = current?.authMode === 'oauth' &&
      current.oauthProvider === connection.oauthProvider &&
      sameStringSet(current.oauthScopes ?? [], connection.oauthScopes ?? []);
    const ref = { agentId, connectionId: connection.id };
    if (!sameAuthorization) {
      await invalidateApiOAuthAuthorization(ref, settingsStore);
    }
    const sources = await describeApiOAuthSources(ref, settingsStore);
    if (sameAuthorization && sources.tokens === 'stored') {
      return {
        ...connection,
        lifecycleStatus: 'ready' as const,
        statusText: current.statusText || 'Connected',
        ...(current.identity ? { identity: current.identity } : {}),
      };
    }
    const { identity: _identity, ...withoutIdentity } = connection;
    return {
      ...withoutIdentity,
      lifecycleStatus: 'pending' as const,
      statusText: 'Not connected',
    };
  }));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

interface VerifyMcpOAuthConnectionInput {
  ref: { agentId: string; connectionId: string };
  configStore: ConfigStore;
  platformEnv?: PlatformEnv;
  discoverMcp: (input: McpConnectInput) => Promise<McpDiscoveryResult>;
  identifyMcp: (input: McpIdentityInput) => Promise<McpConnectionIdentity | undefined>;
  resolveMcpOAuthToken: (
    input: ResolveMcpOAuthAccessInput,
    dependencies: McpOAuthDependencies,
  ) => Promise<string>;
  oauthDependencies: McpOAuthDependencies;
  accountRevision?: number;
  oauthAttemptId?: string;
}

async function verifyAndStoreMcpOAuthConnection(
  input: VerifyMcpOAuthConnectionInput,
): Promise<void> {
  const connectionAccountId = connectionAccountIdFromOAuthRef(input.ref);
  let connection: McpConnectionConfig | undefined;
  if (connectionAccountId) {
    const account = await findConnectionAccount(input.configStore, connectionAccountId);
    if (account?.policy.kind === 'mcp' && account.policy.authMode === 'oauth') {
      connection = {
        id: account.id,
        displayName: account.label,
        url: account.policy.url,
        transport: account.policy.transport,
        authMode: 'oauth',
        headerNames: [...account.policy.headerNames],
        enabled: true,
        lifecycleStatus: 'pending',
        statusText: '',
        discoveredTools: [...account.policy.discoveredTools],
        allowedTools: [...account.policy.allowedTools],
        ...(account.policy.oauthScope ? { oauthScope: account.policy.oauthScope } : {}),
        ...(account.policy.presetId ? { presetId: account.policy.presetId } : {}),
      };
    }
  } else {
    const agent = await input.configStore.getAgent(input.ref.agentId);
    connection = agent.mcpServers.find(
      (entry) => entry.id === input.ref.connectionId,
    );
  }
  if (!connection || connection.authMode !== 'oauth') {
    throw new McpOAuthError('connection_missing', 'OAuth connection no longer exists');
  }
  const validated = validateMcpUrl(connection.url);
  if (!validated.ok) throw new McpBlockedUrlError(validated.reason);
  const accessToken = await input.resolveMcpOAuthToken(
    { ref: input.ref, serverUrl: validated.url },
    input.oauthDependencies,
  );
  const secrets = await resolveMcpSecrets(
    input.ref,
    connection.headerNames,
    input.platformEnv,
    input.oauthDependencies.settings,
  );
  secrets.bearer = accessToken;
  const headers = buildMcpRequestHeaders('oauth', secrets);

  try {
    const discovery = await input.discoverMcp({
      id: connection.id,
      url: validated.url,
      transport: connection.transport,
      headers,
    });
    let identity: McpConnectionIdentity | undefined;
    try {
      identity = await input.identifyMcp({
        id: connection.id,
        url: validated.url,
        transport: connection.transport,
        headers,
        ...(connection.presetId ? { presetId: connection.presetId } : {}),
      });
    } catch (error) {
      console.warn(
        `[chickpea] MCP identity probe failed (${connection.id}): ` +
          mcpDebugText(error),
      );
    }
    await replaceVerifiedMcpConnection(input.configStore, input.ref, connection, {
      lifecycleStatus: 'ready',
      statusText:
        `Connected · ${discovery.tools.length} tool` +
        (discovery.tools.length === 1 ? '' : 's'),
      discoveredTools: discovery.tools,
      lastCheckedAt: Date.now(),
      ...(identity ? { identity } : {}),
    }, input.accountRevision, input.oauthAttemptId);
  } catch (error) {
    await replaceVerifiedMcpConnection(input.configStore, input.ref, connection, {
      lifecycleStatus: 'failed',
      statusText: safeMcpFailureText(error),
      lastCheckedAt: Date.now(),
    }, input.accountRevision, input.oauthAttemptId).catch(() => undefined);
    throw error;
  }
}

function allowedToolsAfterMcpDiscovery(
  connection: Pick<McpConnectionConfig, 'allowedTools' | 'discoveredTools'>,
  discoveredTools: McpConnectionConfig['discoveredTools'],
): string[] {
  const previouslyAllowed = new Set(connection.allowedTools);
  if (connection.discoveredTools.length === 0) {
    return discoveredTools.map((tool) => tool.name);
  }
  return discoveredTools
    .map((tool) => tool.name)
    .filter((toolName) => previouslyAllowed.has(toolName));
}

type VerifiedMcpConnectionResult = Pick<
  McpConnectionConfig,
  'statusText' | 'lastCheckedAt'
> &
  (
    | {
        lifecycleStatus: 'ready';
        discoveredTools: McpConnectionConfig['discoveredTools'];
        identity?: McpConnectionIdentity;
      }
    | {
        lifecycleStatus: 'failed';
      }
  );

async function replaceVerifiedMcpConnection(
  configStore: ConfigStore,
  ref: { agentId: string; connectionId: string },
  original: McpConnectionConfig,
  result: VerifiedMcpConnectionResult,
  accountRevision?: number,
  oauthAttemptId?: string,
): Promise<void> {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (connectionAccountId) {
    const account = await findConnectionAccount(configStore, connectionAccountId);
    if (!account || account.lifecycle !== 'pending' ||
        (accountRevision !== undefined && account.revision !== accountRevision) ||
        (oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId) ||
        account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth' ||
        account.policy.url !== original.url) {
      if (account && (
        (accountRevision !== undefined && account.revision !== accountRevision) ||
        (oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId)
      )) {
        throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
      }
      throw new McpOAuthError('connection_missing', 'OAuth connection no longer exists');
    }
    const discoveredTools = result.lifecycleStatus === 'ready'
      ? result.discoveredTools
      : account.policy.discoveredTools;
    const allowedTools = result.lifecycleStatus === 'ready'
      ? allowedToolsAfterMcpDiscovery(account.policy, discoveredTools)
      : account.policy.allowedTools;
    await configStore.putConnectionAccount({
      ...account,
      lifecycle: result.lifecycleStatus === 'ready' ? 'ready' : 'needs_attention',
      policy: { ...account.policy, discoveredTools, allowedTools },
      ...(result.lifecycleStatus === 'ready' && result.identity
        ? { identity: result.identity }
        : {}),
    }, account.revision);
    return;
  }
  const latest = await configStore.getAgent(ref.agentId);
  const index = latest.mcpServers.findIndex(
    (entry) =>
      entry.id === ref.connectionId &&
      entry.authMode === 'oauth' &&
      entry.url === original.url,
  );
  if (index < 0) {
    throw new McpOAuthError('connection_missing', 'OAuth connection no longer exists');
  }
  const current = latest.mcpServers[index]!;
  const { identity: _priorIdentity, ...policy } = current;
  const discoveredTools =
    result.lifecycleStatus === 'ready'
      ? result.discoveredTools
      : current.discoveredTools;
  const allowedTools =
    result.lifecycleStatus === 'ready'
      ? allowedToolsAfterMcpDiscovery(current, discoveredTools)
      : current.allowedTools;
  const mcpServers = latest.mcpServers.slice();
  mcpServers[index] = { ...policy, ...result, discoveredTools, allowedTools };
  await configStore.updateAgent(ref.agentId, { mcpServers });
}

// The origin Slack must call back into, resolved fail-closed against header
// spoofing (the events URL this origin builds becomes a stored Slack config):
//   1. SLACK_TAG_PUBLIC_URL, when set, is the operator's explicit pin and wins
//      outright — no request header can override it.
//   2. On the Cloudflare target the edge terminates TLS and rewrites Host, so
//      the request URL / Host ARE the public origin; x-forwarded-* here is
//      caller-supplied and untrusted, so it is ignored entirely.
//   3. On Node behind a reverse proxy, honor x-forwarded-proto/host but take
//      the LAST comma-separated hop — the value the proxy nearest this app set
//      — not the first, which a client can forge by pre-seeding the header.
function requestOrigin(c: Context): string {
  const pinned = process.env.SLACK_TAG_PUBLIC_URL?.trim();
  if (pinned) {
    return pinned.replace(/\/+$/, '');
  }
  const url = new URL(c.req.url);
  if (isCloudflareTarget()) {
    return `${url.protocol.replace(/:$/, '')}://${c.req.header('host') || url.host}`;
  }
  const forwardedProto = lastForwardedHop(c.req.header('x-forwarded-proto'));
  const forwardedHost = lastForwardedHop(c.req.header('x-forwarded-host'));
  const proto = forwardedProto || url.protocol.replace(/:$/, '');
  const host = forwardedHost || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

async function restartCloudflareGatewaySession(rawEnv: unknown): Promise<void> {
  const env = (rawEnv ?? {}) as Record<string, unknown>;
  const namespace = env.SLACK_GATEWAY_SESSION as {
    idFromName(name: string): unknown;
    get(id: unknown): { restart(): Promise<void> };
  } | undefined;
  if (!namespace) return;
  await namespace.get(namespace.idFromName('deployment')).restart();
}

async function readGatewaySessionStatus(rawEnv: unknown): Promise<GatewaySessionStatusSnapshot> {
  const env = (rawEnv ?? {}) as Record<string, unknown>;
  const namespace = env.SLACK_GATEWAY_SESSION as {
    idFromName(name: string): unknown;
    get(id: unknown): { status(): Promise<GatewaySessionStatusSnapshot> };
  } | undefined;
  if (namespace) {
    try {
      const status = await namespace.get(namespace.idFromName('deployment')).status();
      if (typeof status?.healthy === 'boolean') {
        const currentVersion = cloudflareWorkerVersionId(rawEnv);
        if (currentVersion && status.versionId !== currentVersion) {
          return {
            healthy: false,
            phase: 'stale',
            detail: 'gateway_session_stale_version',
            generation: status.generation,
            versionId: status.versionId ?? null,
          };
        }
        return status;
      }
    } catch {
      // A missing or unreachable live-health RPC is itself an offline inbound
      // path. The outbound Slack diagnostic still runs and may provide a
      // narrower reconnect-required detail.
    }
  } else {
    const nodeStatus = nodeGatewaySessionStatus();
    if (nodeStatus) return nodeStatus;
  }
  return reconcileGatewaySessionStatus(undefined, undefined);
}

function authResponseHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https://*.slack-edge.com https://secure.gravatar.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

function isValidRecoveryConfiguration(token: string): boolean {
  try {
    decodeRecoverySecret(token);
    return true;
  } catch {
    return false;
  }
}

function validAuthFormPost(c: Context, expectedOrigin: string): boolean {
  return authFormPostFailureReason(c, expectedOrigin) === null;
}

function authFormPostFailureReason(c: Context, expectedOrigin: string): string | null {
  if (c.req.method !== 'POST') return 'method';
  const fetchSite = c.req.header('sec-fetch-site');
  let normalizedExpected: string;
  try {
    normalizedExpected = new URL(expectedOrigin).origin;
  } catch {
    return 'expected_origin';
  }
  const origin = c.req.header('origin');
  if (origin === 'null' && (
    isLoopbackHttpOrigin(normalizedExpected) || fetchSite === 'same-origin'
  )) {
    // Headless Chrome and embedded browsers can give their document an opaque
    // origin. On hosted HTTPS, accept that only when the browser-controlled
    // Fetch Metadata header still proves the navigation is same-origin. Local
    // loopback previews keep their existing capability-gated exception because
    // some embedded clients omit Fetch Metadata there.
  } else if (origin) {
    let normalizedActual: string;
    try {
      normalizedActual = new URL(origin).origin;
    } catch {
      return 'origin_invalid';
    }
    if (normalizedActual !== normalizedExpected) return 'origin_mismatch';
  } else if (fetchSite !== 'same-origin') {
    // Some embedded browsers omit Origin. Fetch Metadata is the remaining
    // browser-authenticated CSRF signal: only an exact same-origin navigation
    // is accepted. `same-site` is deliberately insufficient because a sibling
    // subdomain is not this Admin origin.
    return 'origin_missing';
  }
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site') return 'fetch_site';
  const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') return 'content_type';
  const length = Number(c.req.header('content-length') ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > MAX_AUTH_SETUP_BODY_BYTES) return 'content_length';
  return null;
}

function isLoopbackHttpOrigin(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function boundedSetupField(value: string | undefined, maximum: number): string {
  const normalized = value?.trim() ?? '';
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SlackAppCreationError('setup_invalid', 'Slack setup input is invalid.');
  }
  return normalized;
}

function slackInstallResultRedirect(result: SlackInstallOAuthResult): string {
  const query = new URLSearchParams({
    slack_install: result.status,
    destination: result.destination,
  });
  return `/admin/setup?${query.toString()}`;
}

function safeSlackInstallStatus(value: string | undefined): string | undefined {
  return value && [
    'approval_pending', 'denied', 'cancelled', 'expired', 'waiting_events', 'bot_installed',
  ].includes(value) ? value : undefined;
}

function slackInstallPublicError(error: unknown): string {
  return error instanceof SlackInstallOAuthError ? error.code : 'install_unavailable';
}

function slackInstallHttpStatus(error: unknown): 400 | 409 | 410 | 502 | 503 {
  if (!(error instanceof SlackInstallOAuthError)) return 400;
  if (error.code === 'expired_state') return 410;
  if (error.code === 'stale_revision') return 409;
  if (error.code === 'processing') return 409;
  if (error.code === 'slack_unreachable') return 503;
  if (['directory_unavailable', 'channel_unavailable'].includes(error.code)) return 502;
  return 400;
}

function clearSlackInstallBrowserCookie(c: Context): void {
  deleteCookie(c, SLACK_INSTALL_BROWSER_COOKIE, {
    path: '/auth/slack/install', secure: true, httpOnly: true, sameSite: 'Lax',
  });
}

function recoveryCookieOptions() {
  return {
    path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const,
    maxAge: 15 * 60,
  };
}

function clearSlackRecoveryCookies(c: Context): void {
  deleteCookie(c, SLACK_RECOVERY_SESSION_COOKIE, recoveryCookieOptions());
  deleteCookie(c, SLACK_RECOVERY_BROWSER_COOKIE, recoveryCookieOptions());
}

async function recoveryLimiterSuccess(
  limiter: AuthRateLimiter,
  source: string,
  action: string,
): Promise<void> {
  await Promise.all([
    limiter.recordSuccess('slack_recovery_source', source),
    limiter.recordSuccess('slack_recovery_deployment', 'deployment'),
    limiter.recordSuccess(`slack_recovery_${action}`, source),
  ]);
}

function slackRecoveryPublicMessage(error: unknown): string {
  if (!(error instanceof SlackCredentialRecoveryError)) {
    return 'Recovery could not continue. No active credential was changed.';
  }
  switch (error.code) {
    case 'app_mismatch': return 'These credentials belong to a different Slack app.';
    case 'workspace_mismatch': return 'This app grant belongs to a different Slack workspace.';
    case 'manifest_mismatch': return 'The Slack app contract differs beyond the permitted deployment URLs.';
    case 'missing_scopes': return 'Slack did not grant every required bot permission.';
    case 'slack_unreachable': return 'Slack is unavailable. The existing credential remains active; retry later.';
    case 'events_unverified': return 'The signed Slack Events challenge has not been verified yet.';
    case 'session_expired': return 'This 15-minute recovery session expired.';
    case 'session_consumed': return 'This recovery session was already consumed.';
    case 'grant_reused': return 'This one-time deployment recovery token was already used.';
    case 'parallel_recovery': return 'Another recovery session is already active.';
    default: return 'Recovery could not continue. No active credential was changed.';
  }
}

function slackRecoveryHttpStatus(error: unknown): 400 | 401 | 409 | 410 | 502 | 503 {
  if (!(error instanceof SlackCredentialRecoveryError)) return 400;
  if (['invalid_grant', 'invalid_session', 'wrong_browser'].includes(error.code)) return 401;
  if (['session_expired', 'session_consumed', 'grant_reused'].includes(error.code)) return 410;
  if (['parallel_recovery', 'processing', 'stale_revision'].includes(error.code)) return 409;
  if (error.code === 'slack_unreachable') return 503;
  if (error.code === 'events_unverified') return 502;
  return 400;
}

function encodeSlackOidcCookie(
  purpose: 'first_owner' | 'login' | 'invitation',
  browserBinding: string,
  nonce: string,
  destination: string,
): string {
  const safeDestination = purpose === 'login'
    ? safeSlackLoginDestination(destination)
    : safeSetupDestination(destination);
  return `${purpose}.${browserBinding}.${nonce}.${encodeURIComponent(safeDestination)}`;
}

function decodeSlackOidcCookie(value: string | undefined): {
  purpose: 'first_owner' | 'login' | 'invitation';
  browserBinding: string;
  nonce: string;
  destination: string;
} | undefined {
  if (!value || value.length > 1_500) return undefined;
  const [purpose, browserBinding, nonce, ...destinationParts] = value.split('.');
  if (destinationParts.length === 0 ||
      (purpose !== 'first_owner' && purpose !== 'login' && purpose !== 'invitation') ||
      !browserBinding || browserBinding.length < 32 || browserBinding.length > 512 ||
      !nonce || nonce.length < 32 || nonce.length > 512 ||
      /\s/.test(browserBinding) || /\s/.test(nonce)) return undefined;
  let destination: string;
  try {
    const decoded = decodeURIComponent(destinationParts.join('.'));
    destination = purpose === 'login'
      ? safeSlackLoginDestination(decoded)
      : safeSetupDestination(decoded);
  }
  catch { return undefined; }
  return { purpose, browserBinding, nonce, destination };
}

function clearSlackOidcBrowserCookie(c: Context): void {
  deleteCookie(c, SLACK_OIDC_BROWSER_COOKIE, {
    path: '/auth/slack/oidc', secure: true, httpOnly: true, sameSite: 'Lax',
  });
}

function slackOidcPublicError(error: unknown): string {
  return error instanceof SlackOidcError ? error.code : 'identity_unavailable';
}

function slackOidcHttpStatus(error: unknown): 400 | 403 | 409 | 410 | 503 {
  if (!(error instanceof SlackOidcError)) return 400;
  if (error.code === 'expired_state') return 410;
  if (error.code === 'invitation_unavailable') return 410;
  if (['processing', 'stale_revision'].includes(error.code)) return 409;
  if (error.code === 'slack_unreachable') return 503;
  if (error.code === 'session_unavailable') return 503;
  if (['inactive_user', 'user_mismatch', 'workspace_mismatch'].includes(error.code)) return 403;
  return 400;
}

function slackInvitationClientScript(): string {
  return `(function () {
  "use strict";
  var storageKey = "chickpea.slack-invitation.v1";
  var state = document.documentElement.getAttribute("data-invitation-state") || "";
  if (state === "complete") {
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    var destination = document.documentElement.getAttribute("data-destination") || "/admin";
    if (!/^\\/admin(?:\\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(destination)) destination = "/admin";
    location.replace(destination);
    return;
  }
  if (state === "unavailable") {
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    return;
  }
  if (state !== "ready") return;
  var locator = "";
  try {
    var fragment = new URLSearchParams(location.hash.slice(1));
    locator = fragment.get("invite") || "";
    if (locator) sessionStorage.setItem(storageKey, locator);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  } catch (_) {}
  if (!locator) {
    try { locator = sessionStorage.getItem(storageKey) || ""; } catch (_) {}
  }
  if (locator.length < 32 || locator.length > 512 || /\\s/.test(locator)) {
    locator = "";
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
  }
  var input = document.getElementById("invitation-locator");
  var submit = document.getElementById("invitation-submit");
  var status = document.getElementById("invitation-status");
  if (input) input.value = locator;
  if (submit) submit.disabled = !locator;
  if (status) status.textContent = locator
    ? "Invitation ready. Slack will verify the exact invited account."
    : "This invitation link is missing or no longer available.";
  locator = "";
})();`;
}

function authSourceKey(c: Context): string {
  return requestAuthSourceKey(c.req.raw);
}

async function readForm(c: Context): Promise<Record<string, string>> {
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_AUTH_SETUP_BODY_BYTES) return {};
  return Object.fromEntries(new URLSearchParams(raw));
}

// Per-isolate memo of the last origin we wrote to slack.publicUrl, so the
// opportunistic persist below is a no-op read/write on the steady state (every
// admin request would otherwise hit the settings store).
let lastPersistedPublicUrl: string | undefined;

/**
 * Persist the request origin as slack.publicUrl so the Slack reply footer /
 * onboarding "Configure" deep link works on a button deploy where
 * SLACK_TAG_PUBLIC_URL is never set. Best-effort and non-blocking to the
 * response: an env pin already wins at resolution time, and a settings write
 * failure must never break an admin request. Skips the write when the origin is
 * unchanged since this isolate last wrote it.
 */
async function persistRequestOrigin(c: Context, store: SettingsStore): Promise<void> {
  const origin = requestOrigin(c);
  if (!origin || origin === lastPersistedPublicUrl) {
    return;
  }
  try {
    await store.setSetting(SLACK_SETTING_KEYS.publicUrl, origin);
    primeStoredSlackPublicUrl(origin);
    lastPersistedPublicUrl = origin;
  } catch (err) {
    console.error(
      '[chickpea] failed to persist slack.publicUrl:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// The trusted hop of an X-Forwarded-* header is the LAST value: each proxy
// appends, so the rightmost entry is the one set by the proxy closest to this
// app. Taking the first would trust a value a client can pre-populate.
function lastForwardedHop(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const hops = header
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.length ? hops[hops.length - 1] : undefined;
}

/**
 * Slack's "create an app from a manifest" deep link. The committed manifest
 * carries the `https://<YOUR_PUBLIC_HOST>` placeholder in its URL fields;
 * substituting the real origin here (server-side, from the admin request)
 * removes the copy-the-events-URL step entirely. `$schema` is editor tooling,
 * not part of Slack's manifest schema — strip it from the deep link.
 */
function slackManifestUrl(requestUrl: string): string {
  // Preserve the local Node admin response shape even though Slack itself will
  // reject a non-HTTPS Request URL. Public installs take the validated builder
  // path below; the Admin UI already explains that setup needs its public URL.
  if (new URL(requestUrl).protocol !== 'https:') {
    const manifest = structuredClone(slackAppManifest);
    manifest.settings.event_subscriptions.request_url = requestUrl;
    return `https://api.slack.com/apps?new_app=1&manifest_json=${
      encodeURIComponent(JSON.stringify(manifest))
    }`;
  }
  const origin = new URL(requestUrl).origin;
  return slackManifestPrefillUrl(buildSlackAppManifest({
    kind: 'workspace_app',
    origin,
    appName: slackAppManifest.display_information.name,
    botDisplayName: slackAppManifest.features.bot_user.display_name,
  }));
}

// Any GET under /admin that is a PAGE navigation (the SPA serves every
// client-routed path), as opposed to an /admin/api/* call.
function isAdminPageGet(c: Context): boolean {
  if (c.req.method !== 'GET') return false;
  const pathname = c.req.path;
  return (
    pathname === '/admin' ||
    (pathname.startsWith('/admin/') && !pathname.startsWith('/admin/api/'))
  );
}

function permissionForAdminRequest(c: Context, _principal: AuthPrincipal): Permission {
  if (isAdminPageGet(c)) return 'agent.create';
  if (c.req.path === '/admin/logout') return 'account.view';
  if (c.req.method === 'GET' && c.req.path === '/admin/api/settings/connectors/composio') {
    return 'agent.create';
  }
  if (c.req.path === '/admin/team' ||
      (c.req.method === 'GET' && c.req.path === '/admin/api/team')) return 'team.view';
  if (c.req.path.startsWith('/admin/api/team/memberships')) return 'team.manage_members';
  if (c.req.path.startsWith('/admin/api/connections/')) return 'connection.create_team';
  if (
    c.req.path === '/admin/api/agents' ||
    c.req.path.startsWith('/admin/api/agents/') ||
    (c.req.method === 'GET' && [
      '/admin/api/models',
      '/admin/api/channels',
      '/admin/api/slack-connection',
      '/admin/api/slack-channels',
    ].includes(c.req.path))
  ) return 'agent.create';
  return 'admin.configure';
}

function machinePrincipalAllowed(c: Context): boolean {
  const path = c.req.path;
  return path.startsWith('/admin/api/') &&
    path !== '/admin/api/account' &&
    !path.startsWith('/admin/api/team');
}

function isHumanAuthFormMutation(c: Context): boolean {
  return c.req.method === 'POST' && c.req.path === '/admin/logout';
}

async function inspectionWithinSignal(
  signal: AbortSignal,
  inspect: () => Promise<'match' | 'missing' | 'mismatch' | 'transient'>,
): Promise<'match' | 'missing' | 'mismatch' | 'transient'> {
  if (signal.aborted) return 'transient';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: 'match' | 'missing' | 'mismatch' | 'transient') => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      reject(error);
    };
    const aborted = () => finish('transient');
    signal.addEventListener('abort', aborted, { once: true });
    inspect().then(finish, fail);
  });
}

async function managedProviderImpact(
  config: ConfigStore,
  adapterId: string,
): Promise<{ accounts: number; schedules: number }> {
  const normalizedAdapterId = adapterId.trim().toLowerCase();
  const accountIds = new Set<string>();
  for (const installation of await config.listWorkspaceInstallations()) {
    for (const account of await config.listConnectionAccounts(installation.workspaceId)) {
      if (account.lifecycle !== 'revoked' && account.policy.kind === 'managed' &&
          account.policy.adapterId.trim().toLowerCase() === normalizedAdapterId) {
        accountIds.add(account.id);
      }
    }
  }
  let schedules = 0;
  if (accountIds.size > 0) {
    for (const agent of await config.listAgents()) {
      for (const reference of await config.listAgentScheduleReferences(agent.id)) {
        if (reference.destinationKind !== 'direct_thread' &&
            reference.requiredConnectionAccountIds.some((id) => accountIds.has(id))) {
          schedules += 1;
        }
      }
    }
  }
  return { accounts: accountIds.size, schedules };
}

function betterAuthJsonRequest(
  source: Request,
  baseURL: string,
  path: string,
  body: Record<string, unknown>,
): Request {
  const encoded = JSON.stringify(body);
  const headers = new Headers(source.headers);
  headers.set('origin', baseURL);
  headers.set('content-type', 'application/json');
  headers.set('content-length', String(new TextEncoder().encode(encoded).byteLength));
  headers.set('sec-fetch-site', 'same-origin');
  return new Request(`${baseURL}${path}`, { method: 'POST', headers, body: encoded });
}

function clearBetterAuthCookies(c: Context): void {
  for (const name of ['__Secure-better-auth.session_token', 'better-auth.session_token']) {
    deleteCookie(c, name, { path: '/', secure: name.startsWith('__Secure-') });
  }
}

function safeAdminReturnPath(candidate: string | null | undefined): string {
  if (!candidate) return '/admin';
  try {
    const parsed = new URL(candidate, 'https://chickpea.invalid');
    if (
      parsed.origin !== 'https://chickpea.invalid' ||
      parsed.pathname !== candidate ||
      parsed.pathname === '/admin/login' ||
      parsed.pathname === '/admin/api' ||
      parsed.pathname.startsWith('/admin/api/') ||
      !(parsed.pathname === '/admin' || parsed.pathname.startsWith('/admin/'))
    ) {
      return '/admin';
    }
    return parsed.pathname;
  } catch {
    return '/admin';
  }
}

function toAgentConfig(input: v.InferOutput<typeof agentSchema>): AgentCreateInput {
  return {
    id: input.id,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.editPolicy !== undefined ? { editPolicy: input.editPolicy } : {}),
    instructions: input.instructions,
    enabled: input.enabled,
    ...(input.model !== undefined ? { model: input.model } : {}),
    skills: toSkills(input.skills),
    mcpServers: toMcpServers(input.mcpServers),
    apiConnections: toApiConnections(input.apiConnections),
    repositories: toRepositories(input.repositories),
  };
}

function toSkills(
  skills: v.InferOutput<typeof skillsSchema>,
): CustomAgentConfig['skills'] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    enabled: skill.enabled,
    ...(skill.suggestedSkillId !== undefined ? { suggestedSkillId: skill.suggestedSkillId } : {}),
  }));
}

// Valibot's `v.optional(...)` infers `key?: T | undefined`, which is not
// assignable to the exact-optional (`key?: T`) fields on McpConnectionConfig
// under `exactOptionalPropertyTypes`. Rebuild each server with conditional
// spreads so an absent optional stays absent (never `undefined`).
function toMcpServers(
  servers: v.InferOutput<typeof mcpServersSchema>,
): CustomAgentConfig['mcpServers'] {
  return servers.map((server) => ({
    id: server.id,
    displayName: server.displayName,
    url: server.url,
    transport: server.transport,
    authMode: server.authMode,
    headerNames: server.headerNames,
    enabled: server.enabled,
    lifecycleStatus: server.lifecycleStatus,
    statusText: server.statusText,
    discoveredTools: server.discoveredTools.map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
    })),
    allowedTools: server.allowedTools,
    ...(server.oauthScope !== undefined ? { oauthScope: server.oauthScope } : {}),
    ...(server.lastCheckedAt !== undefined ? { lastCheckedAt: server.lastCheckedAt } : {}),
    ...(server.identity !== undefined
      ? {
          identity: {
            ...(server.identity.workspaceName !== undefined
              ? { workspaceName: server.identity.workspaceName }
              : {}),
            ...(server.identity.accountName !== undefined
              ? { accountName: server.identity.accountName }
              : {}),
          },
        }
      : {}),
    ...(server.presetId !== undefined ? { presetId: server.presetId } : {}),
  }));
}

// Credentials are write-only, so the admin UI cannot see the value — but it must
// know whether one exists. Resolve each connection's real source (stored / env /
// missing) so the editor shows the truth instead of assuming a persisted policy
// carries a usable credential (turn-time resolution silently skips a connection
// whose credential is absent).
async function withApiConnectionSources(
  agent: CustomAgentConfig,
  platformEnv: PlatformEnv | undefined,
  settingsStore: SettingsStore,
): Promise<CustomAgentConfig> {
  if (agent.apiConnections.length === 0) return agent;
  const apiConnections = await Promise.all(
    agent.apiConnections.map(async (connection) => {
      if (connection.authMode === 'oauth') {
        const sources = await describeApiOAuthSources(
          { agentId: agent.id, connectionId: connection.id },
          settingsStore,
        );
        return {
          ...connection,
          credentialSource: 'missing' as const,
          oauthClientSource: sources.client,
          oauthTokenSource: sources.tokens,
        };
      }
      return {
        ...connection,
        credentialSource: await describeConnectorCredentialSource(
          agent.id,
          connection.id,
          platformEnv,
          settingsStore,
        ),
      };
    }),
  );
  return { ...agent, apiConnections };
}

function toApiConnections(
  connections: v.InferOutput<typeof apiConnectionsSchema>,
): CustomAgentConfig['apiConnections'] {
  return connections.map((connection) => ({
    id: connection.id,
    displayName: connection.displayName,
    allowedHosts: connection.allowedHosts,
    pathPrefixes: connection.pathPrefixes,
    headerName: connection.headerName,
    ...(connection.headerValuePrefix !== undefined
      ? { headerValuePrefix: connection.headerValuePrefix }
      : {}),
    allowedMethods: connection.allowedMethods,
    enabled: connection.enabled,
    ...(connection.authMode !== undefined ? { authMode: connection.authMode } : {}),
    ...(connection.oauthProvider !== undefined ? { oauthProvider: connection.oauthProvider } : {}),
    ...(connection.oauthScopes !== undefined ? { oauthScopes: connection.oauthScopes } : {}),
    ...(connection.oauthAppType !== undefined ? { oauthAppType: connection.oauthAppType } : {}),
    ...(connection.lifecycleStatus !== undefined ? { lifecycleStatus: connection.lifecycleStatus } : {}),
    ...(connection.statusText !== undefined ? { statusText: connection.statusText } : {}),
    ...(connection.identity !== undefined
      ? {
          identity: {
            ...(connection.identity.workspaceName !== undefined
              ? { workspaceName: connection.identity.workspaceName }
              : {}),
            ...(connection.identity.accountName !== undefined
              ? { accountName: connection.identity.accountName }
              : {}),
          },
        }
      : {}),
    ...(connection.presetId !== undefined ? { presetId: connection.presetId } : {}),
  }));
}

function toRepositories(
  repositories: v.InferOutput<typeof repositoriesSchema>,
): CustomAgentConfig['repositories'] {
  return repositories.map((repository) => ({
    id: repository.id,
    installationId: repository.installationId,
    accountLogin: repository.accountLogin,
    fullName: repository.fullName,
    ...(repository.allRepos !== undefined ? { allRepos: repository.allRepos } : {}),
    enabled: repository.enabled,
  }));
}

type AgentPatch = Partial<Omit<CustomAgentConfig, 'id' | 'revision' | 'model'>> & {
  model?: string | null;
};

function toAgentPatch(input: v.InferOutput<typeof agentPatchSchema>): AgentPatch {
  const patch: AgentPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.editPolicy !== undefined) patch.editPolicy = input.editPolicy;
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.model !== undefined) patch.model = input.model;
  if (input.skills !== undefined) patch.skills = toSkills(input.skills);
  if (input.mcpServers !== undefined) patch.mcpServers = toMcpServers(input.mcpServers);
  if (input.apiConnections !== undefined) {
    patch.apiConnections = toApiConnections(input.apiConnections);
  }
  if (input.repositories !== undefined) {
    patch.repositories = toRepositories(input.repositories);
  }
  return patch;
}

// Team-identity resolution that never throws: a backfill auth.test that cannot
// reach Slack must not fail the whole assignment PUT / channels GET — the caller
// treats an empty result as "team unknown, skip the workspace check".
async function resolveTeamInfoSafely(
  env: PlatformEnv | undefined,
  store: SettingsStore,
  credentialDependencies?: SlackCredentialResolutionDependencies,
): Promise<SlackTeamInfo> {
  try {
    return await resolveSlackTeamInfo(env, store, credentialDependencies);
  } catch {
    return { teamId: undefined, teamName: undefined };
  }
}

function modelResolutionError(agent: ModelResolvableAgent): ModelResolutionError | undefined {
  try {
    resolveAgentModel(agent);
    return undefined;
  } catch (err) {
    if (err instanceof ModelResolutionError) {
      return err;
    }
    throw err;
  }
}

async function configuredModelResolutionError(
  configStore: ConfigStore,
  agent: ModelResolvableAgent & Pick<CustomAgentConfig, 'kind'>,
): Promise<ModelResolutionError | undefined> {
  const installations = await configStore.listWorkspaceInstallations();
  const installation = installations.length === 1 ? installations[0] : undefined;
  if (!installation || installation.runtimeContract === 'legacy') {
    return modelResolutionError(agent);
  }
  const workspaceDefault = await configStore.getWorkspaceModelDefault(installation.workspaceId);
  try {
    resolveAgentModelPolicy({
      agent,
      runtimeContract: installation.runtimeContract,
      ...(workspaceDefault ? { workspaceDefault } : {}),
    });
    return undefined;
  } catch (error) {
    if (error instanceof ModelResolutionError) return error;
    throw error;
  }
}

function modelNotResolvable(
  c: { json(body: { error: string; message: string }, status: 422): Response },
  err: ModelResolutionError,
): Response {
  return c.json({ error: 'model_not_resolvable', message: err.message }, 422);
}

async function modelDefaultInstallation(
  configStore: ConfigStore,
): Promise<WorkspaceInstallation | undefined> {
  const installations = await configStore.listWorkspaceInstallations();
  return installations.length === 1 ? installations[0] : undefined;
}

function cutoverEnvironmentModel(platformEnv: PlatformEnv | undefined): string | undefined {
  const platformValue = (platformEnv as unknown as Record<string, unknown> | undefined)
    ?.SLACK_TAG_MODEL;
  const raw = typeof platformValue === 'string' ? platformValue : process.env.SLACK_TAG_MODEL;
  const model = raw?.trim();
  return model && /^[^/]+\/.+$/.test(model) ? model : undefined;
}

interface WorkspaceModelDefaultProjection {
  workspaceId: string;
  modelId: string | null;
  revision: number;
  provenance: WorkspaceModelDefault['provenance'];
  runtimeContract: WorkspaceInstallation['runtimeContract'];
  live: boolean;
  inheritingAgentCount: number;
  health: {
    status: 'ready' | 'selection_required' | 'repair_required';
    providerId: string | null;
    code?: 'workspace_default_missing' | 'model_unsupported' | 'provider_unavailable';
    repairPath?: '/admin/settings/providers';
  };
}

async function workspaceModelDefaultProjection(input: {
  installation: WorkspaceInstallation;
  configStore: ConfigStore;
  settingsStore: SettingsStore;
  platformEnv: PlatformEnv | undefined;
  runtimeProviders: RuntimeModelProvider[];
}): Promise<WorkspaceModelDefaultProjection> {
  const [workspaceDefault, agents, openAiAuthMethod, workersAiEnabled] = await Promise.all([
    input.configStore.getWorkspaceModelDefault(input.installation.workspaceId),
    input.configStore.listUserAgents(),
    resolveOpenAiAuthMethod(input.settingsStore),
    getWorkersAiEnabled(input.settingsStore),
  ]);
  const modelId = workspaceDefault?.modelId ?? null;
  const separator = modelId?.indexOf('/') ?? -1;
  const providerId = modelId && separator > 0 ? modelId.slice(0, separator) : null;
  let health: WorkspaceModelDefaultProjection['health'];
  if (!workspaceDefault || !modelId) {
    health = {
      status: 'selection_required',
      providerId: null,
      code: 'workspace_default_missing',
      repairPath: '/admin/settings/providers',
    };
  } else if (!providerId || activeCatalogCompatibilityError(modelId, openAiAuthMethod)) {
    health = {
      status: 'repair_required',
      providerId,
      code: 'model_unsupported',
      repairPath: '/admin/settings/providers',
    };
  } else {
    const provider = input.runtimeProviders.find(({ id }) => id === providerId);
    const workersAiReady = providerId !== 'cloudflare' ||
      (workersAiEnabled && workersAiStatus(input.platformEnv) !== 'missing');
    health = provider?.configured && workersAiReady
      ? { status: 'ready', providerId }
      : {
          status: 'repair_required',
          providerId,
          code: 'provider_unavailable',
          repairPath: '/admin/settings/providers',
        };
  }
  return {
    workspaceId: input.installation.workspaceId,
    modelId,
    revision: workspaceDefault?.revision ?? 0,
    provenance: workspaceDefault?.provenance ?? 'migration_pending',
    runtimeContract: input.installation.runtimeContract,
    live: input.installation.runtimeContract === 'chickpea-v1',
    inheritingAgentCount: agents.filter((agent) =>
      agent.kind === 'user' &&
      agent.lifecycle === 'active' &&
      agent.enabled &&
      !agent.model
    ).length,
    health,
  };
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function channelKey(c: { req: { query(name: string): string | undefined } }):
  | { workspaceId: string; channelId: string }
  | undefined {
  const workspaceId = c.req.query('workspaceId');
  const channelId = c.req.query('channelId');
  if (!workspaceId || !channelId) {
    return undefined;
  }
  return { workspaceId, channelId };
}

function githubApiConnectionValidationMessage(
  issues: readonly { message: string }[],
): string | undefined {
  return issues.some((issue) => issue.message === GITHUB_API_CONNECTION_ERROR)
    ? GITHUB_API_CONNECTION_ERROR
    : undefined;
}

function invalidRequest(
  c: { json(body: { error: string; message?: string }, status: 400): Response },
  message?: string,
): Response {
  return c.json(
    message
      ? { error: 'invalid_request', message }
      : { error: 'invalid_request' },
    400,
  );
}

function openAiSubscriptionRouteError(c: Context, error: unknown): Response {
  if (!(error instanceof OpenAiSubscriptionError)) return internalError(c, error);
  const body = {
    error: error.code,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
  switch (error.code) {
    case 'attempt_forbidden':
      return c.json(body, 403);
    case 'authorization_expired':
      return c.json(body, 410);
    case 'authorization_rate_limited':
      return c.json(body, 429);
    case 'authorization_missing':
    case 'authorization_pending':
    case 'account_change_confirmation_required':
    case 'auth_reconnect_required':
      return c.json(body, 409);
    case 'unsupported_model':
      return c.json(body, 422);
    default:
      return c.json(body, 502);
  }
}

// Free text accepts any provider/model specifier (locked model-picker
// decision: warn, never block — the registry approximates Flue/Pi's real
// provider surface, so an unknown prefix may still work at runtime). A warning
// on the success body keeps the pre-check honest without false blocking. An
// empty registry means "unknown environment" (route module used without
// src/app.ts registrations, e.g. unit tests) — no warning either way.
function providerWarnings(
  model: string | null | undefined,
  known: ReadonlySet<string>,
): { warnings?: Array<{ code: string; provider: string; knownProviders: string[] }> } {
  if (!model || known.size === 0) return {};
  const prefix = model.slice(0, model.indexOf('/'));
  if (known.has(prefix)) return {};
  return {
    warnings: [{ code: 'unknown_provider', provider: prefix, knownProviders: [...known].sort() }],
  };
}

function activeCatalogCompatibilityError(
  model: string | null | undefined,
  method: 'api_key' | 'subscription',
): string | undefined {
  if (!model) return undefined;
  if (model.startsWith('openai/')) {
    const lane = method === 'subscription' ? 'openai_subscription' : 'openai_api_key';
    if (resolveActiveCatalogRoute(model, lane)) return undefined;
    return method === 'subscription'
      ? 'The selected ChatGPT subscription does not support this OpenAI model.'
      : 'The active OpenAI API-key catalog does not support this model.';
  }
  if (model.startsWith('anthropic/') &&
      !resolveActiveCatalogRoute(model, 'anthropic_api_key')) {
    return 'The active Anthropic API-key catalog does not support this model.';
  }
  return undefined;
}

function activeCatalogModels(
  lane: 'anthropic_api_key' | 'openai_api_key' | 'openai_subscription',
): Array<{
  canonical: string;
  id: string;
  name?: string;
}> {
  return activeModelCatalogSnapshot().entries.flatMap((entry) => {
    const provider = lane === 'anthropic_api_key' ? 'anthropic' : 'openai';
    if (!entry.lanes[lane] || !entry.id.startsWith(`${provider}/`)) return [];
    return [{
      canonical: entry.id,
      id: entry.id.slice(provider.length + 1),
      ...(entry.displayName ? { name: entry.displayName } : {}),
    }];
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function safeModelCatalogStatus(settingsStore: SettingsStore): Promise<{
  mode: 'bundled' | 'hosted';
  source: 'bundled' | 'hosted';
  revision: number;
  generatedAt: string | null;
  checkedAt: number | null;
  nextRefreshAt: number | null;
  lkgAvailable: boolean;
}> {
  const mode = await readModelCatalogMode(settingsStore);
  const active = activeModelCatalogSnapshot();
  try {
    const lkg = await readModelCatalogLkg(settingsStore);
    return {
      mode,
      source: active.source,
      revision: active.revision,
      generatedAt: lkg?.document.generatedAt ?? null,
      checkedAt: lkg?.checkedAt ?? null,
      nextRefreshAt: lkg?.nextRefreshAt ?? null,
      lkgAvailable: lkg !== undefined,
    };
  } catch {
    return {
      mode,
      source: active.source,
      revision: active.revision,
      generatedAt: null,
      checkedAt: null,
      nextRefreshAt: null,
      lkgAvailable: false,
    };
  }
}

interface ProviderSummary {
  id: AdminProviderId;
  status: ProviderKeySource;
  modelCount: number | null;
}

function providerSummary(id: AdminProviderId, status: ProviderKeySource): ProviderSummary {
  return {
    id,
    status,
    modelCount: cachedProviderModelCount(id) ?? null,
  };
}

function workersAiStatus(env: PlatformEnv | undefined): ProviderKeySource {
  if (hasWorkersAiBinding(env)) {
    return 'env';
  }
  return process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID ? 'env' : 'missing';
}

function hasWorkersAiBinding(env: PlatformEnv | undefined): boolean {
  const ai = env?.AI;
  return Boolean(ai && typeof ai === 'object' && typeof (ai as { models?: unknown }).models === 'function');
}

function copyAuthResponseCookies(c: Context, headers: Headers | undefined): void {
  if (!headers) return;
  for (const cookie of setCookieValues(headers)) c.header('Set-Cookie', cookie, { append: true });
}

function providerApiKeyFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const value = record.apiKey ?? record.key;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function providerFavoritesFromBody(body: unknown): string[] | undefined {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).favorites)
      ? ((body as Record<string, unknown>).favorites as unknown[])
      : undefined;
  if (!raw) {
    return undefined;
  }
  const favorites = raw.filter((value): value is string => typeof value === 'string');
  return favorites.length === raw.length ? favorites : undefined;
}

function egressDomainUrl(domain: string): string {
  const withoutScheme = domain.replace(/^[a-z][a-z\d+.-]*:\/\//i, '');
  return `https://${withoutScheme}`;
}

// An egress allow-list entry must resolve to a bare host: the stored policy only
// keeps the hostname, so any path/port/query/fragment/userinfo the operator
// typed would be silently dropped and broaden access to the whole origin.
function isBareEgressHost(domain: string): boolean {
  let url: URL;
  try {
    url = new URL(egressDomainUrl(domain));
  } catch {
    return false; // the validateMcpUrl check reports the invalid-host case
  }
  return (
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}

function normalizeEgressDomain(domain: string): string {
  const result = validateMcpUrl(egressDomainUrl(domain));
  if (!result.ok) {
    // The schema runs the same guard first, so reaching this branch would mean
    // validation behavior changed between parsing and normalization.
    throw new Error('Validated egress domain became invalid');
  }
  return new URL(result.url).hostname.toLowerCase();
}

async function providerRemovalImpact(
  configStore: ConfigStore,
  provider: string,
): Promise<{
  pinnedAgentCount: number;
  workspaceDefaultAffected: boolean;
  inheritingAgentCount: number;
}> {
  const impact = await resolveProviderRuntimeImpact(configStore, provider);
  return {
    pinnedAgentCount: impact.pinnedAgents.length,
    workspaceDefaultAffected: impact.workspaceDefaultAffected,
    inheritingAgentCount: impact.activeInheritingAgentCount,
  };
}

// Never echo internal error text (raw SQLite messages) to API clients; log it
// server-side and return a stable retriable status instead.
function internalError(
  c: { json(body: { error: string }, status: 500): Response },
  err: unknown,
): Response {
  console.error('[chickpea] admin API failure:', err instanceof Error ? err.message : String(err));
  return c.json({ error: 'internal_error' }, 500);
}

function agentReferenceCount(references: AgentReferenceSummary): number {
  return references.channelGrants.length;
}

function agentScheduleStatus(
  authorityState: AgentScheduleState,
  routineState: RoutineDefinition['state'],
): 'active' | 'paused' | 'needs_attention' | 'completed' {
  if (authorityState === 'needs_attention') return 'needs_attention';
  if (routineState === 'paused' || authorityState === 'paused') return 'paused';
  if (routineState === 'active') return 'active';
  return 'completed';
}

function agentScheduleActions(
  readable: boolean,
  authorityState: AgentScheduleState,
  routineState: RoutineDefinition['state'],
): { pause: boolean; resume: boolean; delete: boolean } {
  return {
    pause: readable && authorityState === 'active' && routineState === 'active',
    resume: readable && authorityState === 'active' && routineState === 'paused',
    delete: readable,
  };
}

function agentStillReferenced(c: Context, error: AgentStillReferencedError): Response {
  return c.json({
    error: 'agent_still_referenced',
    references: error.references.split(', ').filter(Boolean),
  }, 409);
}

/**
 * The origin an MCP connection's stored secrets were saved against. Returns
 * undefined when the agent or connection does not exist, so callers fail closed
 * and send no stored credential.
 */
async function savedMcpConnectionOrigin(
  configStore: Pick<ConfigStore, 'getAgent'>,
  agentId: string,
  connectionId: string,
): Promise<string | undefined> {
  try {
    const connection = (await configStore.getAgent(agentId)).mcpServers.find(
      (server) => server.id === connectionId,
    );
    return connection ? safeUrlOrigin(connection.url) : undefined;
  } catch (error) {
    if (error instanceof UnknownAgentError) return undefined;
    throw error;
  }
}

/**
 * Stored MCP secrets are keyed by connection id, not by URL, so repointing a
 * connection at a new origin would otherwise carry the old origin's credential
 * to the new one on the next turn. Drop the secrets whenever an existing
 * connection's origin changes; the operator re-enters them for the new target.
 */
function agentDeleteIdempotencyKey(c: Context, agentId: string): string {
  const supplied = c.req.header('idempotency-key')?.trim();
  return supplied && /^[A-Za-z0-9_.:-]{1,512}$/.test(supplied)
    ? supplied
    : `admin:agent-delete:${agentId}:${randomUUID()}`;
}

async function agentAdminProjection(
  agent: CustomAgentConfig,
  configStore: ConfigStore,
  snapshotStore: AgentSnapshotStore,
  preloaded?: {
    references: AgentReferenceSummary;
    grants: AgentChannelGrant[];
    installations: WorkspaceInstallation[];
    snapshotRoots: Awaited<ReturnType<AgentSnapshotStore['listLiveRootsByAgent']>>;
  },
  access: {
    canEdit: boolean;
    privateUseAudience?: PrivateAgentAudience;
  } = { canEdit: true },
): Promise<object> {
  const projectionData = preloaded ?? await (async () => {
    const [references, grants, installations, snapshotRoots] = await Promise.all([
      configStore.getAgentReferences(agent.id),
      configStore.listAgentChannelGrants(),
      configStore.listWorkspaceInstallations(),
      snapshotStore.listLiveRootsByAgent(agent.id),
    ]);
    return {
      references,
      grants: grants.filter((grant) => grant.agentId === agent.id),
      installations,
      snapshotRoots,
    };
  })();
  const { references, grants, installations, snapshotRoots } = projectionData;
  const workspaceId = grants[0]?.workspaceId ?? installations[0]?.workspaceId;
  const installation = workspaceId
    ? installations.find((candidate) => candidate.workspaceId === workspaceId)
    : undefined;
  const workspaceDefault = workspaceId
    ? await configStore.getWorkspaceModelDefault(workspaceId)
    : undefined;
  const legacyDefaultInstallations = installations.filter(
    ({ defaultAgentId, runtimeContract }) =>
      runtimeContract === 'legacy' && defaultAgentId === agent.id,
  );
  return {
    ...agent,
    canEdit: access.canEdit,
    modelPolicy: {
      source: agent.model ? 'pinned' : 'workspace_default',
      effectiveModel: agent.model ?? workspaceDefault?.modelId ?? null,
      live: installation?.runtimeContract === 'chickpea-v1',
      ...(workspaceDefault ? { workspaceDefaultRevision: workspaceDefault.revision } : {}),
    },
    slackPresenceRecovery: agent.slackPresence?.health === 'needs_attention' &&
        agent.slackPresence.errorCode
      ? agentPresenceRecovery(
          {
            code: agent.slackPresence.errorCode as AgentPresenceError['code'],
            message: agent.slackPresence.errorDetail ?? 'Slack could not finish the change.',
          },
          agent.slackPresence.normalizedHandle,
        )
      : null,
    tabs: ['instructions', 'skills', 'connectors', 'repositories', 'memory', 'schedules', 'model'],
    capabilityPreviews: {
      skills: agent.skills.map(({ name, description, enabled }) => ({ name, description, enabled })),
      connectors: [
        ...agent.mcpServers.map(({ id, displayName, enabled, lifecycleStatus, presetId }) => ({
          id,
          name: displayName,
          kind: 'mcp',
          enabled,
          status: lifecycleStatus,
          ...(presetId ? { presetId } : {}),
        })),
        ...agent.apiConnections.map(({ id, displayName, enabled, lifecycleStatus, presetId }) => ({
          id,
          name: displayName,
          kind: 'api',
          enabled,
          status: lifecycleStatus ?? 'ready',
          ...(presetId ? { presetId } : {}),
        })),
      ],
      repositories: agent.repositories.map(({ id, fullName, accountLogin, enabled }) => ({
        id,
        name: fullName || accountLogin,
        enabled,
      })),
    },
    isWorkspaceDefault: legacyDefaultInstallations.length > 0,
    defaultForWorkspaces: legacyDefaultInstallations
      .map(({ workspaceId: installedWorkspaceId }) => installedWorkspaceId),
    whereItWorks: {
      ...(access.privateUseAudience
        ? { privateUseAudience: access.privateUseAudience }
        : {}),
      channels: grants.map((grant) => ({
        workspaceId: grant.workspaceId,
        channelId: grant.channelId,
        channelName: grant.channelLabel ?? grant.channelId,
        status: grant.status,
        channelIsPrivate: grant.channelIsPrivate ?? null,
        href: `/admin/channels/${encodeURIComponent(grant.workspaceId)}/${encodeURIComponent(grant.channelId)}`,
      })),
    },
    memoryOwner: workspaceId
      ? { ownerKind: 'agent', workspaceId, ownerId: agent.id }
      : null,
    deletion: {
      blocked: agentReferenceCount(references) > 0 || snapshotRoots.length > 0,
      references,
      liveSnapshotRoots: projectLiveSnapshotRoots(snapshotRoots),
    },
  };
}

function projectLiveSnapshotRoots(
  roots: Awaited<ReturnType<AgentSnapshotStore['listLiveRootsByAgent']>>,
): Array<object> {
  return roots.map((root) => {
    const { workspaceId, channelId, threadTs } = parseSlackThreadKey(root.threadKey);
    return {
      threadKey: root.threadKey,
      workspaceId,
      channelId,
      threadTs,
      lastActivityAt: root.lastActivityAt,
      channelHref: `/admin/channels/${encodeURIComponent(workspaceId)}/${encodeURIComponent(channelId)}`,
    };
  });
}

function effectiveConfigResponse(config: EffectiveSlackConfig): object {
  return {
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    agentId: config.agentId,
    agent: {
      id: config.agent.id,
      name: config.agent.name,
      enabled: config.agent.enabled,
      model: config.agent.model ?? null,
    },
    model: config.model,
    provider: config.provider,
    instructions: config.instructions,
    instructionLayers: config.instructionLayers,
    snapshotHash: computeSnapshotHash(config),
  };
}

function isAbortOrTimeoutError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError');
}
