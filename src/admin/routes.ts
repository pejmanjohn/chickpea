import { createHash, randomUUID } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';

import { renderAdminLogin, renderAdminPage } from './page.ts';
import { createMemoryAdminApi } from './memory-api.ts';
import { createRoutineAdminApi } from './routines-api.ts';
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
  AgentExistsError,
  AgentStillAssignedError,
  ModelResolutionError,
  NoAssignmentError,
  UnknownAgentError,
} from '../config/errors.ts';
import {
  EGRESS_SETTING_KEY,
  parseEgressPolicy,
  type EgressPolicy,
} from '../config/egress.ts';
import {
  createInstallationToken,
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
import { parseSkillSource, resolveSkillSource, SkillImportError } from '../config/skill-import.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getConfigStore,
  getMemoryStateStore,
  getRoutineStore,
  getSettingsStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { MemoryStateStore } from '../memory/types.ts';
import type { RoutineStore } from '../routines/types.ts';
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
  openAiSubscriptionCapability,
  requireOpenAiSubscriptionEnabled,
  type OpenAiSubscriptionCapability,
} from '../openai-subscription/feature.ts';
import { OPENAI_SUBSCRIPTION_MODELS } from '../openai-subscription/protocol.ts';
import type {
  ChannelAssignment,
  CustomAgentConfig,
  McpConnectionConfig,
  McpConnectionIdentity,
} from '../config/types.ts';
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
  type SlackTeamInfo,
} from '../slack/credentials.ts';
import { constantTimeEquals } from '../slack/internal-auth.ts';

interface AdminRoutesOptions {
  // Injection seam for tests/harnesses: any async ConfigStore serves the
  // routes; absent, the platform backend is resolved per request (c.env is the
  // Cloudflare bindings object there; Node ignores it).
  store?: ConfigStore | undefined;
  // Same seam for the Slack-connection wizard's settings persistence.
  settings?: SettingsStore | undefined;
  memory?: MemoryStateStore | undefined;
  routines?: RoutineStore | undefined;
  adminToken?: string | undefined;
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
  openAiSubscriptionCapability?: ((env?: PlatformEnv) => OpenAiSubscriptionCapability) | undefined;
}

const ADMIN_COOKIE = 'flue_admin';
const MAX_ADMIN_LOGIN_BODY_BYTES = 4_096;

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const modelSpecifier = v.pipe(v.string(), v.regex(/^[^/]+\/.+$/));
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MCP_CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const agentIdSchema = v.pipe(v.string(), v.regex(AGENT_ID_PATTERN));
const openAiSubscriptionCapabilitySchema = v.object({
  attemptCapability: v.pipe(v.string(), v.minLength(32), v.maxLength(512)),
});
const openAiSubscriptionStartSchema = v.object({});
const openAiAuthMethodSchema = v.object({
  method: v.picklist(['api_key', 'subscription']),
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
});

const slackConnectionSchema = v.object({
  botToken: nonEmptyString,
  signingSecret: nonEmptyString,
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
  allowedHosts: v.array(v.picklist(SANDBOX_PACKAGE_REGISTRY_HOSTS)),
  monthlySessionCap: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)),
});

