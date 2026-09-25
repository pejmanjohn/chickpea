import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityStatus, type TypedActivityStatus } from '../src/activity/status.ts';
import { publishActivityStatus } from '../src/slack/activity-publisher.ts';
import { AgentObservationYield } from '../src/slack/flue-dispatch.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationMutation,
  type SlackRunPresentation,
} from '../src/slack/run-presentations.ts';
import { observedStatusTargetFor, singletonObservedStatusTarget } from '../src/slack/status-relay.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import {
  runnerPresentationState,
  runnerTurnJobsPort,
  runThreadRunnerAlarm,
  type ThreadRunnerLoopDeps,
} from '../src/slack/thread-runner-loop.ts';
import { executeTurnJob, type TurnExecutionPorts } from '../src/slack/turn-executor.ts';
import { slackTurnExecutor } from '../src/slack/turn-executor-flag.ts';
import {
  TurnJobStoreLogic,
  type PendingTurnJob,
  type RunnerTurnJobView,
} from '../src/slack/turn-jobs.ts';
import type { RunTurnOptions } from '../src/slack/run-turn.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';
import { NOW, turnJob } from './fixtures/state-db/maintenance.ts';

const threadOf = (job: PendingTurnJob) => job.turn.threadTs;

function inThread(id: string, threadTs: string) {
  const job = turnJob(id);
  return { ...job, turn: { ...job.turn, threadTs, messageTs: threadTs } };
}

// ── the switch ──────────────────────────────────────────────────────────

test('SLACK_TAG_TURN_EXECUTOR selects the runner only when set to runner', () => {
  assert.equal(slackTurnExecutor({}, {}), 'alarm');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: 'runner' }, {}), 'runner');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: ' Runner ' }, {}), 'runner');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: 'alarm' }, { SLACK_TAG_TURN_EXECUTOR: 'runner' }),
    'alarm', 'the platform value wins over the process environment');
  assert.equal(slackTurnExecutor(undefined, { SLACK_TAG_TURN_EXECUTOR: 'runner' }), 'runner');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: 'runners' }, {}), 'alarm');
});

// ── turn rows: who owns a row ───────────────────────────────────────────

test('the alarm never lists runner rows and stops a thread at its first one', () => {
  const db = openStateDb(':memory:');
  let clock = NOW;
  try {
    const turns = new TurnJobStoreLogic(db, () => clock);
    for (const [id, thread] of [['a1', 'A'], ['a2', 'A'], ['b1', 'B'], ['b2', 'B']] as const) {
      turns.enqueue(inThread(id, `18000000${thread === 'A' ? '01' : '02'}.000001`)); clock += 1;
    }
    assert.equal(turns.assignRunner('a1'), true);
    turns.confirmRunner('a1');
    assert.equal(turns.assignRunner('a1'), false, 'a runner row is not handed over twice');
    const listed = turns.listPendingByThread({
      maxThreads: 16, perThread: 4, threadKey: threadOf, executor: 'alarm',
    });
    assert.deepEqual(listed.map((job) => job.id), ['b1', 'b2'],
      "thread A's later row waits behind its runner row");
    assert.equal(turns.hasPending(), true);
    assert.deepEqual(turns.runnerView('a1').executor, 'runner');
    assert.equal(turns.runnerView('a1').job?.executor, 'runner');
  } finally { db.close(); }
});

