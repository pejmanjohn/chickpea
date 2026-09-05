import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AgentInstanceHandle, AgentReply, DispatchReceipt } from '@flue/runtime';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { createDemoStarterAgent } from '../src/config/seed.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  executeRoutineOccurrence,
} from '../src/routines/execution.ts';
import { RoutineRuntimeError } from '../src/routines/runtime.ts';
import { hashRoutineValue, routineDestinationBindingDigest } from '../src/routines/ids.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type {
  RoutineDefinition,
  RoutineDefinitionContent,
  RoutineRun,
} from '../src/routines/types.ts';
import {
  parseRoutineExecutionInitialData,
  ROUTINE_RESULT_DATA_NAME,
} from '../src/agents/routine-execution.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import type { UsageStore } from '../src/usage/types.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { RunExecutionId, WorkStore } from '../src/work/types.ts';
import type { ProductTelemetryEventInput } from '../src/telemetry/events.ts';

const NOW = Date.UTC(2026, 6, 27, 12);

const config = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: 'agent_default',
  agent: {
    id: 'agent_default', kind: 'user', revision: 1, name: 'Chickpea', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', instructions: 'Be useful.', instructionLayers: [],
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
} satisfies EffectiveSlackConfig;

async function admittedFixture(
  store: SqliteRoutineStore,
  suffix: string,
  beforeOccurrence?: (routine: RoutineDefinition) => Promise<void>,
  sourceVisibility?: 'public' | 'private' | 'unknown',
  deadlineAt = NOW + 60_000,
) {
  const definition: RoutineDefinitionContent = {
    name: 'Execution fixture', description: '', taskText: 'Inspect current state.',
    triggerKind: 'schedule', scheduleInput: '0 * * * *',
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
  };
  const routineId = `routine_${suffix}`;
  const saved = await store.save({
    actorId: 'U_MEMBER', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
    draft: {
      action: 'create', routineId, definition, nextRunAt: NOW,
      projectedDailyStarts: 1, reservations: [{ windowStart: NOW, count: 1 }],
    },
    idempotencyKey: `create:${suffix}`,
    ...(sourceVisibility ? { sourceVisibility } : {}),
  });
  await beforeOccurrence?.(saved);
  const run = await store.createOccurrence({
    runId: `rrun_${suffix}`,
    idempotencyKey: `run:${suffix}`,
    routineId,
    routineVersion: 1,
    scheduledFor: NOW,
    triggerSource: 'schedule',
    queuedAt: NOW,
    deadlineAt,
  });
  const attempt = await store.startAdmissionAttempt({
    occurrenceId: run.id,
    owner: 'heartbeat',
    invokeStartedAt: NOW,
    leaseUntil: NOW + 30_000,
  });
  return {
    run: (await store.getRun(run.id))!,
    routine: (await store.getRoutine(routineId))!,
    attempt,
  };
}

async function linkAgentSchedule(
  store: SqliteConfigStore,
  routine: RoutineDefinition,
): Promise<void> {
  const agent = await store.getAgent(config.agentId);
  if (!agent.model) {
    await store.updateAgent(config.agentId, { model: config.model }, agent.revision);
  }
  await store.putChannel({
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    label: 'routine-reliability-lab',
    lifecycle: 'active',
  });
  await store.putAgentChannelGrant({
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    agentId: config.agentId,
    status: 'active',
    createdByMembershipId: 'membership_routine_owner',
    channelLabel: 'routine-reliability-lab',
    channelIsPrivate: false,
  });
  await store.putAgentScheduleReference({
    scheduleId: routine.id,
    agentId: config.agentId,
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    createdByMembershipId: 'membership_routine_owner',
    runsAsMembershipId: 'membership_routine_owner',
    authorityReceiptId: 'receipt_routine_reliability',
    requiredConnectionAccountIds: [],
    state: 'active',
  });
}

function dependencies(events: string[] = []) {
  return {
    now: () => NOW + 1,
    usageRecordingEnabled: false,
    resolveCredential: async () => null,
    resolveAccess: async (_run: RoutineRun, routine: RoutineDefinition) => {
      events.push('live-access');
      return {
        config: { ...config, workspaceId: routine.workspaceId, channelId: routine.channelId },
        accessHash: 'a'.repeat(64),
        botToken: 'xoxb-test',
        botUserId: 'UBOT',
      };
    },
    resolveModel: async () => {
      events.push('model');
      return { model: config.model };
    },
    useCloudflareSandbox: async () => false,
    preparePrompt: async (run: RoutineRun, routine: RoutineDefinition) => ({
      prompt: `Execute ${run.id}`,
      turn: {
        workspaceId: routine.workspaceId,
        channelId: routine.channelId,
        eventId: run.id,
        text: run.revision!.taskText,
        userId: routine.creatorUserId,
        messageTs: '1785100000.000100',
        threadTs: '1785100000.000100',
        source: 'app_mention' as const,
        contextMode: 'channel_history' as const,
      },
      memoryEpoch: 1,
      validateMemoryLease: async () => true,
      confirmMemory: async () => undefined,
    }),
  };
}

