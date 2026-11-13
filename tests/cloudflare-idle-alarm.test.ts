import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import {
  emitRelayAlarm,
  emitResidencyHold,
  startRelayAlarmMetrics,
  type RelayAlarmMetrics,
} from '../src/observability/runtime-latency.ts';
import { StopAbortFence } from '../src/slack/runner-stops.ts';
import { slackTurnExecutor } from '../src/slack/turn-executor-flag.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { storeResidencyHoldMs, type ResidencyHoldChange } from '../src/state/residency-hold.ts';
import { localTurnEnqueue } from '../src/state/tag-state-stores.ts';
import { turnJob as maintenanceTurnJob } from './fixtures/state-db/maintenance.ts';
import { HOLD_ENV, HOLD_MS, holdOn, ScriptedTimers, STORE_HOLD_ENV, STORE_HOLD_MS } from './helpers/residency-hold.ts';

// The production alarm(), its idle drain (no turn pending) and the admission
// RPC, over stubbed stores: the idle drains advance a scripted clock, so each
// part's timing is exact, and the alarm storage records every write. The
// complete Worker is exercised by verify:cf-smoke.
const source = ts.createSourceFile(
  'cloudflare.ts',
  readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const stateClass = source.statements.find((node) =>
  ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
assert.ok(stateClass && ts.isClassDeclaration(stateClass));
const stateMethod = (name: string) => {
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(source);
};
const moduleStatement = (name: string) => {
  const statement = source.statements.find((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      declaration.name.getText(source) === name)));
  assert.ok(statement, `production ${name} exists`);
  return statement.getText(source);
};
const compiled = ts.transpileModule(
  `${['RELAY_BATCH_WINDOW_MS', 'KEEP_WARM_WINDOW_MS', 'KEEP_WARM_TICK_MS', 'RETENTION_SWEEP_INTERVAL_MS', 'earliestDefined'].map(moduleStatement).join('\n')}
class StateStoreProbe { boot = { call() {} };
${[
    'alarm', 'drainRelayAlarm', 'deliverStopNotices', 'admitSlackTurn', 'afterSlackAdmission', 'armAlarmNoLaterThan', 'setAlarmNoLaterThan', 'admissionWakeAt',
    'runnerMode', 'keepWarmTickAt', 'dispatchingWhile', 'hold', 'threadRunnerTurn', 'call',
  ].map(stateMethod).join('\n')} }\nStateStoreProbe`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

const NOW = 1_800_000_000_000;
/** The product's keep-warm window and tick (src/cloudflare.ts). */
const KEEP_WARM_WINDOW_MS = 10 * 60_000;
const KEEP_WARM_TICK_MS = 20_000;
const RETENTION_SWEEP_INTERVAL_MS = 5 * 60_000;
const RUNNER_ENV = { SLACK_THREAD_RUNNER: {} };

type TurnJob = ReturnType<typeof maintenanceTurnJob>;
function hostTurnJob(id: string, turn: Partial<TurnJob['turn']>): TurnJob {
  const job = maintenanceTurnJob(id);
  return { ...job, turn: { ...job.turn, ...turn } };
}
const AGENT_ASK = { fromAgentId: 'agent_b', fromAgentName: 'B', originMessageTs: '1800000000.000001' };
const SETUP_WAKE = { setupOperationId: 'op_1', notice: 'Connected.' };

type LogRecord = { [field: string]: number | boolean | string };
type Result = { ok: true; value: unknown } | { ok: false; error: { code: string } };

/** How long each stubbed part of the idle drain takes, in milliseconds. */
interface PartCosts {
  retention: number;
  ledger: number;
  /** Undefined: no cleanup is pending, so the drain is skipped. */
  cleanups?: number;
  repairs: number;
  schedule: number;
  receipts: number;
}
const QUIET: PartCosts = { retention: 0, ledger: 0, repairs: 0, schedule: 0, receipts: 0 };

interface Probe {
  env: object;
  ctx: object;
  stores: object;
  call: (callback: (stores: unknown) => unknown) => Result;
  stopAborts: StopAbortFence;
  carriedAlarmTurns: Map<string, string>;
  lastHumanTurnAt?: number;
  testRuns?: () => Promise<{ pass(): Promise<unknown> }>;
  alarmAdmissionWake?: () => void;
  dispatchWake?: () => void;
  createAlarmIdentityResolver(): unknown;
  admitToRunner(): Promise<boolean>;
  offerCreatedStop(): Promise<void>;
  alarm(): Promise<void>;
  admitSlackTurn(input: object): Promise<Result>;
  threadRunnerTurn(op: { kind: string; id: string }): Promise<Result>;
}

/**
 * A probe over the test's clock, with alarm storage that records writes and
 * sinks that collect relay_alarm and residency_hold records as they would be
 * logged, and its hold's timers on the same clock. The idle drains each advance the clock by
 * their cost; `duringDrain` runs inside the first of them, as an RPC arming
 * the alarm while the drain awaits would.
 */
function newProbe(costs: PartCosts, duringDrain?: (armAt: (at: number) => void) => void) {
  let clock = NOW;
  const records: LogRecord[] = [];
  const holds: LogRecord[] = [];
  let alarm: number | null = null;
  const writes: number[] = [];
  const armAt = (at: number) => { alarm = at; };
  const advance = (ms: number | undefined) => async () => {
    clock += ms ?? 0;
    return {};
  };
  let gatewayDrains = 0;
  const timers = new ScriptedTimers(() => clock);
  const ProbeClass = vm.runInNewContext(compiled, {
    Date: { now: () => clock },
    setTimeout,
    clearTimeout,
    ResidencyHold: holdOn(timers),
    storeResidencyHoldMs,
    emitResidencyHold: (object: 'store', change: ResidencyHoldChange) =>
      emitResidencyHold(object, change, { info: (record) => holds.push(record as LogRecord) }),
    cloudflareWorkerVersionId: () => undefined,
    applyThreadRunnerTurnOp: () => null,
    ALARM_ADMISSION_RECHECK_MS: 2_000,
    console: { warn() {} },
    startRelayAlarmMetrics: () => startRelayAlarmMetrics(() => clock),
    emitRelayAlarm: (metrics: RelayAlarmMetrics) =>
      emitRelayAlarm(metrics, () => clock, { info: (record) => records.push(record as LogRecord) }),
    createPlatformProductTelemetry: () => ({}),
    localSettingsStore: () => ({}),
    localGatewayAppStores: () => ({ config: {} }),
    slackTurnExecutor: (env: Record<string, unknown>) => slackTurnExecutor(env, {}),
    MAX_TURN_DRAIN_BATCH: 16,
    ALARM_PENDING_PER_THREAD: 4,
    RELAY_RETRY_BACKOFF_MS: 2_000,
    drainGatewayInbox: async () => {
      gatewayDrains += 1;
      return false;
    },
    deliverDueStopNotices: async () => undefined,
    drainLedgerRuns: async () => {
      clock += costs.ledger;
      duringDrain?.(armAt);
      return {};
    },
    drainSlackInteractionCleanups: advance(costs.cleanups),
    drainTerminalPresentationRepairs: advance(costs.repairs),
    drainCloudflareScheduleActions: advance(costs.schedule),
    drainCloudflareManagementReceipts: advance(costs.receipts),
    runDriverRetryDelayMs: (_drain: object, retryDelay: number) => retryDelay,
  }) as new () => Probe;
  const probe = new ProbeClass();
  probe.ctx = { storage: {
    async getAlarm() { return alarm; },
    async setAlarm(at: number) { writes.push(at); alarm = at; },
  } };
  // Class fields the method-only probe does not carry.
  probe.stopAborts = new StopAbortFence();
  probe.carriedAlarmTurns = new Map();
  return {
    probe,
    records,
    /** The residency_hold records, one per change of the store's hold. */
    holds,
    writes,
    alarm: () => alarm,
    /** The deadlines of the store's pending timers, which keep it in memory. */
    heldUntil: () => timers.pending(),
    /** Whether a pending timer still blocks the store's eviction. */
    blocksEviction: () => timers.blocksEviction(),
    /** How many times the alarm drained the gateway inbox, admitting turns. */
    gatewayDrains: () => gatewayDrains,
    /** The platform fires the alarm: it is cleared, then alarm() runs. */
    async fire() {
      alarm = null;
      await probe.alarm();
    },
    advance(ms: number) {
      clock += ms;
      timers.fireDue();
    },
  };
}

/**
 * A state store with no turn pending whose idle drains cost `costs`.
 * `lastHumanTurnAt`: a person's turn this instance admitted; `newestEnqueuedAt`:
 * what its newest turn row says when it starts cold; `nextOutboxDueAt`: a
 * receipt due later; `duringDrain`: see newProbe.
 */
function idleStore(costs: PartCosts, options: {
  lastHumanTurnAt?: number;
  newestEnqueuedAt?: number | undefined;
  nextOutboxDueAt?: number;
  /** A test run whose instance is not erased yet: the alarm looks again every 10 seconds. */
  testRunUnerased?: boolean;
  duringDrain?: (armAt: (at: number) => void) => void;
  /** The deployment's env: none sets a residency hold unless given. */
  env?: object;
} = {}) {
  const store = newProbe(costs, options.duringDrain);
  let reads = 0;
  let sweeps = 0;
  let cleanupChecks = 0;
  store.probe.env = options.env ?? {};
  if (options.lastHumanTurnAt !== undefined) store.probe.lastHumanTurnAt = options.lastHumanTurnAt;
  store.probe.createAlarmIdentityResolver = () => async () => ({ client: {} });
  store.probe.stores = {
    management: {
      cleanupRetention() {
        sweeps += 1;
        store.advance(costs.retention);
      },
      nextOutboxDueAt: () => options.nextOutboxDueAt,
    },
    turnJobs: {
      listPendingByThread: () => [],
      hasPending: () => false,
      hasPendingSlackInteractionCleanup: () => {
        cleanupChecks += 1;
        return costs.cleanups !== undefined;
      },
      hasHandoffs: () => false,
      nextStopNoticeDueAt: () => undefined,
      newestEnqueuedAt: () => {
        reads += 1;
        return options.newestEnqueuedAt;
      },
    },
    gatewayInbox: { hasPending: () => false, nextPendingDueAt: () => undefined },
    testRuns: {
      hasUnerased: () => options.testRunUnerased === true,
      nextDueAt: (now: number) => options.testRunUnerased ? now + 10_000 : undefined,
      eraseExpired: () => 0,
    },
  };
  return { ...store, reads: () => reads, sweeps: () => sweeps, cleanupChecks: () => cleanupChecks };
}

/**
 * A state store admitting turns under the default runner executor, whose
 * runner takes every dispatchable turn at once: admission arms no admission
 * wake, so only the keep-warm tick can arm the alarm. `admission` is what the
 * canonical admission answers; `env` adds to the runner executor's; `rows`
 * tell a person's turn from the host's own when the runner reports one's end.
 */
function admissionStore(
  admission: object = { claimed: true, admission: {} },
  env: object = HOLD_ENV,
  rows?: TurnJobStoreLogic,
) {
  const store = newProbe(QUIET);
  store.probe.env = { ...RUNNER_ENV, ...env };
  store.probe.call = (callback) => ({
    ok: true,
    value: callback({
      slack: { admitCanonical: () => admission },
      turnJobs: {
        dispatchableNow: (id: string) => ({ id }),
        ...(rows ? { isPersonTurn: (id: string) => rows.isPersonTurn(id) } : {}),
      },
    }),
  });
  store.probe.admitToRunner = async () => true;
  store.probe.offerCreatedStop = async () => undefined;
  return store;
}

for (const cleanupPending of [false, true]) {
  test(`an idle alarm's record times each of its parts (${cleanupPending ? 'a' : 'no'} cleanup pending)`, async () => {
    const costs: PartCosts = {
      retention: 300, ledger: 100, ...(cleanupPending ? { cleanups: 50 } : {}),
      repairs: 70, schedule: 20, receipts: 400,
    };
    const store = idleStore(costs);
    await store.fire();
    assert.equal(store.records.length, 1);
    const record = store.records[0]!;
    assert.equal(record.outcome, 'idle');
    assert.equal(record.keepWarm, false, 'no person has talked to this store');
    const parts = {
      retentionMs: 300, ledgerMs: 100, cleanupsMs: cleanupPending ? 50 : 0,
      repairsMs: 70, scheduleMs: 20, receiptsMs: 400,
    };
    for (const [field, expected] of Object.entries(parts)) {
      assert.equal(record[field], expected, `${field} is the part's own time`);
    }
    const sum = Object.values(parts).reduce((total, part) => total + part, 0);
    assert.equal(typeof record.durationMs, 'number');
    assert.ok(sum <= (record.durationMs as number), 'the parts sum to no more than the whole firing');
  });
}

test("a person's turn handed to its runner arms the alarm no later than the keep-warm tick", async () => {
  const store = admissionStore();
  assert.equal((await store.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } })).ok, true);
  assert.deepEqual(store.writes, [NOW + KEEP_WARM_TICK_MS]);
  assert.equal(store.alarm(), NOW + KEEP_WARM_TICK_MS);
});

