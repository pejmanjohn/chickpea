import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import {
  AgentPromptFailure,
  type AgentDispatchResult,
  type SlackFlueDispatchState,
} from '../src/slack/flue-dispatch.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
} from '../src/slack/turn-job-types.ts';
import { runTurn, WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import {
  AGENT_FAILURE_TEXT,
  SANDBOX_UNAVAILABLE_FALLBACK_NOTICE,
} from '../src/slack/web-client-presenter.ts';
import { SLACK_SELF_MENTION_PLACEHOLDER } from '../src/slack/web-client-context.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { repairTerminalSlackPresentation } from '../src/slack/presentation-repair.ts';
import { completeAgentWelcomeDelivery } from '../src/management/receipts.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const assignment: ResolvedAssignment = {
  workspaceId: 'T_HEARTBEAT',
  channelId: 'D_HEARTBEAT',
  agentId: 'agent_heartbeat',
  model: 'local-stub/heartbeat',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_heartbeat',
    kind: 'user',
    revision: 1,
    name: 'Heartbeat',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

const heartbeatStateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-heartbeat-'));
const heartbeatStatePath = join(heartbeatStateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = heartbeatStatePath;
  const store = new SqliteConfigStore(heartbeatStatePath, { agents: [] });
  await store.createAgent(assignment.agent);
  const installation = await store.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await store.updateWorkspaceInstallation(assignment.workspaceId, {
    health: 'healthy',
  }, installation.revision);
  store.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(heartbeatStateDirectory, { recursive: true, force: true });
});

function workTurn(eventId: string): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    eventId,
    text: 'Complete the verification.',
    userId: 'U_HEARTBEAT',
    messageTs: '1785509000.000100',
    threadTs: '1785509000.000100',
    source: 'dm_message',
    channelType: 'im',
    contextMode: 'dm_history',
    interactionIntent: {
      disposition: 'work',
      reason: 'substantive_request',
      checklist: ['Verification result'],
    },
  };
}

function v3PresentationHarness(
  turn: NormalizedSlackTurn,
  runId: string,
  semanticActivityEnabled = true,
) {
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Frozen Support',
      avatarUrl: 'https://chickpea.example/assets/agents/frozen/avatar/7',
      avatarRevision: 7,
    } },
    sessionGeneration,
    ...(semanticActivityEnabled
      ? {
          currentActivity: {
            kind: 'preparing' as const,
            action: 'Preparing',
            object: 'your request',
            generation: sessionGeneration,
            sequence: 1,
            operation: {
              operationId: `activity_${runId}_1`, certainty: 'pending' as const,
            },
          },
        }
      : {}),
    root: {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      requesterUserId: turn.userId,
    },
  });
  return {
    db,
    store,
    state: {
      getRunPresentation: (id: string) => store.get(id),
      getLatestThreadSessionGeneration: (root: Parameters<
        typeof store.getLatestThreadSessionGeneration
      >[0]) => store.getLatestThreadSessionGeneration(root),
      transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) =>
        store.transition(input),
      reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
      applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
        store.applyAppendCooldown(workspaceId, retryAfterMs),
      matchFlueObservation: () => undefined,
    },
  };
}

test('runTurn acknowledges substantive work with a temporary eyes reaction', async () => {
  let reactionAdds = 0;
  let reactionRemoves = 0;
  let managementRuntimeResolutions = 0;
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    reactions: {
      add: async () => {
        reactionAdds += 1;
        return { ok: true };
      },
      remove: async () => {
        reactionRemoves += 1;
        return { ok: true };
      },
    },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      postMessage: async () => ({ ok: true, channel: assignment.channelId, ts: 'checklist-ts' }),
      update: async () => ({ ok: true }),
      startStream: async () => ({ ok: true, ts: 'final-ts' }),
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  await runTurn(workTurn('Ev_NO_SYNTHETIC_WORK_ACK'), assignment, undefined, {
    client,
    replayText: 'Verification complete.',
    managementApproval: () => {
      managementRuntimeResolutions += 1;
      throw new Error('ordinary turns must not resolve the management runtime');
    },
    usageRecordingEnabled: false,
  });

  assert.equal(reactionAdds, 1);
  assert.equal(reactionRemoves, 1);
  assert.equal(managementRuntimeResolutions, 0);
});

