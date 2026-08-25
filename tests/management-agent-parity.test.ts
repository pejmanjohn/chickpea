import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as v from 'valibot';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import {
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_URI,
  AGENT_AUTHORING_GUIDE_VERSION,
} from '../src/management/agent-authoring/index.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import {
  managementOperationValibotSchema,
  managementOperationZodSchema,
} from '../src/management/schemas.ts';
import type {
  ManagementActorContext,
  ManagementAgentPatch,
  ManagementOperation,
} from '../src/management/types.ts';
import { ManagementError } from '../src/management/types.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const agentInput = {
  id: 'agent_support',
  name: 'Support Triage',
  description: 'Handles support triage.',
  requestedHandle: 'support',
  editPolicy: 'creator_and_admins' as const,
  instructions: 'Triage support requests.',
  enabled: true,
  model: 'anthropic/claude-haiku-4-5',
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
  for (const invalidId of ['.', '..']) {
    const operation = {
      itemId: `invalid-${invalidId.length}`,
      kind: 'create_agent' as const,
      agent: { ...agentInput, id: invalidId },
    };
    assert.equal(managementOperationZodSchema.safeParse(operation).success, false);
    assert.equal(v.safeParse(managementOperationValibotSchema, operation).success, false);
  }
  for (const operation of [
    {
      itemId: 'invalid-create-model',
      kind: 'create_agent' as const,
      agent: { ...agentInput, model: 'claude-haiku-4-5' },
    },
    {
      itemId: 'invalid-update-model',
      kind: 'update_agent' as const,
      agentId: 'agent_support',
      expectedRevision: 1,
      patch: { model: 'claude-haiku-4-5' },
    },
  ]) {
    assert.equal(managementOperationZodSchema.safeParse(operation).success, false);
    assert.equal(v.safeParse(managementOperationValibotSchema, operation).success, false);
  }
});

test('Slack and MCP share exact proposal semantics while preserving origin binding', async () => {
  const f = await createManagementAdapterFixture('proposal-surface-parity');
  const agent = await f.config.createAgent({
    ...agentInput,
    creatorMembershipId: f.admin.membership.id,
    lifecycle: 'active',
    configurationGeneration: 1,
  });
  const signal = {
    agentId: CHICKPEA_AGENT_ID,
    workspaceId: f.admin.binding.slackTeamId,
    channelId: 'D_AUTHORING',
    threadTs: '100.1',
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_AUTHORING',
    messageTs: '100.2',
    turnJobId: 'turn_AUTHORING',
  };
  try {
    const operation: ManagementOperation = {
      itemId: 'description',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { description: 'Handles escalated support.' },
    };
    const proposed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('surface-parity'),
        operations: [operation],
      },
    });
    assert.equal(proposed.ok, true);
    const result = (proposed as { ok: true; result: {
      proposalId: string;
      guide: { version: string; uri: string; digest: string };
    } }).result;
    assert.deepEqual(result.guide, {
      version: AGENT_AUTHORING_GUIDE_VERSION,
      uri: AGENT_AUTHORING_GUIDE_URI,
      digest: AGENT_AUTHORING_GUIDE_DIGEST,
    });
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision);

    const mcpConfirmation = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => ({
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'proposal-surface-parity' },
      }),
    }, 'confirm_workspace_change', { proposalId: result.proposalId });
    assert.deepEqual(mcpConfirmation, {
      ok: false,
      error: {
        code: 'proposal_binding_mismatch',
        message: 'The confirmation does not match its initiating user and origin.',
      },
    });

    const wrongThread = await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, threadTs: '100.9' },
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: result.proposalId },
    });
    assert.equal(wrongThread.ok, false);
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision);

    const confirmed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: result.proposalId },
    });
    assert.equal(confirmed.ok, true);
    assert.equal((await f.config.getAgent(agent.id)).description, 'Handles escalated support.');

    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    const rejected = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('surface-parity-secret'),
        operations: [{
          ...operation,
          expectedRevision: (await f.config.getAgent(agent.id)).revision,
          patch: { instructions: `Use ${secret}` },
        }],
      },
    });
    assert.equal(rejected.ok, false);
    assert.doesNotMatch(JSON.stringify(rejected), new RegExp(secret));
  } finally {
    f.close();
  }
});

