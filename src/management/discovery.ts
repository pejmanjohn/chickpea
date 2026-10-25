import { connectionAccountOAuthRef } from '../config/api-oauth.ts';
import { classifyMcpError, safeMcpFailureText, type McpErrorCode } from '../config/mcp-errors.ts';
import { McpOAuthError, resolveMcpOAuthAccessToken } from '../config/mcp-oauth.ts';
import { boundMcpCredentialRef } from '../config/connection-credential-binding.ts';
import { buildMcpRequestHeaders, resolveMcpSecrets } from '../config/mcp-secrets.ts';
import { discoverMcpTools, type McpDiscoveryResult } from '../config/mcp-test.ts';
import type { createMcpGuardedFetch } from '../config/mcp-url.ts';
import { resolveConnectionAccountMcpSecrets } from '../config/profile-mcp.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { McpConnectionConfig } from '../config/types.ts';
import { mcpOAuthLifecycleDependencies } from '../connections/mcp-oauth-lifecycle.ts';
import {
  isActiveConnectionActor,
  projectEffectiveConnectionAccounts,
  projectEffectiveMcpConnections,
  resolveConnectionSecretForInvocation,
  resolveEffectiveConnectionAccounts,
} from '../connections/runtime.ts';
import type { IdentityStore } from '../identity/types.ts';
import { ManagementError } from './types.ts';

/** The member testing a connection, in the workspace that owns its accounts. */
export interface McpConnectionTestActor {
  workspaceId: string;
  actorMembershipId: string;
}

interface TestManagedMcpConnectionInput {
  agentId: string;
  connectionId: string;
  /** Without an actor, only the Agent's profile connections can be tested. */
  actor?: McpConnectionTestActor;
  env?: PlatformEnv;
  config: ConfigStore;
  identity: Pick<
    IdentityStore,
    'getOrganization' | 'getMembership' | 'getMembershipAccessOverlay' | 'getUser' | 'resolveSlackIdentity'
  >;
  settings: SettingsStore;
  /** Test seam; production uses the SSRF-guarded fetch implementation. */
  createGuardedFetch?: typeof createMcpGuardedFetch;
}

type McpConnectionTestResult =
  | { ok: true; tools: McpDiscoveryResult['tools'] }
  | { ok: false; code: McpErrorCode; message: string };

const NOT_FOUND = 'The MCP connection was not found.';

export async function testManagedMcpConnection(
  input: TestManagedMcpConnectionInput,
): Promise<McpConnectionTestResult> {
  const agent = await input.config.getAgent(input.agentId);
  const connection = agent.mcpServers.find(({ id }) => id === input.connectionId);
  if (connection) return testProfileMcpConnection(input, connection);
  if (!input.actor) throw new ManagementError('invalid_request', NOT_FOUND);
  return testConnectionAccountMcp(input, input.actor);
}

async function testProfileMcpConnection(
  input: TestManagedMcpConnectionInput,
  connection: McpConnectionConfig,
): Promise<McpConnectionTestResult> {
  try {
    const credentialRef = boundMcpCredentialRef(input.agentId, connection);
    const authorizeRequest = async () => {
      const currentAgent = await input.config.getAgent(input.agentId);
      const current = currentAgent.mcpServers.find(({ id }) => id === input.connectionId);
      if (!current || boundMcpCredentialRef(currentAgent.id, current).credentialBinding !==
          credentialRef.credentialBinding) {
        throw new Error('connection_changed');
      }
    };
    const resolved = await resolveMcpSecrets(
      credentialRef,
      connection.headerNames,
      input.env,
      input.settings,
    );
    if (connection.authMode === 'oauth') {
      resolved.bearer = await resolveMcpOAuthAccessToken(
        { ref: credentialRef, serverUrl: connection.url },
        { settings: input.settings, refreshTelemetry: { trigger: 'admin' } },
      );
    }
    await authorizeRequest();
    const result = await discoverMcpTools({
      id: connection.id,
      url: connection.url,
      transport: connection.transport,
      headers: buildMcpRequestHeaders(connection.authMode, resolved),
      authorizeRequest,
    }, undefined, input.createGuardedFetch);
    return { ok: true, tools: result.tools };
  } catch (error) {
    return testFailure(error);
  }
}

/**
 * Test a connection account bound to the Agent with the credentials a turn by
 * this actor would use. The actor sees team accounts and their own personal
 * accounts; another member's personal account is not found, whatever the
 * actor's role.
 */
async function testConnectionAccountMcp(
  input: TestManagedMcpConnectionInput,
  actor: McpConnectionTestActor,
): Promise<McpConnectionTestResult> {
  const [accounts, bindings] = await Promise.all([
    input.config.listConnectionAccounts(actor.workspaceId),
    input.config.listAgentConnectionBindings(input.agentId),
  ]);
  const account = accounts.find(({ id }) => id === input.connectionId);
  if (!account || account.policy.kind !== 'mcp' || account.lifecycle === 'revoked' ||
      (account.ownerKind !== 'team' && account.ownerMembershipId !== actor.actorMembershipId) ||
      !bindings.some((binding) =>
        binding.connectionAccountId === account.id && binding.providerId === account.providerId)) {
    throw new ManagementError('invalid_request', NOT_FOUND);
  }
  const selected = projectEffectiveConnectionAccounts(accounts, bindings, actor.actorMembershipId)
    .find((effective) => effective.account.id === account.id);
  if (!selected) {
    return {
      ok: false,
      code: 'unauthorized',
      message: 'This connection is not ready for this Agent. Finish its setup in Admin, then test it again.',
    };
  }
  const [server] = projectEffectiveMcpConnections([selected]);
  if (!server) throw new ManagementError('invalid_request', NOT_FOUND);
  const current = async () => {
    if (!(await isActiveConnectionActor({ identity: input.identity, ...actor }))) return undefined;
    return (await resolveEffectiveConnectionAccounts({ ...actor, config: input.config, agentId: input.agentId }))
      .find((effective) =>
        effective.account.id === account.id && effective.account.revision === account.revision);
  };
  const authorizeRequest = async () => {
    if (!(await current())) throw new Error('connection_changed');
  };
  try {
    const secrets = await resolveConnectionAccountMcpSecrets(server, (connectionAccountId) =>
      resolveConnectionSecretForInvocation({
        ...actor,
        config: input.config,
        settings: input.settings,
        identity: input.identity,
        ...(input.env ? { env: input.env } : {}),
        agentId: input.agentId,
        connectionAccountId,
      }));
    if (server.authMode === 'oauth') {
      secrets.bearer = await resolveMcpOAuthAccessToken(
        { ref: connectionAccountOAuthRef(server.id), serverUrl: server.url },
        {
          settings: input.settings,
          refreshTelemetry: { trigger: 'admin' },
          ...mcpOAuthLifecycleDependencies(input.config, input.settings, actor.workspaceId),
          validateConnection: async (_ref, serverUrl, _revision, attemptId) => {
            const policy = (await current())?.policy;
            return policy?.kind === 'mcp' && policy.authMode === 'oauth' && policy.url === serverUrl &&
              (attemptId === undefined || policy.oauthAttemptId === attemptId);
          },
        },
      );
    }
    await authorizeRequest();
    const result = await discoverMcpTools({
      id: server.id,
      url: server.url,
      transport: server.transport,
      headers: buildMcpRequestHeaders(server.authMode, secrets),
      authorizeRequest,
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