test('dispatch lists the oldest free row per thread and pages past runner rows', () => {
  const db = openStateDb(':memory:');
  let clock = NOW;
  try {
    const turns = new TurnJobStoreLogic(db, () => clock);
    for (const [id, thread] of [['a1', '01'], ['a2', '01'], ['b1', '02'], ['c1', '03']] as const) {
      turns.enqueue(inThread(id, `18000000${thread}.000001`)); clock += 1;
    }
    // Thread C's alarm turn already started a Flue dispatch: the alarm keeps it.
    db.run("UPDATE turn_jobs SET dispatch_started_at = 1 WHERE id = 'c1'");
    const page = (limit = 16) => turns.listDispatchable({ limit, threadKey: threadOf })
      .map((job) => job.id);
    assert.deepEqual(page(), ['a1', 'b1']);
    assert.deepEqual(page(1), ['a1']);
    for (const id of page()) turns.assignRunner(id);
    assert.deepEqual(page(), [], 'an unconfirmed hand-off holds its thread');
    assert.deepEqual(turns.listHandoffs(16).map((job) => job.id), ['a1', 'b1']);
    assert.equal(turns.hasHandoffs(), true);
    turns.confirmRunner('a1');
    turns.confirmRunner('b1');
    assert.deepEqual(page(), ['a2'], "the thread's next row follows its confirmed runner row");
    assert.equal(turns.hasHandoffs(), false);
    const dispatched = turns.listPendingByThread({
      maxThreads: 16, perThread: 4, threadKey: threadOf, executor: 'alarm', dispatchedOnly: true,
    });
    assert.deepEqual(dispatched.map((job) => job.id), ['c1'],
      'in runner mode the alarm only finishes its own dispatched turns');
  } finally { db.close(); }
});

test('runner rows keep their cleanup for their runner, and recovery hands a row back', () => {
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => NOW);
    turns.enqueue(turnJob('r1'));
    turns.assignRunner('r1');
    turns.confirmRunner('r1');
    db.run(`UPDATE turn_jobs SET progress_json = '{"slackInteraction":{"acknowledgment":{"cleanup":"pending"}}}'
      WHERE id = 'r1'`);
    turns.markDelivered('r1');
    assert.deepEqual(turns.listPendingSlackInteractionCleanups(10), [],
      "the state store's sweep leaves a runner's cleanup to it");
    assert.equal(turns.hasPendingSlackInteractionCleanup(), false);
    const view = turns.runnerView('r1');
    assert.equal(view.status, 'done');
    assert.equal(view.cleanupPending, true);
    assert.equal(view.job?.id, 'r1', 'the runner repairs from the decoded row');

    turns.enqueue(turnJob('r2'));
    turns.assignRunner('r2');
    turns.confirmRunner('r2');
    turns.markRecoveryRequired('r2', 'slack_installation_unavailable');
    assert.equal(turns.runnerView('r2').status, 'recovery_required');
    assert.equal(turns.retrySlackInstallationRecovery('T_TEST'), 1);
    assert.equal(turns.runnerView('r2').executor, 'alarm', 'a reopened row is dispatched again');
  } finally { db.close(); }
});

test('the dispatch route is part of the durable observation, validated both ways', () => {
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => NOW);
    turns.enqueue(turnJob('route'));
    assert.throws(() => turns.prepareFlueDispatch('route', 'hi', {
      generation: 'g', executor: 'runner',
    } as never), /runner route is incomplete/);
    assert.throws(() => turns.prepareFlueDispatch('route', 'hi', {
      generation: 'g', executor: 'elsewhere', runnerKey: 'k',
    } as never), /executor is invalid/);
  } finally { db.close(); }
});

// ── presentations: the runner's copy and the state store's ─────────────

const ROOT = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: '1800000000.000001', requesterUserId: 'U_TEST',
};

function v3Input(runId: string, turnJobId: string) {
  return {
    schemaVersion: 3 as const, runId, turnJobId, bindingId: `binding_${runId}`,
    workBindingGeneration: 1, runFencingToken: 0, root: ROOT,
    owner: {
      kind: 'selected_agent' as const,
      persona: { name: 'Fixture', avatarUrl: 'https://example.com/a.png', avatarRevision: 1 },
    },
    sessionGeneration: 5,
  };
}

function advance(
  store: SlackRunPresentationStoreLogic,
  current: SlackRunPresentation,
  mutation: SlackPresentationMutation,
): SlackRunPresentation {
  const result = store.transition({
    runId: current.runId, workBindingGeneration: current.workBindingGeneration,
    runFencingToken: current.runFencingToken, expectedProjectionVersion: current.projectionVersion,
    expectedStreamState: current.stream.state, mutation,
  });
  assert.equal(result.outcome, 'applied');
  return (result as { presentation: SlackRunPresentation }).presentation;
}

