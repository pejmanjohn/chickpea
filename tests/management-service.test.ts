import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import { clearRepointedMcpCredentials } from '../src/config/mcp-connection-lifecycle.ts';
import { resolveMcpSecrets, saveMcpSecrets } from '../src/config/mcp-secrets.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { ManagementError, type ManagementActorContext } from '../src/management/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const START = 1_800_000_000_000;

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_test',
    revision: 1,
    name: 'Test Agent',
    instructions: 'Answer carefully.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

async function fixture() {
  let now = START;
  let sequence = 0;
  let capabilitySequence = 0;
  const providerSources = new Map<string, 'env' | 'stored' | 'missing'>([
    ['anthropic', 'missing'],
    ['openai', 'missing'],
    ['openrouter', 'missing'],
  ]);
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, { now, suffix: 'management' });
  const invitation = await identity.createInvitation({
    organizationId: owner.membership.organizationId,
    slackTeamId: owner.user.slackTeamId,
    slackUserId: 'U87654321',
    displayName: 'Admin',
    role: 'admin',
    locatorHash: 'd'.repeat(64),
    inviterMembershipId: owner.membership.id,
    expiresAt: now + 60_000,
  });
  const admin = await identity.consumeInvitation({
    invitationId: invitation.id,
    locatorHash: 'd'.repeat(64),
    slackTeamId: owner.user.slackTeamId,
    slackUserId: 'U87654321',
    displayName: 'Admin',
    betterAuthUserId: 'ba_user_management_admin',
    betterAuthMembershipId: 'ba_member_management_admin',
  });
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const management = new SqliteManagementStore(':memory:');
  const memory = new SqliteMemoryStateStore(':memory:', () => now);
  const routines = new SqliteRoutineStore(':memory:', () => now);
  const service = new WorkspaceManagementService({
    identity,
    config,
    management,
    memory,
    routines,
    routineSchedulingAvailable: true,
    setupBaseUrl: 'http://localhost',
    randomCapability: () => `${'c'.repeat(42)}${++capabilitySequence % 10}`,
    now: () => now,
    randomId: () => `id_${++sequence}`,
    providerCredentialSource: async (providerId) => providerSources.get(providerId) ?? 'missing',
    removeProviderCredential: async (providerId) => {
      providerSources.set(providerId, 'missing');
      return 'missing';
    },
    resolveSlackInvitee: async (slackUserId) => ({
      slackTeamId: owner.user.slackTeamId,
      displayName: slackUserId === 'U22222222' ? 'New Admin' : null,
    }),
  });
  return {
    identity,
    owner,
    admin,
    config,
    management,
    memory,
    routines,
    service,
    setProviderSource: (providerId: string, source: 'env' | 'stored' | 'missing') => {
      providerSources.set(providerId, source);
    },
    tick: (milliseconds = 1) => { now += milliseconds; },
    close: () => {
      identity.close();
      config.close();
      management.close();
      memory.close();
      routines.close();
    },
  };
}

function context(
  actor: IdentityResolution,
  origin: ManagementActorContext['origin'] = { kind: 'mcp', clientId: 'client_1' },
): ManagementActorContext {
  return {
    userId: actor.user.id,
    membershipId: actor.membership.id,
    organizationId: actor.membership.organizationId,
    origin,
  };
}

