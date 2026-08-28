import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AgentInstanceHandle } from '@flue/runtime';

import { createRoutineAdminApi } from '../src/admin/routines-api.ts';
import { ROUTINE_RESULT_DATA_NAME } from '../src/agents/routine-execution.ts';
import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { RoutineAdmissionController } from '../src/routines/admission.ts';
import { routineDestinationBindingDigest } from '../src/routines/ids.ts';
import { executeRoutineOccurrence } from '../src/routines/execution.ts';
import { RoutineRuntimeError } from '../src/routines/runtime.ts';
import { normalizeRoutineSchedule } from '../src/routines/schedule.ts';
import { RoutineScheduler } from '../src/routines/scheduler.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineCapability } from '../src/routines/scheduler-adapter.ts';
import { RoutineService } from '../src/routines/service.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from '../src/routines/types.ts';

const enabled: RoutineCapability = {
  target: 'cloudflare', available: true, enabled: true, reason: 'enabled',
};
const config: EffectiveSlackConfig = {
  workspaceId: 'T_ACCEPT', channelId: 'C_ACCEPT', agentId: 'agent_accept',
  agent: {
    id: 'agent_accept', kind: 'user', revision: 1, name: 'Acceptance', instructions: 'Use current channel authority.',
    enabled: true, model: 'anthropic/claude-haiku-4-5', skills: [], mcpServers: [],
    apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-haiku-4-5', provider: 'anthropic',
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
  instructions: 'Use current channel authority.', instructionLayers: [],
};
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

async function seedDirectAcceptanceRoutine(
  statePath: string,
  now: number,
  suffix: string,
): Promise<{
  store: SqliteRoutineStore;
  configStore: SqliteConfigStore;
  routine: RoutineDefinition;
  ownerAgentId: string;
}> {
  const configStore = new SqliteConfigStore(statePath, { agents: [] });
  const store = new SqliteRoutineStore(statePath, () => now);
  const ownerAgentId = `agent_direct_owner_${suffix}`;
  const destination = {
    kind: 'direct_thread' as const,
    conversationId: `D_DIRECT_${suffix}`,
    threadTs: '1787853827.722389',
    ownerMembershipId: `membership_direct_${suffix}`,
  };
  await configStore.createAgent({
    id: ownerAgentId,
    name: 'Direct owner',
    instructions: 'Run private scheduled work.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: destination.ownerMembershipId,
    editPolicy: 'creator_and_admins',
    model: config.model,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const pending = await store.save({
    actorId: `U_DIRECT_${suffix}`,
    actorClass: 'member',
    workspaceId: 'T_ACCEPT',
    channelId: destination.conversationId,
    destination,
    draft: {
      action: 'create',
      routineId: `routine_direct_${suffix}`,
      definition: {
        name: 'Private acceptance routine',
        description: '',
        taskText: 'Check the current private state.',
        triggerKind: 'schedule',
        scheduleInput: '0 * * * *',
        scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
        timezone: 'UTC',
        outputPolicy: 'post',
        authorityMode: 'live_direct_member_v1',
      },
      nextRunAt: now,
      projectedDailyStarts: 1,
      reservations: [{ windowStart: now, count: 1 }],
    },
    idempotencyKey: `acceptance:create:${suffix}`,
    sourceVisibility: 'private',
  });
  const destinationBindingDigest = routineDestinationBindingDigest(
    pending.id,
    pending.workspaceId,
    destination,
  );
  const reference = await configStore.putAgentScheduleReference({
    scheduleId: pending.id,
    agentId: ownerAgentId,
    workspaceId: pending.workspaceId,
    channelId: destination.conversationId,
    destinationKind: 'direct_thread',
    destinationBindingDigest,
    createdByMembershipId: destination.ownerMembershipId,
    runsAsMembershipId: destination.ownerMembershipId,
    authorityReceiptId: `receipt_direct_${suffix}`,
    requiredConnectionAccountIds: [],
    state: 'active',
  });
  const routine = await store.activateDirectRoutine({
    routineId: pending.id,
    expectedVersion: pending.version,
    expectedReferenceRevision: reference.revision,
    destinationBindingDigest,
  });
  return { store, configStore, routine, ownerAgentId };
}

test('scheduled work crosses creation, v2 receipt, restart, reattached read, and Admin once', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-acceptance-'));
  const statePath = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date().setUTCMinutes(59, 0, 0);
  let store = new SqliteRoutineStore(statePath, () => now);
  try {
    const projection = normalizeRoutineSchedule('0 * * * *', 'UTC', now);
    const routine = await new RoutineService(store, { now: () => now }).save({
      action: 'create',
      actorId: 'U_CREATOR',
      workspaceId: 'T_ACCEPT',
      channelId: 'C_ACCEPT',
      definition: {
        name: 'Blocker steward',
        description: 'Inspects unresolved blockers.',
        taskText: 'inspect unresolved blockers and report only when needed.',
        triggerKind: 'schedule',
        scheduleInput: '0 * * * *',
        scheduleJson: projection.scheduleJson,
        timezone: 'UTC',
        outputPolicy: 'post',
        authorityMode: 'live_channel_v1',
      },
      nextRunAt: projection.nextRunAt,
      projectedDailyStarts: projection.projectedDailyStarts,
      reservations: projection.reservations,
    }, 'acceptance:seed');

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

test('a direct schedule keeps its owning Agent when the Slack thread route changes', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-direct-owner-acceptance-'));
  const statePath = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await seedDirectAcceptanceRoutine(statePath, Date.now(), 'stable_owner');
  try {
    const destination = fixture.routine.destination;
    assert.equal(destination.kind, 'direct_thread');
    const firstRoute = await fixture.configStore.putAgentThreadRoute({
      workspaceId: fixture.routine.workspaceId,
      channelId: destination.conversationId,
      threadTs: destination.threadTs,
      agentId: fixture.ownerAgentId,
      agentGeneration: 1,
    });
    await fixture.configStore.createAgent({
      id: 'agent_direct_handoff',
      name: 'Handoff Agent',
      instructions: 'Own the interactive thread only.',
      enabled: true,
      lifecycle: 'active',
      creatorMembershipId: destination.ownerMembershipId,
      editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await fixture.configStore.putAgentThreadRoute({
      workspaceId: firstRoute.workspaceId,
      channelId: firstRoute.channelId,
      threadTs: firstRoute.threadTs,
      agentId: 'agent_direct_handoff',
      agentGeneration: 2,
    }, firstRoute.revision);

    const reference = await fixture.configStore.getAgentScheduleReference(fixture.routine.id);
    assert.equal(reference?.agentId, fixture.ownerAgentId);
    assert.equal(reference?.destinationBindingDigest, routineDestinationBindingDigest(
      fixture.routine.id,
      fixture.routine.workspaceId,
      destination,
    ));
    assert.deepEqual((await fixture.store.getRoutine(fixture.routine.id))?.destination, destination);
  } finally {
    fixture.configStore.close();
    fixture.store.close();
  }
});

test('loss of the originating full-member authority auto-disables private scheduled work', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-direct-member-loss-acceptance-'));
  const statePath = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = Date.now();
  const fixture = await seedDirectAcceptanceRoutine(statePath, now, 'member_loss');
  try {
    const run = await fixture.store.createOccurrence({
      runId: 'rrun_direct_member_loss',
      idempotencyKey: 'acceptance:run:member-loss',
      routineId: fixture.routine.id,
      routineVersion: fixture.routine.version,
      scheduledFor: now,
      triggerSource: 'schedule',
      queuedAt: now,
      deadlineAt: now + 60_000,
    });
    const attempt = await fixture.store.startAdmissionAttempt({
      occurrenceId: run.id,
      owner: 'heartbeat',
      invokeStartedAt: now,
      leaseUntil: now + 30_000,
    });
    const logs: string[] = [];
    const originalConsole = {
      error: console.error,
      warn: console.warn,
      log: console.log,
    };
    console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
    console.warn = (...args: unknown[]) => { logs.push(args.join(' ')); };
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    let outcome: Awaited<ReturnType<typeof executeRoutineOccurrence>>;
    try {
      outcome = await executeRoutineOccurrence({
        env: {}, store: fixture.store, occurrenceId: run.id, attempt: attempt.attempt,
      }, {
        ...executionDependencies(() => now),
        resolveAccess: async () => {
          throw new RoutineRuntimeError(
            'creator_ineligible',
            'The originating member is no longer eligible.',
          );
        },
        handle: handle(),
      });
    } finally {
      console.error = originalConsole.error;
      console.warn = originalConsole.warn;
      console.log = originalConsole.log;
    }

    assert.equal(outcome, 'completed');
    assert.equal((await fixture.store.getRun(run.id))?.failureClass, 'creator_ineligible');
    const disabled = await fixture.store.getRoutine(fixture.routine.id);
    assert.equal(disabled?.state, 'disabled');
    assert.equal(disabled?.disabledReason, 'creator_ineligible');
    assert.doesNotMatch(
      logs.join('\n'),
      /routine_direct_member_loss|D_DIRECT_member_loss|1787853827\.722389|membership_direct_member_loss|Check the current private state/,
    );
  } finally {
    fixture.configStore.close();
    fixture.store.close();
  }
});

const privateDmAcceptanceMatrix = [
  {
    example: 'AE1',
    evidence: [
      ['routine-delivery.test.ts', 'private routine results and failure notices stay in the originating thread without Admin links'],
      ['routine-scheduler.test.ts', 'one-time work claims once, completes after its terminal run, and never repeats'],
    ],
  },
  {
    example: 'AE2',
    evidence: [
      ['management-routines.test.ts', 'private DM routines need no deployment flag and use trusted thread management'],
      ['routine-scheduler.test.ts', 'heartbeat claims oldest due schedules once and aggregates downtime without catch-up'],
    ],
  },
  {
    example: 'AE3',
    evidence: [[
      'management-routines.test.ts',
      'private DM routines need no deployment flag and use trusted thread management',
    ]],
  },
  {
    example: 'AE4',
    evidence: [[
      'routine-acceptance.test.ts',
      'a direct schedule keeps its owning Agent when the Slack thread route changes',
    ]],
  },
  {
    example: 'AE5',
    evidence: [
      ['admin-scheduled-work-routes.test.ts', 'direct schedules expose only anonymous health and are absent from shared detail and mutation surfaces'],
      ['admin-page.test.ts', 'Scheduled Work renders private DM health without private schedule content or identifiers'],
    ],
  },
  {
    example: 'AE6',
    evidence: [[
      'routine-workflow.test.ts',
      'a definitive private-thread rejection pauses recurring work and posts one root notice',
    ]],
  },
  {
    example: 'AE7',
    evidence: [[
      'routine-agent-authority.test.ts',
      'direct schedules bind and resolve a full member without any Channel grant',
    ]],
  },
  {
    example: 'AE8',
    evidence: [[
      'routine-acceptance.test.ts',
      'loss of the originating full-member authority auto-disables private scheduled work',
    ]],
  },
] as const;

test('private DM product acceptance matrix stays linked to executable evidence', () => {
  assert.deepEqual(privateDmAcceptanceMatrix.map(({ example }) => example), [
    'AE1', 'AE2', 'AE3', 'AE4', 'AE5', 'AE6', 'AE7', 'AE8',
  ]);
  const testDirectory = fileURLToPath(new URL('.', import.meta.url));
  for (const row of privateDmAcceptanceMatrix) {
    assert.ok(row.evidence.length > 0, `${row.example} needs automated evidence`);
    for (const [file, title] of row.evidence) {
      const source = readFileSync(join(testDirectory, file), 'utf8');
      assert.ok(
        source.includes(`test('${title}'`),
        `${row.example} evidence is missing: ${file} :: ${title}`,
      );
    }
  }
});
