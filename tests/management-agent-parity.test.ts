import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as v from 'valibot';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { UnknownAgentError } from '../src/config/errors.ts';
import {
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_URI,
  AGENT_AUTHORING_GUIDE_VERSION,
} from '../src/management/agent-authoring/index.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import { resolvePrivateAgentAccess } from '../src/slack/agent-access.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import { classifySlackInteraction } from '../src/slack/interaction-intent.ts';
import { slackMarkdownBlockTextLimit } from '../src/slack/message-format.ts';
import { normalizeSlackTurn } from '../src/slack/turn-normalization.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import {
  executeHostSlackManagementApproval,
  resolveHostSlackManagementApproval,
} from '../src/management/slack-approval.ts';
import {
  invokeWorkspaceManagementTool,
  workspaceManagementSemanticInvocation,
} from '../src/management/tool-adapter.ts';
import { narrateSemanticActivity } from '../src/activity/semantic.ts';
import {
  managementOperationValibotSchema,
  managementOperationZodSchema,
} from '../src/management/schemas.ts';
import type {
  ManagementActorContext,
  ManagementAgentPatch,
  ManagementOperation,
  ManagementWorkspaceSnapshot,
} from '../src/management/types.ts';
import { ManagementError } from '../src/management/types.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { appMention, channelThreadMessage } from './helpers/slack-fixtures.ts';

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

test('workspace management emits a closed inspection fact without operation bodies', () => {
  const secret = 'Agent instructions xoxb-do-not-leak';
  const fact = workspaceManagementSemanticInvocation('call_workspace_1', 'inspect_workspace');
  assert.deepEqual(narrateSemanticActivity(fact.descriptor, { phase: 'started' }), {
    kind: 'checking',
    action: 'Inspecting',
    object: 'workspace settings',
    family: 'workspace',
    phase: 'working',
    text: 'Inspecting workspace settings…',
  });
  assert.deepEqual(narrateSemanticActivity(fact.descriptor, {
    phase: 'settled', outcome: 'succeeded',
  }), {
    kind: 'reading',
    action: 'Reviewing',
    object: 'workspace settings',
    family: 'workspace',
    phase: 'reviewing',
    text: 'Reviewing workspace settings…',
  });
  assert.doesNotMatch(JSON.stringify(fact), new RegExp(secret));
  assert.deepEqual(Object.keys(fact).sort(), ['descriptor', 'toolCallId']);
});

test('management operation schemas expose Agent presence, Channel reach, and lifecycle operations', () => {
  const operations: ManagementOperation[] = [
    {
      itemId: 'create',
      kind: 'create_agent',
      duplicateResolution: 'create_distinct',
      agent: agentInput,
    },
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
      patch: {
        description: 'Handles escalated support.',
        instructions: 'Triage support requests and coordinate the right follow-up.',
      },
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
      presentation: { slack: string };
    } }).result;
    assert.deepEqual(result.guide, {
      version: AGENT_AUTHORING_GUIDE_VERSION,
      uri: AGENT_AUTHORING_GUIDE_URI,
      digest: AGENT_AUTHORING_GUIDE_DIGEST,
    });
    assert.match(result.presentation.slack, /Description/);
    assert.match(result.presentation.slack, /Handles support triage\./);
    assert.match(result.presentation.slack, /Handles escalated support\./);
    assert.match(result.presentation.slack, /Instructions/);
    assert.match(result.presentation.slack, /Triage support requests\./);
    assert.match(
      result.presentation.slack,
      /Triage support requests and coordinate the right follow-up\./,
    );
    assert.doesNotMatch(result.presentation.slack, /changeset_/);
    assert.match(result.presentation.slack, /Reply `approve`/);
    assert.equal('expiresAt' in result, false);
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision);
    const pending = await f.management.getChangeSetProposal(result.proposalId);
    assert.ok(pending);

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

    const approval = await classifySlackInteraction({
      workspaceId: signal.workspaceId,
      channelId: signal.channelId,
      eventId: 'Ev_APPROVE',
      text: 'approve',
      source: 'implicit_thread_reply',
      guaranteed: true,
      profileInstructions: agent.instructions,
    }, undefined, async () => JSON.stringify({
      disposition: 'react_only',
      reason: 'state_change',
      reaction: 'approved',
      target: 'trigger',
    }));
    assert.deepEqual(approval.intent, {
      disposition: 'reply',
      reason: 'substantive_request',
    });

    const confirmed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: result.proposalId },
    });
    assert.equal(confirmed.ok, true);
    const updated = await f.config.getAgent(agent.id);
    assert.equal(updated.revision, agent.revision + 1);
    assert.equal(updated.description, 'Handles escalated support.');
    assert.equal(
      updated.instructions,
      'Triage support requests and coordinate the right follow-up.',
    );

    const longInstruction = 'Long instruction. '.repeat(1_000);
    const oversized = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('surface-parity-oversized'),
        operations: [{
          ...operation,
          expectedRevision: updated.revision,
          patch: { instructions: longInstruction },
        }],
      },
    });
    assert.equal(oversized.ok, true);
    const oversizedResult = (oversized as { ok: true; result: {
      proposalId: string;
      presentation: { slack: string };
    } }).result;
    assert.ok(oversizedResult.presentation.slack.length <= slackMarkdownBlockTextLimit);
    assert.match(oversizedResult.presentation.slack, /Preview truncated to fit Slack/);
    assert.match(oversizedResult.presentation.slack, /Reply `approve`/);
    assert.equal(oversizedResult.presentation.slack.includes(longInstruction), false);
    assert.equal((await f.config.getAgent(agent.id)).instructions, updated.instructions);

    const oversizedConfirmed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: oversizedResult.proposalId },
    });
    assert.equal(oversizedConfirmed.ok, true);
    assert.equal(
      (await f.config.getAgent(agent.id)).instructions,
      longInstruction,
    );

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

