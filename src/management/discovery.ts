import { connectionAccountOAuthRef } from '../config/api-oauth.ts';
import { resolveConnectionAccountSecret } from '../config/connector-secrets.ts';
import { matchesEgressPrefix } from '../config/egress.ts';
import {
  classifyMcpError,
  McpBlockedUrlError,
  safeMcpFailureText,
  type McpErrorCode,
} from '../config/mcp-errors.ts';
import { McpOAuthError, resolveMcpOAuthAccessToken } from '../config/mcp-oauth.ts';
import { buildMcpRequestHeaders } from '../config/mcp-secrets.ts';
import { discoverMcpTools, type McpDiscoveryResult } from '../config/mcp-test.ts';
import { sameMcpServerUrl, validateMcpUrl, type createMcpGuardedFetch } from '../config/mcp-url.ts';
import { resolveConnectionAccountMcpSecrets } from '../config/profile-mcp.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  checkConnection,
  connectionCheckUrl,
  connectionHeaderCredential,
  connectionUrlPrefixes,
  mcpCheckFailure,
  pathInsideConnection,
  type ApiConnectionCheck,
  type ApiConnectionScope,
  type ConnectionAuthShape,
  type ConnectionCheckOptions,
  type ConnectionCheckOutcome,
} from '../connections/connection-check.ts';
import { mcpOAuthLifecycleDependencies } from '../connections/mcp-oauth-lifecycle.ts';
import {
  isActiveConnectionActor,
  projectEffectiveConnectionAccounts,
  projectEffectiveMcpConnections,
  resolveConnectionSecretForInvocation,
  resolveEffectiveConnectionAccounts,
} from '../connections/runtime.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import { agentConnections, connectionSetupBinding, type AgentConnectionEntry } from './agent-connections.ts';
import { saveConnectionCredential } from './connection-credential.ts';
import { ManagementError, type ManagementOrigin, type SavedConnectionKeyCheck } from './types.ts';

/** The member testing a connection, in the workspace that owns its accounts. */
export interface ConnectionTestActor {
  workspaceId: string;
  actorMembershipId: string;
}

interface TestManagedConnectionInput {
  agentId: string;
  connectionId: string;
  actor: ConnectionTestActor;
  /** For an API connection: the path to GET on its first host, inside its scope. */
  path?: string;
  env?: PlatformEnv;
  config: ConfigStore;
  identity: Pick<
    IdentityStore,
    'getOrganization' | 'getMembership' | 'getMembershipAccessOverlay' | 'getUser' | 'resolveSlackIdentity'
  >;
  settings: SettingsStore;
  /** Test seam; production uses the SSRF-guarded fetch implementation. */
  createGuardedFetch?: typeof createMcpGuardedFetch;
  /** Test seam; production checks an API connection on the running target. */
  connectionCheck?: ConnectionCheckOptions;
}

export type McpConnectionTestResult =
  | { ok: true; tools: McpDiscoveryResult['tools'] }
  | { ok: false; code: McpErrorCode; message: string };

/** An MCP server that needs no credential, before Chickpea saves it. */
export interface OpenMcpServer {
  id: string;
  url: string;
  transport: 'streamable-http' | 'sse';
}

const NOT_FOUND = 'The connection was not found.';

/**
 * Checks one API or MCP connection with its saved credential, as the actor's
 * turn would use it: team accounts and the actor's own personal accounts,
 * never another member's.
 */
