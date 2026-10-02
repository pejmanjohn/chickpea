import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AgentInstanceHandle } from '@flue/runtime';

import { createRoutineAdminApi } from '../src/admin/routines-api.ts';
import { ROUTINE_RESULT_DATA_NAME } from '../src/agents/routine-execution.ts';
import {
  computeSnapshotHash,
  type EffectiveSlackConfig,
} from '../src/config/effective-config.ts';
import {
  configureInstallationAdmission,
  INSTALLATION_ADMISSION_TTL_MS,
  resetInstallationAdmissionForTests,
  type InstallationAdmission,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { ModelCredentialKeyringUnavailableError } from '../src/config/model-credential-refs.ts';
import { closeNodeStateStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { drainRoutinePauseNotices } from '../src/routines/delivery.ts';
import { ROUTINE_LIMITS } from '../src/routines/limits.ts';
import { RoutineAdmissionController } from '../src/routines/admission.ts';
import { hashRoutineValue, routineDestinationBindingDigest } from '../src/routines/ids.ts';
import { executeRoutineOccurrence } from '../src/routines/execution.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
} from '../src/routines/runtime.ts';
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
    codingWorkspaceConfigured: async () => false,
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
  triggerKind: 'schedule' | 'once' = 'schedule',
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
        triggerKind,
        scheduleInput: triggerKind === 'once' ? 'In one minute' : '0 * * * *',
        scheduleJson: triggerKind === 'once'
          ? JSON.stringify({ version: 1, kind: 'once', at: now })
          : JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
        timezone: 'UTC',
        outputPolicy: 'post',
        authorityMode: 'live_direct_member_v1',
      },
      nextRunAt: now,
      projectedDailyStarts: triggerKind === 'once' ? 0 : 1,
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
    boundRoutineVersion: pending.authorityBindingVersion ?? pending.version,
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

test('a private once occurrence reattaches a legacy catalog hash and delivers to its saved thread', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-direct-once-catalog-'));
  const statePath = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = Date.now();
  const fixture = await seedDirectAcceptanceRoutine(statePath, now, 'once_catalog', 'once');
  const destination = fixture.routine.destination;
  assert.equal(destination.kind, 'direct_thread');
  if (destination.kind !== 'direct_thread') throw new Error('expected direct destination');
  const actorSlackUserId = 'U_DIRECT_once_catalog';
  let catalogRevision = '0';
  let legacyAdmittedHash: string | undefined;
  let userChecks = 0;
  let dmChecks = 0;
  let redispatches = 0;
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    users: { info: async () => {
      userChecks += 1;
      return { ok: true, user: {
        id: actorSlackUserId, team_id: fixture.routine.workspaceId,
        deleted: false, is_bot: false, is_app_user: false, is_restricted: false,
        is_ultra_restricted: false, is_stranger: false,
      } };
    } },
    conversations: { open: async () => {
      dmChecks += 1;
      return { ok: true, channel: { id: destination.conversationId, is_im: true } };
    } },
    chat: { postMessage: async (input: Record<string, unknown>) => {
      posts.push(input);
      return { ok: true, channel: destination.conversationId, ts: '1787853828.000200' };
    } },
  };
  const resolveAccess = async (run: RoutineRun, routine: RoutineDefinition) => {
    const reference = await fixture.configStore.getAgentScheduleReference(routine.id);
    const agent = await fixture.configStore.getAgent(fixture.ownerAgentId);
    assert.ok(reference);
    assert.ok(agent);
    const access = await resolveRoutineRuntimeAccess(run, routine, undefined, {
      authority: async () => ({
        reference,
        agent,
        assignment: {
          workspaceId: routine.workspaceId,
          channelId: routine.channelId,
          agentId: agent.id,
          agent,
          model: config.model,
          modelAttribution: {
            source: 'workspace_default', workspaceDefaultRevision: 2,
            providerId: 'anthropic', catalogRevision,
          },
        },
        actorSlackUserId,
        effectiveConnections: [],
      }),
      installationExecution: async () => ({
        workspaceId: routine.workspaceId, transportMode: 'gateway', sharedAppReads: true,
        botUserId: 'UBOT', client: client as never,
      }),
    });
    if (catalogRevision !== '0') return access;
    legacyAdmittedHash = hashRoutineValue(JSON.stringify({
      config: computeSnapshotHash(access.config),
      workspaceId: routine.workspaceId,
      actorSlackUserId,
      actorMembershipId: reference.runsAsMembershipId,
      authorityReceiptId: reference.authorityReceiptId,
      botUserId: 'UBOT',
      destinationKind: routine.destination.kind,
      destinationBindingDigest: reference.destinationBindingDigest,
    }));
    return { ...access, accessHash: legacyAdmittedHash };
  };
  try {
    const run = await fixture.store.createOccurrence({
      runId: 'rrun_direct_once_catalog',
      idempotencyKey: 'acceptance:run:direct-once-catalog',
      routineId: fixture.routine.id,
      routineVersion: fixture.routine.version,
      scheduledFor: now,
      triggerSource: 'once',
      queuedAt: now,
      deadlineAt: now + 60_000,
    });
    const attempt = await fixture.store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat',
      invokeStartedAt: now, leaseUntil: now + 30_000,
    });
    const dependencies = {
      ...executionDependencies(() => now + 1),
      resolveAccess,
      loadCatalog: async () => ({ status: 'bundled' as const, revision: 0 }),
    };
    assert.equal(await executeRoutineOccurrence({
      env: {}, store: fixture.store, occurrenceId: run.id, attempt: attempt.attempt,
    }, {
      ...dependencies,
      handle: handle(new DOMException('reader restarted', 'AbortError')),
    }), 'resumable');
    const admitted = await fixture.store.getRun(run.id);
    assert.equal(admitted?.resolvedAccessHash, legacyAdmittedHash);
    assert.equal(admitted?.status, 'running');

    catalogRevision = '1';
    const resumed = handle();
    resumed.dispatch = async () => {
      redispatches += 1;
      throw new Error('must not redispatch');
    };
    resumed.read = async () => ({
      submissionId: 'submission_acceptance', uid: 'uid_acceptance', text: 'Updated result',
      data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'succeeded', message: 'Updated result' }] },
    });
    assert.equal(await executeRoutineOccurrence({
      env: {}, store: fixture.store, occurrenceId: run.id, attempt: attempt.attempt,
    }, {
      ...dependencies,
      loadCatalog: async () => ({ status: 'activated' as const, revision: 1 }),
      handle: resumed,
    }), 'completed');

    const completed = await fixture.store.getRun(run.id);
    assert.equal(completed?.status, 'succeeded');
    assert.equal(completed?.deliveryStatus, 'delivered');
    assert.equal((await fixture.store.getRoutine(fixture.routine.id))?.state, 'completed');
    assert.equal(redispatches, 0);
    assert.equal(userChecks, 2);
    assert.equal(dmChecks, 2);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.channel, destination.conversationId);
    assert.equal(posts[0]?.thread_ts, destination.threadTs);
  } finally {
    fixture.configStore.close();
    fixture.store.close();
  }
});

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