test('a top-level DM approval confirms the same pending proposal without model continuity', async () => {
  const f = await createManagementAdapterFixture('dm-approval-scope');
  const chickpea = await f.config.materializeChickpeaAgent();
  const agent = await f.config.createAgent({
    ...agentInput,
    id: 'agent_dm_scope',
    creatorMembershipId: f.admin.membership.id,
    lifecycle: 'active',
    configurationGeneration: 1,
  });
  const installation = await f.config.ensureWorkspaceInstallation({
    workspaceId: f.admin.binding.slackTeamId,
    transportMode: 'direct',
    defaultAgentId: agent.id,
    teamId: f.admin.binding.slackTeamId,
    botUserId: 'U_CHICKPEA',
  });
  await f.config.updateWorkspaceInstallation(
    f.admin.binding.slackTeamId,
    { runtimeContract: 'chickpea-v1', health: 'healthy' },
    installation.revision,
  );
  const proposalSignal = {
    agentId: CHICKPEA_AGENT_ID,
    workspaceId: f.admin.binding.slackTeamId,
    channelId: 'D_AUTHORING',
    threadTs: '100.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_DM_PROPOSAL',
    messageTs: '100.1',
    turnJobId: 'turn_DM_PROPOSAL',
  };
  try {
    const proposed = await invokeSlackWorkspaceManagementTool({
      signal: proposalSignal,
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('dm-approval-scope'),
        operations: [{
          itemId: 'description',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: agent.revision,
          patch: { description: 'Confirmed from a fresh top-level DM turn.' },
        }],
      },
    });
    assert.equal(proposed.ok, true);
    const proposalId = (proposed as { ok: true; result: { proposalId: string } }).result.proposalId;

    const topLevelApprovalTurn = {
        workspaceId: proposalSignal.workspaceId,
        channelId: proposalSignal.channelId,
        eventId: 'Ev_DM_APPROVAL',
        text: 'create it',
        userId: proposalSignal.slackUserId,
        actorMembershipId: f.admin.membership.id,
        messageTs: '200.1',
        threadTs: '200.1',
        source: 'dm_message',
        contextMode: 'dm_history',
      } as const;
    const approvalAssignment = {
      workspaceId: proposalSignal.workspaceId,
      channelId: proposalSignal.channelId,
      agentId: CHICKPEA_AGENT_ID,
      model: 'local-stub/management',
      modelAttribution: { source: 'pinned' as const, providerId: 'local-stub' },
      runtimeContract: 'chickpea-v1' as const,
      agent: chickpea,
    };
    const resolveApproval = (turn: typeof topLevelApprovalTurn | {
      workspaceId: string;
      channelId: string;
      eventId: string;
      text: string;
      userId: string;
      actorMembershipId: string;
      messageTs: string;
      threadTs: string;
      source: 'dm_message';
      contextMode: 'thread';
    }) => resolveHostSlackManagementApproval({
      turn,
      assignment: approvalAssignment,
      actorMembershipId: f.admin.membership.id,
      identity: f.identity,
      management: f.management,
    });

    assert.equal(await resolveApproval(topLevelApprovalTurn), proposalId);
    assert.equal(await resolveApproval({
      ...topLevelApprovalTurn,
      eventId: 'Ev_DM_WRONG_THREAD',
      messageTs: '999.2',
      threadTs: '999.1',
      contextMode: 'thread',
    }), undefined);
    assert.equal(await resolveApproval({
      ...topLevelApprovalTurn,
      eventId: 'Ev_DM_ORIGINAL_THREAD',
      messageTs: '100.2',
      threadTs: '100.1',
      contextMode: 'thread',
    }), proposalId);

    assert.equal(await resolveHostSlackManagementApproval({
      turn: topLevelApprovalTurn,
      assignment: {
        ...approvalAssignment,
        agentId: agent.id,
        agent,
      },
      actorMembershipId: f.admin.membership.id,
      identity: f.identity,
      management: f.management,
    }), undefined);

    const confirmed = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...proposalSignal,
        threadTs: '200.1',
        messageTs: '200.1',
        eventId: 'Ev_DM_APPROVAL',
        turnJobId: 'turn_DM_APPROVAL',
      },
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId },
    });

    assert.equal(confirmed.ok, true);
    assert.equal(
      (await f.config.getAgent(agent.id)).description,
      'Confirmed from a fresh top-level DM turn.',
    );
  } finally {
    f.close();
  }
});

test('a plain Channel thread reply reaches a consequential proposal opened by an explicit Chickpea mention', async () => {
  const f = await createManagementAdapterFixture('channel-approval-route');
  await f.config.materializeChickpeaAgent();
  const legacyDefault = await f.config.createAgent({
    ...agentInput,
    id: 'agent_channel_approval_default',
    name: 'Legacy Default',
    creatorMembershipId: f.admin.membership.id,
    lifecycle: 'active',
    configurationGeneration: 1,
  });
  const installation = await f.config.ensureWorkspaceInstallation({
    workspaceId: f.admin.binding.slackTeamId,
    transportMode: 'direct',
    defaultAgentId: legacyDefault.id,
    teamId: f.admin.binding.slackTeamId,
    botUserId: 'U_CHICKPEA',
  });
  await f.config.updateWorkspaceInstallation(
    f.admin.binding.slackTeamId,
    { runtimeContract: 'chickpea-v1', health: 'healthy' },
    installation.revision,
  );
  const workspaceId = f.admin.binding.slackTeamId;
  const channelId = 'C_CHANNEL_APPROVAL';
  const threadTs = '100.1';
  const actor = { channelMember: true, fullMember: true };
  await f.config.putChannel({
    workspaceId,
    channelId,
    label: 'channel-approval',
    lifecycle: 'active',
  }, 0);
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    memory: f.memory,
    routines: f.routines,
    routineSchedulingAvailable: true,
    setupBaseUrl: 'http://localhost',
    now: () => 1_800_000_000_000,
    randomId: () => 'channel_approval_route',
    assertAgentChannelMembership: async () => undefined,
  });
  try {
    const normalizedRoot = normalizeSlackTurn(appMention({
      team_id: workspaceId,
      event_id: 'Ev_CHANNEL_PROPOSAL',
      event: {
        channel: channelId,
        user: f.admin.binding.slackUserId,
        ts: threadTs,
        text: '<@U_CHICKPEA> update the default Agent description',
      },
    }), { botUserId: 'U_CHICKPEA' });
    assert.equal(normalizedRoot.status, 'runnable');
    if (normalizedRoot.status !== 'runnable') return;
    const root = await resolveAgentRoute({
      turn: normalizedRoot.turn,
      surface: 'channel',
      actor,
      config: f.config,
    });
    assert.equal(root.kind, 'routed');
    if (root.kind !== 'routed') return;
    assert.equal(root.assignment.interactionMode, 'workspace_management');

    const proposed = await invokeSlackWorkspaceManagementTool({
      signal: {
        agentId: CHICKPEA_AGENT_ID,
        workspaceId,
        channelId,
        threadTs,
        conversationKind: 'channel',
        slackUserId: f.admin.binding.slackUserId,
        eventId: 'Ev_CHANNEL_PROPOSAL',
        messageTs: threadTs,
        turnJobId: 'turn_CHANNEL_PROPOSAL',
      },
      identity: f.identity,
      service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('channel-approval-route', 'agent_edit'),
        operations: [{
          itemId: 'update',
          kind: 'update_agent',
          agentId: legacyDefault.id,
          expectedRevision: legacyDefault.revision,
          patch: { description: 'Updated after review.' },
        }],
      },
    });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const proposalId = (proposed as { ok: true; result: { proposalId: string } })
      .result.proposalId;

    const normalizedApproval = normalizeSlackTurn(channelThreadMessage({
      team_id: workspaceId,
      event_id: 'Ev_CHANNEL_APPROVAL',
      event: {
        channel: channelId,
        channel_type: 'channel',
        user: f.admin.binding.slackUserId,
        ts: '100.2',
        thread_ts: threadTs,
        text: 'approve it',
      },
    }), { botUserId: 'U_CHICKPEA' });
    assert.equal(normalizedApproval.status, 'runnable');
    if (normalizedApproval.status !== 'runnable') return;
    const approvalTurn = normalizedApproval.turn;
    const approvalRoute = await resolveAgentRoute({
      turn: approvalTurn,
      surface: 'channel',
      actor,
      config: f.config,
    });
    assert.equal(approvalRoute.kind, 'routed');
    if (approvalRoute.kind !== 'routed') return;
    assert.equal(approvalRoute.source, 'thread_owner');
    assert.equal(approvalRoute.assignment.agentId, CHICKPEA_AGENT_ID);
    assert.equal(approvalRoute.assignment.interactionMode, 'workspace_management');
    assert.equal(
      (await f.config.listAgentChannelGrants(workspaceId, channelId)).length,
      0,
    );
    assert.equal(await resolveHostSlackManagementApproval({
      turn: approvalTurn,
      assignment: approvalRoute.assignment,
      actorMembershipId: f.admin.membership.id,
      identity: f.identity,
      management: f.management,
    }), proposalId);
  } finally {
    f.close();
  }
});