test('a tick armed from a handed-over admission wakes no running alarm', async () => {
  const wakes: string[] = [];
  const listening = (store: ReturnType<typeof admissionStore>) => {
    store.probe.alarmAdmissionWake = () => { wakes.push('admission'); };
    store.probe.dispatchWake = () => { wakes.push('dispatch'); };
    return store;
  };
  const handed = listening(admissionStore());
  assert.equal((await handed.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } })).ok, true);
  assert.deepEqual(handed.writes, [NOW + KEEP_WARM_TICK_MS]);
  assert.deepEqual(wakes, [], 'the runner has the turn; a running alarm has nothing to pick up');
  // A turn its runner did not take is the alarm's: that admission wakes it.
  const kept = listening(admissionStore());
  kept.probe.admitToRunner = async () => false;
  assert.equal((await kept.probe.admitSlackTurn({ turnJob: { id: 'turn_kept', turn: {} } })).ok, true);
  assert.deepEqual(kept.writes, [NOW]);
  assert.deepEqual(wakes, ['admission', 'dispatch']);
});

// Defects caught: a store kept only by its alarm, which hibernates it 10 s
// after each tick; a hold shorter than the configured window, or one that
// outlives it; a window taken from the tick's constant, not the setting.
test("a person's turn holds the store in memory through the configured window, and not past it", async () => {
  const store = admissionStore();
  assert.equal((await store.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } })).ok, true);
  let elapsed = 0;
  for (const gap of [15_000, 45_000, 3 * 60_000, 8 * 60_000]) {
    store.advance(gap - elapsed);
    elapsed = gap;
    assert.deepEqual(store.heldUntil(), [NOW + HOLD_MS], `held ${gap / 1_000} s after the turn`);
  }
  store.advance(HOLD_MS - elapsed);
  assert.deepEqual(store.heldUntil(), [], 'let go when the window ends');
});

