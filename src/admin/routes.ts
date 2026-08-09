import { createHash, randomUUID } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';

import {
  renderAdminLogin,
  renderPasswordChangePage,
  renderPasswordLogin,
  renderPasswordOwnerSetupPage,
  renderPasswordRecoveryPage,
  renderAdminPage,
  renderAuthMigrationPage,
  renderAuthRecoveryPage,
  renderAuthSetupCompletePage,
  renderAuthSetupPage,
  renderMemberAccountPage,
  passwordFormClientScript,
} from './page.ts';
import { createMemoryAdminApi } from './memory-api.ts';
import { createRoutineAdminApi } from './routines-api.ts';
import { createUsageAdminApi } from './usage-api.ts';
import { createWorkAdminApi } from './work-api.ts';
import { createTeamAdminApi } from './team-api.ts';
import { passwordOwnerSetupClientScript } from '../auth/setup-handoff.ts';
import {
  invitationJoinClientScript,
  passwordInvitationClientScript,
  passwordResetClientScript,
  renderInvitationJoinPage,
  renderPasswordInvitationPage,
  renderPasswordResetPage,
} from '../join/page.ts';
// Build-time JSON import: the committed manifest is the single source of the
// Slack app identity; the wizard deep-link below substitutes the request host
// so users never hand-edit a request_url.
import slackAppManifest from '../../slack-app-manifest.json' with { type: 'json' };
import {
  apiOAuthSettingKeys,
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
  AgentSlackIdentityConflictError,
  AgentExistsError,
  AgentStillAssignedError,
  AgentStillSlackDmHandlerError,
  ModelResolutionError,
  NoAssignmentError,
  SlackIdentityExistsError,
  SlackIdentityLifecycleError,
  SlackIdentityRevisionConflictError,
  SlackIdentityStillReferencedError,
  UnknownAgentError,
  UnknownSlackIdentityError,
  WorkspaceDefaultSlackIdentityProtectedError,
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
import { discoverMcpTools, type McpConnectInput, type McpDiscoveryResult } from '../config/mcp-test.ts';
import { validateMcpUrl } from '../config/mcp-url.ts';
import { resolveAgentModel, type ModelResolvableAgent } from '../config/model-policy.ts';
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
  isAdminProviderId,
  isFavoriteProviderId,
  listProviderModels,
  primeProviderModelCache,
  ProviderKeyRejectedError,
  ProviderModelsUnavailableError,
  ProviderUnreachableError,
  putProviderFavorites,
  validateProviderApiKey,
  type AdminProviderId,
} from '../config/provider-models.ts';
import { knownProviderIds, listRuntimeModelProviders } from '../config/providers.ts';
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
  getConfigStore,
  getIdentityStore,
  getMemoryStateStore,
  getRoutineStore,
  getSettingsStore,
  getSlackStateStore,
  getUsageStore,
  getWorkStore,
  isCloudflareTarget,
  readRuntimeDrainStatus,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { RuntimeDrainStatus } from '../config/state-rpc.ts';
import { generateSlackIdentityIngressKey, type ConfigStore } from '../config/store.ts';
import type { MemoryStateStore } from '../memory/types.ts';
import type { RoutineStore } from '../routines/types.ts';
import type { UsageStore } from '../usage/types.ts';
import type { WorkStore } from '../work/types.ts';
import type {
  AuthProviderConfig,
  HumanIdentityDirectory,
  IdentityStore,
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
  ChannelAssignment,
  CustomAgentConfig,
  McpConnectionConfig,
  McpConnectionIdentity,
  SlackIdentity,
} from '../config/types.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import {
  envManagedSlackBehaviorKeys,
  resolveSlackBehaviorSettings,
  saveSlackBehaviorSettings,
  type SlackBehaviorPatch,
} from '../slack/behavior-settings.ts';
import { listSlackChannels, SlackChannelsError } from '../slack/channels.ts';
import {
  describeSlackCredentialSources,
  primeStoredSlackCredentials,
  readSlackConnectionRevision,
  readStoredSlackTeamInfo,
  resolveSlackCredentials,
  resolveSlackTeamInfo,
  primeStoredSlackPublicUrl,
  slackAuthTest,
  slackIdentityAuthTest,
  slackBotIdentityInfo,
  slackConversationsInfo,
  slackConversationsJoin,
  slackTokenFingerprint,
  SLACK_SETTING_KEYS,
  type SlackCredentialSources,
  type SlackTeamInfo,
} from '../slack/credentials.ts';
import {
  beginSlackIdentityConnection,
  cancelSlackIdentityConnection,
  completeSlackIdentityConnection,
  refreshSlackIdentityHealth,
  slackIdentityConsoleUrl,
  SlackIdentityBootstrapError,
  type SlackIdentityBootstrapDeps,
} from '../slack/identity-bootstrap.ts';
import {
  buildSlackIdentityManifest,
  slackManifestPrefillUrl,
} from '../slack/identity-manifest.ts';
import { missingRequiredSlackBotScopes } from '../slack/scopes.ts';
import {
  clearSlackIdentityCredentials,
  resolveSlackIdentityCredentials,
  SlackIdentityCredentialRevisionError,
} from '../slack/identity-credentials.ts';
import type { SlackIdentityAuditEventType } from '../audit/types.ts';
import { constantTimeEquals } from './constant-time.ts';
import { setCookieValues } from '../auth/cookies.ts';
import { AuthDeniedError, AuthService, setRequestPrincipal } from '../auth/service.ts';
import {
  BetterAuthDirectory,
  BetterAuthSessionAuthenticator,
} from '../auth/better-auth-principal.ts';
import {
  resolveBetterAuthBootstrapEnvironment,
  resolveBetterAuthEnvironment,
  type BetterAuthEnvironment,
} from '../auth/better-auth-environment.ts';
import { createBetterAuthEnvironmentPublicHandler } from '../auth/better-auth-runtime.ts';
import { createBetterAuth } from '../auth/better-auth.ts';
import { AuthorizationError, requirePermission, type Permission } from '../auth/permissions.ts';
import { validateMutationProvenance } from '../auth/request-provenance.ts';
import { CloudflareAccessAuthenticator, verifyCloudflareAccessRecoveryAssertion } from '../auth/cloudflare-access.ts';
import { AuthRateLimiter } from '../auth/rate-limit.ts';
import { requestAuthSourceKey } from '../auth/source-key.ts';
import { AuthRecoveryService, PasswordOwnerRecoveryService } from '../auth/recovery.ts';
import {
  AuthSetupService,
  PasswordOwnerSetupService,
  validRecoveryToken,
} from '../auth/setup.ts';
import { PasswordPolicyError, assertPasswordPolicy } from '../auth/password-policy.ts';
import {
  PasswordEnrollmentService,
  PasswordLifecycleError,
  PasswordTeamLifecycleService,
} from '../auth/password-team.ts';
import { digest, PersonalTokenService } from '../auth/personal-token.ts';
import { TokenSessionService } from '../auth/token-session.ts';
import type { AdminAuthenticationService, AuthPrincipal, ExternalIdentity } from '../auth/types.ts';

type AccessVerificationPurpose = 'activation' | 'recovery';
interface PasswordAuthContext {
  environment: BetterAuthEnvironment;
  directory: BetterAuthDirectory;
  organizationId: string;
}
type AccessAssertionVerifier = (
  request: Request,
  config: AuthProviderConfig,
  purpose: AccessVerificationPurpose,
) => Promise<ExternalIdentity>;

interface AdminRoutesOptions {
  // Injection seam for tests/harnesses: any async ConfigStore serves the
  // routes; absent, the platform backend is resolved per request (c.env is the
  // Cloudflare bindings object there; Node ignores it).
  store?: ConfigStore | undefined;
  // Same seam for the Slack-connection wizard's settings persistence.
  settings?: SettingsStore | undefined;
  memory?: MemoryStateStore | undefined;
  routines?: RoutineStore | undefined;
  usage?: UsageStore | undefined;
  work?: WorkStore | undefined;
  slackState?: SlackStateStore | undefined;
  runtimeDrain?: ((env?: PlatformEnv) => Promise<RuntimeDrainStatus>) | undefined;
  usageAdminUi?: boolean | undefined;
  adminToken?: string | undefined;
  authService?: AdminAuthenticationService | undefined;
  betterAuthEnvironment?: BetterAuthEnvironment | undefined;
  identity?: IdentityStore | undefined;
  recoveryToken?: string | undefined;
  authRateLimiter?: AuthRateLimiter | undefined;
  verifyAccessAssertion?: AccessAssertionVerifier | undefined;
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
  slackIdentityBootstrap?: SlackIdentityBootstrapDeps | undefined;
}

const ADMIN_COOKIE = 'flue_admin';
const AUTH_SESSION_COOKIE = 'chickpea_session';
const MAX_ADMIN_LOGIN_BODY_BYTES = 4_096;
const MAX_SLACK_IDENTITY_ADMIN_BODY_BYTES = 64 * 1_024;
const MAX_AUTH_SETUP_BODY_BYTES = 8_192;
const MAX_ADMIN_MUTATION_BODY_BYTES = 1024 * 1024;