test('runTurn applies a bound DM approval in the host without invoking the Agent', async () => {
  const f = await createManagementAdapterFixture('run-turn-host-approval');
  let promptCalls = 0;
  let historyCalls = 0;
  let managementRuntimeResolutions = 0;
  const delivered: string[] = [];
  try {
    const managedAgent = await f.config.createAgent({
      id: 'agent_host_approval',
      name: 'Host Approval',
      instructions: 'Manage this Agent.',
      enabled: true,
      kind: 'user',
      lifecycle: 'active',
      creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const installation = await f.config.ensureWorkspaceInstallation({
      workspaceId: f.admin.binding.slackTeamId,
      transportMode: 'direct',
      defaultAgentId: managedAgent.id,
      teamId: f.admin.binding.slackTeamId,
      botUserId: 'U_CHICKPEA',
    });
    await f.config.updateWorkspaceInstallation(
      f.admin.binding.slackTeamId,
      { runtimeContract: 'chickpea-v1', health: 'healthy' },
      installation.revision,
    );
    const proposalContext = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      actingAgentId: managedAgent.id,
      origin: {
        kind: 'slack' as const,
        workspaceId: f.admin.binding.slackTeamId,
        channelId: 'D_HOST_APPROVAL',
        threadTs: '100.1',
        messageTs: '100.1',
        conversationKind: 'im' as const,
        agentId: managedAgent.id,
      },
    };
    const proposed = await f.service.proposeWorkspaceChanges({
      context: proposalContext,
      ...authoringProposalMetadata('run-turn-host-approval'),
      operations: [{
        itemId: 'description',
        kind: 'update_agent',
        agentId: managedAgent.id,
        expectedRevision: managedAgent.revision,
        patch: { description: 'Applied by the trusted Slack host.' },
      }],
    });
    const approvalAssignment: ResolvedAssignment = {
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'D_HOST_APPROVAL',
      agentId: managedAgent.id,
      runtimeContract: 'chickpea-v1',
      agent: managedAgent,
    };
    const turn: NormalizedSlackTurn = {
      workspaceId: approvalAssignment.workspaceId,
      channelId: approvalAssignment.channelId,
      eventId: 'Ev_HOST_APPROVAL',
      text: 'create it',
      userId: f.admin.binding.slackUserId,
      actorMembershipId: f.admin.membership.id,
      messageTs: '200.1',
      threadTs: '200.1',
      source: 'dm_message',
      contextMode: 'dm_history',
      interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
      managementApprovalProposalId: proposed.proposalId,
    };
    const client = {
      conversations: { history: async () => {
        historyCalls += 1;
        return { ok: true, messages: [] };
      } },
      chat: {
        startStream: async (input: { markdown_text: string }) => {
          delivered.push(input.markdown_text);
          return { ok: true, ts: '201.1' };
        },
        stopStream: async () => ({ ok: true }),
        postMessage: async (input: { text: string }) => {
          delivered.push(input.text);
          return { ok: true, channel: turn.channelId, ts: '201.1' };
        },
      },
    } as unknown as WebClient;

    await runTurn(turn, approvalAssignment, undefined, {
      client,
      turnId: 'turn_HOST_APPROVAL',
      agentPrompt: async () => {
        promptCalls += 1;
        throw new Error('the Agent must not handle an approved proposal');
      },
      managementApproval: () => {
        managementRuntimeResolutions += 1;
        return {
          identity: f.identity,
          config: f.config,
          management: f.management,
          service: f.service,
        };
      },
      usageRecordingEnabled: false,
    });

    assert.equal(promptCalls, 0);
    assert.equal(historyCalls, 0);
    assert.equal(managementRuntimeResolutions, 1);
    assert.match(delivered.join('\n'), /Applied the approved changes\./);
    const applied = await f.config.getAgent(managedAgent.id);
    assert.equal(applied.description, 'Applied by the trusted Slack host.');

    await runTurn({
      ...turn,
      eventId: 'Ev_HOST_APPROVAL_RETRY',
      messageTs: '200.2',
      threadTs: '200.2',
    }, approvalAssignment, undefined, {
      client,
      turnId: 'turn_HOST_APPROVAL_RETRY',
      agentPrompt: async () => {
        promptCalls += 1;
        throw new Error('the Agent must not handle an approved proposal replay');
      },
      managementApproval: () => {
        managementRuntimeResolutions += 1;
        return {
          identity: f.identity,
          config: f.config,
          management: f.management,
          service: f.service,
        };
      },
      usageRecordingEnabled: false,
    });
    assert.equal(promptCalls, 0);
    assert.equal(managementRuntimeResolutions, 2);
    assert.equal((await f.config.getAgent(managedAgent.id)).revision, applied.revision);
    assert.equal(delivered.filter((text) => /Applied the approved changes\./.test(text)).length, 2);
  } finally {
    f.close();
  }
});

test('runTurn suppresses model prose and defers one immediate-creation welcome', async () => {
  const f = await createManagementAdapterFixture('run-turn-immediate-creation');
  try {
    const chickpea = await f.config.materializeChickpeaAgent();
    const bootstrapAgent = await f.config.createAgent({
      id: 'agent_run_turn_bootstrap',
      name: 'Bootstrap',
      instructions: 'Provide the initial Workspace routing target.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const installation = await f.config.ensureWorkspaceInstallation({
      workspaceId: f.admin.binding.slackTeamId,
      transportMode: 'direct',
      defaultAgentId: bootstrapAgent.id,
      teamId: f.admin.binding.slackTeamId,
      botUserId: 'U_CHICKPEA',
    });
    await f.config.updateWorkspaceInstallation(
      f.admin.binding.slackTeamId,
      { runtimeContract: 'chickpea-v1', health: 'healthy' },
      installation.revision,
    );
    const turn: NormalizedSlackTurn = {
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'D_IMMEDIATE_CREATION',
      eventId: 'Ev_IMMEDIATE_CREATION',
      text: 'Create a Deck Agent using Linear.',
      userId: f.admin.binding.slackUserId,
      actorMembershipId: f.admin.membership.id,
      messageTs: '205.1',
      threadTs: '205.1',
      source: 'dm_message',
      channelType: 'im',
      contextMode: 'dm_history',
      interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
    };
    const chickpeaAssignment: ResolvedAssignment = {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      agentId: CHICKPEA_AGENT_ID,
      runtimeContract: 'chickpea-v1',
      model: 'local-stub/management',
      modelAttribution: { source: 'pinned', providerId: 'local-stub' },
      agent: chickpea,
    };
    const context = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      actingAgentId: CHICKPEA_AGENT_ID,
      origin: {
        kind: 'slack' as const,
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        messageTs: turn.messageTs,
        requestText: turn.text,
        conversationKind: 'im' as const,
        agentId: CHICKPEA_AGENT_ID,
      },
    };
    const applied = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'turn-immediate-creation',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: {
          id: 'agent_run_turn_deck',
          name: 'Deck',
          description: 'Creates polished presentations.',
          requestedHandle: 'run-turn-deck',
          editPolicy: 'creator_and_admins',
          instructions: 'Create polished presentations and track projects in Linear.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      }],
    });
    if (!('operationId' in applied)) assert.fail('expected applied creation');
    const created = await f.config.getAgent('agent_run_turn_deck');
    await f.config.updateAgent(created.id, {
      slackPresence: {
        ...created.slackPresence!,
        desiredState: 'active',
        health: 'healthy',
        userGroupId: 'SRUNTURNDECK',
      },
    }, created.revision);
    const storedCreation = await f.management.getRequest(applied.operationId);
    assert.ok(storedCreation);
    assert.equal(storedCreation.status, 'completed');
    assert.equal(storedCreation.actorUserId, f.admin.user.id);
    assert.equal(storedCreation.actorMembershipId, f.admin.membership.id);
    assert.equal(
      storedCreation.originKey,
      `slack:${turn.workspaceId}:${turn.channelId}:${turn.threadTs}:im:agent:${CHICKPEA_AGENT_ID}`,
    );

    const visiblePosts: string[] = [];
    const client = {
      conversations: { history: async () => ({ ok: true, messages: [] }) },
      chat: {
        startStream: async (input: { markdown_text: string }) => {
          visiblePosts.push(input.markdown_text);
          return { ok: true, ts: '206.1' };
        },
        stopStream: async () => ({ ok: true }),
        postMessage: async (input: { text: string }) => {
          visiblePosts.push(input.text);
          return { ok: true, channel: turn.channelId, ts: '206.1' };
        },
      },
    } as unknown as WebClient;
    let deferred = 0;
    let delivered = 0;
    let promptCalls = 0;
    const runOptions = {
      client,
      turnId: 'turn_IMMEDIATE_CREATION',
      agentPrompt: async (): Promise<AgentDispatchResult> => {
        promptCalls += 1;
        return {
          text: 'The model says the Agent was created. This text must stay hidden.',
          agentCreationTerminal: {
            schemaVersion: 1,
            operationId: applied.operationId,
            creationItemId: 'create',
            agentId: 'agent_run_turn_deck',
            connectorMentions: ['Linear'],
            followOnNotices: [],
          },
          requestedModel: 'local-stub/management',
          returnedModel: { provider: 'local-stub', id: 'management' },
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
      appStores: {
        config: f.config,
        identity: f.identity,
        memory: f.memory,
        management: f.management,
      } as never,
      onDeferredTerminal: () => { deferred += 1; },
      onDelivered: () => { delivered += 1; },
      usageRecordingEnabled: false,
    };
    await runTurn(turn, chickpeaAssignment, {
      SLACK_TAG_PUBLIC_URL: 'https://chickpea.example',
    }, runOptions);

    assert.deepEqual(visiblePosts, []);
    assert.equal(promptCalls, 1);
    assert.equal(deferred, 1);
    assert.equal(delivered, 0);
    const outbox = await f.management.getOutboxForOperation(applied.operationId);
    assert.ok(outbox && 'kind' in outbox.receipt &&
      outbox.receipt.kind === 'agent_created_welcome');
    if (!outbox || !('kind' in outbox.receipt) ||
        outbox.receipt.kind !== 'agent_created_welcome') {
      assert.fail('expected deferred Agent welcome');
    }
    assert.equal(outbox.receipt.turnJobId, 'turn_IMMEDIATE_CREATION');
    assert.deepEqual(outbox.receipt.connectorActions?.map(({ label }) => label), [
      'Linear',
    ]);
    assert.match(
      outbox.receipt.connectorActions?.[0]?.setupUrl ?? '',
      /^https:\/\/chickpea\.example\/setup\/setup_welcome_/,
    );
    const linearSetupId = outbox.receipt.connectorActions?.[0]?.setupOperationId;
    assert.ok(linearSetupId);
    const linearSetup = await f.management.getSetup(linearSetupId);
    assert.equal(linearSetup?.action, 'catalog_connection');
    assert.equal(linearSetup?.target.presetId, 'linear');
    assert.equal(linearSetup?.target.agentId, 'agent_run_turn_deck');

    const [claimed] = await f.management.claimDueOutbox(
      outbox.nextAttemptAt,
      1,
      outbox.nextAttemptAt + 60_000,
    );
    assert.ok(claimed);
    await f.management.settleOutbox({
      outboxId: outbox.outboxId,
      outcome: 'delivered',
      at: outbox.nextAttemptAt + 1,
      deliveryRef: 'slack:D_IMMEDIATE_CREATION:206.2',
    });

    await runTurn(turn, chickpeaAssignment, {
      SLACK_TAG_PUBLIC_URL: 'https://chickpea.example',
    }, runOptions);
    assert.deepEqual(visiblePosts, []);
    assert.equal(promptCalls, 2);
    assert.equal(deferred, 1);
    assert.equal(delivered, 1);
  } finally {
    f.close();
  }
});

test('runTurn queues an Agent welcome as the pending terminal delivery', async () => {
  const f = await createManagementAdapterFixture('run-turn-host-creation-avatar');
  try {
    const created = await f.config.createAgent({
      id: 'agent_host_creation_avatar',
      name: 'Paid Marketing',
      description: 'Helps optimize Google Ads.',
      instructions: 'Use Google Ads data when connected.',
      enabled: true,
      kind: 'user',
      lifecycle: 'active',
      creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1,
      slackPresence: {
        requestedHandle: 'paid-marketing-avatar',
        normalizedHandle: 'paid-marketing-avatar',
        desiredState: 'active',
        health: 'healthy',
        avatar: { kind: 'generated', revision: 1, seed: 'paid-marketing-avatar' },
        userGroupId: 'SPAIDMARKETINGAVATAR',
      },
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const installation = await f.config.ensureWorkspaceInstallation({
      workspaceId: f.admin.binding.slackTeamId,
      transportMode: 'direct',
      defaultAgentId: created.id,
      teamId: f.admin.binding.slackTeamId,
      botUserId: 'U_CHICKPEA',
    });
    await f.config.updateWorkspaceInstallation(
      f.admin.binding.slackTeamId,
      { runtimeContract: 'chickpea-v1', health: 'healthy' },
      installation.revision,
    );
    const assignment: ResolvedAssignment = {
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'D_HOST_CREATION_AVATAR',
      agentId: created.id,
      runtimeContract: 'chickpea-v1',
      agent: created,
    };
    const turn: NormalizedSlackTurn = {
      workspaceId: assignment.workspaceId,
      channelId: assignment.channelId,
      eventId: 'Ev_HOST_CREATION_AVATAR',
      text: 'create it',
      userId: f.admin.binding.slackUserId,
      actorMembershipId: f.admin.membership.id,
      messageTs: '210.1',
      threadTs: '210.1',
      source: 'dm_message',
      contextMode: 'dm_history',
      interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
      managementApprovalProposalId: 'changeset_host_creation_avatar',
    };
    const runId = 'run_HOST_CREATION_AVATAR';
    const h = v3PresentationHarness(turn, runId);
    const effects: string[] = [];
    const client = {
      apiCall: async (_method: string, input: Record<string, unknown>) => {
        effects.push(`session:${String(input.status)}`);
        return { ok: true };
      },
      assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
        effects.push(`activity:${input.status ? 'set' : 'clear'}`);
        return { ok: true };
      } } },
      chat: {
        startStream: async () => ({ ok: true, ts: '211.1' }),
        stopStream: async () => ({ ok: true }),
        postMessage: async () => ({ ok: true, channel: turn.channelId, ts: '211.1' }),
      },
    } as unknown as WebClient;

    try {
      await runTurn(turn, assignment, {
        SLACK_TAG_PUBLIC_URL: 'https://chickpea.example',
      }, {
        client,
        turnId: 'turn_HOST_CREATION_AVATAR',
        runId,
        presentationState: h.state,
        managementApproval: {
          identity: f.identity,
          config: f.config,
          management: f.management,
          service: {
            confirmWorkspaceChange: async () => ({
              operationId: 'management_host_creation_avatar',
              idempotencyKey: 'host-creation-avatar',
              status: 'completed',
              outcomes: [{
                itemId: 'create',
                operationKind: 'create_agent',
                disposition: 'applied',
                changed: [{ kind: 'agent', id: created.id, revision: created.revision }],
              }],
              effectiveRevision: 'rev_host_creation_avatar',
              activation: 'next_turn',
            }),
          } as unknown as import('../src/management/service.ts').WorkspaceManagementService,
        },
        usageRecordingEnabled: false,
      });

      const outbox = await f.management.getOutboxForOperation('management_host_creation_avatar');
      assert.ok(outbox?.receipt && 'kind' in outbox.receipt);
      if (!outbox?.receipt || !('kind' in outbox.receipt)) assert.fail('expected Agent welcome');
      assert.equal(outbox.receipt.kind, 'agent_created_welcome');
      if (outbox.receipt.kind !== 'agent_created_welcome') assert.fail('expected Agent welcome');
      assert.equal(
        outbox.receipt.persona.avatarUrl,
        'https://chickpea.example/assets/agents/agent_host_creation_avatar/avatar/1',
      );
      assert.equal(outbox.receipt.presentationRunId, runId);
      const persisted = h.store.get(runId);
      assert.equal(persisted?.schemaVersion, 3);
      if (persisted?.schemaVersion !== 3) assert.fail('expected V3 presentation');
      assert.equal(persisted.terminalDelivery.state, 'intended');
      if (persisted.terminalDelivery.state !== 'intended') {
        assert.fail('expected deferred terminal delivery intent');
      }
      assert.equal(persisted.terminalDelivery.operation.certainty, 'pending');
      assert.deepEqual(effects, ['session:processing', 'activity:set']);
      assert.equal(persisted.stream.state, 'finalized');

      await completeAgentWelcomeDelivery(outbox, {
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        messageTs: '211.2',
        text: 'Agent welcome',
        persona: 'agent',
        client,
      }, f.config, {
        state: h.state,
        resolveClient: async () => {
          throw new Error('delivery cleanup must reuse the posting client');
        },
      });

      const settled = h.store.get(runId);
      assert.equal(settled?.schemaVersion, 3);
      if (settled?.schemaVersion !== 3) assert.fail('expected settled V3 presentation');
      assert.deepEqual(effects, [
        'session:processing',
        'activity:set',
        'session:active',
        'activity:clear',
      ]);
      assert.equal(settled.agentSession.acknowledged, 'active');
      assert.equal(settled.activityProjection.state, 'cleared');
      assert.equal(settled.lifecyclePhase, 'settled');
      assert.equal(settled.repairRequired, false);
    } finally {
      h.db.close();
    }
  } finally {
    f.close();
  }
});