/** A channel routine due at the top of each hour, saved at minute 59. */
async function hourlyChannelRoutine(store: SqliteRoutineStore, now: () => number, key: string) {
  const projection = normalizeRoutineSchedule('0 * * * *', 'UTC', now());
  return new RoutineService(store, { now }).save({
    action: 'create', actorId: 'U_CREATOR', workspaceId: 'T_ACCEPT', channelId: 'C_ACCEPT',
    definition: {
      name: 'Hourly report', description: 'Reports hourly.', taskText: 'report the hourly state.',
      triggerKind: 'schedule', scheduleInput: '0 * * * *', scheduleJson: projection.scheduleJson,
      timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
    },
    nextRunAt: projection.nextRunAt,
    projectedDailyStarts: projection.projectedDailyStarts,
    reservations: projection.reservations,
  }, key);
}

/** An installation of a deployment serving many, admitted or refused by a registry the test edits. */
function hostedRoutineInstallation(context: import('node:test').TestContext, now: () => number) {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  const registry = { status: 'admitted' as InstallationAdmission, reads: 0 };
  resetInstallationAdmissionForTests({ now });
  configureInstallationAdmission(async () => { registry.reads += 1; return registry.status; });
  context.after(() => {
    resetInstallationAdmissionForTests();
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_routines' });
  return { env, registry };
}

test('a refused installation\'s due slot is skipped before dispatch, and resume skips missed slots instead of replaying them', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-refused-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date().setUTCMinutes(59, 0, 0);
  const store = new SqliteRoutineStore(join(directory, 'state.sqlite'), () => now);
  const { env, registry } = hostedRoutineInstallation(context, () => now);
  try {
    const routine = await hourlyChannelRoutine(store, () => now, 'refused:seed');
    let dispatches = 0;
    const agent = handle();
    agent.dispatch = async () => { dispatches += 1; throw new Error('a refused installation dispatches nothing'); };
    let accessReads = 0;
    const scheduler = () => new RoutineScheduler(store, new RoutineAdmissionController(store, {
      execute: (run, attempt) => executeRoutineOccurrence({
        env, store, occurrenceId: run.id, attempt: attempt.attempt,
      }, {
        ...executionDependencies(() => now),
        resolveAccess: async (run, saved) => { accessReads += 1; return executionDependencies(() => now).resolveAccess(run, saved); },
        handle: agent,
      }),
    }));

    // The operator suspends the installation; a tick that still reaches it (or
    // one started before the suspension) admits the due slot and Core skips it.
    registry.status = 'refused';
    now += 60_000;
    await scheduler().heartbeat(now, 'heartbeat-refused');
    const [refused] = await store.listRuns({ routineId: routine.id });
    assert.equal(refused?.status, 'skipped');
    assert.equal(refused?.skipReason, 'installation_not_admitted');
    assert.equal(refused?.failureClass, 'policy_denied');
    assert.equal(dispatches, 0);
    assert.equal(accessReads, 0, 'nothing about the run was resolved, so nothing could post');

    // Three more hours pass with no tick for the suspended installation. On
    // resume the missed slots are recorded once, skipped, never replayed.
    registry.status = 'admitted';
    now += 3 * 60 * 60_000 + INSTALLATION_ADMISSION_TTL_MS;
    await scheduler().heartbeat(now, 'heartbeat-resumed');
    const runs = await store.listRuns({ routineId: routine.id });
    assert.equal(runs.length, 2);
    const resumed = runs.find((run) => run.id !== refused!.id)!;
    assert.equal(resumed.status, 'skipped');
    assert.equal(resumed.skipReason, 'missed_schedule');
    assert.equal(resumed.missedSlotCount, 3);
    assert.equal(dispatches, 0);
  } finally {
    store.close();
  }
});

/** What a resumed installation would see: its routine's state, failure count and pending notices. */
async function afterResume(store: SqliteRoutineStore, routineId: string, env: Record<string, unknown>) {
  const posts: unknown[] = [];
  await drainRoutinePauseNotices({ store, env }, {
    resolveAccess: async () => ({
      config, accessHash: 'a'.repeat(64), botUserId: 'UBOT',
      client: { chat: { postMessage: async (input: unknown) => { posts.push(input); return { ok: true, ts: '1.2' }; } } } as never,
    }),
  });
  const routine = (await store.getRoutine(routineId))!;
  return {
    state: routine.state, consecutiveFailures: routine.consecutiveFailures,
    pendingNotices: (await store.listPendingRecoveryDeliveries()).length, posts: posts.length,
  };
}

const UNHARMED = { state: 'active', consecutiveFailures: 0, pendingNotices: 0, posts: 0 };

test('a result that settles while its installation is refused is skipped: nothing posted, paused or counted, and nothing on resume', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-refused-result-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date().setUTCMinutes(59, 0, 0);
  const store = new SqliteRoutineStore(join(directory, 'state.sqlite'), () => now);
  const { env, registry } = hostedRoutineInstallation(context, () => now);
  try {
    const routine = await hourlyChannelRoutine(store, () => now, 'refused-result:seed');
    const posts: unknown[] = [];
    const client = { chat: { postMessage: async (input: unknown) => {
      posts.push(input);
      return { ok: true, channel: 'C_ACCEPT', ts: '1785100061.000100' };
    } } };
    const agent = handle();
    agent.read = async () => {
      // The installation is suspended while the occurrence runs.
      registry.status = 'refused';
      now += INSTALLATION_ADMISSION_TTL_MS;
      return {
        submissionId: 'submission_acceptance', uid: 'uid_acceptance', text: 'Report',
        data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'succeeded', message: 'Hourly report' }] },
      };
    };
    const scheduler = () => new RoutineScheduler(store, new RoutineAdmissionController(store, {
      execute: (run, attempt) => executeRoutineOccurrence({
        env, store, occurrenceId: run.id, attempt: attempt.attempt,
      }, {
        ...executionDependencies(() => now),
        resolveAccess: async (run, saved) => ({
          ...(await executionDependencies(() => now).resolveAccess(run, saved)), client: client as never,
        }),
        handle: agent,
      }),
    }));

    now += 60_000;
    await scheduler().heartbeat(now, 'heartbeat-first');
    const [skipped] = await store.listRuns({ routineId: routine.id });
    assert.equal(skipped?.status, 'skipped');
    assert.equal(skipped?.skipReason, 'installation_not_admitted');
    assert.equal(skipped?.flueAgentSettlement?.outcome, 'completed', 'the settlement is kept');
    assert.deepEqual(posts, []);

    // Resumed well after the occurrence's deadline: nothing was held for retention to fail.
    registry.status = 'admitted';
    now = skipped!.deadlineAt + ROUTINE_LIMITS.deliveryLeaseMs + INSTALLATION_ADMISSION_TTL_MS;
    await scheduler().heartbeat(now, 'heartbeat-resumed');
    assert.equal((await store.getRun(skipped!.id))?.status, 'skipped');
    assert.deepEqual(await afterResume(store, routine.id, env), UNHARMED);
    assert.deepEqual(posts, []);
  } finally {
    store.close();
  }
});

