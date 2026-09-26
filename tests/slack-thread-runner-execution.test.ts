import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityStatus, type TypedActivityStatus } from '../src/activity/status.ts';
import { publishActivityStatus } from '../src/slack/activity-publisher.ts';
import {
  AgentObservationYield,
  AgentPromptFailure,
  StateStoreUnavailable,
} from '../src/slack/flue-dispatch.ts';
import {
  CfMemoryStateStore,
  CfTurnJobsForRunner,
  CfUsageStore,
  FreshTagStateStubs,
  replaySafeStateRpc,
  StateStoreDisconnectedError,
} from '../src/config/cf-state-proxies.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { localSlackPresentationStatePort } from '../src/slack/presentation-state-port.ts';
import {
  DEFAULT_SLACK_APPEND_BUDGET,
  SlackRunPresentationStoreLogic,
  type SlackPresentationMutation,
  type SlackRunPresentation,
} from '../src/slack/run-presentations.ts';
import { observedStatusTargetFor, singletonObservedStatusTarget } from '../src/slack/status-relay.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import {
  runnerPresentationState,
  RUNNER_SHARED_BUDGET_METHODS,
  runnerTurnJobsPort,
  runThreadRunnerAlarm,
  createRunnerSupersedeState,
  THREAD_RUNNER_SUPERSEDE_COOLDOWN_MS,
  runnerLoopScheduler,
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
import {
  drainManagementReceiptOutbox,
  failAgentWelcomeTurn,
} from '../src/management/receipts.ts';
import { ManagementStoreLogic } from '../src/management/store.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';
import { NOW, turnJob } from './fixtures/state-db/maintenance.ts';

const threadOf = (job: PendingTurnJob) => job.turn.threadTs;

/** The state store's workspace budgets, over one presentation store. */
function sharedBudgets(store: SlackRunPresentationStoreLogic) {
  return {
    reserveSlackAppend: async (workspaceId: string) => store.reserveAppend(workspaceId),
    slackAppendCooldownUntil: async (workspaceId: string) => store.appendCooldownUntil(workspaceId),
    applySlackAppendCooldown: async (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    reserveSlackActivityStatus: async (workspaceId: string) => store.reserveActivityStatus(workspaceId),
    applySlackActivityStatusCooldown: async (workspaceId: string, retryAfterMs: number) =>
      store.applyActivityStatusCooldown(workspaceId, retryAfterMs),
  };
}

function inThread(id: string, threadTs: string) {
  const job = turnJob(id);
  return { ...job, turn: { ...job.turn, threadTs, messageTs: threadTs } };
}

// ── the switch ──────────────────────────────────────────────────────────

test('the thread runner is the default executor; SLACK_TAG_TURN_EXECUTOR=alarm is the emergency fallback', () => {
  assert.equal(slackTurnExecutor({}, {}), 'runner', 'unset: the runner executes');
  assert.equal(slackTurnExecutor(undefined, {}), 'runner');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: '' }, {}), 'runner');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: 'runner' }, {}), 'runner');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: 'alarm' }, {}), 'alarm');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: ' Alarm ' }, {}), 'alarm');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: 'runner' }, { SLACK_TAG_TURN_EXECUTOR: 'alarm' }),
    'runner', 'the platform value wins over the process environment');
  assert.equal(slackTurnExecutor(undefined, { SLACK_TAG_TURN_EXECUTOR: 'alarm' }), 'alarm');
  assert.equal(slackTurnExecutor({ SLACK_TAG_TURN_EXECUTOR: 'alarms' }, {}), 'runner',
    'an unfamiliar value preserves the default');
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
    let generationReads = 0;
    const presentation = runnerPresentationState({
      local,
      remote: {
        ...sharedBudgets(local),
        matchFlueObservation: async () => undefined,
        getLatestThreadSessionGeneration: async () => {
          generationReads += 1;
          return remoteGeneration;
        },
      },
      putRemote: async (value) => { published.push(value.projectionVersion); },
      publishIntervalMs: 0,
      generationCacheMs: 0,
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
    assert.deepEqual(published, [2, 3, 3], 'the job end publishes once more (version-gated)');
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
          error.name = 'StateStoreDisconnectedError';
          throw error;
        }
        calls.push(`view:${id}`);
        return view(id);
      },
      async begin(id: string) {
        if (failViews > 0) {
          failViews -= 1;
          const error = new Error('state store unreachable');
          error.name = 'StateStoreDisconnectedError';
          throw error;
        }
        calls.push(`begin:${id}`);
        return { view: view(id), settings: {} };
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
  /** The state store is unreachable from inside these turns. */
  storeOutage?: (id: string) => boolean;
  /** runTurn rejects with a factory store's disconnect error (no mapping). */
  storeReset?: (id: string) => boolean;
  /** runTurn rejects with a retryable Slack/gateway transport error. */
  slackOutage?: (id: string) => boolean;
  /** The turn ends on a deferred terminal (an Agent welcome the outbox posts). */
  deferred?: (id: string) => boolean;
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
      if (script.storeOutage?.(id)) {
        events.push(`outage:${id}`);
        throw new StateStoreUnavailable();
      }
      if (script.storeReset?.(id)) {
        events.push(`reset:${id}`);
        throw new StateStoreDisconnectedError(
          Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true }),
        );
      }
      if (script.slackOutage?.(id)) {
        events.push(`slack-outage:${id}`);
        throw new SlackTransportError('chat.postMessage', 'gateway_unreachable', { retryable: true });
      }
      if (!options.flueDispatch?.dispatchReceipt) {
        events.push(`dispatch:${id}`);
        await options.flueDispatch?.recordReceipt({ submissionId: `submission_${id}` } as never);
      } else {
        events.push(`reattach:${id}`);
      }
      if (script.deferred?.(id)) {
        await options.onDeferredTerminal?.();
        events.push(`deferred:${id}`);
        return;
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

test('a deferred terminal runs its turn once, then only reads its row with backoff until the outbox settles it', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['welcome', 'next']);
    const h = runnerHarness(db, rows, { deferred: (id) => id === 'welcome' });
    h.jobs.admit({ id: 'welcome', threadKey: 'thread', payload: {} }, 1);
    h.jobs.admit({ id: 'next', threadKey: 'thread', payload: {} }, 2);
    let at = h.deps.now!();
    const first = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:welcome', 'deferred:welcome', 'dispatch:next', 'delivered:next'],
      'a deferred terminal never holds the next turn');
    assert.equal(h.jobs.get('welcome')!.state, 'deferred');
    const due = () => h.jobs.get('welcome')!.retryAt! - at;
    assert.ok(due() >= 2_000 && due() < 2_100, `first check 2 s after the deferral, not ${due()}`);
    assert.equal(first.nextAlarmAt, h.jobs.get('welcome')!.retryAt);
    // The welcome is still pending in the outbox: each wake reads the row
    // and backs off; it never runs the turn (or refreshes its status) again.
    for (const delay of [4_000, 8_000, 16_000, 30_000, 30_000]) {
      h.advance(h.jobs.get('welcome')!.retryAt! - h.deps.now!());
      const calls = rows.calls.length;
      at = h.deps.now!();
      const result = await runThreadRunnerAlarm(h.deps);
      assert.deepEqual(rows.calls.slice(calls), ['view:welcome'], 'a check is one row read');
      assert.ok(due() >= delay && due() < delay + 100, `next check after ${delay} ms, not ${due()}`);
      assert.equal(result.nextAlarmAt, h.jobs.get('welcome')!.retryAt);
    }
    assert.equal(h.events.length, 4, 'the turn ran exactly once');
    assert.equal(rows.rows.get('welcome')!.attempts, 1, 'checks are never attempts');
    // The state store delivers the welcome and settles the turn row.
    rows.rows.get('welcome')!.status = 'done';
    h.advance(h.jobs.get('welcome')!.retryAt! - h.deps.now!());
    await runThreadRunnerAlarm(h.deps);
    assert.equal(h.jobs.get('welcome')!.state, 'done');
    assert.equal(h.events.length, 4);
    assert.deepEqual(h.jobs.runnable(h.deps.now!() + 60_000), []);
  } finally { db.close(); }
});