test('runTurn keeps the persisted V3 owner from first status through final delivery', async () => {
  const persona = {
    name: 'Frozen Support',
    avatarUrl: 'https://chickpea.example/assets/agents/frozen/avatar/7',
    avatarRevision: 7,
  };
  for (const owner of [
    { kind: 'selected_agent' as const, persona },
    { kind: 'chickpea' as const },
  ]) {
    const db = openStateDb(':memory:');
    try {
      const messageTs = owner.kind === 'selected_agent'
        ? '1785700000.000100'
        : '1785700000.000101';
      const turn: NormalizedSlackTurn = {
        ...workTurn(`Ev_FROZEN_OWNER_${owner.kind}`),
        messageTs,
        threadTs: messageTs,
        interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
      };
      const runId = `run_frozen_owner_${owner.kind}`;
      const sessionGeneration = Number(turn.messageTs.replace('.', ''));
      const presentations = new SlackRunPresentationStoreLogic(db);
      presentations.create({
        schemaVersion: 3,
        runId,
        turnJobId: `turn_frozen_owner_${owner.kind}`,
        bindingId: `binding_frozen_owner_${owner.kind}`,
        workBindingGeneration: 1,
        runFencingToken: 0,
        owner,
        sessionGeneration,
        currentActivity: {
          kind: 'preparing',
          action: 'Preparing',
          object: 'your request',
          generation: sessionGeneration,
          sequence: 1,
          operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
        },
        root: {
          workspaceId: turn.workspaceId,
          channelId: turn.channelId,
          threadTs: turn.threadTs,
          requesterUserId: turn.userId,
        },
      });
      const statuses: Array<Record<string, unknown>> = [];
      const sessionStatuses: Array<Record<string, unknown>> = [];
      const activities: Array<Record<string, unknown>> = [];
      const starts: Array<Record<string, unknown>> = [];
      const stops: Array<Record<string, unknown>> = [];
      const client = {
        apiCall: async (method: string, input: Record<string, unknown>) => {
          assert.equal(method, 'agents.sessions.setStatus');
          sessionStatuses.push(input);
          return { ok: true };
        },
        assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
          statuses.push(input);
          return { ok: true };
        } } },
        chat: {
          startStream: async (input: Record<string, unknown>) => {
            starts.push(input);
            return { ok: true, ts: `1785700200.${owner.kind === 'selected_agent' ? '000100' : '000200'}` };
          },
          stopStream: async (input: Record<string, unknown>) => {
            stops.push(input);
            return { ok: true };
          },
          postMessage: async (input: Record<string, unknown>) => {
            activities.push(input);
            return { ok: true, channel: turn.channelId, ts: '1785700150.000100' };
          },
          delete: async () => ({ ok: true }),
        },
      } as unknown as WebClient;
      const presentationState = {
        getRunPresentation: (id: string) => presentations.get(id),
        getLatestThreadSessionGeneration: (root: Parameters<
          typeof presentations.getLatestThreadSessionGeneration
        >[0]) => presentations.getLatestThreadSessionGeneration(root),
        transitionRunPresentation: (input: Parameters<typeof presentations.transition>[0]) =>
          presentations.transition(input),
        reserveSlackAppend: (workspaceId: string) => presentations.reserveAppend(workspaceId),
        applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
          presentations.applyAppendCooldown(workspaceId, retryAfterMs),
        matchFlueObservation: () => undefined,
      };

      await runTurn(turn, { ...assignment, agent: { ...assignment.agent, name: 'Mutable Agent' } },
        undefined, {
          client,
          runId,
          replayText: 'Persisted answer.',
          presentationState,
          usageRecordingEnabled: false,
        });

      assert.deepEqual(
        statuses.map(({ status }) => status),
        ['Preparing your request…', ''],
        'the native under-composer status stays visible and clears after the final',
      );
      assert.deepEqual(statuses[0], {
        channel_id: turn.channelId,
        thread_ts: turn.threadTs,
        status: 'Preparing your request…',
        loading_messages: ['Preparing your request…'],
        ...(owner.kind === 'selected_agent'
          ? { username: persona.name, icon_url: persona.avatarUrl }
          : {}),
      });
      assert.deepEqual(
        sessionStatuses.map(({ status, username, icon_url }) => ({ status, username, icon_url })),
        [
          {
            status: 'processing',
            ...(owner.kind === 'selected_agent'
              ? { username: persona.name, icon_url: persona.avatarUrl }
              : { username: undefined, icon_url: undefined }),
          },
          {
            status: 'active',
            ...(owner.kind === 'selected_agent'
              ? { username: persona.name, icon_url: persona.avatarUrl }
              : { username: undefined, icon_url: undefined }),
          },
        ],
      );
      if (owner.kind === 'selected_agent') {
        assert.deepEqual(activities, [], 'selected Agents use only Slack native status while working');
        assert.equal(starts[0]?.username, persona.name);
        assert.equal(starts[0]?.icon_url, persona.avatarUrl);
      } else {
        assert.deepEqual(activities, [], 'Chickpea uses only Slack native status while working');
        assert.equal(Object.hasOwn(starts[0] ?? {}, 'username'), false);
        assert.equal(Object.hasOwn(starts[0] ?? {}, 'icon_url'), false);
      }
      assert.doesNotMatch(
        JSON.stringify(stops[0]),
        /provider/i,
        'the V3 footer must not add separate provider metadata',
      );
      assert.match(JSON.stringify(stops[0]), /local-stub\/heartbeat/);
      const persisted = presentations.get(runId);
      assert.equal(
        persisted?.schemaVersion === 3
          ? persisted.currentActivity?.operation.certainty
          : undefined,
        'acknowledged',
      );
    } finally {
      db.close();
    }
  }
});