test('host approval receipts never claim that a failed change was applied', async () => {
  const f = await createManagementAdapterFixture('host-approval-receipt-truth');
  const chickpea = await f.config.materializeChickpeaAgent();
  const turn = {
    workspaceId: f.admin.binding.slackTeamId,
    channelId: 'D_HOST_RECEIPT',
    eventId: 'Ev_HOST_RECEIPT',
    text: 'create it',
    userId: f.admin.binding.slackUserId,
    messageTs: '200.1',
    threadTs: '200.1',
    source: 'dm_message' as const,
    contextMode: 'dm_history' as const,
  };
  const assignment = {
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    agentId: CHICKPEA_AGENT_ID,
    runtimeContract: 'chickpea-v1' as const,
    agent: chickpea,
  };
  try {
    const failed = await executeHostSlackManagementApproval({
      turn,
      assignment,
      turnJobId: 'turn_HOST_RECEIPT',
      proposalId: 'changeset_failed',
      dependencies: {
        identity: f.identity,
        config: f.config,
        management: f.management,
        service: {
          confirmWorkspaceChange: async () => ({
            operationId: 'changeset_failed',
            idempotencyKey: 'failed',
            status: 'partial',
            outcomes: [{
              itemId: 'create',
              operationKind: 'create_agent',
              disposition: 'failed',
              code: 'revision_conflict',
            }],
            effectiveRevision: 'rev_failed',
            activation: 'next_turn',
          }),
        } as unknown as WorkspaceManagementService,
      },
    });
    assert.equal(failed.kind, 'message');
    if (failed.kind !== 'message') assert.fail('expected failure message');
    assert.match(failed.text, /couldn’t apply the approved changes/);
    assert.match(failed.text, /Nothing was changed/);
    assert.doesNotMatch(failed.text, /^Applied/);

    let confirmAttempts = 0;
    const recovered = await executeHostSlackManagementApproval({
      turn,
      assignment,
      turnJobId: 'turn_HOST_RECEIPT_RETRY',
      proposalId: 'changeset_applying',
      dependencies: {
        identity: f.identity,
        config: f.config,
        management: f.management,
        service: {
          confirmWorkspaceChange: async () => {
            confirmAttempts += 1;
            throw new ManagementError('operation_in_progress', 'Still applying.');
          },
        } as unknown as WorkspaceManagementService,
      },
    });
    assert.deepEqual(recovered, {
      kind: 'message',
      text: 'That proposal is still being applied; it won’t be applied twice.',
    });
    assert.equal(confirmAttempts, 1);
  } finally {
    f.close();
  }
});

test('clean Slack Agent creation queues one Agent welcome instead of a Chickpea success receipt', async () => {
  const f = await createManagementAdapterFixture('host-creation-welcome');
  const created = await f.config.createAgent({
    ...agentInput,
    id: 'agent_paid_marketing_welcome',
    name: 'Paid Marketing',
    description: 'Helps optimize Google Ads budgets and copy.',
    instructions: 'Use Google Ads data when connected.',
    lifecycle: 'active',
    creatorMembershipId: f.admin.membership.id,
    slackPresence: {
      requestedHandle: 'paid-marketing',
      normalizedHandle: 'paid-marketing',
      desiredState: 'active',
      health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: 'paid-marketing' },
      userGroupId: 'SPAIDMARKETING',
    },
  });
  const turn = {
    workspaceId: f.admin.binding.slackTeamId,
    channelId: 'C_HOST_WELCOME',
    channelType: 'channel',
    eventId: 'Ev_HOST_WELCOME',
    text: 'create it',
    userId: f.admin.binding.slackUserId,
    messageTs: '200.2',
    threadTs: '200.1',
    source: 'implicit_thread_reply' as const,
    contextMode: 'thread' as const,
  };
  try {
    const approval = await executeHostSlackManagementApproval({
      turn,
      assignment: {
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        agentId: CHICKPEA_AGENT_ID,
        runtimeContract: 'chickpea-v1',
        agent: await f.config.materializeChickpeaAgent(),
      },
      turnJobId: 'turn_HOST_WELCOME',
      proposalId: 'changeset_host_welcome',
      dependencies: {
        identity: f.identity,
        config: f.config,
        management: f.management,
        publicUrl: 'https://example.test',
        service: {
          confirmWorkspaceChange: async () => ({
            operationId: 'management_host_welcome',
            idempotencyKey: 'host-welcome',
            status: 'completed',
            outcomes: [
              {
                itemId: 'create',
                operationKind: 'create_agent',
                disposition: 'applied',
                changed: [{ kind: 'agent', id: created.id, revision: created.revision }],
                handoffUrl: 'https://example.test/admin/agents/agent_paid_marketing_welcome',
              },
              {
                itemId: 'create_origin_channel_grant',
                operationKind: 'grant_agent_channel',
                disposition: 'applied',
              },
            ],
            effectiveRevision: 'rev_host_welcome',
            activation: 'next_turn',
          }),
        } as unknown as WorkspaceManagementService,
      },
    });
    assert.deepEqual(approval, {
      kind: 'agent_welcome_queued',
      outboxId: 'agent_welcome_changeset_host_welcome',
    });
    const outbox = await f.management.getOutboxForOperation('management_host_welcome');
    assert.equal(outbox?.destination.kind, 'thread');
    assert.deepEqual(outbox?.receipt, {
      kind: 'agent_created_welcome',
      proposalId: 'changeset_host_welcome',
      agentId: created.id,
      agentName: 'Paid Marketing',
      agentDescription: 'Helps optimize Google Ads budgets and copy.',
      requesterMembershipId: f.admin.membership.id,
      surface: 'channel',
      persona: {
        name: 'Paid Marketing',
        avatarUrl: 'https://example.test/assets/agents/agent_paid_marketing_welcome/avatar/1',
      },
      setupUrl: 'https://example.test/admin/agents/agent_paid_marketing_welcome',
      suggestedConnector: 'Google Ads',
    });
  } finally {
    f.close();
  }
});

test('one direct create publishes the Slack handle once and replays without duplication', async () => {
  const f = await createManagementAdapterFixture('exact-create-proposal');
  let sequence = 0;
  let publishCalls = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    memory: f.memory,
    routines: f.routines,
    routineSchedulingAvailable: true,
    setupBaseUrl: 'http://localhost',
    now: () => 1_800_000_000_000,
    randomId: () => `exact_create_${++sequence}`,
    publishAgentPresence: async ({ agentId }) => {
      publishCalls += 1;
      const current = await f.config.getAgent(agentId);
      const agent = await f.config.updateAgent(agentId, {
        slackPresence: {
          ...current.slackPresence!,
          desiredState: 'active',
          health: 'healthy',
          userGroupId: 'SPAIDMARKETING',
          observedAt: 1_800_000_000_000,
        },
      }, current.revision);
      return { agent };
    },
  });
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'exact-create-client' },
  };
  try {
    const createdResult = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'exact-create',
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
    assert.equal(createdResult.status, 'completed');
    assert.equal(createdResult.outcomes[0]?.disposition, 'applied');
    assert.equal(createdResult.outcomes[0]?.undoAvailable, undefined);
    const created = await f.config.getAgent('agent_support');
    assert.equal(created.lifecycle, 'active');
    assert.equal(created.enabled, true);
    assert.equal(created.slackPresence?.desiredState, 'active');
    assert.equal(created.slackPresence?.health, 'healthy');
    assert.equal(created.slackPresence?.userGroupId, 'SPAIDMARKETING');
    assert.deepEqual(created.mcpServers, []);
    assert.deepEqual(created.apiConnections, []);
    assert.deepEqual(created.repositories, []);
    assert.equal(created.skills[0]?.name, 'support-triage');
    assert.deepEqual(await f.config.listAgentChannelGrants(), []);
    assert.equal(publishCalls, 1);

    const replay = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'exact-create',
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
    assert.deepEqual(replay, createdResult);
    assert.equal(publishCalls, 1);
    assert.equal((await f.config.listUserAgents()).filter(({ id }) => id === 'agent_support').length, 1);
  } finally {
    f.close();
  }
});