test('Admin edits operations, Owner controls members, and suspended actors fail closed', async () => {
  const f = await fixture();
  try {
    const created = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'create_agent',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agent() }],
    });
    assert.equal(created.status, 'completed');
    assert.equal(created.outcomes[0]?.disposition, 'applied');

    const denied = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'member_denied',
      operations: [{
        itemId: 'member',
        kind: 'update_member',
        membershipId: f.admin.membership.id,
        status: 'suspended',
      }],
    });
    assert.equal(denied.outcomes[0]?.code, 'owner_required');
    assert.equal((await f.identity.getMembership(f.admin.membership.id))?.status, 'active');

    const proposed = await f.service.applyWorkspaceChanges({
      context: context(f.owner),
      idempotencyKey: 'member_owner',
      operations: [{
        itemId: 'member',
        kind: 'update_member',
        membershipId: f.admin.membership.id,
        status: 'suspended',
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    f.tick();
    await f.service.confirmWorkspaceChange({
      context: context(f.owner),
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal((await f.identity.getMembership(f.admin.membership.id))?.status, 'suspended');
    await assert.rejects(
      () => f.service.inspectWorkspace(context(f.admin)),
      (error: unknown) => error instanceof ManagementError && error.code === 'forbidden',
    );
  } finally {
    f.close();
  }
});

test('a role downgrade revokes authority for an already-issued confirmation', async () => {
  const f = await fixture();
  try {
    const promote = await f.service.applyWorkspaceChanges({
      context: context(f.owner),
      idempotencyKey: 'promote-second-owner',
      operations: [{
        itemId: 'promote', kind: 'update_member', membershipId: f.admin.membership.id,
        role: 'owner', status: 'active',
      }],
    });
    await f.service.confirmWorkspaceChange({
      context: context(f.owner), proposalId: promote.outcomes[0]!.proposalId!,
    });

    const pending = await f.service.applyWorkspaceChanges({
      context: context(f.owner),
      idempotencyKey: 'owner-only-pending',
      operations: [{
        itemId: 'suspend', kind: 'update_member', membershipId: f.admin.membership.id,
        status: 'suspended',
      }],
    });
    const demote = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'demote-original-owner',
      operations: [{
        itemId: 'demote', kind: 'update_member', membershipId: f.owner.membership.id,
        role: 'admin', status: 'active',
      }],
    });
    await f.service.confirmWorkspaceChange({
      context: context(f.admin), proposalId: demote.outcomes[0]!.proposalId!,
    });
    await assert.rejects(
      () => f.service.confirmWorkspaceChange({
        context: context(f.owner), proposalId: pending.outcomes[0]!.proposalId!,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'forbidden',
    );
    assert.equal((await f.identity.getMembership(f.admin.membership.id))?.status, 'active');
  } finally {
    f.close();
  }
});

test('management confirmation clears saved MCP credentials before an origin repoint', async () => {
  const f = await fixture();
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const current = await f.config.createAgent(agent({
      id: 'agent_mcp',
      mcpServers: [{
        id: 'search', displayName: 'Search', url: 'https://old.example/mcp',
        transport: 'streamable-http', authMode: 'bearer', headerNames: ['X-Key'],
        enabled: true, lifecycleStatus: 'ready', statusText: 'Ready',
        discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
      }],
    }));
    await saveMcpSecrets(
      { agentId: current.id, connectionId: 'search' },
      { bearerToken: 'old-bearer', headers: { 'X-Key': 'old-header' } },
      undefined,
      settings,
    );
    const service = new WorkspaceManagementService({
      identity: f.identity,
      config: f.config,
      management: f.management,
      setupBaseUrl: 'http://localhost',
      prepareAgentUpdate: (existing, patch) => clearRepointedMcpCredentials({
        agentId: existing.id,
        current: existing.mcpServers,
        next: patch.mcpServers,
        settings,
      }),
      randomId: () => 'repoint',
    });
    const proposed = await service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'repoint-mcp',
      operations: [{
        itemId: 'repoint', kind: 'update_agent', agentId: current.id,
        expectedRevision: current.revision,
        patch: { mcpServers: [{ ...current.mcpServers[0]!, url: 'https://new.example/mcp' }] },
      }],
    });
    assert.equal(proposed.outcomes[0]?.disposition, 'confirmation_required');
    await service.confirmWorkspaceChange({
      context: context(f.admin), proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.deepEqual(await resolveMcpSecrets(
      { agentId: current.id, connectionId: 'search' },
      ['X-Key'],
      undefined,
      settings,
    ), { headers: {} });
  } finally {
    settings.close();
    f.close();
  }
});

test('only Owners inspect team authority while provider status stays non-secret', async () => {
  const f = await fixture();
  try {
    f.setProviderSource('openai', 'stored');
    await f.config.createAgent(agent({
      id: 'agent_openai',
      name: 'OpenAI Agent',
      model: 'openai/gpt-5',
    }));
    const ownerSnapshot = await f.service.inspectWorkspace(context(f.owner));
    assert.equal(ownerSnapshot.team?.members.length, 2);
    assert.equal(ownerSnapshot.team?.members.find(({ id }) => id === f.owner.membership.id)?.role, 'owner');
    assert.equal(ownerSnapshot.providers.find(({ id }) => id === 'openai')?.source, 'stored');
    assert.deepEqual(
      ownerSnapshot.providers.find(({ id }) => id === 'openai')?.affectedAgents,
      [{ id: 'agent_openai', name: 'OpenAI Agent' }],
    );
    assert.doesNotMatch(JSON.stringify(ownerSnapshot.providers), /api.?key|credentialvalue/i);

    const adminSnapshot = await f.service.inspectWorkspace(context(f.admin));
    assert.equal(adminSnapshot.team, undefined);
    assert.equal(adminSnapshot.providers.find(({ id }) => id === 'openai')?.source, 'stored');
  } finally {
    f.close();
  }
});

test('stored provider removal names affected Agents and requires a fresh confirmation', async () => {
  const f = await fixture();
  try {
    f.setProviderSource('openai', 'stored');
    await f.config.createAgent(agent({
      id: 'agent_openai',
      name: 'OpenAI Agent',
      model: 'openai/gpt-5',
    }));
    const proposed = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'remove_openai',
      operations: [{
        itemId: 'remove',
        kind: 'remove_provider_credential',
        providerId: 'openai',
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    assert.match(proposed.outcomes[0]?.warning ?? '', /provider_credential_removal/);
    assert.match(proposed.outcomes[0]?.warning ?? '', /OpenAI Agent \(agent_openai\)/);
    assert.equal((await f.service.inspectWorkspace(context(f.admin))).providers
      .find(({ id }) => id === 'openai')?.source, 'stored');

    const applied = await f.service.confirmWorkspaceChange({
      context: context(f.admin),
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal(applied.outcomes[0]?.disposition, 'applied');
    assert.equal((await f.service.inspectWorkspace(context(f.admin))).providers
      .find(({ id }) => id === 'openai')?.source, 'missing');

    f.setProviderSource('anthropic', 'env');
    const denied = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'remove_env_anthropic',
      operations: [{
        itemId: 'remove',
        kind: 'remove_provider_credential',
        providerId: 'anthropic',
      }],
    });
    assert.equal(denied.outcomes[0]?.disposition, 'failed');
    assert.equal(denied.outcomes[0]?.code, 'invalid_request');
  } finally {
    f.close();
  }
});

test('Owner invitation returns a 24-hour handoff, rotates on reissue, and revokes by confirmation', async () => {
  const f = await fixture();
  try {
    const invited = await f.service.applyWorkspaceChanges({
      context: context(f.owner),
      idempotencyKey: 'invite_new_admin',
      operations: [{ itemId: 'invite', kind: 'invite_member', slackUserId: 'U22222222' }],
    });
    assert.equal(invited.outcomes[0]?.disposition, 'applied');
    const firstUrl = new URL(invited.outcomes[0]!.handoffUrl!);
    const firstCapability = new URLSearchParams(firstUrl.hash.slice(1)).get('invite')!;
    assert.equal(firstUrl.pathname, '/auth/slack/invite');
    const firstInvitation = (await f.identity.listInvitations())
      .find(({ slackUserId }) => slackUserId === 'U22222222')!;
    assert.equal(firstInvitation.expiresAt, START + 24 * 60 * 60_000);
    assert.equal(
      (await f.management.getRequest(invited.operationId))?.result?.outcomes[0]?.handoffUrl,
      undefined,
    );
    assert.equal(
      (await f.identity.findInvitation(createHash('sha256').update(firstCapability).digest('hex')))?.id,
      firstInvitation.id,
    );

    f.tick();
    const reissued = await f.service.applyWorkspaceChanges({
      context: context(f.owner),
      idempotencyKey: 'reissue_new_admin',
      operations: [{ itemId: 'invite', kind: 'invite_member', slackUserId: 'U22222222' }],
    });
    const secondUrl = new URL(reissued.outcomes[0]!.handoffUrl!);
    const secondCapability = new URLSearchParams(secondUrl.hash.slice(1)).get('invite')!;
    assert.notEqual(secondCapability, firstCapability);
    assert.equal(
      await f.identity.findInvitation(createHash('sha256').update(firstCapability).digest('hex')),
      undefined,
    );
    const rotated = await f.identity.findInvitation(
      createHash('sha256').update(secondCapability).digest('hex'),
    );
    const team = (await f.service.inspectWorkspace(context(f.owner))).team!;
    const invitation = team.invitations.find(({ id }) => id === rotated!.id)!;
    const proposed = await f.service.applyWorkspaceChanges({
      context: context(f.owner),
      idempotencyKey: 'revoke_new_admin',
      operations: [{
        itemId: 'revoke',
        kind: 'revoke_invitation',
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    await f.service.confirmWorkspaceChange({
      context: context(f.owner),
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal((await f.identity.listInvitations())
      .find(({ id }) => id === invitation.id)?.status, 'revoked');
  } finally {
    f.close();
  }
});

test('memory inspection and edits preserve owner scope and versioned irreversible confirmation', async () => {
  const f = await fixture();
  try {
    const ownerRef = {
      workspaceId: f.owner.user.slackTeamId,
      ownerKind: 'agent' as const,
      ownerId: 'agent_memory',
    };
    await f.memory.ensureOwner(ownerRef);
    const created = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'memory_create',
      operations: [{
        itemId: 'memory',
        kind: 'create_memory_entry',
        owner: ownerRef,
        entry: {
          slug: 'customer-preference',
          description: 'A durable customer preference.',
          type: 'preference',
          body: 'Customers prefer concise release notes.',
        },
      }],
    });
    assert.equal(created.outcomes[0]?.disposition, 'applied');
    const entryId = created.outcomes[0]?.changed?.[0]?.id!;
    const first = await f.service.inspectMemory(context(f.admin), ownerRef);
    assert.equal(first.entries[0]?.body, 'Customers prefer concise release notes.');
    assert.equal(first.entries[0]?.version, 1);

    const updated = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'memory_update',
      operations: [{
        itemId: 'memory',
        kind: 'update_memory_entry',
        owner: ownerRef,
        entryId,
        expectedVersion: 1,
        description: 'A durable customer preference.',
        type: 'preference',
        body: 'Customers prefer concise, linked release notes.',
      }],
    });
    assert.equal(updated.outcomes[0]?.changed?.[0]?.revision, 2);

    const proposed = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'memory_forget',
      operations: [{
        itemId: 'memory',
        kind: 'forget_memory_entry',
        owner: ownerRef,
        entryId,
        expectedVersion: 2,
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    assert.match(proposed.outcomes[0]?.warning ?? '', /irreversible_memory_forget/);
    await f.service.confirmWorkspaceChange({
      context: context(f.admin),
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    const forgotten = await f.service.inspectMemory(context(f.admin), ownerRef);
    assert.equal(forgotten.entries[0]?.status, 'forgotten');
    assert.equal(forgotten.entries[0]?.body, null);

    await assert.rejects(
      () => f.service.inspectMemory(context(f.admin), { ...ownerRef, workspaceId: 'T_OTHER' }),
      (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    );
  } finally {
    f.close();
  }
});

test('routine save and control are immediate, inspection redacts unknown authority, and delete confirms', async () => {
  const f = await fixture();
  try {
    const workspaceId = f.owner.user.slackTeamId;
    await f.config.putChannel({
      workspaceId,
      channelId: 'C_ROUTINES',
      participationMode: 'mention_only',
      lifecycle: 'active',
    }, 0);
    const created = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'routine_create',
      operations: [{
        itemId: 'routine',
        kind: 'save_routine',
        workspaceId,
        channelId: 'C_ROUTINES',
        name: 'Approval chaser',
        description: 'Tracks pending approvals.',
        taskText: 'Check pending approvals and post changes.',
        schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
        timezone: 'America/Los_Angeles',
        outputPolicy: 'post_on_change',
      }],
    });
    assert.equal(created.outcomes[0]?.disposition, 'applied');
    const routineId = created.outcomes[0]?.changed?.[0]?.id!;
    const inspected = await f.service.inspectRoutines(context(f.admin), {
      workspaceId,
      routineId,
    });
    assert.equal(inspected.routines[0]?.contentAccess, 'authorization_unknown');
    assert.equal(inspected.routines[0]?.taskText, null);
    assert.equal(inspected.routines[0]?.scheduleInput, '0 9 * * 1-5');

    const paused = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'routine_pause',
      operations: [{
        itemId: 'routine',
        kind: 'control_routine',
        workspaceId,
        channelId: 'C_ROUTINES',
        routineId,
        expectedVersion: 1,
        action: 'pause',
      }],
    });
    assert.equal(paused.outcomes[0]?.changed?.[0]?.revision, 2);

    const proposed = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'routine_delete',
      operations: [{
        itemId: 'routine',
        kind: 'delete_routine',
        workspaceId,
        channelId: 'C_ROUTINES',
        routineId,
        expectedVersion: 2,
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    assert.match(proposed.outcomes[0]?.warning ?? '', /irreversible_routine_delete/);
    const deleted = await f.service.confirmWorkspaceChange({
      context: context(f.admin),
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal(deleted.outcomes[0]?.disposition, 'applied');
    assert.notEqual((await f.routines.getRoutine(routineId))?.deletedAt, null);
  } finally {
    f.close();
  }
});

test('one progressive request creates an Agent, Channel, and initial placement without confirmation', async () => {
  const f = await fixture();
  try {
    const result = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'initial_bundle',
      operations: [
        {
          itemId: 'agent',
          kind: 'create_agent',
          clientRef: 'research',
          agent: agent({ id: 'agent_research', name: 'Research' }),
        },
        {
          itemId: 'channel',
          kind: 'put_channel',
          channel: {
            workspaceId: 'T1',
            channelId: 'C_RESEARCH',
            participationMode: 'mention_only',
            lifecycle: 'active',
          },
          expectedRevision: 0,
        },
        {
          itemId: 'placement',
          dependsOn: ['agent', 'channel'],
          kind: 'place_agent',
          workspaceId: 'T1',
          channelId: 'C_RESEARCH',
          expectedRevision: 1,
          expectedAgentId: null,
          agentClientRef: 'research',
        },
      ],
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), [
      'applied', 'applied', 'applied',
    ]);
    assert.equal((await f.config.getAssignment('T1', 'C_RESEARCH'))?.agentId, 'agent_research');
    assert.equal((await f.config.getChannel('T1', 'C_RESEARCH'))?.revision, 2);
  } finally {
    f.close();
  }
});

test('one progressive request keeps the Agent live while returning setup for an unavailable connector', async () => {
  const f = await fixture();
  try {
    const research = agent({
      id: 'agent_customer_research',
      name: 'Customer Research',
      skills: [
        { name: 'interview-analysis', description: 'Analyze interviews', instructions: 'Find themes.', enabled: true },
        { name: 'research-brief', description: 'Write briefs', instructions: 'Synthesize evidence.', enabled: true },
      ],
      apiConnections: [{
        id: 'gmail',
        displayName: 'Gmail',
        allowedHosts: ['gmail.googleapis.com'],
        pathPrefixes: ['/gmail/v1'],
        headerName: 'Authorization',
        allowedMethods: ['GET'],
        enabled: true,
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauthAppType: 'external',
        lifecycleStatus: 'pending',
        statusText: 'Not connected',
        presetId: 'gmail',
      }],
      repositories: [{
        id: 'repo_research',
        installationId: 42,
        accountLogin: 'magoosh',
        fullName: 'magoosh/research',
        enabled: true,
      }],
    });
    const result = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'progressive_with_setup',
      operations: [
        { itemId: 'agent', kind: 'create_agent', clientRef: 'research', agent: research },
        {
          itemId: 'channel',
          kind: 'put_channel',
          channel: {
            workspaceId: 'T1', channelId: 'C_RESEARCH',
            participationMode: 'mention_only', lifecycle: 'active',
          },
          expectedRevision: 0,
        },
        {
          itemId: 'placement', dependsOn: ['agent', 'channel'], kind: 'place_agent',
          workspaceId: 'T1', channelId: 'C_RESEARCH', expectedRevision: 1,
          expectedAgentId: null, agentClientRef: 'research',
        },
        {
          itemId: 'gmail', dependsOn: ['agent'], kind: 'request_setup',
          target: { kind: 'api_connection', agentClientRef: 'research', connectionId: 'gmail' },
        },
      ],
    });
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), [
      'applied', 'applied', 'applied', 'setup_required',
    ]);
    assert.match(result.outcomes[3]!.setupUrl!, /\/setup\/setup_.*#setup=/);
    assert.equal((await f.config.getAgent('agent_customer_research')).enabled, true);
    assert.equal(
      (await f.config.getAssignment('T1', 'C_RESEARCH'))?.agentId,
      'agent_customer_research',
    );
  } finally {
    f.close();
  }
});

test('Agent deletion reports placements and only the same actor and Slack thread can confirm', async () => {
  const f = await fixture();
  try {
    await f.config.createAgent(agent());
    for (const channelId of ['C1', 'C2', 'C3']) {
      await f.config.putChannelPlacement({
        channel: {
          workspaceId: 'T1',
          channelId,
          participationMode: 'ambient',
          lifecycle: 'active',
        },
        agentId: 'agent_test',
        expectedAgentId: null,
        expectedRevision: 0,
      });
    }
    const slackOrigin = { kind: 'slack' as const, workspaceId: 'T1', channelId: 'C_ADMIN', threadTs: '1.0' };
    const proposal = await f.service.applyWorkspaceChanges({
      context: context(f.admin, slackOrigin),
      idempotencyKey: 'delete_agent',
      operations: [{
        itemId: 'delete',
        kind: 'delete_agent',
        agentId: 'agent_test',
        expectedRevision: 1,
      }],
    });
    assert.equal(proposal.outcomes[0]?.disposition, 'confirmation_required');
    assert.equal((await f.config.getAgentReferences('agent_test')).channelAssignments.length, 3);

    await assert.rejects(
      () => f.service.confirmWorkspaceChange({
        context: context(f.admin, { ...slackOrigin, channelId: 'C_OTHER' }),
        proposalId: proposal.outcomes[0]!.proposalId!,
      }),
      (error: unknown) => error instanceof ManagementError &&
        error.code === 'proposal_binding_mismatch',
    );
    assert.equal((await f.config.getAgentReferences('agent_test')).channelAssignments.length, 3);

    await f.service.confirmWorkspaceChange({
      context: context(f.admin, slackOrigin),
      proposalId: proposal.outcomes[0]!.proposalId!,
    });
    await assert.rejects(() => f.config.getAgent('agent_test'));
    for (const channelId of ['C1', 'C2', 'C3']) {
      assert.equal(await f.config.getAssignment('T1', channelId), undefined);
      assert.equal((await f.config.getChannel('T1', channelId))?.revision, 2);
    }
  } finally {
    f.close();
  }
});

test('stale confirmation is side-effect free', async () => {
  const f = await fixture();
  try {
    await f.config.createAgent(agent());
    const proposed = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'delete_stale',
      operations: [{
        itemId: 'delete',
        kind: 'delete_agent',
        agentId: 'agent_test',
        expectedRevision: 1,
      }],
    });
    await f.config.updateAgent('agent_test', { instructions: 'A newer edit.' }, 1);
    await assert.rejects(
      () => f.service.confirmWorkspaceChange({
        context: context(f.admin),
        proposalId: proposed.outcomes[0]!.proposalId!,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'proposal_stale',
    );
    assert.equal((await f.config.getAgent('agent_test')).revision, 2);
  } finally {
    f.close();
  }
});

test('idempotent progressive batches replay receipts, skip dependents, and continue independent work', async () => {
  const f = await fixture();
  try {
    const input = {
      context: context(f.admin),
      idempotencyKey: 'progressive',
      operations: [
        {
          itemId: 'missing',
          kind: 'update_agent' as const,
          agentId: 'agent_missing',
          expectedRevision: 1,
          patch: { instructions: 'No target.' },
        },
        {
          itemId: 'dependent',
          dependsOn: ['missing'],
          kind: 'create_agent' as const,
          agent: agent({ id: 'agent_skipped', name: 'Skipped' }),
        },
        {
          itemId: 'independent',
          kind: 'create_agent' as const,
          agent: agent({ id: 'agent_created', name: 'Created' }),
        },
      ],
    };
    const first = await f.service.applyWorkspaceChanges(input);
    assert.deepEqual(first.outcomes.map(({ disposition }) => disposition), [
      'failed', 'skipped', 'applied',
    ]);
    assert.equal(first.status, 'partial');
    assert.deepEqual(await f.service.applyWorkspaceChanges(input), first);
    assert.equal((await f.config.getAgent('agent_created')).revision, 1);
    await assert.rejects(() => f.config.getAgent('agent_skipped'));
    await assert.rejects(
      () => f.service.applyWorkspaceChanges({
        ...input,
        operations: [input.operations[2]!],
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'idempotency_conflict',
    );
  } finally {
    f.close();
  }
});

test('interrupted create reconciles the written revision without duplicating the object', async () => {
  const f = await fixture();
  try {
    let interrupt = true;
    const interruptedConfig = new Proxy(f.config as ConfigStore, {
      get(target, property, receiver) {
        if (property === 'createAgent') {
          return async (...args: Parameters<ConfigStore['createAgent']>) => {
            const created = await target.createAgent(...args);
            if (interrupt) {
              interrupt = false;
              throw new Error('simulated service interruption');
            }
            return created;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let sequence = 100;
    const service = new WorkspaceManagementService({
      identity: f.identity,
      config: interruptedConfig,
      management: f.management,
      now: () => START,
      randomId: () => `interrupt_${++sequence}`,
    });
    const input = {
      context: context(f.admin),
      idempotencyKey: 'interrupted',
      operations: [{
        itemId: 'create',
        kind: 'create_agent' as const,
        agent: agent({ id: 'agent_interrupted' }),
      }],
    };
    await assert.rejects(() => service.applyWorkspaceChanges(input), /simulated service interruption/);
    assert.equal((await f.config.getAgent('agent_interrupted')).revision, 1);
    const replay = await service.applyWorkspaceChanges(input);
    assert.equal(replay.status, 'completed');
    assert.equal((await f.config.listAgents()).filter(({ id }) => id === 'agent_interrupted').length, 1);
  } finally {
    f.close();
  }
});

test('undo restores a safe edit at its exact resulting revision and proposes risky inverses', async () => {
  const f = await fixture();
  try {
    await f.config.createAgent(agent());
    const edit = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'edit',
      operations: [{
        itemId: 'edit',
        kind: 'update_agent',
        agentId: 'agent_test',
        expectedRevision: 1,
        patch: { instructions: 'Use the new instructions.' },
      }],
    });
    assert.equal(edit.outcomes[0]?.undoAvailable, true);
    const undone = await f.service.undoWorkspaceChange({
      context: context(f.admin),
      operationId: edit.operationId,
      idempotencyKey: 'undo_edit',
    });
    assert.equal(undone.status, 'completed');
    assert.equal((await f.config.getAgent('agent_test')).instructions, 'Answer carefully.');
    assert.equal((await f.config.getAgent('agent_test')).revision, 3);

    const create = await f.service.applyWorkspaceChanges({
      context: context(f.admin),
      idempotencyKey: 'create_undo',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: agent({ id: 'agent_new' }),
      }],
    });
    const riskyUndo = await f.service.undoWorkspaceChange({
      context: context(f.admin),
      operationId: create.operationId,
      idempotencyKey: 'undo_create',
    });
    assert.equal(riskyUndo.status, 'confirmation_required');
    assert.equal((await f.config.getAgent('agent_new')).revision, 1);
  } finally {
    f.close();
  }
});