function fakeHandle(input: {
  events?: string[];
  dispatches?: unknown[];
  reply?: AgentReply;
  dispatchError?: unknown;
  readError?: unknown;
}): AgentInstanceHandle {
  const receipt: DispatchReceipt = {
    submissionId: 'submission_test',
    acceptedAt: new Date(NOW).toISOString(),
    uid: 'uid_test',
  };
  return {
    id: 'routineagent_test',
    async dispatch(request) {
      input.events?.push('dispatch');
      input.dispatches?.push(request);
      if (input.dispatchError) throw input.dispatchError;
      return receipt;
    },
    async read() {
      input.events?.push('read');
      if (input.readError) throw input.readError;
      return input.reply ?? {
        submissionId: receipt.submissionId,
        uid: receipt.uid,
        text: '{"outcome":"succeeded"}',
        data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] },
      };
    },
    async abort() {},
  };
}

function successfulReply(): AgentReply {
  return {
    submissionId: 'submission_test',
    uid: 'uid_test',
    text: 'Routine result',
    data: {
      [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'succeeded', message: 'Routine result' }],
    },
  };
}

function telemetrySink() {
  const info: string[] = [];
  const errors: string[] = [];
  return {
    info,
    errors,
    sink: {
      info: (message: Record<string, unknown>) => info.push(JSON.stringify(message)),
      error: (message: Record<string, unknown>) => errors.push(JSON.stringify(message)),
    },
  };
}

test('routine settlement persists measured cached tokens in the occurrence row', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'cached_usage');
    const reply = { ...successfulReply(),
      data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] },
      metadata: { chickpea: { schemaVersion: 1, requestedModel: 'openai/gpt-5.6-terra',
        usage: { input: 3, output: 45, cacheRead: 4482, cacheWrite: 10, totalTokens: 4540 } } },
    };
    await executeRoutineOccurrence({ env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
      { ...dependencies([]), handle: fakeHandle({ reply }) });
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.equal(completed?.inputTokens, 3);
    assert.equal(completed?.outputTokens, 45);
    assert.equal(completed?.cacheReadTokens, 4482);
    assert.equal(completed?.cacheWriteTokens, 10);
  } finally { store.close(); }
});

test('live access and a frozen app checkpoint precede Flue dispatch', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const events: string[] = [];
  const productEvents: unknown[] = [];
  const dispatches: unknown[] = [];
  try {
    const fixture = await admittedFixture(store, 'order');
    await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(events),
      handle: fakeHandle({ events, dispatches }),
      productTelemetry: { capture: (event: ProductTelemetryEventInput) => productEvents.push(event) },
    });

    assert.deepEqual(events, ['live-access', 'model', 'dispatch', 'read']);
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.deepEqual(productEvents, [{
      event: 'run_completed',
      workspaceId: 'T_TEST',
      agentId: 'agent_default',
      triggerKind: 'scheduled',
      outcome: 'no_op',
    }]);
    assert.equal(completed?.flueRunId, null);
    assert.equal(completed?.flueAgentEnvelope?.idempotencyKey, fixture.attempt.attemptId);
    const dispatched = dispatches[0] as {
      idempotencyKey: string;
      message: unknown;
    };
    assert.equal(dispatched.idempotencyKey, fixture.attempt.attemptId);
    assert.deepEqual(dispatched.message, {
      kind: 'signal',
      type: 'schedule',
      body: `Execute ${fixture.run.id}`,
      attributes: {
        routineId: fixture.routine.id,
        occurrenceId: fixture.run.id,
        workspaceId: 'T_TEST',
        conversationId: 'C_TEST',
        destinationKind: 'channel',
        ownerAgentId: 'agent_default',
        ownerMembershipId: 'legacy_membership',
        threadTs: '',
        triggerSource: 'schedule',
        scheduledFor: String(NOW),
      },
    });
    assert.equal(completed?.flueAgentEnvelope?.schemaVersion, 2);
    const executionInstructions = parseRoutineExecutionInitialData(completed?.flueAgentEnvelope?.initialData).runtimePlan.instructions;
    assert.match(executionInstructions, /saved occurrence is due now/);
    assert.match(executionInstructions, /not an acknowledgement that it has been scheduled/);
    assert.deepEqual(
      parseRoutineExecutionInitialData(completed?.flueAgentEnvelope?.initialData)
        .connectorUsageCorrelation,
      { operationId: fixture.run.id },
    );
    assert.equal(
      (await store.listAdmissions(fixture.run.id))[0]?.flueAgentReceipt?.submissionId,
      'submission_test',
    );
  } finally {
    store.close();
  }
});