test('admission activity is fixed thinking copy without checklist or UTC narration', async () => {
  const statuses: Array<Record<string, unknown>> = [];
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let deletes = 0;
  const client = {
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      statuses.push(input);
      return { ok: true };
    } } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, channel: assignment.channelId, ts: 'activity-ts' };
      },
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        return { ok: true };
      },
      delete: async () => {
        deletes += 1;
        return { ok: true };
      },
      startStream: async () => ({ ok: true, ts: 'final-ts' }),
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  await runTurn(workTurn('Ev_NO_CHECKLIST_HEARTBEAT'), assignment, undefined, {
    client,
    replayText: 'Verification complete.',
    usageRecordingEnabled: false,
  });

  assert.deepEqual(statuses.map((status) => status.status), ['Thinking…', '']);
  assert.equal(posts.length, 0);
  assert.deepEqual(updates, []);
  assert.equal(deletes, 0);
  assert.doesNotMatch(JSON.stringify(statuses), /UTC|chickpea_work_checklist|is thinking|local-stub/);
});

test('a capability-disabled V3 turn keeps Agent Session lifecycle without semantic status', async () => {
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_V3_SEMANTIC_ACTIVITY_OFF'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = 'run_v3_semantic_activity_off';
  const h = v3PresentationHarness(turn, runId, false);
  const sessionStatuses: string[] = [];
  const semanticStatuses: string[] = [];
  const client = {
    apiCall: async (_method: string, input: Record<string, unknown>) => {
      sessionStatuses.push(String(input.status));
      return { ok: true };
    },
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      semanticStatuses.push(String(input.status));
      return { ok: true };
    } } },
    chat: {
      startStream: async () => ({ ok: true, ts: '1787776100.000300' }),
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  try {
    await runTurn(turn, assignment, undefined, {
      client,
      runId,
      replayText: 'Lifecycle-only answer.',
      presentationState: h.state,
      usageRecordingEnabled: false,
    });
    assert.deepEqual(sessionStatuses, ['processing', 'active']);
    assert.deepEqual(semanticStatuses, []);
    const stored = h.store.get(runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion === 3) {
      assert.equal(stored.currentActivity, undefined);
      assert.deepEqual(stored.activityProjection, { surface: 'unselected', state: 'absent' });
    }
  } finally {
    h.db.close();
  }
});