test('a deferred terminal the state store failed or took back settles on its next check', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['failed']);
    const h = runnerHarness(db, rows, { deferred: () => true });
    h.jobs.admit({ id: 'failed', threadKey: 'thread', payload: {} }, 1);
    await runThreadRunnerAlarm(h.deps);
    assert.equal(h.jobs.get('failed')!.state, 'deferred');
    rows.rows.get('failed')!.status = 'error';
    h.advance(2_000);
    await runThreadRunnerAlarm(h.deps);
    assert.equal(h.jobs.get('failed')!.state, 'error');
    assert.deepEqual(h.events, ['dispatch:failed', 'deferred:failed']);
  } finally { db.close(); }
});

test('a deferred terminal whose row is no longer the runner\'s is released on its next check', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['taken']);
    const h = runnerHarness(db, rows, { deferred: () => true });
    h.jobs.admit({ id: 'taken', threadKey: 'thread', payload: {} }, 1);
    await runThreadRunnerAlarm(h.deps);
    assert.equal(h.jobs.get('taken')!.state, 'deferred');
    // The state store took the row back (recovery reopened it for the alarm).
    const view = rows.turns.view.bind(rows.turns);
    rows.turns.view = async (id: string) => ({ ...(await view(id)), executor: 'alarm' });
    h.advance(2_000);
    const result = await runThreadRunnerAlarm(h.deps);
    assert.equal(h.jobs.get('taken')!.state, 'released');
    assert.deepEqual(h.events, ['dispatch:taken', 'deferred:taken'], 'a released job never runs here');
    assert.equal(result.nextAlarmAt, undefined, 'nothing is left to check');
  } finally { db.close(); }
});

test('a deferred terminal is read every 5 minutes once the outbox\'s own retries are long over', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['stuck']);
    const h = runnerHarness(db, rows, { deferred: () => true });
    h.jobs.admit({ id: 'stuck', threadKey: 'thread', payload: {} }, 1);
    await runThreadRunnerAlarm(h.deps);
    const delays: number[] = [];
    for (let check = 0; check < 52; check += 1) {
      h.advance(h.jobs.get('stuck')!.retryAt! - h.deps.now!());
      const at = h.deps.now!();
      await runThreadRunnerAlarm(h.deps);
      delays.push(Math.round((h.jobs.get('stuck')!.retryAt! - at) / 1_000));
    }
    assert.deepEqual(delays.slice(0, 5), [4, 8, 16, 30, 30]);
    const elapsedS = 2 + delays.slice(0, 48).reduce((sum, delay) => sum + delay, 0);
    assert.ok(elapsedS > 21 * 60, `30 s reads cover the outbox's retry window (${elapsedS} s)`);
    assert.deepEqual(delays.slice(48), [30, 300, 300, 300]);
  } finally { db.close(); }
});

test('a welcome the outbox gives up on settles its turn even when closing its lifecycle throws; the runner then settles error', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['welcome']);
    const h = runnerHarness(db, rows, { deferred: () => true });
    h.jobs.admit({ id: 'welcome', threadKey: 'thread', payload: {} }, 1);
    await runThreadRunnerAlarm(h.deps);
    assert.equal(h.jobs.get('welcome')!.state, 'deferred');

    const management = new ManagementStoreLogic(db);
    const at = Date.now();
    management.putOutbox({
      outboxId: 'agent_welcome_op', operationId: 'op',
      destination: { kind: 'thread', workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: '1800000000.000001' },
      receipt: {
        kind: 'agent_created_welcome', creationOperationId: 'op', presentationRunId: 'run_welcome',
        turnJobId: 'welcome', agentId: 'agent_new', agentName: 'New Agent',
        requesterMembershipId: 'member_1', surface: 'channel', persona: { name: 'New Agent' },
      },
      status: 'pending', attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at,
    });
    const cleanupFailed = new Error('presentation unavailable');
    const marked: string[] = [];
    const result = await drainManagementReceiptOutbox({
      management: management as never,
      // The channel was archived: delivery ends for good.
      deliver: async () => { throw Object.assign(new Error('archived'), { data: { error: 'is_archived' } }); },
      onTerminalFailure: (record) => failAgentWelcomeTurn(record, {
        state: { getRunPresentation: async () => { throw cleanupFailed; } } as never,
        resolveClient: async () => { throw cleanupFailed; },
      }, async (turnJobId) => {
        marked.push(turnJobId);
        await rows.turns.markError(turnJobId);
      }),
    });
    assert.equal(result.failed, 1);
    assert.deepEqual(marked, ['welcome'], 'the turn is settled although the lifecycle cleanup threw');
    assert.equal(management.getOutboxForOperation('op')!.status, 'failed');
    h.advance(2_000);
    await runThreadRunnerAlarm(h.deps);
    assert.equal(h.jobs.get('welcome')!.state, 'error');
    assert.deepEqual(h.events, ['dispatch:welcome', 'deferred:welcome']);
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
    assert.equal(first.record.reason, 'StateStoreDisconnectedError');
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
    assert.ok(h.records.some((line) => line.includes('"reason":"StateStoreDisconnectedError"')));
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
    assert.equal(first.record.outcome, 'drained', 'the turn settled; a kept claim is not a failure');
    assert.equal(first.nextAlarmAt, undefined);
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
      remote: {
        ...sharedBudgets(shared),
        matchFlueObservation: async () => undefined,
        getLatestThreadSessionGeneration: async () => 5,
      },
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