test('an interrupted local read stays resumable and the next execution reads the saved receipt', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const preparedSandboxKeys: string[] = [];
  const releasedSandboxKeys: string[] = [];
  const sandboxDependencies = {
    ...dependencies(),
    sandboxInstalled: () => true,
    useCloudflareSandbox: async () => true,
    prepareSandbox: async (_env: unknown, conversationKey: string) => {
      preparedSandboxKeys.push(conversationKey);
    },
    releaseSandbox: async (_env: unknown, conversationKey: string) => {
      releasedSandboxKeys.push(conversationKey);
    },
  };
  try {
    const fixture = await admittedFixture(store, 'resume');
    const interrupted = new DOMException('local reader stopped', 'AbortError');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: fakeHandle({ readError: interrupted }) });
    assert.equal(first, 'resumable');
    assert.equal((await store.getRun(fixture.run.id))?.status, 'running');
    assert.equal(preparedSandboxKeys.length, 1);
    assert.deepEqual(releasedSandboxKeys, []);

    let dispatches = 0;
    const resumed = fakeHandle({});
    resumed.dispatch = async () => { dispatches += 1; throw new Error('must not redispatch'); };
    const second = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: resumed });
    assert.equal(second, 'completed');
    assert.equal(dispatches, 0);
    assert.equal(preparedSandboxKeys[0], preparedSandboxKeys[1]);
    assert.deepEqual(releasedSandboxKeys, [preparedSandboxKeys[0]]);
    assert.equal((await store.getRun(fixture.run.id))?.status, 'no_op');
  } finally {
    store.close();
  }
});

test('an unresolved initial assignment records a skip without model or Agent side effects', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const events: string[] = [];
  try {
    const fixture = await admittedFixture(store, 'assignment_missing');
    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(events),
      resolveAccess: async () => {
        events.push('live-access');
        throw new RoutineRuntimeError(
          'assignment_missing',
          'This Channel does not have an active Chickpea Agent.',
        );
      },
      resolveModel: async () => {
        events.push('model');
        return { model: config.model };
      },
      preparePrompt: async () => {
        events.push('prompt');
        throw new Error('must not prepare a prompt without an assignment');
      },
      handle: fakeHandle({ events }),
    });

    assert.equal(outcome, 'completed');
    assert.deepEqual(events, ['live-access']);
    const skipped = await store.getRun(fixture.run.id);
    assert.equal(skipped?.status, 'skipped');
    assert.equal(skipped?.skipReason, 'unresolved_assignment');
    assert.equal(skipped?.failureClass, 'assignment_missing');
    assert.equal(skipped?.flueAgentEnvelope, null);
  } finally {
    store.close();
  }
});