test('a Channel-origin direct create atomically includes its trusted source-Channel grant', async () => {
  const f = await createManagementAdapterFixture('channel-create-origin-grant');
  const workspaceId = f.admin.binding.slackTeamId;
  const channelId = 'C_AGENT_CREATE';
  let membershipChecks = 0;
  let publishCalls = 0;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    actingAgentId: CHICKPEA_AGENT_ID,
    origin: {
      kind: 'slack',
      workspaceId,
      channelId,
      threadTs: '1800000000.000001',
      conversationKind: 'channel',
      agentId: CHICKPEA_AGENT_ID,
    },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => 1_800_000_000_000,
    randomId: () => 'channel_create_origin_grant',
    assertAgentChannelMembership: async ({ actor, workspaceId: actualWorkspaceId, channelId: actualChannelId }) => {
      membershipChecks += 1;
      assert.equal(actor.membershipId, context.membershipId);
      assert.equal(actualWorkspaceId, workspaceId);
      assert.equal(actualChannelId, channelId);
    },
    publishAgentPresence: async ({ agentId }) => {
      const current = await f.config.getAgent(agentId);
      const agent = await f.config.updateAgent(agentId, {
        slackPresence: {
          ...current.slackPresence!,
          desiredState: 'active',
          health: 'healthy',
          userGroupId: 'SPAIDMARKETING',
          observedAt: 1_800_000_000_000,
        },
      }, current.revision);
      return { agent };
    },
    publishAgentChannel: async ({ actor, workspaceId: targetWorkspaceId, channelId: targetChannelId, agentId }) => {
      publishCalls += 1;
      const grant = await f.config.putAgentChannelGrant({
        workspaceId: targetWorkspaceId,
        channelId: targetChannelId,
        agentId,
        status: 'active',
        createdByMembershipId: actor.membershipId,
        channelLabel: 'agent-create',
      }, 0);
      return { agent: await f.config.getAgent(agentId), grant };
    },
  });
  try {
    const created = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'channel-create-origin-grant',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.equal(created.status, 'completed');
    const persisted = await f.management.getRequest(created.operationId);
    assert.deepEqual(persisted?.operations.map(({ kind }) => kind), [
      'create_agent',
      'grant_agent_channel',
    ]);
    assert.deepEqual(persisted?.operations[1], {
      itemId: 'create_origin_channel_grant',
      dependsOn: ['create'],
      kind: 'grant_agent_channel',
      workspaceId,
      channelId,
      agentId: agentInput.id,
      expectedRevision: 0,
    });
    assert.deepEqual(created.outcomes.map(({ operationKind, disposition }) => ({
      operationKind,
      disposition,
    })), [{
      operationKind: 'create_agent',
      disposition: 'applied',
    }, {
      operationKind: 'grant_agent_channel',
      disposition: 'applied',
    }]);
    assert.equal((await f.config.listAgentChannelGrants(workspaceId, channelId))[0]?.agentId, agentInput.id);
    assert.equal((await f.config.listAgentChannelGrants(workspaceId, channelId))[0]?.status, 'active');
    assert.equal(membershipChecks, 1);
    assert.equal(publishCalls, 1);

    const replay = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'channel-create-origin-grant',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.deepEqual(replay, created);
    assert.equal(membershipChecks, 1);
    assert.equal(publishCalls, 1);
  } finally {
    f.close();
  }
});

test('Agent creation stays applied with a warning when Slack publication unexpectedly fails', async () => {
  const f = await createManagementAdapterFixture('create-presence-warning');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'create-presence-warning-client' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    randomId: () => 'create_presence_warning',
    publishAgentPresence: async () => {
      throw new Error('Synthetic unexpected publication failure.');
    },
  });
  try {
    const created = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'create-presence-warning',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.equal(created.status, 'completed');
    assert.equal(created.outcomes[0]?.disposition, 'applied');
    assert.match(created.outcomes[0]?.warning ?? '', /Slack handle needs attention/);
    assert.equal((await f.config.getAgent(agentInput.id)).lifecycle, 'active');
  } finally {
    f.close();
  }
});

test('an interrupted direct create reconciles the already-published Agent on replay', async () => {
  const f = await createManagementAdapterFixture('create-publish-recovery');
  let publishCalls = 0;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'create-publish-recovery-client' },
  };
  const crashingConfig = new Proxy(f.config, {
    get(target, property) {
      if (property === 'createAgent') {
        return async (...args: Parameters<typeof target.createAgent>) => {
          const created = await target.createAgent(...args);
          await target.updateAgent(created.id, {
            slackPresence: {
              ...created.slackPresence!,
              desiredState: 'active',
              health: 'healthy',
              userGroupId: 'SRECOVERED',
              observedAt: 1_800_000_000_000,
            },
          }, created.revision);
          throw new Error('Synthetic crash after Slack publication.');
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const crashingService = new WorkspaceManagementService({
    identity: f.identity,
    config: crashingConfig,
    management: f.management,
    randomId: () => 'create_publish_recovery',
    publishAgentPresence: async ({ agentId }) => {
      publishCalls += 1;
      return { agent: await f.config.getAgent(agentId) };
    },
  });
  try {
    await assert.rejects(
      () => crashingService.applyWorkspaceChanges({
        context,
        idempotencyKey: 'create-publish-recovery',
        operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
      }),
      /Synthetic crash after Slack publication/,
    );
    assert.equal(
      (await f.management.getRequest('management_create_publish_recovery'))?.status,
      'applying',
    );

    const recoveryService = new WorkspaceManagementService({
      identity: f.identity,
      config: f.config,
      management: f.management,
      randomId: () => 'create_publish_recovery_retry',
      publishAgentPresence: async ({ agentId }) => {
        publishCalls += 1;
        return { agent: await f.config.getAgent(agentId) };
      },
    });
    const recovered = await recoveryService.applyWorkspaceChanges({
      context,
      idempotencyKey: 'create-publish-recovery',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.outcomes[0]?.disposition, 'applied');
    assert.equal((await f.config.getAgent(agentInput.id)).slackPresence?.health, 'healthy');
    assert.equal(publishCalls, 0);
  } finally {
    f.close();
  }
});

test('direct create recovery does not adopt a concurrently edited Agent with the same id', async () => {
  const f = await createManagementAdapterFixture('create-recovery-conflict');
  let publishCalls = 0;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'create-recovery-conflict-client' },
  };
  const conflictingConfig = new Proxy(f.config, {
    get(target, property) {
      if (property === 'createAgent') {
        return async (...args: Parameters<typeof target.createAgent>) => {
          const created = await target.createAgent(...args);
          await target.updateAgent(
            created.id,
            { name: 'Concurrent replacement' },
            created.revision,
          );
          throw new Error('Synthetic crash after a concurrent edit.');
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const crashingService = new WorkspaceManagementService({
    identity: f.identity,
    config: conflictingConfig,
    management: f.management,
    randomId: () => 'create_recovery_conflict',
    publishAgentPresence: async ({ agentId }) => {
      publishCalls += 1;
      return { agent: await f.config.getAgent(agentId) };
    },
  });
  try {
    await assert.rejects(
      () => crashingService.applyWorkspaceChanges({
        context,
        idempotencyKey: 'create-recovery-conflict',
        operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
      }),
      /Synthetic crash after a concurrent edit/,
    );
    const recoveryService = new WorkspaceManagementService({
      identity: f.identity,
      config: f.config,
      management: f.management,
      randomId: () => 'create_recovery_conflict_retry',
      publishAgentPresence: async ({ agentId }) => {
        publishCalls += 1;
        return { agent: await f.config.getAgent(agentId) };
      },
    });
    const recovered = await recoveryService.applyWorkspaceChanges({
      context,
      idempotencyKey: 'create-recovery-conflict',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.equal(recovered.status, 'partial');
    assert.equal(recovered.outcomes[0]?.disposition, 'failed');
    assert.equal((await f.config.getAgent(agentInput.id)).name, 'Concurrent replacement');
    assert.equal(publishCalls, 0);
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

test('direct apply creates a standalone base Agent immediately but still reviews consequential edits', async () => {
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
    assert.equal(create.status, 'completed');
    assert.equal(create.outcomes[0]?.disposition, 'applied');
    assert.equal(create.outcomes[0]?.undoAvailable, undefined);
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

test('authoring proposals reject Agent creation in favor of immediate direct apply', async () => {
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
    await assert.rejects(
      () => f.service.proposeWorkspaceChanges({
        context,
        ...authoringProposalMetadata('proposal-safety-create', 'agent_creation'),
        operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
      }),
      (error: unknown) => error instanceof Error &&
        'code' in error && error.code === 'invalid_request',
    );
    await assert.rejects(
      () => f.service.applyWorkspaceChanges({
        context,
        idempotencyKey: 'mixed-create-and-grant',
        operations: [
          { itemId: 'create', kind: 'create_agent', agent: agentInput },
          {
            itemId: 'caller-grant',
            dependsOn: ['create'],
            kind: 'grant_agent_channel',
            workspaceId: f.admin.binding.slackTeamId,
            channelId: 'C_CALLER_SUPPLIED',
            agentId: agentInput.id,
            expectedRevision: 0,
          },
        ],
      }),
      (error: unknown) => error instanceof Error &&
        'code' in error && error.code === 'base_agent_capabilities_require_setup',
    );
    await assert.rejects(() => f.config.getAgent('agent_support'));
  } finally {
    f.close();
  }
});

test('visible duplicate Agent identity returns clarification before any mutation', async () => {
  const f = await createManagementAdapterFixture('visible-duplicate-identity');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'visible-duplicate-client' },
  };
  try {
    const { requestedHandle: _requestedHandle, ...existingAgentInput } = agentInput;
    await f.config.createAgent({
      ...existingAgentInput,
      id: 'agent_existing_deck',
      name: 'Deck',
      creatorMembershipId: f.admin.membership.id,
      lifecycle: 'active',
      configurationGeneration: 1,
      slackPresence: {
        requestedHandle: 'deck',
        normalizedHandle: 'deck',
        desiredState: 'active',
        health: 'healthy',
        avatar: { kind: 'generated', revision: 1, seed: 'deck' },
        userGroupId: 'S_DECK',
      },
    });

    const { requestedHandle: _newRequestedHandle, ...newAgentInput } = agentInput;
    const byName = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'duplicate-by-name',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: { ...newAgentInput, id: 'agent_new_deck', name: '  DECK  ' },
      }],
    });
    assert.equal(byName.status, 'clarification_required');
    assert.deepEqual('clarification' in byName ? byName.clarification : undefined, {
      kind: 'duplicate_agent_identity',
      requested: { name: 'DECK', handle: 'deck' },
      matches: [{ id: 'agent_existing_deck', name: 'Deck', handle: 'deck' }],
      options: ['use_existing', 'create_distinct'],
    });
    await assert.rejects(() => f.config.getAgent('agent_new_deck'));

    const byHandle = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'duplicate-by-handle',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: {
          ...agentInput,
          id: 'agent_campaigns',
          name: 'Campaigns',
          requestedHandle: 'DECK',
        },
      }],
    });
    assert.equal(byHandle.status, 'clarification_required');
    await assert.rejects(() => f.config.getAgent('agent_campaigns'));

    const distinct = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'distinct-deck',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        duplicateResolution: 'create_distinct',
        agent: {
          ...agentInput,
          id: 'agent_distinct_deck',
          name: 'Deck',
          requestedHandle: 'deck-2',
        },
      }],
    });
    assert.equal(distinct.status, 'completed');
    assert.equal((await f.config.getAgent('agent_distinct_deck')).name, 'Deck');
  } finally {
    f.close();
  }
});