// Defects caught: a later turn that leaves the first window's deadline, or
// adds a second timer beside it.
test("a person's next turn renews the hold from that turn", async () => {
  const store = admissionStore();
  await store.probe.admitSlackTurn({ turnJob: { id: 'turn_first', turn: {} } });
  store.advance(8 * 60_000);
  await store.probe.admitSlackTurn({ turnJob: { id: 'turn_next', turn: {} } });
  const renewed = NOW + 8 * 60_000 + HOLD_MS;
  assert.deepEqual(store.heldUntil(), [renewed], 'one timer, at the next turn plus the window');
  store.advance(HOLD_MS - 8 * 60_000);
  assert.deepEqual(store.heldUntil(), [renewed], "the first turn's window ending lets nothing go");
  store.advance(8 * 60_000);
  assert.deepEqual(store.heldUntil(), []);
});

/** Turn rows for a person's turn, an Agent's ask and a setup wake, as the runner reports their ends. */
function endingRows(): TurnJobStoreLogic {
  const rows = new TurnJobStoreLogic(openStateDb(':memory:'), () => NOW);
  const job = (id: string, turn: object) => {
    const base = maintenanceTurnJob(id);
    return { ...base, turn: { ...base.turn, ...turn } };
  };
  rows.enqueue(job('turn_person', {}));
  rows.enqueue(job('turn_ask', { agentAsk: { exchangeId: 'exchange_1' } }));
  rows.enqueue(job('turn_setup', { setupWake: { setupOperationId: 'op_1', notice: 'Connected.' } }));
  return rows;
}