test('a direct schedule with permanently missing Agent authority fails and auto-disables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-direct-authority-loss-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => NOW);
  const configStore = new SqliteConfigStore(path, { agents: [] });
  const destination = {
    kind: 'direct_thread' as const,
    conversationId: 'D_DIRECT',
    threadTs: '1787853827.722389',
    ownerMembershipId: 'membership_direct',
  };
  try {
    await configStore.createAgent({
      id: 'agent_direct', name: 'Direct', instructions: 'Run private work.', enabled: true,
      lifecycle: 'active', creatorMembershipId: destination.ownerMembershipId,
      editPolicy: 'creator_and_admins', model: config.model,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const routine = await store.save({
      actorId: 'U_DIRECT', actorClass: 'member', workspaceId: 'T_TEST',
      channelId: destination.conversationId, destination,
      draft: {
        action: 'create', routineId: 'routine_direct_assignment_missing',
        definition: {
          name: 'Direct fixture', description: '', taskText: 'Inspect current state.',
          triggerKind: 'schedule', scheduleInput: '0 * * * *',
          scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
          timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_direct_member_v1',
        },
        nextRunAt: NOW, projectedDailyStarts: 1,
        reservations: [{ windowStart: NOW, count: 1 }],
      },
      idempotencyKey: 'create:direct-assignment-missing', sourceVisibility: 'private',
    });
    const digest = routineDestinationBindingDigest(routine.id, routine.workspaceId, destination);
    const reference = await configStore.putAgentScheduleReference({
      scheduleId: routine.id, agentId: 'agent_direct', workspaceId: routine.workspaceId,
      channelId: destination.conversationId, destinationKind: 'direct_thread',
      destinationBindingDigest: digest, createdByMembershipId: destination.ownerMembershipId,
      runsAsMembershipId: destination.ownerMembershipId,
      authorityReceiptId: 'receipt_direct', requiredConnectionAccountIds: [], state: 'active',
    });
    await store.activateDirectRoutine({
      routineId: routine.id, expectedVersion: routine.version,
      expectedReferenceRevision: reference.revision, destinationBindingDigest: digest,
    });
    const run = await store.createOccurrence({
      runId: 'rrun_direct_assignment_missing', idempotencyKey: 'run:direct-assignment-missing',
      routineId: routine.id, routineVersion: routine.version, scheduledFor: NOW,
      triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
    });
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
    });

    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: run.id, attempt: attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess: async () => {
        throw new RoutineRuntimeError('assignment_missing', 'The direct Agent is unavailable.');
      },
    });

    assert.equal(outcome, 'completed');
    assert.equal((await store.getRun(run.id))?.status, 'failed');
    const disabled = await store.getRoutine(routine.id);
    assert.equal(disabled?.state, 'disabled');
    assert.equal(disabled?.disabledReason, 'assignment_missing');
  } finally {
    configStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a definitive private-thread rejection pauses recurring work and posts one root notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-direct-thread-recovery-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => NOW);
  const configStore = new SqliteConfigStore(path, { agents: [] });
  const destination = {
    kind: 'direct_thread' as const,
    conversationId: 'D_DIRECT',
    threadTs: '1787853827.722389',
    ownerMembershipId: 'membership_direct',
  };
  const slackRequests: Array<Record<string, unknown>> = [];
  const productEvents: unknown[] = [];
  try {
    await configStore.createAgent({
      id: 'agent_direct', name: 'Direct Agent', instructions: 'Run private work.', enabled: true,
      lifecycle: 'active', creatorMembershipId: destination.ownerMembershipId,
      editPolicy: 'creator_and_admins', model: config.model,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const pending = await store.save({
      actorId: 'U_DIRECT', actorClass: 'member', workspaceId: 'T_TEST',
      channelId: destination.conversationId, destination,
      draft: {
        action: 'create', routineId: 'routine_direct_thread_recovery',
        definition: {
          name: 'Direct recurring fixture', description: '', taskText: 'Inspect current state.',
          triggerKind: 'schedule', scheduleInput: '0 * * * *',
          scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
          timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_direct_member_v1',
        },
        nextRunAt: NOW, projectedDailyStarts: 1,
        reservations: [{ windowStart: NOW, count: 1 }],
      },
      idempotencyKey: 'create:direct-thread-recovery', sourceVisibility: 'private',
    });
    const digest = routineDestinationBindingDigest(pending.id, pending.workspaceId, destination);
    const reference = await configStore.putAgentScheduleReference({
      scheduleId: pending.id, agentId: 'agent_direct', workspaceId: pending.workspaceId,
      channelId: destination.conversationId, destinationKind: 'direct_thread',
      destinationBindingDigest: digest, createdByMembershipId: destination.ownerMembershipId,
      runsAsMembershipId: destination.ownerMembershipId,
      authorityReceiptId: 'receipt_direct', requiredConnectionAccountIds: [], state: 'active',
    });
    const routine = await store.activateDirectRoutine({
      routineId: pending.id, expectedVersion: pending.version,
      expectedReferenceRevision: reference.revision, destinationBindingDigest: digest,
    });
    const run = await store.createOccurrence({
      runId: 'rrun_direct_thread_recovery', idempotencyKey: 'run:direct-thread-recovery',
      routineId: routine.id, routineVersion: routine.version, scheduledFor: NOW,
      triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
    });
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
    });
    const client = {
      conversations: {
        open: async (input: Record<string, unknown>) => {
          slackRequests.push({ method: 'open', ...input });
          return { ok: true, channel: { id: destination.conversationId, is_im: true } };
        },
      },
      chat: {
        postMessage: async (input: Record<string, unknown>) => {
          slackRequests.push({ method: 'post', ...input });
          if ('thread_ts' in input) throw { data: { error: 'cannot_reply_to_message' } };
          return { ok: true, channel: destination.conversationId, ts: '1787853828.000100' };
        },
      },
    };

    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: run.id, attempt: attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess: async () => ({
        config: {
          ...config,
          channelId: destination.conversationId,
          agentId: 'agent_direct',
          agent: { ...config.agent, id: 'agent_direct', name: 'Direct Agent' },
        },
        accessHash: 'a'.repeat(64),
        botToken: 'xoxb-test',
        botUserId: 'UBOT',
        actorSlackUserId: 'U_DIRECT',
        actorMembershipId: destination.ownerMembershipId,
        authorityReceiptId: 'receipt_direct',
        client: client as never,
      }),
      handle: fakeHandle({ reply: successfulReply() }),
      productTelemetry: { capture: (event: ProductTelemetryEventInput) => productEvents.push(event) },
    });

    assert.equal(outcome, 'completed');
    const failed = await store.getRun(run.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureClass, 'direct_thread_unavailable');
    assert.equal((await store.getRoutine(routine.id))?.state, 'paused');
    assert.equal((await store.getRoutine(routine.id))?.pausedReason, 'direct_thread_unavailable');
    assert.equal((await store.getRecoveryDelivery(run.id))?.status, 'accepted');
    assert.equal(slackRequests.length, 3);
    assert.equal(slackRequests[0]?.thread_ts, destination.threadTs);
    assert.deepEqual(slackRequests[1], { method: 'open', users: 'U_DIRECT' });
    assert.equal(slackRequests[2]?.thread_ts, undefined);
    assert.equal(slackRequests[2]?.username, 'Chickpea');
    assert.deepEqual(productEvents, [{
      event: 'run_completed',
      workspaceId: 'T_TEST',
      agentId: 'agent_direct',
      triggerKind: 'scheduled',
      outcome: 'failed',
    }]);
  } finally {
    configStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reattachment never combines a frozen Agent A envelope with current Agent B access', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'reattach_agent_fence');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      handle: fakeHandle({ readError: new DOMException('reader stopped', 'AbortError') }),
    });
    assert.equal(first, 'resumable');
    const frozen = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;
    assert.equal(
      parseRoutineExecutionInitialData(frozen?.initialData).runtimePlan.agentId,
      'agent_default',
    );

    const events: string[] = [];
    const second = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(events),
      resolveAccess: async (_run, routine) => {
        events.push('live-access-b');
        return {
          config: {
            ...config,
            workspaceId: routine.workspaceId,
            channelId: routine.channelId,
            agentId: 'agent_b',
            agent: { ...config.agent, id: 'agent_b', name: 'Agent B' },
          },
          accessHash: 'b'.repeat(64),
          botToken: 'xoxb-test',
          botUserId: 'UBOT',
        };
      },
      resolveModel: async () => {
        events.push('model-b');
        return { model: config.model };
      },
      preparePrompt: async () => {
        events.push('prompt-b');
        throw new Error('must not prepare Agent B context for Agent A reattachment');
      },
      handle: fakeHandle({ events }),
    });

    assert.equal(second, 'completed');
    assert.deepEqual(events, ['live-access-b']);
    const failed = await store.getRun(fixture.run.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureClass, 'access_denied');
    assert.equal(failed?.resolvedAgentId, 'agent_default');
    assert.deepEqual(failed?.flueAgentEnvelope, frozen);
  } finally {
    store.close();
  }
});