function repairable(store: SlackRunPresentationStoreLogic, runId: string, turnJobId: string) {
  let current: SlackRunPresentation = store.create(v3Input(runId, turnJobId));
  current = advance(store, current, {
    kind: 'record_terminal_delivery_intent', operationId: `terminal_${runId}`, result: 'answer',
  });
  return advance(store, current, {
    kind: 'record_terminal_delivery_receipt', operationId: `terminal_${runId}`, certainty: 'acknowledged',
  });
}

test("the state store's repair sweep skips runner-owned presentations", () => {
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => NOW);
    const store = new SlackRunPresentationStoreLogic(db, () => NOW);
    turns.enqueue(turnJob('turn_alarm'));
    turns.enqueue(turnJob('turn_runner'));
    turns.assignRunner('turn_runner');
    repairable(store, 'run_alarm', 'turn_alarm');
    repairable(store, 'run_runner', 'turn_runner');
    assert.deepEqual(store.listAutoRepairableV3(10).map((row) => row.runId).sort(),
      ['run_alarm', 'run_runner']);
    assert.deepEqual(store.listAutoRepairableV3(10, { skipRunnerOwned: true }).map((row) => row.runId),
      ['run_alarm'], 'even an unconfirmed hand-off belongs to its runner');
  } finally { db.close(); }
});

test('a presentation snapshot moves between stores only forward', () => {
  const shared = openStateDb(':memory:');
  const runner = openStateDb(':memory:');
  try {
    const sharedStore = new SlackRunPresentationStoreLogic(shared, () => NOW);
    const runnerStore = new SlackRunPresentationStoreLogic(runner, () => NOW);
    const admitted = sharedStore.create(v3Input('run_move', 'turn_move'));
    assert.equal(runnerStore.putSnapshot(admitted), true, 'the runner imports the hand-off copy');
    assert.equal(runnerStore.putSnapshot(admitted), false, 'a repeated hand-off changes nothing');
    const advanced = repairable(runnerStore, 'run_move_2', 'turn_move_2');
    assert.equal(sharedStore.putSnapshot(advanced), true);
    assert.deepEqual(sharedStore.get('run_move_2'), advanced, 'readers of the shared store see it');
    const next = advance(runnerStore, runnerStore.get('run_move')!, {
      kind: 'record_terminal_delivery_intent', operationId: 'terminal_move', result: 'answer',
    });
    assert.equal(sharedStore.putSnapshot(next), true);
    assert.equal(sharedStore.putSnapshot(admitted), false, 'an older copy never overwrites a newer one');
    assert.equal(sharedStore.get('run_move')!.projectionVersion, next.projectionVersion);
  } finally {
    shared.close();
    runner.close();
  }
});

test('runner presentation state writes locally and publishes lifecycle changes only', async () => {
  const db = openStateDb(':memory:');
  try {
    const local = new SlackRunPresentationStoreLogic(db, () => NOW);
    const published: number[] = [];
    let remoteGeneration: number | undefined = 9;
    const presentation = runnerPresentationState({
      local,
      remote: {
        matchFlueObservation: async () => undefined,
        getLatestThreadSessionGeneration: async () => remoteGeneration,
      },
      putRemote: async (value) => { published.push(value.projectionVersion); },
    });
    let current = local.create(v3Input('run_pub', 'turn_pub'));
    const transition = async (mutation: SlackPresentationMutation) => {
      const result = await presentation.state.transitionRunPresentation({
        runId: current.runId, workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken, expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state, mutation,
      });
      assert.equal(result.outcome, 'applied');
      current = (result as { presentation: SlackRunPresentation }).presentation;
    };
    await transition({ kind: 'record_terminal_delivery_intent', operationId: 'terminal_pub', result: 'answer' });
    await transition({ kind: 'record_terminal_delivery_receipt', operationId: 'terminal_pub', certainty: 'acknowledged' });
    assert.deepEqual(published, [2, 3]);
    await presentation.publish('run_pub');
    assert.deepEqual(published, [2, 3], 'an unchanged lifecycle is not published again');
    assert.equal(await presentation.state.getLatestThreadSessionGeneration(ROOT), 9,
      "the shared store's newer generation fences this runner's shared effects");
    remoteGeneration = undefined;
    assert.equal(await presentation.state.getLatestThreadSessionGeneration(ROOT), 5);
  } finally { db.close(); }
});