test('an outcome the state store keeps refusing backs the runner off instead of spinning', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['unrecorded']);
    rows.failNextMarkDelivered(100);
    const h = runnerHarness(db, rows);
    h.jobs.admit({ id: 'unrecorded', threadKey: 'thread', payload: {} }, 1);
    const delays: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const at = Date.now();
      const result = await runThreadRunnerAlarm(h.deps);
      assert.equal(result.record.reason, 'follow_up_failed');
      delays.push(Math.round((result.nextAlarmAt! - at) / 1_000));
    }
    assert.deepEqual(delays, [2, 4, 8, 16]);
    assert.deepEqual(h.events, ['dispatch:unrecorded', 'delivered:unrecorded'], 'one final');
  } finally { db.close(); }
});

test('a due cleanup check the state store cannot answer backs the runner off', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['checked']);
    const h = runnerHarness(db, rows);
    h.jobs.admit({ id: 'checked', threadKey: 'thread', payload: {} }, 1);
    rows.rows.get('checked')!.status = 'done';
    h.jobs.settle('checked', 'done', Date.now());
    rows.failNextViews(100);
    const delays: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const at = Date.now();
      const result = await runThreadRunnerAlarm(h.deps);
      delays.push(Math.round((result.nextAlarmAt! - at) / 1_000));
    }
    assert.deepEqual(delays, [2, 4, 8]);
    rows.failNextViews(0);
    const recovered = await runThreadRunnerAlarm(h.deps);
    assert.equal(recovered.nextAlarmAt, undefined, 'the check clears once the store answers');
    assert.equal(h.deps.failures.count, 0);
  } finally { db.close(); }
});

test('activity changes publish nothing; the generation is read once per window', async () => {
  const db = openStateDb(':memory:');
  try {
    const local = new SlackRunPresentationStoreLogic(db, () => NOW);
    let clock = NOW;
    const published: number[] = [];
    let generationReads = 0;
    const presentation = runnerPresentationState({
      local,
      remote: {
        ...sharedBudgets(local),
        matchFlueObservation: async () => undefined,
        getLatestThreadSessionGeneration: async () => {
          generationReads += 1;
          return 5;
        },
      },
      putRemote: async (value) => { published.push(value.projectionVersion); },
      now: () => clock,
    });
    let current = local.create(v3Input('run_busy', 'turn_busy'));
    const transition = async (mutation: SlackPresentationMutation) => {
      const result = await presentation.state.transitionRunPresentation({
        runId: current.runId, workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken, expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state, mutation,
      });
      assert.equal(result.outcome, 'applied');
      current = (result as { presentation: SlackRunPresentation }).presentation;
    };
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      // What one activity change does: the generation fence, the intent, the receipt.
      await presentation.state.getLatestThreadSessionGeneration(ROOT);
      const operationId = `activity_busy_${sequence}`;
      await transition({
        kind: 'set_current_activity',
        activity: {
          kind: 'checking', action: 'Checking', object: `page ${sequence}`, generation: 5, sequence,
          operation: { operationId, certainty: 'pending' },
        },
      });
      if (sequence === 1) {
        await transition({ kind: 'select_activity_projection', surface: 'assistant_status' });
      }
      await transition({ kind: 'record_activity_receipt', operationId, certainty: 'acknowledged' });
      clock += 1_000;
    }
    assert.deepEqual(published, [2],
      'the first activity starts the turn (a lifecycle change); later ones publish nothing');
    assert.equal(generationReads, 1, 'one generation read within the cache window');
    clock += 15_000;
    await presentation.state.getLatestThreadSessionGeneration(ROOT);
    assert.equal(generationReads, 2);
  } finally { db.close(); }
});

test("the runner's port books the workspace's Slack budgets in the state store, not its own SQLite", async () => {
  const runnerDbs = [openStateDb(':memory:'), openStateDb(':memory:')];
  const sharedDb = openStateDb(':memory:');
  try {
    // Every workspace-scoped budget method on the port is routed.
    const portBudgets = Object.keys(localSlackPresentationStatePort({
      presentations: new SlackRunPresentationStoreLogic(runnerDbs[0]!, () => NOW),
      matchFlueObservation: async () => undefined,
    })).filter((name) => /slack(Append|ActivityStatus)/i.test(name)).sort();
    assert.deepEqual([...RUNNER_SHARED_BUDGET_METHODS].sort(), portBudgets);

    const shared = new SlackRunPresentationStoreLogic(sharedDb, () => NOW);
    const calls: string[] = [];
    const remote = Object.fromEntries(Object.entries(sharedBudgets(shared)).map(([name, method]) => [
      name,
      async (...args: never[]) => { calls.push(name); return (method as (...a: never[]) => unknown)(...args); },
    ])) as ReturnType<typeof sharedBudgets>;
    const [a, b] = runnerDbs.map((db) => {
      const local = new SlackRunPresentationStoreLogic(db, () => NOW);
      return {
        local,
        state: runnerPresentationState({
          local,
          remote: {
            ...remote,
            matchFlueObservation: async () => undefined,
            getLatestThreadSessionGeneration: async () => undefined,
          },
          putRemote: async () => {},
        }).state,
      };
    });
    // Two threads share one burst, first come first served.
    const outcomes: string[] = [];
    for (let slot = 0; slot < DEFAULT_SLACK_APPEND_BUDGET.capacity + 2; slot += 1) {
      const runner = slot % 2 === 0 ? a! : b!;
      outcomes.push((await runner.state.reserveSlackAppend(ROOT.workspaceId)).outcome);
    }
    assert.deepEqual(outcomes, [
      ...Array(DEFAULT_SLACK_APPEND_BUDGET.capacity).fill('reserved'), 'scheduled', 'scheduled',
    ], "the second thread's bookings come after the first's in one budget");
    const [slotA, slotB] = [
      await a!.state.reserveSlackAppend(ROOT.workspaceId),
      await b!.state.reserveSlackAppend(ROOT.workspaceId),
    ];
    assert.ok(slotA.outcome === 'scheduled' && slotB.outcome === 'scheduled' && slotB.at > slotA.at);
    // A Slack rate limit one thread hit holds the other.
    const { cooldownUntil } = await a!.state.applySlackAppendCooldown(ROOT.workspaceId, 5_000);
    assert.equal(await b!.state.slackAppendCooldownUntil!(ROOT.workspaceId), cooldownUntil);
    assert.equal((await b!.state.reserveSlackAppend(ROOT.workspaceId)).outcome, 'cooldown');
    // Status writes share the workspace's status budget the same way.
    await a!.state.reserveSlackActivityStatus!(ROOT.workspaceId);
    await b!.state.applySlackActivityStatusCooldown!(ROOT.workspaceId, 1_000);
    assert.deepEqual(new Set(calls), new Set(RUNNER_SHARED_BUDGET_METHODS));
    for (const runner of [a!, b!]) {
      assert.equal(runner.local.appendCooldownUntil(ROOT.workspaceId), undefined,
        "the runner's own copy holds no budget");
      assert.equal(runner.local.reserveAppend(ROOT.workspaceId).outcome, 'reserved');
    }
  } finally {
    for (const db of [...runnerDbs, sharedDb]) db.close();
  }
});