// Defects caught: a store whose window counts from admission alone, so after
// a long turn it has less of the window left than the runner and the Agent
// object; a renewal at the end of the host's own turns, or at a turn's other
// reports.
test("a person's turn ending renews the store's hold from its end, as the runner reports it", async () => {
  const store = admissionStore(undefined, HOLD_ENV, endingRows());
  await store.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } });
  store.advance(6 * 60_000);
  await store.probe.threadRunnerTurn({ kind: 'recordAttempt', id: 'turn_person' });
  assert.deepEqual(store.heldUntil(), [NOW + HOLD_MS], 'a report before the end renews nothing');
  await store.probe.threadRunnerTurn({ kind: 'markDelivered', id: 'turn_person' });
  const ended = NOW + 6 * 60_000;
  assert.deepEqual(store.heldUntil(), [ended + HOLD_MS], 'from the delivered answer');
  store.advance(60_000);
  for (const id of ['turn_ask', 'turn_setup']) {
    await store.probe.threadRunnerTurn({ kind: 'markDelivered', id });
    await store.probe.threadRunnerTurn({ kind: 'markError', id });
  }
  assert.deepEqual(store.heldUntil(), [ended + HOLD_MS], "an Agent's ask or a setup wake ending renews nothing");
  await store.probe.threadRunnerTurn({ kind: 'markError', id: 'turn_person' });
  assert.deepEqual(store.heldUntil(), [ended + 60_000 + HOLD_MS], 'a failed turn ends too');
  store.advance(HOLD_MS);
  assert.deepEqual(store.heldUntil(), []);
});

// Defects caught: a store window read as the conversation's, so the store
// leaves memory with the thread's objects; one 60-minute timer, which blocks
// eviction for only its first 15 minutes; a run of timers that stops early or
// outlives the window; and a turn's end that renews from the shorter window.
test("the store's own window holds it through the hour after a person's turn, past the 15 minutes one timer blocks eviction", async () => {
  const store = admissionStore(undefined, STORE_HOLD_ENV, endingRows());
  await store.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } });
  store.advance(2 * 60_000);
  await store.probe.threadRunnerTurn({ kind: 'markDelivered', id: 'turn_person' });
  const ended = NOW + 2 * 60_000;
  for (let minute = 1; minute < STORE_HOLD_MS / 60_000; minute += 1) {
    store.advance(60_000);
    assert.equal(store.heldUntil().length, 1, `one timer ${minute} min after the turn's end`);
    assert.equal(store.blocksEviction(), true, `held ${minute} min after the turn's end`);
  }
  assert.deepEqual(store.heldUntil(), [ended + STORE_HOLD_MS], "the last timer ends with the window, from the turn's end");
  store.advance(60_000);
  assert.deepEqual(store.heldUntil(), [], "let go when the store's window ends");
  assert.equal(store.blocksEviction(), false);
});