test('a dispatched occurrence of a refused installation is stopped and skipped, and a model request refused mid-run is skipped, not failed', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-refused-dispatched-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date().setUTCMinutes(59, 0, 0);
  const store = new SqliteRoutineStore(join(directory, 'state.sqlite'), () => now);
  const { env, registry } = hostedRoutineInstallation(context, () => now);
  try {
    const routine = await hourlyChannelRoutine(store, () => now, 'refused-dispatched:seed');
    let aborts = 0;
    const agent = handle(new DOMException('reader restarted', 'AbortError'));
    agent.abort = async () => { aborts += 1; };
    const scheduler = (attemptHandle: AgentInstanceHandle) => new RoutineScheduler(store, new RoutineAdmissionController(store, {
      execute: (run, attempt) => executeRoutineOccurrence({
        env, store, occurrenceId: run.id, attempt: attempt.attempt,
      }, { ...executionDependencies(() => now), handle: attemptHandle }),
    }));

    // Dispatched, then the read is interrupted: the occurrence is running with a receipt.
    now += 60_000;
    await scheduler(agent).heartbeat(now, 'heartbeat-dispatched');
    const [running] = await store.listRuns({ routineId: routine.id });
    assert.equal(running?.status, 'running');
    // Suspended before the next visit: the attempt is stopped and the occurrence skipped.
    registry.status = 'refused';
    now += INSTALLATION_ADMISSION_TTL_MS;
    await scheduler(agent).heartbeat(now, 'heartbeat-refused');
    assert.equal(aborts, 1);
    const stopped = (await store.getRun(running!.id))!;
    assert.equal(stopped.status, 'skipped');
    assert.equal(stopped.skipReason, 'installation_not_admitted');

    // The next slot: the agent's own model request is refused before the
    // executor's cached answer changes, and the read fails with that refusal.
    registry.status = 'admitted';
    now += 60 * 60_000;
    const refusedMidRun = handle({
      name: 'AgentRunError', message: 'agent submission failed',
      cause: { type: 'operation_failed', message: 'This installation is not admitted to start work (installation_not_admitted).' },
    });
    await scheduler(refusedMidRun).heartbeat(now, 'heartbeat-refused-mid-run');
    const midRun = (await store.listRuns({ routineId: routine.id })).find((run) => run.id !== running!.id)!;
    assert.equal(midRun.status, 'skipped');
    assert.equal(midRun.failureClass, 'policy_denied');
    assert.equal(midRun.flueAgentSettlement?.outcome, 'failed');
    assert.deepEqual(await afterResume(store, routine.id, env), UNHARMED, 'no failure notice, pause or failure count');
  } finally {
    store.close();
  }
});