test('an unreachable state store leaves the runner pacing itself, and a booking is never replayed', async () => {
  const db = openStateDb(':memory:');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const local = new SlackRunPresentationStoreLogic(db, () => NOW);
    let mints = 0;
    const calls: string[] = [];
    const rows = new CfTurnJobsForRunner(() => {
      mints += 1;
      const disconnect = () => {
        throw Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true });
      };
      return {
        async slackPresentationReserveAppend() { calls.push('reserve'); disconnect(); },
        async slackPresentationReserveActivityStatus() { calls.push('status'); disconnect(); },
        async slackPresentationApplyCooldown() {
          calls.push('cooldown');
          if (mints % 2 === 1) disconnect();
          return { ok: true, value: { cooldownUntil: NOW + 1_000, budgetVersion: 3 } };
        },
      } as unknown as TagStateRpc;
    });
    await assert.rejects(rows.reserveSlackAppend(ROOT.workspaceId),
      (error) => error instanceof StateStoreDisconnectedError);
    await assert.rejects(rows.reserveSlackActivityStatus(ROOT.workspaceId),
      (error) => error instanceof StateStoreDisconnectedError);
    assert.deepEqual(calls, ['reserve', 'status'], 'one attempt: a lost reply only wastes that slot');
    assert.deepEqual(await rows.applySlackAppendCooldown(ROOT.workspaceId, 1_000),
      { cooldownUntil: NOW + 1_000, budgetVersion: 3 }, 'a convergent cooldown is replayed once');
    const state = runnerPresentationState({
      local,
      remote: {
        ...sharedBudgets(local),
        reserveSlackAppend: (workspaceId) => rows.reserveSlackAppend(workspaceId),
        matchFlueObservation: async () => undefined,
        getLatestThreadSessionGeneration: async () => undefined,
      },
      putRemote: async () => {},
    }).state;
    assert.equal((await state.reserveSlackAppend(ROOT.workspaceId)).outcome, 'reserved',
      'the stream goes on, paced by its own budget');
  } finally {
    console.warn = warn;
    db.close();
  }
});

test('every store built on fresh stubs mints one per call and replays a disconnect once', async () => {
  // Amber LT4: the memory, config, usage, and work stores a turn built kept
  // one stub for the whole attempt; after a state-store reset every call on
  // it failed at once and the memory lease read as invalid.
  let mints = 0;
  const failing = new Set<number>();
  const calls: string[] = [];
  const store = new CfMemoryStateStore(new FreshTagStateStubs(() => {
    mints += 1;
    const mint = mints;
    return {
      async memoryExecute(request: { kind: string }) {
        calls.push(`${mint}:${request.kind}`);
        if (failing.has(mint)) {
          throw Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true });
        }
        if (mint === 99) return { ok: false, error: { code: 'memory_owner_invalid', message: 'x' } };
        return { ok: true, value: { kind: 'agent_memory', memory: { agentId: 'a', revision: 1, body: '' } } };
      },
    } as unknown as TagStateRpc;
  }));
  await store.getAgentMemory('a');
  await store.getAgentMemory('a');
  assert.deepEqual(calls, ['1:get_agent_memory', '2:get_agent_memory'], 'a new stub for every call');

  failing.add(3);
  await store.getAgentMemory('a');
  assert.deepEqual(calls.slice(2), ['3:get_agent_memory', '4:get_agent_memory'], 'replayed once on a new stub');

  failing.add(5);
  failing.add(6);
  await assert.rejects(store.getAgentMemory('a'), (error: unknown) =>
    error instanceof StateStoreDisconnectedError);
  assert.equal(mints, 6, 'no third call');
});

test('a write that is not idempotent is never replayed after a disconnect; a read is', async () => {
  const sent: string[] = [];
  let mints = 0;
  const usage = new CfUsageStore(new FreshTagStateStubs(() => {
    mints += 1;
    const mint = mints;
    return {
      async usageExecute(request: { kind: string }) {
        sent.push(`${mint}:${request.kind}`);
        if (mint === 1 || mint === 2) {
          throw Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true });
        }
        return { ok: true, value: { kind: 'operation', operation: null } };
      },
    } as unknown as TagStateRpc;
  }));
  // A usage row written twice would count twice: the caller (a turn) retries
  // from its own checkpoints instead.
  await assert.rejects(usage.recordTerminal({} as never), (error: unknown) =>
    error instanceof StateStoreDisconnectedError);
  assert.deepEqual(sent, ['1:record_terminal']);
  // A read is replayed once on a new stub.
  await usage.getOperation('operation').catch(() => undefined);
  assert.deepEqual(sent, ['1:record_terminal', '2:get_operation', '3:get_operation']);

  for (const [method, op] of [
    ['usageExecute', 'record_terminal'], ['usageExecute', 'admit_operation'],
    ['workExecute', 'create_execution'], ['workExecute', 'admit_shadow_run'],
    ['routinesExecute', 'claim_delivery'], ['claim', undefined], ['admitSlackTurn', undefined],
    ['configCreateAgent', undefined], ['slackInteractionProgressRecord', undefined],
  ] as const) {
    assert.equal(replaySafeStateRpc(method, op), false, `${method} ${op ?? ''}`);
  }
  for (const [method, op] of [
    ['workExecute', 'get_execution'], ['memoryExecute', 'put_agent_memory'],
    ['identityExecute', 'find_invitation'], ['configGetAgent', undefined],
    ['threadActiveWorkSet', undefined], ['slackFlueSettlementRecord', undefined],
  ] as const) {
    assert.equal(replaySafeStateRpc(method, op), true, `${method} ${op ?? ''}`);
  }
});