// Defects caught: a store held on a deployment whose store window is 0, and
// a store window that needs the conversation's to be set.
test("a store window of 0 turns only the store's hold off; set alone, it holds the store", async () => {
  const off = admissionStore(undefined, { ...HOLD_ENV, CHICKPEA_STORE_RESIDENCY_HOLD_MS: '0' });
  await off.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } });
  assert.deepEqual(off.heldUntil(), [], '0 turns the store hold off');
  const alone = admissionStore(undefined, { CHICKPEA_STORE_RESIDENCY_HOLD_MS: String(STORE_HOLD_MS) });
  await alone.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } });
  assert.equal(alone.blocksEviction(), true, 'the store window needs no conversation window');
  alone.advance(30 * 60_000);
  assert.equal(alone.blocksEviction(), true, 'still held half an hour on');
});

// Defects caught: a hold on a deployment that sets no window, sets 0, or
// sets one the deploy refuses, which would bill every idle store; a turn's
// end that reads its row for a hold it cannot set; and a tick that moved with
// the setting.
test('without a valid hold window nothing holds the store, and the keep-warm tick runs as before', async () => {
  for (const value of [undefined, '', '0', '900001', '10m']) {
    const env = value === undefined ? {} : { CHICKPEA_RESIDENCY_HOLD_MS: value };
    const rows = endingRows();
    const kindReads = mock.method(rows, 'isPersonTurn');
    const store = admissionStore(undefined, env, rows);
    await store.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } });
    assert.deepEqual(store.writes, [NOW + KEEP_WARM_TICK_MS], `${value}: the tick`);
    await store.probe.threadRunnerTurn({ kind: 'markDelivered', id: 'turn_person' });
    await store.probe.threadRunnerTurn({ kind: 'markError', id: 'turn_person' });
    assert.deepEqual(store.heldUntil(), [], `${value}: neither admission nor the turn's end holds`);
    assert.equal(kindReads.mock.callCount(), 0, `${value}: the turn's end reads no row`);
    const cold = idleStore(QUIET, { newestEnqueuedAt: NOW - 60_000, env });
    await cold.fire();
    assert.deepEqual(cold.writes, [NOW + KEEP_WARM_TICK_MS], `${value}: a cold store ticks`);
    assert.deepEqual(cold.heldUntil(), [], `${value}: a cold store holds nothing`);
  }
});

test("an Agent's ask, a setup wake, or a stop alone arms no tick and holds nothing", async () => {
  const cases: Array<[string, object, object | undefined]> = [
    ["an Agent's ask", { id: 'turn_ask', turn: { agentAsk: { exchangeId: 'exchange_1' } } }, undefined],
    ['a setup wake', { id: 'turn_setup', turn: { setupWake: { operationId: 'op_1' } } }, undefined],
    ['a stop alone', { id: 'turn_stop', turn: {} }, { claimed: true, steered: { created: false } }],
  ];
  for (const [name, turnJob, admission] of cases) {
    const store = admissionStore(admission);
    assert.equal((await store.probe.admitSlackTurn({ turnJob })).ok, true);
    assert.deepEqual(store.writes, [], `${name} arms nothing`);
    assert.deepEqual(store.heldUntil(), [], `${name} holds nothing`);
  }
});

test('an idle alarm inside the window re-arms the tick and says so; outside it, nothing', async () => {
  const inside = idleStore(QUIET, { lastHumanTurnAt: NOW - 60_000 });
  await inside.fire();
  assert.deepEqual(inside.writes, [NOW + KEEP_WARM_TICK_MS]);
  assert.equal(inside.records[0]?.keepWarm, true);
  assert.equal(inside.records[0]?.rearmed, true);
  for (const [name, at] of [
    ["at the window's end", NOW - KEEP_WARM_WINDOW_MS],
    ['11 minutes on', NOW - 11 * 60_000],
  ] as const) {
    const outside = idleStore(QUIET, { lastHumanTurnAt: at });
    await outside.fire();
    assert.deepEqual(outside.writes, [], `${name}: no tick`);
    assert.equal(outside.records[0]?.keepWarm, false, `${name}: not a keep-warm firing`);
    assert.equal(outside.records[0]?.rearmed, false, `${name}: nothing re-armed`);
  }
});

test('a due time earlier than the tick wins, and a tick never moves an armed alarm later', async () => {
  const due = idleStore(QUIET, { lastHumanTurnAt: NOW - 1_000, nextOutboxDueAt: NOW + 5_000 });
  await due.fire();
  assert.deepEqual(due.writes, [NOW + 5_000]);
  const armed = idleStore(QUIET, {
    lastHumanTurnAt: NOW - 1_000,
    duringDrain: (armAt) => armAt(NOW + 3_000),
  });
  await armed.fire();
  assert.deepEqual(armed.writes, []);
  assert.equal(armed.alarm(), NOW + 3_000);
});

