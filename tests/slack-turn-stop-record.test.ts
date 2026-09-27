import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  SlackStateLogic,
  SqliteSlackStateStore,
  slackSessionGenerationFromTimestamp,
} from '../src/slack/claim-store.ts';
import { AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import { localSlackStateStore } from '../src/slack/local-state-store.ts';
import { hasRetryableTerminalRepair } from '../src/slack/presentation-repair.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackRunPresentationV3,
} from '../src/slack/run-presentations.ts';
import type { RunTurnOptions } from '../src/slack/run-turn.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { runThreadRunnerAlarm, type ThreadRunnerLoopDeps } from '../src/slack/thread-runner-loop.ts';
import {
  executeTurnJob,
  type TurnExecutionOptions,
  type TurnExecutionPorts,
} from '../src/slack/turn-executor.ts';
import type { TurnJob, TurnSteeringRequest } from '../src/slack/turn-job-types.ts';
import {
  deliverDueStopNotices,
  isTurnJobStopRefusal,
  TURN_STOP_HOLD_RETRY_MS,
  TurnJobStopRefusal,
  TurnJobStoreLogic,
  turnJobStopGate,
  turnStopThreadKey,
  type PendingTurnJob,
} from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
import type { RunId } from '../src/work/types.ts';
import { recordingDb } from './fixtures/state-db/maintenance.ts';

const NOW = 1_800_000_000_000;
const THREAD_TS = '1800000000.000100';
const THREAD = `T_STOP:C_STOP:${THREAD_TS}`;
const RUNNER_KEY = `${THREAD}:owner-i1`;
const UID = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function turn(messageTs: string, overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T_STOP', channelId: 'C_STOP', eventId: `Ev_${messageTs}`,
    text: 'Do the work', userId: 'U_MEMBER', messageTs, threadTs: THREAD_TS,
    source: 'app_mention', contextMode: 'thread', channelType: 'channel',
    ...overrides,
  };
}

function assignment(overrides: Partial<ResolvedAssignment> = {}): ResolvedAssignment {
  return {
    workspaceId: 'T_STOP', channelId: 'C_STOP', agentId: 'agent_stop', model: 'local-stub/stop',
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_stop', kind: 'user', revision: 1, name: 'Stop', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
    ...overrides,
  };
}

