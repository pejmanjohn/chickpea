import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { RoutineRuntimeError } from '../src/routines/runtime.ts';
import { OpenAiSubscriptionError } from '../src/openai-subscription/errors.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from '../src/routines/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import {
  failInterruptedRoutineWorkflow,
  initializeRoutineWorkflowRuntime,
  routineAgentInstanceId,
  routineModelLabel,
  routineUsageMetadata,
} from '../src/workflows/routine.ts';

const config = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: 'agent_default',
  agent: {
    id: 'agent_default', name: 'Chickpea', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', instructions: 'Be useful.', instructionLayers: [],
} satisfies EffectiveSlackConfig;

const routine = {
  id: 'routine_test', workspaceId: 'T_TEST', channelId: 'C_TEST', creatorUserId: 'U_CREATOR',
  name: 'Test', description: '', taskText: 'Do the work.', triggerKind: 'schedule',
  scheduleInput: '0 * * * *', scheduleJson: '{"version":1,"kind":"cron","expression":"0 * * * *"}',
  timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1', state: 'active',
  version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
  consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
  reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 1, createdBy: 'U_CREATOR',
  updatedAt: 1, updatedBy: 'U_CREATOR', pausedAt: null, pausedBy: null, pausedReason: null,
  disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
} satisfies RoutineDefinition;

const run = {
  id: 'rrun_test', idempotencyKey: 'slot', routineId: routine.id, routineVersion: 1,
  scheduledFor: 1, triggerSource: 'schedule', requestedBy: null, status: 'admitting',
  failureClass: null, publicError: null, admissionOwner: 'heartbeat', admissionLeaseUntil: 2,
  flueRunId: 'run_flue', queuedAt: 1, admittedAt: 1, startedAt: null, finishedAt: null,
  resolvedAccessHash: null, resolvedAgentId: null, model: null, inputTokens: null,
  providerAuthRoute: null,
  outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costEstimate: null,
  costUnit: null, deadlineAt: 9999999999999, sandboxSessionId: null, toolCallCount: 0,
  deliveryStatus: 'none', deliveryLeaseUntil: null, deliveryChannelId: null,
  deliveryMessageTs: null, changeKeyHash: null, baselineChangeKeyHash: null,
  suppressedAsNoOp: false, skipReason: null, missedSlotCount: 0, firstMissedAt: null,
  lastMissedAt: null, traceId: null,
  revision: {
    name: routine.name, description: routine.description, taskText: routine.taskText,
    triggerKind: 'schedule', scheduleInput: routine.scheduleInput, scheduleJson: routine.scheduleJson,
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
  },
  revisionHash: 'a'.repeat(64),
} satisfies RoutineRun;

function fakeStore(events: string[], begin: 'began' | 'superseded' = 'began'): RoutineStore {
  return {
    beginOccurrence: async () => { events.push('begin'); return begin; },
    getRun: async () => ({ ...run, status: 'running' }),
    transitionRun: async () => { events.push('terminal'); return true; },
  } as unknown as RoutineStore;
}

test('live access and atomic begin precede all Agent and sandbox construction', async () => {
  const events: string[] = [];
  const runtime = await initializeRoutineWorkflowRuntime(
    { flueRunId: 'run_one', env: {}, store: fakeStore(events), run, routine },
    {
      resolveAccess: async () => {
        events.push('live-access');
        return { config, accessHash: 'a'.repeat(64), botToken: 'xoxb-test', botUserId: 'U_BOT' };
      },
      resolveModel: async () => ({ model: config.model }),
      useCloudflareSandbox: async () => { events.push('sandbox-check'); return false; },
      createAgent: async ({ id }) => {
        events.push(`agent:${id}`);
        return { model: config.model, instructions: config.instructions, tools: [] };
      },
    },
  );
  assert.deepEqual(events, [
    'live-access',
    'begin',
    'sandbox-check',
    `agent:${routineAgentInstanceId('run_one')}`,
  ]);
  assert.equal(runtime.agentInstanceId, routineAgentInstanceId('run_one'));
  assert.doesNotMatch(runtime.agentInstanceId, /T_TEST|C_TEST/);
});