test("a turn's first generation check uses the value its begin round trip read", async () => {
  const db = openStateDb(':memory:');
  try {
    const local = new SlackRunPresentationStoreLogic(db, () => NOW);
    let clock = NOW;
    let generationReads = 0;
    const presentation = runnerPresentationState({
      local,
      remote: {
        ...sharedBudgets(local),
        matchFlueObservation: async () => undefined,
        getLatestThreadSessionGeneration: async () => {
          generationReads += 1;
          return 7;
        },
      },
      putRemote: async () => undefined,
      now: () => clock,
    });
    local.create(v3Input('run_seeded', 'turn_seeded'));
    presentation.seedLatestThreadSessionGeneration('run_seeded', 6);
    assert.equal(await presentation.state.getLatestThreadSessionGeneration(ROOT), 6);
    assert.equal(generationReads, 0, 'no state-store read before the first activity status');
    clock += 15_000;
    assert.equal(await presentation.state.getLatestThreadSessionGeneration(ROOT), 7,
      'the seeded value ages out like any cached read');
    assert.equal(generationReads, 1);

    // A state store that did not send one (an older version) leaves the read to the turn.
    local.create({ ...v3Input('run_unseeded', 'turn_unseeded'), root: { ...ROOT, threadTs: '1800000000.000002' } });
    presentation.seedLatestThreadSessionGeneration('run_unseeded', undefined);
    await presentation.state.getLatestThreadSessionGeneration({ ...ROOT, threadTs: '1800000000.000002' });
    assert.equal(generationReads, 2);
    // A thread with no V3 generation yet is cached as none.
    local.create({ ...v3Input('run_none', 'turn_none'), root: { ...ROOT, threadTs: '1800000000.000003' } });
    presentation.seedLatestThreadSessionGeneration('run_none', null);
    assert.equal(
      await presentation.state.getLatestThreadSessionGeneration({ ...ROOT, threadTs: '1800000000.000003' }),
      5,
      'only the local copy remains',
    );
    assert.equal(generationReads, 2);
  } finally { db.close(); }
});

/** Stubs for CfTurnJobsForRunner: `fail` decides which minted stub rejects. */
function mintingStubs(fail: (mint: number, kind: string) => boolean) {
  let mints = 0;
  const kinds: string[] = [];
  const mint = () => {
    mints += 1;
    const mint = mints;
    return {
      async threadRunnerTurn(op: { kind: string }) {
        kinds.push(`${mint}:${op.kind}`);
        if (fail(mint, op.kind)) throw new Error('Durable Object reset because its code was updated.');
        return { ok: true, value: null };
      },
    } as unknown as TagStateRpc;
  };
  return { mint, kinds, mints: () => mints };
}

test('every runner store call mints a fresh stub and replays once after a reset', async () => {
  const stubs = mintingStubs((mint) => mint === 1);
  const store = new CfTurnJobsForRunner(stubs.mint);
  await store.markDelivered('turn_reset');
  assert.deepEqual(stubs.kinds, ['1:markDelivered', '2:markDelivered'], 'replayed on a new stub');
  await store.markError('turn_other');
  assert.equal(stubs.mints(), 3, 'no stub is reused across calls');

  const down = mintingStubs(() => true);
  await assert.rejects(new CfTurnJobsForRunner(down.mint).markDelivered('turn_down'),
    (error: unknown) => error instanceof StateStoreDisconnectedError);
  assert.equal(down.mints(), 2, 'one replay only');

  const plain = new CfTurnJobsForRunner(() => ({
    async threadRunnerTurn() { return { ok: false, error: { code: 'internal', message: 'boom' } }; },
  }) as unknown as TagStateRpc);
  await assert.rejects(plain.markDelivered('turn_boom'), /boom/, 'a store error is never replayed');
});

test('a final whose outcome record hits a store reset is recorded once, with no failure notice', async () => {
  const db = openStateDb(':memory:');
  try {
    const jobs = new ThreadRunnerJobStore(db);
    jobs.admit({ id: 'reset', threadKey: 'thread', payload: {} }, 1);
    const stubs = mintingStubs((mint, kind) => mint === 1 && kind === 'markDelivered');
    const port = runnerTurnJobsPort(new CfTurnJobsForRunner(stubs.mint), jobs);
    await port.markDelivered('reset');
    assert.deepEqual(stubs.kinds, ['1:markDelivered', '2:markDelivered']);
    assert.equal(jobs.get('reset')!.state, 'done');
    assert.equal(jobs.get('reset')!.terminalSync, undefined, 'recorded; nothing owed');
  } finally { db.close(); }
});

test('a store that stays unreachable mid-turn is retried, never answered with a failure notice', async () => {
  const db = openStateDb(':memory:');
  try {
    const jobs = new ThreadRunnerJobStore(db);
    const failure = new StateStoreUnavailable();
    assert.ok(failure instanceof AgentPromptFailure && failure.retryable,
      'run-turn passes retryable prompt failures through without a final');
    const attempts: number[] = [];
    const port = runnerTurnJobsPort({
      recordAttempt: async (_id: string, value: number) => { attempts.push(value); },
      recordFlueSettlement: async () => { throw new StateStoreDisconnectedError(new Error('reset')); },
    } as unknown as TurnExecutionPorts['turnJobs'], jobs);
    const finals: string[] = [];
    const retries: Array<number | undefined> = [];
    const settled = await executeTurnJob({
      ...turnJob('mid'), executionAuthority: 'legacy', attempts: 2, progress: {},
      dispatchEnvelope: { instanceId: 'agent' } as never,
      dispatchReceipt: { submissionId: 'submission_mid', acceptedAt: new Date().toISOString() } as never,
    } as PendingTurnJob, {
      env: {},
      turnJobs: port,
      slack: { setActiveWork: async () => {}, release: async () => {}, markCodingActiveWork: async () => {} },
      config: {},
      presentationState: {},
      telemetry: { capture() {} },
      resolveInstallation: async () => ({
        workspaceId: 'T_TEST',
        client: { conversations: { info: async () => ({ ok: true, channel: { id: 'C_TEST', is_member: true } }) } },
      }),
      sandboxes: () => [],
      runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
        if (options.replayTerminalResult === 'failure') finals.push('recovery');
        await options.flueDispatch!.recordSettlement({ outcome: 'completed' } as never);
        finals.push('answer');
      },
    } as unknown as TurnExecutionPorts, {
      latency: { lane: 'cloudflare', executor: 'runner' },
      onRetry: (afterMs) => { retries.push(afterMs); },
    });
    assert.equal(settled, false, 'the turn stays pending for its next attempt');
    assert.deepEqual(finals, [], 'no final of any kind');
    assert.deepEqual(retries, [undefined]);
    assert.deepEqual(attempts, [3, 2], 'the attempt is given back');

    // Past the submission's durability the retry is no longer free: it spends
    // the attempt, so the post-dispatch cap ends the turn with the notice.
    const lateAttempts: number[] = [];
    const late = await executeTurnJob({
      ...turnJob('late'), executionAuthority: 'legacy', attempts: 2, progress: {},
      dispatchEnvelope: { instanceId: 'agent' } as never,
      dispatchReceipt: {
        submissionId: 'submission_late',
        acceptedAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
      } as never,
    } as PendingTurnJob, {
      env: {},
      turnJobs: runnerTurnJobsPort({
        recordAttempt: async (_id: string, value: number) => { lateAttempts.push(value); },
        recordFlueSettlement: async () => { throw new StateStoreDisconnectedError(new Error('reset')); },
      } as unknown as TurnExecutionPorts['turnJobs'], jobs),
      slack: { setActiveWork: async () => {}, release: async () => {}, markCodingActiveWork: async () => {} },
      config: {},
      presentationState: {},
      telemetry: { capture() {} },
      resolveInstallation: async () => ({
        workspaceId: 'T_TEST',
        client: { conversations: { info: async () => ({ ok: true, channel: { id: 'C_TEST', is_member: true } }) } },
      }),
      sandboxes: () => [],
      runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
        await options.flueDispatch!.recordSettlement({ outcome: 'completed' } as never);
      },
    } as unknown as TurnExecutionPorts, {
      latency: { lane: 'cloudflare', executor: 'runner' },
      onRetry: () => {},
    });
    assert.equal(late, false);
    assert.deepEqual(lateAttempts, [3], 'the attempt is spent');
  } finally { db.close(); }
});

