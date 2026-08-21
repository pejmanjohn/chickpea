import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as v from 'valibot';

import { WorkspaceManagementService } from '../src/management/service.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import {
  managementOperationValibotSchema,
  managementOperationZodSchema,
} from '../src/management/schemas.ts';
import type { ManagementActorContext, ManagementOperation } from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const agentInput = {
  id: 'agent_support',
  name: 'Support Triage',
  description: 'Handles support triage.',
  requestedHandle: 'support',
  editPolicy: 'creator_and_admins' as const,
  instructions: 'Triage support requests.',
  enabled: true,
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

test('management operation schemas expose Agent presence, Channel reach, and lifecycle operations', () => {
  const operations: ManagementOperation[] = [
    { itemId: 'create', kind: 'create_agent', agent: agentInput },
    {
      itemId: 'update',
      kind: 'update_agent',
      agentId: 'agent_support',
      expectedRevision: 1,
      patch: {
        description: 'Updated support role.',
        requestedHandle: 'support-team',
        editPolicy: 'all_workspace_members',
      },
    },
    {
      itemId: 'channel',
      kind: 'put_channel',
      channel: { workspaceId: 'T123', channelId: 'C123', lifecycle: 'active' },
      expectedRevision: 0,
    },
    {
      itemId: 'grant',
      kind: 'grant_agent_channel',
      workspaceId: 'T123',
      channelId: 'C123',
      agentId: 'agent_support',
      expectedRevision: 0,
    },
    {
      itemId: 'revoke',
      kind: 'revoke_agent_channel',
      workspaceId: 'T123',
      channelId: 'C123',
      agentId: 'agent_support',
      expectedRevision: 1,
    },
    {
      itemId: 'archive',
      kind: 'archive_agent',
      agentId: 'agent_support',
      expectedRevision: 2,
      replacementDefaultAgentId: 'agent_default',
    },
    {
      itemId: 'restore',
      kind: 'restore_agent',
      agentId: 'agent_support',
      expectedRevision: 3,
    },
  ];
  for (const operation of operations) {
    assert.equal(managementOperationZodSchema.safeParse(operation).success, true, operation.kind);
    assert.equal(v.safeParse(managementOperationValibotSchema, operation).success, true, operation.kind);
  }
});

test('a full member creates an owned Agent and production publication seam owns the Channel grant', async () => {
  const f = await createManagementAdapterFixture('member-agent-parity');
  const provisioned = await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERPARITY',
    displayName: 'Member Parity',
  });
  const member = provisioned.resolution!;
  const context: ManagementActorContext = {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'member-client' },
  };
  let publishCalls = 0;
  let membershipChecks = 0;
  let sequence = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    setupBaseUrl: 'http://localhost',
    randomId: () => `member_parity_${++sequence}`,
    randomCapability: () => 'p'.repeat(43),
    assertAgentChannelMembership: async ({ actor, workspaceId, channelId }) => {
      membershipChecks += 1;
      assert.equal(actor.membershipId, member.membership.id);
      assert.equal(workspaceId, f.owner.binding.slackTeamId);
      assert.equal(channelId, 'CSUPPORT');
    },
    publishAgentChannel: async ({ actor, workspaceId, channelId, agentId }) => {
      publishCalls += 1;
      assert.equal(actor.membershipId, member.membership.id);
      const grant = await f.config.putAgentChannelGrant({
        workspaceId,
        channelId,
        agentId,
        status: 'active',
        createdByMembershipId: actor.membershipId,
        channelLabel: 'support',
      }, 0);
      return { agent: await f.config.getAgent(agentId), grant };
    },
  });
  try {
    const result = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'member-create-publish',
      operations: [
        { itemId: 'create', kind: 'create_agent', clientRef: 'support', agent: agentInput },
        {
          itemId: 'channel',
          kind: 'put_channel',
          channel: {
            workspaceId: f.owner.binding.slackTeamId,
            channelId: 'CSUPPORT',
            label: 'support',
            lifecycle: 'active',
          },
          expectedRevision: 0,
        },
        {
          itemId: 'grant',
          dependsOn: ['create', 'channel'],
          kind: 'grant_agent_channel',
          workspaceId: f.owner.binding.slackTeamId,
          channelId: 'CSUPPORT',
          agentClientRef: 'support',
          expectedRevision: 0,
        },
      ],
    });
    assert.equal(result.status, 'completed');
    assert.equal(membershipChecks, 1);
    assert.equal(publishCalls, 1);
    const agent = await f.config.getAgent('agent_support');
    assert.equal(agent.creatorMembershipId, member.membership.id);
    assert.equal(agent.description, 'Handles support triage.');
    assert.equal(agent.editPolicy, 'creator_and_admins');
    assert.equal(agent.slackPresence?.requestedHandle, 'support');
    assert.equal(agent.slackPresence?.normalizedHandle, 'support');
    assert.equal(agent.slackPresence?.avatar.kind, 'generated');
    assert.equal(agent.slackPresence?.avatar.seed, agent.id);
  } finally {
    f.close();
  }
});

