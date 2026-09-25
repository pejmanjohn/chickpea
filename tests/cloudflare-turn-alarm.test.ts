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

test('a long turn yields at the alarm budget without spending attempts while new messages run', async () => {
  const { AgentObservationYield, AgentPromptFailure } = await import('../src/slack/flue-dispatch.ts');
  const alarmMethod = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === 'alarm');
  const armMethod = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === 'armAlarmNoLaterThan');
  assert.ok(alarmMethod && armMethod);
  const alarmCode = ts.transpileModule(
    `class AlarmProbe { ${armMethod.getText(source)}\n${alarmMethod.getText(source)} }\nAlarmProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  type Job = {
    id: string; attempts: number; turn: Record<string, unknown>; assignment: object;
    progress: object; dispatchReceipt?: object; dispatchEnvelope?: object;
  };
  const longJob: Job = {
    id: 'long', attempts: 3, turn: { interactionIntent: { disposition: 'work' }, thread: 'coding' },
    assignment: {}, progress: {}, dispatchEnvelope: { instanceId: 'agent' },
    dispatchReceipt: { submissionId: 'submission_long' },
  };
  const jobs = new Map<string, Job>([[longJob.id, longJob]]);
  const attemptWrites: Array<[string, number]> = [];
  const activeWork: Array<[string, boolean]> = [];
  const recovery: string[] = [];
  const events: string[] = [];
  const replayTexts: unknown[] = [];
  let inboxDrains = 0;
  let alarmAt: number | null = null;

  const AlarmProbe = vm.runInNewContext(alarmCode, {
    Date, setTimeout, clearTimeout, AbortController, Promise,
    MAX_TURN_DRAIN_BATCH: 16,
    MAX_TURN_ATTEMPTS: 2,
    MAX_POST_DISPATCH_ATTEMPTS: 8,
    RELAY_RETRY_BACKOFF_MS: 2_000,
    ALARM_TURN_BUDGET_MS: 40,
    ALARM_ADMISSION_RECHECK_MS: 2,
    ALARM_YIELD_REARM_MS: 1_000,
    AgentObservationYield,
    AgentPromptFailure,
    drainAlarmTurnJobs,
    console: { warn() {}, error() {}, info() {} },
    createPlatformProductTelemetry: () => ({ capture() {} }),
    localSettingsStore: () => ({}),
    localGatewayAppStores: () => ({ config: {} }),
    localUsageStore: () => ({}),
    localSlackPresentationState: () => ({}),
    drainGatewayInbox: async () => {
      inboxDrains += 1;
      // A channel mention lands while the coding turn is observing.
      if (inboxDrains === 2) {
        jobs.set('new', {
          id: 'new', attempts: 0, turn: { thread: 'channel' }, assignment: {}, progress: {},
        });
      }
      return false;
    },
    drainLedgerRuns: async () => ({}),
    drainSlackInteractionCleanups: async () => {},
    drainTerminalPresentationRepairs: async () => ({}),
    drainCloudflareScheduleActions: async () => ({}),
    drainCloudflareManagementReceipts: async () => {},
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
      turnId: string; replayText?: string; observationSignal?: AbortSignal;
      onObservationStarted?: () => void; onDelivered?: () => void;
    }) => {
      events.push(`start:${options.turnId}`);
      if (options.turnId === 'long') {
        replayTexts.push(options.replayText);
        options.onObservationStarted?.();
        const signal = options.observationSignal!;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        events.push('yield:long');
        throw new AgentObservationYield();
      }
      options.onDelivered?.();
      events.push(`delivered:${options.turnId}`);
    },
  }) as new () => {
    stores: object; env: object; ctx: object; alarm(): Promise<void>;
    createAlarmIdentityResolver(): unknown;
  };
  const probe = new AlarmProbe();
  probe.env = {};
  probe.ctx = { storage: {
    async getAlarm() { return alarmAt; },
    async setAlarm(at: number) { alarmAt = at; },
  } };
  probe.createAlarmIdentityResolver = () => async () => ({ client: {} });
  probe.stores = {
    management: { cleanupRetention() {}, nextOutboxDueAt: () => undefined },
    turnJobs: {
      listPending: () => [...jobs.values()].map((job) => structuredClone(job)),
      hasPending: (lane = 'legacy') => lane === 'legacy' && jobs.size > 0,
      hasPendingSlackInteractionCleanup: () => false,
      recordAttempt(id: string, attempts: number) {
        attemptWrites.push([id, attempts]);
        jobs.get(id)!.attempts = attempts;
      },
      markDelivered(id: string) { jobs.delete(id); },
      markRecoveryRequired(id: string) { recovery.push(id); },
      markError(id: string) { recovery.push(id); },
      recordInteractionIntent() {},
    },
    slack: {
      setActiveWork(key: string, _id: string, active: boolean) { activeWork.push([key, active]); },
    },
    gatewayInbox: { hasPending: () => false },
  };

  const before = Date.now();
  await probe.alarm();
  const after = Date.now();
  assert.deepEqual(events, ['start:long', 'start:new', 'delivered:new', 'yield:long'],
    'the new message is answered while the long turn is still observing');
  assert.ok(alarmAt !== null && alarmAt >= before + 1_000 && alarmAt <= after + 1_000,
    'a yield re-arms promptly rather than with the error backoff');
  assert.deepEqual(replayTexts, [undefined],
    'a dispatched, unsettled turn reattaches to its reply instead of replaying progress');

  // A 155-minute coding turn yields many times; none of them spends its budget.
  for (let index = 0; index < 12; index += 1) {
    alarmAt = null;
    await probe.alarm();
  }
  assert.equal(jobs.get('long')?.attempts, 3);
  assert.deepEqual(attemptWrites.filter(([id]) => id === 'long').at(-1), ['long', 3]);
  assert.deepEqual(recovery, []);
  assert.deepEqual(activeWork.filter(([key]) => key === 'coding'), [],
    'the running turn keeps its active work');
  assert.equal(events.filter((event) => event === 'yield:long').length, 13);
});
