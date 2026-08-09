import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentInstanceHandle, AgentReply, DispatchReceipt } from '@flue/runtime';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import {
  executeRoutineOccurrence,
} from '../src/routines/execution.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
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

const NOW = Date.UTC(2026, 6, 27, 12);

const config = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: 'agent_default',
  agent: {
    id: 'agent_default', name: 'Chickpea', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', instructions: 'Be useful.', instructionLayers: [],
} satisfies EffectiveSlackConfig;

async function admittedFixture(store: SqliteRoutineStore, suffix: string) {
  const definition: RoutineDefinitionContent = {
    name: 'Execution fixture', description: '', taskText: 'Inspect current state.',
    triggerKind: 'schedule', scheduleInput: '0 * * * *',
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
  };
  const routineId = `routine_${suffix}`;
  await store.save({
    actorId: 'U_MEMBER', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
    draft: {
      action: 'create', routineId, definition, nextRunAt: NOW,
      projectedDailyStarts: 1, reservations: [{ windowStart: NOW, count: 1 }],
    },
    idempotencyKey: `create:${suffix}`,
  });
  const run = await store.createOccurrence({
    runId: `rrun_${suffix}`,
    idempotencyKey: `run:${suffix}`,
    routineId,
    routineVersion: 1,
    scheduledFor: NOW,
    triggerSource: 'schedule',
    queuedAt: NOW,
    deadlineAt: NOW + 60_000,
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
        botUserId: 'U_BOT',
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
    async dispatch() {
      input.events?.push('dispatch');
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

test('live access and a frozen app checkpoint precede Flue dispatch', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const events: string[] = [];
  try {
    const fixture = await admittedFixture(store, 'order');
    await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...dependencies(events), handle: fakeHandle({ events }) });

    assert.deepEqual(events, ['live-access', 'model', 'dispatch', 'read']);
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.equal(completed?.flueRunId, null);
    assert.equal(completed?.flueAgentEnvelope?.idempotencyKey, fixture.attempt.attemptId);
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