test('a runner starts a turn with one state-store round trip before running it', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['first']);
    const h = runnerHarness(db, rows);
    h.jobs.admit({ id: 'first', threadKey: 'thread', payload: {} }, 1);
    const execute = h.deps.execute;
    let callsBeforeExecute: string[] = [];
    h.deps.execute = (...args) => {
      callsBeforeExecute = [...rows.calls];
      return execute(...args);
    };
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(callsBeforeExecute, ['begin:first']);
  } finally { db.close(); }
});

test('a runner backs off a turn whose state store stays unreachable (1 s, then 2 s)', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['outage']);
    const h = runnerHarness(db, rows, { storeOutage: () => true });
    h.jobs.admit({ id: 'outage', threadKey: 'thread', payload: {} }, 1);
    const delays: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      const at = h.deps.now!();
      const result = await runThreadRunnerAlarm(h.deps);
      assert.equal(result.record.reason, 'state_store_unavailable');
      delays.push(Math.round((result.nextAlarmAt! - at) / 1_000));
      h.advance(10_000);
    }
    assert.deepEqual(delays, [1, 2], 'a store being replaced is retried quickly (1 s doubling to 8 s)');
    assert.equal(rows.rows.get('outage')!.attempts, 0, 'no attempt spent inside the durability window');
  } finally { db.close(); }
});

test('a state-store disconnect escaping the turn is retried like an outage, never failed', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['reset']);
    const h = runnerHarness(db, rows, { storeReset: () => true });
    h.jobs.admit({ id: 'reset', threadKey: 'thread', payload: {} }, 1);
    const result = await runThreadRunnerAlarm(h.deps);
    assert.equal(result.record.reason, 'state_store_unavailable');
    assert.equal(rows.rows.get('reset')!.attempts, 0, 'no attempt spent inside the durability window');
    assert.equal(h.events.some((event) => event.startsWith('failed:')), false);
    assert.equal(rows.rows.get('reset')!.status, 'pending', 'the turn is kept for its retry');
  } finally { db.close(); }
});

test('a retryable Slack or gateway outage escaping the turn keeps its bounded, counted retries', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['slack']);
    const h = runnerHarness(db, rows, { slackOutage: () => true });
    h.jobs.admit({ id: 'slack', threadKey: 'thread', payload: {} }, 1);
    const result = await runThreadRunnerAlarm(h.deps);
    assert.notEqual(result.record.reason, 'state_store_unavailable');
    assert.equal(rows.rows.get('slack')!.attempts, 1, 'the attempt is spent, so the caps still end it');
  } finally { db.close(); }
});

test('a running job keeps a wake a few seconds ahead, so a replaced runner resumes promptly', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['long']);
    const h = runnerHarness(db, rows, { hold: () => true });
    const armed: number[] = [];
    h.deps.armBackstop = async (at) => { armed.push(at - (h.deps.now!())); };
    h.deps.heartbeatMs = 5;
    h.jobs.admit({ id: 'long', threadKey: 'thread', payload: {} }, 1);
    await runThreadRunnerAlarm(h.deps);
    assert.ok(armed.length >= 3, `the wake is refreshed while the job runs (${armed.length})`);
    assert.ok(armed.every((ahead) => ahead > 0 && ahead <= 5_000), 'always at most 5 s ahead');
  } finally { db.close(); }
});

test('a runner whose state store is being replaced retries within seconds', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['reset']);
    const h = runnerHarness(db, rows);
    h.jobs.admit({ id: 'reset', threadKey: 'thread', payload: {} }, 1);
    rows.turns.begin = async () => {
      throw new Error('Durable Object reset because its code was updated.');
    };
    const at = h.deps.now!();
    const result = await runThreadRunnerAlarm(h.deps);
    assert.equal(result.record.outcome, 'threw');
    assert.equal(Math.round((result.nextAlarmAt! - at) / 1_000), 1, 'a store reset is retried after a second');
  } finally { db.close(); }
});