test('replay delivery skips model activity and never invokes the agent provider', async () => {
  const statusCalls: Array<{ status?: string; loading_messages?: string[] }> = [];
  let agentCalls = 0;
  const client = {
    assistant: {
      threads: {
        async setStatus(input: { status?: string; loading_messages?: string[] }) {
          statusCalls.push(input);
          return { ok: true };
        },
      },
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async () => ({ ok: true, ts: 'final-ts' }),
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, channel: assignment.channelId, ts: 'final-ts' }),
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_REPLAY_NO_MODEL'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const terminalOutcomes: Array<string | undefined> = [];

  await runTurn(turn, assignment, undefined, {
    client,
    replayText: 'Previously completed answer.',
    usageRecordingEnabled: false,
    onDelivered: (outcome) => { terminalOutcomes.push(outcome); },
    async agentPrompt(): Promise<AgentDispatchResult> {
      agentCalls += 1;
      throw new Error('replay must not invoke the agent provider');
    },
  });

  assert.equal(agentCalls, 0);
  assert.deepEqual(terminalOutcomes, [undefined]);
  assert.equal(
    statusCalls.some((call) =>
      call.loading_messages?.includes(`Using ${assignment.model}`)
    ),
    false,
  );
});

test('activated turns never fall back to SLACK_TAG_MODEL when the frozen model is missing', async () => {
  const previousModel = process.env.SLACK_TAG_MODEL;
  process.env.SLACK_TAG_MODEL = 'local-stub/legacy-environment-fallback';
  let delivered = '';
  let agentCalls = 0;
  let deliveredTombstones = 0;
  const client = {
    chat: {
      startStream: async (input: { markdown_text: string }) => {
        delivered = input.markdown_text;
        return { ok: true, ts: 'repair-final-ts' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: { text: string }) => {
        delivered = input.text;
        return { ok: true, channel: assignment.channelId, ts: 'repair-final-ts' };
      },
    },
  } as unknown as WebClient;
  const { model: _assignmentModel, modelAttribution: _attribution, ...assignmentWithoutModel } = assignment;
  const { model: _agentModel, ...agentWithoutModel } = assignment.agent;
  const activatedAssignment: ResolvedAssignment = {
    ...assignmentWithoutModel,
    runtimeContract: 'chickpea-v1',
    agent: agentWithoutModel,
  };

  try {
    await runTurn(workTurn('Ev_MISSING_WORKSPACE_DEFAULT'), activatedAssignment, undefined, {
      client,
      usageRecordingEnabled: false,
      onDelivered() {
        deliveredTombstones += 1;
      },
      async agentPrompt(): Promise<AgentDispatchResult> {
        agentCalls += 1;
        throw new Error('a missing frozen model must not enter Flue');
      },
    });
  } finally {
    if (previousModel === undefined) delete process.env.SLACK_TAG_MODEL;
    else process.env.SLACK_TAG_MODEL = previousModel;
  }

  assert.equal(agentCalls, 0);
  assert.equal(deliveredTombstones, 1);
  assert.equal(delivered, WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT);
  assert.doesNotMatch(delivered, /legacy-environment-fallback/);
});

test('runTurn resolves the authenticated self-mention placeholder before Slack delivery', async () => {
  let delivered = '';
  const client = {
    assistant: {
      threads: {
        setStatus: async () => ({ ok: true }),
      },
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async (input: { markdown_text: string }) => {
        delivered = input.markdown_text;
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, channel: assignment.channelId, ts: 'final-ts' }),
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_SELF_MENTION'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  await runTurn(turn, assignment, undefined, {
    installationContext: {
      workspaceId: assignment.workspaceId,
      transportMode: 'direct',
      botToken: 'xoxb-test',
      botUserId: 'U_CHICKPEA',
      displayName: 'Chickpea Renamed',
      client,
    },
    replayText: `Try ${SLACK_SELF_MENTION_PLACEHOLDER} summarize this channel.`,
    usageRecordingEnabled: false,
  });

  assert.match(delivered, /Try <@U_CHICKPEA> summarize this channel\./);
  assert.doesNotMatch(delivered, /CHICKPEA_SELF_MENTION/);
});

test('a recovery-required Flue conflict emits no Slack final', async () => {
  let finalAttempts = 0;
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    assistant: {
      threads: {
        setStatus: async () => ({ ok: true }),
      },
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async () => {
        finalAttempts += 1;
        return { ok: true, ts: 'unexpected-final' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, channel: assignment.channelId, ts: 'unexpected-final' };
      },
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_RECOVERY_REQUIRED'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  await assert.rejects(
    () => runTurn(turn, assignment, undefined, {
      client,
      usageRecordingEnabled: false,
      async agentPrompt(): Promise<AgentDispatchResult> {
        throw new AgentPromptFailure('agent', 409, true);
      },
    }),
    (error: unknown) => error instanceof AgentPromptFailure && error.recoveryRequired,
  );
  assert.equal(finalAttempts, 0);
  assert.deepEqual(posts, []);
});

test('a retryable Flue interruption emits no Slack final', async () => {
  let finalAttempts = 0;
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      startStream: async () => {
        finalAttempts += 1;
        return { ok: true, ts: 'unexpected-final' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, channel: assignment.channelId, ts: 'unexpected-final' };
      },
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_RETRYABLE_INTERRUPTION'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  await assert.rejects(
    () => runTurn(turn, assignment, undefined, {
      client,
      usageRecordingEnabled: false,
      async agentPrompt(): Promise<AgentDispatchResult> {
        throw new AgentPromptFailure('agent', 503, false, true);
      },
    }),
    (error: unknown) => error instanceof AgentPromptFailure && error.retryable,
  );
  assert.equal(finalAttempts, 0);
  assert.deepEqual(posts, []);
});