test('inferred Slack handle collision recovers one Agent with one stable alternative', async () => {
  const f = await createManagementAdapterFixture('inferred-handle-recovery');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'inferred-handle-client' },
  };
  let publishCalls = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    randomId: () => 'inferred_handle_recovery',
    publishAgentPresence: async ({ agentId }) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        throw new AgentPresenceError(
          'handle_collision',
          'That Slack handle is unavailable.',
          { suggestions: ['support-triage-2', 'support-triage-3'] },
        );
      }
      const current = await f.config.getAgent(agentId);
      assert.equal(current.slackPresence?.requestedHandle, 'support-triage-2');
      return {
        agent: await f.config.updateAgent(agentId, {
          slackPresence: {
            ...current.slackPresence!,
            desiredState: 'active',
            health: 'healthy',
            userGroupId: 'S_SUPPORT_2',
          },
        }, current.revision),
      };
    },
  });
  try {
    const { requestedHandle: _requestedHandle, ...inferredAgentInput } = agentInput;
    const operation: ManagementOperation = {
      itemId: 'create',
      kind: 'create_agent',
      agent: inferredAgentInput,
    };
    const created = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'inferred-handle-recovery',
      operations: [operation],
    });
    assert.equal(created.status, 'completed');
    assert.equal((await f.config.getAgent(agentInput.id)).slackPresence?.normalizedHandle,
      'support-triage-2');
    assert.equal(publishCalls, 2);

    const replay = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'inferred-handle-recovery',
      operations: [operation],
    });
    assert.deepEqual(replay, created);
    assert.equal(publishCalls, 2);
    assert.equal((await f.config.listUserAgents()).filter(({ id }) => id === agentInput.id).length, 1);
  } finally {
    f.close();
  }
});

test('duplicate clarification ignores Agents the member cannot edit', async () => {
  const f = await createManagementAdapterFixture('hidden-duplicate-identity');
  const provisioned = await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UHIDDENDUPLICATE',
    displayName: 'Hidden Duplicate Member',
  });
  const member = provisioned.resolution!;
  const context: ManagementActorContext = {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'hidden-duplicate-client' },
  };
  try {
    const { requestedHandle: _requestedHandle, ...privateAgentInput } = agentInput;
    await f.config.createAgent({
      ...privateAgentInput,
      id: 'agent_hidden_deck',
      name: 'Deck',
      creatorMembershipId: f.admin.membership.id,
      lifecycle: 'active',
      configurationGeneration: 1,
      slackPresence: {
        requestedHandle: 'deck',
        normalizedHandle: 'deck',
        desiredState: 'active',
        health: 'healthy',
        avatar: { kind: 'generated', revision: 1, seed: 'hidden-deck' },
        userGroupId: 'S_HIDDEN_DECK',
      },
    });
    const created = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'hidden-duplicate-create',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: {
          ...privateAgentInput,
          id: 'agent_member_deck',
          name: 'Deck',
        },
      }],
    });
    assert.equal(created.status, 'completed');
    assert.equal((await f.config.getAgent('agent_member_deck')).creatorMembershipId,
      member.membership.id);
    assert.doesNotMatch(JSON.stringify(created), /agent_hidden_deck|S_HIDDEN_DECK/);
  } finally {
    f.close();
  }
});

test('an explicit unavailable handle preserves the created Agent without choosing an alternative', async () => {
  const f = await createManagementAdapterFixture('explicit-handle-collision');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'explicit-handle-client' },
  };
  let publishCalls = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    publishAgentPresence: async () => {
      publishCalls += 1;
      throw new AgentPresenceError(
        'handle_collision',
        'That Slack handle is unavailable.',
        { suggestions: ['support-2'] },
      );
    },
  });
  try {
    const created = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'explicit-handle-collision',
      operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
    });
    assert.equal(created.status, 'completed');
    assert.match(created.outcomes[0]?.warning ?? '', /Slack handle needs attention/);
    assert.equal((await f.config.getAgent(agentInput.id)).slackPresence?.normalizedHandle, 'support');
    assert.equal(publishCalls, 1);
  } finally {
    f.close();
  }
});

test('admitted change sets durably complete with a content-free failure when an unexpected later error occurs', async () => {
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
        throw new Error('Synthetic unexpected downstream failure.');
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
    assert.equal(confirmed.outcomes[1]?.code, 'operation_failed');
    assert.equal((await f.config.getAgent('agent_first')).description, 'Reviewed first.');
    assert.equal((await f.config.getAgent('agent_second')).description, undefined);
    const persisted = await f.management.getChangeSetProposal(proposed.proposalId);
    assert.equal(persisted?.status, 'completed');
    assert.doesNotMatch(JSON.stringify(persisted), /Synthetic unexpected downstream failure/);
  } finally {
    f.close();
  }
});