test('failed authorization and superseded begin construct no Agent', async () => {
  for (const scenario of ['denied', 'superseded'] as const) {
    const events: string[] = [];
    await assert.rejects(
      () => initializeRoutineWorkflowRuntime(
        {
          flueRunId: `run_${scenario}`,
          env: {},
          store: fakeStore(events, scenario === 'superseded' ? 'superseded' : 'began'),
          run,
          routine,
        },
        {
          resolveAccess: async () => {
            events.push('live-access');
            if (scenario === 'denied') {
              throw new RoutineRuntimeError('access_denied', 'Current access could not be verified.');
            }
            return { config, accessHash: 'a'.repeat(64), botToken: 'xoxb-test', botUserId: 'U_BOT' };
          },
          resolveModel: async () => ({ model: config.model }),
          createAgent: async () => { events.push('agent'); throw new Error('must not run'); },
        },
      ),
    );
    assert.ok(!events.includes('agent'));
    assert.equal(events.includes('begin'), scenario === 'superseded');
  }
});

test('a routine records the selected OpenAI lane before using the isolated runtime model', async () => {
  const openAiConfig: EffectiveSlackConfig = {
    ...config,
    agent: {
      ...config.agent,
      model: 'openai/gpt-5.4',
    },
    model: 'openai/gpt-5.4',
    provider: 'openai',
  };
  const begins: unknown[] = [];
  const store = {
    ...fakeStore([]),
    beginOccurrence: async (input: unknown) => { begins.push(input); return 'started' as const; },
  } as unknown as RoutineStore;
  const runtime = await initializeRoutineWorkflowRuntime(
    { flueRunId: 'run_subscription', env: {}, store, run, routine },
    {
      resolveAccess: async () => ({
        config: openAiConfig,
        accessHash: 'b'.repeat(64),
        botToken: 'xoxb-test',
        botUserId: 'U_BOT',
      }),
      resolveModel: async () => ({
        model: 'openai-subscription/gpt-5.4',
        providerAuthRoute: 'openai_subscription',
      }),
      useCloudflareSandbox: async () => false,
      createAgent: async (input) => {
        assert.deepEqual(input.runtimeModel, {
          model: 'openai-subscription/gpt-5.4',
          providerAuthRoute: 'openai_subscription',
        });
        return { model: input.runtimeModel!.model, instructions: 'test', tools: [] };
      },
    },
  );

  assert.equal(runtime.providerAuthRoute, 'openai_subscription');
  assert.deepEqual(begins, [{
    occurrenceId: run.id,
    flueRunId: 'run_subscription',
    startedAt: (begins[0] as { startedAt: number }).startedAt,
    resolvedAccessHash: 'b'.repeat(64),
    resolvedAgentId: openAiConfig.agentId,
    model: 'openai/gpt-5.4',
    providerAuthRoute: 'openai_subscription',
    traceId: 'run_subscription',
  }]);
});

test('subscription routine usage keeps canonical model identity and does not invent Platform spend', () => {
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 5,
    cacheWrite: 2,
    cost: { total: 0.42 },
  } as Parameters<typeof routineUsageMetadata>[0];

  assert.equal(
    routineModelLabel({ provider: 'openai-subscription', id: 'gpt-5.4' }),
    'openai/gpt-5.4',
  );
  assert.deepEqual(routineUsageMetadata(usage, 'openai_subscription'), {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    costUnit: 'chatgpt_subscription_quota',
  });
  assert.equal(routineUsageMetadata(usage, 'openai_api_key').costEstimate, 0.42);
});

test('a routine subscription credential failure is categorized before Agent construction with no fallback', async () => {
  const transitions: Array<Record<string, unknown>> = [];
  const store = {
    ...fakeStore([]),
    transitionRun: async (input: Record<string, unknown>) => {
      transitions.push(input);
      return { ...run, status: 'failed' as const };
    },
  } as unknown as RoutineStore;
  const openAiConfig: EffectiveSlackConfig = {
    ...config,
    agent: {
      ...config.agent,
      model: 'openai/gpt-5.4',
    },
    model: 'openai/gpt-5.4',
    provider: 'openai',
  };
  let agentConstructions = 0;

  await assert.rejects(
    () => initializeRoutineWorkflowRuntime(
      { flueRunId: 'run_reconnect', env: {}, store, run, routine },
      {
        resolveAccess: async () => ({
          config: openAiConfig,
          accessHash: 'c'.repeat(64),
          botToken: 'xoxb-test',
          botUserId: 'U_BOT',
        }),
        resolveModel: async () => {
          throw new OpenAiSubscriptionError('auth_reconnect_required');
        },
        createAgent: async () => {
          agentConstructions += 1;
          throw new Error('must not construct');
        },
      },
    ),
    /ChatGPT subscription connection needs attention in Settings/,
  );
  assert.equal(agentConstructions, 0);
  assert.equal(transitions[0]?.failureClass, 'credential_unavailable');
  assert.equal(transitions[0]?.publicError,
    'The ChatGPT subscription connection needs attention in Settings. API-key billing was not used.');
});