test('a keyring outage defers an occurrence, and stops a dispatched one without a failure, notice or pause', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-keyring-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date().setUTCMinutes(59, 0, 0);
  const store = new SqliteRoutineStore(join(directory, 'state.sqlite'), () => now);
  const { env } = hostedRoutineInstallation(context, () => now);
  try {
    const routine = await hourlyChannelRoutine(store, () => now, 'keyring:seed');
    let keyringLoads = false;
    let outageRead = true;
    const agent = handle();
    agent.read = async () => {
      if (!outageRead) return handle().read({} as never);
      throw { name: 'AgentRunError', message: 'agent submission failed',
        cause: { message: new ModelCredentialKeyringUnavailableError().message } };
    };
    const scheduler = () => new RoutineScheduler(store, new RoutineAdmissionController(store, {
      execute: (run, attempt) => executeRoutineOccurrence({
        env, store, occurrenceId: run.id, attempt: attempt.attempt,
      }, {
        ...executionDependencies(() => now),
        resolveModel: async () => {
          if (!keyringLoads) throw new ModelCredentialKeyringUnavailableError();
          return { model: config.model };
        },
        handle: agent,
      }),
    }));

    // The keyring will not load: the occurrence waits, nothing fails.
    now += 60_000;
    assert.equal((await scheduler().heartbeat(now, 'heartbeat-outage')).admissions.deferred, 1);
    const [waiting] = await store.listRuns({ routineId: routine.id });
    assert.equal(waiting?.status, 'admitting');
    assert.deepEqual(await afterResume(store, routine.id, env), UNHARMED);

    // It loads again, but the dispatched attempt's own key read still fails: skipped, not failed.
    keyringLoads = true;
    now += ROUTINE_LIMITS.admissionLeaseMs + 1;
    await scheduler().heartbeat(now, 'heartbeat-dispatched');
    const stopped = (await store.getRun(waiting!.id))!;
    assert.equal(stopped.status, 'skipped');
    assert.equal(stopped.skipReason, 'keyring_unavailable');
    assert.deepEqual(await afterResume(store, routine.id, env), UNHARMED);

    // The next slot runs normally.
    outageRead = false;
    now += 60 * 60_000;
    await scheduler().heartbeat(now, 'heartbeat-next');
    assert.equal((await store.listRuns({ routineId: routine.id })).find((run) => run.id !== waiting!.id)?.status, 'no_op');
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
      ['routine-slack-tools.test.ts', 'natural five-minute follow-up arguments become fresh private thread work'],
      ['routine-slack-actions.test.ts', 'first-class DM actions create once, queue reactions, and run now without approval'],
      ['routine-delivery.test.ts', 'private routine results and failure notices stay in the originating thread without Admin links'],
      ['admin-scheduled-work-routes.test.ts', 'direct schedules are absent from shared list, detail, and mutation surfaces'],
    ],
  },
  {
    example: 'AE2',
    evidence: [
      ['routine-slack-tools.test.ts', 'recurring and run-now arguments use the same first-class schedule action'],
      ['management-routines.test.ts', 'private DM routines need no deployment flag and use trusted thread management'],
      ['routine-delivery.test.ts', 'private routine results and failure notices stay in the originating thread without Admin links'],
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
    evidence: [
      ['management-slack-cloudflare-rpc.test.ts', 'first-class schedule RPC retries the same host-bound action without an unknown outcome'],
      ['routine-slack-actions.test.ts', 'a transient first-class action failure recovers from the durable alarm ledger'],
    ],
  },
  {
    example: 'AE5',
    evidence: [[
      'routine-slack-actions.test.ts',
      'first-class DM actions create once, queue reactions, and run now without approval',
    ]],
  },
  {
    example: 'AE6',
    evidence: [
      ['routine-slack-actions.test.ts', 'a transient first-class action failure recovers from the durable alarm ledger'],
      ['routine-slack-command.test.ts', 'authority failure leaves a durable safe routine state'],
    ],
  },
  {
    example: 'AE7',
    evidence: [
      ['management-receipts.test.ts', 'the outbox drain records the real Slack failure code and settles permanent rejections terminally'],
      ['management-receipts.test.ts', 'durable action state repairs one DM reaction and keeps Channel success reply-owned'],
    ],
  },
  {
    example: 'AE8',
    evidence: [[
      'management-routines.test.ts',
      'private DM routines need no deployment flag and use trusted thread management',
    ]],
  },
  {
    example: 'AE9',
    evidence: [
      ['admin-scheduled-work-routes.test.ts', 'direct schedules are absent from shared list, detail, and mutation surfaces'],
      ['admin-page.test.ts', 'Agent Schedules explains that private DM schedules stay in Slack even when no Channel schedules exist'],
    ],
  },
  {
    example: 'AE10',
    evidence: [[
      'routine-delivery.test.ts',
      'a repeated-failure pause notice is content-free and posts at the verified DM root',
    ]],
  },
  {
    example: 'AE11',
    evidence: [
      ['management-routines.test.ts', 'management-created schedules accept active grant-only destinations and bind authority'],
      ['routine-delivery.test.ts', 'routine delivery claims once, posts at top level, and records the Slack receipt'],
    ],
  },
  {
    example: 'AE12',
    evidence: [
      ['routine-slack-command.test.ts', 'the shared schedule command replays save and immediate run effects once'],
      ['management-routines.test.ts', 'management-created schedules accept active grant-only destinations and bind authority'],
    ],
  },
  {
    example: 'AE13',
    evidence: [[
      'routine-admission.test.ts',
      'a repeated controller reattaches one stable attempt and never creates a second admission',
    ]],
  },
] as const;

test('private DM product acceptance matrix stays linked to executable evidence', () => {
  assert.deepEqual(privateDmAcceptanceMatrix.map(({ example }) => example), [
    'AE1', 'AE2', 'AE3', 'AE4', 'AE5', 'AE6', 'AE7', 'AE8', 'AE9', 'AE10',
    'AE11', 'AE12', 'AE13',
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