test('an abandoned applying change set resumes by reconciling the frozen mutation after its lease', async () => {
  const f = await createManagementAdapterFixture('proposal-crash-recovery');
  let now = 1_800_000_000_000;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'crash-recovery-client' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => now,
  });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_recovery', name: 'Recovery', instructions: 'Recover safely.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const operation: ManagementOperation = {
      itemId: 'description', kind: 'update_agent', agentId: agent.id,
      expectedRevision: agent.revision, patch: { description: 'Recovered exactly once.' },
    };
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('crash-recovery'),
      operations: [operation],
    });
    await f.management.claimChangeSetProposal({
      proposalId: proposed.proposalId,
      organizationId: context.organizationId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      originKey: 'mcp:crash-recovery-client',
      at: now,
    });
    await f.config.updateAgent(
      agent.id,
      { description: 'Recovered exactly once.' },
      agent.revision,
    );

    now += 30_001;
    const recovered = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.outcomes[0]?.disposition, 'applied');
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision + 1);
    assert.equal(
      (await f.management.getChangeSetProposal(proposed.proposalId))?.status,
      'completed',
    );
  } finally {
    f.close();
  }
});

test('an unexpected preflight outage leaves the reviewed change set pending for a safe retry', async () => {
  const f = await createManagementAdapterFixture('proposal-transient-preflight');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'transient-preflight-client' },
  };
  let membershipChecks = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    assertAgentChannelMembership: async () => {
      membershipChecks += 1;
      if (membershipChecks === 2) throw new Error('Synthetic Slack outage.');
    },
  });
  try {
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('transient-preflight'),
      operations: [{
        itemId: 'channel',
        kind: 'put_channel',
        channel: {
          workspaceId: f.admin.binding.slackTeamId,
          channelId: 'C_TRANSIENT',
          label: 'transient',
          lifecycle: 'active',
        },
        expectedRevision: 0,
      }],
    });
    await assert.rejects(
      () => service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
      /Synthetic Slack outage/,
    );
    assert.equal(
      (await f.management.getChangeSetProposal(proposed.proposalId))?.status,
      'pending',
    );
    assert.equal(await f.config.getChannel(f.admin.binding.slackTeamId, 'C_TRANSIENT'), undefined);
  } finally {
    f.close();
  }
});

test('change-set confirmation preserves the cascading disable behavior for an Agent with Channel reach', async () => {
  const f = await createManagementAdapterFixture('proposal-disable-agent');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'disable-agent-client' },
  };
  try {
    const agent = await f.config.createAgent({
      id: 'agent_disable', name: 'Disable', instructions: 'Disable safely.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await f.config.putChannel({
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'C_DISABLE',
      label: 'disable',
      lifecycle: 'active',
    }, 0);
    await f.config.putAgentChannelGrant({
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'C_DISABLE',
      agentId: agent.id,
      status: 'active',
      createdByMembershipId: f.admin.membership.id,
    });
    const proposed = await f.service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('disable-agent'),
      operations: [{
        itemId: 'disable', kind: 'update_agent', agentId: agent.id,
        expectedRevision: agent.revision, patch: { enabled: false },
      }],
    });
    const confirmed = await f.service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.equal(confirmed.status, 'completed');
    assert.equal((await f.config.getAgent(agent.id)).enabled, false);
    assert.deepEqual(
      await f.config.listAgentChannelGrants(f.admin.binding.slackTeamId, 'C_DISABLE'),
      [],
    );
    assert.ok(confirmed.outcomes[0]?.changed?.some(({ kind }) => kind === 'channel_grant'));
  } finally {
    f.close();
  }
});

test('an applying change set cannot resume after the requester loses Agent edit authority', async () => {
  const f = await createManagementAdapterFixture('proposal-recovery-authority');
  let now = 1_800_000_000_000;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'recovery-authority-client' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => now,
  });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_owner_created', name: 'Owner Created', instructions: 'Owner controlled.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.owner.membership.id,
      editPolicy: 'creator_and_admins', configurationGeneration: 1,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('recovery-authority'),
      operations: [{
        itemId: 'description', kind: 'update_agent', agentId: agent.id,
        expectedRevision: agent.revision, patch: { description: 'Must not be written.' },
      }],
    });
    await f.management.claimChangeSetProposal({
      proposalId: proposed.proposalId,
      organizationId: context.organizationId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      originKey: 'mcp:recovery-authority-client',
      at: now,
    });
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id,
      role: 'member',
      actorMembershipId: f.owner.membership.id,
      correlationId: 'recovery-authority-demotion',
      authenticationSurface: 'better_auth',
      reasonCode: 'recovery_authority_test',
    });
    now += 30_001;
    await assert.rejects(
      () => service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
      (error: unknown) => error instanceof ManagementError && error.code === 'forbidden',
    );
    assert.equal((await f.config.getAgent(agent.id)).description, undefined);
    assert.equal(
      (await f.management.getChangeSetProposal(proposed.proposalId))?.status,
      'stale',
    );
  } finally {
    f.close();
  }
});

test('a pending workspace proposal can be approved after the former expiration window', async () => {
  const f = await createManagementAdapterFixture('proposal-no-expiry');
  let now = 1_800_000_000_000;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'slack', workspaceId: 'T_TEST', channelId: 'D_TEST', threadTs: '1.0' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => now,
  });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_no_expiry', name: 'No Expiry', instructions: 'Stay available.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('no-expiry'),
      operations: [{
        itemId: 'description', kind: 'update_agent', agentId: agent.id,
        expectedRevision: agent.revision, patch: { description: 'Approved asynchronously.' },
      }],
    });
    now += 16 * 60_000 + 48_000;

    const applied = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });

    assert.equal(applied.status, 'completed');
    assert.equal((await f.config.getAgent(agent.id)).description, 'Approved asynchronously.');
  } finally {
    f.close();
  }
});

test('an applying change set can recover after the former expiration window', async () => {
  const f = await createManagementAdapterFixture('proposal-recovery-no-expiry');
  let now = 1_800_000_000_000;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'recovery-no-expiry-client' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => now,
  });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_recovery_no_expiry', name: 'Recovery', instructions: 'Recover safely.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('recovery-no-expiry'),
      operations: [{
        itemId: 'description', kind: 'update_agent', agentId: agent.id,
        expectedRevision: agent.revision, patch: { description: 'Recovered write.' },
      }],
    });
    await f.management.claimChangeSetProposal({
      proposalId: proposed.proposalId,
      organizationId: context.organizationId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      originKey: 'mcp:recovery-no-expiry-client',
      at: now,
    });
    now += 15 * 60_000 + 1;
    const result = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.equal(result.status, 'completed');
    assert.equal((await f.config.getAgent(agent.id)).description, 'Recovered write.');
    assert.equal(
      (await f.management.getChangeSetProposal(proposed.proposalId))?.status,
      'completed',
    );
  } finally {
    f.close();
  }
});