// ── status relay target ─────────────────────────────────────────────────

test('observed activity goes to the executor recorded with the dispatch', async () => {
  const runnerStub = { observedStatus: async () => ({ ok: true as const, value: null }) };
  const singletonStub = { observedStatus: async () => ({ ok: true as const, value: null }) };
  const env = {
    TAG_STATE: { getByName: () => singletonStub },
    SLACK_THREAD_RUNNER: {
      getByName(name: string) {
        assert.equal(name, 'T1:C1:1.0:owner-i1');
        return runnerStub;
      },
    },
  };
  assert.equal(observedStatusTargetFor(undefined), singletonObservedStatusTarget);
  assert.equal(observedStatusTargetFor({ executor: 'runner', runnerKey: 'T1:C1:1.0:owner-i1' })(env, 'i', 's'),
    runnerStub);
  assert.equal(observedStatusTargetFor({ executor: 'runner', runnerKey: 'T1:C1:1.0:owner-i1' })(
    { TAG_STATE: env.TAG_STATE }, 'i', 's'), singletonStub, 'without the binding the state store forwards it');
});

test('the agent relays activity for a runner turn straight to that runner', async () => {
  const prototype = Object.getPrototypeOf(globalThis.navigator) as object;
  const original = Object.getOwnPropertyDescriptor(prototype, 'userAgent');
  Object.defineProperty(prototype, 'userAgent', { configurable: true, enumerable: true, value: 'Cloudflare-Workers' });
  try {
    const delivered = Promise.withResolvers<{ runner: string; status: TypedActivityStatus }>();
    const env = {
      TAG_STATE: { getByName: () => assert.fail('the state store is not on this path') },
      SLACK_THREAD_RUNNER: {
        getByName: (runner: string) => ({
          async observedStatus(_instanceId: string, _submissionId: string, status: TypedActivityStatus) {
            delivered.resolve({ runner, status });
            return { ok: true as const, value: null };
          },
        }),
      },
    };
    const interceptor = createWorkModelInvocationInterceptor({
      resolveTarget: async () => ({
        turnJobId: 'turn_runner', instanceId: 'runner-thread', submissionId: 'submission_runner',
        generation: 'g_runner', executor: 'runner', runnerKey: 'T1:C1:1.0:owner-i1',
      }),
    });
    await interceptor(
      { type: 'agent', operationId: 'runner-status', operationKind: 'prompt' },
      { instanceId: 'runner-thread', submissionId: 'submission_runner', agentName: 'chickpea-slack-v2' },
      async () => {
        publishActivityStatus('runner-thread', activityStatus('reading', 'Loading', 'a skill'), env);
      },
    );
    const { runner, status } = await delivered.promise;
    assert.equal(runner, 'T1:C1:1.0:owner-i1');
    assert.deepEqual(status, activityStatus('reading', 'Loading', 'a skill'));
  } finally {
    if (original) Object.defineProperty(prototype, 'userAgent', original);
  }
});

// ── the runner loop ─────────────────────────────────────────────────────