const authSetupSchema = v.strictObject({
  ownerEmail: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  recoveryToken: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  issuer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_024)),
  audience: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_024)),
});
const passwordOwnerSetupSchema = v.strictObject({
  ownerEmail: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  organizationName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  recoveryToken: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
const passwordChangeSchema = v.strictObject({
  currentPassword: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  newPassword: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
const passwordRecoverySchema = v.strictObject({
  ownerEmail: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  newPassword: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  recoveryToken: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
const invitationJoinSchema = v.strictObject({
  invitationId: v.pipe(v.string(), v.regex(/^invitation_[A-Za-z0-9_-]{1,180}$/)),
  token: v.pipe(v.string(), v.minLength(32), v.maxLength(256), v.regex(/^[A-Za-z0-9_-]+$/)),
});
const passwordInvitationSchema = v.strictObject({
  operationId: v.pipe(v.string(), v.regex(/^auth_operation_[A-Za-z0-9_-]{1,220}$/)),
  token: v.pipe(v.string(), v.minLength(32), v.maxLength(256), v.regex(/^[A-Za-z0-9_-]+$/)),
  displayName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  password: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});
const passwordCapabilityInspectionSchema = v.strictObject({
  operationId: v.pipe(v.string(), v.regex(/^auth_operation_[A-Za-z0-9_-]{1,220}$/)),
  token: v.pipe(v.string(), v.minLength(32), v.maxLength(256), v.regex(/^[A-Za-z0-9_-]+$/)),
});
const passwordResetSchema = v.strictObject({
  operationId: v.pipe(v.string(), v.regex(/^auth_operation_[A-Za-z0-9_-]{1,220}$/)),
  token: v.pipe(v.string(), v.minLength(32), v.maxLength(256), v.regex(/^[A-Za-z0-9_-]+$/)),
  inspect: v.optional(v.literal(true)),
  newPassword: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});
const authRecoverySchema = v.strictObject({
  operation: v.picklist(['audience', 'owner_binding']),
  recoveryToken: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  audience: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_024))),
});

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const modelSpecifier = v.pipe(v.string(), v.regex(/^[^/]+\/.+$/));
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MCP_CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const agentIdSchema = v.pipe(v.string(), v.regex(AGENT_ID_PATTERN));
const openAiSubscriptionAttemptSchema = v.object({
  attemptCapability: v.pipe(v.string(), v.minLength(32), v.maxLength(512)),
});
const openAiSubscriptionStartSchema = v.object({});
const openAiAuthMethodSchema = v.object({
  method: v.picklist(['api_key', 'subscription']),
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
  instructions: nonEmptyString,
  enabled: v.boolean(),
  model: v.optional(modelSpecifier),
  skills: v.optional(skillsSchema, []),
  mcpServers: v.optional(mcpServersSchema, []),
  apiConnections: v.optional(apiConnectionsSchema, []),
  repositories: v.optional(repositoriesSchema, []),
});

const agentPatchSchema = v.partial(
  v.object({
    name: nonEmptyString,
    instructions: nonEmptyString,
    enabled: v.boolean(),
    model: v.nullable(modelSpecifier),
    skills: skillsSchema,
    mcpServers: mcpServersSchema,
    apiConnections: apiConnectionsSchema,
    repositories: repositoriesSchema,
  }),
);

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

const assignmentSchema = v.object({
  workspaceId: nonEmptyString,
  channelId: nonEmptyString,
  agentId: nonEmptyString,
  enabled: v.boolean(),
  channelLabel: v.optional(v.string()),
  channelPromptAddendum: v.optional(v.string()),
  participationMode: v.optional(v.picklist(['ambient', 'mention_only'])),
});

const slackConnectionSchema = v.object({
  botToken: nonEmptyString,
  signingSecret: nonEmptyString,
});

const slackIdentityRevisionSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const slackIdentityCreateSchema = v.strictObject({
  source: v.picklist(['profile', 'settings']),
  initialDmAgentId: agentIdSchema,
  appName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(35))),
  displayName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
});
const slackIdentitySetupIntentSchema = v.strictObject({
  expectedRevision: slackIdentityRevisionSchema,
  appName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(35)),
  displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
});
const slackIdentityConnectSchema = v.strictObject({
  expectedRevision: slackIdentityRevisionSchema,
  botToken: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8_192)),
  signingSecret: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8_192)),
});
const slackIdentityRevisionOnlySchema = v.strictObject({
  expectedRevision: slackIdentityRevisionSchema,
});
const slackIdentityVerifySchema = v.strictObject({
  expectedRevision: slackIdentityRevisionSchema,
  expectedProfileIdentityId: v.optional(v.nullable(v.pipe(v.string(), v.regex(AGENT_ID_PATTERN)))),
});
const slackIdentityDmSchema = v.strictObject({
  expectedRevision: slackIdentityRevisionSchema,
  dmState: v.picklist(['on', 'off', 'needs_setup']),
  dmAgentId: v.optional(agentIdSchema),
});
const slackIdentityAttachProfileSchema = v.strictObject({
  expectedRevision: slackIdentityRevisionSchema,
  expectedProfileIdentityId: v.nullable(v.pipe(v.string(), v.regex(AGENT_ID_PATTERN))),
  acknowledgeUnenumeratedChannels: v.optional(v.boolean(), false),
  preflightOnly: v.optional(v.boolean(), false),
});
const slackIdentityCancelSchema = v.strictObject({
  expectedRevision: slackIdentityRevisionSchema,
  deleteDraft: v.optional(v.boolean(), false),
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
    configStore.listAgents(),
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
      allowDms: v.boolean(),
      unassignedHint: v.boolean(),
      welcomeOnJoin: v.boolean(),
      ambientParticipation: v.boolean(),
      progressiveStreaming: v.boolean(),
      nativeTasks: v.boolean(),
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
  const passwordAuthByContext = new WeakMap<object, Promise<PasswordAuthContext | undefined>>();
  const tokenFromOptions = Object.hasOwn(options, 'adminToken');
  const store = (c: Context) => options.store ?? getConfigStore(c.env as PlatformEnv | undefined);
  const identity = (c: Context) =>
    options.identity ?? getIdentityStore(c.env as PlatformEnv | undefined);
  const settings = (c: Context) =>
    options.settings ?? getSettingsStore(c.env as PlatformEnv | undefined);
  const memory = (c: Context) =>
    options.memory ?? getMemoryStateStore(c.env as PlatformEnv | undefined);
  const routines = (c: Context) =>
    options.routines ?? getRoutineStore(c.env as PlatformEnv | undefined);
  const usage = (c: Context) =>
    options.usage ?? getUsageStore(c.env as PlatformEnv | undefined);
  const work = (c: Context) =>
    options.work ?? getWorkStore(c.env as PlatformEnv | undefined);
  const slackState = (c: Context) =>
    options.slackState ?? getSlackStateStore(c.env as PlatformEnv | undefined);
  const runtimeDrain = options.runtimeDrain ?? readRuntimeDrainStatus;
  const usageAdminUi = (c: Context): boolean => {
    if (options.usageAdminUi !== undefined) return options.usageAdminUi;
    const platformValue = (c.env as PlatformEnv | undefined)?.USAGE_ADMIN_UI;
    const value = platformValue ?? process.env.USAGE_ADMIN_UI;
    return value === undefined || value === '1' || value === 'true';
  };
  const adminToken = () =>
    tokenFromOptions ? options.adminToken : process.env.TAG_ADMIN_TOKEN;
  const recoveryToken = (c: Context): string | undefined => {
    if (Object.hasOwn(options, 'recoveryToken')) return options.recoveryToken;
    const bound = (c.env as PlatformEnv | undefined)?.CHICKPEA_RECOVERY_TOKEN;
    return typeof bound === 'string' ? bound : process.env.CHICKPEA_RECOVERY_TOKEN;
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
      authenticatorKind: principal?.authenticatorKind ?? 'legacy_admin_token',
      ...(principal
        ? { userId: principal.userId, membershipId: principal.membershipId }
        : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
  };
  const verifyAccessAssertion: AccessAssertionVerifier = options.verifyAccessAssertion ??
    (async (request, config, purpose) => {
      if (!config.issuer) throw new AuthDeniedError();
      if (purpose === 'recovery') {
        const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
        if (!assertion) throw new AuthDeniedError();
        return verifyCloudflareAccessRecoveryAssertion(assertion, { issuer: config.issuer });
      }
      if (!config.audience) throw new AuthDeniedError();
      return new CloudflareAccessAuthenticator({
        issuer: config.issuer,
        audience: config.audience,
      }).authenticate(request);
    });
  const passwordAuthContext = (c: Context): Promise<PasswordAuthContext | undefined> => {
    const cached = passwordAuthByContext.get(c);
    if (cached) return cached;
    const pending = (async () => {
      const identityStore = identity(c);
      const control = await identityStore.getAuthControl();
      if (control?.authMode !== 'password_active' ||
          !control.betterAuthOrganizationId ||
          !control.canonicalAdminOrigin) return undefined;
      const environment = options.betterAuthEnvironment ?? await resolveBetterAuthEnvironment({
          control,
          platformEnv: c.env as PlatformEnv | undefined,
          recoveryToken: recoveryToken(c),
          passwordShardKey: requestAuthSourceKey(c.req.raw, isCloudflareTarget()),
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
    passwordAuthByContext.set(c, pending);
    return pending;
  };
  const humanDirectory = async (c: Context): Promise<HumanIdentityDirectory> =>
    (await passwordAuthContext(c))?.directory ?? identity(c);
  const passwordTeamLifecycle = async (c: Context): Promise<PasswordTeamLifecycleService | undefined> => {
    const context = await passwordAuthContext(c);
    return context
      ? new PasswordTeamLifecycleService(
          identity(c),
          context.environment,
          context.organizationId,
        )
      : undefined;
  };
  const configuredAuthService = async (c: Context): Promise<AdminAuthenticationService | undefined> => {
    if (options.authService) return options.authService;
    const identityStore = identity(c);
    const passwordContext = await passwordAuthContext(c);
    if (passwordContext) {
      const { environment, directory, organizationId } = passwordContext;
      return new AuthService({
        identity: identityStore,
        passwordAuthenticator: new BetterAuthSessionAuthenticator({
          ...environment,
          directory,
          organizationId,
        }),
        personalTokens: new PersonalTokenService(identityStore, { directory }),
      });
    }
    const organization = await identityStore.getOrganization();
    if (!organization) return undefined;
    if (organization.authMode === 'access_active') {
      const config = await identityStore.getAuthProviderConfig('cloudflare_access');
      if (!config?.issuer || !config.audience || config.state !== 'active') return undefined;
      return new AuthService({
        identity: identityStore,
        authenticators: [new CloudflareAccessAuthenticator({
          issuer: config.issuer,
          audience: config.audience,
        })],
      });
    }
    if (organization.authMode === 'token_active') {
      return new AuthService({
        identity: identityStore,
        personalTokens: new PersonalTokenService(identityStore),
        tokenSessions: new TokenSessionService(identityStore),
      });
    }
    return undefined;
  };
  const legacyAuthenticationAllowed = async (c: Context): Promise<boolean> => {
    if (tokenFromOptions) return options.authService === undefined;
    const control = await identity(c).getAuthControl();
    if (control?.authMode === 'password_active') return false;
    const organization = await identity(c).getOrganization();
    return !organization || ['unconfigured', 'access_pending', 'legacy_shared'].includes(organization.authMode);
  };
  const modelProviders = () =>
    options.knownProviders
      ? listRuntimeModelProviders({ registeredProviders: options.knownProviders })
      : listRuntimeModelProviders();
  const providerIds = () => options.knownProviders ?? knownProviderIds();
  const safeSlackIdentityResponse = async (
    c: Context,
    identity: SlackIdentity,
  ) => {
    const behavior = await resolveSlackBehaviorSettings(
      c.env as PlatformEnv | undefined,
      settings(c),
    );
    return slackIdentityAdminResponse(
      identity,
      store(c),
      behavior.allowDms.value,
      slackState(c),
      identity.kind === 'workspace_default'
        ? await describeSlackCredentialSources(
            c.env as PlatformEnv | undefined,
            settings(c),
          )
        : undefined,
    );
  };
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
    validateConnection: (ref, serverUrl) =>
      isCurrentMcpOAuthConnection(store(c), ref, serverUrl),
    onReauthorizationRequired: async (ref, serverUrl) => {
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
    validateConnection: (ref, provider) =>
      isCurrentApiOAuthConnection(store(c), ref, provider),
    onReauthorizationRequired: async (ref, provider) => {
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
  const adminLoginBodyLimit = bodyLimit({
    maxSize: MAX_ADMIN_LOGIN_BODY_BYTES,
    onError: (c) =>
      c.html(renderAdminLogin({ invalidToken: true, returnTo: '/admin' }), 401),
  });
  const slackIdentityAdminBodyLimit = bodyLimit({
    maxSize: MAX_SLACK_IDENTITY_ADMIN_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  const authSetupBodyLimit = bodyLimit({
    maxSize: MAX_AUTH_SETUP_BODY_BYTES,
    onError: (c) => c.json({ error: 'invalid_request' }, 413),
  });
  const invitationJoinBodyLimit = bodyLimit({
    maxSize: MAX_AUTH_SETUP_BODY_BYTES,
    onError: (c) => c.json({ error: 'join_unavailable' }, 401),
  });
  const adminMutationBodyLimit = bodyLimit({
    maxSize: MAX_ADMIN_MUTATION_BODY_BYTES,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  });

  const adminGate = async (c: Context, next: Next) => {
    let authService: AdminAuthenticationService | undefined;
    try {
      authService = await configuredAuthService(c);
    } catch {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    if (authService) {
      if (isAdminLoginPost(c)) {
        const login = await readAdminLogin(c);
        const passwordContext = await passwordAuthContext(c);
        if (passwordContext) {
          authResponseHeaders(c);
          if (!login.email || !login.password ||
              !validAuthFormPost(c, passwordContext.environment.baseURL)) {
            return c.html(renderPasswordLogin({
              invalid: true,
              returnTo: login.returnTo,
              email: login.email ?? '',
            }), 401);
          }
          const handler = createBetterAuthEnvironmentPublicHandler({
            environment: passwordContext.environment,
            identity: identity(c),
            directory: passwordContext.directory,
          });
          const response = await handler(betterAuthJsonRequest(
            c.req.raw,
            passwordContext.environment.baseURL,
            '/api/auth/sign-in/email',
            { email: login.email, password: login.password },
          ));
          if (!response.ok) {
            return c.html(renderPasswordLogin({
              invalid: true,
              returnTo: login.returnTo,
              email: login.email ?? '',
            }), 401);
          }
          copyAuthResponseCookies(c, response.headers);
          return c.redirect(login.returnTo, 303);
        }
        const limiterToken = recoveryToken(c);
        const limiter = limiterToken && isValidRecoveryConfiguration(limiterToken)
          ? authRateLimiter(c, limiterToken)
          : undefined;
        const source = authSourceKey(c);
        try {
          await limiter?.assertAllowed('login', source);
          const result = await authService.loginWithPersonalToken?.(login.token ?? '');
          if (!result) throw new AuthDeniedError();
          setCookie(c, AUTH_SESSION_COOKIE, result.sessionToken, {
            path: '/admin',
            httpOnly: true,
            sameSite: 'Lax',
            secure: isHttps(c),
            expires: new Date(result.expiresAt),
          });
          await limiter?.recordSuccess('login', source);
          return c.redirect(login.returnTo, 303);
        } catch {
          await limiter?.recordFailure('login', source);
          return c.html(
            renderAdminLogin({ invalidToken: true, returnTo: login.returnTo }),
            401,
          );
        }
      }
      try {
        const principal = await authService.authenticateRequest(c.req.raw);
        copyAuthResponseCookies(c, authService.takeResponseHeaders?.(c.req.raw));
        principalByContext.set(c, principal);
        setRequestPrincipal(c.req.raw, principal);
        const permission = permissionForAdminRequest(c, principal);
        try {
          if (principal.machine && !machinePrincipalAllowed(c)) throw new AuthorizationError();
          requirePermission(principal, permission);
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
        if (principal.role === 'member' && isAdminPageGet(c) &&
            !['/admin/account', '/admin/account/password'].includes(c.req.path)) {
          return c.redirect('/admin/account', 303);
        }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
          const origin = (await passwordAuthContext(c))?.environment.baseURL ??
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
        if (error instanceof AuthorizationError) {
          return c.json({ error: 'forbidden' }, 403);
        }
        if (isAdminPageGet(c)) {
          authResponseHeaders(c);
          return c.html(
            (await passwordAuthContext(c))
              ? renderPasswordLogin({
                  returnTo: safeAdminReturnPath(c.req.query('returnTo') ?? c.req.path),
                })
              : renderAdminLogin({ returnTo: safeAdminReturnPath(c.req.path) }),
            401,
          );
        }
        return c.json({ error: 'unauthorized' }, 401);
      }
    }
    try {
      const control = await identity(c).ensureAuthControl();
      if (
        control?.authMode === 'unconfigured' &&
        isAdminPageGet(c) &&
        recoveryToken(c) &&
        !adminToken()
      ) {
        return c.redirect('/admin/setup', 303);
      }
      if (control?.authMode === 'invalid' && isAdminPageGet(c) && recoveryToken(c)) {
        return c.redirect('/admin/recovery', 303);
      }
    } catch {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    let legacyAllowed = false;
    try {
      legacyAllowed = await legacyAuthenticationAllowed(c);
    } catch {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    if (!legacyAllowed) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    const expected = adminToken();
    if (!expected) {
      return c.notFound();
    }

    // The cookie carries a hash of the token, never the token itself: a captured
    // cookie can't be replayed as a Bearer credential and doesn't reveal
    // TAG_ADMIN_TOKEN. The raw browser token exists only in the POST body, never
    // in a URL that access logs, browser history, or referrers can retain.
    const cookieValue = cookieTokenFor(expected);

    if (isAdminLoginPost(c)) {
      const login = await readAdminLogin(c);
      if (!constantTimeEquals(login.token, expected)) {
        return c.html(
          renderAdminLogin({ invalidToken: true, returnTo: login.returnTo }),
          401,
        );
      }
      setAdminCookie(c, cookieValue);
      return c.redirect(tokenFromOptions ? login.returnTo : '/admin/migrate', 303);
    }

    const candidate = bearerToken(c.req.header('authorization'));
    if (candidate !== undefined) {
      if (!constantTimeEquals(candidate, expected)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      return next();
    }

    if (!constantTimeEquals(getCookie(c, ADMIN_COOKIE), cookieValue)) {
      // A browser navigating to an /admin page with no valid session gets a
      // minimal POST token-entry form instead of a bare JSON 401. XHR and
      // /admin/api/* callers still get the JSON 401 they can handle. Kept at
      // 401 (not 200) so it is never cached as a real page.
      if (isAdminPageGet(c)) {
        return c.html(
          renderAdminLogin({ returnTo: safeAdminReturnPath(c.req.path) }),
          401,
        );
      }
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!tokenFromOptions && c.req.method === 'GET' && c.req.path === '/admin') {
      return c.redirect('/admin/migrate', 303);
    }
    return next();
  };

  const setAdminCookie = (c: Context, cookieValue: string): void => {
    setCookie(c, ADMIN_COOKIE, cookieValue, {
      path: '/admin',
      httpOnly: true,
      sameSite: 'Lax',
      // Send only over TLS when the request arrived over TLS; on plain-http
      // dev there is no transport to protect, so forcing Secure would just
      // drop the cookie and break login.
      secure: isHttps(c),
    });
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

  // Setup is public only until an authenticator becomes active. The recovery
  // credential authorizes the bounded owner bootstrap but is never itself a
  // browser login. Fresh installs create a Better Auth owner/session; the
  // legacy Access form remains available only for an already-pending install.
  app.use('/admin/setup', authSetupBodyLimit);
  app.use('/admin/setup/*', authSetupBodyLimit);
  app.use('/admin/recovery', authSetupBodyLimit);
  app.use('/admin/migrate', authSetupBodyLimit);

  app.get('/admin/setup/client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    return c.body(passwordOwnerSetupClientScript());
  });

  app.get('/admin/setup', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token) return c.notFound();
    if (!isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    const identityStore = identity(c);
    const [control, organization] = await Promise.all([
      identityStore.ensureAuthControl(),
      identityStore.getOrganization(),
    ]);
    if (control.authMode === 'password_active') return c.redirect('/admin/login', 303);
    if (organization?.authMode === 'access_active') return c.redirect('/admin', 303);
    if (!organization && control.authMode === 'unconfigured') {
      return c.html(renderPasswordOwnerSetupPage());
    }
    if (organization?.authMode === 'access_pending') {
      const config = await identityStore.getAuthProviderConfig('cloudflare_access');
      return c.html(renderAuthSetupPage({
        state: 'access_pending',
        origin: requestOrigin(c),
        ...(config?.issuer === undefined ? {} : { issuer: config.issuer }),
        ...(config?.audience === undefined ? {} : { audience: config.audience }),
      }));
    }
    return c.json({ error: 'authentication_unavailable' }, 409);
  });

  app.post('/admin/setup', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token) return c.notFound();
    if (!isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    let passwordSetup = false;
    let ownerSetupValues: { organizationName?: string; ownerEmail?: string } = {};
    try {
      await limiter.assertAllowed('setup', source);
      if (!validAuthFormPost(c, requestOrigin(c))) throw new AuthDeniedError();
      const rawForm = await readForm(c);
      passwordSetup = Object.hasOwn(rawForm, 'password');
      if (passwordSetup) {
        ownerSetupValues = {
          organizationName: preservedFormValue(rawForm.organizationName, 128),
          ownerEmail: preservedFormValue(rawForm.ownerEmail, 320),
        };
        const organization = await identity(c).getOrganization();
        if (organization) throw new AuthDeniedError();
        const form = v.safeParse(passwordOwnerSetupSchema, rawForm);
        if (!form.success) throw new AuthDeniedError();
        const environment = options.betterAuthEnvironment ??
          await resolveBetterAuthBootstrapEnvironment({
            canonicalOrigin: requestOrigin(c),
            platformEnv: c.env as PlatformEnv | undefined,
            recoveryToken: token,
            passwordShardKey: source,
          });
        if (!environment) throw new AuthDeniedError();
        const result = await new PasswordOwnerSetupService(identity(c), environment).complete({
          canonicalOrigin: requestOrigin(c),
          email: form.output.ownerEmail,
          organizationName: form.output.organizationName,
          password: form.output.password,
          recoveryToken: form.output.recoveryToken,
        });
        copyAuthResponseCookies(c, result.headers);
        await limiter.recordSuccess('setup', source);
        return c.redirect('/admin/ready', 303);
      }
      // Fresh OSS setup is password-based. Cloudflare Access remains readable
      // only for installations that were already pending before this flow;
      // stale copies of the retired form must never create a new Access setup.
      throw new AuthDeniedError();
    } catch (error) {
      await limiter.recordFailure('setup', source);
      const organization = await identity(c).getOrganization();
      const config = organization?.authMode === 'access_pending'
        ? await identity(c).getAuthProviderConfig('cloudflare_access')
        : undefined;
      return c.html(
        !passwordSetup && organization?.authMode === 'access_pending'
          ? renderAuthSetupPage({
            state: 'access_pending',
            error: true,
            origin: requestOrigin(c),
            ...(config?.issuer === undefined ? {} : { issuer: config.issuer }),
            ...(config?.audience === undefined ? {} : { audience: config.audience }),
          })
          : renderPasswordOwnerSetupPage({
            error: error instanceof PasswordPolicyError ? error.code : true,
            ...ownerSetupValues,
          }),
        401,
      );
    }
  });

  app.get('/admin/setup/verify', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token) return c.notFound();
    if (!isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    try {
      const config = await identity(c).getAuthProviderConfig('cloudflare_access');
      if (!config || config.state !== 'pending') throw new AuthDeniedError();
      const external = await verifyAccessAssertion(c.req.raw, config, 'activation');
      await new AuthSetupService(identity(c), { recoveryToken: token }).activateAccess(external);
      return c.redirect('/admin/ready', 303);
    } catch {
      const organization = await identity(c).getOrganization();
      const config = await identity(c).getAuthProviderConfig('cloudflare_access');
      return c.html(
        organization?.authMode === 'legacy_shared'
          ? renderAuthMigrationPage({ error: true })
          : renderAuthSetupPage({
            state: 'access_pending',
            error: true,
            origin: requestOrigin(c),
            ...(config?.issuer === undefined ? {} : { issuer: config.issuer }),
            ...(config?.audience === undefined ? {} : { audience: config.audience }),
          }),
        401,
      );
    }
  });

  // Recovery is deliberately not a login path. Password mode uses the offline
  // recovery credential to replace one durable owner password and revokes
  // authority; optional Access mode additionally requires its signed assertion.
  app.get('/admin/recovery', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token) return c.notFound();
    if (!isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    try {
      const control = await identity(c).getAuthControl();
      if (control?.authMode === 'password_active') {
        if (!await passwordAuthContext(c)) throw new AuthDeniedError();
        return c.html(renderPasswordRecoveryPage());
      }
      const config = await identity(c).getAuthProviderConfig('cloudflare_access');
      if (!config || config.state !== 'active') throw new AuthDeniedError();
      await verifyAccessAssertion(c.req.raw, config, 'recovery');
      return c.html(renderAuthRecoveryPage());
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
  });

  app.post('/admin/recovery', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token) return c.notFound();
    if (!isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    let passwordRecovery = false;
    try {
      await limiter.assertAllowed('recovery', source);
      const control = await identity(c).getAuthControl();
      passwordRecovery = control?.authMode === 'password_active';
      if (passwordRecovery) {
        if (!control?.canonicalAdminOrigin ||
            !validAuthFormPost(c, control.canonicalAdminOrigin)) throw new AuthDeniedError();
        const form = v.safeParse(passwordRecoverySchema, await readForm(c));
        const context = await passwordAuthContext(c);
        if (!form.success || !context) throw new AuthDeniedError();
        await new PasswordOwnerRecoveryService(identity(c), context.environment).replacePassword({
          recoveryToken: form.output.recoveryToken,
          email: form.output.ownerEmail,
          newPassword: form.output.newPassword,
        });
        await limiter.recordSuccess('recovery', source);
        return c.html(renderPasswordRecoveryPage({ success: true }));
      }
      const organization = await identity(c).getOrganization();
      if (!organization?.canonicalAdminOrigin ||
          !validAuthFormPost(c, organization.canonicalAdminOrigin)) {
        throw new AuthDeniedError();
      }
      const form = v.safeParse(authRecoverySchema, await readForm(c));
      if (!form.success) throw new AuthDeniedError();
      const config = await identity(c).getAuthProviderConfig('cloudflare_access');
      if (!config || config.state !== 'active') throw new AuthDeniedError();
      const external = await verifyAccessAssertion(c.req.raw, config, 'recovery');
      const recovery = new AuthRecoveryService(identity(c), { recoveryToken: token });
      if (form.output.operation === 'audience') {
        if (!form.output.audience) throw new AuthDeniedError();
        await recovery.repairAudience({
          recoveryToken: form.output.recoveryToken,
          identity: external,
          audience: form.output.audience,
        });
      } else {
        await recovery.replaceOwnerBinding({
          recoveryToken: form.output.recoveryToken,
          identity: external,
        });
      }
      await limiter.recordSuccess('recovery', source);
      return c.redirect('/admin', 303);
    } catch {
      await limiter.recordFailure('recovery', source);
      return c.html(
        passwordRecovery
          ? renderPasswordRecoveryPage({ error: true })
          : renderAuthRecoveryPage({ error: true }),
        401,
      );
    }
  });

  // GitHub calls this endpoint without a Chickpea or Access session. The
  // single-use state is the authorization boundary and is bound to the Admin
  // membership that initiated the manifest flow. Keep the old path public for
  // states minted before upgrade; both paths delegate to the same consumer.
  app.get('/oauth/github/setup/callback', completeGithubSetupCallback);
  app.get('/admin/api/github/setup/callback', completeGithubSetupCallback);

  // Invitation and reset capabilities arrive in URL fragments and are moved to
  // same-tab storage before these routes run. Keep the bounded enrollment
  // wrappers outside the ordinary Admin gate: they authenticate only the exact
  // operation, while Better Auth signup itself remains dark.
  app.use('/admin/join', invitationJoinBodyLimit);
  app.use('/admin/join/*', invitationJoinBodyLimit);
  app.use('/admin/reset', invitationJoinBodyLimit);
  app.use('/admin/reset/*', invitationJoinBodyLimit);
  app.get('/admin/join/client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    c.header('Content-Security-Policy', invitationJoinCsp());
    return c.body(invitationJoinClientScript());
  });
  app.get('/admin/join/password-client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    c.header('Content-Security-Policy', invitationJoinCsp());
    return c.body(passwordInvitationClientScript());
  });
  app.get('/admin/reset/client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    c.header('Content-Security-Policy', invitationJoinCsp());
    return c.body(passwordResetClientScript());
  });
  app.get('/admin/password/client.js', (c) => {
    authResponseHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    c.header('Content-Security-Policy', invitationJoinCsp());
    return c.body(passwordFormClientScript());
  });
  app.get('/admin/join', async (c) => {
    authResponseHeaders(c);
    c.header('Content-Security-Policy', invitationJoinCsp());
    try {
      if (await passwordAuthContext(c)) return c.html(renderPasswordInvitationPage());
      const config = await identity(c).getAuthProviderConfig('cloudflare_access');
      if (!config || config.state !== 'active') throw new AuthDeniedError();
      const external = await verifyAccessAssertion(c.req.raw, config, 'activation');
      const existing = await identity(c).resolveExternalIdentity(
        external.provider,
        external.issuer,
        external.subject,
      );
      if (existing?.membership.status === 'active') return c.redirect('/admin/account', 303);
      return c.html(renderInvitationJoinPage({ email: external.verifiedEmail }));
    } catch {
      return c.json({ error: 'join_unavailable' }, 401);
    }
  });
  app.post('/admin/join/inspect', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token || !isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'join_unavailable' }, 401);
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    try {
      await limiter.assertAllowed('invite', source);
      const context = await passwordAuthContext(c);
      if (!context || !validJsonMutation(c, context.environment.baseURL)) {
        throw new AuthDeniedError();
      }
      const parsed = v.safeParse(passwordCapabilityInspectionSchema, await readJson(c.req));
      if (!parsed.success) throw new AuthDeniedError();
      const inspected = await new PasswordEnrollmentService(
        identity(c),
        context.environment,
        context.organizationId,
      ).inspectInvitation({
        operationId: parsed.output.operationId,
        secret: parsed.output.token,
        headers: c.req.raw.headers,
      });
      await limiter.recordSuccess('invite', source);
      return c.json(inspected);
    } catch (error) {
      await limiter.recordFailure('invite', source);
      return passwordCapabilityError(c, error, 'join_unavailable');
    }
  });
  app.post('/admin/join', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token || !isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'join_unavailable' }, 401);
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    try {
      await limiter.assertAllowed('invite', source);
      const passwordContext = await passwordAuthContext(c);
      if (passwordContext) {
        if (!validJsonMutation(c, passwordContext.environment.baseURL)) throw new AuthDeniedError();
        const parsed = v.safeParse(passwordInvitationSchema, await readJson(c.req));
        if (!parsed.success) throw new AuthDeniedError();
        const result = await new PasswordEnrollmentService(
          identity(c),
          passwordContext.environment,
          passwordContext.organizationId,
        ).completeInvitation({
          operationId: parsed.output.operationId,
          secret: parsed.output.token,
          headers: c.req.raw.headers,
          ...(parsed.output.displayName === undefined
            ? {} : { displayName: parsed.output.displayName }),
          ...(parsed.output.password === undefined ? {} : { password: parsed.output.password }),
        });
        copyAuthResponseCookies(c, result.headers);
        await identity(c).recordAuthAudit({
          event: 'authentication',
          outcome: 'success',
          action: 'team.invitation_accept',
          correlationId: `join_${digest(parsed.output.operationId).slice(0, 24)}`,
          authenticatorKind: 'better_auth',
          userId: result.userId,
          membershipId: result.membershipId,
        });
        await limiter.recordSuccess('invite', source);
        return c.json({ redirect: '/admin/channels' });
      }
      const organization = await identity(c).getOrganization();
      const config = await identity(c).getAuthProviderConfig('cloudflare_access');
      if (!organization?.canonicalAdminOrigin || !config || config.state !== 'active') {
        throw new AuthDeniedError();
      }
      if (!validJsonMutation(c, organization.canonicalAdminOrigin)) throw new AuthDeniedError();
      const parsed = v.safeParse(invitationJoinSchema, await readJson(c.req));
      if (!parsed.success) throw new AuthDeniedError();
      const external = await verifyAccessAssertion(c.req.raw, config, 'activation');
      const resolution = await identity(c).consumeInvitation({
        invitationId: parsed.output.invitationId,
        tokenHash: digest(parsed.output.token),
        provider: external.provider,
        issuer: external.issuer,
        subject: external.subject,
        verifiedEmail: external.verifiedEmail,
        ...(external.displayName === undefined ? {} : { displayName: external.displayName }),
      });
      await identity(c).recordAuthAudit({
        event: 'authentication',
        outcome: 'success',
        action: 'team.invitation_accept',
        correlationId: `join_${digest(external.credentialId).slice(0, 24)}`,
        authenticatorKind: external.provider,
        userId: resolution.user.id,
        membershipId: resolution.membership.id,
      });
      await limiter.recordSuccess('invite', source);
      return c.json({ redirect: '/admin/channels' });
    } catch (error) {
      await limiter.recordFailure('invite', source);
      return passwordCapabilityError(c, error, 'join_unavailable');
    }
  });

  app.get('/admin/reset', async (c) => {
    authResponseHeaders(c);
    c.header('Content-Security-Policy', invitationJoinCsp());
    return await passwordAuthContext(c)
      ? c.html(renderPasswordResetPage())
      : c.json({ error: 'reset_unavailable' }, 404);
  });
  app.post('/admin/reset', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token || !isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'reset_unavailable' }, 401);
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    try {
      await limiter.assertAllowed('recovery', source);
      const context = await passwordAuthContext(c);
      if (!context || !validJsonMutation(c, context.environment.baseURL)) {
        throw new AuthDeniedError();
      }
      const parsed = v.safeParse(passwordResetSchema, await readJson(c.req));
      if (!parsed.success || (parsed.output.inspect !== true && !parsed.output.newPassword)) {
        throw new AuthDeniedError();
      }
      const service = new PasswordEnrollmentService(
        identity(c),
        context.environment,
        context.organizationId,
      );
      if (parsed.output.inspect === true) {
        const inspected = await service.inspectReset({
          operationId: parsed.output.operationId,
          secret: parsed.output.token,
          headers: c.req.raw.headers,
        });
        await limiter.recordSuccess('recovery', source);
        return c.json(inspected);
      }
      await service.completeReset({
        operationId: parsed.output.operationId,
        secret: parsed.output.token,
        newPassword: parsed.output.newPassword!,
        headers: c.req.raw.headers,
      });
      await limiter.recordSuccess('recovery', source);
      clearBetterAuthCookies(c);
      return c.json({ redirect: '/admin/login' });
    } catch (error) {
      await limiter.recordFailure('recovery', source);
      return passwordCapabilityError(c, error, 'reset_unavailable');
    }
  });

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
    try {
      if (providerError) {
        const cancelled = await cancelMcpOAuth(state, oauthDependencies(c));
        const status = providerError === 'access_denied' ? 'cancelled' : 'failed';
        return c.redirect(mcpOAuthAdminRedirect(status, cancelled.ref), 303);
      }
      ({ ref } = await completeMcpOAuth(
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
      });
      return c.redirect(mcpOAuthAdminRedirect('connected', ref), 303);
    } catch (error) {
      console.warn(
        `[chickpea] MCP OAuth verification failed (${ref.connectionId}): ` +
          mcpDebugText(error),
      );
      return c.redirect(mcpOAuthAdminRedirect('verification_failed', ref), 303);
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
    try {
      if (providerError) {
        const cancelled = await cancelApiOAuth(state, apiOAuthDependencies(c));
        const status = providerError === 'access_denied' ? 'cancelled' : 'failed';
        return c.redirect(apiOAuthAdminRedirect(status, cancelled.ref), 303);
      }
      const completed = await completeApiOAuth(
        { code: code!, state },
        apiOAuthDependencies(c),
      );
      ref = completed.ref;
      try {
        await replaceReadyApiOAuthConnection(
          store(c),
          completed.ref,
          completed.provider,
          completed.identity,
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
      return c.redirect(apiOAuthAdminRedirect('connected', completed.ref), 303);
    } catch (error) {
      if (error instanceof ApiOAuthError && error.code === 'invalid_state') {
        return invalidRequest(c);
      }
      console.error(
        '[chickpea] API OAuth callback failed:',
        error instanceof ApiOAuthError ? error.code : 'internal_error',
      );
      if (ref) {
        return c.redirect(apiOAuthAdminRedirect('failed', ref), 303);
      }
      try {
        ref = apiOAuthReturnRefFromState(state);
        return c.redirect(apiOAuthAdminRedirect('failed', ref), 303);
      } catch {
        return c.redirect('/admin?oauth=failed&lane=api', 303);
      }
    }
  });

  // The worker's root is not a product surface — send visitors to the admin
  // (the gate/login there handles auth). Bare 404 at `/` read as a broken
  // install during live testing.
  app.get('/', (c) => c.redirect('/admin', 302));

  // Apply the byte cap before the unauthenticated body is buffered. Keep the
  // missing-token 404 contract by letting adminGate handle disabled admin UI.
  app.use('/admin/login', adminLoginBodyLimit);
  app.use('/admin', adminGate);
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
    // link works even on a button deploy that never set SLACK_TAG_PUBLIC_URL,
    // and even when creds arrived via env. No-op on the steady state.
    // The observational connection test must mutate NOTHING, and disconnect
    // promises to preserve the already-stored public URL, so those two
    // lifecycle operations deliberately skip the opportunistic write.
    const slackConnectionTest =
      c.req.method === 'POST' && c.req.path === '/admin/api/slack-connection/test';
    const slackDisconnect =
      c.req.method === 'DELETE' && c.req.path === '/admin/api/slack-connection';
    // Identity-authenticated installs pin their canonical Admin origin during
    // setup. Never let an arbitrary later request host rewrite it (or the
    // Slack public URL derived from it). Legacy installs retain the historical
    // opportunistic behavior until migration completes.
    if (!principal && !slackConnectionTest && !slackDisconnect) {
      await persistRequestOrigin(c, settingsStore);
    }
    return next();
  });
  const limitSlackIdentityMutation = (c: Context, next: Next) =>
    c.req.method === 'GET' || c.req.method === 'HEAD'
      ? next()
      : slackIdentityAdminBodyLimit(c, next);
  app.use('/admin/api/slack-identities', limitSlackIdentityMutation);
  app.use('/admin/api/slack-identities/*', limitSlackIdentityMutation);
  // The legacy workspace-default connection route is an identity mutation too.
  // Keep its compatibility shape, but give it the same pre-parse byte ceiling.
  app.use('/admin/api/slack-connection', limitSlackIdentityMutation);

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

  const adminPage = (c: Context): Response => {
    // The shell contains the full inline application. Never let a browser keep
    // an older deployment's JavaScript after the Worker has been updated.
    c.header('Cache-Control', 'no-store');
    return c.html(renderAdminPage({ usageAdminUi: usageAdminUi(c) }));
  };

  app.get('/admin/migrate', async (c) => {
    authResponseHeaders(c);
    const organization = await identity(c).getOrganization();
    if (organization?.authMode === 'access_active' || organization?.authMode === 'token_active') {
      return c.redirect('/admin', 303);
    }
    const token = recoveryToken(c);
    if (!token || !isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    return c.html(renderAuthMigrationPage());
  });

  app.post('/admin/migrate', async (c) => {
    authResponseHeaders(c);
    const token = recoveryToken(c);
    if (!token || !isValidRecoveryConfiguration(token)) {
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
    const source = authSourceKey(c);
    const limiter = authRateLimiter(c, token);
    try {
      await limiter.assertAllowed('setup', source);
      if (!validAuthFormPost(c, requestOrigin(c))) throw new AuthDeniedError();
      const form = v.safeParse(authSetupSchema, await readForm(c));
      if (!form.success) throw new AuthDeniedError();
      const setup = new AuthSetupService(identity(c), { recoveryToken: token });
      const pending = await setup.beginAccessSetup({
        recoveryToken: form.output.recoveryToken,
        ownerEmail: form.output.ownerEmail,
      });
      await setup.configureAccess({
        recoveryToken: form.output.recoveryToken,
        issuer: form.output.issuer,
        audience: form.output.audience,
        canonicalAdminOrigin: requestOrigin(c),
      });
      await identity(c).updateOrganizationAuth({
        organizationId: pending.organization.id,
        authMode: 'legacy_shared',
        canonicalAdminOrigin: requestOrigin(c),
      });
      await limiter.recordSuccess('setup', source);
      return c.redirect('/admin/setup/verify', 303);
    } catch {
      await limiter.recordFailure('setup', source);
      return c.html(renderAuthMigrationPage({ error: true }), 401);
    }
  });

  app.get('/admin', adminPage);

  app.get('/admin/ready', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(renderAuthSetupCompletePage());
  });

  app.post('/admin/logout', async (c) => {
    authResponseHeaders(c);
    const context = await passwordAuthContext(c);
    if (!context) return c.redirect('/admin/login', 303);
    const handler = createBetterAuthEnvironmentPublicHandler({
      environment: context.environment,
      identity: identity(c),
      directory: context.directory,
    });
    const response = await handler(betterAuthJsonRequest(
      c.req.raw,
      context.environment.baseURL,
      '/api/auth/sign-out',
      {},
    ));
    copyAuthResponseCookies(c, response.headers);
    clearBetterAuthCookies(c);
    return c.redirect('/admin/login', 303);
  });

  app.get('/admin/account/password', async (c) => {
    authResponseHeaders(c);
    if (!await passwordAuthContext(c)) return c.notFound();
    return c.html(renderPasswordChangePage());
  });

  app.post('/admin/account/password', async (c) => {
    authResponseHeaders(c);
    const principal = principalByContext.get(c);
    const context = await passwordAuthContext(c);
    if (!principal || principal.machine || !context) return c.json({ error: 'forbidden' }, 403);
    try {
      const parsed = v.safeParse(passwordChangeSchema, await readForm(c));
      if (!parsed.success) throw new AuthDeniedError();
      const [user, organization] = await Promise.all([
        context.directory.getUser(principal.userId),
        context.directory.getOrganization(),
      ]);
      if (!user || !organization) throw new AuthDeniedError();
      assertPasswordPolicy(parsed.output.newPassword, {
        email: user.primaryEmail,
        organizationName: organization.displayName,
      });
      const auth = createBetterAuth({ ...context.environment, allowSignUp: false });
      await auth.api.changePassword({
        body: {
          currentPassword: parsed.output.currentPassword,
          newPassword: parsed.output.newPassword,
          revokeOtherSessions: false,
        },
        headers: c.req.raw.headers,
      });
      await auth.api.revokeSessions({ headers: c.req.raw.headers });
      clearBetterAuthCookies(c);
      return c.redirect('/admin/login', 303);
    } catch {
      return c.html(renderPasswordChangePage({ error: true }), 400);
    }
  });

  app.get('/admin/account', async (c) => {
    const principal = principalByContext.get(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const directory = await humanDirectory(c);
    const [organization, user, membership] = await Promise.all([
      directory.getOrganization(),
      directory.getUser(principal.userId),
      directory.getMembershipForUser(principal.userId, principal.organizationId),
    ]);
    if (!organization || !user || !membership) return c.json({ error: 'account_unavailable' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.html(renderMemberAccountPage({
      organizationName: organization.displayName,
      displayName: user.displayName,
      email: user.primaryEmail,
      role: membership.role,
      status: membership.status,
    }));
  });

  app.get('/account', (c) => c.redirect('/admin/account', 303));

  app.route('/admin/api', createTeamAdminApi({
    store: identity,
    directory: humanDirectory,
    passwordLifecycle: passwordTeamLifecycle,
  }));
  app.route('/admin/api', createMemoryAdminApi({
    store: memory,
    adminSecret: () => adminToken() ?? '',
  }));
  app.route('/admin/api', createRoutineAdminApi({ store: routines, usage, work }));
  app.route('/admin/api', createUsageAdminApi({ store: usage, work }));
  app.route('/admin/api', createWorkAdminApi({ store: work, usage }));

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
    const agents = await Promise.all(
      (await store(c).listAgents()).map((agent) =>
        withApiConnectionSources(agent, platformEnv, settingsStore),
      ),
    );
    return c.json({ agents });
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
  // Reviewed catalog entries augment both API-key providers and define the
  // complete Subscription list. OpenRouter and the keyless
  // Workers AI binding show ONLY the user's starred favorites (curated in the
  // Settings managers), so this route folds those favorites into their
  // suggestions — the per-provider search/favorites endpoints stay the editors.
  app.get('/admin/api/models', async (c) => {
    const settingsStore = settings(c);
    await refreshCatalog(c, false);
    const [subscription, activeAuthMethod] = await Promise.all([
      getOpenAiSubscriptionAuthorizationStatus(settingsStore),
      resolveOpenAiAuthMethod(settingsStore),
    ]);
    const subscriptionModels = activeCatalogModels('openai_subscription');
    const openAiApiModels = activeCatalogModels('openai_api_key');
    const anthropicApiModels = activeCatalogModels('anthropic_api_key');
    const providers = await Promise.all(
      modelProviders().map(async (provider) => {
        if (provider.id === 'openai') {
          const subscriptionConfigured = (
            subscription.state === 'connected' ||
            subscription.state === 'account_change_confirmation_required' ||
            (subscription.state === 'authorizing' && Boolean(subscription.accountFingerprint))
          );
          const subscriptionActive = activeAuthMethod === 'subscription';
          return {
            ...provider,
            configured: subscriptionActive
              ? subscriptionConfigured
              : provider.configured,
            source: subscriptionActive ? 'ChatGPT subscription' : provider.source,
            suggestions: subscriptionActive
              ? subscriptionModels.map((model) => model.canonical)
              : uniqueStrings([
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

  app.get('/admin/api/providers', async (c) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const [sources, subscription, activeAuthMethod] = await Promise.all([
      describeProviderKeySources(platformEnv, settingsStore),
      getOpenAiSubscriptionAuthorizationStatus(settingsStore),
      resolveOpenAiAuthMethod(settingsStore),
    ]);
    return c.json({
      providers: [
        ...PROVIDER_KEY_IDS.map((id) => ({
          ...providerSummary(id, sources[id]),
          ...(id === 'openai'
            ? { activeAuthMethod, subscription }
            : {}),
        })),
        providerSummary('workers-ai', workersAiStatus(platformEnv)),
      ],
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
    if (method === 'api_key') {
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
    } else {
      const subscription = await getOpenAiSubscriptionAuthorizationStatus(settingsStore);
      if (!openAiSubscriptionIsReady(subscription)) {
        return c.json({
          error: 'openai_subscription_missing',
          message: 'Connect a ChatGPT subscription before selecting it.',
        }, 409);
      }
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
    const resolved = await deleteProviderApiKey(
      id,
      platformEnv,
      settingsStore,
      usage(c),
    );
    if (
      id === 'openai' &&
      resolved.source === 'missing' &&
      openAiSubscriptionIsReady(await getOpenAiSubscriptionAuthorizationStatus(settingsStore))
    ) {
      await saveOpenAiAuthMethod(settingsStore, 'subscription');
    }
    return c.json({
      ok: true,
      provider: providerSummary(id, resolved.source),
      pinnedProfileCount: await countPinnedProfiles(store(c), id),
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
      if (id === 'openai' && await resolveOpenAiAuthMethod(settingsStore) === 'subscription') {
        const snapshot = activeModelCatalogSnapshot();
        return c.json({
          provider: id,
          models: activeCatalogModels('openai_subscription').map((model) => ({ id: model.id })),
          cached: true,
          source: snapshot.source,
        });
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

  app.get('/admin/api/memory/settings', async (c) => {
    return c.json({ enabled: true, alwaysOn: true });
  });

  app.put('/admin/api/memory/settings', async (c) => {
    return c.json(
      { error: 'memory_always_enabled', enabled: true, alwaysOn: true },
      409,
    );
  });

  app.get('/admin/api/github/status', async (c) => {
    try {
      const connection = await getGithubConnection(settings(c));
      // Profiles holding grants are reported up front so the UI can warn
      // before a disconnect, not after (DELETE also reports, but too late).
      const referencingProfiles = (await store(c).listAgents())
        .filter((agent) => agent.repositories.length > 0)
        .map(({ id, name }) => ({ id, name }));
      if (connection.mode !== 'app') {
        return c.json({
          mode: connection.mode,
          referencingProfiles,
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
          referencingProfiles,
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
        referencingProfiles,
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
      const referencingProfiles = (await store(c).listAgents())
        .filter((agent) => agent.repositories.length > 0)
        .map(({ id, name }) => ({ id, name }));
      await settings(c).applySettingsPatch({
        delete: [
          ...Object.values(GITHUB_SETTING_KEYS),
          // Cleanup only: older installs may still have this now-ignored key.
          LEGACY_GITHUB_PAT_SETTING_KEY,
        ],
      });
      return c.json({ ok: true, referencingProfiles });
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
    let agent = toAgentConfig(parsed.output);
    await loadModelCatalog(settings(c));
    const modelCompatibilityError = activeCatalogCompatibilityError(
      agent.model,
      await resolveOpenAiAuthMethod(settings(c)),
    );
    if (modelCompatibilityError) return invalidRequest(c, modelCompatibilityError);
    const modelError = modelResolutionError(agent);
    if (modelError) {
      return modelNotResolvable(c, modelError);
    }
    try {
      const configStore = store(c);
      agent = {
        ...agent,
        apiConnections: await normalizeApiOAuthPatch(
          agent.id,
          [],
          agent.apiConnections,
          settings(c),
        ),
      };
      return c.json(
        {
          agent: await configStore.createAgent(agent),
          ...providerWarnings(agent.model, providerIds()),
        },
        201,
      );
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
    // Start from stored/env secrets for this profile-local connection, then let
    // any value typed into the unsaved form win — the operator is testing
    // exactly what they typed.
    const resolved = await resolveMcpSecrets(
      { agentId, connectionId: input.id },
      // Union of the connection's known header names and any typed this session,
      // so a stored value backs a header the operator didn't re-enter.
      [...new Set([...(input.headerNames ?? []), ...Object.keys(input.headers ?? {})])],
      platformEnv,
      settingsStore,
    );
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

  app.get('/admin/api/agents/:id', async (c) => {
    try {
      const agent = await store(c).getAgent(c.req.param('id'));
      return c.json({
        agent: await withApiConnectionSources(
          agent,
          c.env as PlatformEnv | undefined,
          settings(c),
        ),
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.patch('/admin/api/agents/:id', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentPatchSchema, body);
    if (!parsed.success) {
      return invalidRequest(c, githubApiConnectionValidationMessage(parsed.issues));
    }
    try {
      const configStore = store(c);
      const agentId = c.req.param('id');
      const current = await configStore.getAgent(agentId);
      const patch = toAgentPatch(parsed.output);
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
      const modelError = modelResolutionError(next);
      if (modelError) {
        return modelNotResolvable(c, modelError);
      }
      return c.json({
        agent: await configStore.updateAgent(agentId, patch),
        ...providerWarnings(next.model, providerIds()),
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      if (err instanceof AgentStillSlackDmHandlerError) {
        return c.json({
          error: 'agent_slack_dm_handler',
          profileId: err.agentId,
          identityIds: err.identityIds.split(', ').filter(Boolean),
        }, 409);
      }
      return internalError(c, err);
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

    const references = await configStore.listAssignmentsForAgent(agentId);
    if (references.length > 0) {
      return c.json(
        {
          error: 'agent_still_assigned',
          assignments: references.map(({ workspaceId, channelId }) => ({ workspaceId, channelId })),
        },
        409,
      );
    }
    // Persist the cleanup inventory before deleting the profile. The marker is
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
      // A false return means another request removed the row after our initial
      // read. Either way the profile is absent and the staged cleanup is safe.
      await configStore.deleteAgent(agentId);
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
      if (err instanceof AgentStillSlackDmHandlerError) {
        return c.json({
          error: 'agent_slack_dm_handler',
          profileId: err.agentId,
          identityIds: err.identityIds.split(', ').filter(Boolean),
        }, 409);
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

  app.get('/admin/api/assignments', async (c) => {
    if (!c.req.query('workspaceId') && !c.req.query('channelId')) {
      return c.json({ assignments: await store(c).listAssignments() });
    }
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const assignment = await store(c).getAssignment(key.workspaceId, key.channelId);
    return assignment ? c.json({ assignment }) : c.json({ error: 'not_found' }, 404);
  });

  app.put('/admin/api/assignments', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(assignmentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const input = parsed.output;
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);

    // Slack validation guards EVERY assignment path (this API is the one choke
    // point), but only when a bot token is resolvable AND the target is a
    // concrete workspace+channel. Wildcards ('*') are scope rules, not real
    // channels, and a credential-less (offline/dev) install keeps the exact
    // pre-validation behavior so those setups and tests never break.
    const { botToken } = await resolveSlackCredentials(platformEnv, settingsStore);
    const isWildcard = input.workspaceId === '*' || input.channelId === '*';

    let isMember: boolean | undefined;
    let joined: boolean | undefined;
    let authoritativeLabel: string | undefined;
    if (botToken && !isWildcard) {
      const teamInfo = await resolveTeamInfoSafely(platformEnv, settingsStore);
      // (a) The channel must live in the CONNECTED workspace. Without this
      //     check, a channel id copied from another workspace could be accepted
      //     even though the configured bot can never reach it.
      if (teamInfo.teamId && input.workspaceId !== teamInfo.teamId) {
        return c.json(
          {
            error: 'workspace_mismatch',
            message: workspaceMismatchMessage(teamInfo, input.workspaceId),
            connectedTeamId: teamInfo.teamId,
            connectedTeamName: teamInfo.teamName ?? null,
          },
          400,
        );
      }
      // (b) The channel must actually exist in that workspace. A typo, a
      //     wrong-workspace id, or a private channel the bot was never invited
      //     to all surface here as channel_not_found.
      let info;
      try {
        info = await slackConversationsInfo(botToken, input.channelId);
      } catch {
        // Slack unreachable: do not hard-fail an operator edit on a transient
        // outage — skip verification and save what we can.
        info = undefined;
      }
      if (info && !info.ok && info.error === 'channel_not_found') {
        return c.json(
          {
            error: 'channel_not_found',
            message: channelNotFoundMessage(input.channelId, teamInfo),
          },
          400,
        );
      }
      if (info?.ok && info.channel) {
        // (c) Membership drives the UI's "invite @Chickpea or it never hears
        //     mentions" reminder; Slack's authoritative name becomes the label.
        isMember = info.channel.isMember;
        if (info.channel.name) {
          authoritativeLabel = info.channel.name;
        }
        // (d) A bot CAN self-join a PUBLIC channel it is not yet in (via the
        //     channels:join scope) — do it now so the operator does not have to
        //     switch to Slack and invite it. A PRIVATE channel cannot be
        //     self-joined (Slack forbids it), so it keeps the invite reminder.
        //     Any failure — missing_scope on installs that predate the scope, a
        //     transient error — is graceful: the assignment still saves and the
        //     invite reminder still shows. The join must never fail the save.
        if (isMember === false && info.channel.isPrivate === false) {
          try {
            const join = await slackConversationsJoin(botToken, input.channelId);
            if (join.ok) {
              isMember = true;
              joined = true;
            }
          } catch {
            // Slack unreachable mid-join: leave isMember false so the invite
            // reminder shows; the save proceeds regardless.
          }
        }
      }
    }

    const assignment = toAssignment(input);
    if (authoritativeLabel !== undefined) {
      assignment.channelLabel = authoritativeLabel;
    }
    try {
      const saved = await store(c).putAssignment(assignment);
      return c.json({
        assignment: saved,
        ...(isMember !== undefined ? { isMember } : {}),
        ...(joined !== undefined ? { joined } : {}),
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'unknown_agent' }, 404);
      }
      return internalError(c, err);
    }
  });

  // Server-side channel picker source for the Add-channel form: the browser
  // never touches a Slack token. Cursor-paginated + cached in-isolate (see
  // channels.ts); ?refresh=1 bypasses after the operator invites the bot to a
  // new channel. Fails closed with a clear envelope when Slack is not connected.
  app.get('/admin/api/slack-channels', async (c) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const { botToken } = await resolveSlackCredentials(platformEnv, settingsStore);
    if (!botToken) {
      return c.json({ error: 'slack_not_configured' }, 409);
    }
    const teamInfo = await resolveTeamInfoSafely(platformEnv, settingsStore);
    try {
      const { channels, truncated } = await listSlackChannels(botToken, {
        refresh: c.req.query('refresh') === '1',
      });
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
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/assignments', async (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const deleted = await store(c).deleteAssignment(key.workspaceId, key.channelId);
    return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/admin/api/effective-config', async (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    try {
      const configStore = store(c);
      return c.json({
        config: effectiveConfigResponse(
          await resolveEffectiveSlackConfig(key.workspaceId, key.channelId, {
            agents: configStore,
            assignments: configStore,
          }),
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

  app.get('/admin/api/slack-identities', async (c) => {
    try {
      const configStore = store(c);
      const identities = await configStore.listSlackIdentities();
      const behavior = await resolveSlackBehaviorSettings(
        c.env as PlatformEnv | undefined,
        settings(c),
      );
      const responses = await Promise.all(
        identities.map((identity) =>
          slackIdentityAdminResponse(
            identity,
            configStore,
            behavior.allowDms.value,
            slackState(c),
            identity.kind === 'workspace_default'
              ? describeSlackCredentialSources(
                  c.env as PlatformEnv | undefined,
                  settings(c),
                )
              : undefined,
          ),
        ),
      );
      c.header('Cache-Control', 'no-store');
      return c.json({
        identities: responses,
        globalDmAllowed: behavior.allowDms.value,
      });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.post('/admin/api/slack-identities', async (c) => {
    const parsed = v.safeParse(slackIdentityCreateSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const configStore = store(c);
      const dmAgent = await configStore.getAgent(parsed.output.initialDmAgentId);
      if (!dmAgent.enabled) {
        return c.json({
          error: 'slack_identity_dm_profile_disabled',
          message: 'Choose an enabled Profile to handle DMs for this identity.',
        }, 409);
      }
      const now = Date.now();
      const identityId = `slack_identity_${randomUUID().replaceAll('-', '')}`;
      const identity = await configStore.createSlackIdentity({
        id: identityId,
        ingressKey: generateSlackIdentityIngressKey(),
        kind: 'dedicated',
        lifecycle: 'setup_incomplete',
        dmState: 'on',
        dmAgentId: dmAgent.id,
        credentialProvenance: 'none',
        connectionRevision: 0,
        health: 'unknown',
        createdAt: now,
        updatedAt: now,
        setupIntent: {
          appName:
            parsed.output.appName ??
            (parsed.output.displayName || 'Chickpea identity').slice(0, 35),
          ...(parsed.output.displayName
            ? { displayName: parsed.output.displayName }
            : {}),
          ...(parsed.output.source === 'profile'
            ? {
                sourceAgentId: dmAgent.id,
                sourceAgentSlackIdentityId: dmAgent.slackIdentityId ?? null,
              }
            : {}),
        },
      });
      await appendSlackIdentityAudit(
        configStore,
        c,
        'slack_identity.setup_started',
        identity,
        identity,
      );
      const behavior = await resolveSlackBehaviorSettings(
        c.env as PlatformEnv | undefined,
        settings(c),
      );
      return c.json({
        identity: await slackIdentityAdminResponse(
          identity,
          configStore,
          behavior.allowDms.value,
          slackState(c),
        ),
        setupUrl: slackIdentitySetupUrl(identity.id),
        setup: dedicatedSlackIdentitySetup(identity, requestOrigin(c)),
      }, 201);
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.get('/admin/api/slack-identities/:identityId', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    try {
      const configStore = store(c);
      const identity = await configStore.getSlackIdentity(identityId);
      c.header('Cache-Control', 'no-store');
      return c.json({
        identity: await safeSlackIdentityResponse(c, identity),
        setup:
          identity.kind === 'dedicated' &&
          (identity.lifecycle === 'setup_incomplete' ||
            identity.lifecycle === 'credentials_pending')
            ? dedicatedSlackIdentitySetup(identity, requestOrigin(c))
            : null,
      });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.patch('/admin/api/slack-identities/:identityId/setup', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    const parsed = v.safeParse(
      slackIdentitySetupIntentSchema,
      await readJson(c.req),
    );
    if (!parsed.success) return invalidRequest(c);
    try {
      const configStore = store(c);
      const before = await configStore.getSlackIdentity(identityId);
      if (before.kind !== 'dedicated' || before.lifecycle !== 'setup_incomplete') {
        throw new SlackIdentityLifecycleError(
          identityId,
          'edit setup names for',
          before.lifecycle,
        );
      }
      const identity = await configStore.updateSlackIdentity(
        identityId,
        parsed.output.expectedRevision,
        {
          setupIntent: {
            ...before.setupIntent,
            appName: parsed.output.appName,
            displayName: parsed.output.displayName,
          },
        },
      );
      return c.json({
        identity: await safeSlackIdentityResponse(c, identity),
        setup: dedicatedSlackIdentitySetup(identity, requestOrigin(c)),
      });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.post('/admin/api/slack-identities/:identityId/connect', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    const parsed = v.safeParse(slackIdentityConnectSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const configStore = store(c);
      const before = await configStore.getSlackIdentity(identityId);
      const base = await configStore.getSlackIdentity(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      );
      const teamInfo = await resolveTeamInfoSafely(
        c.env as PlatformEnv | undefined,
        settings(c),
      );
      const expectedTeamId = base.teamId ?? teamInfo.teamId;
      if (!expectedTeamId) {
        return c.json({
          error: 'slack_workspace_unverified',
          message: 'Connect the workspace-default Slack app before adding a dedicated identity.',
        }, 409);
      }
      const identity = await beginSlackIdentityConnection(
        {
          config: configStore,
          settings: settings(c),
          identityId,
          expectedRevision: parsed.output.expectedRevision,
          expectedTeamId,
          botToken: parsed.output.botToken,
          signingSecret: parsed.output.signingSecret,
        },
        options.slackIdentityBootstrap,
      );
      await appendSlackIdentityAudit(
        configStore,
        c,
        before.lifecycle === 'setup_incomplete'
          ? 'slack_identity.credentials_connected'
          : 'slack_identity.credentials_rotated',
        before,
        identity,
      );
      return c.json({ identity: await safeSlackIdentityResponse(c, identity) });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.post('/admin/api/slack-identities/:identityId/verify', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    const parsed = v.safeParse(slackIdentityVerifySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const configStore = store(c);
      const before = await configStore.getSlackIdentity(identityId);
      const attachAgentId = before.setupIntent?.reconnecting
        ? undefined
        : before.setupIntent?.sourceAgentId;
      const expectedAgentIdentityId = attachAgentId
        ? Object.prototype.hasOwnProperty.call(
            before.setupIntent ?? {},
            'sourceAgentSlackIdentityId',
          )
          ? before.setupIntent?.sourceAgentSlackIdentityId ?? null
          : parsed.output.expectedProfileIdentityId ?? null
        : undefined;
      const identity = await completeSlackIdentityConnection({
        config: configStore,
        settings: settings(c),
        identityId,
        expectedRevision: parsed.output.expectedRevision,
        ...(attachAgentId ? { attachAgentId } : {}),
        ...(attachAgentId
          ? { expectedAgentIdentityId: expectedAgentIdentityId ?? null }
          : {}),
      });
      await appendSlackIdentityAudit(
        configStore,
        c,
        'slack_identity.setup_verified',
        before,
        identity,
      );
      if (attachAgentId) {
        await appendSlackIdentityAudit(
          configStore,
          c,
          'slack_identity.profile_attached',
          before,
          identity,
        );
      }
      if (before.setupIntent?.reconnecting) {
        const recoveryStore = slackState(c);
        const retryRecovery = recoveryStore.retrySlackIdentityRecovery;
        if (retryRecovery) {
          const retried = await retryRecovery.call(recoveryStore, identity.id);
          if (retried > 0) {
            console.info(
              `[chickpea] Requeued ${retried} Slack identity recovery turn(s) after reconnect`,
            );
          }
        }
      }
      return c.json({
        identity: await safeSlackIdentityResponse(c, identity),
        attachedProfileId: attachAgentId ?? null,
      });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.post('/admin/api/slack-identities/:identityId/refresh', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    const parsed = v.safeParse(slackIdentityRevisionOnlySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const configStore = store(c);
      const before = await configStore.getSlackIdentity(identityId);
      const refreshed = await refreshSlackIdentityHealth(
        {
          config: configStore,
          settings: settings(c),
          identityId,
          expectedRevision: parsed.output.expectedRevision,
        },
        options.slackIdentityBootstrap,
      );
      await appendSlackIdentityAudit(
        configStore,
        c,
        'slack_identity.refreshed',
        before,
        refreshed.identity,
      );
      return c.json({
        identity: await safeSlackIdentityResponse(c, refreshed.identity),
      });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.patch('/admin/api/slack-identities/:identityId/dms', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    const parsed = v.safeParse(slackIdentityDmSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    if (parsed.output.dmState === 'needs_setup') {
      return c.json({
        error: 'slack_identity_dm_state_invalid',
        message: 'Choose a DM handler or turn DMs off.',
      }, 400);
    }
    try {
      const configStore = store(c);
      const before = await configStore.getSlackIdentity(identityId);
      const dmAgentId = parsed.output.dmAgentId ?? before.dmAgentId;
      const identity = await configStore.setSlackIdentityDmBinding(
        identityId,
        parsed.output.expectedRevision,
        parsed.output.dmState,
        dmAgentId,
      );
      await appendSlackIdentityAudit(
        configStore,
        c,
        'slack_identity.dm_binding_changed',
        before,
        identity,
      );
      return c.json({ identity: await safeSlackIdentityResponse(c, identity) });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.post(
    '/admin/api/slack-identities/:identityId/profiles/:agentId',
    async (c) => {
      const identityId = c.req.param('identityId');
      const agentId = c.req.param('agentId');
      if (!isSlackIdentityId(identityId) || !AGENT_ID_PATTERN.test(agentId)) {
        return invalidRequest(c);
      }
      const parsed = v.safeParse(
        slackIdentityAttachProfileSchema,
        await readJson(c.req),
      );
      if (!parsed.success) return invalidRequest(c);
      try {
        const configStore = store(c);
        const before = await configStore.getSlackIdentity(identityId);
        if (parsed.output.preflightOnly) {
          if (before.lifecycle !== 'connected' && before.lifecycle !== 'degraded') {
            throw new SlackIdentityLifecycleError(
              before.id,
              'assign',
              before.lifecycle,
            );
          }
          if (before.connectionRevision !== parsed.output.expectedRevision) {
            throw new SlackIdentityRevisionConflictError(
              before.id,
              parsed.output.expectedRevision,
              before.connectionRevision,
            );
          }
          const currentProfile = await configStore.getAgent(agentId);
          const currentIdentityId = currentProfile.slackIdentityId ?? null;
          if (currentIdentityId !== parsed.output.expectedProfileIdentityId) {
            throw new AgentSlackIdentityConflictError(
              agentId,
              parsed.output.expectedProfileIdentityId,
              currentIdentityId,
            );
          }
        }
        const readiness = await preflightSlackIdentityMembership({
          config: configStore,
          settings: settings(c),
          ...((c.env as PlatformEnv | undefined) !== undefined
            ? { env: c.env as PlatformEnv }
            : {}),
          identityId,
          agentId,
          acknowledgeUnenumeratedChannels:
            parsed.output.acknowledgeUnenumeratedChannels,
        });
        if (!readiness.ready) return c.json(readiness, 409);
        if (parsed.output.preflightOnly) {
          return c.json({
            profile: await configStore.getAgent(agentId),
            identity: await safeSlackIdentityResponse(c, before),
            membership: readiness,
            preflightOnly: true,
            newThreadsOnly: true,
          });
        }
        const profile = await configStore.attachAgentToSlackIdentity(
          agentId,
          identityId,
          parsed.output.expectedRevision,
          parsed.output.expectedProfileIdentityId,
        );
        await appendSlackIdentityAudit(
          configStore,
          c,
          'slack_identity.profile_attached',
          before,
          before,
        );
        return c.json({
          profile,
          identity: await safeSlackIdentityResponse(c, before),
          membership: readiness,
          newThreadsOnly: true,
        });
      } catch (error) {
        return slackIdentityAdminError(c, error);
      }
    },
  );

  app.post('/admin/api/slack-identities/:identityId/cancel', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    const parsed = v.safeParse(slackIdentityCancelSchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const configStore = store(c);
      const before = await configStore.getSlackIdentity(identityId);
      if (before.setupIntent?.reconnecting) {
        return c.json({
          error: 'slack_identity_reconnect_cancel_unsupported',
          message:
            'Finish signed verification or replace the credentials again; an established identity cannot be deleted as a setup draft.',
        }, 409);
      }
      const canceled = await cancelSlackIdentityConnection({
        config: configStore,
        settings: settings(c),
        identityId,
        expectedRevision: parsed.output.expectedRevision,
      });
      let deleted = false;
      if (parsed.output.deleteDraft) {
        deleted = await configStore.deleteIncompleteSlackIdentity(
          identityId,
          canceled.connectionRevision,
          true,
        );
      }
      await appendSlackIdentityAudit(
        configStore,
        c,
        'slack_identity.setup_canceled',
        before,
        canceled,
      );
      return c.json({
        ok: true,
        deleted,
        ...(deleted ? {} : { identity: await safeSlackIdentityResponse(c, canceled) }),
      });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  app.post('/admin/api/slack-identities/:identityId/retire', async (c) => {
    const identityId = c.req.param('identityId');
    if (!isSlackIdentityId(identityId)) return invalidRequest(c);
    const parsed = v.safeParse(slackIdentityRevisionOnlySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      const configStore = store(c);
      const before = await configStore.getSlackIdentity(identityId);
      const references = await configStore.getSlackIdentityReferences(identityId);
      const pendingDeliveryCount = await countSlackIdentityPendingDeliveries(
        slackState(c),
        identityId,
        true,
      );
      if (
        references.profileIds.length > 0 ||
        before.dmState !== 'off' ||
        pendingDeliveryCount > 0
      ) {
        const profiles = await Promise.all(
          references.profileIds.map((profileId) => configStore.getAgent(profileId)),
        );
        return c.json({
          error: 'slack_identity_retirement_blocked',
          profiles: profiles.map(({ id, name }) => ({ id, name })),
          dmState: before.dmState,
          dmAgentId: before.dmAgentId ?? null,
          pendingDeliveryCount,
        }, 409);
      }
      const retired = await configStore.retireSlackIdentity(
        identityId,
        parsed.output.expectedRevision,
      );
      const credentials = await resolveSlackIdentityCredentials(
        identityId,
        c.env as PlatformEnv | undefined,
        settings(c),
      );
      await clearSlackIdentityCredentials(
        settings(c),
        identityId,
        credentials.connectionRevision,
      );
      const secretFree = await configStore.updateSlackIdentity(
        identityId,
        retired.connectionRevision,
        { credentialProvenance: 'none' },
      );
      await appendSlackIdentityAudit(
        configStore,
        c,
        'slack_identity.retired',
        before,
        secretFree,
      );
      return c.json({
        identity: await safeSlackIdentityResponse(c, secretFree),
        slackAppUninstalled: false,
        slackAppRevoked: false,
        message:
          'Retired this Slack identity locally. The Slack app was not uninstalled or revoked.',
      });
    } catch (error) {
      return slackIdentityAdminError(c, error);
    }
  });

  // First-run Slack-connection wizard state: per-credential provenance
  // (env > stored > missing) plus the manifest deep-link with this install's
  // events URL substituted server-side — the one setup step every Slack bot
  // makes users do by hand. Passing the settings store explicitly bypasses
  // the resolver's 60s cache, so the card always shows fresh provenance.
  app.get('/admin/api/slack-connection', async (c) => {
    try {
      const settingsStore = settings(c);
      const credentials = await describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
      // STORED-only (no network on admin load): the connected workspace name is
      // populated by the wizard save for new installs, and by the first
      // channels-list / assignment backfill for pre-existing ones.
      const teamInfo = await readStoredSlackTeamInfo(c.env as PlatformEnv | undefined, settingsStore);
      const requestUrl = `${requestOrigin(c)}/channels/slack/events`;
      return c.json({
        credentials,
        // Connected = both wire credentials resolvable somewhere. The bot
        // user id is not required for a connection (it resolves via
        // auth.test at event time when absent).
        connected: credentials.botToken !== 'missing' && credentials.signingSecret !== 'missing',
        teamId: teamInfo.teamId ?? null,
        teamName: teamInfo.teamName ?? null,
        requestUrl,
        manifestUrl: slackManifestUrl(requestOrigin(c)),
      });
    } catch (err) {
      return internalError(c, err);
    }
  });

  // Slack owns the install-wide bot name and avatar. Read both live so the
  // Channels admin shows what people actually see, then provide the exact app
  // settings deep-link where an owner can change them. This is intentionally
  // read-only: Slack's profile mutation API requires a user token, while this
  // app stores only the least-privileged bot token used at runtime.
  app.get('/admin/api/slack-identity', async (c) => {
    let botToken: string | undefined;
    let botUserId: string | undefined;
    try {
      const credentials = await resolveSlackCredentials(
        c.env as PlatformEnv | undefined,
        settings(c),
      );
      botToken = credentials.botToken;
      botUserId = credentials.botUserId;
    } catch (err) {
      return internalError(c, err);
    }
    if (!botToken) {
      return c.json({ error: 'slack_not_configured' }, 409);
    }

    try {
      let auth: Awaited<ReturnType<typeof slackIdentityAuthTest>> | undefined;
      // An empty bot user ID is intentional for the event lane: it prevents
      // event-time auth.test discovery and keeps message-family events
      // fail-closed. This operator-initiated presentation read is separate,
      // however, and needs a live identity to show the connected installation.
      if (!botUserId) {
        auth = await slackIdentityAuthTest(botToken);
        botUserId = auth.botUserId;
      }
      if (!botUserId || (auth && !auth.ok)) {
        throw new Error('Slack could not resolve the bot user');
      }

      let identity = await slackBotIdentityInfo(botToken, botUserId);
      // A bot id saved with this token should remain stable, but recover once
      // through auth.test if Slack explicitly says that user no longer exists.
      if (!identity.ok && identity.error === 'user_not_found' && !auth) {
        auth = await slackIdentityAuthTest(botToken);
        if (auth.ok && auth.botUserId && auth.botUserId !== botUserId) {
          botUserId = auth.botUserId;
          identity = await slackBotIdentityInfo(botToken, botUserId);
        }
      }
      if (!identity.ok) {
        throw new Error('Slack could not read the bot profile');
      }

      // A stored bot ID avoids auth.test on the usual path, but users.info
      // does not always include profile.api_app_id. Probe only to recover the
      // precise settings link; a failed secondary probe must not hide a valid
      // live name/avatar card behind an error state.
      if (!auth && !identity.appId) {
        try {
          const appIdentity = await slackIdentityAuthTest(botToken);
          if (appIdentity.ok) auth = appIdentity;
        } catch {
          // The identity itself is already valid; retain the generic apps link.
        }
      }

      const appIdCandidate = auth?.appId ?? identity.appId;
      const appId = appIdCandidate && /^[A-Z0-9]+$/i.test(appIdCandidate)
        ? appIdCandidate
        : null;
      const avatarUrl = safeHttpsUrl(identity.avatarUrl);
      return c.json({
        displayName:
          identity.displayName || slackAppManifest.features.bot_user.display_name,
        avatarUrl,
        botUserId,
        appId,
        consoleUrl: appId
          ? `https://api.slack.com/apps/${appId}/general`
          : 'https://api.slack.com/apps',
      });
    } catch (err) {
      console.error(
        '[chickpea] Slack identity lookup failed:',
        err instanceof Error ? err.message : String(err),
      );
      return c.json({
        error: 'slack_identity_unavailable',
        message: 'Slack identity could not be loaded.',
      }, 502);
    }
  });

  // Wizard paste-back: validate the bot token LIVE via auth.test (so the
  // paste feels instant and verified), then persist token + signing secret +
  // the auth.test bot user id in the settings store. Environment values keep
  // precedence at resolution time, so storing while env creds exist is
  // harmless. The signing secret cannot be pre-validated — Slack only proves
  // it on the first signed event; the response says so.
  app.post('/admin/api/slack-connection', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(slackConnectionSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    // Trim and require non-empty AFTER trimming: a whitespace-only value clears
    // the schema's min-length but would store as empty and resolve back as
    // 'missing', so reject it as an invalid request before touching Slack.
    const botToken = parsed.output.botToken.trim();
    const signingSecret = parsed.output.signingSecret.trim();
    if (!botToken || !signingSecret) {
      return invalidRequest(c);
    }
    let settingsStore: SettingsStore;
    let expectedRevision: string | null;
    let defaultIdentityBefore: SlackIdentity;
    let priorCredentialSources: SlackCredentialSources;
    try {
      settingsStore = settings(c);
      expectedRevision = await readSlackConnectionRevision(settingsStore);
      defaultIdentityBefore = await store(c).getSlackIdentity(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      );
      priorCredentialSources = await describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
    } catch (err) {
      return internalError(c, err);
    }
    let auth;
    try {
      auth = await slackAuthTest(botToken);
    } catch (err) {
      // Distinct from a rejected token: Slack (or the SLACK_API_URL override)
      // could not be reached at all — retriable, nothing stored.
      console.error(
        '[chickpea] wizard auth.test unreachable:',
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
    try {
      const nextRevision = randomUUID();
      const writes = [
        { key: SLACK_SETTING_KEYS.connectionRevision, value: nextRevision },
        { key: SLACK_SETTING_KEYS.botToken, value: botToken },
        { key: SLACK_SETTING_KEYS.signingSecret, value: signingSecret },
        ...(auth.botUserId
          ? [{ key: SLACK_SETTING_KEYS.botUserId, value: auth.botUserId }]
          : []),
        ...(auth.teamId
          ? [
              { key: SLACK_SETTING_KEYS.teamId, value: auth.teamId },
              {
                key: SLACK_SETTING_KEYS.teamTokenFingerprint,
                value: slackTokenFingerprint(botToken),
              },
            ]
          : []),
        ...(auth.teamName
          ? [{ key: SLACK_SETTING_KEYS.teamName, value: auth.teamName }]
          : []),
      ];
      const deletes = [
        ...(auth.botUserId ? [] : [SLACK_SETTING_KEYS.botUserId]),
        ...(auth.teamId
          ? []
          : [SLACK_SETTING_KEYS.teamId, SLACK_SETTING_KEYS.teamTokenFingerprint]),
        ...(auth.teamName ? [] : [SLACK_SETTING_KEYS.teamName]),
      ];
      // Persist the connected workspace identity from the same auth.test: the
      // admin names the workspace, and the assignment PUT rejects channels from
      // any OTHER workspace against this stored team id.
      const applied = await settingsStore.applySettingsPatch({
        expected: {
          key: SLACK_SETTING_KEYS.connectionRevision,
          value: expectedRevision,
        },
        set: writes,
        delete: deletes,
      });
      if (!applied) {
        return c.json(
          {
            error: 'slack_connection_changed',
            message: 'Slack connection changed while credentials were being validated. Try again.',
          },
          409,
        );
      }
      // Prime the resolver cache in THIS isolate so the very next signed
      // event verifies with the just-stored secret instead of waiting out
      // the cache TTL.
      primeStoredSlackCredentials({
        botToken,
        signingSecret,
        botUserId: auth.botUserId,
      }, nextRevision);
      await appendSlackIdentityAudit(
        store(c),
        c,
        priorCredentialSources.botToken === 'missing' ||
            priorCredentialSources.signingSecret === 'missing'
          ? 'slack_identity.credentials_connected'
          : 'slack_identity.credentials_rotated',
        defaultIdentityBefore,
        defaultIdentityBefore,
      );
      return c.json({
        ok: true,
        ...(auth.teamId ? { teamId: auth.teamId } : {}),
        ...(auth.teamName ? { team: auth.teamName } : {}),
        ...(auth.botName ? { botName: auth.botName } : {}),
        ...(auth.botUserId ? { botUserId: auth.botUserId } : {}),
        note: 'Signing secret saved; Slack proves it on the first signed event.',
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
        )
      ).botToken;
    } catch (err) {
      return internalError(c, err);
    }
    if (!botToken) {
      return c.json({ error: 'slack_not_configured' }, 409);
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

  // Disconnect is a LOCAL credential removal, not a Slack uninstall/revoke.
  // Environment-managed credentials cannot be removed from a browser, and a
  // partial stored install is treated as read-only rather than implying the
  // app has been fully disconnected.
  app.delete('/admin/api/slack-connection', async (c) => {
    try {
      const settingsStore = settings(c);
      const configStore = store(c);
      const defaultIdentityBefore = await configStore.getSlackIdentity(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      );
      const dedicatedWithCredentials: Array<{ id: string; name: string }> = [];
      for (const identity of await configStore.listSlackIdentities()) {
        if (identity.kind !== 'dedicated') continue;
        const credentials = await resolveSlackIdentityCredentials(
          identity.id,
          c.env as PlatformEnv | undefined,
          settingsStore,
        );
        if (credentials.botToken || credentials.signingSecret) {
          dedicatedWithCredentials.push({
            id: identity.id,
            name: identity.observedDisplayName ??
              identity.setupIntent?.displayName ??
              identity.id,
          });
        }
      }
      if (dedicatedWithCredentials.length > 0) {
        return c.json({
          error: 'slack_dedicated_identities_connected',
          message:
            'Cancel or retire every credentialed dedicated Slack identity before disconnecting @Chickpea.',
          identities: dedicatedWithCredentials,
        }, 409);
      }
      const expectedRevision = await readSlackConnectionRevision(settingsStore);
      const sources = await describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
      if (sources.botToken !== 'stored' || sources.signingSecret !== 'stored') {
        return c.json({ error: 'slack_connection_read_only' }, 409);
      }

      const nextRevision = randomUUID();
      const applied = await settingsStore.applySettingsPatch({
        expected: {
          key: SLACK_SETTING_KEYS.connectionRevision,
          value: expectedRevision,
        },
        set: [{ key: SLACK_SETTING_KEYS.connectionRevision, value: nextRevision }],
        delete: [
          SLACK_SETTING_KEYS.botToken,
          SLACK_SETTING_KEYS.signingSecret,
          SLACK_SETTING_KEYS.botUserId,
          SLACK_SETTING_KEYS.teamId,
          SLACK_SETTING_KEYS.teamName,
          SLACK_SETTING_KEYS.teamTokenFingerprint,
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
      // Replace (rather than merely invalidate) this isolate's credential
      // cache so the next event fails closed immediately without a store read.
      primeStoredSlackCredentials({
        botToken: undefined,
        signingSecret: undefined,
        botUserId: undefined,
      }, nextRevision);
      await appendSlackIdentityAudit(
        configStore,
        c,
        'slack_identity.credentials_disconnected',
        defaultIdentityBefore,
        defaultIdentityBefore,
      );
      return c.json({
        ok: true,
        connected: false,
        slackAppUninstalled: false,
        slackAppRevoked: false,
        configurationPreserved: true,
        message:
          'Disconnected Chickpea locally. The Slack app was not uninstalled or revoked, and profiles, channel assignments, transcripts, and the public URL were preserved.',
      });
    } catch (err) {
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
  // (/admin/profiles, /admin/channels/T/C, ...) serves the same page so deep
  // links and refreshes work. Unmatched /admin/api/* stays a 404, never HTML.
  app.get('/admin/sessions', (c) => c.redirect('/admin/channels'));
  app.get('/admin/sessions/*', (c) => c.redirect('/admin/channels'));
  app.get('/admin/*', (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/admin/api/')) return c.notFound();
    return adminPage(c);
  });

  return app;
}

function mcpOAuthAdminRedirect(
  status: 'connected' | 'cancelled' | 'failed' | 'verification_failed',
  ref: { agentId: string; connectionId: string },
): string {
  return (
    `/admin/profiles/${encodeURIComponent(ref.agentId)}` +
    `?oauth=${status}&connection=${encodeURIComponent(ref.connectionId)}`
  );
}

function apiOAuthAdminRedirect(
  status: 'connected' | 'cancelled' | 'failed',
  ref: ApiOAuthRef,
): string {
  return (
    `/admin/profiles/${encodeURIComponent(ref.agentId)}` +
    `?oauth=${status}&connection=${encodeURIComponent(ref.connectionId)}&lane=api`
  );
}

async function isCurrentApiOAuthConnection(
  configStore: Pick<ConfigStore, 'getAgent'>,
  ref: ApiOAuthRef,
  provider: ApiOAuthProvider,
): Promise<boolean> {
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
): Promise<void> {
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
): Promise<void> {
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
}

async function verifyAndStoreMcpOAuthConnection(
  input: VerifyMcpOAuthConnectionInput,
): Promise<void> {
  const agent = await input.configStore.getAgent(input.ref.agentId);
  const connection = agent.mcpServers.find(
    (entry) => entry.id === input.ref.connectionId,
  );
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
    });
  } catch (error) {
    await replaceVerifiedMcpConnection(input.configStore, input.ref, connection, {
      lifecycleStatus: 'failed',
      statusText: safeMcpFailureText(error),
      lastCheckedAt: Date.now(),
    }).catch(() => undefined);
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
): Promise<void> {
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

function safeHttpsUrl(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

function authResponseHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

function invitationJoinCsp(): string {
  return "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
}

function passwordCapabilityError(
  c: Context,
  error: unknown,
  fallback: 'join_unavailable' | 'reset_unavailable',
) {
  if (error instanceof PasswordLifecycleError && [
    'conflict',
    'existing_account',
    'already_enrolled',
    'suspended',
  ].includes(error.code)) {
    return c.json({ error: error.code }, 409);
  }
  return c.json({ error: fallback }, 401);
}

function isValidRecoveryConfiguration(token: string): boolean {
  try {
    validRecoveryToken(token);
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
    // Cloudflare Access can omit Origin on a protected browser form POST. In
    // that case, Fetch Metadata is the remaining browser-authenticated CSRF
    // signal: only an exact same-origin navigation is accepted. `same-site`
    // is deliberately insufficient because a sibling subdomain is not this
    // Admin origin.
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
function slackManifestUrl(origin: string): string {
  const { $schema: _schema, ...manifest } = slackAppManifest;
  const json = JSON.stringify(manifest).replaceAll('https://<YOUR_PUBLIC_HOST>', origin);
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(json)}`;
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

function permissionForAdminRequest(c: Context, principal: AuthPrincipal): Permission {
  if (principal.role === 'member' && isAdminPageGet(c)) return 'account.view';
  if (c.req.path === '/admin/account' || c.req.path === '/admin/api/account' ||
      c.req.path === '/admin/account/password' || c.req.path === '/admin/logout') {
    return 'account.view';
  }
  if (c.req.path === '/admin/team' || c.req.path.startsWith('/admin/api/team')) return 'team.manage';
  return 'admin.configure';
}

function machinePrincipalAllowed(c: Context): boolean {
  const path = c.req.path;
  return path.startsWith('/admin/api/') &&
    path !== '/admin/api/account' &&
    !path.startsWith('/admin/api/team');
}

function validJsonMutation(c: Context, canonicalOrigin: string): boolean {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const fetchSite = c.req.header('sec-fetch-site')?.toLowerCase();
  return (
    contentType === 'application/json' &&
    c.req.header('origin') === canonicalOrigin &&
    (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'same-site')
  );
}

function isAdminLoginPost(c: Context): boolean {
  return c.req.method === 'POST' && c.req.path === '/admin/login';
}

async function readAdminLogin(
  c: Context,
): Promise<{
  token: string | undefined;
  email: string | undefined;
  password: string | undefined;
  returnTo: string;
}> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentLength = Number(c.req.header('content-length'));
  if (
    contentType !== 'application/x-www-form-urlencoded' ||
    (Number.isFinite(contentLength) && contentLength > MAX_ADMIN_LOGIN_BODY_BYTES)
  ) {
    return { token: undefined, email: undefined, password: undefined, returnTo: '/admin' };
  }

  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_ADMIN_LOGIN_BODY_BYTES) {
    return { token: undefined, email: undefined, password: undefined, returnTo: '/admin' };
  }
  const params = new URLSearchParams(raw);
  return {
    token: params.get('token') ?? undefined,
    email: params.get('email') ?? undefined,
    password: params.get('password') ?? undefined,
    returnTo: safeAdminReturnPath(params.get('returnTo')),
  };
}

function isHumanAuthFormMutation(c: Context): boolean {
  return c.req.method === 'POST' && [
    '/admin/account/password',
    '/admin/logout',
  ].includes(c.req.path);
}

function preservedFormValue(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
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

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer (.+)$/);
  return match?.[1];
}

// Cookie value = a hash of the admin token, so the cookie is not itself the
// admin credential (can't be sent as a Bearer, doesn't leak TAG_ADMIN_TOKEN).
function cookieTokenFor(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isHttps(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toAgentConfig(input: v.InferOutput<typeof agentSchema>): CustomAgentConfig {
  return {
    id: input.id,
    name: input.name,
    instructions: input.instructions,
    enabled: input.enabled,
    ...(input.model !== undefined ? { model: input.model } : {}),
    skills: input.skills,
    mcpServers: toMcpServers(input.mcpServers),
    apiConnections: toApiConnections(input.apiConnections),
    repositories: toRepositories(input.repositories),
  };
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

type AgentPatch = Partial<Omit<CustomAgentConfig, 'id' | 'model'>> & { model?: string | null };

function toAgentPatch(input: v.InferOutput<typeof agentPatchSchema>): AgentPatch {
  const patch: AgentPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.model !== undefined) patch.model = input.model;
  if (input.skills !== undefined) patch.skills = input.skills;
  if (input.mcpServers !== undefined) patch.mcpServers = toMcpServers(input.mcpServers);
  if (input.apiConnections !== undefined) {
    patch.apiConnections = toApiConnections(input.apiConnections);
  }
  if (input.repositories !== undefined) {
    patch.repositories = toRepositories(input.repositories);
  }
  return patch;
}

async function slackIdentityAdminResponse(
  identity: SlackIdentity,
  configStore: ConfigStore,
  globalDmAllowed: boolean,
  slackStateStore: SlackStateStore,
  workspaceCredentialSources?: SlackCredentialSources | Promise<SlackCredentialSources>,
) {
  const profiles = await configStore.listAgentsForSlackIdentity(identity.id);
  let dmProfile: CustomAgentConfig | undefined;
  if (identity.dmAgentId) {
    try {
      dmProfile = await configStore.getAgent(identity.dmAgentId);
    } catch (error) {
      if (!(error instanceof UnknownAgentError)) throw error;
    }
  }
  const pendingDeliveryCount = await countSlackIdentityPendingDeliveries(
    slackStateStore,
    identity.id,
  );
  const credentialSources = identity.kind === 'workspace_default'
    ? await workspaceCredentialSources
    : undefined;
  const workspaceDefaultConnected = identity.kind === 'workspace_default'
    ? credentialSources?.botToken !== 'missing' &&
      credentialSources?.signingSecret !== 'missing'
    : undefined;
  return {
    id: identity.id,
    kind: identity.kind,
    lifecycle: identity.kind === 'workspace_default'
      ? (workspaceDefaultConnected ? 'connected' : 'setup_incomplete')
      : identity.lifecycle,
    teamId: identity.teamId ?? null,
    appId: identity.appId ?? null,
    botUserId: identity.botUserId ?? null,
    dmState: identity.dmState,
    effectiveDmState: globalDmAllowed ? identity.dmState : 'off',
    globalDmAllowed,
    dmAgentId: identity.dmAgentId ?? null,
    dmProfile: dmProfile
      ? { id: dmProfile.id, name: dmProfile.name, enabled: dmProfile.enabled }
      : null,
    credentialProvenance: identity.credentialProvenance,
    credentialsWritable:
      identity.kind === 'dedicated' ||
      (credentialSources?.botToken === 'stored' &&
        credentialSources.signingSecret === 'stored'),
    connectionRevision: identity.connectionRevision,
    displayName: identity.observedDisplayName ??
      identity.setupIntent?.displayName ??
      (identity.kind === 'workspace_default' ? 'Chickpea' : null),
    avatarUrl: safeHttpsUrl(identity.observedAvatarUrl),
    observedAt: identity.observedAt ?? null,
    health: identity.kind === 'workspace_default' && !workspaceDefaultConnected
      ? 'disconnected'
      : identity.health,
    healthDetail: identity.healthDetail ?? null,
    consoleUrl: slackIdentityConsoleUrl(identity.appId),
    profiles: profiles.map(({ id, name, enabled }) => ({ id, name, enabled })),
    pendingDeliveryCount,
    setupSourceProfileId: identity.setupIntent?.sourceAgentId ?? null,
    setupReconnecting: identity.setupIntent?.reconnecting === true,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    retiredAt: identity.retiredAt ?? null,
  };
}

async function countSlackIdentityPendingDeliveries(
  slackStateStore: SlackStateStore,
  identityId: string,
  failClosed = false,
): Promise<number> {
  if (failClosed) {
    return slackStateStore.countPendingDeliveriesForSlackIdentity(identityId);
  }
  try {
    return await slackStateStore.countPendingDeliveriesForSlackIdentity(identityId);
  } catch {
    if (!slackStateStore.listPendingTurns) return 0;
  }
  try {
    return (await slackStateStore.listPendingTurns()).filter(
      ({ turn, assignment }) =>
        (turn.slackIdentityId ?? assignment.slackIdentityId ??
          WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) === identityId,
    ).length;
  } catch {
    // A missing or unavailable inventory must not make safe identity reads fail.
    return 0;
  }
}

type SlackIdentityMembershipReadiness =
  | {
      ready: true;
      checkedChannels: Array<{ workspaceId: string; channelId: string; label: string }>;
      joinedChannels: Array<{ workspaceId: string; channelId: string; label: string }>;
      unenumeratedRules: Array<{ workspaceId: string; channelId: string }>;
    }
  | {
      ready: false;
      error: string;
      message: string;
      channels?: Array<{ workspaceId: string; channelId: string; label: string }>;
      unenumeratedRules?: Array<{ workspaceId: string; channelId: string }>;
    };

async function preflightSlackIdentityMembership(input: {
  config: ConfigStore;
  settings: SettingsStore;
  env?: PlatformEnv;
  identityId: string;
  agentId: string;
  acknowledgeUnenumeratedChannels: boolean;
}): Promise<SlackIdentityMembershipReadiness> {
  const identity = await input.config.getSlackIdentity(input.identityId);
  const assignments = await input.config.listAssignmentsForAgent(input.agentId);
  const unenumeratedRules = assignments
    .filter(({ workspaceId, channelId }) => workspaceId.includes('*') || channelId.includes('*'))
    .map(({ workspaceId, channelId }) => ({ workspaceId, channelId }));
  if (unenumeratedRules.length > 0 && !input.acknowledgeUnenumeratedChannels) {
    return {
      ready: false,
      error: 'slack_identity_unenumerated_channels',
      message:
        'Some channel rules cannot be enumerated. Invite this Slack app wherever those rules match; missing membership will fail closed.',
      unenumeratedRules,
    };
  }
  const concrete = assignments.filter(
    ({ workspaceId, channelId }) => !workspaceId.includes('*') && !channelId.includes('*'),
  );
  if (concrete.length === 0) {
    return { ready: true, checkedChannels: [], joinedChannels: [], unenumeratedRules };
  }
  const credentials = await resolveSlackIdentityCredentials(
    identity.id,
    input.env,
    input.settings,
  );
  if (!credentials.botToken) {
    return {
      ready: false,
      error: 'slack_identity_credentials_missing',
      message: 'Connect this Slack identity before assigning it to channels.',
    };
  }
  const checkedChannels: Array<{ workspaceId: string; channelId: string; label: string }> = [];
  const joinedChannels: Array<{ workspaceId: string; channelId: string; label: string }> = [];
  const missingChannels: Array<{ workspaceId: string; channelId: string; label: string }> = [];
  for (const assignment of concrete) {
    const label = assignment.channelLabel ?? assignment.channelId;
    const channel = {
      workspaceId: assignment.workspaceId,
      channelId: assignment.channelId,
      label,
    };
    if (identity.teamId && identity.teamId !== assignment.workspaceId) {
      missingChannels.push(channel);
      continue;
    }
    let info;
    try {
      info = await slackConversationsInfo(credentials.botToken, assignment.channelId);
    } catch {
      return {
        ready: false,
        error: 'slack_identity_membership_unavailable',
        message: 'Slack membership could not be verified. Try again before switching identities.',
      };
    }
    if (!info?.ok || !info.channel) {
      missingChannels.push(channel);
      continue;
    }
    const authoritative = {
      ...channel,
      label: info.channel.name ?? label,
    };
    checkedChannels.push(authoritative);
    if (info.channel.isMember) continue;
    if (info.channel.isPrivate === false) {
      try {
        const joined = await slackConversationsJoin(
          credentials.botToken,
          assignment.channelId,
        );
        if (joined.ok) {
          joinedChannels.push(authoritative);
          continue;
        }
      } catch {
        // The actionable invite blocker below is safer than pretending a join.
      }
    }
    missingChannels.push(authoritative);
  }
  if (missingChannels.length > 0) {
    return {
      ready: false,
      error: 'slack_identity_not_in_channels',
      message: 'Invite this Slack app to every listed channel before switching identities.',
      channels: missingChannels,
      ...(unenumeratedRules.length > 0 ? { unenumeratedRules } : {}),
    };
  }
  return { ready: true, checkedChannels, joinedChannels, unenumeratedRules };
}

async function appendSlackIdentityAudit(
  configStore: ConfigStore,
  c: Context,
  eventType: SlackIdentityAuditEventType,
  before: SlackIdentity,
  after: SlackIdentity,
): Promise<void> {
  const operation = eventType.slice('slack_identity.'.length);
  const suppliedRequestId = c.req.header('x-request-id')?.trim();
  const requestId = suppliedRequestId && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : randomUUID();
  await configStore.appendSlackIdentityAudit({
    eventId: randomUUID(),
    domain: 'slack_identity',
    eventType,
    outcome: 'success',
    actorClass: 'admin',
    actorId: null,
    workspaceId: after.teamId ?? before.teamId ?? null,
    subjectId: after.id,
    subjectVersion: after.connectionRevision,
    createdAt: Date.now(),
    metadataJson: JSON.stringify({
      operation,
      priorLifecycle: before.lifecycle,
      newLifecycle: after.lifecycle,
      requestId,
    }),
    idempotencyKey:
      `slack_identity:${after.id}:${operation}:${after.connectionRevision}:${requestId}:success`,
  });
}

function slackIdentityAdminError(c: Context, error: unknown) {
  if (error instanceof UnknownSlackIdentityError || error instanceof UnknownAgentError) {
    return c.json({ error: 'not_found' }, 404);
  }
  if (error instanceof SlackIdentityExistsError) {
    return c.json({ error: 'slack_identity_exists' }, 409);
  }
  if (error instanceof SlackIdentityRevisionConflictError) {
    return c.json({
      error: 'slack_identity_changed',
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
    }, 409);
  }
  if (error instanceof AgentSlackIdentityConflictError) {
    return c.json({
      error: 'profile_slack_identity_changed',
      profileId: error.agentId,
      expectedIdentityId: error.expectedIdentityId,
      actualIdentityId: error.actualIdentityId,
    }, 409);
  }
  if (error instanceof SlackIdentityStillReferencedError) {
    return c.json({
      error: 'slack_identity_still_referenced',
      profileIds: error.profileIds ? error.profileIds.split(', ').filter(Boolean) : [],
      dmAgentId: error.dmAgentId || null,
    }, 409);
  }
  if (
    error instanceof SlackIdentityLifecycleError ||
    error instanceof WorkspaceDefaultSlackIdentityProtectedError
  ) {
    return c.json({ error: 'slack_identity_lifecycle', message: error.message }, 409);
  }
  if (error instanceof SlackIdentityCredentialRevisionError) {
    return c.json({ error: 'slack_identity_credentials_changed' }, 409);
  }
  if (error instanceof SlackIdentityBootstrapError) {
    const status = error.code === 'slack_unreachable' ? 502 :
      error.code.endsWith('_missing') || error.code.endsWith('_expired') ? 409 : 422;
    return c.json({
      error: error.code,
      message: error.message,
      ...(error.missingScopes ? { missingScopes: error.missingScopes } : {}),
    }, status);
  }
  return internalError(c, error);
}

function isSlackIdentityId(identityId: string): boolean {
  return /^slack_identity_[a-z0-9_-]{1,96}$/.test(identityId);
}

function slackIdentitySetupUrl(identityId: string): string {
  return `/admin/settings/slack/identities/${encodeURIComponent(identityId)}/setup`;
}

function dedicatedSlackIdentitySetup(identity: SlackIdentity, origin: string) {
  const appName =
    identity.setupIntent?.appName ??
    identity.setupIntent?.displayName ??
    'Chickpea identity';
  const botDisplayName = identity.setupIntent?.displayName ?? appName;
  if (!safeHttpsUrl(origin)) {
    return {
      appName,
      botDisplayName,
      manifestUrl: null,
      manifestError:
        'Open Chickpea at its public HTTPS Admin URL to create this Slack app.',
    };
  }
  const requestUrl = `${origin}/channels/slack/events/${identity.ingressKey}`;
  const manifest = buildSlackIdentityManifest(slackAppManifest, {
    appName,
    botDisplayName,
    requestUrl,
  });
  return {
    appName,
    botDisplayName,
    manifestUrl: slackManifestPrefillUrl(manifest),
    manifestError: null,
  };
}

function toAssignment(input: v.InferOutput<typeof assignmentSchema>): ChannelAssignment {
  return {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    agentId: input.agentId,
    enabled: input.enabled,
    ...(input.channelLabel !== undefined ? { channelLabel: input.channelLabel } : {}),
    ...(input.channelPromptAddendum !== undefined
      ? { channelPromptAddendum: input.channelPromptAddendum }
      : {}),
    participationMode: input.participationMode ?? 'ambient',
  };
}

// Team-identity resolution that never throws: a backfill auth.test that cannot
// reach Slack must not fail the whole assignment PUT / channels GET — the caller
// treats an empty result as "team unknown, skip the workspace check".
async function resolveTeamInfoSafely(
  env: PlatformEnv | undefined,
  store: SettingsStore,
): Promise<SlackTeamInfo> {
  try {
    return await resolveSlackTeamInfo(env, store);
  } catch {
    return { teamId: undefined, teamName: undefined };
  }
}

function connectedWorkspaceLabel(team: SlackTeamInfo): string {
  if (team.teamName && team.teamId) return `${team.teamName} (${team.teamId})`;
  return team.teamName ?? team.teamId ?? 'the connected workspace';
}

function workspaceMismatchMessage(team: SlackTeamInfo, workspaceId: string): string {
  return (
    `Chickpea is connected to ${connectedWorkspaceLabel(team)}, but this channel belongs to a ` +
    `different workspace (${workspaceId}). Add Chickpea to ${team.teamName ?? 'the connected workspace'} ` +
    `in Slack, or connect Chickpea to that workspace instead.`
  );
}

function channelNotFoundMessage(channelId: string, team: SlackTeamInfo): string {
  const where = team.teamName ? ` in ${team.teamName}` : '';
  return (
    `Slack could not find channel ${channelId}${where}. Check for a typo, make sure the channel ` +
    `is in the connected workspace, and if it is private invite @Chickpea to it first — then try again.`
  );
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

function modelNotResolvable(
  c: { json(body: { error: string; message: string }, status: 422): Response },
  err: ModelResolutionError,
): Response {
  return c.json({ error: 'model_not_resolvable', message: err.message }, 422);
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function assignmentKey(c: { req: { query(name: string): string | undefined } }):
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

function openAiSubscriptionIsReady(
  status: Awaited<ReturnType<typeof getOpenAiSubscriptionAuthorizationStatus>>,
): boolean {
  return status.state === 'connected' || status.state === 'account_change_confirmation_required';
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

async function countPinnedProfiles(configStore: ConfigStore, provider: string): Promise<number> {
  const agents = await configStore.listAgents();
  return agents.filter((agent) => modelBelongsToProvider(agent.model, provider)).length;
}

function modelBelongsToProvider(model: string | undefined, provider: string): boolean {
  if (!model) {
    return false;
  }
  if (provider === 'workers-ai') {
    return model.startsWith('cloudflare/') || model.startsWith('cloudflare-workers-ai/');
  }
  return model.startsWith(`${provider}/`);
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

function effectiveConfigResponse(config: EffectiveSlackConfig): object {
  return {
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    agentId: config.agentId,
    slackIdentityId: config.slackIdentityId ?? WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    profile: {
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