test('recovery returns a truthful partial receipt when authority changes after a saved prefix', async () => {
  const f = await createManagementAdapterFixture('proposal-recovery-partial-authority');
  let now = 1_800_000_000_000;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'recovery-partial-authority-client' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => now,
  });
  try {
    const first = await f.config.createAgent({
      id: 'agent_recovery_prefix', name: 'Recovery Prefix', instructions: 'Apply first.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.owner.membership.id,
      editPolicy: 'creator_and_admins', configurationGeneration: 1,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const second = await f.config.createAgent({
      id: 'agent_recovery_denied', name: 'Recovery Denied', instructions: 'Protect second.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.owner.membership.id,
      editPolicy: 'creator_and_admins', configurationGeneration: 1,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('recovery-partial-authority'),
      operations: [
        {
          itemId: 'first', kind: 'update_agent', agentId: first.id,
          expectedRevision: first.revision, patch: { description: 'Applied before interruption.' },
        },
        {
          itemId: 'second', kind: 'update_agent', agentId: second.id,
          expectedRevision: second.revision, patch: { description: 'Must remain protected.' },
        },
      ],
    });
    const claimed = await f.management.claimChangeSetProposal({
      proposalId: proposed.proposalId,
      organizationId: context.organizationId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      originKey: 'mcp:recovery-partial-authority-client',
      at: now,
    });
    const appliedFirst = await f.config.updateAgent(
      first.id,
      { description: 'Applied before interruption.' },
      first.revision,
    );
    await f.management.saveChangeSetProposalProgress(
      proposed.proposalId,
      {
        operationId: proposed.proposalId,
        idempotencyKey: `confirmation:${proposed.proposalId}`,
        status: 'completed',
        outcomes: [{
          itemId: 'first',
          operationKind: 'update_agent',
          disposition: 'applied',
          changed: [{ kind: 'agent', id: first.id, revision: appliedFirst.revision }],
        }],
        effectiveRevision: 'a'.repeat(64),
        activation: 'next_turn',
      },
      claimed.updatedAt,
      now + 1,
    );
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id,
      role: 'member',
      actorMembershipId: f.owner.membership.id,
      correlationId: 'recovery-partial-authority-demotion',
      authenticationSurface: 'better_auth',
      reasonCode: 'recovery_partial_authority_test',
    });
    now += 30_002;
    const recovered = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.equal(recovered.status, 'partial');
    assert.equal(recovered.outcomes[0]?.disposition, 'applied');
    assert.equal(recovered.outcomes[1]?.disposition, 'failed');
    assert.equal(recovered.outcomes[1]?.code, 'forbidden');
    assert.equal((await f.config.getAgent(first.id)).description, 'Applied before interruption.');
    assert.equal((await f.config.getAgent(second.id)).description, undefined);
    assert.equal(
      (await f.management.getChangeSetProposal(proposed.proposalId))?.status,
      'completed',
    );
  } finally {
    f.close();
  }
});

test('recovery rechecks live Slack membership before applying a Channel grant', async () => {
  const f = await createManagementAdapterFixture('proposal-recovery-channel-membership');
  let now = 1_800_000_000_000;
  let membershipChecks = 0;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'recovery-channel-membership-client' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => now,
    assertAgentChannelMembership: async () => {
      membershipChecks += 1;
      if (membershipChecks > 1) {
        throw new ManagementError('forbidden', 'Requester left the Slack Channel.');
      }
    },
  });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_recovery_channel', name: 'Recovery Channel', instructions: 'Publish safely.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await f.config.putChannel({
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'C_RECOVERY_MEMBERSHIP',
      label: 'recovery-membership',
      lifecycle: 'active',
    }, 0);
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('recovery-channel-membership'),
      operations: [{
        itemId: 'grant',
        kind: 'grant_agent_channel',
        workspaceId: f.admin.binding.slackTeamId,
        channelId: 'C_RECOVERY_MEMBERSHIP',
        agentId: agent.id,
        expectedRevision: 0,
      }],
    });
    await f.management.claimChangeSetProposal({
      proposalId: proposed.proposalId,
      organizationId: context.organizationId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      originKey: 'mcp:recovery-channel-membership-client',
      at: now,
    });
    now += 30_001;
    const recovered = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.proposalId,
    });
    assert.equal(membershipChecks, 2);
    assert.equal(recovered.status, 'partial');
    assert.equal(recovered.outcomes[0]?.disposition, 'failed');
    assert.equal(recovered.outcomes[0]?.code, 'forbidden');
    assert.deepEqual(
      await f.config.listAgentChannelGrants(
        f.admin.binding.slackTeamId,
        'C_RECOVERY_MEMBERSHIP',
      ),
      [],
    );
  } finally {
    f.close();
  }
});

test('concurrent expired-lease recovery admits one executor and preserves one truthful receipt', async () => {
  const f = await createManagementAdapterFixture('proposal-recovery-race');
  let now = 1_800_000_000_000;
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'recovery-race-client' },
  };
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    now: () => now,
  });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_recovery_race', name: 'Recovery Race', instructions: 'Race safely.', enabled: true,
      lifecycle: 'active', creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const proposed = await service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('recovery-race'),
      operations: [{
        itemId: 'description', kind: 'update_agent', agentId: agent.id,
        expectedRevision: agent.revision, patch: { description: 'Applied once.' },
      }],
    });
    await f.management.claimChangeSetProposal({
      proposalId: proposed.proposalId,
      organizationId: context.organizationId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      originKey: 'mcp:recovery-race-client',
      at: now,
    });
    now += 30_001;
    const confirmations = await Promise.allSettled([
      service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
      service.confirmWorkspaceChange({ context, proposalId: proposed.proposalId }),
    ]);
    assert.equal(confirmations.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(confirmations.filter(({ status }) => status === 'rejected').length, 1);
    const fulfilled = confirmations.find(({ status }) => status === 'fulfilled');
    assert.equal(fulfilled?.status === 'fulfilled' ? fulfilled.value.status : undefined, 'completed');
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision + 1);
    assert.equal(
      (await f.management.getChangeSetProposal(proposed.proposalId))?.status,
      'completed',
    );
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
    assert.equal(createResult.status, 'completed');
    assert.equal((await f.config.getAgent('agent_support')).lifecycle, 'active');
    assert.equal(
      new URL(createResult.outcomes[0]!.handoffUrl!).pathname,
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

test('all-workspace editing does not bypass private Channel use', async () => {
  const f = await createManagementAdapterFixture('member-edit-private-use');
  const creator = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UEDITPRIVATECREATOR',
    displayName: 'Private Agent Creator',
  })).resolution!;
  const editor = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UEDITPRIVATEEDITOR',
    displayName: 'Workspace Editor',
  })).resolution!;
  const agent = await f.config.createAgent({
    ...agentInput,
    id: 'agent_workspace_edit_private_use',
    creatorMembershipId: creator.membership.id,
    editPolicy: 'all_workspace_members',
    lifecycle: 'active',
    configurationGeneration: 1,
  });
  const grant = await f.config.putAgentChannelGrant({
    workspaceId: f.owner.binding.slackTeamId,
    channelId: 'C_PRIVATE_EDIT',
    agentId: agent.id,
    status: 'active',
    createdByMembershipId: creator.membership.id,
  }, 0);
  const context: ManagementActorContext = {
    userId: editor.user.id,
    membershipId: editor.membership.id,
    organizationId: editor.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'workspace-editor-private-client' },
  };
  try {
    const snapshot = await f.service.inspectWorkspace(context);
    assert.deepEqual(snapshot.agents.map(({ id }) => id), [agent.id]);
    const projected = snapshot.agents[0] as Record<string, unknown>;
    assert.equal('privateUseAudience' in projected, false);
    assert.equal('canUse' in projected, false);

    assert.deepEqual(await resolvePrivateAgentAccess({
      agent,
      workspaceId: f.owner.binding.slackTeamId,
      grants: [grant],
      actor: {
        fullMember: true,
        membershipId: editor.membership.id,
        slackUserId: editor.binding.slackUserId,
      },
      transport: {
        async lookupChannel(channelId) {
          return { id: channelId, name: 'private-edit', private: true, member: true, archived: false };
        },
        async listChannels() { return { channels: [], truncated: false }; },
        async listMemberChannels() { return new Set<string>(); },
      },
    }), { status: 'denied', audience: 'private_channel_members' });

    const proposed = await f.service.proposeWorkspaceChanges({
      context,
      ...authoringProposalMetadata('workspace-editor-private-use'),
      operations: [{
        itemId: 'description',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: { description: 'Editable without private Slack use.' },
      }],
    });
    assert.equal(proposed.status, 'pending');
  } finally {
    f.close();
  }
});