export async function testManagedConnection(
  input: TestManagedConnectionInput,
): Promise<ConnectionCheckOutcome> {
  const { actor } = input;
  const [accounts, bindings] = await Promise.all([
    input.config.listConnectionAccounts(actor.workspaceId),
    input.config.listAgentConnectionBindings(input.agentId),
  ]);
  const account = accounts.find(({ id }) => id === input.connectionId);
  if (!account || (account.policy.kind !== 'mcp' && account.policy.kind !== 'api') ||
      account.lifecycle === 'revoked' ||
      (account.ownerKind !== 'team' && account.ownerMembershipId !== actor.actorMembershipId) ||
      !bindings.some((binding) =>
        binding.connectionAccountId === account.id && binding.providerId === account.providerId)) {
    throw new ManagementError('invalid_request', NOT_FOUND);
  }
  if (account.policy.kind === 'api' && account.policy.authMode !== 'credential') {
    throw new ManagementError('invalid_request', 'Only API connections with a key and MCP connections can be tested. This one signs in with Google.');
  }
  if (input.path !== undefined && account.policy.kind !== 'api') {
    throw new ManagementError('invalid_request', 'path applies only to API connections.');
  }
  const selected = projectEffectiveConnectionAccounts(accounts, bindings, actor.actorMembershipId)
    .find((effective) => effective.account.id === account.id);
  if (!selected) {
    return {
      kind: 'inconclusive',
      detail: 'This connection is not ready for this Agent. Finish its setup, then test it again.',
    };
  }
  const { policy } = selected;
  if (policy.kind === 'api' && input.path !== undefined) assertPathInsideConnection(policy, input.path);
  const effective = async () => {
    if (!(await isActiveConnectionActor({ identity: input.identity, ...actor }))) {
      throw new Error('connection_changed');
    }
    return (await resolveEffectiveConnectionAccounts({ ...actor, config: input.config, agentId: input.agentId }))
      .find((entry) => entry.account.id === account.id);
  };
  const authorizeRequest = async () => {
    if ((await effective())?.account.revision !== account.revision) throw new Error('connection_changed');
  };
  const savedSecret = (connectionAccountId: string) => resolveConnectionSecretForInvocation({
    ...actor,
    config: input.config,
    settings: input.settings,
    identity: input.identity,
    ...(input.env ? { env: input.env } : {}),
    agentId: input.agentId,
    connectionAccountId,
  });
  if (policy.kind === 'api') {
    let credential: string;
    try {
      credential = await savedSecret(account.id);
    } catch {
      return {
        kind: 'inconclusive',
        url: connectionCheckUrl(policy, input.path) ?? '',
        detail: 'The saved key could not be read for this check.',
      };
    }
    return checkConnection({
      kind: 'api',
      connection: policy,
      credential,
      ...(input.path === undefined ? {} : { path: input.path }),
      authorize: async () => {
        try {
          await authorizeRequest();
          return true;
        } catch {
          return false;
        }
      },
    }, input.connectionCheck);
  }
  const server = projectEffectiveMcpConnections([selected])[0]!;
  let headers: Record<string, string>;
  try {
    const secrets = await resolveConnectionAccountMcpSecrets(server, savedSecret);
    if (server.authMode === 'oauth') {
      secrets.bearer = await resolveMcpOAuthAccessToken(
        { ref: connectionAccountOAuthRef(server.id), serverUrl: server.url },
        {
          settings: input.settings,
          refreshTelemetry: { trigger: 'admin' },
          ...mcpOAuthLifecycleDependencies(input.config, input.settings, actor.workspaceId),
          validateConnection: async (_ref, serverUrl, _revision, attemptId) => {
            const current = (await effective())?.policy;
            return current?.kind === 'mcp' && current.authMode === 'oauth' && sameMcpServerUrl(current.url, serverUrl) &&
              (attemptId === undefined || current.oauthAttemptId === attemptId);
          },
        },
      );
    }
    await authorizeRequest();
    headers = buildMcpRequestHeaders(server.authMode, secrets);
  } catch (error) {
    return mcpCheckFailure(error);
  }
  return checkConnection({
    kind: 'mcp',
    server: { id: server.id, url: server.url, transport: server.transport, headers, authorizeRequest },
  }, { discoverMcp: (target) => discoverMcpTools(target, undefined, input.createGuardedFetch) });
}

interface SaveManagedConnectionKeyInput {
  agentId: string;
  /** The connection account id. */
  connectionId: string;
  actor: ConnectionTestActor;
  key: string;
  path: string;
  /** basic_username saves base64 of `key:`, for a connection that sends `Authorization: Basic `. */
  authShape?: ConnectionAuthShape;
  /** The account revision whose hosts and paths the caller checked the key may reach. */
  expectedRevision: number;
  surface: ManagementOrigin['kind'];
  env?: PlatformEnv;
  config: ConfigStore;
  settings: SettingsStore;
  productTelemetry?: ProductTelemetryCapture;
  /** Test seam; production checks the key on the running target. */
  connectionCheck?: ConnectionCheckOptions;
}