test('every Flue run receives a fresh Agent identity', () => {
  assert.notEqual(
    routineAgentInstanceId('run_one'),
    routineAgentInstanceId('run_two'),
  );
});

test('cold Workflow context fails persisted state without replaying model or tool work', async () => {
  const transitions: unknown[] = [];
  const releases: unknown[] = [];
  const coldRun = { ...run, status: 'running' as const, toolCallCount: 2 };
  const store = {
    getRun: async () => coldRun,
    getRoutine: async () => routine,
    transitionRun: async (input: unknown) => { transitions.push(input); return coldRun; },
  } as unknown as RoutineStore;

  await failInterruptedRoutineWorkflow(coldRun.id, {
    env: {},
    store,
    now: () => 123,
    releaseSandbox: async (...input) => { releases.push(input); },
  });

  assert.deepEqual(transitions, [{
    occurrenceId: coldRun.id,
    from: ['running'],
    to: 'failed',
    at: 123,
    failureClass: 'workflow_interrupted',
    publicError: 'The routine Workflow was interrupted before execution could resume safely.',
    toolCallCount: 2,
  }]);
  assert.deepEqual(releases, [[{}, routineAgentInstanceId('run_flue'), true]]);
});

test('cold Workflow usage keeps its canonical Run without inventing a RunExecution', async () => {
  const canonicalRunId = 'run_interrupted_routine';
  const coldRun = {
    ...run,
    canonicalRunId,
    status: 'running' as const,
    toolCallCount: 2,
  };
  const routineStore = {
    getRun: async () => coldRun,
    getRoutine: async () => routine,
    transitionRun: async () => coldRun,
  } as unknown as RoutineStore;
  const usageStore = new SqliteUsageStore(':memory:');

  try {
    await failInterruptedRoutineWorkflow(coldRun.id, {
      env: {},
      store: routineStore,
      usageStore,
      usageRecordingEnabled: true,
      now: () => 123,
      releaseSandbox: async () => undefined,
    });

    const detail = await usageStore.getOperation(coldRun.id);
    assert.equal(detail?.operation.runId, canonicalRunId);
    assert.equal(detail?.measurements[0]?.runExecutionId, undefined);
  } finally {
    usageStore.close();
  }
});

test('routine setup failure keeps canonical Run usage without inventing a RunExecution', async () => {
  const usageStore = new SqliteUsageStore(':memory:');
  const canonicalRun = {
    ...run,
    canonicalRunId: 'run_routine_setup_failure',
  };
  try {
    await assert.rejects(
      () => initializeRoutineWorkflowRuntime(
        {
          flueRunId: 'run_setup_failure',
          env: {},
          store: fakeStore([]),
          run: canonicalRun,
          routine,
        },
        {
          usageRecordingEnabled: true,
          usageStore,
          resolveAccess: async () => ({
            config,
            accessHash: 'd'.repeat(64),
            botToken: 'xoxb-test',
            botUserId: 'U_BOT',
          }),
          resolveCredential: async () => null,
          resolveModel: async () => ({ model: config.model }),
          useCloudflareSandbox: async () => false,
          createAgent: async () => { throw new Error('setup failed'); },
        },
      ),
      /could not complete safely/i,
    );
    const detail = await usageStore.getOperation(canonicalRun.id);
    assert.equal(detail?.operation.runId, canonicalRun.canonicalRunId);
    assert.equal(detail?.measurements[0]?.runExecutionId, undefined);
  } finally {
    usageStore.close();
  }
});