test('a store that starts cold derives the window from its newest turn row, once', async () => {
  const recent = idleStore(QUIET, { newestEnqueuedAt: NOW - 2 * 60_000, env: HOLD_ENV });
  await recent.fire();
  assert.deepEqual(recent.writes, [NOW + KEEP_WARM_TICK_MS]);
  assert.equal(recent.records[0]?.keepWarm, true);
  assert.deepEqual(recent.heldUntil(), [NOW - 2 * 60_000 + HOLD_MS], 'and holds itself for the rest of the hold window');
  recent.advance(KEEP_WARM_TICK_MS);
  await recent.fire();
  assert.deepEqual(recent.writes, [NOW + KEEP_WARM_TICK_MS, NOW + 2 * KEEP_WARM_TICK_MS]);
  assert.equal(recent.reads(), 1, 'the newest row is read once per instance');
  const stale = idleStore(QUIET, { newestEnqueuedAt: NOW - 15 * 60_000, env: HOLD_ENV });
  await stale.fire();
  assert.deepEqual(stale.writes, []);
  assert.equal(stale.records[0]?.keepWarm, false);
  assert.deepEqual(stale.heldUntil(), [], 'a window that ended holds nothing');
  const empty = idleStore(QUIET, { env: HOLD_ENV });
  await empty.fire();
  await empty.fire();
  assert.deepEqual(empty.writes, []);
  assert.deepEqual(empty.heldUntil(), [], 'no person has talked to it');
  assert.equal(empty.reads(), 1, 'an empty table is read once too');
});

/** The value of one call through the store's call(), as a minute tick's maintenance read makes it. */
const tick = (store: ReturnType<typeof newProbe>) => {
  const result = store.probe.call(() => 'tick');
  return result.ok ? result.value : result.error.code;
};

/** A residency_hold record as the store logs it. */
const holdRecord = (fields: LogRecord): LogRecord => ({ component: 'runtime', event: 'residency_hold', object: 'store', ...fields });

// Defects caught: a store that restarted inside a person's window and stays
// unheld until that person's next turn (staging, 2026-11-13: the platform
// closed a held store 39 minutes into its hour, and it stayed cold for the
// remaining 20); a re-hold counted from the call, which outlives the
// person's window; one that reads the turn rows at every call, or again at
// the next alarm; and a hold change that logs nothing.
test("a store that restarts inside a person's window holds itself again at its first call, to that window's end", async () => {
  const turnAt = NOW - 39 * 60_000;
  const end = turnAt + STORE_HOLD_MS;
  const store = idleStore(QUIET, { newestEnqueuedAt: turnAt, env: STORE_HOLD_ENV });
  assert.equal(tick(store), 'tick');
  assert.deepEqual(store.holds, [holdRecord({
    reason: 'first_call', windowMs: STORE_HOLD_MS, holdEndsAt: end, holdLeftMs: 21 * 60_000,
    timerMs: 14 * 60_000, renewed: false,
  })]);
  tick(store);
  await store.fire();
  assert.equal(store.reads(), 1, 'the turn rows are read once per instance');
  assert.equal(store.holds.length, 1, 'a call or an alarm that moves nothing logs nothing');
  for (let minute = 1; minute < 21; minute += 1) {
    store.advance(60_000);
    assert.equal(store.heldUntil().length, 1, `one timer ${minute} min after the restart`);
    assert.equal(store.blocksEviction(), true, `held ${minute} min after the restart`);
  }
  assert.deepEqual(store.heldUntil(), [end], "the last timer ends with the person's window");
  store.advance(60_000);
  assert.deepEqual(store.heldUntil(), []);
  assert.deepEqual(store.holds.slice(1), [
    holdRecord({ reason: 'chain', windowMs: STORE_HOLD_MS, holdEndsAt: end, holdLeftMs: 7 * 60_000, timerMs: 7 * 60_000 }),
    holdRecord({ reason: 'expired', windowMs: STORE_HOLD_MS, holdEndsAt: end, holdLeftMs: 0 }),
  ]);
});

// Defects caught: a re-hold from a window that ended, or from no person's
// turn, which would hold every idle store the scheduled tick restarts; and
// a read of the turn rows on a deployment that holds nothing.
test("a store that restarts after a person's window, or with none, holds nothing at its first call", async () => {
  for (const [name, newestEnqueuedAt] of [
    ['an hour and a minute on', NOW - STORE_HOLD_MS - 60_000],
    ["at the window's end", NOW - STORE_HOLD_MS],
    ["no person's turn", undefined],
  ] as const) {
    const store = idleStore(QUIET, { newestEnqueuedAt, env: STORE_HOLD_ENV });
    assert.equal(tick(store), 'tick');
    assert.deepEqual(store.heldUntil(), [], `${name}: no hold`);
    assert.deepEqual(store.holds, [], `${name}: no record`);
    assert.equal(store.reads(), 1, `${name}: one read`);
  }
  for (const env of [{}, { ...HOLD_ENV, CHICKPEA_STORE_RESIDENCY_HOLD_MS: '0' }]) {
    const store = idleStore(QUIET, { newestEnqueuedAt: NOW - 60_000, env });
    assert.equal(tick(store), 'tick');
    assert.deepEqual(store.heldUntil(), [], `${JSON.stringify(env)}: no hold`);
    assert.equal(store.reads(), 0, `${JSON.stringify(env)}: no read`);
  }
});