const CONNECTION_CHANGED = 'The connection changed while the key was being saved, so nothing was saved. Inspect the workspace again, then retry.';

/** A check whose answer did not show the key works, so nothing was saved. */
export type RefusedConnectionKeyCheck = Exclude<ApiConnectionCheck, { kind: 'ok' }>;

/**
 * save_connection_key's refusal once its check saved nothing. With a setup
 * link for the same connection the model only relays it; without one, as
 * when the link could not be issued, the model is told how to get one.
 */
export class ConnectionKeyRefusedError extends ManagementError {
  constructor(
    readonly check: RefusedConnectionKeyCheck,
    setupLink?: { url: string; pastedInChat: boolean },
  ) {
    super(
      check.kind === 'key_rejected' ? 'key_rejected' : 'key_unconfirmed',
      setupLink ? refusalWithSetupLink(check, setupLink) : refusalWithoutSetupLink(check),
    );
  }
}

function checkFinding(check: RefusedConnectionKeyCheck): string {
  if (check.kind === 'key_rejected') {
    return `${new URL(check.url).host} rejected this key (HTTP 401), so nothing was saved.`;
  }
  const answer = check.status === undefined ? check.detail : `${check.url} answered HTTP ${check.status}.`;
  // Some APIs (Datadog, AWS API Gateway) answer 403 to an invalid key, so a 403 confirms nothing.
  const reading = check.kind === 'not_permitted'
    ? ' A 403 can mean the key is invalid or that it lacks access to that path.'
    : '';
  return `Nothing was saved, because Chickpea could not confirm the key. ${answer}${reading}`;
}

function refusalWithoutSetupLink(check: RefusedConnectionKeyCheck): string {
  return check.kind === 'key_rejected'
    ? `${checkFinding(check)} Tell the person the key did not work and send a setup link with request_setup for this connection, where they can enter a working key. Never ask them to paste a key in chat.`
    : `${checkFinding(check)} To check it, call save_connection_key again with path set to a read endpoint of this API that the key can read, such as a list endpoint, or send a setup link with request_setup. Never repeat the key.`;
}

function refusalWithSetupLink(
  check: RefusedConnectionKeyCheck,
  { url, pastedInChat }: { url: string; pastedInChat: boolean },
): string {
  const outcome = check.kind === 'key_rejected' ? 'the key did not work' : 'Chickpea could not confirm the key works';
  const rotate = pastedInChat ? ', suggest they rotate the key at the service because they pasted it in chat,' : '';
  return `${checkFinding(check)} Tell the person ${outcome}${rotate} and give them the setup link below, where they can enter the key on a Chickpea page. Never repeat the key, and never ask them to paste a key in chat. Setup link: ${url}`;
}

/**
 * Checks a key against one of an Agent's API connections with one GET and,
 * only when the answer shows the key works (2xx), saves it the way the setup
 * page does, so the account becomes ready. Unlike the setup page, it saves
 * nothing on any other answer: a 403 can mean an invalid key, and many APIs
 * give a 404 at a bare prefix whatever the key. The
 * check and the save are fenced on the account revision the caller checked.
 */