test('an ambiguous dispatch keeps its sandbox until the frozen request settles', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const events: string[] = [];
  const preparedSandboxKeys: string[] = [];
  const releasedSandboxKeys: string[] = [];
  let sandboxSelectionCalls = 0;
  let releases = 0;
  const sandboxDependencies = {
    ...dependencies(events),
    sandboxInstalled: () => true,
    useCloudflareSandbox: async () => {
      sandboxSelectionCalls += 1;
      return sandboxSelectionCalls === 1;
    },
    prepareSandbox: async (_env: unknown, conversationKey: string) => {
      preparedSandboxKeys.push(conversationKey);
      events.push('sandbox:prepare');
    },
    releaseSandbox: async (_env: unknown, conversationKey: string) => {
      releasedSandboxKeys.push(conversationKey);
      releases += 1;
      events.push('sandbox:release');
    },
  };
  try {
    const fixture = await admittedFixture(store, 'dispatch_retry');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...sandboxDependencies,
      handle: fakeHandle({ events, dispatchError: new Error('connection ended after dispatch') }),
    });
    assert.equal(first, 'resumable');
    assert.equal(releases, 0);
    const frozen = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;

    const second = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: fakeHandle({ events }) });
    assert.equal(second, 'completed');
    assert.equal(sandboxSelectionCalls, 1);
    assert.equal(releases, 1);
    assert.equal(preparedSandboxKeys[0], preparedSandboxKeys[1]);
    assert.match(
      preparedSandboxKeys[0] ?? '',
      /^sandbox_[a-f0-9]{40}$/,
    );
    assert.deepEqual(releasedSandboxKeys, [preparedSandboxKeys[0]]);
    assert.deepEqual((await store.getRun(fixture.run.id))?.flueAgentEnvelope, frozen);
    assert.equal(
      (await store.listAdmissions(fixture.run.id))[0]?.flueAgentReceipt?.submissionId,
      'submission_test',
    );
  } finally {
    store.close();
  }
});