test('activity remains visible until final delivery and omits model or context narration', async () => {
  const agentStarted = deferred<void>();
  const finalAttempted = deferred<void>();
  const lifecycle: string[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const nativeStatuses: Array<Record<string, unknown>> = [];
  const terminalOutcomes: Array<string | undefined> = [];
  const client = {
    assistant: {
      threads: {
        async setStatus(input: Record<string, unknown>) {
          nativeStatuses.push(input);
          if (input.status === '') lifecycle.push('clear');
          return { ok: true };
        },
      },
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async () => {
        lifecycle.push('final');
        finalAttempted.resolve(undefined);
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: Record<string, unknown>) => {
        activity.push(input);
        return { ok: true, channel: assignment.channelId, ts: 'activity-ts' };
      },
      delete: async () => {
        lifecycle.push('clear');
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_STATUS_DOES_NOT_BLOCK'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  const outcome = runTurn(turn, assignment, undefined, {
    client,
    usageRecordingEnabled: false,
    onDelivered: (terminalOutcome) => { terminalOutcomes.push(terminalOutcome); },
    async agentPrompt(): Promise<AgentDispatchResult> {
      agentStarted.resolve(undefined);
      return {
        text: 'Fresh answer.',
        requestedModel: assignment.model ?? null,
        returnedModel: null,
        reportedUsage: null,
        usageCompleteness: 'not_reported',
      };
    },
  }).then(() => 'resolved' as const, () => 'rejected' as const);

  await agentStarted.promise;
  await finalAttempted.promise;
  assert.equal(await Promise.race([outcome, delay(100, 'timeout' as const)]), 'resolved');
  assert.deepEqual(
    nativeStatuses.map((item) => item.status),
    ['Thinking…', ''],
    'native status is set once and cleared once',
  );
  assert.deepEqual(activity, []);
  assert.deepEqual(terminalOutcomes, ['succeeded']);
  assert.doesNotMatch(JSON.stringify(nativeStatuses), /local-stub|message(?:s)? of|is thinking/i);
  assert.deepEqual(
    lifecycle.slice(0, 2),
    ['final', 'clear'],
    'the final must be posted before the activity is removed',
  );
});

test('acknowledged final settles the frozen Agent Session before deleting activity', async () => {
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_V3_TERMINAL_ORDER'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = 'run_v3_terminal_order';
  const h = v3PresentationHarness(turn, runId);
  const effects: string[] = [];
  const client = {
    apiCall: async (_method: string, input: Record<string, unknown>) => {
      effects.push(`session:${String(input.status)}:${String(input.username)}`);
      return { ok: true };
    },
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      effects.push(`activity:${input.status ? 'set' : 'clear'}:${String(input.username)}`);
      return { ok: true };
    } } },
    chat: {
      startStream: async () => {
        effects.push('final:start');
        return { ok: true, ts: '1787776100.000200' };
      },
      stopStream: async () => {
        effects.push('final:ack');
        return { ok: true };
      },
    },
  } as unknown as WebClient;

  try {
    await runTurn(turn, assignment, undefined, {
      client,
      runId,
      presentationState: h.state,
      replayText: 'The requested work is complete.',
      executionAuthority: 'ledger',
      usageRecordingEnabled: false,
    });
    assert.deepEqual(effects, [
      'session:processing:Frozen Support',
      'activity:set:Frozen Support',
      'final:start',
      'final:ack',
      'session:active:Frozen Support',
      'activity:clear:undefined',
    ]);
    const persisted = h.store.get(runId);
    assert.equal(persisted?.schemaVersion, 3);
    if (persisted?.schemaVersion !== 3) return;
    assert.equal(persisted.terminalDelivery.state === 'intended'
      ? persisted.terminalDelivery.operation.certainty
      : undefined, 'acknowledged');
    assert.equal(persisted.agentSession.acknowledged, 'active');
    assert.equal(persisted.cleanup.state === 'required'
      ? persisted.cleanup.operation.certainty
      : undefined, 'acknowledged');
    assert.equal(persisted.activityProjection.state, 'cleared');
  } finally {
    h.db.close();
  }
});

test('a lease lost after visible activity and agent completion settles a frozen-owner failure', async () => {
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_V3_LEASE_LOST_AFTER_AGENT'),
    messageTs: '1787776150.000100',
    threadTs: '1787776150.000100',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = 'run_v3_lease_lost_after_agent';
  const h = v3PresentationHarness(turn, runId);
  const { model: _model, modelAttribution: _modelAttribution, ...assignmentWithoutModel } = assignment;
  const leaseAssignment: ResolvedAssignment = {
    ...assignmentWithoutModel,
    agent: assignment.agent,
  };
  const config = new SqliteConfigStore(':memory:', { agents: [assignment.agent] });
  const memory = new SqliteMemoryStateStore(':memory:');
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await config.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  const finalPayloads: Array<Record<string, unknown>> = [];
  let delivered = 0;
  const terminalOutcomes: Array<string | undefined> = [];
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      postMessage: async () => ({ ok: true, channel: turn.channelId, ts: '1787776150.000200' }),
      startStream: async (input: Record<string, unknown>) => {
        finalPayloads.push(input);
        return { ok: true, ts: '1787776150.000300' };
      },
      stopStream: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  try {
    await runTurn(turn, leaseAssignment, undefined, {
      client,
      runId,
      presentationState: h.state,
      executionAuthority: 'ledger',
      usageRecordingEnabled: false,
      appStores: { config, memory, identity: {} } as never,
      onDelivered: (outcome) => {
        delivered += 1;
        terminalOutcomes.push(outcome);
      },
      async agentPrompt(): Promise<AgentDispatchResult> {
        const live = await config.getAgent(assignment.agentId);
        await config.updateAgent(assignment.agentId, { enabled: false }, live.revision);
        return {
          text: 'This answer must not be delivered after the lease changes.',
          requestedModel: null,
          returnedModel: null,
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
    });

    assert.equal(finalPayloads.length, 1);
    assert.match(String(finalPayloads[0]?.markdown_text), /agent run failed before completion/);
    assert.equal(delivered, 1, 'the terminal failure still writes the delivery tombstone');
    assert.deepEqual(terminalOutcomes, ['failed']);
    const persisted = h.store.get(runId);
    assert.equal(persisted?.schemaVersion, 3);
    if (persisted?.schemaVersion !== 3) return;
    assert.equal(
      persisted.terminalDelivery.state === 'intended'
        ? persisted.terminalDelivery.operation.certainty
        : undefined,
      'acknowledged',
    );
    assert.equal(persisted.agentSession.acknowledged, 'suspended');
    assert.equal(persisted.activityProjection.state, 'cleared');
  } finally {
    config.close();
    memory.close();
    h.db.close();
  }
});

test('confirmed final rejection leaves the same durable activity visible for recovery', async () => {
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_V3_FINAL_REJECTED'),
    messageTs: '1787776200.000100',
    threadTs: '1787776200.000100',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = 'run_v3_final_rejected';
  const h = v3PresentationHarness(turn, runId);
  const deleted: string[] = [];
  const rejected = Object.assign(new Error('Slack rejected the final'), {
    code: ErrorCode.PlatformError,
    data: { error: 'invalid_blocks' },
  });
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      postMessage: async () => { throw rejected; },
      startStream: async () => { throw rejected; },
      delete: async (input: Record<string, unknown>) => {
        deleted.push(String(input.ts));
        return { ok: true };
      },
    },
  } as unknown as WebClient;

  try {
    await assert.rejects(() => runTurn(turn, assignment, undefined, {
      client,
      runId,
      presentationState: h.state,
      replayText: 'This final will be rejected.',
      executionAuthority: 'ledger',
      usageRecordingEnabled: false,
    }));
    assert.deepEqual(deleted, [], 'activity must remain until a terminal reply is acknowledged');
    const persisted = h.store.get(runId);
    assert.equal(persisted?.schemaVersion, 3);
    if (persisted?.schemaVersion !== 3) return;
    assert.deepEqual(persisted.activityProjection, {
      surface: 'assistant_status', state: 'visible',
    });
    assert.equal(persisted.terminalDelivery.state === 'intended'
      ? persisted.terminalDelivery.operation.certainty
      : undefined, 'failed');
    assert.deepEqual(persisted.cleanup, { state: 'not_required' });
    assert.equal(persisted.agentSession.desired, 'processing');
  } finally {
    h.db.close();
  }
});

