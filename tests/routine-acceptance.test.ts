import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AgentInstanceHandle } from '@flue/runtime';

import { createRoutineAdminApi } from '../src/admin/routines-api.ts';
import { ROUTINE_RESULT_DATA_NAME } from '../src/agents/routine-execution.ts';
import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { RoutineAdmissionController } from '../src/routines/admission.ts';
import { handleRoutineSlackRequest } from '../src/routines/commands.ts';
import { executeRoutineOccurrence } from '../src/routines/execution.ts';
import { RoutineScheduler } from '../src/routines/scheduler.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineCapability } from '../src/routines/scheduler-adapter.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from '../src/routines/types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const enabled: RoutineCapability = {
  target: 'cloudflare', available: true, enabled: true, reason: 'enabled',
};
const config: EffectiveSlackConfig = {
  workspaceId: 'T_ACCEPT', channelId: 'C_ACCEPT', agentId: 'agent_accept',
  agent: {
    id: 'agent_accept', revision: 1, name: 'Acceptance', instructions: 'Use current channel authority.',
    enabled: true, model: 'anthropic/claude-haiku-4-5', skills: [], mcpServers: [],
    apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-haiku-4-5', provider: 'anthropic',
  instructions: 'Use current channel authority.', instructionLayers: [],
};

function turn(text: string, eventId: string): NormalizedSlackTurn {
  return {
    workspaceId: 'T_ACCEPT', channelId: 'C_ACCEPT', userId: 'U_CREATOR', eventId, text,
    messageTs: '1785100000.000100', threadTs: '1785100000.000100',
    source: 'app_mention', contextMode: 'channel_history',
  };
}

function executionDependencies(now: () => number) {
  return {
    now,
    usageRecordingEnabled: false,
    resolveCredential: async () => null,
    resolveAccess: async (_run: RoutineRun, routine: RoutineDefinition) => ({
      config: { ...config, workspaceId: routine.workspaceId, channelId: routine.channelId },
      accessHash: 'a'.repeat(64), botToken: 'xoxb-acceptance', botUserId: 'UBOT',
    }),
    resolveModel: async () => ({ model: config.model }),
    useCloudflareSandbox: async () => false,
    preparePrompt: async (run: RoutineRun, routine: RoutineDefinition) => ({
      prompt: `Execute ${run.id}`,
      turn: {
        workspaceId: routine.workspaceId, channelId: routine.channelId,
        eventId: run.id, text: run.revision!.taskText, userId: routine.creatorUserId,
        messageTs: '1785100060.000100', threadTs: '1785100060.000100',
        source: 'app_mention' as const, contextMode: 'channel_history' as const,
      },
      memoryEpoch: 1,
      validateMemoryLease: async () => true,
      confirmMemory: async () => undefined,
    }),
  };
}

function handle(readError?: unknown): AgentInstanceHandle {
  return {
    id: 'routineagent_acceptance',
    async dispatch() {
      return {
        submissionId: 'submission_acceptance',
        acceptedAt: new Date().toISOString(),
        uid: 'uid_acceptance',
      };
    },
    async read() {
      if (readError) throw readError;
      return {
        submissionId: 'submission_acceptance', uid: 'uid_acceptance', text: 'ignored',
        data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] },
      };
    },
    async abort() {},
  };
}

test('scheduled work crosses creation, v2 receipt, restart, reattached read, and Admin once', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-acceptance-'));
  const statePath = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date().setUTCMinutes(59, 0, 0);
  let store = new SqliteRoutineStore(statePath, () => now);
  try {
    const createdText = await handleRoutineSlackRequest(
      turn('Every hour, inspect unresolved blockers and report only when needed.', 'Ev_ACCEPT_CREATE'),
      undefined,
      {
        store, capability: enabled, now: () => now, canManageChannel: async () => true,
        parseIntent: async () => ({
          action: 'create', name: 'Blocker steward', description: '',
          taskText: 'inspect unresolved blockers and report only when needed.',
          scheduleExpression: '0 * * * *', timezone: 'UTC', timezoneWasDefaulted: false,
          outputPolicy: 'post',
        }),
      },
    );
    assert.match(createdText ?? '', /Routine created/i);
    const [routine] = await store.listRoutines('T_ACCEPT', 'C_ACCEPT');
    assert.ok(routine);

    now += 60_000;
    const interrupted = handle(new DOMException('reader restarted', 'AbortError'));
    const firstScheduler = new RoutineScheduler(
      store,
      new RoutineAdmissionController(store, {
        execute: (run, attempt) => executeRoutineOccurrence({
          env: {}, store, occurrenceId: run.id, attempt: attempt.attempt,
        }, { ...executionDependencies(() => now), handle: interrupted }),
      }),
    );
    const first = await firstScheduler.heartbeat(now, 'heartbeat-first');
    assert.equal(first.admissions.attached, 1);
    assert.equal(first.admissions.deferred, 1);
    const running = (await store.listRuns({ routineId: routine.id }))[0]!;
    assert.equal(running.status, 'running');
    assert.equal(running.flueRunId, null);
    assert.ok(running.flueAgentEnvelope);

    store.close();
    store = new SqliteRoutineStore(statePath, () => now);
    let redispatches = 0;
    const resumed = handle();
    resumed.dispatch = async () => { redispatches += 1; throw new Error('must not redispatch'); };
    const secondScheduler = new RoutineScheduler(
      store,
      new RoutineAdmissionController(store, {
        execute: (run, attempt) => executeRoutineOccurrence({
          env: {}, store, occurrenceId: run.id, attempt: attempt.attempt,
        }, { ...executionDependencies(() => now), handle: resumed }),
      }),
    );
    const second = await secondScheduler.heartbeat(now, 'heartbeat-second');
    assert.equal(second.admissions.reconciled, 1);
    assert.equal(redispatches, 0);

    const completed = (await store.listRuns({ routineId: routine.id }))[0]!;
    assert.equal(completed.status, 'no_op');
    assert.equal((await store.listAdmissions(completed.id)).length, 1);
    const admin = createRoutineAdminApi({
      store: () => store as RoutineStore,
      capability: () => enabled,
    });
    const body = await (await admin.request(`/audit/scheduled_work/routines/${routine.id}`)).json() as {
      runs: Array<{ status: string; flueRunId: string | null }>;
    };
    assert.deepEqual(body.runs.map((run) => [run.status, run.flueRunId]), [['no_op', null]]);
  } finally {
    store.close();
  }
});