test('concurrent routine occurrences isolate sandbox preparation and release by frozen owner', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const prepared: Array<{ conversationKey: string; turnId: string }> = [];
  const released: string[] = [];
  const { promise: holdFirstRead, resolve: releaseFirstRead } = Promise.withResolvers<void>();
  const { promise: firstReadStarted, resolve: markFirstReadStarted } = Promise.withResolvers<void>();
  let firstExecution: Promise<Awaited<ReturnType<typeof executeRoutineOccurrence>>> | undefined;
  const sandboxDependencies = {
    ...dependencies(),
    sandboxInstalled: () => true,
    useCloudflareSandbox: async () => true,
    prepareSandbox: async (_env: unknown, conversationKey: string, turnId: string) => {
      prepared.push({ conversationKey, turnId });
    },
    releaseSandbox: async (_env: unknown, conversationKey: string) => {
      released.push(conversationKey);
    },
  };
  try {
    const firstFixture = await admittedFixture(store, 'sandbox_owner_first');
    const secondFixture = await admittedFixture(store, 'sandbox_owner_second');
    const firstHandle = fakeHandle({});
    const originalFirstRead = firstHandle.read.bind(firstHandle);
    firstHandle.read = async (...args) => {
      markFirstReadStarted();
      await holdFirstRead;
      return originalFirstRead(...args);
    };

    firstExecution = executeRoutineOccurrence({
      env: {}, store, occurrenceId: firstFixture.run.id, attempt: firstFixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: firstHandle });
    await firstReadStarted;

    const secondOutcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: secondFixture.run.id, attempt: secondFixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: fakeHandle({}) });
    assert.equal(secondOutcome, 'completed');
    assert.equal(prepared.length, 2);
    assert.notEqual(prepared[0]?.conversationKey, prepared[1]?.conversationKey);
    assert.deepEqual(released, [prepared[1]?.conversationKey]);

    releaseFirstRead();
    assert.equal(await firstExecution, 'completed');
    assert.deepEqual(released, [
      prepared[1]?.conversationKey,
      prepared[0]?.conversationKey,
    ]);
  } finally {
    releaseFirstRead();
    await firstExecution?.catch(() => undefined);
    store.close();
  }
});

test('a sandbox preparation failure terminalizes the already-started occurrence and cleans up', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  let releases = 0;
  try {
    const fixture = await admittedFixture(store, 'sandbox_failure');
    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => true,
      useCloudflareSandbox: async () => true,
      prepareSandbox: async () => { throw new Error('sandbox unavailable'); },
      releaseSandbox: async () => { releases += 1; },
      handle: fakeHandle({}),
    });

    assert.equal(outcome, 'completed');
    assert.equal(releases, 1);
    assert.equal((await store.getRun(fixture.run.id))?.status, 'failed');
  } finally {
    store.close();
  }
});

test('an admitted routine with a pre-dispatch cloud plan narrows when the binding disappeared', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  let preparations = 0;
  try {
    const fixture = await admittedFixture(store, 'binding_removed');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => false,
      useCloudflareSandbox: async () => true,
      prepareSandbox: async () => { preparations += 1; },
      handle: fakeHandle({}),
    });

    assert.equal(first, 'completed');
    assert.equal(preparations, 0);
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.equal(
      parseRoutineExecutionInitialData(completed?.flueAgentEnvelope?.initialData).runtimePlan
        .sandbox.mode,
      'bash',
    );
  } finally {
    store.close();
  }
});

test('a persisted cloud plan narrows when the binding disappears before resume', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const preparations: string[] = [];
  try {
    const fixture = await admittedFixture(store, 'persisted_binding_removed');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => true,
      useCloudflareSandbox: async () => true,
      prepareSandbox: async (_env: unknown, key: string) => { preparations.push(key); },
      handle: fakeHandle({ dispatchError: new Error('dispatch interrupted') }),
    });
    assert.equal(first, 'resumable');
    const persisted = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;
    assert.equal(
      parseRoutineExecutionInitialData(persisted?.initialData).runtimePlan.sandbox.mode,
      'cloudflare',
    );

    const resumed = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => false,
      useCloudflareSandbox: async () => { throw new Error('must preserve stored plan'); },
      prepareSandbox: async () => { throw new Error('must not prepare missing binding'); },
      handle: fakeHandle({}),
    });

    assert.equal(resumed, 'completed');
    assert.equal(preparations.length, 1);
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.deepEqual(completed?.flueAgentEnvelope, persisted);
  } finally {
    store.close();
  }
});

test('missing, multiple, and free-form JSON results fail as result_invalid without delivery', async () => {
  for (const [suffix, data] of [
    ['missing', {}],
    ['multiple', { [ROUTINE_RESULT_DATA_NAME]: [
      { outcome: 'no_op', message: '' },
      { outcome: 'no_op', message: '' },
    ] }],
  ] as Array<[string, Record<string, unknown[]>]>) {
    const store = new SqliteRoutineStore(':memory:', () => NOW);
    try {
      const fixture = await admittedFixture(store, suffix);
      await executeRoutineOccurrence({
        env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
      }, {
        ...dependencies(),
        handle: fakeHandle({
          reply: {
            submissionId: 'submission_test',
            text: '{"outcome":"succeeded","message":"ignore me"}',
            data,
          },
        }),
      });
      const failed = await store.getRun(fixture.run.id);
      assert.equal(failed?.status, 'failed');
      assert.equal(failed?.failureClass, 'result_invalid');
      assert.notEqual(failed?.deliveryStatus, 'delivered');
    } finally {
      store.close();
    }
  }
});

test('the occurrence attempt id is stable, opaque, and unique per attempt', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'identity');
    assert.match(fixture.attempt.attemptId, /^routineattempt_/);
    assert.equal(
      fixture.attempt.attemptId,
      (await store.listAdmissions(fixture.run.id))[0]?.attemptId,
    );
    assert.notEqual(hashRoutineValue(fixture.run.id), fixture.attempt.attemptId);
  } finally {
    store.close();
  }
});