test('public placement permits use without exposing Agent management', async () => {
  const f = await createManagementAdapterFixture('member-public-use-private-admin');
  const creator = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UPUBLICCREATOR',
    displayName: 'Public Agent Creator',
  })).resolution!;
  const user = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UPUBLICUSER',
    displayName: 'Public Agent User',
  })).resolution!;
  const agent = await f.config.createAgent({
    ...agentInput,
    id: 'agent_public_use_private_admin',
    creatorMembershipId: creator.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
  });
  const grant = await f.config.putAgentChannelGrant({
    workspaceId: f.owner.binding.slackTeamId,
    channelId: 'C_PUBLIC_USE',
    agentId: agent.id,
    status: 'active',
    createdByMembershipId: creator.membership.id,
  }, 0);
  const context: ManagementActorContext = {
    userId: user.user.id,
    membershipId: user.membership.id,
    organizationId: user.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'public-agent-user-client' },
  };
  try {
    assert.deepEqual(await resolvePrivateAgentAccess({
      agent,
      workspaceId: f.owner.binding.slackTeamId,
      grants: [grant],
      actor: {
        fullMember: true,
        membershipId: user.membership.id,
        slackUserId: user.binding.slackUserId,
      },
      transport: {
        async lookupChannel(channelId) {
          return { id: channelId, name: 'public-use', private: false, member: true, archived: false };
        },
        async listChannels() { return { channels: [], truncated: false }; },
        async listMemberChannels() { return new Set<string>(); },
      },
    }), { status: 'allowed', audience: 'workspace_members' });
    assert.deepEqual((await f.service.inspectWorkspace(context)).agents, []);
    await assert.rejects(
      () => f.service.proposeWorkspaceChanges({
        context,
        ...authoringProposalMetadata('public-use-private-admin'),
        operations: [{
          itemId: 'description',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: agent.revision,
          patch: { description: 'Must remain editor-only.' },
        }],
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'forbidden',
    );
  } finally {
    f.close();
  }
});

test('an admin manages a private-only Agent without gaining private use', async () => {
  const f = await createManagementAdapterFixture('admin-private-use-separation');
  const creator = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UADMINPRIVATECREATOR',
    displayName: 'Admin Private Creator',
  })).resolution!;
  const agent = await f.config.createAgent({
    ...agentInput,
    id: 'agent_admin_private_use',
    creatorMembershipId: creator.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
  });
  const grant = await f.config.putAgentChannelGrant({
    workspaceId: f.admin.binding.slackTeamId,
    channelId: 'C_ADMIN_PRIVATE',
    agentId: agent.id,
    status: 'active',
    createdByMembershipId: creator.membership.id,
  }, 0);
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'admin-private-use-client' },
  };
  try {
    assert.deepEqual((await f.service.inspectWorkspace(context)).agents.map(({ id }) => id), [agent.id]);
    assert.deepEqual(await resolvePrivateAgentAccess({
      agent,
      workspaceId: f.admin.binding.slackTeamId,
      grants: [grant],
      actor: {
        fullMember: true,
        membershipId: f.admin.membership.id,
        slackUserId: f.admin.binding.slackUserId,
      },
      transport: {
        async lookupChannel(channelId) {
          return { id: channelId, name: 'admin-private', private: true, member: true, archived: false };
        },
        async listChannels() { return { channels: [], truncated: false }; },
        async listMemberChannels() { return new Set<string>(); },
      },
    }), { status: 'denied', audience: 'private_channel_members' });
  } finally {
    f.close();
  }
});

test('inspection exposes the Agent Channel grant revision separately from its Channel revision', async () => {
  const f = await createManagementAdapterFixture('inspect-channel-grant-revision');
  try {
    const agent = await f.config.createAgent({
      ...agentInput,
      id: 'agent_grant_revision',
      creatorMembershipId: f.admin.membership.id,
      lifecycle: 'active',
      configurationGeneration: 1,
    });
    const channel = await f.config.putChannel({
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'C_GRANT_REVISION',
      label: 'grant-revision',
      lifecycle: 'active',
    }, 0);
    const updatedChannel = await f.config.putChannel({
      ...channel,
      label: 'grant-revision-updated',
    }, channel.revision);
    const grant = await f.config.putAgentChannelGrant({
      workspaceId: f.admin.binding.slackTeamId,
      channelId: updatedChannel.channelId,
      agentId: agent.id,
      status: 'active',
      createdByMembershipId: f.admin.membership.id,
    }, 0);

    const snapshot = await f.service.inspectWorkspace({
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'inspect-grant-revision-client' },
    });
    const inspectedChannel = snapshot.channels.find(({ channelId }) =>
      channelId === updatedChannel.channelId);
    assert.equal(inspectedChannel?.revision, updatedChannel.revision);
    assert.notEqual(updatedChannel.revision, grant.revision);
    assert.deepEqual(inspectedChannel?.grants, [{
      agentId: agent.id,
      status: 'active',
      revision: grant.revision,
    }]);

    const mcpInspection = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => ({
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'inspect-grant-revision-client' },
      }),
    }, 'inspect_workspace', {});
    assert.equal(mcpInspection.ok, true);
    const mcpChannel = mcpInspection.ok
      ? (mcpInspection.result as ManagementWorkspaceSnapshot).channels.find(({ channelId }) =>
          channelId === updatedChannel.channelId)
      : undefined;
    assert.equal(mcpChannel?.grants[0]?.revision, grant.revision);

    const slackInspection = await invokeSlackWorkspaceManagementTool({
      signal: {
        agentId: CHICKPEA_AGENT_ID,
        workspaceId: f.admin.binding.slackTeamId,
        channelId: 'C_GRANT_REVISION',
        threadTs: '200.1',
        slackUserId: f.admin.binding.slackUserId,
        eventId: 'Ev_GRANT_REVISION',
        messageTs: '200.2',
        turnJobId: 'turn_GRANT_REVISION',
      },
      identity: f.identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });
    assert.equal(slackInspection.ok, true);
    const slackChannel = slackInspection.ok
      ? (slackInspection.result as ManagementWorkspaceSnapshot).channels.find(({ channelId }) =>
          channelId === updatedChannel.channelId)
      : undefined;
    assert.equal(slackChannel?.grants[0]?.revision, grant.revision);
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

test('confirmed Agent deletion uses the live cleanup boundary before removing the Agent', async () => {
  const f = await createManagementAdapterFixture('member-agent-delete');
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UMEMBERDELETE',
    displayName: 'Delete Member',
  })).resolution!;
  await f.config.createAgent({
    id: 'agent_delete', name: 'Delete', instructions: 'Delete safely.', enabled: true,
    lifecycle: 'active', creatorMembershipId: member.membership.id,
    editPolicy: 'creator_and_admins', configurationGeneration: 1,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  let cleanupCalls = 0;
  const service = new WorkspaceManagementService({
    identity: f.identity,
    config: f.config,
    management: f.management,
    setupBaseUrl: 'http://localhost',
    now: () => 1_800_000_000_000,
    randomId: () => 'delete_operation',
    randomCapability: () => 'd'.repeat(43),
    deleteAgent: async ({ agentId, expectedRevision }) => {
      cleanupCalls += 1;
      return f.config.deleteAgent(agentId, expectedRevision);
    },
  });
  const context: ManagementActorContext = {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'delete-client' },
  };
  try {
    const proposed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'delete-owned-agent',
      operations: [{
        itemId: 'delete', kind: 'delete_agent', agentId: 'agent_delete', expectedRevision: 1,
      }],
    });
    assert.equal(proposed.status, 'confirmation_required');
    assert.equal(cleanupCalls, 0);
    const deleted = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal(deleted.status, 'completed');
    assert.equal(cleanupCalls, 1);
    await assert.rejects(() => f.config.getAgent('agent_delete'), UnknownAgentError);
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
