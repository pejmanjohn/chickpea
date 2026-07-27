import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { RoutineRuntimeError } from '../src/routines/runtime.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from '../src/routines/types.ts';
import {
  initializeRoutineWorkflowRuntime,
  routineAgentInstanceId,
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
    'agent:routine:run_one:T_TEST:C_TEST',
  ]);
  assert.equal(runtime.agentInstanceId, 'routine:run_one:T_TEST:C_TEST');
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
          createAgent: async () => { events.push('agent'); throw new Error('must not run'); },
        },
      ),
    );
    assert.ok(!events.includes('agent'));
    assert.equal(events.includes('begin'), scenario === 'superseded');
  }
});

test('every Flue run receives a fresh Agent identity', () => {
  assert.notEqual(
    routineAgentInstanceId('run_one', routine),
    routineAgentInstanceId('run_two', routine),
  );
});