test('exact create proposal writes nothing before approval and creates only the active base Agent', async () => {
  const f = await createManagementAdapterFixture('exact-create-proposal');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'exact-create-client' },
  };
  try {
    const proposed = await f.service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('exact-create', 'agent_creation'),
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: {
          ...agentInput,
          skills: [{
            name: 'support-triage',
            description: 'Triage a newly reported customer support issue.',
            instructions: 'Inspect the report, classify urgency, and propose the next owner.',
            enabled: true,
          }],
        },
      }],
    });
    assert.equal(proposed.status, 'pending');
    assert.equal(proposed.confirmationTool, 'confirm_workspace_change');
    assert.equal(proposed.preview.changes[0]?.operationKind, 'create_agent');
    await assert.rejects(() => f.config.getAgent('agent_support'));
    assert.deepEqual(await f.config.listAgentChannelGrants(), []);

    const confirmed = await f.service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.equal(confirmed.status, 'completed');
    const created = await f.config.getAgent('agent_support');
    assert.equal(created.lifecycle, 'active');
    assert.equal(created.enabled, true);
    assert.equal(created.slackPresence?.desiredState, 'unpublished');
    assert.equal(created.slackPresence?.health, 'unpublished');
    assert.deepEqual(created.mcpServers, []);
    assert.deepEqual(created.apiConnections, []);
    assert.deepEqual(created.repositories, []);
    assert.equal(created.skills[0]?.name, 'support-triage');
    assert.deepEqual(await f.config.listAgentChannelGrants(), []);

    const replay = await f.service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.deepEqual(replay, confirmed);
    assert.equal((await f.config.listUserAgents()).filter(({ id }) => id === 'agent_support').length, 1);
  } finally {
    f.close();
  }
});

test('change-set proposal preflights the whole set and stales before the first write', async () => {
  const f = await createManagementAdapterFixture('whole-set-stale');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'whole-set-client' },
  };
  try {
    for (const [id, name] of [['agent_alpha', 'Alpha'], ['agent_beta', 'Beta']] as const) {
      await f.config.createAgent({
        id, name, instructions: `Run ${name}.`, enabled: true, lifecycle: 'active',
        creatorMembershipId: f.admin.membership.id, configurationGeneration: 1,
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
      });
    }
    const proposed = await f.service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('whole-set'),
      operations: [
        {
          itemId: 'alpha', kind: 'update_agent', agentId: 'agent_alpha',
          expectedRevision: 1, patch: { description: 'New Alpha.' },
        },
        {
          itemId: 'beta', kind: 'update_agent', agentId: 'agent_beta',
          expectedRevision: 1, patch: { description: 'New Beta.' },
        },
      ],
    });
    await f.config.updateAgent('agent_beta', { description: 'Concurrent Beta.' }, 1);
    await assert.rejects(
      () => f.service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
      (error: unknown) => error instanceof ManagementError && error.code === 'revision_conflict',
    );
    assert.equal((await f.config.getAgent('agent_alpha')).description, undefined);
    assert.equal((await f.management.getChangeSetProposal(proposed.proposalId))?.status, 'stale');
  } finally {
    f.close();
  }
});