test('unknown final effect remains repair-required and replay never posts a duplicate', async () => {
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_V3_FINAL_UNKNOWN'),
    messageTs: '1787776300.000100',
    threadTs: '1787776300.000100',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = 'run_v3_final_unknown';
  const h = v3PresentationHarness(turn, runId);
  let activityPosts = 0;
  let finalStarts = 0;
  let finalStops = 0;
  let deletes = 0;
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      postMessage: async () => {
        activityPosts += 1;
        return { ok: true, channel: turn.channelId, ts: '1787776300.000200' };
      },
      startStream: async () => {
        finalStarts += 1;
        return { ok: true, ts: '1787776300.000300' };
      },
      stopStream: async () => {
        finalStops += 1;
        throw Object.assign(new Error('timeout'), { code: ErrorCode.RequestError });
      },
      delete: async () => { deletes += 1; return { ok: true }; },
    },
  } as unknown as WebClient;
  const options = {
    client,
    runId,
    presentationState: h.state,
    replayText: 'The final may already be visible.',
    executionAuthority: 'ledger' as const,
    usageRecordingEnabled: false,
  };

  try {
    await assert.rejects(() => runTurn(turn, assignment, undefined, options));
    await assert.rejects(() => runTurn(turn, assignment, undefined, options));
    assert.deepEqual({ activityPosts, finalStarts, finalStops, deletes }, {
      activityPosts: 0, finalStarts: 1, finalStops: 1, deletes: 0,
    });
    const persisted = h.store.get(runId);
    assert.equal(persisted?.schemaVersion === 3 &&
      persisted.terminalDelivery.state === 'intended'
      ? persisted.terminalDelivery.operation.certainty
      : undefined, 'unknown');
    assert.equal(persisted?.repairRequired, true);
  } finally {
    h.db.close();
  }
});

test('unknown fallback post keeps its terminal idempotency key and is not reposted', async () => {
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_V3_FALLBACK_UNKNOWN'),
    messageTs: '1787776350.000100',
    threadTs: '1787776350.000100',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = 'run_v3_fallback_unknown';
  const h = v3PresentationHarness(turn, runId);
  const posts: Array<Record<string, unknown>> = [];
  let starts = 0;
  const startRejected = Object.assign(new Error('unsupported stream'), {
    code: ErrorCode.PlatformError,
    data: { error: 'invalid_blocks' },
  });
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        throw Object.assign(new Error('post timeout'), { code: ErrorCode.RequestError });
      },
      startStream: async () => { starts += 1; throw startRejected; },
      delete: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const options = {
    client, runId, presentationState: h.state,
    replayText: 'The fallback may already be visible.',
    executionAuthority: 'ledger' as const,
    usageRecordingEnabled: false,
  };

  try {
    await assert.rejects(() => runTurn(turn, assignment, undefined, options));
    await assert.rejects(() => runTurn(turn, assignment, undefined, options));
    assert.equal(starts, 1);
    assert.equal(posts.length, 1, 'only the terminal fallback is attempted');
    assert.match(String(posts[0]?.client_msg_id), /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(
      JSON.stringify(posts[0]),
      /provider/i,
      'the V3 fallback footer must not add separate provider metadata',
    );
    assert.match(JSON.stringify(posts[0]), /local-stub\/heartbeat/);
    const persisted = h.store.get(runId);
    assert.equal(persisted?.schemaVersion === 3 &&
      persisted.terminalDelivery.state === 'intended'
      ? persisted.terminalDelivery.operation.certainty
      : undefined, 'unknown');
  } finally {
    h.db.close();
  }
});

test('failed activity cleanup retries the same coordinate without replaying the answer', async () => {
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_V3_CLEANUP_RETRY'),
    messageTs: '1787776400.000100',
    threadTs: '1787776400.000100',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = 'run_v3_cleanup_retry';
  const h = v3PresentationHarness(turn, runId);
  let finalStarts = 0;
  const statuses: Array<Record<string, unknown>> = [];
  const clearRejected = Object.assign(new Error('status clear rejected'), {
    code: ErrorCode.PlatformError,
    data: { error: 'temporarily_unavailable' },
  });
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      statuses.push(input);
      if (input.status === '' && statuses.filter((status) => status.status === '').length === 1) {
        throw clearRejected;
      }
      return { ok: true };
    } } },
    chat: {
      startStream: async () => {
        finalStarts += 1;
        return { ok: true, ts: '1787776400.000300' };
      },
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const options = {
    client,
    runId,
    presentationState: h.state,
    replayText: 'The final is durable.',
    executionAuthority: 'ledger' as const,
    usageRecordingEnabled: false,
  };

  try {
    await runTurn(turn, assignment, undefined, options);
    const pendingRepair = h.store.get(runId);
    assert.equal(pendingRepair?.schemaVersion, 3);
    if (pendingRepair?.schemaVersion !== 3) return;
    await repairTerminalSlackPresentation(pendingRepair, h.state, client);
    assert.equal(finalStarts, 1);
    assert.deepEqual(statuses.map(({ status }) => status), [
      'Preparing your request…', '', '',
    ]);
    const persisted = h.store.get(runId);
    assert.equal(persisted?.schemaVersion === 3 && persisted.cleanup.state === 'required'
      ? persisted.cleanup.operation.certainty
      : undefined, 'acknowledged');
  } finally {
    h.db.close();
  }
});

test('runTurn freezes eligibility before exposing the receipt-scoped relay factory', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => 1_800_000_000_000 });
  const presentationDb = openStateDb(':memory:');
  try {
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      startStream: async () => ({ ok: true, ts: '1785700200.000100' }),
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({
        ok: true,
        channel: assignment.channelId,
        ts: '1785700200.000100',
      }),
    },
  } as unknown as WebClient;
  const currentTurn: NormalizedSlackTurn = {
    ...workTurn('Ev_PROGRESSIVE_ELIGIBILITY'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runtimePlan = compileRuntimePlanV2({
    turn: currentTurn,
    assignment,
    instructions: assignment.agent.instructions,
    memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  const captured: unknown[] = [];
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn: currentTurn,
    assignment,
    sourceVisibility: 'private',
    admittedAt: 1_800_000_000_000,
  }));
  const presentations = new SlackRunPresentationStoreLogic(
    presentationDb,
    () => 1_800_000_000_000,
  );
  presentations.create({
    runId: admitted.run.id,
    turnJobId: 'turn_progressive_eligibility',
    bindingId: admitted.binding.id,
    workBindingGeneration: admitted.binding.generation,
    runFencingToken: 0,
    root: {
      workspaceId: currentTurn.workspaceId,
      channelId: currentTurn.channelId,
      threadTs: currentTurn.threadTs,
      requesterUserId: currentTurn.userId,
    },
  });

  await runTurn(currentTurn, assignment, undefined, {
    client,
    runId: admitted.run.id,
    runAttempt: 1,
    workStore: work,
    runtimePlanDecision: {
      runtimePlan,
      instanceId: deriveRuntimePlanInstanceId(runtimePlan),
    },
    // The Cloudflare relay always provides this recovery callback. Its mere
    // presence must not imply replacement authority for a frozen bash plan.
    beforeDelivery: async () => undefined,
    presentationState: {
      getRunPresentation: (runId) => presentations.get(runId),
      getLatestThreadSessionGeneration: (root) =>
        presentations.getLatestThreadSessionGeneration(root),
      transitionRunPresentation: (input) => presentations.transition(input),
      reserveSlackAppend: (workspaceId) => presentations.reserveAppend(workspaceId),
      applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
        presentations.applyAppendCooldown(workspaceId, retryAfterMs),
      matchFlueObservation: () => undefined,
    },
    progressiveAttributionProven: true,
    prepareProgressiveRelay: async (input) => {
      captured.push(structuredClone(input));
      return undefined;
    },
    usageRecordingEnabled: false,
    async agentPrompt(input): Promise<AgentDispatchResult> {
      assert.deepEqual(presentations.get(admitted.run.id)?.progressiveEligibility, {
        status: 'frozen',
        allowed: true,
        reason: 'safe_early_release',
      });
      assert.equal(typeof input.prepareProgressiveRelay, 'function');
      await input.prepareProgressiveRelay?.({
        instanceId: deriveRuntimePlanInstanceId(runtimePlan),
        receipt: {
          submissionId: 'submission_progressive_eligibility',
          acceptedAt: '2026-08-02T12:00:00.000Z',
          uid: 'uid_progressive_eligibility',
        },
      });
      return {
        text: 'Fresh answer.',
        requestedModel: assignment.model ?? null,
        returnedModel: null,
        reportedUsage: null,
        usageCompleteness: 'not_reported',
      };
    },
  });

  assert.deepEqual(captured, [{
    runId: admitted.run.id,
    runFencingToken: 0,
    instanceId: deriveRuntimePlanInstanceId(runtimePlan),
    receipt: {
      submissionId: 'submission_progressive_eligibility',
      acceptedAt: '2026-08-02T12:00:00.000Z',
      uid: 'uid_progressive_eligibility',
    },
    eligibility: { allowed: true, reason: 'safe_early_release' },
  }]);
  } finally {
    presentationDb.close();
    work.close();
  }
});