test('members inspect and mutate only Agents permitted by canEditAgent', async () => {
  const f = await createManagementAdapterFixture('member-agent-scope');
  const first = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERSCOPE1',
    displayName: 'First Member',
  })).resolution!;
  const second = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERSCOPE2',
    displayName: 'Second Member',
  })).resolution!;
  const { requestedHandle: _requestedHandle, ...storedAgent } = agentInput;
  await f.config.createAgent({
    ...storedAgent,
    id: 'agent_private',
    creatorMembershipId: first.membership.id,
    lifecycle: 'draft',
    configurationGeneration: 1,
  });
  await f.config.putChannel({
    workspaceId: f.owner.binding.slackTeamId,
    channelId: 'CPRIVATE',
    label: 'private-agent-only',
    lifecycle: 'active',
  }, 0);
  await f.config.putAgentChannelGrant({
    workspaceId: f.owner.binding.slackTeamId,
    channelId: 'CPRIVATE',
    agentId: 'agent_private',
    status: 'active',
    createdByMembershipId: first.membership.id,
  }, 0);
  const context: ManagementActorContext = {
    userId: second.user.id,
    membershipId: second.membership.id,
    organizationId: second.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'second-member-client' },
  };
  try {
    const snapshot = await f.service.inspectWorkspace(context);
    assert.deepEqual(snapshot.agents, []);
    assert.deepEqual(snapshot.channels, []);
    assert.deepEqual(snapshot.providers, []);
    const denied = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'forbidden-other-agent',
      operations: [{
        itemId: 'update',
        kind: 'update_agent',
        agentId: 'agent_private',
        expectedRevision: 1,
        patch: { description: 'Should not be visible.' },
      }],
    });
    assert.equal(denied.status, 'partial');
    assert.equal(denied.outcomes[0]?.disposition, 'failed');
    assert.equal(denied.outcomes[0]?.code, 'forbidden');
  } finally {
    f.close();
  }
});

test('Agent presentation updates preserve avatar and observed Slack state', async () => {
  const f = await createManagementAdapterFixture('member-agent-presentation');
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERPRESENT',
    displayName: 'Presentation Member',
  })).resolution!;
  await f.config.createAgent({
    id: 'agent_present',
    name: 'Present',
    description: 'Before.',
    instructions: 'Present facts.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: member.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    slackPresence: {
      requestedHandle: 'present',
      normalizedHandle: 'present',
      desiredState: 'active',
      health: 'healthy',
      avatar: { kind: 'uploaded', revision: 7, url: 'https://assets.example/avatar.webp' },
      userGroupId: 'S123',
      observedAt: 123_456,
    },
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const context: ManagementActorContext = {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'presentation-client' },
  };
  let reconciles = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    setupBaseUrl: 'http://localhost',
    reconcileAgentUpdate: async ({ actor, agent, patch }) => {
      reconciles += 1;
      assert.equal(actor.membershipId, member.membership.id);
      assert.equal(patch.slackPresence?.requestedHandle, 'present-team');
      return f.config.updateAgent(agent.id, {
        slackPresence: {
          ...agent.slackPresence!,
          health: 'healthy',
          observedAt: 123_457,
        },
      }, agent.revision);
    },
  });
  try {
    const result = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'presentation-update',
      operations: [{
        itemId: 'update',
        kind: 'update_agent',
        agentId: 'agent_present',
        expectedRevision: 1,
        patch: {
          description: 'After.',
          requestedHandle: 'present-team',
          editPolicy: 'all_workspace_members',
        },
      }],
    });
    assert.equal(result.status, 'completed');
    assert.equal(reconciles, 1);
    const updated = await f.config.getAgent('agent_present');
    assert.equal(updated.description, 'After.');
    assert.equal(updated.editPolicy, 'all_workspace_members');
    assert.equal(updated.slackPresence?.requestedHandle, 'present-team');
    assert.equal(updated.slackPresence?.normalizedHandle, 'present-team');
    assert.equal(updated.slackPresence?.health, 'healthy');
    assert.deepEqual(updated.slackPresence?.avatar, {
      kind: 'uploaded',
      revision: 7,
      seed: 'agent_present',
      url: 'https://assets.example/avatar.webp',
    });
    assert.equal(updated.slackPresence?.observedAt, 123_457);
    assert.equal(updated.slackPresence?.userGroupId, 'S123');
  } finally {
    f.close();
  }
});