// Defects caught: a re-hold or a record that waits for the store's own
// variable. A deployment that sets only the conversation's window holds its
// store for that window, so its restarted store reads the rows, holds and
// logs as well.
test("a store on the conversation's window alone holds itself again at its first call", async () => {
  const turnAt = NOW - 4 * 60_000;
  const store = idleStore(QUIET, { newestEnqueuedAt: turnAt, env: HOLD_ENV });
  assert.equal(tick(store), 'tick');
  assert.equal(store.reads(), 1);
  assert.deepEqual(store.heldUntil(), [turnAt + HOLD_MS]);
  assert.deepEqual(store.holds, [holdRecord({
    reason: 'first_call', windowMs: HOLD_MS, holdEndsAt: turnAt + HOLD_MS, holdLeftMs: HOLD_MS - 4 * 60_000,
    timerMs: HOLD_MS - 4 * 60_000, renewed: false,
  })]);
});

// Defects caught: a first call that fails when the turn rows cannot be read,
// and a failed read that stops the next call from holding.
test("a store whose turn rows fail to read serves its first call unheld, and holds at the next", async () => {
  const store = idleStore(QUIET, { newestEnqueuedAt: NOW - 60_000, env: STORE_HOLD_ENV });
  const turnJobs = (store.probe.stores as { turnJobs: { newestEnqueuedAt(): number | undefined } }).turnJobs;
  const read = turnJobs.newestEnqueuedAt;
  turnJobs.newestEnqueuedAt = () => { throw new Error('SQLITE_BUSY'); };
  assert.equal(tick(store), 'tick');
  assert.deepEqual(store.heldUntil(), []);
  turnJobs.newestEnqueuedAt = read;
  tick(store);
  assert.deepEqual(store.holds.map(({ reason, holdEndsAt }) => [reason, holdEndsAt]), [['first_call', NOW - 60_000 + STORE_HOLD_MS]]);
});

// Defects caught: an admission, a turn's end, or a cold alarm that moves the
// hold with no record or the wrong reason; and a record for a renewal that
// moved nothing, which would log every keep-warm tick.
test("the store logs each change of its hold with its reason", async () => {
  const store = admissionStore(undefined, HOLD_ENV, endingRows());
  await store.probe.admitSlackTurn({ turnJob: { id: 'turn_person', turn: {} } });
  store.advance(60_000);
  await store.probe.threadRunnerTurn({ kind: 'markDelivered', id: 'turn_person' });
  await store.probe.threadRunnerTurn({ kind: 'markDelivered', id: 'turn_ask' });
  const ended = NOW + 60_000;
  store.advance(HOLD_MS);
  assert.deepEqual(store.holds, [
    holdRecord({ reason: 'admission', windowMs: HOLD_MS, holdEndsAt: NOW + HOLD_MS, holdLeftMs: HOLD_MS, timerMs: HOLD_MS, renewed: false }),
    holdRecord({ reason: 'turn_end', windowMs: HOLD_MS, holdEndsAt: ended + HOLD_MS, holdLeftMs: HOLD_MS, timerMs: HOLD_MS, renewed: true }),
    holdRecord({ reason: 'expired', windowMs: HOLD_MS, holdEndsAt: ended + HOLD_MS, holdLeftMs: 0 }),
  ]);
  const cold = idleStore(QUIET, { newestEnqueuedAt: NOW - 2 * 60_000, env: HOLD_ENV });
  await cold.fire();
  cold.advance(KEEP_WARM_TICK_MS);
  await cold.fire();
  assert.deepEqual(cold.holds.map(({ reason }) => reason), ['alarm'], 'a cold alarm holds once; the next tick moves nothing');
});

test('idle firings run the retention sweep once per interval, not once per tick', async () => {
  const store = idleStore({ ...QUIET, retention: 300 });
  await store.fire();
  assert.equal(store.sweeps(), 1, 'an instance that starts cold sweeps on its first firing');
  assert.equal(store.records[0]?.retentionMs, 300);
  store.advance(KEEP_WARM_TICK_MS);
  await store.fire();
  assert.equal(store.sweeps(), 1, 'a tick 20 s later skips the sweep');
  assert.equal(store.records[1]?.retentionMs, 0, 'a skipped sweep reads 0');
  store.advance(RETENTION_SWEEP_INTERVAL_MS);
  await store.fire();
  assert.equal(store.sweeps(), 2, 'the interval re-opens it');
  assert.equal(store.records[2]?.retentionMs, 300);
});

test('an idle firing checks for pending cleanups once; a pending one still owes a retry', async () => {
  const none = idleStore(QUIET);
  await none.fire();
  assert.equal(none.cleanupChecks(), 1);
  assert.equal(none.records[0]?.needsRetry, false);
  const pending = idleStore({ ...QUIET, cleanups: 50 });
  await pending.fire();
  assert.equal(pending.cleanupChecks(), 1);
  assert.equal(pending.records[0]?.cleanupsMs, 50, 'the one check decided the cleanup drain');
  assert.equal(pending.records[0]?.needsRetry, true, 'and the retry');
  assert.deepEqual(pending.writes, [NOW + 50 + 2_000]);
});