export async function saveManagedConnectionKey(
  input: SaveManagedConnectionKeyInput,
): Promise<SavedConnectionKeyCheck> {
  const entry = await memberApiConnection(input);
  const policy = entry?.account.policy;
  if (!entry || entry.account.revision !== input.expectedRevision ||
      policy?.kind !== 'api' || policy.authMode !== 'credential') {
    throw new ManagementError('invalid_request', CONNECTION_CHANGED);
  }
  assertPathInsideConnection(policy, input.path);
  const credential = connectionHeaderCredential(input.key, input.authShape);
  if (input.surface === 'slack' && await keySavedOnAnotherConnection({ ...input, key: credential }, entry.account.id)) {
    throw new ManagementError(
      'invalid_request',
      'Nothing was saved: this key is already saved on another of this Agent\'s connections, and a key pasted in chat fills one connection. Send a setup link with request_setup for this one.',
    );
  }
  const unchanged = async () =>
    (await memberApiConnection(input).catch(() => undefined))?.account.revision === entry.account.revision;
  const check = await checkConnection({
    kind: 'api',
    connection: policy,
    credential: input.key,
    ...(input.authShape ? { authShape: input.authShape } : {}),
    path: input.path,
    authorize: unchanged,
  }, input.connectionCheck);
  if (check.kind !== 'ok') throw new ConnectionKeyRefusedError(check);
  await saveConnectionCredential({
    config: input.config,
    settings: input.settings,
    platformEnv: input.env,
    productTelemetry: input.productTelemetry,
  }, entry, credential, {
    surface: input.surface,
    retired: async () => {
      try {
        const current = await memberApiConnection(input);
        return !current || connectionSetupBinding(current) !== connectionSetupBinding(entry);
      } catch {
        return undefined;
      }
    },
  });
  return check;
}

type UrlScope = Pick<ApiConnectionScope, 'allowedHosts' | 'pathPrefixes'>;

/** The connection a try stays inside: its account id and the revision the door admitted. */
export interface ConnectionTrialBound {
  connectionId: string;
  revision: number;
}

/**
 * The key one try sends. A pasted key may be bounded by the connection it is
 * meant for; a saved key always is, and is read from that connection.
 */
export type ConnectionTrialCredential =
  | { kind: 'key'; key: string; within?: ConnectionTrialBound }
  | { kind: 'saved'; within: ConnectionTrialBound };

/** One try_connection GET as the door admitted it. */
export interface ConnectionTrialRequest {
  agentId: string;
  actor: ConnectionTestActor;
  /** Where the key goes and in which header. Only GET is ever sent. */
  scope: Omit<ApiConnectionScope, 'allowedMethods'>;
  authShape: ConnectionAuthShape;
  path: string;
  credential: ConnectionTrialCredential;
}

interface TryManagedConnectionInput extends ConnectionTrialRequest {
  env?: PlatformEnv;
  config: ConfigStore;
  settings: SettingsStore;
  identity: TestManagedConnectionInput['identity'];
  /** Test seam; production checks on the running target. */
  connectionCheck?: ConnectionCheckOptions;
}

/**
 * Sends one GET for try_connection and saves nothing. A bounded try finds its
 * connection among the Agent's connections this member manages, never by an
 * account id alone, stays inside that connection's hosts and paths, and stops
 * if the connection changes before the request leaves.
 */
export async function tryManagedConnection(input: TryManagedConnectionInput): Promise<ApiConnectionCheck> {
  const { within } = input.credential;
  const scope: ApiConnectionScope = { ...input.scope, allowedMethods: ['GET'] };
  let authorize: (() => Promise<boolean>) | undefined;
  if (within) {
    const lookup = { agentId: input.agentId, connectionId: within.connectionId, actor: input.actor, config: input.config };
    const entry = await memberApiConnection(lookup);
    const policy = entry?.account.policy;
    if (!entry || entry.account.revision !== within.revision || policy?.kind !== 'api' ||
        policy.authMode !== 'credential') {
      throw new ManagementError('invalid_request', 'The connection changed, so nothing was sent. Inspect the workspace again, then retry.');
    }
    assertScopeInsideConnection(scope, policy);
    authorize = async () => (await memberApiConnection(lookup).catch(() => undefined))?.account.revision === within.revision;
  }
  assertPathInsideConnection(scope, input.path);
  let key: string;
  if (input.credential.kind === 'key') {
    key = input.credential.key;
  } else {
    try {
      key = await resolveConnectionSecretForInvocation({
        ...input.actor,
        config: input.config,
        settings: input.settings,
        identity: input.identity,
        ...(input.env ? { env: input.env } : {}),
        agentId: input.agentId,
        connectionAccountId: input.credential.within.connectionId,
      });
    } catch {
      return {
        kind: 'inconclusive',
        url: connectionCheckUrl(scope, input.path) ?? '',
        detail: 'The saved key could not be read for this check.',
      };
    }
  }
  return checkConnection({
    kind: 'api',
    connection: scope,
    credential: key,
    authShape: input.authShape,
    path: input.path,
    ...(authorize ? { authorize } : {}),
  }, input.connectionCheck);
}