async function sandboxStatus(store: SettingsStore) {
  const resolved = await resolveSandboxSettings(store);
  const cloudflare = isCloudflareTarget();
  return {
    enabled: resolved.enabled,
    instanceType: resolved.instanceType,
    allowedHosts: resolved.allowedHosts,
    monthlySessionCap: resolved.monthlySessionCap,
    monthlySessionCapConfigured: resolved.monthlySessionCapConfigured,
    target: cloudflare ? ('cloudflare' as const) : ('node' as const),
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
    }),
  ),
  v.check((patch) => Object.keys(patch).length > 0),
);
export function createAdminRoutes(options: AdminRoutesOptions = {}): Hono {
  const app = new Hono();
  const tokenFromOptions = Object.hasOwn(options, 'adminToken');
  const store = (c: Context) => options.store ?? getConfigStore(c.env as PlatformEnv | undefined);
  const settings = (c: Context) =>
    options.settings ?? getSettingsStore(c.env as PlatformEnv | undefined);
  const memory = (c: Context) =>
    options.memory ?? getMemoryStateStore(c.env as PlatformEnv | undefined);
  const routines = (c: Context) =>
    options.routines ?? getRoutineStore(c.env as PlatformEnv | undefined);
  const adminToken = () =>
    tokenFromOptions ? options.adminToken : process.env.TAG_ADMIN_TOKEN;
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
  const subscriptionCapability = (c: Context): OpenAiSubscriptionCapability =>
    (options.openAiSubscriptionCapability ?? openAiSubscriptionCapability)(
      c.env as PlatformEnv | undefined,
    );
  const requireSubscriptionEnabled = (c: Context): void => {
    if (options.openAiSubscriptionCapability) {
      if (!subscriptionCapability(c).enabled) {
        throw new OpenAiSubscriptionError('preview_disabled');
      }
      return;
    }
    requireOpenAiSubscriptionEnabled(c.env as PlatformEnv | undefined);
  };
  const adminLoginBodyLimit = bodyLimit({
    maxSize: MAX_ADMIN_LOGIN_BODY_BYTES,
    onError: (c) =>
      c.html(renderAdminLogin({ invalidToken: true, returnTo: '/admin' }), 401),
  });

  const adminGate = async (c: Context, next: Next) => {
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
      return c.redirect(login.returnTo, 303);
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
  app.use('/admin/login', (c, next) =>
    adminToken() ? adminLoginBodyLimit(c, next) : next(),
  );
  app.use('/admin', adminGate);
  app.use('/admin/*', adminGate);
  app.use('/admin/api/*', async (c, next) => {
    const platformEnv = c.env as PlatformEnv | undefined;
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
    if (!slackConnectionTest && !slackDisconnect) {
      await persistRequestOrigin(c, settingsStore);
    }
    return next();
  });

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

  app.get('/admin', (c) => c.html(renderAdminPage()));

  app.route('/admin/api', createMemoryAdminApi({
    store: memory,
    adminSecret: () => adminToken() ?? '',
  }));
  app.route('/admin/api', createRoutineAdminApi({ store: routines }));

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

  // The profile picker's single source of provider groups + suggestions. Anthropic
  // and OpenAI keep their small dynamic catalogs; OpenRouter and the keyless
  // Workers AI binding show ONLY the user's starred favorites (curated in the
  // Settings managers), so this route folds those favorites into their
  // suggestions — the per-provider search/favorites endpoints stay the editors.
  app.get('/admin/api/models', async (c) => {
    const settingsStore = settings(c);
    const [subscription, activeAuthMethod] = await Promise.all([
      getOpenAiSubscriptionAuthorizationStatus(settingsStore),
      resolveOpenAiAuthMethod(settingsStore),
    ]);
    const capability = subscriptionCapability(c);
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
              ? capability.enabled && subscriptionConfigured
              : provider.configured,
            source: subscriptionActive ? 'ChatGPT subscription' : provider.source,
            suggestions: subscriptionActive
              ? OPENAI_SUBSCRIPTION_MODELS.map((model) => `openai/${model}`)
              : provider.suggestions,
            authMethods: {
              activeMethod: activeAuthMethod,
              apiKeyConfigured: provider.configured,
              subscription,
              subscriptionCapability: capability,
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
    const capability = subscriptionCapability(c);
    return c.json({
      providers: [
        ...PROVIDER_KEY_IDS.map((id) => ({
          ...providerSummary(id, sources[id]),
          ...(id === 'openai'
            ? { activeAuthMethod, subscription, subscriptionCapability: capability }
            : {}),
        })),
        providerSummary('workers-ai', workersAiStatus(platformEnv)),
      ],
    });
  });

  app.get('/admin/api/providers/openai/subscription', async (c) =>
    c.json({
      status: await getOpenAiSubscriptionAuthorizationStatus(settings(c)),
      capability: subscriptionCapability(c),
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
      if (!subscriptionCapability(c).enabled) {
        return c.json({
          error: 'preview_disabled',
          message: 'ChatGPT subscription connections are disabled for this installation.',
        }, 409);
      }
      const subscription = await getOpenAiSubscriptionAuthorizationStatus(settingsStore);
      if (!openAiSubscriptionIsReady(subscription)) {
        return c.json({
          error: 'openai_subscription_missing',
          message: 'Connect a ChatGPT subscription before selecting it.',
        }, 409);
      }
      const incompatibleProfiles = (await store(c).listAgents())
        .filter((agent) => agent.model?.startsWith('openai/'))
        .filter((agent) => !openAiSubscriptionSupportsModel(agent.model))
        .map(({ id, name, model }) => ({ id, name, model }));
      if (incompatibleProfiles.length > 0) {
        return c.json({
          error: 'openai_subscription_models_incompatible',
          message: 'Some OpenAI profiles use models that are not available through ChatGPT subscription.',
          profiles: incompatibleProfiles,
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
      requireSubscriptionEnabled(c);
      return c.json(await startOpenAiSubscriptionAuthorization(openAiSubscriptionDependencies(c)));
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.post('/admin/api/providers/openai/subscription/poll', async (c) => {
    const parsed = v.safeParse(openAiSubscriptionCapabilitySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      requireSubscriptionEnabled(c);
      return c.json(await pollOpenAiSubscriptionAuthorization(
        parsed.output,
        openAiSubscriptionDependencies(c),
      ));
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.post('/admin/api/providers/openai/subscription/confirm-account', async (c) => {
    const parsed = v.safeParse(openAiSubscriptionCapabilitySchema, await readJson(c.req));
    if (!parsed.success) return invalidRequest(c);
    try {
      requireSubscriptionEnabled(c);
      return c.json(await confirmOpenAiSubscriptionAccountChange(
        parsed.output,
        openAiSubscriptionDependencies(c),
      ));
    } catch (error) {
      return openAiSubscriptionRouteError(c, error);
    }
  });

  app.post('/admin/api/providers/openai/subscription/cancel', async (c) => {
    const parsed = v.safeParse(openAiSubscriptionCapabilitySchema, await readJson(c.req));
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
      return c.json({ status: await disconnectOpenAiSubscription(settings(c), {
        ...(options.openAiSubscriptionNow ? { now: options.openAiSubscriptionNow } : {}),
      }) });
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
      await saveProviderApiKey(id, apiKey, platformEnv, settingsStore);
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
    const resolved = await deleteProviderApiKey(id, platformEnv, settings(c));
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
      if (id === 'openai' && await resolveOpenAiAuthMethod(settingsStore) === 'subscription') {
        return c.json({
          provider: id,
          models: OPENAI_SUBSCRIPTION_MODELS.map((model) => ({ id: model })),
          cached: true,
        });
      }
      const result = await listProviderModels(id, {
        store: settingsStore,
        refresh: c.req.query('refresh') === '1',
        ...(platformEnv !== undefined ? { env: platformEnv } : {}),
      });
      return c.json({ provider: id, models: result.models, cached: result.cached });
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
    return c.json(await sandboxStatus(settings(c)));
  });

  app.put('/admin/api/sandbox/status', async (c) => {
    const parsed = v.safeParse(sandboxSettingsSchema, await readJson(c.req));
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const sandbox = parsed.output;
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
    return c.json(await sandboxStatus(settings(c)));
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
    await settings(c).setSetting(
      GITHUB_SETTING_KEYS.setupState,
      `${setupState}:${Date.now()}`,
    );
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
        redirect_url: `${origin}/admin/api/github/setup/callback`,
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

  app.get('/admin/api/github/setup/callback', async (c) => {
    const parsed = v.safeParse(githubCallbackSchema, { code: c.req.query('code') });
    if (!parsed.success) {
      return invalidRequest(c);
    }
    try {
      // Consume the single-use setup state BEFORE exchanging the code: a
      // mismatched or replayed callback must never reach the credential write.
      const state = c.req.query('state')?.trim() ?? '';
      const stored = await settings(c).getSetting(GITHUB_SETTING_KEYS.setupState);
      await settings(c).applySettingsPatch({ delete: [GITHUB_SETTING_KEYS.setupState] });
      const [storedState, mintedAtRaw] = (stored ?? '').split(':');
      const mintedAt = Number(mintedAtRaw);
      const fresh = Number.isFinite(mintedAt) && Date.now() - mintedAt < 15 * 60 * 1_000;
      if (!state || !storedState || state !== storedState || !fresh) {
        return c.json({ error: 'invalid_setup_state' }, 403);
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
          // Apps created without a webhook (localhost dev) return no secret.
          ...(conversion.webhookSecret
            ? [{ key: GITHUB_SETTING_KEYS.webhookSecret, value: conversion.webhookSecret }]
            : []),
        ],
        // A prior install may have left a webhook secret; clear it when the
        // new App has none so stale state can't linger.
        ...(conversion.webhookSecret ? {} : { delete: [GITHUB_SETTING_KEYS.webhookSecret] }),
      });
      // A registered app is useless until it's installed somewhere, so send
      // the operator straight to GitHub's install page — one continuous flow:
      // create → (this callback) → pick repos → setup_url back to Settings.
      return c.redirect(
        `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`,
        302,
      );
    } catch (err) {
      return internalError(c, err);
    }
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
    const openAiAuthError = openAiModelCompatibilityError(
      agent.model,
      await resolveOpenAiAuthMethod(settings(c)),
    );
    if (openAiAuthError) return invalidRequest(c, openAiAuthError);
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
      const openAiAuthError = openAiModelCompatibilityError(
        next.model,
        await resolveOpenAiAuthMethod(settings(c)),
      );
      if (openAiAuthError) return invalidRequest(c, openAiAuthError);
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
    try {
      settingsStore = settings(c);
      expectedRevision = await readSlackConnectionRevision(settingsStore);
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
  app.get('/admin/*', (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/admin/api/')) return c.notFound();
    return c.html(renderAdminPage());
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

function isAdminLoginPost(c: Context): boolean {
  return c.req.method === 'POST' && c.req.path === '/admin/login';
}

async function readAdminLogin(
  c: Context,
): Promise<{ token: string | undefined; returnTo: string }> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentLength = Number(c.req.header('content-length'));
  if (
    contentType !== 'application/x-www-form-urlencoded' ||
    (Number.isFinite(contentLength) && contentLength > MAX_ADMIN_LOGIN_BODY_BYTES)
  ) {
    return { token: undefined, returnTo: '/admin' };
  }

  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_ADMIN_LOGIN_BODY_BYTES) {
    return { token: undefined, returnTo: '/admin' };
  }
  const params = new URLSearchParams(raw);
  return {
    token: params.get('token') ?? undefined,
    returnTo: safeAdminReturnPath(params.get('returnTo')),
  };
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
    case 'preview_disabled':
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

function openAiModelCompatibilityError(
  model: string | null | undefined,
  method: 'api_key' | 'subscription',
): string | undefined {
  if (
    method === 'subscription' &&
    model?.startsWith('openai/') &&
    !(OPENAI_SUBSCRIPTION_MODELS as readonly string[]).includes(model?.slice('openai/'.length) ?? '')
  ) {
    return 'The selected ChatGPT subscription does not support this OpenAI model.';
  }
  return undefined;
}

function openAiSubscriptionSupportsModel(model: string | undefined): boolean {
  return Boolean(
    model?.startsWith('openai/') &&
    (OPENAI_SUBSCRIPTION_MODELS as readonly string[]).includes(model.slice('openai/'.length)),
  );
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
