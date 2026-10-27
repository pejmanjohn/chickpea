import { connectionAccountOAuthRef } from '../config/api-oauth.ts';
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
  actor: McpConnectionTestActor;
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

export type McpConnectionTestResult =
  | { ok: true; tools: McpDiscoveryResult['tools'] }
  | { ok: false; code: McpErrorCode; message: string };

/** An MCP server that needs no credential, before Chickpea saves it. */
export interface OpenMcpServer {
  id: string;
  url: string;
  transport: 'streamable-http' | 'sse';
}

const NOT_FOUND = 'The MCP connection was not found.';

/** Tests team accounts and the actor's own personal accounts as the actor's turn would; never another member's. */
export async function testManagedMcpConnection(
  input: TestManagedMcpConnectionInput,
): Promise<McpConnectionTestResult> {
  const { actor } = input;
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
  const server = projectEffectiveMcpConnections([selected])[0]!;
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
            const policy = (await effective())?.policy;
            return policy?.kind === 'mcp' && policy.authMode === 'oauth' && sameMcpServerUrl(policy.url, serverUrl) &&
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