test('routine Usage repairs failed admission and terminal persistence before completion', async () => {
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  let admissionCalls = 0;
  let terminalCalls = 0;
  const repairingUsage = new Proxy(usage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      if (property === 'admitOperation') {
        return async (...args: unknown[]) => {
          if (++admissionCalls === 1) throw new Error('temporary admission outage');
          return bound(...args);
        };
      }
      if (property === 'recordTerminal') {
        return async (...args: unknown[]) => {
          if (++terminalCalls === 1) throw new Error('temporary terminal outage');
          return bound(...args);
        };
      }
      return bound;
    },
  }) as UsageStore;
  const telemetry = telemetrySink();
  try {
    const fixture = await admittedFixture(routines, 'usage_repair');
    assert.equal(await executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      usageRecordingEnabled: true,
      usageStore: repairingUsage,
      persistenceTelemetrySink: telemetry.sink,
      handle: fakeHandle({}),
    }), 'completed');

    assert.equal((await usage.getOperation(fixture.run.id))?.operation.status, 'completed');
    assert.equal(admissionCalls, 2);
    assert.equal(terminalCalls, 2);
    assert.equal(telemetry.info.length, 1);
    assert.equal(telemetry.errors.length, 0);
    assert.match(telemetry.info[0]!, /"phase":"repair","outcome":"repaired"/);
  } finally {
    usage.close();
    routines.close();
  }
});

test('routine deadline bounds a stalled durable Usage owner before dispatch', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  const telemetry = telemetrySink();
  const events: string[] = [];
  const deadlineAt = Date.now() + 50;
  let enteredUsage!: () => void;
  const usageEntered = new Promise<void>((resolve) => { enteredUsage = resolve; });
  const stalledUsage = {
    admitOperation: async () => {
      enteredUsage();
      return new Promise<never>(() => undefined);
    },
  } as unknown as UsageStore;
  try {
    const fixture = await admittedFixture(
      routines,
      'usage_deadline',
      undefined,
      undefined,
      deadlineAt,
    );
    const startedAt = Date.now();
    const execution = executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      now: Date.now,
      usageRecordingEnabled: true,
      usageStore: stalledUsage,
      persistenceTelemetrySink: telemetry.sink,
      handle: fakeHandle({ events }),
    });
    await usageEntered;
    t.mock.timers.tick(50);
    assert.equal(await execution, 'completed');

    assert.equal(Date.now() - startedAt, 50);
    assert.equal(events.filter((event) => event === 'dispatch').length, 0);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"usage":"unrepaired"/);
    assert.doesNotMatch(telemetry.errors[0]!, /usage_deadline|C_TEST/);
  } finally {
    routines.close();
  }
});

