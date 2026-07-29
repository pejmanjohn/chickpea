import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRoutineAdminApi } from '../../src/admin/routines-api.ts';
import { SqliteSettingsStore } from '../../src/config/settings-store.ts';
import type { EffectiveSlackConfig } from '../../src/config/effective-config.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from '../../src/routines/types.ts';
import { SqliteUsageStore } from '../../src/usage/store.ts';
import { RoutineUsageRecorder } from '../../src/usage/runtime-recorder.ts';
import { initializeRoutineWorkflowRuntime } from '../../src/workflows/routine.ts';

const routine = {
  id: 'routine_usage', workspaceId: 'T_USAGE', channelId: 'C_USAGE', creatorUserId: 'U_OWNER',
  name: 'Usage digest', description: '', taskText: 'Prepare the digest.', triggerKind: 'schedule',
  scheduleInput: '0 * * * *', scheduleJson: '{"version":1,"kind":"cron","expression":"0 * * * *"}',
  timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1', state: 'active',
  version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
  consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
  reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 1, createdBy: 'U_OWNER',
  updatedAt: 1, updatedBy: 'U_OWNER', pausedAt: null, pausedBy: null, pausedReason: null,
  disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
} satisfies RoutineDefinition;

const run = {
  id: 'rrun_usage', idempotencyKey: 'slot', routineId: routine.id, routineVersion: 1,
  scheduledFor: 1, triggerSource: 'schedule', requestedBy: null, status: 'admitting',
  failureClass: null, publicError: null, admissionOwner: 'heartbeat', admissionLeaseUntil: 2,
  flueRunId: 'run_usage', queuedAt: 1_000, admittedAt: 1_100, startedAt: null, finishedAt: null,
  resolvedAccessHash: null, resolvedAgentId: null, model: null, inputTokens: null,
  outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costEstimate: null,
  costUnit: null, deadlineAt: 9_999_999_999_999, sandboxSessionId: null, toolCallCount: 0,
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

const config = {
  workspaceId: routine.workspaceId,
  channelId: routine.channelId,
  channelLabel: 'usage-lab',
  agentId: 'agent_usage',
  agent: {
    id: 'agent_usage', name: 'Usage profile', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-haiku-4-5', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-haiku-4-5',
  provider: 'anthropic',
  instructions: 'Be useful.',
  instructionLayers: [],
} satisfies EffectiveSlackConfig;

test('routine recorder captures success, no-op-style zero usage, failure, and interruption honestly', async () => {
  const usage = new SqliteUsageStore(':memory:');
  try {
    const completed = new RoutineUsageRecorder({
      operationId: 'rrun_completed', executionId: 'exec_routine_completed', startedAt: 1_000,
      workspaceId: routine.workspaceId, channelId: routine.channelId, channelLabel: 'usage-lab',
      profileId: config.agentId, profileLabel: config.agent.name,
      routineId: routine.id, routineLabel: routine.name, requestedModel: config.model,
      credentialRefId: null, credentialVersion: null, store: usage, now: () => 2_000,
    });
    await completed.admit();
    await completed.recordTerminal({
      status: 'completed',
      usage: { input: 200, output: 50, totalTokens: 250 },
      returnedModel: { provider: 'anthropic', id: 'claude-haiku-4-5-20251001' },
    });

    for (const [operationId, status, reason] of [
      ['rrun_no_op', 'completed', 'usage_not_reported'],
      ['rrun_failed', 'failed', 'provider_request_unknown'],
      ['rrun_interrupted', 'interrupted', 'stream_interrupted'],
    ] as const) {
      const recorder = new RoutineUsageRecorder({
        operationId, executionId: `exec_${operationId}`, startedAt: 1_000,
        workspaceId: routine.workspaceId, channelId: routine.channelId,
        profileId: config.agentId, profileLabel: config.agent.name,
        routineId: routine.id, routineLabel: routine.name, requestedModel: config.model,
        credentialRefId: null, credentialVersion: null, store: usage, now: () => 2_000,
      });
      await recorder.admit();
      await recorder.recordTerminal({
        status,
        ...(operationId === 'rrun_no_op'
          ? { usage: { input: 0, output: 0, totalTokens: 0 } }
          : { unknownReason: reason }),
      });
    }

    assert.equal((await usage.getOperation('rrun_completed'))?.measurements[0]?.totalTokens, 250);
    assert.equal(
      (await usage.getOperation('rrun_no_op'))?.measurements[0]?.usageCompleteness,
      'not_reported',
    );
    assert.equal((await usage.getOperation('rrun_failed'))?.operation.status, 'failed');
    assert.equal((await usage.getOperation('rrun_interrupted'))?.operation.status, 'interrupted');
  } finally {
    usage.close();
  }
});

test('routine initialization admits ledger work before constructing the Agent', async () => {
  const usage = new SqliteUsageStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const events: string[] = [];
  const store = {
    beginOccurrence: async () => { events.push('begin'); return 'started'; },
  } as unknown as RoutineStore;
  try {
    await initializeRoutineWorkflowRuntime(
      { flueRunId: 'run_usage', env: {}, store, run, routine },
      {
        usageRecordingEnabled: true,
        usageStore: usage,
        settingsStore: settings,
        now: () => 2_000,
        resolveAccess: async () => {
          events.push('access');
          return { config, accessHash: 'a'.repeat(64), botToken: 'xoxb', botUserId: 'U_BOT' };
        },
        resolveCredential: async () => null,
        useCloudflareSandbox: async () => false,
        createAgent: async () => {
          events.push('agent');
          assert.equal((await usage.getOperation(run.id))?.operation.status, 'admitted');
          return { model: config.model, instructions: config.instructions, tools: [] };
        },
      },
    );
    assert.deepEqual(events, ['access', 'begin', 'agent']);
  } finally {
    settings.close();
    usage.close();
  }
});

test('Scheduled Work detail prefers linked ledger facts and labels historical rows honestly', async () => {
  const usage = new SqliteUsageStore(':memory:');
  try {
    const recorder = new RoutineUsageRecorder({
      operationId: run.id, executionId: 'exec_admin_routine', startedAt: 1_000,
      workspaceId: routine.workspaceId, channelId: routine.channelId,
      profileId: config.agentId, profileLabel: config.agent.name,
      routineId: routine.id, routineLabel: routine.name, requestedModel: config.model,
      credentialRefId: null, credentialVersion: null, store: usage, now: () => 2_000,
    });
    await recorder.admit();
    await recorder.recordTerminal({
      status: 'completed', usage: { input: 10, output: 5, totalTokens: 15 },
    });
    const linked = {
      ...run,
      status: 'succeeded' as const,
      finishedAt: 2_000,
      usageLedgerOperationId: run.id,
      usageProvenance: 'usage_ledger' as const,
      usageCompleteness: 'complete' as const,
    };
    const legacy = { ...linked, id: 'rrun_legacy', usageLedgerOperationId: null, usageProvenance: 'legacy_routine' as const };
    const routines = {
      getRun: async (id: string) => id === linked.id ? linked : id === legacy.id ? legacy : undefined,
    } as unknown as RoutineStore;
    const api = createRoutineAdminApi({ store: () => routines, usage: () => usage });

    const linkedBody = await (await api.request(`/audit/scheduled_work/runs/${linked.id}`)).json() as any;
    assert.equal(linkedBody.run.usage.source, 'usage_ledger');
    assert.equal(linkedBody.run.usage.measurements[0].totalTokens, 15);
    const legacyBody = await (await api.request(`/audit/scheduled_work/runs/${legacy.id}`)).json() as any;
    assert.equal(legacyBody.run.usage.source, 'legacy_routine');
    assert.match(legacyBody.run.usage.limitation, /No provider or credential attribution/);
  } finally {
    usage.close();
  }
});
