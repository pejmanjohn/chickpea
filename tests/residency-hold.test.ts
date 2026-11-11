import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { slackThreadCloudflareExtension } from '../src/agents/turn-input.ts';
import { objectInstallationEnv } from '../src/config/installation-scope.ts';
import { RunnerBootMarks } from '../src/observability/runtime-latency.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { createRunnerSupersedeState, runnerLoopScheduler } from '../src/slack/thread-runner-loop.ts';
import { DoSqlStateDb } from '../src/state/do-state-db.ts';
import {
  MAX_RESIDENCY_HOLD_MS,
  parseResidencyHoldMs,
  RESIDENCY_HOLD_VARIABLE,
  ResidencyHold,
  residencyHoldMs,
} from '../src/state/residency-hold.ts';
import { FakeObjectRestoreContext, FakeObjectStorage } from './helpers/installation-objects.ts';
import { HOLD_ENV, HOLD_MS, holdOn, ScriptedTimers } from './helpers/residency-hold.ts';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
/** The gaps between messages the staging proof sends, all inside the window. */
const GAPS = [15_000, 45_000, 3 * MINUTE, 8 * MINUTE];
const PERSON = {};
const AGENT_ASK = { agentAsk: { exchangeId: 'exchange_1' } };
const SETUP_WAKE = { setupWake: { setupOperationId: 'op_1', notice: 'Connected.' } };
/** Envs that set no hold window: unset, empty, 0, and values the deploy refuses. */
const NO_HOLD_ENVS: Array<Record<string, unknown>> = [
  {}, ...['', '0', '900001', '10m', '-1'].map((value) => ({ [RESIDENCY_HOLD_VARIABLE]: value })),
];

// Defects caught: a hold on by default, or on at 0; a window past the
// 15 minutes one timer holds; a malformed value read as some other number;
// and an object that fails, rather than holds nothing, on a value the deploy
// would refuse.
test('the hold window is a whole number of milliseconds up to 15 minutes; unset, empty or 0 is none', () => {
  assert.equal(MAX_RESIDENCY_HOLD_MS, 15 * MINUTE);
  for (const [value, window] of [
    [undefined, undefined], ['', undefined], ['0', undefined], [0, undefined],
    ['1', 1], ['600000', 600_000], ['900000', 900_000], [600_000, 600_000],
  ] as const) {
    assert.equal(parseResidencyHoldMs(value), window, JSON.stringify(value));
    assert.equal(residencyHoldMs({ [RESIDENCY_HOLD_VARIABLE]: value }), window, `env ${JSON.stringify(value)}`);
  }
  assert.equal(residencyHoldMs(undefined), undefined);
  for (const value of ['900001', '10m', '-1', '6e5', '1.5', ' 600000', '600000 ', true, 900_001, 1.5]) {
    assert.throws(
      () => parseResidencyHoldMs(value),
      /CHICKPEA_RESIDENCY_HOLD_MS must be a whole number of milliseconds up to 900000, or 0 or unset for no hold\./,
      JSON.stringify(value),
    );
    assert.equal(residencyHoldMs({ [RESIDENCY_HOLD_VARIABLE]: value }), undefined, `an object holds nothing for ${JSON.stringify(value)}`);
  }
});

// Defects caught: a hold that a nearer deadline shortens, one a past deadline
// sets, two timers where one moved, a fired hold that cannot hold again, and
// a hold without a window.
test('a hold is one pending timer, the window after its latest start, and gone once it fires', () => {
  let clock = NOW;
  const timers = new ScriptedTimers(() => clock);
  const hold = new ResidencyHold(5 * MINUTE, timers);
  assert.equal(hold.active, true);
  hold.holdFrom(NOW - 5 * MINUTE - 1);
  assert.deepEqual(timers.pending(), [], 'a window already past holds nothing');
  hold.holdFrom(NOW);
  hold.holdFrom(NOW - 3 * MINUTE);
  assert.deepEqual(timers.pending(), [NOW + 5 * MINUTE], 'an earlier start never shortens it');
  hold.holdFrom(NOW + 2 * MINUTE);
  assert.deepEqual(timers.pending(), [NOW + 7 * MINUTE], 'a later start replaces the timer');
  clock = NOW + 7 * MINUTE;
  timers.fireDue();
  assert.deepEqual(timers.pending(), []);
  hold.holdFrom(clock - 4 * MINUTE);
  assert.deepEqual(timers.pending(), [NOW + 8 * MINUTE], 'it holds again after it fired');

  const none = new ResidencyHold(undefined, timers);
  assert.equal(none.active, false);
  none.holdFrom(clock);
  assert.deepEqual(timers.pending(), [NOW + 8 * MINUTE], 'no window, no timer');
});

