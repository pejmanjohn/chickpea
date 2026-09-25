import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { drainAlarmTurnJobs } from '../src/slack/alarm-turn-drain.ts';

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
const ProbeClass = vm.runInNewContext(compiled, { Date }) as new () => Probe;
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
    const alarmMethod = stateClass.members.find((member) =>
      ts.isMethodDeclaration(member) && member.name.getText(source) === 'alarm');
    assert.ok(alarmMethod);
    const alarmCode = ts.transpileModule(
      `${batchDeclaration.getText(source)}\nclass AlarmProbe { ${methods.join('\n')}\n${alarmMethod.getText(source)} }\nAlarmProbe`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const { probe: storageProbe, alarm, writes } = fixture(null);
    const AlarmProbe = vm.runInNewContext(alarmCode, {
      Date,
      setTimeout,
      clearTimeout,
      AbortController,
      drainAlarmTurnJobs,
      ALARM_TURN_BUDGET_MS: 60_000,
      ALARM_ADMISSION_RECHECK_MS: 2_000,
      ALARM_YIELD_REARM_MS: 1_000,
      MAX_TURN_DRAIN_BATCH: 25,
      RELAY_RETRY_BACKOFF_MS: 1000,
      console: { warn() {} },
      createPlatformProductTelemetry: () => ({}),
      localSettingsStore: () => ({}),
      localGatewayAppStores: () => ({ config: {} }),
      localUsageStore: () => ({}),
      drainGatewayInbox: async () => false,
      drainLedgerRuns: async () => ({}),
      drainSlackInteractionCleanups: async () => {},
      drainTerminalPresentationRepairs: async () => ({}),
      drainCloudflareScheduleActions: async () => ({}),
      // A new turn can arrive while the receipt delivery awaits Slack.
      drainCloudflareManagementReceipts: async () => { await storageProbe.enqueueTurn({ id: 'during-drain' }); },
      runDriverRetryDelayMs: (_drain: object, retryDelay: number) => retryDelay,
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
    drainingProbe.createAlarmIdentityResolver = () => async () => { throw new Error('rate limited'); };
    drainingProbe.stores = {
      management: { cleanupRetention() {}, nextOutboxDueAt: () => NOW + 120_000 },
      turnJobs: {
        listPending: () => withPendingTurn ? [{ turn: {}, progress: {}, assignment: {} }] : [],
        hasPending: () => withPendingTurn,
        hasPendingSlackInteractionCleanup: () => false,
      },
      gatewayInbox: { hasPending: () => false },
    };
    await drainingProbe.alarm();
    assert.equal(alarm(), NOW + BATCH_MS);
    assert.deepEqual(writes, [NOW + BATCH_MS]);
  });
}

type AlarmJob = {
  id: string; attempts: number; turn: Record<string, unknown>; assignment: object;
  progress: object; dispatchReceipt?: { submissionId: string; acceptedAt?: string };
  dispatchEnvelope?: object;
};

/** The production alarm() with in-memory stores and a scripted runTurn. */
async function alarmHarness(initial: AlarmJob[], hooks: {
  onInboxDrain?: (count: number, jobs: Map<string, AlarmJob>) => void;
} = {}) {
  const { AgentObservationYield, AgentPromptFailure } = await import('../src/slack/flue-dispatch.ts');
  const { alarmYieldIsFree } = await import('../src/slack/alarm-turn-drain.ts');
  const alarmMethod = (stateClass as ts.ClassDeclaration).members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === 'alarm');
  const armMethod = (stateClass as ts.ClassDeclaration).members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === 'armAlarmNoLaterThan');
  assert.ok(alarmMethod && armMethod);
  const alarmCode = ts.transpileModule(
    `class AlarmProbe { ${armMethod.getText(source)}\n${alarmMethod.getText(source)} }\nAlarmProbe`,
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
    alarmAt: null as number | null,
  };
  let inboxDrains = 0;
  const AlarmProbe = vm.runInNewContext(alarmCode, {
    Date, setTimeout, clearTimeout, AbortController, Promise,
    MAX_TURN_DRAIN_BATCH: 16,
    MAX_TURN_ATTEMPTS: 2,
    MAX_POST_DISPATCH_ATTEMPTS: 8,
    RELAY_RETRY_BACKOFF_MS: 2_000,
    ALARM_TURN_BUDGET_MS: 40,
    ALARM_ADMISSION_RECHECK_MS: 2,
    ALARM_YIELD_REARM_MS: 1_000,
    DURABLE_RECOVERY_FAILURE_TEXT: 'recovery notice',
    AgentObservationYield,
    AgentPromptFailure,
    alarmYieldIsFree,
    drainAlarmTurnJobs,
    console: { warn() {}, error() {}, info() {} },
    createPlatformProductTelemetry: () => ({ capture() {} }),
    localSettingsStore: () => ({}),
    localGatewayAppStores: () => ({ config: {} }),
    localUsageStore: () => ({}),
    localSlackPresentationState: () => ({}),
    settlementFailureFacts: () => [],
    drainGatewayInbox: async () => {
      inboxDrains += 1;
      hooks.onInboxDrain?.(inboxDrains, jobs);
      return false;
    },
    drainLedgerRuns: async () => ({}),
    drainSlackInteractionCleanups: async () => { record.events.push('tick:cleanups'); },
    drainTerminalPresentationRepairs: async () => ({}),
    drainCloudflareScheduleActions: async () => {
      record.events.push('tick:schedule');
      return {};
    },
    drainCloudflareManagementReceipts: async () => { record.events.push('tick:receipts'); },
    runDriverRetryDelayMs: (_drain: object, retryDelay: number) => retryDelay,
    slackAgentThreadKey: (turn: { thread: string }) => turn.thread,
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
    }) => {
      if (options.replayTerminalResult === 'failure') {
        record.events.push(`recovery-notice:${options.turnId}`);
        options.onDelivered?.();
        return;
      }
      record.events.push(`start:${options.turnId}`);
      if (options.turnId.startsWith('long')) {
        record.replayTexts.push(options.replayText);
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
  probe.env = {};
  probe.ctx = { storage: {
    async getAlarm() { return record.alarmAt; },
    async setAlarm(at: number) { record.alarmAt = at; },
  } };
  probe.createAlarmIdentityResolver = () => async () => ({ client: {} });
  probe.stores = {
    management: { cleanupRetention() {}, nextOutboxDueAt: () => undefined },
    turnJobs: {
      listPending: () => [...jobs.values()].map((job) => structuredClone(job)),
      hasPending: (lane = 'legacy') => lane === 'legacy' && jobs.size > 0,
      hasPendingSlackInteractionCleanup: () => false,
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
    },
    gatewayInbox: { hasPending: () => false },
  };
  return { probe, record };
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