test('legacy apply routes creation and compound or skill edits through confirmation', async () => {
  const f = await createManagementAdapterFixture('legacy-review-floor');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'legacy-review-client' },
  };
  try {
    const create = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'legacy-create',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.equal(create.status, 'confirmation_required');
    await assert.rejects(() => f.config.getAgent('agent_support'));
    await f.service.confirmWorkspaceChange({
      context,
      proposalId: create.outcomes[0]!.proposalId!,
    });
    const current = await f.config.getAgent('agent_support');

    const patches: Array<[string, ManagementAgentPatch]> = [
      ['compound', { name: 'Support', description: 'Updated.' }],
      ['skill', { skills: [{
        name: 'support-triage', description: 'Triage support.', instructions: 'Triage it.', enabled: true,
      }] }],
    ];
    for (const [idempotencyKey, patch] of patches) {
      const result = await f.service.applyWorkspaceChanges({
        context,
        idempotencyKey,
        operations: [{
          itemId: idempotencyKey,
          kind: 'update_agent',
          agentId: current.id,
          expectedRevision: current.revision,
          patch,
        }],
      });
      assert.equal(result.status, 'confirmation_required');
    }
  } finally {
    f.close();
  }
});

test('authoring proposals reject capability-bearing creation and remain origin-bound', async () => {
  const f = await createManagementAdapterFixture('proposal-safety');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'proposal-owner' },
  };
  try {
    await assert.rejects(
      () => f.service.proposeWorkspaceChanges({
        context,
        ...authoringProposalMetadata('capability-bearing-create', 'agent_creation'),
        operations: [{
          itemId: 'create', kind: 'create_agent',
          agent: {
            ...agentInput,
            repositories: [{
              id: 'repo_support', installationId: 1, accountLogin: 'acme',
              fullName: 'acme/support', enabled: true,
            }],
          },
        }],
      }),
      (error: unknown) => error instanceof Error &&
        'code' in error && error.code === 'base_agent_capabilities_require_setup',
    );
    const proposed = await f.service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('proposal-safety-create', 'agent_creation'),
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    await assert.rejects(
      () => f.service.confirmWorkspaceChange({
        context: { ...context, origin: { kind: 'mcp', clientId: 'different-client' } },
        proposalId: proposed.proposalId,
      }),
      (error: unknown) => error instanceof Error &&
        'code' in error && error.code === 'proposal_binding_mismatch',
    );
    await assert.rejects(() => f.config.getAgent('agent_support'));
  } finally {
    f.close();
  }
});

test('admitted change sets return a content-free partial receipt when a later item fails', async () => {
  const f = await createManagementAdapterFixture('proposal-partial');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'partial-client' },
  };
  for (const [id, name] of [['agent_first', 'First'], ['agent_second', 'Second']] as const) {
    await f.config.createAgent({
      id, name, instructions: `Run ${name}.`, enabled: true, lifecycle: 'active',
      creatorMembershipId: f.admin.membership.id, configurationGeneration: 1,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
  }
  let sequence = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    randomId: () => `partial_${++sequence}`,
    prepareAgentUpdate: async (agent) => {
      if (agent.id === 'agent_second') {
        throw new ManagementError('invalid_request', 'Synthetic downstream denial.');
      }
    },
  });
  try {
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('partial'),
      operations: [
        {
          itemId: 'first', kind: 'update_agent', agentId: 'agent_first',
          expectedRevision: 1, patch: { description: 'Reviewed first.' },
        },
        {
          itemId: 'second', kind: 'update_agent', agentId: 'agent_second',
          expectedRevision: 1, patch: { description: 'Reviewed second.' },
        },
      ],
    });
    const confirmed = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.equal(confirmed.status, 'partial');
    assert.equal(confirmed.outcomes[0]?.disposition, 'applied');
    assert.equal(confirmed.outcomes[1]?.disposition, 'failed');
    assert.equal(confirmed.outcomes[1]?.code, 'invalid_request');
    assert.equal((await f.config.getAgent('agent_first')).description, 'Reviewed first.');
    assert.equal((await f.config.getAgent('agent_second')).description, undefined);
    assert.doesNotMatch(JSON.stringify(
      await f.management.getChangeSetProposal(proposed.proposalId),
    ), /Synthetic downstream denial/);
  } finally {
    f.close();
  }
});