test('a joined alarm never starts a second loop budget after a yield in the same call', async () => {
  const record = (yielded: boolean) => ({
    record: { jobs: 1, ran: 1, yielded, carried: 0, durationMs: 0, outcome: 'drained' as const },
    ...(yielded ? { nextAlarmAt: 1_000 } : {}),
  });
  for (const yielded of [true, false]) {
    let runs = 0;
    const armed: Array<number | undefined> = [];
    let joined: Promise<void> | undefined;
    const runSoon = runnerLoopScheduler({
      runOnce: async () => {
        runs += 1;
        if (runs === 1) {
          // The 5 s backstop alarm fires while the admit-started loop runs.
          joined = runSoon();
          // Slow post-job work (publish, repair, purge) after the budget.
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return record(runs === 1 && yielded);
      },
      arm: async (at) => { armed.push(at); },
    });
    await runSoon();
    await joined;
    if (yielded) {
      assert.equal(runs, 1, 'the re-armed alarm reattaches; no second budget in this call');
      assert.deepEqual(armed, [1_000]);
    } else {
      assert.equal(runs, 2, 'work that arrived after the last listing runs once more');
      assert.deepEqual(armed, [undefined, undefined]);
    }
  }
});

const OLD_VERSION = '11111111-1111-4111-8111-111111111111';
const NEW_VERSION = '22222222-2222-4222-8222-222222222222';

/**
 * A runner on OLD_VERSION whose state store serves `serving()` from `begin`
 * and from the heartbeat's version check.
 */
function versionedHarness(
  db: ReturnType<typeof openStateDb>,
  rows: ReturnType<typeof fakeRows>,
  serving: () => string,
  script: Parameters<typeof runnerHarness>[2] = {},
) {
  const h = runnerHarness(db, rows, script);
  const begin = rows.turns.begin.bind(rows.turns);
  rows.turns.begin = async (id: string) => ({ ...(await begin(id)), servingVersion: serving() });
  let checks = 0;
  (rows.turns as { servingVersion?: () => Promise<string> }).servingVersion = async () => {
    checks += 1;
    return serving();
  };
  h.deps.versionId = OLD_VERSION;
  h.deps.supersede = createRunnerSupersedeState();
  h.deps.budgetMs = 60_000;
  h.deps.hardCapMs = 120_000;
  h.deps.heartbeatMs = 2;
  h.deps.versionCheckMs = 5;
  return { ...h, checks: () => checks };
}

test('a runner whose version a code update replaced yields its turn within one version check', async () => {
  // Amber run 6: the old version's runner alarm observed its turn to the end
  // (138 s, 146 s) and the new version's alarm waited behind it: the turn
  // came back 1 m 46 s / 1 m 49 s after the upload. Here it would observe
  // for the whole 60 s budget.
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['long']);
    let serving = OLD_VERSION;
    let holding = true;
    const h = versionedHarness(db, rows, () => serving, { hold: (id) => id === 'long' && holding });
    h.jobs.admit({ id: 'long', threadKey: 'thread', payload: {} }, 1);
    const alarm = runThreadRunnerAlarm(h.deps);
    while (!h.events.includes('dispatch:long')) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(h.events, ['dispatch:long'], 'the same version keeps observing');
    const updatedAt = performance.now();
    serving = NEW_VERSION; // the upload: the state store now answers from the new code
    const first = await alarm;
    const tookMs = performance.now() - updatedAt;
    assert.ok(tookMs < 1_000, `the old alarm returns within a version check (${Math.round(tookMs)} ms)`);
    assert.deepEqual(h.events, ['dispatch:long', 'yield:long']);
    assert.equal(first.record.yielded, true);
    assert.equal(first.record.supersededBy, NEW_VERSION);
    assert.equal(first.record.versionId, OLD_VERSION);
    assert.equal(h.jobs.get('long')!.state, 'yielded');
    assert.equal(rows.rows.get('long')!.attempts, 0, 'a yield for a code update is never an attempt');
    const ahead = first.nextAlarmAt! - h.deps.now!();
    assert.ok(ahead > 0 && ahead <= 1_000, `the successor alarm is a second out (${ahead} ms)`);
    const superseded = h.records.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === 'thread_runner_superseded');
    assert.deepEqual(superseded, [{
      component: 'runtime', event: 'thread_runner_superseded',
      versionId: OLD_VERSION, supersededBy: NEW_VERSION, running: true,
    }]);
    // The successor alarm, on the new version, reattaches: one dispatch, one final.
    holding = false;
    h.advance(1_000);
    h.deps.versionId = NEW_VERSION;
    h.deps.supersede = createRunnerSupersedeState();
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events.slice(2), ['reattach:long', 'delivered:long']);
    assert.equal(rows.rows.get('long')!.status, 'done');
  } finally { db.close(); }
});

test('a runner that loses its storage mid-turn yields at once', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['long']);
    const h = versionedHarness(db, rows, () => OLD_VERSION, { hold: (id) => id === 'long' });
    let storageLost = false;
    h.deps.armBackstop = async () => {
      if (storageLost) throw new Error('Durable Object reset because its code was updated.');
    };
    h.jobs.admit({ id: 'long', threadKey: 'thread', payload: {} }, 1);
    const alarm = runThreadRunnerAlarm(h.deps);
    while (!h.events.includes('dispatch:long')) await new Promise((resolve) => setTimeout(resolve, 1));
    storageLost = true;
    const first = await alarm;
    assert.deepEqual(h.events, ['dispatch:long', 'yield:long']);
    assert.equal(first.record.supersededBy, 'storage_lost');
    assert.equal(rows.rows.get('long')!.attempts, 0);
  } finally { db.close(); }
});

test('a code update seen between jobs holds the next job for the new version', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['first', 'second']);
    let serving = OLD_VERSION;
    const h = versionedHarness(db, rows, () => serving);
    h.jobs.admit({ id: 'first', threadKey: 'thread', payload: {} }, 1);
    h.jobs.admit({ id: 'second', threadKey: 'thread', payload: {} }, 2);
    const originalExecute = h.deps.execute;
    h.deps.execute = async (...args) => {
      const settled = await originalExecute(...args);
      serving = NEW_VERSION; // the upload lands as the first job finishes
      return settled;
    };
    const first = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:first', 'delivered:first'],
      'the second job never starts on the old version');
    assert.equal(first.record.supersededBy, NEW_VERSION);
    assert.equal(h.jobs.get('second')!.state, 'admitted');
    assert.ok(first.nextAlarmAt! - h.deps.now!() >= 1_000 - 5, 'the successor is a second out, not a spin');
    // The successor, on the new version, runs it once.
    h.advance(1_000);
    h.deps.execute = originalExecute;
    h.deps.versionId = NEW_VERSION;
    h.deps.supersede = createRunnerSupersedeState();
    await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events.slice(2), ['dispatch:second', 'delivered:second']);
  } finally { db.close(); }
});

test('a deferred check on a superseded alarm settles or backs off without holding; the next turn waits for the new version', async () => {
  for (const outcome of ['done', 'pending'] as const) {
    const db = openStateDb(':memory:');
    try {
      const rows = fakeRows(['first', 'welcome', 'next']);
      const h = versionedHarness(db, rows, () => OLD_VERSION);
      h.jobs.admit({ id: 'first', threadKey: 'thread', payload: {} }, 1);
      h.jobs.admit({ id: 'welcome', threadKey: 'thread', payload: {} }, 2);
      h.jobs.admit({ id: 'next', threadKey: 'thread', payload: {} }, 3);
      // The welcome turn already ran and deferred its terminal; its check is due.
      h.jobs.settle('welcome', 'deferred', 0, 0);
      rows.rows.get('welcome')!.attempts = 1;
      if (outcome === 'done') rows.rows.get('welcome')!.status = 'done';
      const originalExecute = h.deps.execute;
      h.deps.execute = async (...args) => {
        const settled = await originalExecute(...args);
        // A code update is noticed as the first job finishes.
        h.deps.supersede!.by = NEW_VERSION;
        return settled;
      };
      const calls = () => rows.calls.filter((call) => call.endsWith(':welcome'));
      const at = h.deps.now!();
      const result = await runThreadRunnerAlarm(h.deps);
      assert.deepEqual(h.events, ['dispatch:first', 'delivered:first'], `${outcome}: nothing else runs`);
      // A settled row also gets the usual interaction-cleanup check (a second read).
      assert.deepEqual(calls(), outcome === 'done' ? ['view:welcome', 'view:welcome'] : ['view:welcome'],
        `${outcome}: the deferred check only reads the row, never begins the turn`);
      assert.equal(result.record.supersededBy, NEW_VERSION);
      assert.equal(h.jobs.get('next')!.state, 'admitted', 'the next turn waits for the new version');
      if (outcome === 'done') {
        assert.equal(h.jobs.get('welcome')!.state, 'done');
      } else {
        const welcome = h.jobs.get('welcome')!;
        assert.equal(welcome.state, 'deferred');
        assert.ok(welcome.retryAt! - at >= 4_000 && welcome.retryAt! - at < 4_100,
          'a pending row backs off as on any alarm');
        assert.deepEqual(h.jobs.runnable(h.deps.now!()).map((job) => job.id), ['next'],
          'the deferred job never holds the thread');
      }
      assert.equal(rows.rows.get('welcome')!.attempts, 1, 'a check is never an attempt');
    } finally { db.close(); }
  }
});