test("newestEnqueuedAt is the newest turn row's enqueue time, or undefined with none", () => {
  const db = openStateDb(':memory:');
  try {
    let clock = NOW;
    const turnJobs = new TurnJobStoreLogic(db, () => clock);
    assert.equal(turnJobs.newestEnqueuedAt(), undefined);
    turnJobs.enqueue(maintenanceTurnJob('first'));
    clock += 90_000;
    turnJobs.enqueue(maintenanceTurnJob('second'));
    assert.equal(turnJobs.newestEnqueuedAt(), NOW + 90_000);
  } finally {
    db.close();
  }
});

test("a store that starts cold counts only a person's turn rows: an Agent's ask or a setup wake opens no window", async () => {
  const db = openStateDb(':memory:');
  try {
    let clock = NOW - 16 * 60_000;
    const turnJobs = new TurnJobStoreLogic(db, () => clock);
    const enqueueHostTurn = localTurnEnqueue({ turnJobs });
    await enqueueHostTurn(hostTurnJob('ask-0', { agentAsk: AGENT_ASK }));
    assert.equal(turnJobs.newestEnqueuedAt(), undefined, "an Agent's ask alone is no person's turn");
    // The person spoke 15 minutes ago; the host's own turns came since.
    clock = NOW - 15 * 60_000;
    turnJobs.enqueue(maintenanceTurnJob('person'));
    clock = NOW - 60_000;
    await enqueueHostTurn(hostTurnJob('ask', { agentAsk: AGENT_ASK }));
    clock = NOW - 30_000;
    await enqueueHostTurn(hostTurnJob('setup', { setupWake: SETUP_WAKE }));
    assert.equal(turnJobs.newestEnqueuedAt(), NOW - 15 * 60_000, "the person's turn, not the host's later ones");
    const quiet = idleStore(QUIET, { newestEnqueuedAt: turnJobs.newestEnqueuedAt() });
    await quiet.fire();
    assert.deepEqual(quiet.writes, [], 'no window: the person has been quiet for 15 minutes');
    assert.equal(quiet.records[0]?.keepWarm, false);
    // The person speaks again, 2 minutes ago: the window is open.
    clock = NOW - 2 * 60_000;
    turnJobs.enqueue(maintenanceTurnJob('person-2'));
    assert.equal(turnJobs.newestEnqueuedAt(), NOW - 2 * 60_000);
    const live = idleStore(QUIET, { newestEnqueuedAt: turnJobs.newestEnqueuedAt() });
    await live.fire();
    assert.deepEqual(live.writes, [NOW + KEEP_WARM_TICK_MS]);
    assert.equal(live.records[0]?.keepWarm, true);
  } finally {
    db.close();
  }
});

test('an idle alarm runs the test-run pass while a run is not erased, and looks again in 10 seconds', async () => {
  const store = idleStore(QUIET, { testRunUnerased: true });
  let passes = 0;
  store.probe.testRuns = async () => ({ pass: async () => { passes += 1; } });
  await store.fire();
  assert.equal(passes, 1);
  assert.deepEqual(store.writes, [NOW + 10_000]);
  const quiet = idleStore(QUIET);
  quiet.probe.testRuns = async () => { throw new Error('no test run, so no lifecycle is loaded'); };
  await quiet.fire();
  assert.deepEqual(quiet.writes, []);
});

test('in runner mode the alarm waits for a slow test-run pass while it keeps handing over turns that arrive', async () => {
  const store = idleStore(QUIET, { testRunUnerased: true });
  store.probe.env = RUNNER_ENV;
  (store.probe as unknown as { dispatchToRunners(): Promise<number> }).dispatchToRunners = async () => 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  store.probe.testRuns = async () => ({ pass: () => held });
  // The outbox is read once the alarm's other work is done, just before it waits for the pass.
  let waiting = false;
  const stores = store.probe.stores as { management: { nextOutboxDueAt(): number | undefined } };
  stores.management.nextOutboxDueAt = () => { waiting = true; return undefined; };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const firing = store.fire();
  for (let ticks = 0; ticks < 200 && !(waiting && store.probe.dispatchWake); ticks += 1) await tick();
  assert.ok(waiting && store.probe.dispatchWake, 'an admission wakes the alarm while the pass is out');
  const drains = store.gatewayDrains();
  store.probe.dispatchWake();
  for (let ticks = 0; ticks < 200 && store.gatewayDrains() === drains; ticks += 1) await tick();
  assert.equal(store.gatewayDrains(), drains + 1, 'the turn that arrived is admitted and handed over at once');
  release();
  await firing;
  assert.deepEqual(store.writes, [NOW + 10_000]);
});