test('concurrent confirmations acquire one change-set execution claim', async () => {
  const f = await createManagementAdapterFixture('proposal-concurrent-claim');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'concurrent-claim-client' },
  };
  let removalCalls = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    providerCredentialSource: async () => 'stored',
    providerCredentialRevision: async () => 1,
    removeProviderCredential: async () => {
      removalCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'missing';
    },
  });
  try {
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('concurrent-provider-removal'),
      operations: [{
        itemId: 'remove-provider',
        kind: 'remove_provider_credential',
        providerId: 'openai',
      }],
    });
    const confirmations = await Promise.allSettled([
      service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
      service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
    ]);
    assert.equal(removalCalls, 1);
    assert.equal(confirmations.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(confirmations.filter(({ status }) => status === 'rejected').length, 1);
    assert.equal(
      (await f.management.getChangeSetProposal(proposed.proposalId))?.status,
      'completed',
    );
  } finally {
    f.close();
  }
});

test('confirmation preflights deterministic failures before an earlier item writes', async () => {
  const f = await createManagementAdapterFixture('proposal-admission-preflight');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'admission-preflight-client' },
  };
  try {
    const first = await f.config.createAgent({
      id: 'agent_first', name: 'First', instructions: 'Run first.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const second = await f.config.createAgent({
      id: 'agent_second', name: 'Second', instructions: 'Run second.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const proposed = await f.service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('admission-preflight'),
      operations: [
        {
          itemId: 'first', kind: 'update_agent', agentId: first.id,
          expectedRevision: first.revision, patch: { description: 'Must remain unchanged.' },
        },
        {
          itemId: 'second', kind: 'delete_agent', agentId: second.id,
          expectedRevision: second.revision,
        },
      ],
    });
    await f.config.putChannel({
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'C_PREFLIGHT',
      lifecycle: 'active',
    }, 0);
    await f.config.putAgentChannelGrant({
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'C_PREFLIGHT',
      agentId: second.id,
      status: 'active',
      createdByMembershipId: f.admin.membership.id,
    }, 0);
    await assert.rejects(
      () => f.service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
      (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    );
    assert.equal((await f.config.getAgent(first.id)).description, undefined);
    assert.equal((await f.management.getChangeSetProposal(proposed.proposalId))?.status, 'stale');
  } finally {
    f.close();
  }
});

test('a full member creates an owned Agent before confirmed Channel publication', async () => {
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
      const draft = await f.config.getAgent(agentId);
      await f.config.updateAgent(
        agentId,
        { lifecycle: 'active', enabled: true },
        draft.revision,
      );
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
    for (const invalidId of ['.', '..']) {
      await assert.rejects(
        service.applyWorkspaceChanges({
          context,
          idempotencyKey: `member-invalid-agent-${invalidId.length}`,
          operations: [{
            itemId: `invalid-agent-${invalidId.length}`,
            kind: 'create_agent',
            agent: { ...agentInput, id: invalidId },
          }],
        }),
        (error: unknown) => error instanceof Error &&
          error.message.includes('Agent IDs must start with a lowercase letter or digit'),
      );
    }
    const createResult = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'member-create',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.equal(createResult.status, 'confirmation_required');
    await assert.rejects(() => f.config.getAgent('agent_support'));
    const created = await service.confirmWorkspaceChange({
      context,
      proposalId: createResult.outcomes[0]!.proposalId!,
    });
    assert.equal((await f.config.getAgent('agent_support')).lifecycle, 'active');
    assert.equal(
      new URL(created.outcomes[0]!.handoffUrl!).pathname,
      '/admin/agents/agent_support',
    );

    const result = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'member-publish',
      operations: [
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
          dependsOn: ['channel'],
          kind: 'grant_agent_channel',
          workspaceId: f.owner.binding.slackTeamId,
          channelId: 'CSUPPORT',
          agentId: 'agent_support',
          expectedRevision: 0,
        },
      ],
    });
    assert.equal(result.status, 'confirmation_required');
    assert.equal(membershipChecks, 1);
    assert.equal(publishCalls, 0);
    await service.confirmWorkspaceChange({
      context,
      proposalId: result.outcomes.find(({ itemId }) => itemId === 'grant')!.proposalId!,
    });
    assert.equal(publishCalls, 1);
    const agent = await f.config.getAgent('agent_support');
    assert.equal(agent.creatorMembershipId, member.membership.id);
    assert.equal(agent.description, 'Handles support triage.');
    assert.equal(agent.editPolicy, 'creator_and_admins');
    assert.equal(agent.slackPresence?.requestedHandle, 'support');
    assert.equal(agent.slackPresence?.normalizedHandle, 'support');
    assert.equal(agent.slackPresence?.avatar.kind, 'generated');
    assert.match(agent.slackPresence?.avatar.seed ?? '', /^chickpea-avatar-v1:\d{2}:/);
  } finally {
    f.close();
  }
});