test('member-owned Agent archive and restore remain explicit confirmed operations', async () => {
  const f = await createManagementAdapterFixture('member-agent-lifecycle');
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERLIFECYCLE',
    displayName: 'Lifecycle Member',
  })).resolution!;
  await f.config.createAgent({
    id: 'agent_lifecycle',
    name: 'Lifecycle',
    instructions: 'Manage a lifecycle.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: member.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  let sequence = 0;
  let archives = 0;
  let restores = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    setupBaseUrl: 'http://localhost',
    now: () => 1_800_000_000_000,
    randomId: () => `lifecycle_${++sequence}`,
    randomCapability: () => 'l'.repeat(43),
    archiveAgent: async ({ agentId, expectedRevision, replacementDefaultAgentId }) => {
      archives += 1;
      return f.config.archiveAgent(agentId, {
        expectedRevision,
        ...(replacementDefaultAgentId ? { replacementDefaultAgentId } : {}),
      });
    },
    restoreAgent: async ({ agentId, expectedRevision }) => {
      restores += 1;
      return f.config.restoreAgent(agentId, expectedRevision);
    },
  });
  const context: ManagementActorContext = {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'lifecycle-client' },
  };
  try {
    const proposedArchive = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'archive-owned-agent',
      operations: [{
        itemId: 'archive',
        kind: 'archive_agent',
        agentId: 'agent_lifecycle',
        expectedRevision: 1,
      }],
    });
    assert.equal(proposedArchive.status, 'confirmation_required');
    assert.equal(archives, 0);
    const archived = await service.confirmWorkspaceChange({
      context,
      proposalId: proposedArchive.outcomes[0]!.proposalId!,
    });
    assert.equal(archived.status, 'completed');
    assert.equal(archives, 1);
    const archivedAgent = await f.config.getAgent('agent_lifecycle');
    assert.equal(archivedAgent.lifecycle, 'archived');

    const proposedRestore = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'restore-owned-agent',
      operations: [{
        itemId: 'restore',
        kind: 'restore_agent',
        agentId: 'agent_lifecycle',
        expectedRevision: archivedAgent.revision,
      }],
    });
    assert.equal(proposedRestore.status, 'confirmation_required');
    assert.equal(restores, 0);
    await service.confirmWorkspaceChange({
      context,
      proposalId: proposedRestore.outcomes[0]!.proposalId!,
    });
    assert.equal(restores, 1);
    assert.equal((await f.config.getAgent('agent_lifecycle')).lifecycle, 'active');
  } finally {
    f.close();
  }
});

test('a confirmed Channel publication resumes an interrupted pending Slack reconciliation', async () => {
  const f = await createManagementAdapterFixture('member-channel-resume');
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERRESUME',
    displayName: 'Resume Member',
  })).resolution!;
  await f.config.createAgent({
    id: 'agent_resume',
    name: 'Resume',
    instructions: 'Resume safely.',
    enabled: true,
    lifecycle: 'draft',
    creatorMembershipId: member.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await f.config.putChannel({
    workspaceId: f.owner.binding.slackTeamId,
    channelId: 'CRESUME',
    label: 'resume',
    lifecycle: 'active',
  }, 0);
  let sequence = 0;
  let attempts = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    setupBaseUrl: 'http://localhost',
    now: () => 1_800_000_000_000,
    randomId: () => `channel_resume_${++sequence}`,
    randomCapability: () => 'r'.repeat(43),
    publishAgentChannel: async ({ actor, workspaceId, channelId, agentId }) => {
      attempts += 1;
      const current = (await f.config.listAgentChannelGrants(workspaceId, channelId))
        .find((grant) => grant.agentId === agentId);
      if (!current) {
        await f.config.putAgentChannelGrant({
          workspaceId,
          channelId,
          agentId,
          status: 'pending',
          createdByMembershipId: actor.membershipId,
          channelLabel: 'resume',
        }, 0);
        throw new AgentPresenceError(
          'slack_unavailable',
          'Slack disconnected after the pending grant was saved.',
          { retryable: true },
        );
      }
      const grant = await f.config.putAgentChannelGrant({ ...current, status: 'active' }, current.revision);
      return { agent: await f.config.getAgent(agentId), grant };
    },
  });
  const context: ManagementActorContext = {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'channel-resume-client' },
  };
  try {
    const proposed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'publish-resume',
      operations: [{
        itemId: 'grant',
        kind: 'grant_agent_channel',
        workspaceId: f.owner.binding.slackTeamId,
        channelId: 'CRESUME',
        agentId: 'agent_resume',
        expectedRevision: 0,
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    const proposalId = proposed.outcomes[0]!.proposalId!;
    await assert.rejects(
      service.confirmWorkspaceChange({ context, proposalId }),
      AgentPresenceError,
    );
    assert.equal((await f.config.listAgentChannelGrants(
      f.owner.binding.slackTeamId,
      'CRESUME',
    ))[0]?.status, 'pending');
    const resumed = await service.confirmWorkspaceChange({ context, proposalId });
    assert.equal(resumed.status, 'completed');
    assert.equal(attempts, 2);
    assert.equal((await f.config.listAgentChannelGrants(
      f.owner.binding.slackTeamId,
      'CRESUME',
    ))[0]?.status, 'active');
  } finally {
    f.close();
  }
});