test('routine Usage and Work settle with the same canonical execution correlation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-correlation-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  const work = new SqliteWorkStore(path, { now: () => NOW });
  const telemetry = telemetrySink();
  try {
    const fixture = await admittedFixture(
      routines,
      'correlation',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
    );
    assert.ok(fixture.run.canonicalRunId);
    await executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      usageRecordingEnabled: true,
      usageStore: usage,
      workStore: work,
      persistenceTelemetrySink: telemetry.sink,
      handle: fakeHandle({}),
    });

    const operation = await usage.getOperation(fixture.run.id);
    const executionId = operation?.measurements[0]?.runExecutionId;
    assert.equal(operation?.operation.runId, fixture.run.canonicalRunId);
    assert.ok(executionId);
    assert.equal(
      (await work.getRunExecution(executionId as RunExecutionId))?.runId,
      fixture.run.canonicalRunId,
    );
    assert.match(telemetry.info[0]!, /"usage":"recorded","work":"recorded"/);
    assert.deepEqual(telemetry.errors, []);
  } finally {
    work.close();
    usage.close();
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('permanent Work initialization failure is one gap and never redispatches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-work-gap-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const telemetry = telemetrySink();
  const events: string[] = [];
  try {
    const fixture = await admittedFixture(
      routines,
      'work_gap',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
    );
    const failedWork = {
      getRun: async () => { throw new Error('work state owner unavailable'); },
    } as unknown as WorkStore;
    const executionInput = {
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    };
    assert.equal(await executeRoutineOccurrence(executionInput, {
      ...dependencies(), usageRecordingEnabled: false, workStore: failedWork,
      persistenceTelemetrySink: telemetry.sink, handle: fakeHandle({ events }),
    }), 'completed');
    assert.equal(await executeRoutineOccurrence(executionInput, {
      ...dependencies(), usageRecordingEnabled: false, workStore: failedWork,
      persistenceTelemetrySink: telemetry.sink, handle: fakeHandle({ events }),
    }), 'superseded');

    assert.equal(events.filter((event) => event === 'dispatch').length, 1);
    assert.equal(telemetry.info.length, 0);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"phase":"work","outcome":"unrepaired"/);
    assert.doesNotMatch(telemetry.errors[0]!, /work state owner|routine_work_gap|C_TEST/);
  } finally {
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('routine deadline bounds a stalled durable Work owner before dispatch', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-work-deadline-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const telemetry = telemetrySink();
  const events: string[] = [];
  const deadlineAt = Date.now() + 50;
  try {
    const fixture = await admittedFixture(
      routines,
      'work_deadline',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
      deadlineAt,
    );
    let enteredWork!: () => void;
    const workEntered = new Promise<void>((resolve) => { enteredWork = resolve; });
    const stalledWork = {
      getRun: async () => {
        enteredWork();
        return new Promise<never>(() => undefined);
      },
    } as unknown as WorkStore;
    const startedAt = Date.now();
    const execution = executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      now: Date.now,
      usageRecordingEnabled: false,
      workStore: stalledWork,
      persistenceTelemetrySink: telemetry.sink,
      handle: fakeHandle({ events }),
    });
    await workEntered;
    t.mock.timers.tick(50);
    assert.equal(await execution, 'completed');

    assert.equal(Date.now() - startedAt, 50);
    assert.equal(events.filter((event) => event === 'dispatch').length, 0);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"phase":"work","outcome":"unrepaired"/);
    assert.doesNotMatch(telemetry.errors[0]!, /work_deadline|C_TEST/);
  } finally {
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Work terminal failure after Slack delivery cannot post or replay twice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-terminal-gap-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const durableWork = new SqliteWorkStore(path, { now: () => NOW });
  const telemetry = telemetrySink();
  const productEvents: unknown[] = [];
  let posts = 0;
  const client = {
    chat: {
      postMessage: async () => {
        posts += 1;
        return { ok: true, channel: 'C_TEST', ts: '1900000000.000001' };
      },
    },
  };
  const failingTerminalWork = new Proxy(durableWork, {
    get(target, property, receiver) {
      if (property === 'finalizeRunDelivery') {
        return async () => { throw new Error('terminal Work persistence unavailable'); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as WorkStore;
  try {
    const fixture = await admittedFixture(
      routines,
      'terminal_gap',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
    );
    const access = dependencies().resolveAccess;
    const executionInput = {
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    };
    const executionDependencies = {
      ...dependencies(),
      usageRecordingEnabled: false,
      workStore: failingTerminalWork,
      persistenceTelemetrySink: telemetry.sink,
      resolveAccess: async (run: RoutineRun, routine: RoutineDefinition) => ({
        ...(await access(run, routine)),
        client: client as never,
      }),
      handle: fakeHandle({ reply: successfulReply() }),
      productTelemetry: { capture: (event: ProductTelemetryEventInput) => productEvents.push(event) },
    };
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'completed');
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'superseded');

    assert.equal(posts, 1);
    assert.equal((await routines.getRun(fixture.run.id))?.status, 'succeeded');
    assert.equal((await routines.getRun(fixture.run.id))?.deliveryStatus, 'delivered');
    assert.deepEqual(productEvents, [{
      event: 'run_completed',
      workspaceId: 'T_TEST',
      agentId: 'agent_default',
      triggerKind: 'scheduled',
      outcome: 'succeeded',
    }]);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"work":"unrepaired"/);
  } finally {
    durableWork.close();
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('permanent Usage terminal failure after Slack delivery cannot post or replay twice', async () => {
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  const telemetry = telemetrySink();
  let posts = 0;
  const client = {
    chat: {
      postMessage: async () => {
        posts += 1;
        return { ok: true, channel: 'C_TEST', ts: '1900000000.000002' };
      },
    },
  };
  const failingTerminalUsage = new Proxy(usage, {
    get(target, property, receiver) {
      if (property === 'recordTerminal') {
        return async () => { throw new Error('terminal Usage persistence unavailable'); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as UsageStore;
  try {
    const fixture = await admittedFixture(routines, 'usage_terminal_gap');
    const access = dependencies().resolveAccess;
    const executionInput = {
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    };
    const executionDependencies = {
      ...dependencies(),
      usageRecordingEnabled: true,
      usageStore: failingTerminalUsage,
      persistenceTelemetrySink: telemetry.sink,
      resolveAccess: async (run: RoutineRun, routine: RoutineDefinition) => ({
        ...(await access(run, routine)),
        client: client as never,
      }),
      handle: fakeHandle({ reply: successfulReply() }),
    };
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'completed');
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'superseded');

    assert.equal(posts, 1);
    assert.equal((await routines.getRun(fixture.run.id))?.status, 'succeeded');
    assert.equal((await routines.getRun(fixture.run.id))?.deliveryStatus, 'delivered');
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"usage":"unrepaired"/);
    assert.doesNotMatch(
      telemetry.errors[0]!,
      /terminal Usage persistence|usage_terminal_gap|C_TEST/,
    );
  } finally {
    usage.close();
    routines.close();
  }
});