test('a frozen Cloudflare plan narrows unsettled dispatches when its live binding disappeared', async () => {
  const repositoryAssignment: ResolvedAssignment = {
    ...assignment,
    agent: {
      ...assignment.agent,
      repositories: [{
        id: 'repo-runtime-fallback',
        installationId: 42,
        accountLogin: 'Acme',
        fullName: 'Acme/RuntimeFallback',
        enabled: true,
      }],
    },
  };
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_SANDBOX_BINDING_REMOVED'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runtimePlan = compileRuntimePlanV2({
    turn,
    assignment: repositoryAssignment,
    instructions: repositoryAssignment.agent.instructions,
    memoryEpoch: 1,
    sandboxMode: 'cloudflare',
  });
  const finalPayloads: unknown[] = [];
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      startStream: async (input: unknown) => {
        finalPayloads.push(input);
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async (input: unknown) => {
        finalPayloads.push(input);
        return { ok: true };
      },
      postMessage: async (input: unknown) => {
        finalPayloads.push(input);
        return { ok: true, channel: assignment.channelId, ts: 'final-ts' };
      },
    },
  } as unknown as WebClient;
  for (const checkpoint of ['unstarted', 'envelope', 'receipt'] as const) {
      const dispatchEnvelope: FlueDispatchEnvelopeV1 = {
        schemaVersion: 1,
        agentName: 'chickpea-slack-v2',
        instanceId: deriveRuntimePlanInstanceId(runtimePlan),
        uid: null,
        message: { kind: 'user', body: `durable ${checkpoint} message` },
        initialData: runtimePlan,
        idempotencyKey: `sandbox-binding-removed:${checkpoint}`,
      };
      const dispatchReceipt: FlueDispatchReceiptV1 = {
        submissionId: `submission_sandbox_binding_removed_${checkpoint}`,
        acceptedAt: '2026-08-08T18:00:00.000Z',
        uid: `uid_sandbox_binding_removed_${checkpoint}`,
      };
      const flueDispatch: SlackFlueDispatchState = {
        ...(checkpoint === 'unstarted' ? {} : { dispatchEnvelope }),
        ...(checkpoint === 'receipt' ? { dispatchReceipt } : {}),
        prepare: async () => { throw new Error('focused agent override owns dispatch'); },
        recordReceipt: async (receipt) => receipt,
        recordSettlement: async (settlement) => settlement,
        reconcileExistingInstance: async () => { throw new Error('not used'); },
        markRecoveryRequired: async () => {},
      };
      await runTurn({ ...turn, eventId: `${turn.eventId}_${checkpoint}` }, repositoryAssignment, undefined, {
        client,
        runtimePlanDecision: {
          runtimePlan,
          instanceId: deriveRuntimePlanInstanceId(runtimePlan),
        },
        flueDispatch,
        usageRecordingEnabled: false,
        async agentPrompt(input): Promise<AgentDispatchResult> {
          assert.equal(input.useCloudflareSandbox, false, checkpoint);
          assert.equal(input.state.dispatchEnvelope, checkpoint === 'unstarted' ? undefined : dispatchEnvelope);
          assert.equal(input.state.dispatchReceipt, checkpoint === 'receipt' ? dispatchReceipt : undefined);
          return {
            text: 'Normal response without repository access.',
            requestedModel: repositoryAssignment.model ?? null,
            returnedModel: null,
            reportedUsage: null,
            usageCompleteness: 'not_reported',
          };
        },
      });
  }
  assert.match(JSON.stringify(finalPayloads), new RegExp(SANDBOX_UNAVAILABLE_FALLBACK_NOTICE));
  assert.doesNotMatch(JSON.stringify(finalPayloads), /control-plane|binding|credential|token/i);
});

test('runTurn fails a lease-rejected turn closed instead of returning silently', async () => {
  // The Cobalt stall: the pre-run owner-lease fence returned without any
  // delivery, so the durable relay never tombstoned the job and kept re-arming
  // its alarm behind a live "Thinking…" status.
  const fencedAssignment: ResolvedAssignment = {
    ...assignment,
    channelId: 'C_FENCE',
  };
  const fencedTurn: NormalizedSlackTurn = {
    workspaceId: fencedAssignment.workspaceId,
    channelId: fencedAssignment.channelId,
    eventId: 'Ev_LEASE_FENCE',
    text: '<@U_CHICKPEA> archive the Brief agent.',
    userId: 'U_HEARTBEAT',
    messageTs: '1785509100.000100',
    threadTs: '1785509100.000100',
    source: 'app_mention',
    channelType: 'channel',
    contextMode: 'thread',
  };
  const posted: string[] = [];
  const deliveries: (string | undefined)[] = [];
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      postMessage: async (input: { text?: string }) => {
        if (input.text) posted.push(input.text);
        return { ok: true, channel: fencedTurn.channelId, ts: 'fence-ts' };
      },
      update: async () => ({ ok: true }),
      startStream: async (input: Record<string, unknown>) => {
        const streamed = input.markdown_text ?? input.text;
        if (typeof streamed === 'string') posted.push(streamed);
        return { ok: true, ts: 'fence-final-ts' };
      },
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  await runTurn(fencedTurn, fencedAssignment, undefined, {
    client,
    usageRecordingEnabled: false,
    onDelivered: (outcome) => {
      deliveries.push(outcome);
    },
  });

  // Bounded and visible: exactly one terminal delivery outcome the relay can
  // tombstone, plus a sanitized final in Slack.
  assert.deepEqual(deliveries, ['failed']);
  assert.ok(
    posted.some((text) => text.includes(AGENT_FAILURE_TEXT)),
    `expected a sanitized final, saw ${JSON.stringify(posted)}`,
  );
});
