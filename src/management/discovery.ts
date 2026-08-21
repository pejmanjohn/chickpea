import { classifyMcpError, safeMcpFailureText } from '../config/mcp-errors.ts';
import { resolveMcpOAuthAccessToken } from '../config/mcp-oauth.ts';
import { buildMcpRequestHeaders, resolveMcpSecrets } from '../config/mcp-secrets.ts';
import { discoverMcpTools } from '../config/mcp-test.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import { listSlackChannels } from '../slack/channels.ts';
import { resolveSlackInstallationCredentials } from '../slack/installation-credentials.ts';
import { ManagementError } from './types.ts';

export async function discoverManagedSlackChannels(
  refresh: boolean,
  env: PlatformEnv | undefined,
  identity: IdentityStore,
) {
  const [organization, credentials] = await Promise.all([
    identity.getOrganization(),
    managedSlackCredentials(env, identity),
  ]);
  if (!organization?.slackTeamId || !credentials.botToken) throw slackUnavailable();
  try {
    const result = await listSlackChannels(credentials.botToken, { refresh });
    return { teamId: organization.slackTeamId, ...result };
  } catch {
    throw slackUnavailable();
  }
}

export async function testManagedMcpConnection(input: {
  agentId: string;
  connectionId: string;
  env?: PlatformEnv;
  config: Pick<ConfigStore, 'getAgent'>;
  settings: SettingsStore;
}) {
  const agent = await input.config.getAgent(input.agentId);
  const connection = agent.mcpServers.find(({ id }) => id === input.connectionId);
  if (!connection) throw new ManagementError('invalid_request', 'The MCP connection was not found.');
  try {
    const ref = { agentId: agent.id, connectionId: connection.id };
    const resolved = await resolveMcpSecrets(
      ref,
      connection.headerNames,
      input.env,
      input.settings,
    );
    if (connection.authMode === 'oauth') {
      resolved.bearer = await resolveMcpOAuthAccessToken(
        { ref, serverUrl: connection.url },
        { settings: input.settings },
      );
    }
    const result = await discoverMcpTools({
      id: connection.id,
      url: connection.url,
      transport: connection.transport,
      headers: buildMcpRequestHeaders(connection.authMode, resolved),
    });
    return { ok: true as const, tools: result.tools };
  } catch (error) {
    return {
      ok: false as const,
      code: classifyMcpError(error),
      message: safeMcpFailureText(error),
    };
  }
}

async function managedSlackCredentials(env: PlatformEnv | undefined, identity: IdentityStore) {
  try {
    return await resolveSlackInstallationCredentials(
      WORKSPACE_SLACK_INSTALLATION_ID,
      env,
      { state: identity, ...(env ? { env } : {}) },
    );
  } catch {
    throw slackUnavailable();
  }
}

function slackUnavailable(): ManagementError {
  return new ManagementError('invalid_request', 'The connected Slack directory is unavailable.');
}