/** The URLs the scope sends to that sit inside none of the connection's own. */
export function urlsOutsideConnection(scope: UrlScope, connection: UrlScope): string[] {
  const own = connectionUrlPrefixes(connection);
  return connectionUrlPrefixes(scope).filter((url) => !own.some((prefix) => matchesEgressPrefix(url, prefix)));
}

/** Every URL the scope sends to sits inside one of the connection's own. */
export function assertScopeInsideConnection(scope: UrlScope, connection: UrlScope): void {
  const outside = urlsOutsideConnection(scope, connection);
  if (outside.length > 0) {
    const own = connectionUrlPrefixes(connection);
    throw new ManagementError(
      'invalid_request',
      `Nothing was sent: this connection's key goes only to ${own.join(', ')}, not ${outside.join(', ')}.`,
    );
  }
}

/**
 * Whether another of the Agent's API connections already holds `key`. One
 * message can name the key's API and other URLs; this stops a second
 * connection to one of those URLs from receiving the same pasted key.
 */
async function keySavedOnAnotherConnection(
  input: Pick<SaveManagedConnectionKeyInput, 'agentId' | 'actor' | 'config' | 'settings' | 'env' | 'key'>,
  connectionId: string,
): Promise<boolean> {
  const [accounts, bindings] = await Promise.all([
    input.config.listConnectionAccounts(input.actor.workspaceId),
    input.config.listAgentConnectionBindings(input.agentId),
  ]);
  for (const { account } of agentConnections(accounts, bindings, input.actor.actorMembershipId).api.values()) {
    if (account.id === connectionId || account.policy.kind !== 'api') continue;
    if (await resolveConnectionAccountSecret(account, input.env, input.settings) === input.key) return true;
  }
  return false;
}

/** The Agent's API connection with this account id, as the member manages it. */
async function memberApiConnection(
  input: Pick<SaveManagedConnectionKeyInput, 'agentId' | 'connectionId' | 'actor' | 'config'>,
): Promise<AgentConnectionEntry | undefined> {
  const [accounts, bindings] = await Promise.all([
    input.config.listConnectionAccounts(input.actor.workspaceId),
    input.config.listAgentConnectionBindings(input.agentId),
  ]);
  return [...agentConnections(accounts, bindings, input.actor.actorMembershipId).api.values()]
    .find(({ account }) => account.id === input.connectionId);
}

export function assertPathInsideConnection(policy: UrlScope, path: string): void {
  if (!pathInsideConnection(policy, path)) {
    throw new ManagementError(
      'invalid_request',
      `path must be inside the connection on its first host: ${connectionUrlPrefixes(policy).join(', ')}.`,
    );
  }
}

/** Lists an open server's tools exactly as Admin's Test connection does before it saves one. */
export async function discoverOpenMcpServer(input: {
  server: OpenMcpServer;
  /** Test seam; production uses the SSRF-guarded fetch implementation. */
  createGuardedFetch?: typeof createMcpGuardedFetch;
}): Promise<McpConnectionTestResult> {
  const validated = validateMcpUrl(input.server.url);
  if (!validated.ok) return testFailure(new McpBlockedUrlError(validated.reason));
  try {
    const result = await discoverMcpTools({
      id: input.server.id,
      url: validated.url,
      transport: input.server.transport,
      headers: {},
    }, undefined, input.createGuardedFetch);
    return { ok: true, tools: result.tools };
  } catch (error) {
    return testFailure(error);
  }
}

function testFailure(error: unknown): McpConnectionTestResult {
  if (error instanceof McpOAuthError && error.code === 'reauthorization_required') {
    return { ok: false, code: 'unauthorized', message: 'This connection needs OAuth authorization.' };
  }
  return { ok: false, code: classifyMcpError(error), message: safeMcpFailureText(error) };
}
