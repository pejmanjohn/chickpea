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
  connectionUrlPrefixes,
  mcpCheckFailure,
  type ApiConnectionScope,
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
  path?: string;
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

/**
 * Checks a key against one of an Agent's API connections with one GET and,
 * when the answer shows the key works (2xx) or refuses only that request (403),
 * saves it the way the setup page does, so the account becomes ready. Unlike
 * the setup page, it saves nothing on an answer that says nothing about the
 * key, such as the 404 many APIs give at a bare prefix whatever the key. The
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
  if (input.path !== undefined) assertPathInsideConnection(policy, input.path);
  if (input.surface === 'slack' && await keySavedOnAnotherConnection(input, entry.account.id)) {
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
    ...(input.path === undefined ? {} : { path: input.path }),
    authorize: unchanged,
  }, input.connectionCheck);
  if (check.kind === 'key_rejected') {
    throw new ManagementError(
      'key_rejected',
      `${new URL(check.url).host} rejected this key (HTTP 401), so nothing was saved. Tell the person the key did not work and send a setup link with request_setup for this connection, where they can enter a working key. Never ask them to paste a key in chat.`,
    );
  }
  if (check.kind !== 'ok') {
    const answer = check.status === undefined ? check.detail : `${check.url} answered HTTP ${check.status}.`;
    // Some APIs (Datadog, AWS API Gateway) answer 403 to an invalid key, so a 403 confirms nothing.
    const reading = check.kind === 'not_permitted'
      ? ' A 403 can mean the key is invalid or that it lacks access to that path.'
      : '';
    throw new ManagementError(
      'key_unconfirmed',
      `Nothing was saved, because Chickpea could not confirm the key. ${answer}${reading} To check it, call save_connection_key again with path set to a read endpoint of this API that the key can read, such as a list endpoint, or send a setup link with request_setup. Never repeat the key.`,
    );
  }
  await saveConnectionCredential({
    config: input.config,
    settings: input.settings,
    platformEnv: input.env,
    productTelemetry: input.productTelemetry,
  }, entry, input.key, {
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

function assertPathInsideConnection(policy: ApiConnectionScope, path: string): void {
  const url = connectionCheckUrl(policy, path);
  if (url === undefined || !connectionUrlPrefixes(policy).some((prefix) => matchesEgressPrefix(url, prefix))) {
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
