import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
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
  const service = new WorkspaceManagementService({
    identity,
    config,
    management,
    now: () => now,
    randomId: () => `id_${++sequence}`,
  });
  return {
    identity,
    owner,
    admin,
    config,
    management,
    service,
    tick: (milliseconds = 1) => { now += milliseconds; },
    close: () => {
      identity.close();
      config.close();
      management.close();
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
