import { SqliteConfigStore } from '../../src/config/store.ts';
import { SqliteIdentityStore } from '../../src/identity/store.ts';
import { SqliteManagementStore } from '../../src/management/store.ts';
import { WorkspaceManagementService } from '../../src/management/service.ts';
import { createSlackOwner } from './slack-owner.ts';

export async function createManagementAdapterFixture(suffix: string) {
  let sequence = 0;
  const now = 1_800_000_000_000;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, { now, suffix });
  const locatorHash = createHash('sha256').update(`locator:${suffix}`).digest('hex');
  const invitation = await identity.createInvitation({
    organizationId: owner.membership.organizationId,
    slackTeamId: owner.user.slackTeamId,
    slackUserId: 'U87654321',
    displayName: 'Admin',
    role: 'admin',
    locatorHash,
    inviterMembershipId: owner.membership.id,
    expiresAt: now + 60_000,
  });
  const admin = await identity.consumeInvitation({
    invitationId: invitation.id,
    locatorHash,
    slackTeamId: owner.user.slackTeamId,
    slackUserId: invitation.slackUserId,
    displayName: 'Admin',
    betterAuthUserId: `ba_user_${suffix}_admin`,
    betterAuthMembershipId: `ba_member_${suffix}_admin`,
  });
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const management = new SqliteManagementStore(':memory:');
  const service = new WorkspaceManagementService({
    identity,
    config,
    management,
    setupBaseUrl: 'http://localhost',
    randomCapability: () => 'c'.repeat(43),
    now: () => now,
    randomId: () => `${suffix}_${++sequence}`,
  });
  return {
    identity,
    owner,
    admin,
    config,
    management,
    service,
    close() {
      identity.close();
      config.close();
      management.close();
    },
  };
}

export function initialManagementBundle(workspaceId: string, channelId: string) {
  return [
    {
      itemId: 'agent',
      kind: 'create_agent' as const,
      clientRef: 'research',
      agent: {
        id: 'agent_research',
        name: 'Customer Research',
        instructions: 'Synthesize customer research and cite evidence.',
        enabled: true,
        model: 'openai/gpt-5',
        skills: [{
          name: 'research-synthesis',
          description: 'Synthesize research.',
          instructions: 'Group evidence into themes and cite sources.',
          enabled: true,
        }],
        mcpServers: [],
        apiConnections: [],
        repositories: [{
          id: 'repo_research',
          installationId: 42,
          accountLogin: 'acme',
          fullName: 'acme/research',
          enabled: true,
        }],
      },
    },
    {
      itemId: 'channel',
      kind: 'put_channel' as const,
      channel: {
        workspaceId,
        channelId,
        label: 'research',
        participationMode: 'mention_only' as const,
        lifecycle: 'active' as const,
      },
      expectedRevision: 0,
    },
    {
      itemId: 'placement',
      dependsOn: ['agent', 'channel'],
      kind: 'place_agent' as const,
      workspaceId,
      channelId,
      expectedRevision: 1,
      expectedAgentId: null,
      agentClientRef: 'research',
    },
  ];
}
import { createHash } from 'node:crypto';