/** In-memory state-store turn rows, as the runner reaches them over RPC. */
function fakeRows(ids: string[]) {
  const rows = new Map<string, {
    status: RunnerTurnJobView['status']; attempts: number; receipt?: string; cleanup?: boolean;
  }>(ids.map((id) => [id, { status: 'pending', attempts: 0 }]));
  const calls: string[] = [];
  let failMarkDelivered = 0;
  let failViews = 0;
  const job = (id: string): PendingTurnJob => {
    const row = rows.get(id)!;
    return {
      ...turnJob(id), executionAuthority: 'legacy', attempts: row.attempts, progress: {},
      executor: 'runner',
      ...(row.receipt
        ? {
            dispatchEnvelope: { instanceId: 'agent' } as never,
            dispatchReceipt: { submissionId: row.receipt, acceptedAt: new Date().toISOString() } as never,
          }
        : {}),
    } as PendingTurnJob;
  };
  const view = (id: string): RunnerTurnJobView => {
    const row = rows.get(id);
    if (!row) return { status: 'missing' };
    if (row.status !== 'pending') {
      return {
        status: row.status,
        executor: 'runner',
        ...(row.cleanup ? { cleanupPending: true, job: job(id) } : {}),
      };
    }
    return { status: 'pending', executor: 'runner', job: job(id) };
  };
  return {
    rows,
    calls,
    failNextMarkDelivered(times = 1) { failMarkDelivered = times; },
    failNextViews(times: number) { failViews = times; },
    turns: {
      async view(id: string) {
        if (failViews > 0) {
          failViews -= 1;
          const error = new Error('state store unreachable');
          error.name = 'StateStoreUnavailable';
          throw error;
        }
        calls.push(`view:${id}`);
        return view(id);
      },
      async markDelivered(id: string) {
        if (failMarkDelivered > 0) {
          failMarkDelivered -= 1;
          throw new Error('state store unreachable');
        }
        calls.push(`markDelivered:${id}`);
        rows.get(id)!.status = 'done';
      },
      async markError(id: string) { calls.push(`markError:${id}`); rows.get(id)!.status = 'error'; },
    },
  };
}

/**
 * A runner over one storage file whose `execute` is the real executeTurnJob
 * against a fake agent: a job without a receipt dispatches (counted), a job
 * with one reattaches; `hold` keeps observing until the alarm aborts.
 */
function runnerHarness(db: ReturnType<typeof openStateDb>, rows: ReturnType<typeof fakeRows>, script: {
  hold?: (id: string) => boolean;
  /** The agent fails every attempt of these turns. */
  fail?: (id: string) => boolean;
  /** Claim releases reject (the state store is unreachable after a final). */
  failRelease?: boolean;
  /** Slack interaction cleanup attempts reject this many times. */
  failCleanups?: number;
} = {}) {
  const jobs = new ThreadRunnerJobStore(db);
  const events: string[] = [];
  let failCleanups = script.failCleanups ?? 0;
  const records: string[] = [];
  let backstops = 0;
  let offset = 0;
  const port = runnerTurnJobsPort({
    recordAttempt: async (id: string, attempts: number) => { rows.rows.get(id)!.attempts = attempts; },
    recordFlueReceipt: async (id: string, receipt: { submissionId: string }) => {
      rows.rows.get(id)!.receipt = receipt.submissionId;
      return receipt;
    },
    markDelivered: (id: string) => rows.turns.markDelivered(id),
    markError: (id: string) => rows.turns.markError(id),
  } as unknown as TurnExecutionPorts['turnJobs'], jobs, () => Date.now());
  const ports = {
    env: {},
    turnJobs: port,
    slack: {
      setActiveWork: async () => {},
      release: async () => {
        if (script.failRelease) throw new Error('state store unreachable');
      },
      markCodingActiveWork: async () => {},
    },
    config: {},
    presentationState: {},
    telemetry: { capture() {} },
    resolveInstallation: async () => ({
      workspaceId: 'T_TEST',
      client: { conversations: { info: async () => ({ ok: true, channel: { id: 'C_TEST', is_member: true } }) } },
    }),
    sandboxes: () => [],
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
      const id = options.turnId!;
      if (script.fail?.(id)) {
        events.push(`failed:${id}`);
        throw new Error('model unavailable');
      }
      if (!options.flueDispatch?.dispatchReceipt) {
        events.push(`dispatch:${id}`);
        await options.flueDispatch?.recordReceipt({ submissionId: `submission_${id}` } as never);
      } else {
        events.push(`reattach:${id}`);
      }
      if (script.hold?.(id)) {
        options.onObservationStarted?.();
        const signal = options.observationSignal!;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        events.push(`yield:${id}`);
        throw new AgentObservationYield();
      }
      await options.onDelivered?.();
      events.push(`delivered:${id}`);
    },
  } as unknown as TurnExecutionPorts;
  const deps: ThreadRunnerLoopDeps = {
    jobs,
    turns: rows.turns,
    execute: (job, control, onRetry, threadKey) => executeTurnJob(job, ports, {
      latency: { lane: 'cloudflare', executor: 'runner' },
      observationRoute: { executor: 'runner', runnerKey: threadKey },
      control,
      onRetry,
    }),
    repairInteraction: async (job) => {
      if (failCleanups > 0) {
        failCleanups -= 1;
        events.push(`cleanup-failed:${job.id}`);
        throw new Error('reaction removal failed');
      }
      events.push(`cleanup:${job.id}`);
      rows.rows.get(job.id)!.cleanup = false;
    },
    clearActiveWork: async () => {},
    armBackstop: async () => { backstops += 1; },
    carried: new Map(),
    failures: { count: 0 },
    budgetMs: 40,
    hardCapMs: 400,
    recheckMs: 2,
    sink: { info(record: Record<string, unknown>) { records.push(JSON.stringify(record)); } },
    now: () => Date.now() + offset,
  };
  return {
    jobs, events, deps, records,
    backstops: () => backstops,
    advance: (ms: number) => { offset += ms; },
  };
}