test('a signal left over from an earlier alarm does not hold the next one', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['only']);
    const h = versionedHarness(db, rows, () => OLD_VERSION);
    h.deps.supersede!.by = 'storage_lost';
    h.jobs.admit({ id: 'only', threadKey: 'thread', payload: {} }, 1);
    const result = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:only', 'delivered:only']);
    assert.equal(result.record.supersededBy, undefined);
  } finally { db.close(); }
});

test('an instance kept on its version yields once per serving version, then runs', async () => {
  // A gradual deployment (or rollback) can leave this runner on its version
  // while the state store serves another: one yield, never a loop.
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['job']);
    const h = versionedHarness(db, rows, () => NEW_VERSION);
    h.jobs.admit({ id: 'job', threadKey: 'thread', payload: {} }, 1);
    const first = await runThreadRunnerAlarm(h.deps);
    assert.equal(first.record.supersededBy, NEW_VERSION);
    assert.deepEqual(h.events, []);
    h.advance(1_000);
    const second = await runThreadRunnerAlarm(h.deps);
    assert.equal(second.record.supersededBy, undefined);
    assert.deepEqual(h.events, ['dispatch:job', 'delivered:job']);
  } finally { db.close(); }
});

test('without a version of its own the runner never yields for a version', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['job']);
    const h = versionedHarness(db, rows, () => NEW_VERSION);
    delete h.deps.versionId;
    h.jobs.admit({ id: 'job', threadKey: 'thread', payload: {} }, 1);
    const result = await runThreadRunnerAlarm(h.deps);
    assert.deepEqual(h.events, ['dispatch:job', 'delivered:job']);
    assert.equal(result.record.supersededBy, undefined);
    assert.equal(h.checks(), 0);
  } finally { db.close(); }
});

test('a staggered release gets one more yield after the cool-down, at most three per version', async () => {
  // The state store reached the new version before this runner's host did:
  // the first yield ran again on the old version. Its next alarm may yield
  // again once the cool-down passed; a runner kept on its version stops.
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['job']);
    const h = versionedHarness(db, rows, () => NEW_VERSION);
    h.jobs.admit({ id: 'job', threadKey: 'thread', payload: {} }, 1);
    const outcomes: Array<string | undefined> = [];
    for (const step of [0, 1_000, THREAD_RUNNER_SUPERSEDE_COOLDOWN_MS, THREAD_RUNNER_SUPERSEDE_COOLDOWN_MS]) {
      h.advance(step);
      outcomes.push((await runThreadRunnerAlarm(h.deps)).record.supersededBy);
      if (h.events.length > 0) break;
    }
    assert.deepEqual(outcomes, [NEW_VERSION, undefined], 'within the cool-down the job runs');
    assert.deepEqual(h.events, ['dispatch:job', 'delivered:job']);

    const capped = fakeRows(['long']);
    const c = versionedHarness(openStateDb(':memory:'), capped, () => NEW_VERSION);
    c.jobs.admit({ id: 'long', threadKey: 'thread', payload: {} }, 1);
    const yields: Array<string | undefined> = [];
    for (let alarm = 0; alarm < 4; alarm += 1) {
      yields.push((await runThreadRunnerAlarm(c.deps)).record.supersededBy);
      c.advance(THREAD_RUNNER_SUPERSEDE_COOLDOWN_MS);
    }
    assert.deepEqual(yields, [NEW_VERSION, NEW_VERSION, NEW_VERSION, undefined],
      'three yields for one version, then the runner runs its turn');
    assert.deepEqual(c.events, ['dispatch:long', 'delivered:long']);
  } finally { db.close(); }
});

test('a version check that settles after its alarm ended never holds the next alarm', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['first', 'second']);
    let serving = OLD_VERSION;
    const h = versionedHarness(db, rows, () => serving, { hold: (id) => id === 'first' });
    h.deps.budgetMs = 40;
    let releaseCheck!: (version: string) => void;
    (rows.turns as { servingVersion?: () => Promise<string> }).servingVersion = () =>
      new Promise((resolve) => { releaseCheck = resolve; });
    h.jobs.admit({ id: 'first', threadKey: 'thread', payload: {} }, 1);
    const first = await runThreadRunnerAlarm(h.deps);
    assert.equal(first.record.yielded, true, 'the first alarm ends at its budget');
    assert.ok(releaseCheck, 'a version check was still in flight');
    serving = OLD_VERSION;
    releaseCheck(NEW_VERSION); // settles late, after that alarm ended
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.deps.supersede!.by, undefined, 'the late signal is ignored');
    h.jobs.admit({ id: 'second', threadKey: 'thread', payload: {} }, 2);
    h.advance(1_000);
    const next = await runThreadRunnerAlarm(h.deps);
    assert.equal(next.record.supersededBy, undefined);
  } finally { db.close(); }
});

test('a heartbeat storage failure after its alarm ended never holds the next alarm', async () => {
  const db = openStateDb(':memory:');
  try {
    const rows = fakeRows(['job']);
    const h = versionedHarness(db, rows, () => OLD_VERSION);
    let rejectLate!: () => void;
    const originalExecute = h.deps.execute;
    h.deps.execute = async (...args) => {
      // Heartbeat arms from here on settle only after the alarm ends.
      h.deps.armBackstop = () => new Promise((_resolve, reject) => { rejectLate = () => reject(new Error('reset')); });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalExecute(...args);
    };
    h.jobs.admit({ id: 'job', threadKey: 'thread', payload: {} }, 1);
    await runThreadRunnerAlarm(h.deps);
    assert.ok(rejectLate, 'a heartbeat arm was still in flight when the alarm ended');
    rejectLate();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.deps.supersede!.by, undefined, 'the late storage failure is ignored');
  } finally { db.close(); }
});
