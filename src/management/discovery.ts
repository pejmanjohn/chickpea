import { classifyMcpError, safeMcpFailureText } from '../config/mcp-errors.ts';
import { resolveMcpOAuthAccessToken } from '../config/mcp-oauth.ts';
import { buildMcpRequestHeaders, resolveMcpSecrets } from '../config/mcp-secrets.ts';
import { discoverMcpTools } from '../config/mcp-test.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import { listSlackChannels } from '../slack/channels.ts';
import {
  slackDirectoryUsersList,
  type SlackDirectoryMember,
} from '../slack/credentials.ts';
import { resolveSlackIdentityCredentials } from '../slack/identity-credentials.ts';
import { classifySlackUserForAdmission } from '../slack/user-classification.ts';
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

export async function discoverEligibleSlackMembers(
  cursor: string | undefined,
  env: PlatformEnv | undefined,
  identity: IdentityStore,
) {
  const [organization, credentials] = await Promise.all([
    identity.getOrganization(),
    managedSlackCredentials(env, identity),
  ]);
  if (!organization?.slackTeamId || !credentials.botToken || !credentials.botUserId) {
    throw slackUnavailable();
  }
  const teamId = organization.slackTeamId;
  const page = await slackDirectoryUsersList(credentials.botToken, {
    ...(cursor ? { cursor } : {}),
    limit: 200,
    timeoutMs: 10_000,
  }).catch(() => undefined);
  if (!page?.ok) throw slackUnavailable();
  const unavailable = await unavailableSlackUserIds(identity, organization.id);
  return {
    members: page.members
      .filter((member) => classifySlackUserForAdmission(
        member,
        teamId,
        credentials.botUserId!,
      ) === 'eligible_human')
      .filter(({ id }) => !unavailable.has(id))
      .map(safeDirectoryMember),
    nextCursor: page.nextCursor ?? null,
  };
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
    return await resolveSlackIdentityCredentials(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      env,
      { state: identity, ...(env ? { env } : {}) },
    );
  } catch {
    throw slackUnavailable();
  }
}

async function unavailableSlackUserIds(
  identity: IdentityStore,
  organizationId: string,
): Promise<Set<string>> {
  const [bindings, memberships, invitations] = await Promise.all([
    identity.listExternalIdentities(),
    identity.listMemberships(),
    identity.listInvitations(),
  ]);
  const membershipStatus = new Map(memberships.map(({ id, status }) => [id, status]));
  return new Set([
    ...bindings
      .filter((binding) => binding.organizationId === organizationId &&
        membershipStatus.get(binding.membershipId) !== 'removed')
      .map(({ slackUserId }) => slackUserId),
    ...invitations
      .filter((invitation) => invitation.organizationId === organizationId &&
        invitation.status === 'pending')
      .map(({ slackUserId }) => slackUserId),
  ]);
}

function safeDirectoryMember(member: SlackDirectoryMember) {
  return {
    slackUserId: member.id,
    displayName: member.displayName,
    realName: member.realName,
    handle: member.handle,
    avatarUrl: safeHttpsUrl(member.avatarUrl),
  };
}

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function slackUnavailable(): ManagementError {
  return new ManagementError('invalid_request', 'The connected Slack directory is unavailable.');
}