// The runner, transpiled whole over a fake object. Its alarm's turn loop is a
// stand-in that ends the given turns, as the real loop does after each turn's
// attempt; the rest of what the alarm builds is inert here.
const runnerSource = ts.createSourceFile(
  'thread-runner.ts',
  readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const runnerClass = runnerSource.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'SlackThreadRunner');
assert.ok(runnerClass);
const runnerCode = ts.transpileModule(
  `${runnerClass.getText(runnerSource).replace(/^export /, '')}\nSlackThreadRunner`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

/** A thread's runner on a deployment with `env`, on the test's clock and timers. */
function threadRunner(env: Record<string, unknown> = HOLD_ENV) {
  const clock = { now: NOW };
  const timers = new ScriptedTimers(() => clock.now);
  let turns: object[] = [];
  let ended = 0;
  const Runner = vm.runInNewContext(runnerCode, {
    Date: { now: () => clock.now },
    console,
    DurableObject: class {
      constructor(readonly ctx: unknown, readonly env: unknown) {}
    },
    RunnerBootMarks: class extends RunnerBootMarks {
      constructor() {
        super(() => clock.now, { info() {} });
      }
    },
    ResidencyHold: holdOn(timers),
    residencyHoldMs,
    objectInstallationEnv,
    ThreadRunnerJobStore,
    DoSqlStateDb,
    SlackStatusRegistry,
    createRunnerSupersedeState,
    runnerLoopScheduler,
    cloudflareWorkerVersionId: () => undefined,
    CfTurnJobsForRunner: class {},
    SlackRunPresentationStoreLogic: class {},
    runnerPresentationState: () => ({ state: {}, publish: async () => undefined }),
    deploymentTenancy: () => 'standalone',
    withAgentAppExecution: (resolve: unknown) => resolve,
    cacheSlackInstallationExecutionContexts: (resolve: unknown) => resolve,
    RunnerStops: class {},
    runnerTurnJobsPort: () => ({}),
    runnerSlackPort: () => ({}),
    createPlatformProductTelemetry: () => ({}),
    getSettingsStore: () => ({}),
    getConfigStore: () => ({}),
    sandboxTurnReaders: () => () => [],
    runTurn: () => undefined,
    startEarlyJudgment: () => undefined,
    runThreadRunnerAlarm: async (deps: { afterJob(job: object): Promise<void> }) => {
      for (const [index, turn] of turns.entries()) {
        await deps.afterJob({ id: `turn_${index}`, runId: `run_${index}`, turn });
        ended += 1;
      }
      return { record: { yielded: false, carried: 0 } };
    },
  }) as new (ctx: unknown, env: unknown) => { alarm(): Promise<void> };
  const runner = new Runner(new FakeObjectRestoreContext(new FakeObjectStorage(), { name: 'T1:C1:5000.000100' }), env);
  return {
    /** The runner's alarm runs these turns to their end. */
    async runTurns(...ending: object[]) {
      turns = ending;
      ended = 0;
      await runner.alarm();
      assert.equal(ended, ending.length, 'the alarm ended every turn');
    },
    heldUntil: () => timers.pending(),
    advance(ms: number) {
      clock.now += ms;
      timers.fireDue();
    },
  };
}

// Defects caught: a runner that leaves memory between a turn and the
// thread's follow-up, a hold that outlives the configured window, a later
// turn that keeps the first deadline, a hold after the host's own turns, and
// a hold on a deployment that sets no window.
test("a thread's runner stays in memory for the configured window after a person's turn ends there", async () => {
  const runner = threadRunner();
  await runner.runTurns(PERSON);
  let elapsed = 0;
  for (const gap of GAPS) {
    runner.advance(gap - elapsed);
    elapsed = gap;
    assert.deepEqual(runner.heldUntil(), [NOW + HOLD_MS], `held ${gap / 1_000} s after the turn`);
  }
  await runner.runTurns(PERSON);
  const renewed = NOW + elapsed + HOLD_MS;
  assert.deepEqual(runner.heldUntil(), [renewed], 'the next turn renews it');
  runner.advance(HOLD_MS);
  assert.deepEqual(runner.heldUntil(), [], 'let go when the window ends');

  const host = threadRunner();
  await host.runTurns(AGENT_ASK, SETUP_WAKE);
  assert.deepEqual(host.heldUntil(), [], "an Agent's ask or a setup wake holds nothing");

  for (const env of NO_HOLD_ENVS) {
    const unset = threadRunner(env);
    await unset.runTurns(PERSON);
    assert.deepEqual(unset.heldUntil(), [], `no hold with ${JSON.stringify(env)}`);
  }
});

interface AgentObject {
  chickpeaWake(sentAt?: number, turnJobId?: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

/**
 * A Slack thread Agent object on a deployment with `env`, over a base that
 * answers every request, on the test's clock and timers.
 */
function agentObject(t: TestContext, env: Record<string, unknown> = HOLD_ENV) {
  let clock = NOW;
  const timers = new ScriptedTimers(() => clock);
  t.mock.method(console, 'info', () => undefined);
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => timers.set(callback, ms));
  t.mock.method(globalThis, 'clearTimeout', (timer: unknown) => timers.clear(timer));
  class Base {
    constructor(readonly ctx: unknown, readonly env: unknown) {}

    async fetch() {
      return new Response('ok');
    }
  }
  const Extended = slackThreadCloudflareExtension.base(Base as never) as unknown as new (
    ctx: { id: { name?: string } },
    env: unknown,
  ) => AgentObject;
  return {
    agent: new Extended({ id: { name: 'agent_thread' } }, env),
    heldUntil: () => timers.pending(),
    advance(ms: number) {
      clock += ms;
      timers.fireDue();
    },
  };
}

// Defects caught: an Agent object that leaves memory between a turn and the
// thread's follow-up, a hold counted from the turn's first request rather
// than its last, one that outlives the configured window, a hold from a wake
// alone, and a hold on a deployment that sets no window.
test("a thread's Agent object stays in memory for the configured window after its turn's last request", async (t) => {
  const { agent, heldUntil, advance } = agentObject(t);
  await agent.chickpeaWake(NOW);
  assert.deepEqual(heldUntil(), [], 'a wake alone holds nothing');
  assert.equal((await agent.fetch(new Request('https://agent.invalid/dispatch', { method: 'POST' }))).ok, true);
  advance(20_000);
  await agent.fetch(new Request('https://agent.invalid/read'));
  const lastRequest = NOW + 20_000;
  assert.deepEqual(heldUntil(), [lastRequest + HOLD_MS], 'one timer, from the last read of the reply');
  let elapsed = 0;
  for (const gap of GAPS) {
    advance(gap - elapsed);
    elapsed = gap;
    assert.deepEqual(heldUntil(), [lastRequest + HOLD_MS], `held ${gap / 1_000} s after the turn`);
  }
  advance(HOLD_MS - elapsed);
  assert.deepEqual(heldUntil(), [], 'let go when the window ends');
});

test("a thread's Agent object holds nothing on a deployment that sets no window", async (t) => {
  for (const env of NO_HOLD_ENVS) {
    await t.test(JSON.stringify(env), async (sub) => {
      const { agent, heldUntil } = agentObject(sub, env);
      assert.equal((await agent.fetch(new Request('https://agent.invalid/dispatch', { method: 'POST' }))).ok, true);
      assert.deepEqual(heldUntil(), []);
    });
  }
});