test('a runner runs its thread strictly in order and settles each job', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['j1', 'j2']);
    const h = runnerHarness(db, rows);
    h.jobs.admit({ id: 'j1', threadKey: 'thread', payload: {} }, 1);
    h.jobs.admit({ id: 'j2', threadKey: 'thread', payload: {} }, 1);
    const result = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:j1', 'delivered:j1', 'dispatch:j2', 'delivered:j2']);
    assert.deepEqual(h.jobs.status().jobs, { done: 2 });
    assert.equal(result.nextAlarmAt, undefined, 'an idle runner arms nothing');
    assert.deepEqual({ ...result.record, durationMs: 0 },
      { jobs: 2, ran: 2, yielded: false, carried: 0, durationMs: 0, outcome: 'drained' });
    assert.equal(h.backstops(), 2, 'a backstop wake is armed whenever a job starts');
  } finally { db.close(); }
});

test('a long turn yields at the budget, holds its thread, and reattaches without dispatching again', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['long', 'next']);
    let holding = true;
    const h = runnerHarness(db, rows, { hold: (id) => id === 'long' && holding });
    h.jobs.admit({ id: 'long', threadKey: 'thread', payload: {} }, 1);
    h.jobs.admit({ id: 'next', threadKey: 'thread', payload: {} }, 2);
    const before = Date.now();
    const first = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:long', 'yield:long'], 'the next turn waits in its thread');
    assert.equal(first.record.yielded, true);
    assert.ok(first.nextAlarmAt! >= before + 1_000 && first.nextAlarmAt! <= Date.now() + 1_000,
      'a yield re-arms in a second');
    assert.equal(h.jobs.get('long')!.state, 'yielded');
    assert.equal(rows.rows.get('long')!.attempts, 0, 'a yield is never an attempt');
    holding = false;
    h.advance(1_000);
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events.slice(2), ['reattach:long', 'delivered:long', 'dispatch:next', 'delivered:next']);
  } finally { db.close(); }
});

test('a new runner over the same storage resumes an evicted turn without dispatching again', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['evicted']);
    // The evicted runner dispatched and recorded the receipt, then vanished.
    rows.rows.get('evicted')!.receipt = 'submission_evicted';
    rows.rows.get('evicted')!.attempts = 1;
    const before = new ThreadRunnerJobStore(db);
    before.admit({ id: 'evicted', threadKey: 'thread', payload: {} }, 1);
    before.markRunning('evicted');
    const h = runnerHarness(db, rows);
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['reattach:evicted', 'delivered:evicted']);
    assert.equal(rows.rows.get('evicted')!.status, 'done');
  } finally { db.close(); }
});