/** A turn in the stop thread posted at `.000<suffix>`. */
function job(id: string, suffix: string, overrides: Partial<NormalizedSlackTurn> = {}): TurnJob {
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`,
    turn: turn(`1800000000.000${suffix}`, overrides), assignment: assignment(),
  };
}

function stop(suffix: string, overrides: Partial<Extract<TurnSteeringRequest, { kind: 'stop' }>> = {}) {
  return {
    kind: 'stop' as const, threadKey: THREAD, source: 'typed' as const,
    stopperUserId: 'U_STOPPER', cutoffTs: `1800000000.000${suffix}`, ...overrides,
  };
}

/** Freeze, prepare and admit the row's Flue dispatch, as a running turn has. */
function dispatch(turns: TurnJobStoreLogic, queued: TurnJob): void {
  turns.freezeRuntimePlan(queued.id, compileRuntimePlanV2({
    turn: queued.turn, assignment: queued.assignment, instructions: 'Help.', memoryEpoch: 1,
  }));
  turns.prepareFlueDispatch(queued.id, 'Do the work', { generation: queued.id });
  turns.recordFlueReceipt(queued.id, {
    submissionId: `sub_${queued.id}`, acceptedAt: '2026-09-26T12:00:00.000Z', uid: UID,
  });
}

function store(clock: { now: number } = { now: NOW }) {
  const db = openStateDb(':memory:');
  return { db, turns: new TurnJobStoreLogic(db, () => clock.now), clock };
}

function stopOf(turns: TurnJobStoreLogic, id: string) {
  return turns.runnerView(id).job?.stop;
}

// ── the stop transaction ───────────────────────────────────────────────

test('a stop stamps the running row, holds the unread rows before it, and the ending drops and counts them', () => {
  const { db, turns } = store();
  try {
    const running = job('running', '101');
    turns.enqueue(running);
    turns.enqueue(job('unread_1', '102'));
    turns.enqueue(job('unread_2', '103'));
    dispatch(turns, running);

    const decision = turns.steer(stop('110'));
    assert.equal(decision.outcome, 'stopped');
    const result = decision.outcome === 'stopped' ? decision.stop : undefined;
    assert.equal(result?.created, true);
    assert.equal(result?.headId, 'running');
    assert.equal(result?.runnerKey, RUNNER_KEY);
    assert.equal(result?.executor, 'alarm');
    assert.equal(result?.held, 2);
    assert.equal(result?.dispatchEnvelope?.instanceId, turns.getDispatchEnvelope('running')?.instanceId);
    assert.equal(result?.dispatchReceipt?.uid, UID);
    assert.deepEqual(result?.record, {
      schemaVersion: 1, role: 'stopped', source: 'typed', stopperUserId: 'U_STOPPER',
      cutoffTs: '1800000000.000110', stoppedAt: NOW,
    });
    assert.deepEqual(stopOf(turns, 'running'), result?.record);
    for (const id of ['unread_1', 'unread_2']) {
      assert.deepEqual(stopOf(turns, id), { schemaVersion: 1, role: 'held', headId: 'running', at: NOW });
      assert.equal(turnJobStopGate(turns.runnerView(id).job!), 'hold');
    }
    assert.equal(turnJobStopGate(turns.runnerView('running').job!), 'stopped',
      'a dispatched stopped row reattaches to read its aborted settlement');

    const finish = turns.finishStop('running', 'dropped');
    assert.equal(finish?.outcome, 'dropped');
    assert.equal(finish?.count, 2);
    assert.deepEqual(finish?.rows.map((row) => row.id), ['unread_1', 'unread_2']);
    for (const id of ['unread_1', 'unread_2']) {
      const row = db.get('SELECT delivered, status, stop_json FROM turn_jobs WHERE id = ?', id);
      assert.equal(row?.delivered, 1, 'an older release never re-dispatches a dropped row');
      assert.equal(row?.status, 'done', 'nor maps it to error');
      assert.equal(JSON.parse(String(row?.stop_json)).role, 'dropped');
      assert.equal(turns.runnerView(id).status, 'done');
    }
    assert.equal(turns.runnerView('running').status, 'pending', 'the stopped ending settles the head itself');
    assert.deepEqual(stopOf(turns, 'running'), {
      ...result!.record, ending: { outcome: 'dropped', count: 2, at: NOW },
    });
    assert.deepEqual(turns.finishStop('running', 'released'), finish,
      'finishing again returns the first ending');
    assert.equal(turns.finishStop('unread_1', 'dropped'), undefined, 'only a stopped head finishes');
  } finally { db.close(); }
});

test('a second stop for the same run returns the first record and holds nothing more', () => {
  const { db, turns, clock } = store();
  try {
    turns.enqueue(job('running', '101'));
    turns.enqueue(job('unread', '102'));
    const first = turns.steer(stop('110'));
    clock.now += 1_000;
    turns.enqueue(job('after', '111'));
    const second = turns.steer(stop('120', { source: 'button', stopperUserId: 'U_OTHER' }));
    assert.equal(first.outcome, 'stopped');
    assert.equal(second.outcome, 'stopped');
    if (first.outcome !== 'stopped' || second.outcome !== 'stopped') return;
    assert.equal(second.stop.created, false);
    assert.equal(second.stop.headId, first.stop.headId);
    assert.deepEqual(second.stop.record, first.stop.record, 'the first stopper and cutoff stand');
    assert.equal(second.stop.held, first.stop.held);
    assert.equal(stopOf(turns, 'after'), undefined, 'the repeat holds nothing more');
    assert.equal(turns.listDueStopNotices(clock.now).length, 1, 'one stop owes one notice');
  } finally { db.close(); }
});

test('a message posted after the stop is untouched and runs normally, even when Slack delivers it first', () => {
  const { db, turns } = store();
  try {
    turns.enqueue(job('running', '101'));
    turns.steer(stop('110'));
    // Reversed arrival: the later message is admitted before the earlier one.
    turns.enqueue(job('posted_after', '111'));
    turns.enqueue(job('posted_before', '105'));
    assert.equal(stopOf(turns, 'posted_after'), undefined);
    assert.equal(turnJobStopGate(turns.runnerView('posted_after').job!), 'run');
    assert.deepEqual(stopOf(turns, 'posted_before'), {
      schemaVersion: 1, role: 'held', headId: 'running', at: NOW,
    });
    assert.equal(turns.finishStop('running', 'dropped')?.count, 1);
    assert.equal(turns.runnerView('posted_after').status, 'pending');
    assert.equal(turnJobStopGate(turns.runnerView('posted_after').job!), 'run');
  } finally { db.close(); }
});

test('a message posted before the stop but delivered after it is held and counted until the ending finishes', () => {
  const { db, turns } = store();
  try {
    turns.enqueue(job('running', '101'));
    turns.enqueue(job('unread', '102'));
    const decision = turns.steer(stop('110'));
    assert.equal(decision.outcome === 'stopped' ? decision.stop.held : -1, 1);
    turns.enqueue(job('late', '103'));
    assert.equal(stopOf(turns, 'late')?.role, 'held', 'held at admission while the ending is unfinished');
    const repeat = turns.steer(stop('110'));
    assert.equal(repeat.outcome === 'stopped' ? repeat.stop.held : -1, 2);
    assert.deepEqual(turns.finishStop('running', 'dropped')?.rows.map((row) => row.id), ['unread', 'late']);
    turns.enqueue(job('very_late', '104'));
    assert.equal(stopOf(turns, 'very_late'), undefined, 'after the ending it runs as an ordinary turn');
  } finally { db.close(); }
});

// ── intercept or enqueue ───────────────────────────────────────────────

test('a stop right after the thread first message is intercepted, never enqueued', () => {
  const { db, turns } = store();
  try {
    turns.enqueue(job('first', '101'));
    const stopMessage = job('stop_message', '102', { text: 'stop' });
    const decision = turns.steer(stop('102'), stopMessage);
    assert.equal(decision.outcome, 'stopped');
    assert.equal(decision.outcome === 'stopped' ? decision.stop.headId : undefined, 'first');
    assert.equal(decision.outcome === 'stopped' ? decision.stop.dispatchEnvelope : 'none', undefined);
    assert.equal(turns.runnerView('stop_message').status, 'missing', 'the stop is not a TurnJob');
    assert.equal(turnJobStopGate(turns.runnerView('first').job!), 'stopped_before_dispatch');
  } finally { db.close(); }
});

test('with no undelivered rows a stop or check-in enqueues as an ordinary message, in the same transaction', () => {
  const { db, turns } = store();
  try {
    const stopMessage = job('stop_message', '101', { text: 'stop' });
    assert.deepEqual(turns.steer(stop('101'), stopMessage),
      { outcome: 'enqueue', undelivered: false, enqueued: true });
    assert.equal(turns.runnerView('stop_message').status, 'pending');
    assert.equal(stopOf(turns, 'stop_message'), undefined);
    turns.markDelivered('stop_message');
    assert.deepEqual(turns.steer({ kind: 'check_in', threadKey: THREAD }),
      { outcome: 'enqueue', undelivered: false });
    assert.throws(() => turns.steer(stop('102'), job('elsewhere', '102', { threadTs: '1800000000.000999' })),
      /thread/, 'the enqueued job must belong to the steered thread');
    assert.throws(() => turns.steer(stop('102', { cutoffTs: 'soon' })), /cutoff/);
    assert.throws(() => turns.steer(stop('102', { threadKey: `${THREAD}:owner-i1` })), /thread key/,
      'a runner key (with its owner incarnation) is not a stop thread key');
    assert.throws(() => turns.steer(stop('102', { source: 'model' as never })), /source/);
    assert.throws(() => turns.steer(stop('102', { stopperUserId: '' })), /stopper/);
    assert.throws(() => turns.finishStop('stop_message', 'forgotten' as never), /ending/);
  } finally { db.close(); }
});

test('a check-in during a run routes to the run facts; a plain message reports the run and enqueues', () => {
  const { db, turns } = store();
  try {
    const running = job('running', '101');
    turns.enqueue(running);
    turns.enqueue(job('queued', '102'));
    dispatch(turns, running);
    turns.assignRunner('running');
    turns.confirmRunner('running');
    const checkIn = turns.steer({ kind: 'check_in', threadKey: THREAD }, job('status', '103', { text: 'status' }));
    assert.deepEqual(checkIn, {
      outcome: 'check_in',
      run: {
        turnJobId: 'running', runnerKey: RUNNER_KEY, executor: 'runner', agentId: 'agent_stop',
        requesterUserId: 'U_MEMBER', dispatched: true, undelivered: 2,
      },
    });
    assert.equal(turns.runnerView('status').status, 'missing', 'a check-in is not a TurnJob');
    assert.equal(stopOf(turns, 'running'), undefined, 'a check-in never touches the run');
    assert.deepEqual(turns.steer({ kind: 'message', threadKey: THREAD }, job('midrun', '104')),
      { outcome: 'enqueue', undelivered: true, enqueued: true });
    assert.equal(turns.runnerView('midrun').status, 'pending');
  } finally { db.close(); }
});

// ── the dispatch gate ──────────────────────────────────────────────────

test('dispatch preparation refuses a stopped or held row whose dispatch never started', () => {
  const { db, turns } = store();
  try {
    const head = job('head', '101');
    const held = job('held', '102');
    const after = job('after', '120');
    for (const queued of [head, held]) turns.enqueue(queued);
    turns.steer(stop('110'));
    turns.enqueue(after);
    for (const queued of [head, held, after]) {
      turns.freezeRuntimePlan(queued.id, compileRuntimePlanV2({
        turn: queued.turn, assignment: queued.assignment, instructions: 'Help.', memoryEpoch: 1,
      }));
    }
    for (const id of ['head', 'held']) {
      assert.throws(() => turns.prepareFlueDispatch(id, 'Do the work', { generation: id }),
        (error: unknown) => error instanceof TurnJobStopRefusal && isTurnJobStopRefusal(error));
      assert.equal(turns.getDispatchEnvelope(id), undefined, 'no Flue admission was frozen');
      assert.equal(turns.runnerView(id).job?.dispatchStartedAt, undefined);
    }
    assert.ok(turns.prepareFlueDispatch('after', 'Do the work', { generation: 'after' }),
      'a message posted after the stop dispatches');
    // Over RPC the refusal arrives as a plain Error carrying its fixed message.
    assert.equal(isTurnJobStopRefusal(new Error(new TurnJobStopRefusal().message)), true);
    assert.equal(isTurnJobStopRefusal(new Error('something else')), false);
  } finally { db.close(); }
});

/** Executor ports that record writes; `runTurn` follows the script. */
function executorPorts(script: (options: RunTurnOptions) => Promise<void>, prepare?: () => unknown) {
  const calls: string[] = [];
  const runs: string[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
  };
  const ports = {
    env: {},
    turnJobs: {
      recordAttempt: record('recordAttempt'),
      markRecoveryRequired: record('markRecoveryRequired'),
      markDelivered: record('markDelivered'),
      markError: record('markError'),
      prepareFlueDispatch: async () => prepare?.(),
    },
    slack: { setActiveWork: record('setActiveWork'), release: record('release') },
    config: {},
    presentationState: {},
    telemetry: { capture: () => undefined },
    resolveInstallation: async () => ({
      workspaceId: 'T_STOP',
      client: { conversations: { info: async () => ({ ok: true, channel: { id: 'C_STOP', is_member: true } }) } },
    }),
    sandboxes: () => [],
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
      runs.push(options.turnId!);
      await script(options);
    },
  } as unknown as TurnExecutionPorts;
  const retries: Array<number | undefined> = [];
  const options: TurnExecutionOptions = {
    latency: { lane: 'cloudflare', executor: 'runner' },
    onRetry: (afterMs) => { retries.push(afterMs); },
  };
  return { ports, options, calls, runs, retries };
}

function pending(id: string, extra: Partial<PendingTurnJob> = {}): PendingTurnJob {
  return { ...job(id, '101'), executionAuthority: 'legacy', attempts: 0, progress: {}, ...extra };
}

test('the executor never runs a held row, and spends no attempt', async () => {
  const h = executorPorts(async () => assert.fail('a held row must not run'));
  const held = pending('held', { stop: { schemaVersion: 1, role: 'held', headId: 'head', at: NOW } });
  assert.equal(await executeTurnJob(held, h.ports, h.options), false);
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.calls, [], 'no attempt, no terminal, no claim release');
  assert.deepEqual(h.retries, [TURN_STOP_HOLD_RETRY_MS]);
});

test('a stopped row that never dispatched takes the stopped ending at once and never prepares a dispatch', async () => {
  const h = executorPorts(async (options) => {
    // The stopped ending (U3; tests/run-turn-stopped.test.ts) replaces the hold.
    assert.equal(options.stopEnding?.beforeDispatch, true);
  }, () => assert.fail('a stopped row must never prepare its dispatch'));
  const stopped = pending('stopped', {
    stop: {
      schemaVersion: 1, role: 'stopped', source: 'button', stopperUserId: 'U_STOPPER',
      cutoffTs: '1800000000.000110', stoppedAt: NOW,
    },
  });
  await executeTurnJob(stopped, h.ports, h.options);
  assert.deepEqual(h.runs, ['stopped']);
  assert.deepEqual(h.retries, [], 'no 5 s hold');
});

test('a stop that lands between the read and the dispatch is refused without a failure final', async () => {
  const h = executorPorts(async (options) => {
    // run-turn passes a retryable prompt failure through untouched.
    await options.flueDispatch!.prepare('Do the work', { generation: 'g' });
    assert.fail('a refused dispatch never reaches Flue');
  }, () => { throw new Error(new TurnJobStopRefusal().message); });
  assert.equal(await executeTurnJob(pending('raced', { attempts: 1 }), h.ports, h.options), false);
  assert.deepEqual(h.runs, ['raced']);
  assert.deepEqual(h.calls, ['recordAttempt("raced",2)', 'recordAttempt("raced",1)'],
    'the attempt is given back and no failure final or error tombstone is written');
  assert.deepEqual(h.retries, [TURN_STOP_HOLD_RETRY_MS]);
  // The refusal crosses run-turn as a retryable prompt failure.
  const seen: unknown[] = [];
  const probe = executorPorts(async (options) => {
    try {
      await options.flueDispatch!.prepare('Do the work', { generation: 'g' });
    } catch (error) {
      seen.push(error);
      throw error;
    }
  }, () => { throw new TurnJobStopRefusal(); });
  await executeTurnJob(pending('probe'), probe.ports, probe.options);
  assert.ok(seen[0] instanceof AgentPromptFailure && seen[0].retryable && !seen[0].recoveryRequired);
});

// ── the runner ─────────────────────────────────────────────────────────

function runnerDeps(turns: TurnJobStoreLogic, jobs: ThreadRunnerJobStore, clock: { now: number }) {
  const ran: string[] = [];
  const deps: ThreadRunnerLoopDeps = {
    jobs,
    turns: {
      view: async (id) => turns.runnerView(id),
      begin: async (id) => ({ view: turns.runnerView(id), settings: {} }),
      markDelivered: async (id) => turns.markDelivered(id),
      markError: async (id) => turns.markError(id),
    },
    execute: async (queued) => {
      ran.push(queued.id);
      jobs.settleTerminal(queued.id, 'done', clock.now);
      turns.markDelivered(queued.id);
      jobs.terminalSynced(queued.id);
      return true;
    },
    clearActiveWork: async () => undefined,
    armBackstop: async () => undefined,
    carried: new Map(),
    failures: { count: 0 },
    budgetMs: 60_000,
    hardCapMs: 120_000,
    recheckMs: 5,
    sink: { info: () => undefined },
    now: () => clock.now,
  };
  return { deps, ran };
}

function toRunner(turns: TurnJobStoreLogic, jobs: ThreadRunnerJobStore, id: string, at: number): void {
  turns.assignRunner(id);
  turns.confirmRunner(id);
  jobs.admit({ id, threadKey: RUNNER_KEY, payload: {} }, at);
}

test('a yielded, stopped job reattached by a later alarm settles without running, and so do its dropped rows', async () => {
  const clock = { now: NOW };
  const { db, turns } = store(clock);
  try {
    const jobs = new ThreadRunnerJobStore(db);
    const running = job('running', '101');
    turns.enqueue(running);
    turns.enqueue(job('unread', '102'));
    dispatch(turns, running);
    toRunner(turns, jobs, 'running', 1);
    toRunner(turns, jobs, 'unread', 2);
    jobs.markRunning('running');
    jobs.settle('running', 'yielded', clock.now, clock.now);
    turns.steer(stop('110'));
    turns.enqueue(job('after', '111'));
    toRunner(turns, jobs, 'after', 3);
    // The stopped ending (U3) drops the held rows and settles the head.
    assert.equal(turns.finishStop('running', 'dropped')?.count, 1);
    turns.markDelivered('running');
    const { deps, ran } = runnerDeps(turns, jobs, clock);
    await runThreadRunnerAlarm(deps);
    assert.deepEqual(ran, ['after'], 'neither the stopped job nor the dropped one runs again');
    assert.equal(jobs.get('running')?.state, 'done');
    assert.equal(jobs.get('unread')?.state, 'done');
    assert.equal(jobs.get('after')?.state, 'done');
  } finally { db.close(); }
});

test('a runner that reaches a held row waits for the ending without running it', async () => {
  const clock = { now: NOW };
  const { db, turns } = store(clock);
  try {
    const jobs = new ThreadRunnerJobStore(db);
    turns.enqueue(job('running', '101'));
    turns.enqueue(job('unread', '102'));
    // The head runs elsewhere (another owner incarnation's runner, say).
    toRunner(turns, jobs, 'unread', 1);
    turns.steer(stop('110'));
    const { deps, ran } = runnerDeps(turns, jobs, clock);
    const first = await runThreadRunnerAlarm(deps);
    assert.deepEqual(ran, []);
    assert.equal(jobs.get('unread')?.state, 'admitted');
    assert.equal(jobs.hasRunning(), false, 'a held row never counts as running');
    assert.equal(first.nextAlarmAt, clock.now + TURN_STOP_HOLD_RETRY_MS);
    // The run had finished before the stop took effect: its rows are released.
    assert.equal(turns.finishStop('running', 'released')?.count, 1);
    clock.now += TURN_STOP_HOLD_RETRY_MS;
    await runThreadRunnerAlarm(deps);
    assert.deepEqual(ran, ['unread']);
  } finally { db.close(); }
});

// ── completion race ────────────────────────────────────────────────────

test('on a completion race the held rows are released and run as ordinary turns', () => {
  const { db, turns } = store();
  try {
    turns.enqueue(job('running', '101'));
    turns.enqueue(job('unread_1', '102'));
    turns.enqueue(job('unread_2', '103'));
    turns.steer(stop('110'));
    const released = turns.finishStop('running', 'released');
    assert.equal(released?.outcome, 'released');
    assert.equal(released?.count, 2);
    for (const id of ['unread_1', 'unread_2']) {
      assert.equal(turns.runnerView(id).status, 'pending');
      assert.equal(stopOf(turns, id)?.role, 'released');
      assert.equal(turnJobStopGate(turns.runnerView(id).job!), 'run');
    }
    turns.enqueue(job('late', '104'));
    assert.equal(stopOf(turns, 'late'), undefined, 'a released stop holds no late arrival');
  } finally { db.close(); }
});

test('a head that settles without the stopped ending releases its held rows, so none is stranded', () => {
  for (const settle of ['markDelivered', 'markError', 'markRecoveryRequired'] as const) {
    const { db, turns } = store();
    try {
      turns.enqueue(job('running', '101'));
      turns.enqueue(job('unread', '102'));
      turns.steer(stop('110'));
      if (settle === 'markRecoveryRequired') turns.markRecoveryRequired('running', 'flue_receipt_conflict');
      else turns[settle]('running');
      assert.equal(stopOf(turns, 'unread')?.role, 'released', settle);
      assert.equal(turnJobStopGate(turns.runnerView('unread').job!), 'run', settle);
      assert.equal(turns.listDueStopNotices(NOW).length, settle === 'markRecoveryRequired' ? 1 : 0,
        `${settle}: a delivered head owes no notice; one held for recovery may still run in Flue`);
    } finally { db.close(); }
  }
});

test('a hold whose head was settled by an older release reads as released', () => {
  const { db, turns } = store();
  try {
    turns.enqueue(job('running', '101'));
    turns.enqueue(job('unread', '102'));
    turns.steer(stop('110'));
    // An older release delivers the head without knowing the stop record.
    db.run("UPDATE turn_jobs SET delivered = 1, status = 'done' WHERE id = 'running'");
    assert.equal(stopOf(turns, 'unread')?.role, 'released');
    assert.equal(turnJobStopGate(turns.runnerView('unread').job!), 'run');
  } finally { db.close(); }
});

// ── the outbox ─────────────────────────────────────────────────────────

test('the outbox redelivers a stop notice until the runner acknowledges it', async () => {
  const clock = { now: NOW };
  const { db, turns } = store(clock);
  try {
    const running = job('running', '101');
    turns.enqueue(running);
    dispatch(turns, running);
    turns.assignRunner('running');
    turns.confirmRunner('running');
    assert.equal(turns.nextStopNoticeDueAt(), undefined);
    turns.steer(stop('110'));
    assert.equal(turns.nextStopNoticeDueAt(), NOW);
    const [notice] = turns.listDueStopNotices(clock.now);
    assert.deepEqual(notice, {
      turnJobId: 'running', runnerKey: RUNNER_KEY, executor: 'runner',
      record: stopOf(turns, 'running'), attempts: 0,
      instanceId: turns.getDispatchEnvelope('running')!.instanceId, uid: UID,
      submissionId: 'sub_running',
    });
    const answers: Array<'throw' | boolean> = ['throw', false, true];
    const seen: number[] = [];
    const deliver = () => deliverDueStopNotices({
      turnJobs: turns,
      receiver: async (sent) => {
        seen.push(sent.attempts);
        const answer = answers.shift();
        if (answer === 'throw') throw new Error('runner unreachable');
        return answer === true;
      },
      now: () => clock.now,
    });
    assert.deepEqual(await deliver(), { acknowledged: 0, deferred: 1 });
    assert.deepEqual(turns.listDueStopNotices(clock.now), [], 'not due again at once');
    const retryAt = turns.nextStopNoticeDueAt()!;
    assert.ok(retryAt > clock.now);
    clock.now = retryAt;
    assert.deepEqual(await deliver(), { acknowledged: 0, deferred: 1 });
    assert.ok(turns.nextStopNoticeDueAt()! - clock.now > retryAt - NOW, 'the retry backs off');
    clock.now = turns.nextStopNoticeDueAt()!;
    assert.deepEqual(await deliver(), { acknowledged: 1, deferred: 0 });
    assert.deepEqual(seen, [0, 1, 2]);
    assert.equal(turns.nextStopNoticeDueAt(), undefined);
    clock.now += 3_600_000;
    assert.deepEqual(await deliver(), { acknowledged: 0, deferred: 0 });
    assert.equal(turns.steer(stop('120')).outcome, 'stopped');
    assert.equal(turns.nextStopNoticeDueAt(), undefined, 'a repeated stop does not re-send an acknowledged notice');
  } finally { db.close(); }
});

// ── lookups ────────────────────────────────────────────────────────────

test('rows in other threads are unaffected and stop lookups use the thread_key index', () => {
  const db = openStateDb(':memory:');
  try {
    const trace = recordingDb(db);
    const turns = new TurnJobStoreLogic(trace.db, () => NOW);
    turns.enqueue(job('running', '101'));
    turns.enqueue(job('unread', '102'));
    turns.enqueue(job('other_thread', '103', { threadTs: '1800000000.000900' }));
    turns.enqueue({ ...job('other_channel', '104'), turn: turn('1800000000.000104', { channelId: 'C_OTHER' }) });
    trace.statements.length = 0;
    turns.steer(stop('110'));
    assert.equal(stopOf(turns, 'other_thread'), undefined);
    assert.equal(stopOf(turns, 'other_channel'), undefined);
    let usedThreadIndex = false;
    for (const { sql, params } of trace.statements) {
      if (!/turn_jobs/.test(sql) || !/^\s*(SELECT|UPDATE)/.test(sql)) continue;
      const plan = db.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => String(row.detail)).join('\n');
      assert.doesNotMatch(plan, /SCAN turn_jobs\b/, sql);
      if (plan.includes('turn_jobs_thread_key_idx')) usedThreadIndex = true;
    }
    assert.ok(usedThreadIndex, 'the thread lookup reads the thread_key index');
    assert.equal(db.get("SELECT thread_key FROM turn_jobs WHERE id = 'other_channel'")?.thread_key,
      `T_STOP:C_OTHER:${THREAD_TS}`);
    assert.equal(db.get("SELECT message_ts FROM turn_jobs WHERE id = 'unread'")?.message_ts,
      '1800000000.000102');
  } finally { db.close(); }
});

test('the stop thread key ignores the owner incarnation and keeps a legacy DM conversation key', () => {
  assert.equal(turnStopThreadKey(turn('1800000000.000101'), assignment({ ownerIncarnation: 3 })), THREAD);
  const dm = turn('1800000000.000101', { channelId: 'D_STOP', sessionThreadTs: 'dm', source: 'dm_message' });
  assert.equal(turnStopThreadKey(dm, {}), 'T_STOP:D_STOP:dm');
  assert.equal(turnStopThreadKey(dm, { runtimeContract: 'chickpea-v1' }), `T_STOP:D_STOP:${THREAD_TS}`);
});

test('a handoff to a new owner incarnation does not hide the running turn from a stop', () => {
  const { db, turns } = store();
  try {
    turns.enqueue(job('running', '101'));
    turns.enqueue({ ...job('new_owner', '102'), assignment: assignment({ ownerIncarnation: 2 }) });
    const decision = turns.steer(stop('110'));
    assert.equal(decision.outcome === 'stopped' ? decision.stop.headId : undefined, 'running');
    assert.equal(stopOf(turns, 'new_owner')?.role, 'held');
  } finally { db.close(); }
});

test('a stop finds and holds rows enqueued before the new columns existed', () => {
  // Rows an older release wrote after the columns existed (a rollback, then forward).
  {
    const { db, turns } = store();
    try {
      turns.enqueue(job('running', '101'));
      turns.enqueue(job('unread', '102'));
      db.run('UPDATE turn_jobs SET thread_key = NULL, message_ts = NULL');
      const decision = turns.steer(stop('110'));
      assert.equal(decision.outcome === 'stopped' ? decision.stop.held : -1, 1);
      assert.equal(stopOf(turns, 'unread')?.role, 'held');
      assert.equal(db.get("SELECT thread_key FROM turn_jobs WHERE id = 'unread'")?.thread_key, THREAD,
        'the fallback backfills the key it decoded');
    } finally { db.close(); }
  }
  // Rows from before the columns: the add-column block backfills undelivered rows.
  {
    const { db, turns } = store();
    try {
      turns.enqueue(job('running', '101'));
      turns.enqueue(job('unread', '102'));
      turns.enqueue(job('delivered', '099'));
      turns.markDelivered('delivered');
      db.exec('DROP INDEX turn_jobs_thread_key_idx');
      db.exec('DROP INDEX turn_jobs_stop_notice_idx');
      for (const column of ['thread_key', 'message_ts', 'stop_json', 'stop_notice_at', 'stop_notice_attempts']) {
        db.exec(`ALTER TABLE turn_jobs DROP COLUMN ${column}`);
      }
      const upgraded = new TurnJobStoreLogic(db, () => NOW);
      assert.deepEqual(db.all('SELECT id, thread_key, message_ts FROM turn_jobs ORDER BY id')
        .map((row) => ({ ...row })), [
        { id: 'delivered', thread_key: null, message_ts: null },
        { id: 'running', thread_key: THREAD, message_ts: '1800000000.000101' },
        { id: 'unread', thread_key: THREAD, message_ts: '1800000000.000102' },
      ]);
      assert.equal(upgraded.steer(stop('110')).outcome, 'stopped');
      assert.equal(stopOf(upgraded, 'unread')?.role, 'held');
    } finally { db.close(); }
  }
});

// ── durability and the Node store ──────────────────────────────────────

test('a stop is durable across a redeploy and the dropped count matches the rows it held', () => {
  const { db, turns } = store();
  try {
    turns.enqueue(job('running', '101'));
    for (const suffix of ['102', '103', '104']) turns.enqueue(job(`unread_${suffix}`, suffix));
    const decision = turns.steer(stop('110', { source: 'button' }));
    const held = decision.outcome === 'stopped' ? decision.stop.held : -1;
    const redeployed = new TurnJobStoreLogic(db, () => NOW + 60_000);
    assert.equal(stopOf(redeployed, 'running')?.role, 'stopped');
    assert.equal(redeployed.listDueStopNotices(NOW + 60_000).length, 1, 'the notice survives');
    assert.equal(redeployed.finishStop('running', 'dropped')?.count, held);
    assert.equal(held, 3);
  } finally { db.close(); }
});

test('the stop operations run on the Node SQLite store without a nested transaction', async () => {
  const state = new SqliteSlackStateStore(':memory:', () => NOW);
  try {
    await state.enqueueTurn!(job('running', '101'));
    assert.deepEqual(await state.steerTurn!({ kind: 'message', threadKey: THREAD }, job('queued', '102')),
      { outcome: 'enqueue', undelivered: true, enqueued: true });
    const decision = await state.steerTurn!(stop('110'), job('stop_message', '110', { text: 'stop' }));
    assert.equal(decision.outcome, 'stopped');
    assert.equal(decision.outcome === 'stopped' ? decision.stop.held : -1, 1);
    assert.equal((await state.finishTurnStop!('running', 'dropped'))?.count, 1);
    assert.equal(await state.finishTurnStop!('queued', 'dropped'), undefined);
  } finally { state.close(); }
  // A composite admission may run the decision inside its own transaction.
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => NOW);
    turns.enqueue(job('running', '101'));
    const decision = db.transaction(() =>
      turns.steerInTransaction(stop('110'), job('stop_message', '110', { text: 'stop' })));
    assert.equal(decision.outcome, 'stopped');
    const enqueued = db.transaction(() =>
      turns.steerInTransaction({ kind: 'message', threadKey: THREAD }, job('queued', '111')));
    assert.deepEqual(enqueued, { outcome: 'enqueue', undelivered: true, enqueued: true });
  } finally { db.close(); }
});

// ── the dropped turns' canonical records ───────────────────────────────

/** One state store with every owner of a canonical Slack admission. */
function canonicalStore(clock: { now: number } = { now: NOW }) {
  const db = openStateDb(':memory:');
  const now = () => clock.now;
  return {
    db,
    clock,
    slack: new SlackStateLogic(db, now),
    work: new WorkStoreLogic(db, { now }),
    turns: new TurnJobStoreLogic(db, now),
    presentations: new SlackRunPresentationStoreLogic(db, now),
  };
}

type CanonicalStore = ReturnType<typeof canonicalStore>;

/**
 * Admit a turn as Slack admission does: its claims, a Work Run, the TurnJob
 * and an admitted V3 presentation whose first activity was never shown.
 */
function admitCanonical(s: CanonicalStore, queued: TurnJob): RunId {
  const admission = prepareSlackShadowAdmission({
    turn: queued.turn, assignment: queued.assignment, sourceVisibility: 'public', admittedAt: s.clock.now,
  });
  const sessionGeneration = slackSessionGenerationFromTimestamp(queued.turn.messageTs);
  const result = s.slack.admitCanonical({
    evtKey: queued.evtKey,
    msgKey: queued.msgKey,
    threadKey: THREAD,
    admission,
    turnJob: { ...queued, runId: admission.run.id, executionAuthority: admission.run.executionAuthority },
    presentation: {
      schemaVersion: 3,
      root: { workspaceId: 'T_STOP', channelId: 'C_STOP', threadTs: THREAD_TS, requesterUserId: queued.turn.userId },
      owner: { kind: 'chickpea' },
      sessionGeneration,
      currentActivity: {
        kind: 'preparing', action: 'Preparing', object: 'your request',
        generation: sessionGeneration, sequence: 1,
        operation: { operationId: `activity_${queued.id}`, certainty: 'pending' },
      },
    },
  }, s.work, s.turns, s.presentations);
  assert.equal(result.claimed, true);
  return admission.run.id;
}

function v3(s: CanonicalStore, runId: string) {
  const presentation = s.presentations.get(runId);
  assert.equal(presentation?.schemaVersion, 3);
  return presentation as SlackRunPresentationV3;
}

/** A running head with two unread messages after it, all admitted canonically, then a stop. */
function canonicalStoppedThread(input: { dispatched?: boolean } = {}) {
  const s = canonicalStore();
  const runs = {
    running: admitCanonical(s, job('running', '101')),
    unread_1: admitCanonical(s, job('unread_1', '102')),
    unread_2: admitCanonical(s, job('unread_2', '103')),
  };
  if (input.dispatched !== false) dispatch(s.turns, job('running', '101'));
  assert.equal(s.turns.steer(stop('110')).outcome, 'stopped');
  return { ...s, runs };
}

test('the stopped ending settles each dropped turn\'s Run cancelled and closes its presentation with no Slack effect', () => {
  const s = canonicalStoppedThread();
  try {
    for (const id of ['unread_1', 'unread_2'] as const) {
      assert.equal(s.work.getRun(s.runs[id])?.status, 'admitted', 'before the ending the Run waits');
    }
    const finished = s.slack.finishTurnStop('running', 'dropped', s.turns, s.work, s.presentations);
    assert.equal(finished?.outcome, 'dropped');
    assert.equal(finished?.count, 2);
    assert.deepEqual(finished?.rows.map((row) => row.runId), [s.runs.unread_1, s.runs.unread_2]);
    for (const id of ['unread_1', 'unread_2'] as const) {
      const run = s.work.getRun(s.runs[id]);
      assert.equal(run?.status, 'settled', `${id}: never read, its Run is terminal`);
      assert.equal(run?.terminalDisposition, 'cancelled');
      assert.equal(run?.deliveryStatus, 'not_applicable');
      assert.equal(run?.leaseOwner, null);
      assert.equal(s.work.listRunExecutions(s.runs[id]).length, 0, 'it never executed');
      const presentation = v3(s, s.runs[id]);
      assert.equal(presentation.lifecyclePhase, 'settled');
      assert.equal(presentation.terminalDelivery.state, 'abandoned');
      assert.equal(presentation.agentSession.disposition, 'superseded',
        'the thread\'s Agent Session belongs to the stopped run\'s ending');
      assert.equal(presentation.stream.state, 'absent');
      assert.equal(presentation.activityProjection.state, 'absent');
      assert.equal(presentation.currentActivity, undefined, 'its first activity was never shown');
      assert.equal(presentation.repairRequired, false);
      assert.equal(hasRetryableTerminalRepair(presentation), false);
    }
    assert.deepEqual(s.presentations.listAutoRepairableV3(50), [], 'nothing for presentation repair to do');
    const audit = s.work.listAuditEvents(s.runs.unread_1, 50)
      .filter((event) => event.eventType === 'work.run_settled_without_delivery');
    assert.equal(audit.length, 1);
    // The running head is the stop's own ending's: untouched here.
    assert.equal(s.work.getRun(s.runs.running)?.status, 'admitted');
    assert.equal(v3(s, s.runs.running).lifecyclePhase, 'admitted');
    // Claims stay held, so a Slack retry of a dropped message never runs it.
    for (const id of ['unread_1', 'unread_2']) {
      assert.equal(s.slack.claim(`evt:${id}`), false);
      assert.equal(s.slack.claim(`msg:${id}`), false);
    }
  } finally { s.db.close(); }
});

test('a repeated or replayed ending settles nothing twice and keeps the first outcome', () => {
  const s = canonicalStoppedThread();
  try {
    s.slack.finishTurnStop('running', 'dropped', s.turns, s.work, s.presentations);
    const settled = [s.runs.unread_1, s.runs.unread_2].map((runId) => ({
      run: s.work.getRun(runId),
      presentation: s.presentations.get(runId),
    }));
    s.clock.now += 60_000;
    const replay = s.slack.finishTurnStop('running', 'dropped', s.turns, s.work, s.presentations);
    assert.equal(replay?.count, 2);
    const raced = s.slack.finishTurnStop('running', 'released', s.turns, s.work, s.presentations);
    assert.equal(raced?.outcome, 'dropped', 'the first ending stands');
    assert.deepEqual([s.runs.unread_1, s.runs.unread_2].map((runId) => ({
      run: s.work.getRun(runId),
      presentation: s.presentations.get(runId),
    })), settled);
    assert.equal(s.work.listAuditEvents(s.runs.unread_2, 50)
      .filter((event) => event.eventType === 'work.run_settled_without_delivery').length, 1);
  } finally { s.db.close(); }
});

test('an ending interrupted before the records settled finishes them on its replay', () => {
  const s = canonicalStoppedThread();
  try {
    // A drop that committed before its records settled (an older build, or
    // an isolate lost between the two): the replayed ending settles them.
    assert.equal(s.turns.finishStop('running', 'dropped')?.count, 2);
    assert.equal(s.work.getRun(s.runs.unread_1)?.status, 'admitted');
    s.slack.finishTurnStop('running', 'dropped', s.turns, s.work, s.presentations);
    for (const id of ['unread_1', 'unread_2'] as const) {
      assert.equal(s.work.getRun(s.runs[id])?.terminalDisposition, 'cancelled');
      assert.equal(v3(s, s.runs[id]).lifecyclePhase, 'settled');
    }
  } finally { s.db.close(); }
});

test('a record that cannot settle never undoes the drop', () => {
  const s = canonicalStoppedThread();
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const failingWork = Object.assign(Object.create(s.work) as WorkStoreLogic, {
      settleUnstartedRun: () => { throw new Error('ledger unavailable'); },
    });
    const finished = s.slack.finishTurnStop('running', 'dropped', s.turns, failingWork, s.presentations);
    assert.equal(finished?.count, 2, 'the stop still drops and counts its rows');
    for (const id of ['unread_1', 'unread_2'] as const) {
      assert.equal(s.turns.runnerView(id).status, 'done');
      assert.equal(v3(s, s.runs[id]).lifecyclePhase, 'settled', 'the other record still settles');
    }
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every((args) => args.every((arg) => typeof arg === 'string' && !arg.includes('run_'))),
      'the warning is content-free');
    // The next ending settles what is left.
    s.slack.finishTurnStop('running', 'dropped', s.turns, s.work, s.presentations);
    assert.equal(s.work.getRun(s.runs.unread_1)?.terminalDisposition, 'cancelled');
  } finally {
    console.warn = warn;
    s.db.close();
  }
});

test('R22: rows released by a completion race keep their Runs and presentations, to run as ordinary turns', () => {
  const s = canonicalStoppedThread();
  try {
    const released = s.slack.finishTurnStop('running', 'released', s.turns, s.work, s.presentations);
    assert.equal(released?.outcome, 'released');
    for (const id of ['unread_1', 'unread_2'] as const) {
      assert.equal(s.turns.runnerView(id).status, 'pending');
      assert.equal(s.work.getRun(s.runs[id])?.status, 'admitted');
      const presentation = v3(s, s.runs[id]);
      assert.equal(presentation.lifecyclePhase, 'admitted');
      assert.equal(presentation.terminalDelivery.state, 'none');
      assert.equal(presentation.currentActivity?.operation.certainty, 'pending');
    }
    assert.equal(s.work.getRun(s.runs.running)?.status, 'admitted');
  } finally { s.db.close(); }
});

test('a stopped head that never dispatched settles its own Run cancelled and keeps its presentation for the note', () => {
  const s = canonicalStoppedThread({ dispatched: false });
  try {
    const finished = s.slack.finishTurnStop('running', 'dropped', s.turns, s.work, s.presentations);
    assert.equal(finished?.count, 2);
    const head = s.work.getRun(s.runs.running);
    assert.equal(head?.status, 'settled', 'its message was never read either');
    assert.equal(head?.terminalDisposition, 'cancelled');
    const presentation = v3(s, s.runs.running);
    assert.equal(presentation.lifecyclePhase, 'admitted', 'the stop note is still to post through it');
    assert.equal(presentation.terminalDelivery.state, 'none');
    for (const id of ['unread_1', 'unread_2'] as const) {
      assert.equal(s.work.getRun(s.runs[id])?.terminalDisposition, 'cancelled');
    }
  } finally { s.db.close(); }
});

test('a dropped legacy-lane row without a Run is dropped as before', () => {
  const s = canonicalStore();
  try {
    admitCanonical(s, job('running', '101'));
    s.turns.enqueue(job('legacy', '102'));
    const unread = admitCanonical(s, job('unread', '103'));
    dispatch(s.turns, job('running', '101'));
    s.turns.steer(stop('110'));
    const finished = s.slack.finishTurnStop('running', 'dropped', s.turns, s.work, s.presentations);
    assert.equal(finished?.count, 2);
    assert.deepEqual(finished?.rows.map((row) => row.id), ['legacy', 'unread']);
    assert.equal(finished?.rows[0]?.runId, undefined);
    assert.equal(s.turns.runnerView('legacy').status, 'done');
    assert.equal(s.work.getRun(unread)?.terminalDisposition, 'cancelled');
  } finally { s.db.close(); }
});

test('the Node state store settles the dropped turns\' records through its stop ending', async () => {
  const s = canonicalStoppedThread();
  try {
    const state = localSlackStateStore({
      slack: s.slack, work: s.work, turnJobs: s.turns, presentations: s.presentations,
    });
    assert.equal((await state.finishTurnStop!('running', 'dropped'))?.count, 2);
    for (const id of ['unread_1', 'unread_2'] as const) {
      assert.equal(s.work.getRun(s.runs[id])?.terminalDisposition, 'cancelled');
      assert.equal(v3(s, s.runs[id]).lifecyclePhase, 'settled');
    }
  } finally { s.db.close(); }
});
