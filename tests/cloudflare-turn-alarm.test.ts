import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { drainAlarmTurnJobs } from '../src/slack/alarm-turn-drain.ts';
import {
  startRelayAlarmMetrics,
  type RelayAlarmMetrics,
} from '../src/observability/runtime-latency.ts';

// Execute the production RPC methods and alarm helper, not a copy of their
// scheduling logic. The complete Worker is also exercised by verify:cf-smoke;
// this isolated seam lets us set exact alarm times and inject storage failures.
const source = ts.createSourceFile(
  'cloudflare.ts',
  readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const stateClass = source.statements.find((node) =>
  ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
assert.ok(stateClass && ts.isClassDeclaration(stateClass));
const methodNames = [
  'enqueueTurn', 'resumeTurnAfterOAuth', 'slackInstallationRecoveryRetry',
  'maintainWork', 'armAlarmNoLaterThan',
];
const methods = methodNames.map((name) => {
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(source);
});
const batchDeclaration = source.statements.find((node) =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    declaration.name.getText(source) === 'RELAY_BATCH_WINDOW_MS'));
assert.ok(batchDeclaration);
// The alarm runs each job through the shared turn executor; evaluate that
// production function beside it so the same injected collaborators apply.
const executorSource = ts.createSourceFile(
  'turn-executor.ts',
  readFileSync(new URL('../src/slack/turn-executor.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const executorFunction = executorSource.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'executeTurnJob');
assert.ok(executorFunction);
const executorCode = executorFunction.getText(executorSource).replace(/^export /, '');
const compiled = ts.transpileModule(
  `${batchDeclaration.getText(source)}\nclass AlarmProbe { ${methods.join('\n')} }\nAlarmProbe`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string } };
type Probe = {
  ctx: { storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> } };
  call: (callback: (stores: unknown) => unknown) => Result;
  enqueueTurn(job: object): Promise<Result>;
  resumeTurnAfterOAuth(taskId: string, continuationId: string): Promise<Result>;
  slackInstallationRecoveryRetry(workspaceId: string): Promise<Result>;
  maintainWork(at: number): Promise<Result>;
};
const ProbeClass = vm.runInNewContext(compiled, {
  Date,
  oauthResumeTurnJobId: (id: string) => `oauthresume:${id}`,
}) as new () => Probe;
const NOW = 1_800_000_000_000;
const BATCH_MS = 250;
const entryPoints: Array<{ name: string; invoke(probe: Probe): Promise<Result>; inactive: unknown }> = [
  { name: 'new turn', invoke: (probe) => probe.enqueueTurn({ id: 'new' }), inactive: null },
  { name: 'OAuth resume', invoke: (probe) => probe.resumeTurnAfterOAuth('task', 'continuation'), inactive: false },
  { name: 'installation recovery', invoke: (probe) => probe.slackInstallationRecoveryRetry('workspace'), inactive: 0 },
  { name: 'work maintenance', invoke: (probe) => probe.maintainWork(NOW), inactive: false },
];

function fixture(initialAlarm: number | null, result?: Result) {
  const probe = new ProbeClass();
  let alarm = initialAlarm;
  let persisted = false;
  const writes: number[] = [];
  probe.call = (callback) => {
    if (result) return result;
    const value = callback({
      turnJobs: {
        enqueue() {},
        resumeAfterOAuth: () => true,
        runnerView: () => ({ status: 'pending', executor: 'alarm' }),
        retrySlackInstallationRecovery: () => 1,
        hasPending: () => true,
      },
      work: { purgeContent() {} },
      presentations: { maintain() {} },
    });
    persisted = true;
    return { ok: true, value };
  };
  probe.ctx = { storage: {
    async getAlarm() { return alarm; },
    async setAlarm(at) {
      assert.equal(persisted, true, 'work must be persisted before its alarm');
      writes.push(at);
      alarm = at;
    },
  } };
  return { probe, writes, alarm: () => alarm };
}

for (const entry of entryPoints) {
  for (const [label, initial] of [
    ['missing', null], ['later retry', NOW + 120_000],
    ['earlier', NOW + 100], ['equal', NOW + BATCH_MS], ['overdue', NOW - 100],
  ] as const) {
    test(`${entry.name} respects its wake policy for a ${label} alarm`, async (context) => {
      context.mock.method(Date, 'now', () => NOW);
      const { probe, writes, alarm } = fixture(initial);
      assert.equal((await entry.invoke(probe)).ok, true);
      const expected = entry.name === 'work maintenance' && initial !== null
        ? initial
        : Math.min(initial ?? Infinity, NOW + BATCH_MS);
      assert.equal(alarm(), expected);
      assert.deepEqual(writes, initial === expected ? [] : [expected]);
    });
  }

  test(`${entry.name} does not arm an alarm after a failed store operation`, async () => {
    const failure: Result = { ok: false, error: { code: 'store_unavailable' } };
    const { probe, writes } = fixture(null, failure);
    assert.equal(await entry.invoke(probe), failure);
    assert.deepEqual(writes, []);
  });

  test(`${entry.name} rejects if its durable alarm write fails`, async (context) => {
    context.mock.method(Date, 'now', () => NOW);
    const { probe } = fixture(null);
    probe.ctx.storage.setAlarm = async () => { throw new Error('alarm write failed'); };
    await assert.rejects(entry.invoke(probe), /alarm write failed/);
  });

  test(`${entry.name} awaits the durable alarm write before returning`, async (context) => {
    context.mock.method(Date, 'now', () => NOW);
    const { probe } = fixture(null);
    let release!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { release = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    probe.ctx.storage.setAlarm = async () => { signalStarted(); await pendingWrite; };
    let returned = false;
    const invocation = entry.invoke(probe).then(() => { returned = true; });
    try {
      assert.equal(await Promise.race([
        started.then(() => 'write started'),
        invocation.then(() => 'RPC returned early'),
      ]), 'write started');
      assert.equal(returned, false);
    } finally {
      release();
    }
    await invocation;
    assert.equal(returned, true);
  });

  if (entry.inactive !== null) {
    test(`${entry.name} leaves the alarm unchanged when no work became runnable`, async () => {
      const { probe, writes } = fixture(null, { ok: true, value: entry.inactive });
      assert.equal((await entry.invoke(probe)).ok, true);
      assert.deepEqual(writes, []);
    });
  }
}

for (const withPendingTurn of [false, true]) {
  test(`the ${withPendingTurn ? 'pending-turn' : 'empty-turn'} drain ending preserves a concurrent new turn's alarm`, async (context) => {
    context.mock.method(Date, 'now', () => NOW);
    const alarmMethods = ['alarm', 'drainRelayAlarm'].map((name) => {
      const method = stateClass.members.find((member) =>
        ts.isMethodDeclaration(member) && member.name.getText(source) === name);
      assert.ok(method, `production method ${name} exists`);
      return method.getText(source);
    });
    const alarmCode = ts.transpileModule(
      `${batchDeclaration.getText(source)}\n${executorCode}\nclass AlarmProbe { ${methods.join('\n')}\n${alarmMethods.join('\n')} }\nAlarmProbe`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const { probe: storageProbe, alarm, writes } = fixture(null);
    const relayAlarmRecords: object[] = [];
    const AlarmProbe = vm.runInNewContext(alarmCode, {
      Date,
      setTimeout,
      clearTimeout,
      AbortController,
      drainAlarmTurnJobs,
      ALARM_TURN_BUDGET_MS: 60_000,
      ALARM_TURN_HARD_CAP_MS: 120_000,
      ALARM_PENDING_PER_THREAD: 4,
      ALARM_ADMISSION_RECHECK_MS: 2_000,
      ALARM_YIELD_REARM_MS: 1_000,
      MAX_TURN_DRAIN_BATCH: 25,
      RELAY_RETRY_BACKOFF_MS: 1000,
      console: { warn() {} },
      startRelayAlarmMetrics: () => ({ outcome: 'idle', jobsRun: 0, jobsSettled: 0, jobsRetained: 0, longestJobMs: 0 }),
      emitRelayAlarm: (metrics: object) => relayAlarmRecords.push(metrics),
      createPlatformProductTelemetry: () => ({}),
      localSettingsStore: () => ({}),
      localGatewayAppStores: () => ({ config: {} }),
      localUsageStore: () => ({}),
      localSlackPresentationState: () => ({}),
      runTurn: async () => { throw new Error('the preflight fails first'); },
      drainGatewayInbox: async () => false,
      drainLedgerRuns: async () => ({}),
      drainSlackInteractionCleanups: async () => {},
      drainTerminalPresentationRepairs: async () => ({}),
      drainCloudflareScheduleActions: async () => ({}),
      // A new turn can arrive while the receipt delivery awaits Slack.
      drainCloudflareManagementReceipts: async () => { await storageProbe.enqueueTurn({ id: 'during-drain' }); },
      runDriverRetryDelayMs: (_drain: object, retryDelay: number) => retryDelay,
      slackTurnExecutor: () => 'alarm',
      sandboxTurnReaders: () => () => [],
      slackAgentThreadKey: () => 'pending-thread',
      effectiveTurnSlackInstallationId: () => 'workspace',
      normalizeSlackInstallationExecutionError: () => ({
        retryable: true, retryAfterMs: 120_000, reasonCode: 'rate_limited',
      }),
      recordSlackInstallationUnavailable() {},
      earliestDefined: (...values: Array<number | undefined>) =>
        values.filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0],
    }) as new () => Probe & {
      stores: object;
      alarm(): Promise<void>;
      createAlarmIdentityResolver(): object;
    };
    const drainingProbe = new AlarmProbe();
    drainingProbe.ctx = storageProbe.ctx;
    (drainingProbe as unknown as { env: object }).env = {};
    // A class field the method-only probe does not carry.
    (drainingProbe as unknown as { carriedAlarmTurns: Map<string, string> }).carriedAlarmTurns = new Map();
    drainingProbe.createAlarmIdentityResolver = () => async () => { throw new Error('rate limited'); };
    drainingProbe.stores = {
      management: { cleanupRetention() {}, nextOutboxDueAt: () => NOW + 120_000 },
      turnJobs: {
        listPendingByThread: () => withPendingTurn ? [{ turn: {}, progress: {}, assignment: {} }] : [],
        hasPending: () => withPendingTurn,
        hasPendingSlackInteractionCleanup: () => false,
        hasHandoffs: () => false,
      },
      gatewayInbox: { hasPending: () => false },
    };
    await drainingProbe.alarm();
    assert.equal(alarm(), NOW + BATCH_MS);
    assert.deepEqual(writes, [NOW + BATCH_MS]);
    assert.equal(relayAlarmRecords.length, 1);
    assert.equal(
      (relayAlarmRecords[0] as { outcome?: string }).outcome,
      withPendingTurn ? 'drained' : 'idle',
    );
    assert.equal((relayAlarmRecords[0] as { jobsListed?: number }).jobsListed, withPendingTurn ? 1 : 0);
    assert.equal((relayAlarmRecords[0] as { rearmed?: boolean }).rearmed, true);
  });
}

type AlarmJob = {
  id: string; attempts: number; turn: Record<string, unknown>; assignment: object;
  progress: object; dispatchReceipt?: { submissionId: string; acceptedAt?: string };
  dispatchEnvelope?: object;
  /** The executor column: absent is `alarm`. */
  executor?: 'handoff' | 'runner';
};

type RunnerAdmission = { id: string; threadKey: string; payload: unknown };

/** The production alarm() with in-memory stores and a scripted runTurn. */
async function alarmHarness(initial: AlarmJob[], hooks: {
  onInboxDrain?: (
    count: number,
    jobs: Map<string, AlarmJob>,
    onAdmitted?: () => void,
  ) => void | Promise<void>;
  /** Holds this runner admission until the returned promise settles. */
  admissionGate?: (admission: RunnerAdmission) => Promise<void> | undefined;
  /** SLACK_TAG_TURN_EXECUTOR=runner with a fake SLACK_THREAD_RUNNER namespace. */
  runnerMode?: boolean;
  /** Rejects this runner admission (the hand-off stays unconfirmed). */
  failAdmission?: (admission: RunnerAdmission) => boolean;
  /** The runner refuses this admission (its presentation import failed). */
  refuseAdmission?: (admission: RunnerAdmission) => boolean;
  /** Runs while a turn is being admitted to its runner. */
  onRunnerAdmit?: (id: string, jobs: Map<string, AlarmJob>) => void;
  /** Runs as the alarm starts its other due work (the ledger drain). */
  beforeChores?: () => void;
  /** Runs inside the alarm's receipt delivery (its other due work). */
  duringChores?: (jobs: Map<string, AlarmJob>, admit: () => Promise<void>) => Promise<void>;
} = {}) {
  const { AgentObservationYield, AgentPromptFailure } = await import('../src/slack/flue-dispatch.ts');
  const { alarmYieldIsFree } = await import('../src/slack/alarm-turn-drain.ts');
  const alarmMethods = [
    'armAlarmNoLaterThan', 'alarm', 'drainRelayAlarm', 'dispatchToRunners', 'admitToRunner',
    'dispatchingWhile',
  ].map((name) => {
    const method = (stateClass as ts.ClassDeclaration).members.find((member) =>
      ts.isMethodDeclaration(member) && member.name.getText(source) === name);
    assert.ok(method, `production method ${name} exists`);
    return method.getText(source);
  });
  const alarmCode = ts.transpileModule(
    `${executorCode}\nclass AlarmProbe { ${alarmMethods.join('\n')} }\nAlarmProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const jobs = new Map(initial.map((job) => [job.id, job]));
  const record = {
    jobs,
    attemptWrites: [] as Array<[string, number]>,
    activeWork: [] as Array<[string, boolean]>,
    recovery: [] as string[],
    events: [] as string[],
    replayTexts: [] as unknown[],
    codingSeeds: [] as unknown[],
    alarmAt: null as number | null,
    relayAlarms: [] as RelayAlarmMetrics[],
    admissions: [] as RunnerAdmission[],
    admitting: 0,
    maxAdmitting: 0,
  };
  const alarmOwned = (job: AlarmJob) => job.executor === undefined;
  let inboxDrains = 0;
  const AlarmProbe = vm.runInNewContext(alarmCode, {
    Date, setTimeout, clearTimeout, AbortController, Promise,
    MAX_TURN_DRAIN_BATCH: 16,
    RUNNER_DISPATCH_MAX_PAGES: 16,
    slackTurnExecutor: () => (hooks.runnerMode ? 'runner' : 'alarm'),
    sandboxTurnReaders: () => () => [],
    threadRunnerStub: (_env: unknown, threadKey: string) => ({
      async admit(admission: RunnerAdmission) {
        assert.equal(admission.threadKey, threadKey, 'each turn goes to its own thread runner');
        record.admitting += 1;
        record.maxAdmitting = Math.max(record.maxAdmitting, record.admitting);
        try {
          await hooks.admissionGate?.(admission);
        } finally {
          record.admitting -= 1;
        }
        if (hooks.failAdmission?.(admission)) throw new Error('runner unavailable');
        if (hooks.refuseAdmission?.(admission)) {
          return { admitted: false, refused: 'presentation_import_failed' };
        }
        record.admissions.push(admission);
        hooks.onRunnerAdmit?.(admission.id, jobs);
        return { admitted: true };
      },
    }),
    MAX_TURN_ATTEMPTS: 2,
    MAX_POST_DISPATCH_ATTEMPTS: 8,
    RELAY_RETRY_BACKOFF_MS: 2_000,
    ALARM_TURN_BUDGET_MS: 40,
    ALARM_TURN_HARD_CAP_MS: 400,
    ALARM_PENDING_PER_THREAD: 4,
    ALARM_ADMISSION_RECHECK_MS: 2,
    ALARM_YIELD_REARM_MS: 1_000,
    DURABLE_RECOVERY_FAILURE_TEXT: 'recovery notice',
    AgentObservationYield,
    AgentPromptFailure,
    alarmYieldIsFree,
    drainAlarmTurnJobs,
    startRelayAlarmMetrics,
    emitRelayAlarm: (metrics: RelayAlarmMetrics) => record.relayAlarms.push({ ...metrics }),
    console: { warn() {}, error() {}, info() {} },
    createPlatformProductTelemetry: () => ({ capture() {} }),
    localSettingsStore: () => ({}),
    localGatewayAppStores: () => ({ config: {} }),
    localUsageStore: () => ({}),
    localSlackPresentationState: () => ({}),
    settlementFailureFacts: () => [],
    drainGatewayInbox: async (_stores: unknown, _env: unknown, onAdmitted?: () => void) => {
      inboxDrains += 1;
      await hooks.onInboxDrain?.(inboxDrains, jobs, onAdmitted);
      return false;
    },
    drainLedgerRuns: async () => { hooks.beforeChores?.(); return {}; },
    drainSlackInteractionCleanups: async () => { record.events.push('tick:cleanups'); },
    drainTerminalPresentationRepairs: async () => ({}),
    drainCloudflareScheduleActions: async () => {
      record.events.push('tick:schedule');
      return {};
    },
    drainCloudflareManagementReceipts: async () => {
      record.events.push('tick:receipts');
      await hooks.duringChores?.(jobs, async () => {
        await (probe as unknown as { armAlarmNoLaterThan(at: number): Promise<void> })
          .armAlarmNoLaterThan(Date.now() + 250);
      });
    },
    runDriverRetryDelayMs: (_drain: object, retryDelay: number) => retryDelay,
    slackAgentThreadKey: (turn: { thread: string }) => turn.thread,
    StateStoreUnavailable: class StateStoreUnavailable extends Error {},
    effectiveTurnSlackInstallationId: () => 'workspace',
    verifySlackInstallationTurnAccess: async () => {},
    runtimePlanHasCodingWorkspace: () => false,
    replayTextForTurnProgress: () => 'Pull request #12 is already open',
    recordDeliveredSlackAgentMessage() {},
    earliestDefined: (...values: Array<number | undefined>) =>
      values.filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0],
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: {
      turnId: string; replayText?: string; replayTerminalResult?: string;
      observationSignal?: AbortSignal; onObservationStarted?: () => void;
      onDelivered?: () => void;
      flueDispatch?: { dispatchReceipt?: object };
      codingTaskStarted?: boolean;
    }) => {
      if (options.replayTerminalResult === 'failure') {
        record.events.push(`recovery-notice:${options.turnId}`);
        options.onDelivered?.();
        return;
      }
      record.events.push(`start:${options.turnId}`);
      if (options.turnId.startsWith('long')) {
        record.replayTexts.push(options.replayText);
        record.codingSeeds.push(options.codingTaskStarted);
        options.onObservationStarted?.();
        const signal = options.observationSignal!;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        record.events.push(`yield:${options.turnId}`);
        throw new AgentObservationYield();
      }
      options.onDelivered?.();
      record.events.push(`delivered:${options.turnId}`);
    },
  }) as new () => {
    stores: object; env: object; ctx: object; alarm(): Promise<void>;
    createAlarmIdentityResolver(): unknown;
  };
  const probe = new AlarmProbe();
  probe.env = hooks.runnerMode ? { SLACK_THREAD_RUNNER: {} } : {};
  (probe as unknown as { carriedAlarmTurns: Map<string, string> }).carriedAlarmTurns = new Map();
  (probe as unknown as { admissionsSeen: number }).admissionsSeen = 0;
  probe.ctx = { storage: {
    async getAlarm() { return record.alarmAt; },
    async setAlarm(at: number) { record.alarmAt = at; },
  } };
  probe.createAlarmIdentityResolver = () => async () => ({ client: {} });
  probe.stores = {
    management: { cleanupRetention() {}, nextOutboxDueAt: () => undefined },
    turnJobs: {
      listPendingByThread: (input: { executor?: string; dispatchedOnly?: boolean }) => {
        assert.equal(input.executor, 'alarm', 'the alarm never lists runner rows');
        return [...jobs.values()]
          .filter((job) => alarmOwned(job) && (!input.dispatchedOnly || job.dispatchEnvelope))
          .map((job) => structuredClone(job));
      },
      hasPending: (lane = 'legacy') =>
        lane === 'legacy' && [...jobs.values()].some(alarmOwned),
      hasPendingSlackInteractionCleanup: () => false,
      // Same contract as TurnJobStoreLogic.listDispatchable (tested there).
      listDispatchable: (input: { limit: number }) => {
        const threads = new Set<unknown>();
        return [...jobs.values()].filter((job) => {
          if (job.executor === 'runner' || threads.has(job.turn.thread) ||
              threads.size >= input.limit) return false;
          threads.add(job.turn.thread);
          return alarmOwned(job) && !job.dispatchEnvelope;
        }).map((job) => structuredClone(job));
      },
      assignRunner(id: string) {
        const job = jobs.get(id);
        if (!job || !alarmOwned(job)) return false;
        job.executor = 'handoff';
        return true;
      },
      confirmRunner(id: string) {
        const job = jobs.get(id);
        if (job?.executor === 'handoff') job.executor = 'runner';
      },
      listHandoffs: () => [...jobs.values()].filter((job) => job.executor === 'handoff')
        .map((job) => structuredClone(job)),
      hasHandoffs: () => [...jobs.values()].some((job) => job.executor === 'handoff'),
      recordAttempt(id: string, attempts: number) {
        record.attemptWrites.push([id, attempts]);
        jobs.get(id)!.attempts = attempts;
      },
      markDelivered(id: string) { jobs.delete(id); },
      markRecoveryRequired(id: string) { record.recovery.push(id); },
      markError(id: string) { record.recovery.push(id); jobs.delete(id); },
      recordInteractionIntent() {},
    },
    slack: {
      setActiveWork(key: string, _id: string, active: boolean) {
        record.activeWork.push([key, active]);
      },
      isCodingActiveWork: (key: string) => key === 'coding',
    },
    gatewayInbox: { hasPending: () => false },
    presentations: { get: (runId: string) => ({ runId, projectionVersion: 3 }) },
  };
  return { probe, record };
}

function channelJob(id: string, thread: string): AlarmJob {
  return { id, attempts: 0, turn: { thread }, assignment: {}, progress: {} };
}

function longCodingJob(id: string, attempts: number, acceptedAt: string): AlarmJob {
  return {
    id, attempts, turn: { interactionIntent: { disposition: 'work' }, thread: 'coding' },
    assignment: {}, progress: {}, dispatchEnvelope: { instanceId: 'agent' },
    dispatchReceipt: { submissionId: `submission_${id}`, acceptedAt },
  };
}

test('a long turn yields at the alarm budget without spending attempts while new messages run', async () => {
  const { probe, record } = await alarmHarness(
    [longCodingJob('long', 3, new Date().toISOString())],
    {
      onInboxDrain: (count, jobs) => {
        // A channel mention lands while the coding turn is observing.
        if (count === 2) {
          jobs.set('new', {
            id: 'new', attempts: 0, turn: { thread: 'channel' }, assignment: {}, progress: {},
          });
        }
      },
    },
  );
  const before = Date.now();
  await probe.alarm();
  const after = Date.now();
  const turnEvents = record.events.filter((event) => !event.startsWith('tick:'));
  assert.deepEqual(turnEvents, ['start:long', 'start:new', 'delivered:new', 'yield:long'],
    'the new message is answered while the long turn is still observing');
  assert.ok(record.alarmAt !== null && record.alarmAt >= before + 1_000 &&
    record.alarmAt <= after + 1_000,
  'a yield re-arms promptly rather than with the error backoff');
  assert.deepEqual(record.replayTexts, [undefined],
    'a dispatched, unsettled turn reattaches to its reply instead of replaying progress');
  const [yieldedAlarm] = record.relayAlarms;
  assert.equal(record.relayAlarms.length, 1);
  assert.equal(yieldedAlarm!.yielded, true, 'relay_alarm reports the budget yield');
  assert.equal(yieldedAlarm!.jobsListed, 1);
  assert.equal(yieldedAlarm!.groups, 2, 'the thread admitted mid-drain counts');
  assert.equal(yieldedAlarm!.jobsRun, 2);
  assert.equal(yieldedAlarm!.jobsSettled, 1);
  assert.equal(yieldedAlarm!.jobsRetained, 1, 'the yielded turn stays pending for reattachment');
  assert.ok(yieldedAlarm!.longestJobMs <= yieldedAlarm!.turnsMs);
  assert.equal(yieldedAlarm!.jobsCarried, 0);
  assert.deepEqual(record.codingSeeds, [true],
    'a reattached coding turn starts its observation from the quiet-worker cadence');

  // A 155-minute coding turn yields many times; none of them spends its budget.
  for (let index = 0; index < 12; index += 1) {
    record.alarmAt = null;
    await probe.alarm();
  }
  assert.equal(record.jobs.get('long')?.attempts, 3);
  assert.deepEqual(record.attemptWrites.filter(([id]) => id === 'long').at(-1), ['long', 3]);
  assert.deepEqual(record.recovery, []);
  assert.deepEqual(record.activeWork.filter(([key]) => key === 'coding'), [],
    'the running turn keeps its active work');
  assert.equal(record.events.filter((event) => event === 'yield:long').length, 13);
});

test('due receipts and schedule actions run while a long turn observes, before it yields', async () => {
  const { probe, record } = await alarmHarness([longCodingJob('long', 0, new Date().toISOString())]);
  await probe.alarm();
  const yieldAt = record.events.indexOf('yield:long');
  const receiptsAt = record.events.indexOf('tick:receipts');
  const scheduleAt = record.events.indexOf('tick:schedule');
  assert.ok(receiptsAt > record.events.indexOf('start:long') && receiptsAt < yieldAt,
    'a management receipt armed mid-drain is delivered without waiting for the budget');
  assert.ok(scheduleAt >= 0 && scheduleAt < yieldAt);
});

test('a submission past its durability stops yielding for free and ends with the recovery notice', async () => {
  const stale = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
  const { probe, record } = await alarmHarness([longCodingJob('long', 6, stale)]);
  await probe.alarm();
  assert.equal(record.jobs.get('long')?.attempts, 7, 'the yield counts as an attempt');
  assert.deepEqual(record.activeWork, [['coding', false]]);
  await probe.alarm();
  assert.deepEqual(record.events.filter((event) => !event.startsWith('tick:')), [
    'start:long', 'yield:long', 'start:long', 'yield:long', 'recovery-notice:long',
  ]);
  assert.equal(record.jobs.has('long'), false, 'the exhausted turn is terminal');
});

test('runner mode hands new turns to their thread runners without running them', async () => {
  const { probe, record } = await alarmHarness([
    { ...channelJob('a1', 'thread-a'), runId: 'run-a1' } as AlarmJob,
    channelJob('a2', 'thread-a'),
    channelJob('b1', 'thread-b'),
  ], { runnerMode: true });
  await probe.alarm();
  assert.deepEqual(record.events.filter((event) => !event.startsWith('tick:')), [],
    'the alarm executes nothing it handed over');
  assert.deepEqual(record.admissions.map(({ id, threadKey }) => [id, threadKey]),
    [['a1', 'thread-a'], ['b1', 'thread-b'], ['a2', 'thread-a']],
    "the oldest row of each thread first; a thread's next row on the next page");
  assert.equal(JSON.stringify(record.admissions[0]!.payload),
    JSON.stringify({ presentation: { runId: 'run-a1', projectionVersion: 3 } }),
    'the runner receives the presentation as the state store holds it');
  assert.deepEqual([...record.jobs.values()].map((job) => job.executor), ['runner', 'runner', 'runner']);
  assert.equal(record.relayAlarms.at(-1)!.jobsDispatched, 3);
  assert.equal(record.alarmAt, null, 'nothing is left for the alarm to wake for');
});

test('runner mode pages through more threads than one listing holds', async () => {
  const jobs = Array.from({ length: 40 }, (_, index) => channelJob(`t${index}`, `thread-${index}`));
  const { probe, record } = await alarmHarness(jobs, { runnerMode: true });
  await probe.alarm();
  assert.equal(record.admissions.length, 40);
  assert.equal(record.relayAlarms.at(-1)!.jobsDispatched, 40);
});

test('runner mode finishes turns the alarm already dispatched, then hands the thread over', async () => {
  const dispatched: AlarmJob = {
    ...channelJob('old', 'thread-a'),
    dispatchEnvelope: { instanceId: 'agent' },
    dispatchReceipt: { submissionId: 'submission_old', acceptedAt: new Date().toISOString() },
  };
  const { probe, record } = await alarmHarness(
    [dispatched, channelJob('next', 'thread-a'), channelJob('other', 'thread-b')],
    { runnerMode: true },
  );
  await probe.alarm();
  assert.deepEqual(record.admissions.map(({ id }) => id), ['other'],
    'a thread whose alarm turn is in flight keeps its later rows for now');
  assert.deepEqual(record.events.filter((event) => !event.startsWith('tick:')),
    ['start:old', 'delivered:old'], 'the alarm reattaches only to its own dispatched turn');
  record.alarmAt = null;
  await probe.alarm();
  assert.deepEqual(record.admissions.map(({ id }) => id), ['other', 'next']);
});

test('runner mode keeps an unconfirmed hand-off first in its thread and admits it again', async () => {
  let failing = true;
  const { probe, record } = await alarmHarness(
    [channelJob('first', 'thread-a'), channelJob('second', 'thread-a')],
    { runnerMode: true, failAdmission: ({ id }) => failing && id === 'first' },
  );
  const before = Date.now();
  await probe.alarm();
  assert.deepEqual(record.admissions, []);
  assert.equal(record.jobs.get('first')!.executor, 'handoff', "the row is the runner's; the alarm never runs it");
  assert.ok(record.alarmAt !== null && record.alarmAt >= before + 2_000, 'a failed hand-off retries with the backoff');
  assert.deepEqual(record.events.filter((event) => !event.startsWith('tick:')), []);
  failing = false;
  record.alarmAt = null;
  await probe.alarm();
  assert.deepEqual(record.admissions.map(({ id }) => id), ['first', 'second'],
    "the lost hand-off is admitted before its thread's next row");
  assert.deepEqual([...record.jobs.values()].map((job) => job.executor), ['runner', 'runner']);
});

test('runner mode hands a message admitted mid-drain to its runner while an alarm turn observes', async () => {
  const { probe, record } = await alarmHarness(
    [longCodingJob('long', 0, new Date().toISOString())],
    {
      runnerMode: true,
      onInboxDrain: (count, jobs) => {
        if (count === 2) jobs.set('new', channelJob('new', 'channel'));
      },
    },
  );
  await probe.alarm();
  assert.deepEqual(record.admissions.map(({ id }) => id), ['new']);
  assert.deepEqual(record.events.filter((event) => !event.startsWith('tick:')), ['start:long', 'yield:long'],
    "the new message never waits for, or runs beside, the alarm's own turn");
});

test('an OAuth continuation already handed to a thread runner is admitted there again', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const resumeMethods = ['resumeTurnAfterOAuth', 'admitToRunner', 'armAlarmNoLaterThan'].map((name) => {
    const method = stateClass.members.find((member) =>
      ts.isMethodDeclaration(member) && member.name.getText(source) === name);
    assert.ok(method, `production method ${name} exists`);
    return method.getText(source);
  });
  const code = ts.transpileModule(
    `${batchDeclaration.getText(source)}\nclass ResumeProbe { ${resumeMethods.join('\n')} }\nResumeProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const admissions: Array<{ id: string; threadKey: string }> = [];
  const confirmed: string[] = [];
  const ResumeProbe = vm.runInNewContext(code, {
    Date,
    console: { warn() {} },
    oauthResumeTurnJobId: (id: string) => `oauthresume:${id}`,
    slackAgentThreadKey: () => 'T1:C1:1.0:owner-i1',
    threadRunnerStub: (_env: unknown, threadKey: string) => ({
      async admit(job: { id: string }) {
        admissions.push({ id: job.id, threadKey });
        return { admitted: false };
      },
    }),
  }) as new () => Probe & { stores: object; env: object };
  for (const executor of ['runner', 'alarm'] as const) {
    admissions.length = 0;
    const probe = new ResumeProbe();
    const job = { id: 'oauthresume:c1', turn: {}, assignment: {} };
    const stores = {
      turnJobs: {
        resumeAfterOAuth: () => true,
        runnerView: (id: string) => {
          assert.equal(id, 'oauthresume:c1');
          return { status: 'pending', executor, job };
        },
        confirmRunner: (id: string) => confirmed.push(id),
      },
      presentations: { get: () => undefined },
    };
    probe.stores = stores;
    probe.env = {};
    probe.call = (callback) => ({ ok: true, value: callback(stores) });
    const writes: number[] = [];
    probe.ctx = { storage: {
      async getAlarm() { return null; },
      async setAlarm(at) { writes.push(at); },
    } };
    const result = await probe.resumeTurnAfterOAuth('task', 'c1');
    assert.equal(JSON.stringify(result), JSON.stringify({ ok: true, value: true }));
    if (executor === 'runner') {
      assert.deepEqual(admissions, [{ id: 'oauthresume:c1', threadKey: 'T1:C1:1.0:owner-i1' }]);
      assert.deepEqual(writes, [], 'its runner resumes it; the state store alarm is not needed');
    } else {
      assert.deepEqual(admissions, [], 'a new continuation is dispatched like any turn');
      assert.deepEqual(writes, [NOW + BATCH_MS]);
    }
  }
  assert.deepEqual(confirmed, ['oauthresume:c1']);
});

test('runner mode: one runner failing its admissions holds only its own thread', async () => {
  const { probe, record } = await alarmHarness(
    [channelJob('stuck', 'thread-a'), channelJob('stuck-next', 'thread-a'),
      channelJob('b1', 'thread-b'), channelJob('c1', 'thread-c')],
    { runnerMode: true, failAdmission: ({ threadKey }) => threadKey === 'thread-a' },
  );
  await probe.alarm();
  assert.deepEqual(record.admissions.map(({ id }) => id), ['b1', 'c1'],
    'the other threads are handed over in the same alarm');
  assert.equal(record.jobs.get('stuck')!.executor, 'handoff');
  assert.equal(record.jobs.get('stuck-next')!.executor, undefined, "the stuck thread's next row waits");
  assert.ok(record.alarmAt !== null, 'the alarm comes back for the hand-off');
});

test('runner mode: a runner that refuses a hand-off keeps it a hand-off', async () => {
  let refusing = true;
  const { probe, record } = await alarmHarness([channelJob('refused', 'thread-a')], {
    runnerMode: true,
    refuseAdmission: () => refusing,
  });
  await probe.alarm();
  assert.equal(record.jobs.get('refused')!.executor, 'handoff');
  refusing = false;
  record.alarmAt = null;
  await probe.alarm();
  assert.equal(record.jobs.get('refused')!.executor, 'runner');
});

test('runner mode hands over a turn admitted while the alarm runs its other work, in the same alarm', async () => {
  let admitted = false;
  const { probe, record } = await alarmHarness([], {
    runnerMode: true,
    duringChores: async (jobs, admit) => {
      if (admitted) return;
      admitted = true;
      jobs.set('late', channelJob('late', 'thread-late'));
      await admit();
      // The receipt drain keeps working for a while after the admission.
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  await probe.alarm();
  assert.deepEqual(record.admissions.map(({ id }) => id), ['late'],
    'handed to its runner before this alarm returned');
  assert.equal(record.relayAlarms.at(-1)!.jobsDispatched, 1);
});

test('runner mode hands each admitted turn over at once, side by side with admissions in flight', async () => {
  // One slow runner admission (a cold runner) must not hold back the next
  // conversation's hand-off: each admission starts its own.
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const { probe, record } = await alarmHarness([], {
    runnerMode: true,
    admissionGate: ({ id }) => (id === 'slow' ? slow : undefined),
    onInboxDrain: async (count, jobs, onAdmitted) => {
      if (count !== 1) return;
      jobs.set('slow', channelJob('slow', 'thread-a'));
      onAdmitted?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const id of ['b', 'c', 'd']) {
        jobs.set(id, channelJob(id, `thread-${id}`));
        onAdmitted?.();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      // Released only once the later turns are with their runners (or late).
      const deadline = Date.now() + 500;
      while (record.admissions.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      releaseSlow();
    },
  });
  await probe.alarm();
  assert.deepEqual(record.admissions.map(({ id }) => id), ['b', 'c', 'd', 'slow'],
    'later conversations reach their runners while the slow admission is in flight');
  assert.ok(record.maxAdmitting >= 2, `admissions overlap (max ${record.maxAdmitting})`);
  assert.equal(record.relayAlarms.at(-1)!.jobsDispatched, 4);
  assert.deepEqual([...record.jobs.values()].map((job) => job.executor),
    ['runner', 'runner', 'runner', 'runner']);
});

test('runner mode hands over a turn admitted during the alarm\'s first inbox pass before its other work', async () => {
  let deliveryWaiting = false;
  let handedOverBeforeChores: string[] | undefined;
  const { probe, record } = await alarmHarness([channelJob('first', 'thread-a')], {
    runnerMode: true,
    onRunnerAdmit: (id) => {
      // A new Slack event reaches the gateway inbox while the first hand-off
      // is in flight; it becomes a turn row when the inbox is drained.
      if (id !== 'first') return;
      deliveryWaiting = true;
      void (probe as unknown as { armAlarmNoLaterThan(at: number, admission: boolean): Promise<void> })
        .armAlarmNoLaterThan(Date.now() + 250, true);
    },
    onInboxDrain: (_count, jobs) => {
      if (!deliveryWaiting) return;
      deliveryWaiting = false;
      jobs.set('second', channelJob('second', 'thread-b'));
    },
    beforeChores: () => {
      handedOverBeforeChores ??= record.admissions.map(({ id }) => id);
    },
  });
  await probe.alarm();
  assert.deepEqual(handedOverBeforeChores, ['first', 'second'],
    'both turns reach their runners before the alarm turns to its other work');
});
