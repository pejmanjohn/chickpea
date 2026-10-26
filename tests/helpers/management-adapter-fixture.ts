import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CHICKPEA_AGENT_ID } from '../../src/config/agent-id.ts';
import { SqliteSettingsStore } from '../../src/config/settings-store.ts';
import { SqliteConfigStore } from '../../src/config/store.ts';
import type { CustomAgentConfig } from '../../src/config/types.ts';
import { ConnectionAccountService } from '../../src/connections/store.ts';
import { SqliteIdentityStore } from '../../src/identity/store.ts';
import { SqliteManagementStore } from '../../src/management/store.ts';
import {
  WorkspaceManagementService,
  type WorkspaceManagementServiceInput,
} from '../../src/management/service.ts';
import { invokeWorkspaceManagementTool } from '../../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
} from '../../src/management/types.ts';
import { SqliteMemoryStateStore } from '../../src/memory/store.ts';
import { SqliteRoutineStore } from '../../src/routines/store.ts';
import { createSlackOwner } from './slack-owner.ts';

/** The tools every open MCP server offers in this fixture unless a test supplies its own discovery. */
export const FIXTURE_MCP_TOOLS = ['search', 'read_page', 'delete_page', 'export_all', 'list_errors', 'delete_project'];

export async function createManagementAdapterFixture(
  suffix: string,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
  options: { teamId?: string } = {},
) {
  let sequence = 0;
  const now = 1_800_000_000_000;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, {
    now,
    suffix,
    ...(options.teamId ? { teamId: options.teamId } : {}),
  });
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const memory = new SqliteMemoryStateStore(':memory:', () => now);
  const routines = new SqliteRoutineStore(':memory:', () => now);
  const settings = new SqliteSettingsStore(':memory:', () => now);
  const service = new WorkspaceManagementService({
    identity,
    config,
    connectionAccounts: new ConnectionAccountService({ config, settings }),
    websiteLogins: { store: settings },
    discoverMcpServer: async () => ({ ok: true, tools: FIXTURE_MCP_TOOLS.map((name) => ({ name })) }),
    management,
    memory,
    routines,
    routineSchedulingAvailable: true,
    setupBaseUrl: 'http://localhost',
    randomCapability: () => 'c'.repeat(43),
    now: () => now,
    randomId: () => `${suffix}_${++sequence}`,
    ...overrides,
  });
  return {
    identity,
    owner,
    admin,
    config,
    management,
    memory,
    routines,
    settings,
    service,
    close() {
      identity.close();
      config.close();
      settings.close();
      management.close();
      memory.close();
      routines.close();
    },
  };
}

export type ManagementAdapterFixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;

export async function withManagementAdapterFixture(
  suffix: string,
  run: (f: ManagementAdapterFixture) => Promise<void>,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
): Promise<void> {
  const f = await createManagementAdapterFixture(suffix, overrides);
  try {
    await run(f);
  } finally {
    f.close();
  }
}

/** The owner asking from an MCP client. */
export function ownerMcpContext(
  f: ManagementAdapterFixture,
  clientId = 'adapter-test',
): ManagementActorContext {
  return {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    origin: { kind: 'mcp', clientId },
  };
}

/** The owner asking Chickpea in a Slack DM. */
export function ownerSlackDmContext(f: ManagementAdapterFixture): ManagementActorContext {
  return {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    actingAgentId: CHICKPEA_AGENT_ID,
    origin: {
      kind: 'slack',
      workspaceId: f.owner.binding.slackTeamId,
      channelId: 'D_ADAPTER',
      threadTs: '900.1',
      messageTs: '900.1',
      requestText: 'Please make this change.',
      conversationKind: 'im',
      agentId: CHICKPEA_AGENT_ID,
    },
  };
}

/** Calls apply_workspace_changes through the tool adapter, as both doors do. */
export async function applyThroughAdapter(
  f: ManagementAdapterFixture,
  context: ManagementActorContext,
  idempotencyKey: string,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  const response = await invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => context,
  }, 'apply_workspace_changes', { idempotencyKey, operations });
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: ManagementApplyResult }).result;
}

/** An active user Agent created by the owner, with no connections. */
export async function createFixtureAgent(
  f: ManagementAdapterFixture,
  id: string,
  extra: Partial<CustomAgentConfig> = {},
): Promise<CustomAgentConfig> {
  return f.config.createAgent({
    id,
    name: 'Research',
    instructions: 'Find and cite sources.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: f.owner.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...extra,
  });
}