test('a final posted while the state store is unreachable is never posted again', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['final']);
    rows.failNextMarkDelivered(2);
    const h = runnerHarness(db, rows);
    h.jobs.admit({ id: 'final', threadKey: 'thread', payload: {} }, 1);
    const first = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:final', 'delivered:final']);
    assert.equal(rows.rows.get('final')!.status, 'pending', 'the state store has not recorded it');
    assert.equal(h.jobs.get('final')!.state, 'done', 'the runner settled it locally first');
    assert.ok(first.nextAlarmAt !== undefined, 'the runner comes back to record it');
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:final', 'delivered:final'], 'exactly one final');
    assert.equal(rows.rows.get('final')!.status, 'done');
    assert.equal(h.jobs.get('final')!.terminalSync, undefined);
  } finally { db.close(); }
});

test('a job the state store settled or took back never runs in the runner', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['settled', 'recovery', 'live']);
    rows.rows.get('settled')!.status = 'done';
    rows.rows.get('recovery')!.status = 'recovery_required';
    const h = runnerHarness(db, rows);
    for (const [index, id] of ['settled', 'recovery', 'live'].entries()) {
      h.jobs.admit({ id, threadKey: 'thread', payload: {} }, index);
    }
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:live', 'delivered:live']);
    assert.deepEqual(h.jobs.status().jobs, { done: 2, recovery_required: 1 });
    // The state store reopens the recovery row and hands it over again.
    assert.deepEqual(h.jobs.admit({ id: 'recovery', threadKey: 'thread', payload: {} }, 9), { admitted: true });
    assert.equal(h.jobs.get('recovery')!.state, 'admitted');
    assert.deepEqual(h.jobs.admit({ id: 'live', threadKey: 'thread', payload: {} }, 9), { admitted: false },
      'a settled job is never revived by a repeated hand-off');
  } finally { db.close(); }
});

test('a deferred terminal is checked again without holding the next turn', () => {
  const db = openStateDb(':memory:');
  try {
    const jobs = new ThreadRunnerJobStore(db);
    jobs.admit({ id: 'deferred', threadKey: 'thread', payload: {} }, 1);
    jobs.admit({ id: 'next', threadKey: 'thread', payload: {} }, 2);
    jobs.settle('deferred', 'deferred', 10, 1_000);
    assert.deepEqual(jobs.runnable(10).map((job) => job.id), ['next']);
    assert.deepEqual(jobs.runnable(1_000).map((job) => job.id), ['deferred', 'next']);
    jobs.settle('next', 'admitted', 10, 500);
    assert.deepEqual(jobs.runnable(10).map((job) => job.id), [], 'a retained turn holds its successors');
    assert.equal(jobs.nextDueAt(10), 500);
  } finally { db.close(); }
});

test('a state store outage never throws out of the runner alarm; the job runs once it recovers', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['outage']);
    rows.rows.get('outage')!.receipt = 'submission_outage';
    const h = runnerHarness(db, rows);
    h.jobs.admit({ id: 'outage', threadKey: 'thread', payload: {} }, 1);
    rows.failNextViews(2);
    const first = await runThreadRunnerAlarm(h.deps);
    const firstAt = Date.now();
    assert.equal(first.record.outcome, 'threw');
    assert.equal(first.record.reason, 'StateStoreUnavailable');
    assert.ok(first.nextAlarmAt! >= firstAt + 1_900 && first.nextAlarmAt! <= firstAt + 2_100,
      'the first retry is two seconds out');
    const second = await runThreadRunnerAlarm(h.deps);
    const secondAt = Date.now();
    assert.equal(second.record.outcome, 'threw');
    assert.ok(second.nextAlarmAt! >= secondAt + 3_900 && second.nextAlarmAt! <= secondAt + 4_100,
      'the backoff doubles');
    const third = await runThreadRunnerAlarm(h.deps);
    assert.equal(third.record.outcome, 'drained');
    assert.deepEqual(h.events, ['reattach:outage', 'delivered:outage'], 'reattached, never dispatched again');
    assert.equal(h.deps.failures.count, 0);
    assert.ok(h.records.some((line) => line.includes('"reason":"StateStoreUnavailable"')));
  } finally { db.close(); }
});