test('confirmed publication may import a live Slack Channel that is not in Chickpea yet', async () => {
  const f = await createManagementAdapterFixture('member-live-channel-import');
  const provisioned = await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERLIVECHANNEL',
    displayName: 'Live Channel Member',
  });
  const member = provisioned.resolution!;
  const context: ManagementActorContext = {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: {
      kind: 'slack',
      workspaceId: f.owner.binding.slackTeamId,
      channelId: 'CNEWINSLACK',
      threadTs: '1710000000.000001',
    },
  };
  const { requestedHandle: _requestedHandle, ...storedAgent } = agentInput;
  await f.config.createAgent({
    ...storedAgent,
    id: 'agent_live_channel',
    creatorMembershipId: member.membership.id,
    lifecycle: 'draft',
    configurationGeneration: 1,
  });
  let sequence = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    randomId: () => `live_channel_import_${++sequence}`,
    publishAgentChannel: async ({ actor, workspaceId, channelId, agentId }) => {
      assert.equal(await f.config.getChannel(workspaceId, channelId), undefined);
      await f.config.putChannel({
        workspaceId,
        channelId,
        label: 'new-in-slack',
        lifecycle: 'active',
      }, 0);
      const grant = await f.config.putAgentChannelGrant({
        workspaceId,
        channelId,
        agentId,
        status: 'active',
        createdByMembershipId: actor.membershipId,
        channelLabel: 'new-in-slack',
      }, 0);
      return { agent: await f.config.getAgent(agentId), grant };
    },
  });
  try {
    const proposed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'live-channel-import-proposal',
      operations: [{
        itemId: 'grant',
        kind: 'grant_agent_channel',
        workspaceId: f.owner.binding.slackTeamId,
        channelId: 'CNEWINSLACK',
        agentId: 'agent_live_channel',
        expectedRevision: 0,
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    const confirmed = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal(confirmed.status, 'completed');
    assert.equal(
      (await f.config.getChannel(f.owner.binding.slackTeamId, 'CNEWINSLACK'))?.label,
      'new-in-slack',
    );
    assert.equal(
      (await f.config.listAgentChannelGrants(
        f.owner.binding.slackTeamId,
        'CNEWINSLACK',
      ))[0]?.status,
      'active',
    );
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
    assert.equal(result.status, 'confirmation_required');
    assert.equal(reconciles, 0);
    await service.confirmWorkspaceChange({
      context,
      proposalId: result.outcomes[0]!.proposalId!,
    });
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
    assert.deepEqual(await invokeWorkspaceManagementTool({
      service,
      resolveContext: async () => context,
    }, 'confirm_workspace_change', { proposalId }), {
      ok: false,
      error: {
        code: 'slack_unavailable',
        message: 'Slack disconnected after the pending grant was saved.',
      },
    });
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