test('a failure final is settled before claims are released, so a failed release never re-runs it', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['failing']);
    rows.rows.get('failing')!.attempts = 1;
    const h = runnerHarness(db, rows, { fail: (id) => id === 'failing', failRelease: true });
    h.jobs.admit({ id: 'failing', threadKey: 'thread', payload: {} }, 1);
    const first = await runThreadRunnerAlarm(h.deps);
    assert.equal(first.record.outcome, 'threw', 'the release failure is caught, not thrown');
    assert.equal(h.jobs.get('failing')!.state, 'error');
    assert.equal(rows.rows.get('failing')!.status, 'error');
    h.advance(10_000);
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['failed:failing'], 'the terminal attempt ran exactly once');
  } finally { db.close(); }
});

test("a runner repairs its own turn's failed Slack interaction cleanup", async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['cleanup']);
    const h = runnerHarness(db, rows, { failCleanups: 1 });
    h.jobs.admit({ id: 'cleanup', threadKey: 'thread', payload: {} }, 1);
    const original = rows.turns.markDelivered;
    rows.turns.markDelivered = async (id: string) => {
      await original(id);
      rows.rows.get(id)!.cleanup = true; // the reaction removal failed in the turn
    };
    const first = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:cleanup', 'delivered:cleanup', 'cleanup-failed:cleanup']);
    assert.ok(first.nextAlarmAt !== undefined, 'the runner comes back for the cleanup');
    h.advance(30_000);
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events.slice(3), ['cleanup:cleanup']);
    h.advance(60_000);
    const settled = await runThreadRunnerAlarm(h.deps);
    assert.equal(settled.nextAlarmAt, undefined, 'nothing is owed once the cleanup is done');
    assert.deepEqual(h.events.slice(4), []);
  } finally { db.close(); }
});

test("a retired aged stream in the runner's copy is published and accepted by the state store", async () => {
  const runnerDb = openStateDb(':memory:');
  const sharedDb = openStateDb(':memory:');
  try {
    const local = new SlackRunPresentationStoreLogic(runnerDb, () => NOW);
    const shared = new SlackRunPresentationStoreLogic(sharedDb, () => NOW);
    const published: SlackRunPresentation[] = [];
    const presentation = runnerPresentationState({
      local,
      remote: { matchFlueObservation: async () => undefined, getLatestThreadSessionGeneration: async () => 5 },
      putRemote: async (value) => { published.push(value); shared.putSnapshot(value); },
    });
    let current = local.create(v3Input('run_aged', 'turn_aged'));
    shared.putSnapshot(current);
    current = advance(local, current, { kind: 'stream_start_intent' });
    current = advance(local, current, {
      kind: 'stream_started', messageTs: '1800000000.000200',
      flue: { instanceId: 'instance_aged', submissionId: 'submission_aged' },
    });
    const result = await presentation.state.transitionRunPresentation({
      runId: current.runId, workBindingGeneration: current.workBindingGeneration,
      runFencingToken: current.runFencingToken, expectedProjectionVersion: current.projectionVersion,
      expectedStreamState: 'streaming', mutation: { kind: 'retire_aged_stream', messageTs: '1800000000.000200' },
    });
    assert.equal(result.outcome, 'applied');
    const retired = shared.get('run_aged')!;
    assert.equal(retired.stream.state, 'fallback');
    assert.equal(retired.repairRequired, true);
    assert.equal(published.at(-1)!.projectionVersion, retired.projectionVersion);
  } finally {
    runnerDb.close();
    sharedDb.close();
  }
});
