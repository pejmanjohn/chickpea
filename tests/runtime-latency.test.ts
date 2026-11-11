import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import type { FlueObservation } from '@flue/runtime';
import type { WebClient } from '@slack/web-api';
import ts from 'typescript';

import type { ResolvedAssignment } from '../src/config/types.ts';
import type { AnswerReleaseShadowRecord } from '../src/slack/answer-release.ts';
import {
  emitGatewayDelivery,
  emitInteractionJudgment,
  emitRelayAlarm,
  emitThreadRunnerAlarm,
  emitRuntimeLatency,
  modelToken,
  ModelStepMarks,
  opaqueRunRef,
  opaqueTurnRef,
  recordStateRpc,
  AgentBootMarks,
  resetRunnerActivationsForTest,
  resetStateRpcCountersForTest,
  RunnerBootMarks,
  startRelayAlarmMetrics,
  STATE_RPC_SAMPLE_EVERY,
  STATE_RPC_SLOW_MS,
  StateRpcSummary,
  StoreBootMarks,
  timedStateRpc,
  TurnLatencyTracker,
} from '../src/observability/runtime-latency.ts';
import type { SlackStateStore } from '../src/slack/claim-store.ts';
import { stopNodeTurnRelay, wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import {
  AgentObservationYield,
  AgentPromptFailure,
  AgentReplyReadInterrupted,
  StateStoreUnavailable,
} from '../src/slack/flue-dispatch.ts';
import {
  attemptEndReason,
  runTurn,
  WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT,
  type RunTurnOptions,
} from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { GatewayInboxStoreLogic } from '../src/slack/gateway/inbox.ts';
import {
  HttpDeliveryError,
  httpDeliveryReceipt,
  parseHttpDeliveryState,
} from '../src/slack/gateway/http-delivery.ts';
import { gatewayUiReceiptNow } from '../src/slack/gateway/ui-receipt.ts';
import type { GatewayEventDelivery, GatewayInboundDelivery } from '../src/slack/gateway/protocol.ts';
import { GatewayInboundAdmission } from '../src/slack/gateway/inbound-admission.ts';
import {
  GatewaySessionRunnerSupervisor,
  type GatewaySessionRunnerHealthSnapshot,
} from '../src/slack/gateway/session-runner.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { WorkStore } from '../src/work/types.ts';
import { deploymentTenancy } from '../src/config/installation-scope.ts';

// Keep the ambient config store the Node relay opens off any on-disk database.
process.env.SLACK_STATE_DB_PATH = ':memory:';

type LogRecord = Record<string, unknown>;

function captureSink() {
  const records: LogRecord[] = [];
  return { records, sink: { info: (record: LogRecord) => records.push(record) } };
}

function clock(start: number) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const USER_CONTENT = [
  'Complete the verification.',
  'U_LATENCY',
  'C_LATENCY',
  'T_LATENCY',
  '1785509000.000100',
  'slack.botToken',
];

function assertContentFree(record: LogRecord): void {
  const serialized = JSON.stringify(record);
  for (const value of USER_CONTENT) {
    assert.equal(serialized.includes(value), false, `log must not contain ${value}`);
  }
}

test('runtime latency records keep only numbers, booleans, tokens, and opaque refs', () => {
  const { records, sink } = captureSink();
  emitRuntimeLatency('turn_latency', {
    runRef: opaqueRunRef('run_raw_identifier'),
    turnRef: 'evt:T_LATENCY:C_LATENCY:1785509000.000100',
    outcome: 'returned',
    lane: 'Complete the verification.',
    method: 'settingGet',
    op: 'slack.botToken',
    attempt: 2,
    negative: -5,
    fractional: 12.6,
    notFinite: Number.NaN,
    missing: undefined,
    slow: true,
    unknownString: 'U_LATENCY',
  }, sink);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.deepEqual(record, {
    component: 'runtime',
    event: 'turn_latency',
    runRef: opaqueRunRef('run_raw_identifier'),
    outcome: 'returned',
    method: 'settingGet',
    attempt: 2,
    negative: 0,
    fractional: 13,
    slow: true,
  });
  assert.match(String(record?.runRef), /^run_[0-9a-f]{24}$/);
  assertContentFree(record!);
});

// Defects caught: a model id logged as written (slashes, dots, capitals),
// one longer than the token shape that is dropped instead of cut, a missing
// id that leaves no token to group by, and a token field that admits capitals.
test('modelToken turns a model id into a lowercase token, and the log keeps only that shape', () => {
  assert.equal(modelToken('anthropic/claude-opus-5.5'), 'anthropic_claude_opus_5_5');
  assert.equal(modelToken('openrouter/Google/Gemini-3.0-Pro:free'), 'openrouter_google_gemini_3_0_pro_free');
  assert.equal(modelToken(undefined), 'unknown');
  assert.equal(modelToken(''), 'unknown');
  assert.equal(modelToken('/claude-opus-5.5'), 'unknown', 'a token starts with a letter');
  const long = modelToken(`openrouter/${'synthetic-model-'.repeat(8)}`);
  assert.equal(long.length, 64);
  assert.ok(long.startsWith('openrouter_synthetic_model_'));
  const { records, sink } = captureSink();
  emitRuntimeLatency('turn_latency', { modelToken: long }, sink);
  emitRuntimeLatency('turn_latency', { modelToken: 'Anthropic_Claude' }, sink);
  assert.equal(records[0]?.modelToken, long);
  assert.equal('modelToken' in records[1]!, false, 'only modelToken output passes');
});

// Defect caught: a free-text or probability field reaches Workers Logs as
// written, or the fields production monitoring reads are dropped.
test('interaction_judgment keeps its tokens, scales probabilities to thousandths, and drops free text', () => {
  const { records, sink } = captureSink();
  emitInteractionJudgment({
    turnJobId: 'turn_judgment_raw_identifier',
    recordedBy: 'clef',
    basis: 'reply',
    basisMs: 312.4,
    clef: 'read',
    clefMs: 260,
    clefInputTokens: 878,
    clefChoice: 'reply',
    clefTop: 0.81,
    clefTextMass: 0.91,
    clefMemory: 0.02,
    gate: 'dispatch',
    model: 'react_only',
    modelFailed: false,
    modelMs: 2410,
    refinement: 'disagreed',
    agreed: false,
    management: 'read',
    managementMs: 240.6,
    managementInputTokens: 414,
    managementTop: 0.973,
    managementFired: true,
  }, sink);
  emitInteractionJudgment({
    recordedBy: 'Complete the verification.',
    clef: 'unavailable',
    gate: 'await_model',
    model: 'slack.botToken',
    clefLate: true,
    management: 'Create an Agent named Scout.',
    managementFired: false,
  }, sink);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    component: 'runtime',
    event: 'interaction_judgment',
    turnRef: opaqueTurnRef('turn_judgment_raw_identifier'),
    recordedBy: 'clef',
    basis: 'reply',
    basisMs: 312,
    clef: 'read',
    clefMs: 260,
    clefInputTokens: 878,
    clefChoice: 'reply',
    clefTop: 810,
    clefTextMass: 910,
    clefMemory: 20,
    gate: 'dispatch',
    model: 'react_only',
    modelFailed: false,
    modelMs: 2410,
    refinement: 'disagreed',
    agreed: false,
    management: 'read',
    managementMs: 241,
    managementInputTokens: 414,
    managementTop: 973,
    managementFired: true,
  });
  assert.deepEqual(records[1], {
    component: 'runtime',
    event: 'interaction_judgment',
    clef: 'unavailable',
    gate: 'await_model',
    clefLate: true,
    managementFired: false,
  });
  for (const record of records) assertContentFree(record!);
});

test('runtime latency emission never throws when the sink fails', () => {
  assert.doesNotThrow(() => emitRuntimeLatency('relay_alarm', { durationMs: 1 }, {
    info() {
      throw new Error('log pipe closed');
    },
  }));
});

test('opaque refs match the presentation finalization record and hide raw ids', () => {
  assert.equal(opaqueRunRef(undefined), undefined);
  assert.equal(opaqueTurnRef(undefined), undefined);
  const turnRef = opaqueTurnRef('evt:T_LATENCY:1785509000.000100');
  assert.match(String(turnRef), /^turn_[0-9a-f]{24}$/);
  assert.equal(String(turnRef).includes('1785509000'), false);
});

test('relay_alarm reports the documented fields for one invocation', () => {
  const time = clock(1_000);
  const metrics = startRelayAlarmMetrics(time.now);
  metrics.outcome = 'drained';
  metrics.jobsListed = 5;
  metrics.groups = 3;
  metrics.jobsRun = 4;
  metrics.jobsSettled = 3;
  metrics.jobsRetained = 1;
  metrics.jobsCarried = 1;
  metrics.longestJobMs = 700;
  metrics.turnsMs = 900;
  metrics.needsRetry = true;
  metrics.rearmed = true;
  metrics.jobsDispatched = 2;
  time.advance(1_250);
  const { records, sink } = captureSink();
  emitRelayAlarm(metrics, time.now, sink);
  assert.deepEqual(records, [{
    component: 'runtime',
    event: 'relay_alarm',
    outcome: 'drained',
    durationMs: 1_250,
    jobsListed: 5,
    groups: 3,
    jobsRun: 4,
    jobsSettled: 3,
    jobsRetained: 1,
    jobsCarried: 1,
    longestJobMs: 700,
    turnsMs: 900,
    needsRetry: true,
    rearmed: true,
    yielded: false,
    jobsDispatched: 2,
    keepWarm: false,
  }]);
});

test('thread_runner_alarm reports one runner alarm with fixed fields only', () => {
  const { records, sink } = captureSink();
  emitThreadRunnerAlarm({
    jobs: 2, ran: 1, yielded: true, carried: 0, durationMs: 600_010.4, outcome: 'drained',
  }, sink);
  assert.deepEqual(records, [{
    component: 'runtime',
    event: 'thread_runner_alarm',
    jobs: 2,
    ran: 1,
    yielded: true,
    carried: 0,
    durationMs: 600_010,
    outcome: 'drained',
  }]);
});

test('runner_boot logs an activation once, at its first call, and only the first in an isolate is cold', () => {
  resetRunnerActivationsForTest();
  const time = clock(50_000);
  const { records, sink } = captureSink();
  const first = new RunnerBootMarks(time.now, sink);
  time.advance(30);
  first.constructed();
  time.advance(5);
  first.call('admit', { sentAt: 48_100, turnJobId: 'evt:T_LATENCY:1785509000.000100' });
  time.advance(100);
  first.call('alarm');
  first.call('admit', { sentAt: 50_100, turnJobId: 'evt:T_LATENCY:1785509000.000100' });
  assert.deepEqual(records, [{
    component: 'runtime',
    event: 'runner_boot',
    firstMethod: 'admit',
    cold: true,
    turnRef: opaqueTurnRef('evt:T_LATENCY:1785509000.000100'),
    sentToConstructMs: 1_900,
    constructMs: 30,
    constructToFirstCallMs: 5,
  }], 'later calls on the same activation log nothing');
  assertContentFree(records[0]!);

  // Another runner in the same isolate, woken by its alarm: no caller clock.
  const next = new RunnerBootMarks(time.now, sink);
  next.constructed();
  next.call('alarm');
  assert.deepEqual(records[1], {
    component: 'runtime',
    event: 'runner_boot',
    firstMethod: 'alarm',
    cold: false,
    constructMs: 0,
    constructToFirstCallMs: 0,
  });
  assert.equal(records.length, 2);
});

test('agent_boot logs an agent activation once, names its class, and counts cold apart from runners', () => {
  resetRunnerActivationsForTest();
  const time = clock(70_000);
  const { records, sink } = captureSink();
  new RunnerBootMarks(time.now, sink).call('alarm');
  const agent = new AgentBootMarks('ChickpeaSlackV2', time.now, sink);
  agent.constructed();
  time.advance(40);
  agent.call('stage', { sentAt: 68_800, turnJobId: 'evt:T_LATENCY:1785509000.000100' });
  agent.call('fetch');
  const routine = new AgentBootMarks('ChickpeaRoutineExecutionV2', time.now, sink);
  routine.call('alarm');
  assert.deepEqual(records.slice(1), [{
    component: 'runtime',
    event: 'agent_boot',
    agentClass: 'ChickpeaSlackV2',
    firstMethod: 'stage',
    cold: true,
    turnRef: opaqueTurnRef('evt:T_LATENCY:1785509000.000100'),
    sentToConstructMs: 1_200,
    constructMs: 0,
    constructToFirstCallMs: 40,
  }, {
    component: 'runtime',
    event: 'agent_boot',
    agentClass: 'ChickpeaRoutineExecutionV2',
    firstMethod: 'alarm',
    cold: false,
    constructMs: 0,
    constructToFirstCallMs: 0,
  }], 'the runner before it does not make the first agent warm, and a later call logs nothing');
  assertContentFree(records[1]!);
});

// Execute the production alarm entry point, not a copy: it must emit one
// record whether the drain returns or throws, and never swallow the throw.
const cloudflareSource = ts.createSourceFile(
  'cloudflare.ts',
  readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const stateClass = cloudflareSource.statements.find((node) =>
  ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
assert.ok(stateClass && ts.isClassDeclaration(stateClass));
const alarmMethod = stateClass.members.find((member) =>
  ts.isMethodDeclaration(member) && member.name.getText(cloudflareSource) === 'alarm');
assert.ok(alarmMethod, 'production alarm() exists');
const AlarmProbe = vm.runInNewContext(
  ts.transpileModule(
    `class AlarmProbe { boot = { call() {} }; ${alarmMethod.getText(cloudflareSource)} }\nAlarmProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  {
    startRelayAlarmMetrics,
    emitRelayAlarm: (metrics: Parameters<typeof emitRelayAlarm>[0]) =>
      alarmSink.records.push({ ...metrics }),
  },
) as new () => {
  alarm(): Promise<void>;
  drainRelayAlarm(metrics: ReturnType<typeof startRelayAlarmMetrics>): Promise<void>;
};
const alarmSink = { records: [] as LogRecord[] };

test('alarm() emits one relay_alarm record when the drain returns', async () => {
  alarmSink.records.length = 0;
  const probe = new AlarmProbe();
  probe.drainRelayAlarm = async (metrics) => {
    metrics.outcome = 'drained';
    metrics.jobsListed = 2;
  };
  await probe.alarm();
  assert.equal(alarmSink.records.length, 1);
  assert.equal(alarmSink.records[0]?.outcome, 'drained');
  assert.equal(alarmSink.records[0]?.jobsListed, 2);
});

test('alarm() emits a threw record and still rethrows a store failure', async () => {
  alarmSink.records.length = 0;
  const probe = new AlarmProbe();
  probe.drainRelayAlarm = async () => {
    throw new Error('state store unavailable in alarm: test');
  };
  await assert.rejects(probe.alarm(), /state store unavailable/);
  assert.equal(alarmSink.records.length, 1);
  assert.equal(alarmSink.records[0]?.outcome, 'threw');
});

// The production hand-off, not a copy: it sends its clock with the job.
const admitToRunnerMethod = stateClass.members.find((member) =>
  ts.isMethodDeclaration(member) && member.name.getText(cloudflareSource) === 'admitToRunner');
assert.ok(admitToRunnerMethod, 'production admitToRunner() exists');

function handoffProbe(answer: Record<string, unknown>) {
  const sent: LogRecord[] = [];
  const confirmed: unknown[][] = [];
  const runner = {
    admit: async (job: LogRecord) => {
      sent.push({ ...job });
      return answer;
    },
  };
  const HandoffProbe = vm.runInNewContext(
    ts.transpileModule(
      `class HandoffProbe { ${admitToRunnerMethod!.getText(cloudflareSource)} }\nHandoffProbe`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      Date: { now: () => 70_000 },
      console: { warn: () => undefined },
      slackAgentThreadKey: () => 'T1:C1:1.0',
      threadRunnerStub: () => runner,
      installationOwnershipOf: () => undefined,
      effectiveTurnSlackInstallationId: () => 'workspace',
      carriedGatewayIdentity: () => undefined,
    },
  ) as new () => {
    stores: unknown;
    env: unknown;
    wakeAgentAtHandoff: () => undefined;
    admitToRunner(job: unknown): Promise<boolean>;
  };
  const probe = new HandoffProbe();
  probe.env = {};
  // The Agent wake beside the hand-off is agent-wake-admission.test.ts's.
  probe.wakeAgentAtHandoff = () => undefined;
  probe.stores = {
    presentations: { get: () => undefined },
    config: { getWorkspaceInstallation: () => undefined },
    turnJobs: {
      confirmRunner: (...args: unknown[]) => confirmed.push(args),
    },
  };
  return { admit: () => probe.admitToRunner({ id: 'turn_1', turn: {}, assignment: {} }), sent, confirmed };
}

test("a runner hand-off sends the state store's clock with the job", async () => {
  const admitted = handoffProbe({ admitted: true });
  assert.equal(await admitted.admit(), true);
  assert.equal(admitted.sent[0]?.sentAt, 70_000);
  assert.deepEqual(admitted.confirmed, [['turn_1']]);

  const refused = handoffProbe({ admitted: false, refused: 'installation_mismatch' });
  assert.equal(await refused.admit(), false);
  assert.deepEqual(refused.confirmed, [], 'a refused hand-off is retried, never confirmed');
});

test('turn_latency measures admission to the first acknowledged write and to final', () => {
  const time = clock(10_000);
  const { records, sink } = captureSink();
  const tracker = new TurnLatencyTracker(
    { admittedAt: 9_000, lane: 'cloudflare', executor: 'alarm' },
    { turnJobId: 'evt:T_LATENCY:1785509000.000100', runId: 'run-raw', attempt: 1, model: 'anthropic/claude-opus-5.5' },
    time.now,
    sink,
  );
  time.advance(500);
  tracker.markSlackWrite('agent_session');
  time.advance(500);
  tracker.markSlackWrite('activity_status');
  time.advance(4_000);
  tracker.markFinal('delivered');
  time.advance(100);
  tracker.emit('returned');
  tracker.emit('threw');
  assert.deepEqual(records, [{
    component: 'runtime',
    event: 'turn_latency',
    turnRef: opaqueTurnRef('evt:T_LATENCY:1785509000.000100'),
    runRef: opaqueRunRef('run-raw'),
    lane: 'cloudflare',
    executor: 'alarm',
    attempt: 1,
    modelToken: 'anthropic_claude_opus_5_5',
    outcome: 'returned',
    firstWrite: 'agent_session',
    final: 'delivered',
    admissionToStartMs: 1_000,
    admissionToFirstWriteMs: 1_500,
    admissionToFinalMs: 6_000,
    firstAnswerText: 'final',
    admissionToFirstAnswerTextMs: 6_000,
    admissionToShadowAnswerTextMs: 6_000,
    attemptMs: 5_100,
  }]);
  assertContentFree(records[0]!);
});

function shadowRecord(overrides: Partial<AnswerReleaseShadowRecord> = {}): AnswerReleaseShadowRecord {
  return {
    outcome: 'below_hold',
    holdChars: 400,
    toolSteps: 0,
    answerSteps: 1,
    preToolText1: 0,
    preToolText100: 0,
    preToolText200: 0,
    preToolText300: 0,
    preToolText400: 0,
    preToolText600: 0,
    preToolText800: 0,
    finalAnswerChars: 120,
    displayParts: 0,
    keySetupParts: 0,
    ...overrides,
  };
}

// Defects caught: a status or task card counted as answer text, a stream
// start not counted, the shadow time taken from a retired release (whose
// answer still waits for the terminal), an epoch timestamp logged as is, a
// shadow that cannot be read per model, or a task-card stream it does not name.
test('turn_latency times the first answer text as shown and as a host release would have shown it', () => {
  const { records, sink } = captureSink();
  const run = (
    streamAt: number | undefined,
    answerRelease: AnswerReleaseShadowRecord | undefined,
    taskCard = false,
  ) => {
    const time = clock(10_000);
    const tracker = new TurnLatencyTracker(
      { receivedAt: 8_000, admittedAt: 9_000, lane: 'cloudflare', executor: 'runner' },
      { turnJobId: 'evt:T_LATENCY:1785509000.000100', runId: 'run-raw', attempt: 1, model: 'anthropic/claude-sonnet-5.5' },
      time.now,
      sink,
    );
    time.advance(500);
    tracker.markSlackWrite('activity_status');
    if (taskCard) tracker.markTaskCardStreamed();
    if (streamAt !== undefined) {
      time.advance(streamAt - time.now());
      tracker.markStreamedAnswerText();
    }
    time.advance(30_000 - time.now());
    tracker.markFinal('delivered');
    tracker.emit('returned', answerRelease);
    return records.filter((record) => record.event === 'turn_latency').at(-1)!;
  };

  const terminal = run(undefined, undefined);
  assert.equal(terminal.firstWrite, 'activity_status');
  assert.equal(terminal.firstAnswerText, 'final');
  assert.equal(terminal.receiptToFirstAnswerTextMs, 22_000);
  assert.equal(terminal.admissionToFirstAnswerTextMs, 21_000);
  assert.equal(terminal.receiptToShadowAnswerTextMs, 22_000, 'no release: the shadow shows the answer when the terminal did');
  assert.equal(records.some((record) => record.event === 'answer_release'), false, 'no shadow, no answer_release');

  const streamed = run(18_000, undefined);
  assert.equal(streamed.firstAnswerText, 'stream');
  assert.equal(streamed.receiptToFirstAnswerTextMs, 10_000);

  const released = run(undefined, shadowRecord({
    outcome: 'released', releasedAt: 21_000, releaseChars: 412, releaseHoldMs: 900, finalAnswerChars: 1_300,
  }));
  assert.equal(released.receiptToFirstAnswerTextMs, 22_000);
  assert.equal(released.receiptToShadowAnswerTextMs, 13_000);
  assert.equal(released.admissionToShadowAnswerTextMs, 12_000);

  const earlierStream = run(15_000, shadowRecord({ outcome: 'released', releasedAt: 21_000 }));
  assert.equal(earlierStream.receiptToShadowAnswerTextMs, 7_000, 'never later than what Slack showed');

  const retired = run(undefined, shadowRecord({
    outcome: 'retired', late: 'tool', releasedAt: 12_000, releaseChars: 430, releaseHoldMs: 600, releaseToLateMs: 1_200,
    toolSteps: 1, preToolText1: 1, preToolText100: 1, preToolText200: 1, preToolText300: 1, preToolText400: 1,
  }), true);
  assert.equal(retired.receiptToShadowAnswerTextMs, 22_000, 'a retired release leaves the answer to the terminal');
  assert.equal(retired.modelToken, 'anthropic_claude_sonnet_5_5');
  assert.equal('taskCardStream' in retired, false, 'the task card is on answer_release only');

  const shadowLogs = records.filter((record) => record.event === 'answer_release');
  assert.equal(shadowLogs.length, 3);
  assert.equal(shadowLogs[0]?.taskCardStream, false, 'a reply whose stream carried no task card');
  assert.deepEqual(shadowLogs.at(-1), {
    component: 'runtime',
    event: 'answer_release',
    turnRef: opaqueTurnRef('evt:T_LATENCY:1785509000.000100'),
    runRef: opaqueRunRef('run-raw'),
    attempt: 1,
    modelToken: 'anthropic_claude_sonnet_5_5',
    outcome: 'retired',
    late: 'tool',
    holdChars: 400,
    releaseChars: 430,
    releaseHoldMs: 600,
    releaseToLateMs: 1_200,
    toolSteps: 1,
    answerSteps: 1,
    preToolText1: 1,
    preToolText100: 1,
    preToolText200: 1,
    preToolText300: 1,
    preToolText400: 1,
    preToolText600: 0,
    preToolText800: 0,
    finalAnswerChars: 120,
    displayParts: 0,
    keySetupParts: 0,
    taskCardStream: true,
    admissionToReleaseMs: 3_000,
    receiptToReleaseMs: 4_000,
  });
  records.forEach(assertContentFree);
});

// Defect caught: a record that drops the receipt wake's lead its runner measured.
test("turn_latency logs a runner turn's hand-off delay and wake lead from its context", () => {
  const { records, sink } = captureSink();
  new TurnLatencyTracker(
    { admittedAt: 9_000, handoffMs: 1_900, runnerWakeLeadMs: 640, lane: 'cloudflare', executor: 'runner' },
    { turnJobId: 'evt:T_LATENCY:1785509000.000100', attempt: 1 },
    clock(10_000).now,
    sink,
  ).emit('returned');
  assert.equal(records[0]?.handoffMs, 1_900);
  assert.equal(records[0]?.runnerWakeLeadMs, 640);
  new TurnLatencyTracker(
    { admittedAt: 9_000, handoffMs: 1_900, lane: 'cloudflare', executor: 'runner' }, {}, clock(10_000).now, sink,
  ).emit('returned');
  assert.equal('runnerWakeLeadMs' in records[1]!, false, 'a turn whose runner no wake reached omits the field');
  records.forEach(assertContentFree);
});

// Defects caught: a retried attempt with no reason for the one before it, a
// reason on an attempt that returned, and a stalled read the record misses.
test('turn_latency names why a thrown attempt ended, and counts reads a fresh one joined', () => {
  const { records, sink } = captureSink();
  const interrupted = new TurnLatencyTracker(
    { admittedAt: 9_000, lane: 'cloudflare', executor: 'runner' }, { attempt: 1 }, clock(10_000).now, sink,
  );
  interrupted.emit('threw', undefined, 'reply_read_interrupted');
  const resumed = new TurnLatencyTracker(
    { admittedAt: 9_000, lane: 'cloudflare', executor: 'runner' }, { attempt: 2 }, clock(10_000).now, sink,
  );
  resumed.markStalledRead();
  resumed.markStalledRead();
  resumed.markFinal('delivered');
  resumed.emit('returned');
  assert.deepEqual(records.map(({ attempt, outcome, reason, stalledReads }) => ({ attempt, outcome, reason, stalledReads })), [
    { attempt: 1, outcome: 'threw', reason: 'reply_read_interrupted', stalledReads: undefined },
    { attempt: 2, outcome: 'returned', reason: undefined, stalledReads: 2 },
  ]);
  records.forEach(assertContentFree);
});

// Defect caught: a failure class logged under another class's reason, so
// retries are counted under the wrong cause.
test('a thrown attempt\'s reason names its failure class', () => {
  assert.deepEqual([
    new AgentObservationYield(),
    new StateStoreUnavailable(),
    new AgentReplyReadInterrupted(new TypeError('Network connection lost')),
    new AgentPromptFailure('agent', 409, true),
    new AgentPromptFailure('agent', 503, false, true),
    new Error('slack unavailable'),
  ].map(attemptEndReason), [
    'observation_yield', 'state_store_unavailable', 'reply_read_interrupted',
    'recovery_required', 'agent_failure', 'other',
  ]);
});

// Defects caught: a first write that ignores the status the state store
// showed before the hand-off (receiptToFirstWriteMs would then count to the
// runner's later write), one a later write replaces, a wait that is not
// logged, and fields on a turn whose hand-off tried no status.
test('turn_latency counts the first write from the status the state store showed before the hand-off', () => {
  const { records, sink } = captureSink();
  const time = clock(10_000);
  const tracker = new TurnLatencyTracker({
    receivedAt: 8_000, admittedAt: 8_300, handoffMs: 40, admissionStatusMs: 310, admissionStatusAt: 8_610,
    lane: 'cloudflare', executor: 'runner',
  }, { turnJobId: 'msg:C1:1785509000.000100', attempt: 1 }, time.now, sink);
  time.advance(700);
  tracker.markSlackWrite('activity_status');
  tracker.emit('returned');
  assert.equal(records[0]?.firstWrite, 'admission_status');
  assert.equal(records[0]?.receiptToFirstWriteMs, 610);
  assert.equal(records[0]?.admissionToFirstWriteMs, 310);
  assert.equal(records[0]?.admissionStatusMs, 310);
  // The cap or a failure: the wait is logged, and the runner's write is the first.
  const missed = new TurnLatencyTracker({
    receivedAt: 8_000, admittedAt: 8_300, admissionStatusMs: 600, lane: 'cloudflare', executor: 'runner',
  }, {}, clock(10_000).now, sink);
  missed.markSlackWrite('agent_session');
  missed.emit('returned');
  assert.equal(records[1]?.firstWrite, 'agent_session');
  assert.equal(records[1]?.receiptToFirstWriteMs, 2_000);
  assert.equal(records[1]?.admissionStatusMs, 600);
  new TurnLatencyTracker({ admittedAt: 9_000, lane: 'cloudflare', executor: 'runner' }, {}, clock(10_000).now, sink)
    .emit('returned');
  assert.equal('admissionStatusMs' in records[2]!, false, 'a hand-off that tried no status omits the field');
  records.forEach(assertContentFree);
});

// Defects caught: a start-to-stage time that includes the staging itself, one
// a later staging (a retry's) overwrites, and a field present on a turn that
// staged nothing.
test('turn_latency logs how long staging the turn input took and how soon it began, from its first staging', () => {
  const { records, sink } = captureSink();
  const time = clock(10_000);
  const tracker = new TurnLatencyTracker(
    { admittedAt: 9_000, lane: 'cloudflare', executor: 'runner' }, {}, time.now, sink,
  );
  // The attempt prepares for 1.2 s, then staging takes 240 ms.
  time.advance(1_440);
  tracker.markAgentStage(240);
  time.advance(500);
  tracker.markAgentStage(15);
  tracker.emit('returned');
  assert.equal(records[0]?.agentStageMs, 240);
  assert.equal(records[0]?.startToStageMs, 1_200);
  new TurnLatencyTracker({ lane: 'node', executor: 'node' }, {}, clock(0).now, sink).emit('returned');
  assert.equal('agentStageMs' in records[1]!, false, 'a turn that staged nothing omits the field');
  assert.equal('startToStageMs' in records[1]!, false);
});

// Defects caught: the lead is measured to the end of staging instead of its
// send, a later wake or staging moves it, or a turn that did not both wake
// and stage reports one.
test('turn_latency logs how long before staging the turn woke its Agent object', () => {
  const time = clock(10_000);
  const { records, sink } = captureSink();
  const tracker = new TurnLatencyTracker({ lane: 'cloudflare', executor: 'runner' }, {}, time.now, sink);
  tracker.markAgentWake();
  time.advance(1_300);
  tracker.markAgentWake();
  time.advance(200);
  tracker.markAgentStage(200);
  time.advance(50);
  tracker.markAgentStage(10);
  tracker.emit('returned');
  assert.equal(records[0]?.agentStageMs, 200);
  assert.equal(records[0]?.agentWakeLeadMs, 1_300, 'from the first wake to the first staging send');
  assert.equal(records[0]?.agentWakeSource, 'plan');

  const wokenOnly = new TurnLatencyTracker({ lane: 'cloudflare', executor: 'runner' }, {}, time.now, sink);
  wokenOnly.markAgentWake();
  wokenOnly.emit('returned');
  const stagedOnly = new TurnLatencyTracker({ lane: 'cloudflare', executor: 'runner' }, {}, time.now, sink);
  stagedOnly.markAgentStage(900);
  stagedOnly.emit('returned');
  assert.equal('agentWakeLeadMs' in records[1]!, false, 'a woken turn that staged nothing omits the field');
  assert.equal('agentWakeLeadMs' in records[2]!, false, 'a turn that staged without a wake omits the field');
  assert.equal('agentWakeSource' in records[1]! || 'agentWakeSource' in records[2]!, false, 'and its source');
});

// Defects caught: the lead counted from the turn's own clock when admission's
// wake came first, a later wake that moves it, and a record that does not
// say which wake it counts from.
test("turn_latency counts the lead from admission's wake of the Agent object when that came first", () => {
  const time = clock(10_000);
  const { records, sink } = captureSink();
  const tracker = new TurnLatencyTracker({ lane: 'cloudflare', executor: 'runner' }, {}, time.now, sink);
  time.advance(900);
  tracker.markAgentWake(7_600);
  tracker.markAgentWake();
  time.advance(400);
  tracker.markAgentStage(100);
  tracker.emit('returned');
  assert.equal(records[0]?.agentWakeLeadMs, 3_600, "from admission's send (the state store's clock) to the staging send");
  assert.equal(records[0]?.agentWakeSource, 'admission');
});

// Defects caught: model start or final counted from admission only (or from
// a later dispatch), the model work dropped or summed across updates, and the
// attempt's state store calls missing or not split at model start.
test('turn_latency logs model start and final from receipt, the model work, and the attempt\'s state store calls', async (context) => {
  const time = clock(10_000);
  context.mock.method(Date, 'now', time.now);
  context.mock.method(console, 'info', () => {});
  const { records, sink } = captureSink();
  const tracker = new TurnLatencyTracker(
    { receivedAt: 7_500, admittedAt: 9_000, lane: 'cloudflare', executor: 'runner' },
    { turnJobId: 'evt:T_LATENCY:1785509000.000100', attempt: 1 },
    time.now,
    sink,
  );
  await tracker.observeStateRpcs(async () => {
    await timedStateRpc('configGetAgent', Promise.resolve().then(() => time.advance(400)));
    time.advance(800);
    tracker.markModelStart();
    time.advance(300);
    tracker.markModelStart();
    tracker.markWork({ modelSteps: 1, toolCalls: 0, toolMs: 0 });
    tracker.markWork({ modelSteps: 3, toolCalls: 2, toolMs: 2_450 });
    await timedStateRpc('snapshotReplace', Promise.resolve().then(() => time.advance(600)));
    time.advance(19_400);
    tracker.markFinal('delivered');
  });
  tracker.emit('returned');
  assert.equal(records.length, 2);
  const [latency, rpcs] = records;
  assert.equal(latency?.event, 'turn_latency');
  assert.deepEqual({
    admissionToModelStartMs: latency?.admissionToModelStartMs,
    receiptToModelStartMs: latency?.receiptToModelStartMs,
    admissionToFinalMs: latency?.admissionToFinalMs,
    receiptToFinalMs: latency?.receiptToFinalMs,
    modelSteps: latency?.modelSteps,
    toolCalls: latency?.toolCalls,
    toolMs: latency?.toolMs,
  }, {
    admissionToModelStartMs: 2_200,
    receiptToModelStartMs: 3_700,
    admissionToFinalMs: 22_500,
    receiptToFinalMs: 24_000,
    modelSteps: 3,
    toolCalls: 2,
    toolMs: 2_450,
  });
  assert.deepEqual(rpcs, {
    component: 'runtime',
    event: 'state_rpc_summary',
    scope: 'turn',
    turnRef: opaqueTurnRef('evt:T_LATENCY:1785509000.000100'),
    calls: 2,
    rounds: 2,
    totalMs: 1_000,
    busyMs: 1_000,
    slowestMethod: 'snapshotReplace',
    slowestMs: 600,
    spanMs: 21_500,
    callsBeforeModelStart: 1,
    roundsBeforeModelStart: 1,
    busyMsBeforeModelStart: 400,
  });
  assertContentFree(latency!);
  assertContentFree(rpcs!);
});

test('turn_latency omits model start and work for an attempt that sent no dispatch', () => {
  const { records, sink } = captureSink();
  const time = clock(10_000);
  const tracker = new TurnLatencyTracker(
    { receivedAt: 7_500, admittedAt: 9_000, lane: 'cloudflare', executor: 'runner' }, {}, time.now, sink,
  );
  tracker.markFinal('deferred');
  tracker.emit('returned');
  for (const field of ['admissionToModelStartMs', 'receiptToModelStartMs', 'receiptToFinalMs', 'modelSteps', 'toolCalls', 'toolMs']) {
    assert.equal(field in records[0]!, false, field);
  }
});

test('state_rpc_summary logs nothing for a scope that made no call', async () => {
  const { records, sink } = captureSink();
  const summary = new StateRpcSummary('turn', Date.now, sink);
  await summary.run(async () => undefined);
  summary.emit();
  assert.deepEqual(records, []);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Defects caught: only slow calls counted (the bias this record removes),
// overlapping calls counted as separate rounds, a failure dropped, a call
// outside the scope counted, and two scopes in one isolate mixing their calls.
test('state_rpc_summary counts every call of its scope, its rounds, busy time and slowest method', async (context) => {
  let now = 1_000;
  context.mock.method(Date, 'now', () => now);
  context.mock.method(console, 'info', () => {});
  const { records, sink } = captureSink();
  const delivery = new StateRpcSummary('slack_delivery', () => now, sink);
  const other = new StateRpcSummary('turn', () => now, sink);
  await delivery.run(async () => {
    const a = deferred<{ ok: true }>();
    const b = deferred<{ ok: true }>();
    const first = timedStateRpc('configGetWorkspaceInstallation', a.promise);
    now += 30;
    const second = timedStateRpc('snapshotGet', b.promise);
    const elsewhere = other.run(() => timedStateRpc('settingGet', Promise.resolve({ ok: true })));
    now += 50;
    a.resolve({ ok: true });
    await first;
    now += 290;
    b.resolve({ ok: true });
    await second;
    await elsewhere;
    now += 100;
    const c = deferred<never>();
    const third = timedStateRpc('admitSlackTurn', c.promise);
    now += 900;
    c.reject(new Error('rpc disconnected'));
    await assert.rejects(third);
  });
  await timedStateRpc('settingGet', Promise.resolve({ ok: true }));
  now += 40;
  delivery.emit({ receivedAt: 400 });
  delivery.emit({ receivedAt: 400 });
  other.emit();
  assert.deepEqual(records, [{
    component: 'runtime',
    event: 'state_rpc_summary',
    scope: 'slack_delivery',
    calls: 3,
    rounds: 2,
    totalMs: 1_320,
    busyMs: 1_270,
    failed: 1,
    slowestMethod: 'admitSlackTurn',
    slowestMs: 900,
    spanMs: 1_410,
    receiptToStartMs: 600,
  }, {
    component: 'runtime',
    event: 'state_rpc_summary',
    scope: 'turn',
    calls: 1,
    rounds: 1,
    totalMs: 50,
    busyMs: 50,
    slowestMethod: 'settingGet',
    slowestMs: 50,
    spanMs: 1_410,
  }]);
});

// Defect caught: a cold store invisible in the logs (no record), logged on
// every call, or counted as cold because a runner booted in its isolate first.
test('store_boot logs a state store activation once, at its first call, with whether it installed the schema', () => {
  resetRunnerActivationsForTest();
  const time = clock(90_000);
  const { records, sink } = captureSink();
  new RunnerBootMarks(time.now, sink).call('alarm');
  const store = new StoreBootMarks(time.now, sink);
  time.advance(20);
  store.constructedOnVersion(true);
  time.advance(5);
  store.call('rpc');
  store.call('alarm');
  const next = new StoreBootMarks(time.now, sink);
  next.constructedOnVersion(false);
  next.call('alarm');
  assert.deepEqual(records.slice(1), [{
    component: 'runtime',
    event: 'store_boot',
    versionChanged: true,
    firstMethod: 'rpc',
    cold: true,
    constructMs: 20,
    constructToFirstCallMs: 5,
  }, {
    component: 'runtime',
    event: 'store_boot',
    versionChanged: false,
    firstMethod: 'alarm',
    cold: false,
    constructMs: 0,
    constructToFirstCallMs: 0,
  }]);
});

function flueEvent(event: Record<string, unknown>): FlueObservation {
  return { v: 3, eventIndex: 0, timestamp: '2026-11-10T00:00:00.000Z', instanceId: 'agent_x', submissionId: 'sub_x', ...event } as unknown as FlueObservation;
}

// Defects caught: message or tool text in the record, first token timed from
// the wrong request or from a later token, the turn read on every streamed
// token, cached input folded into input, a request that ended without a
// start (or with an error) dropped, and a model token that differs from the
// one turn_latency logs for the same model.
test('model_step logs each model request\'s first token, duration, tokens and tool calls without content', () => {
  const time = clock(5_000);
  const { records, sink } = captureSink();
  const steps = new ModelStepMarks(time.now, sink);
  let reads = 0;
  const turnOf = () => {
    reads += 1;
    return 'evt:T_LATENCY:1785509000.000100';
  };
  steps.observe(flueEvent({ type: 'turn_request', turnId: 'step_1', purpose: 'agent', request: { input: { systemPrompt: 'Complete the verification.' } } }), turnOf);
  time.advance(100);
  steps.observe(flueEvent({ type: 'turn_request', turnId: 'step_other', purpose: 'agent' }), turnOf);
  time.advance(600);
  steps.observe(flueEvent({ type: 'thinking_start', turnId: 'step_1' }), turnOf);
  time.advance(50);
  steps.observe(flueEvent({ type: 'text_delta', turnId: 'step_1', text: 'Complete the verification.' }), turnOf);
  steps.observe(flueEvent({
    type: 'turn',
    turnId: 'step_1',
    purpose: 'agent',
    durationMs: 6_200,
    isError: false,
    request: { providerId: 'openrouter', providerName: 'openrouter', requestedModel: 'synthetic/model-2.5', api: 'openai-completions' },
    response: {
      finishReason: 'toolUse',
      usage: { input: 1_200, output: 340, cacheRead: 30_000, cacheWrite: 900, totalTokens: 32_440, cost: {} },
      output: { role: 'assistant', content: [
        { type: 'text', text: 'Complete the verification.' },
        { type: 'toolCall', id: 'call_a', name: 'slack_read', arguments: { user: 'U_LATENCY' } },
        { type: 'toolCall', id: 'call_b', name: 'slack_read', arguments: { channel: 'C_LATENCY' } },
      ] },
    },
  }), turnOf);
  steps.observe(flueEvent({ type: 'turn', turnId: 'step_lost', purpose: 'compaction', durationMs: 900, isError: true, response: {} }), () => {
    throw new Error('Staged Slack turn input belongs to another submission.');
  });
  assert.equal(reads, 1, 'the turn is read once, when its request ends');
  assert.deepEqual(records, [{
    component: 'runtime',
    event: 'model_step',
    turnRef: opaqueTurnRef('evt:T_LATENCY:1785509000.000100'),
    modelToken: modelToken('openrouter/synthetic/model-2.5'),
    purpose: 'agent',
    outcome: 'toolUse',
    durationMs: 6_200,
    firstTokenMs: 700,
    inputTokens: 1_200,
    cachedInputTokens: 30_000,
    cacheWriteTokens: 900,
    outputTokens: 340,
    toolCalls: 2,
  }, {
    component: 'runtime',
    event: 'model_step',
    modelToken: 'unknown',
    purpose: 'compaction',
    outcome: 'error',
    durationMs: 900,
  }]);
  assertContentFree(records[0]!);
  assert.equal(records[0]!.modelToken, 'openrouter_synthetic_model_2_5');
});

test('turn_latency omits durations it cannot measure and never throws', () => {
  const time = clock(5_000);
  const { records, sink } = captureSink();
  const deferred = new TurnLatencyTracker({ lane: 'node', executor: 'node' }, {}, time.now, sink);
  deferred.markFinal('deferred');
  deferred.emit('returned');
  assert.deepEqual(records[0], {
    component: 'runtime',
    event: 'turn_latency',
    lane: 'node',
    executor: 'node',
    modelToken: 'unknown',
    outcome: 'returned',
    firstWrite: 'none',
    final: 'deferred',
    firstAnswerText: 'none',
    attemptMs: 0,
  });
  const failing = new TurnLatencyTracker(
    { admittedAt: 4_000, lane: 'node', executor: 'node' },
    {},
    time.now,
    { info() { throw new Error('closed'); } },
  );
  assert.doesNotThrow(() => failing.emit('threw'));
});

test('turn_latency counts the follow-ups a turn took, and only when it took some', () => {
  const { records, sink } = captureSink();
  const folded = new TurnLatencyTracker({ lane: 'cloudflare', executor: 'runner' }, {}, clock(0).now, sink);
  folded.markFolded(2);
  folded.emit('returned');
  const single = new TurnLatencyTracker({ lane: 'cloudflare', executor: 'runner' }, {}, clock(0).now, sink);
  single.markFolded(0);
  single.emit('returned');
  assert.equal(records[0]?.folded, 2);
  assert.equal('folded' in records[1]!, false);
  assertContentFree(records[0]!);
});

test('state_rpc logs every slow or failed call and samples fast ones', () => {
  resetStateRpcCountersForTest();
  const { records, sink } = captureSink();
  for (let index = 1; index < STATE_RPC_SAMPLE_EVERY; index += 1) {
    recordStateRpc('settingGet', 3, true, undefined, sink);
  }
  assert.equal(records.length, 0);
  recordStateRpc('settingGet', 4, true, undefined, sink);
  recordStateRpc('usageExecute', STATE_RPC_SLOW_MS, true, 'record_terminal', sink);
  recordStateRpc('configGetAgent', 1, false, undefined, sink);
  assert.deepEqual(records, [
    {
      component: 'runtime', event: 'state_rpc', method: 'settingGet', ms: 4, slow: false,
      ok: true, isolateCalls: STATE_RPC_SAMPLE_EVERY, isolateSlowCalls: 0,
    },
    {
      component: 'runtime', event: 'state_rpc', method: 'usageExecute', op: 'record_terminal',
      ms: STATE_RPC_SLOW_MS, slow: true, ok: true,
      isolateCalls: STATE_RPC_SAMPLE_EVERY + 1, isolateSlowCalls: 1,
    },
    {
      component: 'runtime', event: 'state_rpc', method: 'configGetAgent', ms: 1, slow: false,
      ok: false, isolateCalls: STATE_RPC_SAMPLE_EVERY + 2, isolateSlowCalls: 1,
    },
  ]);
  resetStateRpcCountersForTest();
});

test('timedStateRpc returns the RPC result, rethrows its failure, and logs slow calls', async (context) => {
  resetStateRpcCountersForTest();
  const logged: LogRecord[] = [];
  context.mock.method(console, 'info', (record: LogRecord) => logged.push(record));
  let now = 50_000;
  context.mock.method(Date, 'now', () => now);
  // The in-flight RPC settles after the timer starts, as a real stub call does.
  const value = await timedStateRpc('settingGet', Promise.resolve().then(() => {
    now += 4_200;
    return { ok: true, value: 'secret-setting-value' };
  }));
  assert.deepEqual(value, { ok: true, value: 'secret-setting-value' });
  await assert.rejects(
    timedStateRpc('settingGet', Promise.reject(new Error('rpc disconnected'))),
    /rpc disconnected/,
  );
  assert.deepEqual(logged.map((record) => [record.method, record.ms, record.slow, record.ok]), [
    ['settingGet', 4_200, true, true],
    ['settingGet', 0, false, false],
  ]);
  assert.equal(JSON.stringify(logged).includes('secret-setting-value'), false);
  resetStateRpcCountersForTest();
});

test('Cf*Store proxies time every stub call without wrapping the stub', () => {
  const source = readFileSync(new URL('../src/config/cf-state-proxies.ts', import.meta.url), 'utf8');
  assert.equal(/\bnew Proxy\b/.test(source), false);
  assert.equal(/unwrap\(\s*await this\.stub\./.test(source), false, 'every stub call goes through rpc()');
  assert.equal(/this\.stub\.\w+\(/.test(source), false, 'no call bypasses the stub source');
  // Each call names its method and runs on the stub the store's source gives
  // it (a fresh one per call for FreshTagStateStubs), then through rpc().
  const calls = [...source.matchAll(/rpcVia\(this\.stub,\s*'(\w+)',\s*\(stub\) => stub\.(\w+)\(/g)];
  assert.ok(calls.length > 100);
  for (const [, label, method] of calls) assert.equal(label, method);
});

const latencyAssignment: ResolvedAssignment = {
  workspaceId: 'T_LATENCY',
  channelId: 'C_LATENCY',
  agentId: 'agent_latency',
  runtimeContract: 'chickpea-v1',
  agent: {
    id: 'agent_latency',
    kind: 'user',
    revision: 1,
    name: 'Latency',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

function latencyTurn(): NormalizedSlackTurn {
  return {
    workspaceId: 'T_LATENCY',
    channelId: 'C_LATENCY',
    eventId: 'Ev_LATENCY',
    text: 'Complete the verification.',
    userId: 'U_LATENCY',
    messageTs: '1785509000.000100',
    threadTs: '1785509000.000100',
    source: 'app_mention',
    channelType: 'channel',
    contextMode: 'thread',
  };
}

test('runTurn emits one content-free turn_latency record per relay attempt', async (context) => {
  const logged: LogRecord[] = [];
  context.mock.method(console, 'info', (record: unknown) => {
    if (typeof record === 'object' && record && (record as LogRecord).event === 'turn_latency') {
      logged.push(record as LogRecord);
    }
  });
  let tombstones = 0;
  const client = {
    chat: {
      postMessage: async () => ({ ok: true, channel: 'C_LATENCY', ts: '1785509001.000100' }),
    },
  } as unknown as WebClient;
  await runTurn(latencyTurn(), latencyAssignment, undefined, {
    client,
    turnId: 'evt:T_LATENCY:1785509000.000100',
    runId: 'run-latency',
    runAttempt: 1,
    usageRecordingEnabled: false,
    turnLatency: { admittedAt: Date.now() - 2_000, lane: 'node', executor: 'node' },
    onDelivered() {
      tombstones += 1;
    },
  });
  assert.equal(tombstones, 1);
  assert.equal(logged.length, 1);
  const [record] = logged;
  assert.equal(record?.outcome, 'returned');
  assert.equal(record?.final, 'delivered');
  assert.equal(record?.firstWrite, 'final');
  assert.equal(record?.lane, 'node');
  assert.equal(record?.runRef, opaqueRunRef('run-latency'));
  assert.equal(record?.turnRef, opaqueTurnRef('evt:T_LATENCY:1785509000.000100'));
  assert.ok(Number(record?.admissionToFinalMs) >= 2_000);
  assert.ok(Number(record?.admissionToFirstWriteMs) >= 2_000);
  assertContentFree(record!);
  assert.equal(JSON.stringify(record).includes(WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT), false);

  logged.length = 0;
  const failing = {
    chat: {
      postMessage: async () => {
        throw new Error('slack unavailable');
      },
    },
  } as unknown as WebClient;
  await assert.rejects(runTurn(latencyTurn(), latencyAssignment, undefined, {
    client: failing,
    turnId: 'evt:T_LATENCY:1785509000.000100',
    usageRecordingEnabled: false,
    turnLatency: { lane: 'cloudflare', executor: 'alarm' },
  }));
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.outcome, 'threw');
  assert.equal(logged[0]?.reason, 'other', 'a failed Slack write is none of the reattaching reasons');
  assert.equal(logged[0]?.final, 'none');
  assert.equal(logged[0]?.firstWrite, 'none');
});

test('runTurn without a relay latency context logs nothing', async (context) => {
  const logged: unknown[] = [];
  context.mock.method(console, 'info', (record: unknown) => {
    if (typeof record === 'object' && record && (record as LogRecord).event === 'turn_latency') {
      logged.push(record);
    }
  });
  const client = {
    chat: {
      postMessage: async () => ({ ok: true, channel: 'C_LATENCY', ts: '1785509002.000100' }),
    },
  } as unknown as WebClient;
  await runTurn(latencyTurn(), latencyAssignment, undefined, {
    client,
    usageRecordingEnabled: false,
  });
  assert.deepEqual(logged, []);
});

test('the Node relay passes the durable admission time to runTurn', async () => {
  const noop = async () => undefined;
  const rows = [{
    id: 'evt:T1:100.1',
    attempts: 0,
    enqueuedAt: 1_700_000_000_000,
    turn: {
      workspaceId: 'T1', channelId: 'C1', threadTs: '100.1', messageTs: '100.1',
      userId: 'U1', text: 'hello', source: 'app_mention',
    },
    assignment: { agentId: 'analyst' },
    progress: {},
  }];
  const seen: Array<RunTurnOptions['turnLatency']> = [];
  const state = {
    listPendingTurns: async () => rows.map((row) => ({ ...row })),
    freezeRuntimePlan: noop,
    prepareFlueDispatch: noop,
    reconcileFlueExistingInstance: noop,
    recordFlueReceipt: noop,
    recordFlueSettlement: noop,
    matchFlueObservation: noop,
    markTurnRecoveryRequired: noop,
    recordTurnAttempt: noop,
    recordInteractionIntent: noop,
    recordSlackInteractionProgress: noop,
    markTurnDelivered: async () => {
      rows.length = 0;
    },
    discardTurn: async () => {
      rows.length = 0;
    },
    setActiveWork: noop,
  } as unknown as SlackStateStore;
  const executeTurn = async (
    _turn: unknown,
    _assignment: unknown,
    _env: unknown,
    options: RunTurnOptions,
  ) => {
    seen.push(options.turnLatency);
  };
  try {
    await wakeNodeTurnRelay(undefined, {
      state,
      work: {} as unknown as WorkStore,
      executeTurn: executeTurn as never,
    });
  } finally {
    await stopNodeTurnRelay();
  }
  assert.deepEqual(seen, [{ admittedAt: 1_700_000_000_000, lane: 'node', executor: 'node' }]);
});

test('a job admitted from a gateway inbox row carries its receipt time into turn_latency', () => {
  const db = openStateDb(':memory:');
  try {
    let now = 1_800_000_000_000;
    const receivedAt = now;
    const inbox = new GatewayInboxStoreLogic(db, () => now);
    const turns = new TurnJobStoreLogic(db, () => now);
    const delivery: GatewayEventDelivery = {
      protocolVersion: 1,
      kind: 'event.deliver',
      deliveryId: 'delivery:Ev_LATENCY',
      bindingId: 'binding_latency',
      workspaceId: 'T_LATENCY',
      envelope: {
        workspaceId: 'T_LATENCY',
        eventId: 'Ev_LATENCY',
        eventTime: 1_800_000_000,
        event: {
          type: 'app_mention', channel: 'C_LATENCY', user: 'U_LATENCY',
          ts: '1785509000.000100', event_ts: '1785509000.000100', text: 'Complete the verification.',
        },
      },
    };
    assert.equal(inbox.admit(delivery), 'accepted');

    // The delivery waits in the inbox while an earlier alarm runs turns.
    now += 90_000;
    const [claimed] = inbox.claimPending(1);
    assert.equal(claimed?.acceptedAt, receivedAt);
    const release = turns.noteReceipt('Ev_LATENCY', claimed!.acceptedAt);
    turns.enqueue({
      id: 'evt:gateway', evtKey: 'evt:gateway', msgKey: 'msg:gateway',
      turn: { ...latencyTurn(), eventId: 'Ev_LATENCY' }, assignment: latencyAssignment,
    });
    release();
    // An HTTP or Node admission (no queued receipt) is received when admitted.
    turns.enqueue({
      id: 'evt:http', evtKey: 'evt:http', msgKey: 'msg:http',
      turn: { ...latencyTurn(), eventId: 'Ev_HTTP' }, assignment: latencyAssignment,
    });
    const pending = turns.listPending(10);
    const gateway = pending.find((job) => job.id === 'evt:gateway');
    const http = pending.find((job) => job.id === 'evt:http');
    assert.equal(gateway?.receivedAt, receivedAt);
    assert.equal(gateway?.enqueuedAt, receivedAt + 90_000);
    assert.equal(http?.receivedAt, http?.enqueuedAt);

    const time = clock(receivedAt + 91_000);
    const { records, sink } = captureSink();
    const tracker = new TurnLatencyTracker(
      { admittedAt: gateway!.enqueuedAt!, receivedAt: gateway!.receivedAt!, lane: 'cloudflare', executor: 'alarm' },
      { turnJobId: gateway!.id },
      time.now,
      sink,
    );
    time.advance(1_000);
    tracker.markSlackWrite('activity_status');
    tracker.emit('returned');
    assert.equal(records[0]?.receiptToAdmissionMs, 90_000);
    assert.equal(records[0]?.admissionToFirstWriteMs, 2_000);
    assert.equal(records[0]?.receiptToFirstWriteMs, 92_000);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// gateway_delivery

const GATEWAY_NOW = 1_785_509_061_500;

function gatewayEvent(eventTs: unknown = '1785509000.100100'): GatewayEventDelivery {
  return {
    protocolVersion: 1,
    kind: 'event.deliver',
    deliveryId: 'delivery:Ev_LATENCY',
    bindingId: 'binding_latency',
    workspaceId: 'T_LATENCY',
    envelope: {
      workspaceId: 'T_LATENCY',
      eventId: 'Ev_LATENCY',
      eventTime: 1_785_509_000,
      event: {
        type: 'app_mention', channel: 'C_LATENCY', user: 'U_LATENCY',
        ts: '1785509000.000100', event_ts: eventTs as string, text: 'Complete the verification.',
      },
    },
  };
}

const healthySession: GatewaySessionRunnerHealthSnapshot = {
  generation: 3,
  phase: 'healthy',
  healthy: true,
  shouldReplace: false,
  socketState: 1,
  checkpoint: {
    health: 'healthy', attempt: 0, connectedAt: GATEWAY_NOW - 45_000,
    lastHeartbeatAt: GATEWAY_NOW - 5_000, rotateAt: GATEWAY_NOW + 600_000,
  },
};

test('gateway_delivery reports transport lag, Slack lag, and socket health without content', () => {
  const { records, sink } = captureSink();
  emitGatewayDelivery({
    transport: 'socket', receivedAt: GATEWAY_NOW, delivery: gatewayEvent(),
    session: healthySession, outcome: 'accepted',
  }, sink);
  emitGatewayDelivery({
    transport: 'http', receivedAt: GATEWAY_NOW, delivery: gatewayEvent(),
    issuedAt: GATEWAY_NOW - 180, outcome: 'duplicate',
  }, sink);
  assert.deepEqual(records, [{
    component: 'runtime',
    event: 'gateway_delivery',
    transport: 'socket',
    deliveryKind: 'event',
    eventType: 'app_mention',
    outcome: 'accepted',
    slackLagMs: 61_400,
    sessionPhase: 'healthy',
    sessionHealth: 'healthy',
    sessionAttempt: 0,
    sessionGeneration: 3,
    sessionAgeMs: 45_000,
  }, {
    component: 'runtime',
    event: 'gateway_delivery',
    transport: 'http',
    deliveryKind: 'event',
    eventType: 'app_mention',
    outcome: 'duplicate',
    lagMs: 180,
    slackLagMs: 61_400,
  }]);
  records.forEach(assertContentFree);
});

test('gateway_delivery falls back to event_time and skips Slack lag for interactions', () => {
  const { records, sink } = captureSink();
  emitGatewayDelivery({
    transport: 'socket', receivedAt: GATEWAY_NOW, delivery: gatewayEvent('not-a-ts U_LATENCY'),
    outcome: 'rejected',
  }, sink);
  const interaction: GatewayInboundDelivery = {
    protocolVersion: 1, kind: 'interaction.agent_selected', deliveryId: 'delivery:I_LATENCY',
    bindingId: 'binding_latency', workspaceId: 'T_LATENCY', userId: 'U_LATENCY', agentId: 'agent_latency',
  };
  emitGatewayDelivery({ transport: 'socket', receivedAt: GATEWAY_NOW, delivery: interaction, outcome: 'accepted' }, sink);
  assert.equal(records[0]?.slackLagMs, 61_500, 'whole-second envelope event_time');
  assert.equal(records[0]?.outcome, 'rejected');
  assert.equal(records[1]?.deliveryKind, 'agent_selected');
  assert.equal('slackLagMs' in records[1]!, false);
  assert.equal('sessionPhase' in records[1]!, false);
  records.forEach(assertContentFree);
  assert.doesNotThrow(() => emitGatewayDelivery({
    transport: 'socket', receivedAt: GATEWAY_NOW, delivery: {} as GatewayInboundDelivery, outcome: 'failed',
  }, { info() { throw new Error('log pipe closed'); } }));
});

function extractClass(path: string, name: string) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) =>
    ts.isClassDeclaration(node) && node.name?.text === name);
  assert.ok(declaration && ts.isClassDeclaration(declaration));
  return { source, declaration };
}

test('the Cloudflare gateway socket logs gateway_delivery for each admitted frame', async () => {
  const { source, declaration } = extractClass('../src/slack/gateway/cloudflare-session.ts', 'SlackGatewaySession');
  const { records, sink } = captureSink();
  let admission: GatewayInboundAdmission | undefined;
  let admissions = 0;
  let admit: () => Promise<unknown> = async () => ({ ok: true, value: 'accepted' });
  const Probe = vm.runInNewContext(
    ts.transpileModule(declaration.getText(source).replace(/^export /u, '') + '\nSlackGatewaySession',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      resolveSlackPublicUrl: async () => undefined,
      parseHttpDeliveryState: () => undefined,
      GATEWAY_HTTP_SETTING: 'slack.gateway.httpDelivery.v1',
      Date: { now: () => GATEWAY_NOW },
      DurableObject: class { constructor(_context: unknown, public env: unknown) {} },
      deploymentTenancy,
      getSettingsStore: () => ({ getSetting: async () => 'configured' }),
      GATEWAY_BINDING_SETTING: 'binding',
      GATEWAY_DURABLE_ADMISSION_CAPABILITY: 'durable',
    GATEWAY_UI_INTERACTIONS_CAPABILITY: 'ui',
      cloudflareWorkerVersionId: () => 'test-version',
      tagStateStub: () => ({ admitGatewayDelivery: () => { admissions += 1; return admit(); } }),
      GatewayInboundAdmission,
      emitGatewayDelivery: (observation: Parameters<typeof emitGatewayDelivery>[0]) =>
        emitGatewayDelivery(observation, sink),
      GatewaySessionRunnerSupervisor,
      GatewaySessionRunner: class {
        constructor(options: { admission: GatewayInboundAdmission }) { admission = options.admission; }
        async start() { return true; }
        stop() {}
        healthSnapshot() { return healthySession; }
      },
    },
  ) as new (context: object, env: object) => { wake(): Promise<void> };
  let alarm: number | null = null;
  await new Probe({ waitUntil() {}, storage: {
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => { alarm = at; },
    deleteAlarm: async () => { alarm = null; },
  } }, {}).wake();
  assert.ok(admission);
  const context = { botUserId: 'U_BOT' };
  assert.equal(await admission.deliver(gatewayEvent(), context), 'accepted');
  // A Slack retry of an admitted delivery is answered from memory.
  assert.equal(await admission.deliver(gatewayEvent(), context), 'duplicate');
  assert.equal(admissions, 1);
  // This app's own stream edit never reaches the store.
  const edit = gatewayEvent();
  edit.deliveryId = 'delivery:Ev_EDIT';
  edit.envelope = { ...edit.envelope, eventId: 'Ev_EDIT', event: {
    type: 'message', subtype: 'message_changed', channel: 'C_LATENCY', ts: '1785509001.000100',
    event_ts: '1785509001.000100', message: { type: 'message', user: 'U_BOT', ts: '1785509000.000200', text: 'x' },
  } as unknown as GatewayEventDelivery['envelope']['event'] };
  assert.equal(await admission.deliver(edit, context), 'accepted');
  assert.equal(admissions, 1);
  admit = async () => { throw new Error('singleton reset U_LATENCY'); };
  const failing = gatewayEvent();
  failing.deliveryId = 'delivery:Ev_FAIL';
  await assert.rejects(admission.deliver(failing, context), /singleton reset/);
  assert.deepEqual(records.map((record) =>
    [record.transport, record.outcome, record.source, record.eventType, record.subtype,
      record.filterReason, record.slackLagMs, record.sessionAgeMs]), [
    ['socket', 'accepted', 'store', 'app_mention', undefined, undefined, 61_400, 45_000],
    ['socket', 'duplicate', 'recent', 'app_mention', undefined, undefined, 61_400, 45_000],
    ['socket', 'filtered', 'filter', 'message', 'message_changed', 'own_message_changed', 60_500, 45_000],
    ['socket', 'failed', 'store', 'app_mention', undefined, undefined, 61_400, 45_000],
  ]);
  assert.equal(typeof records[0]!.admitMs, 'number');
  assert.equal(typeof records[0]!.queueMs, 'number');
  records.forEach(assertContentFree);
});

test('HTTP gateway admission logs gateway_delivery with the signed issuedAt lag', async () => {
  const { source, declaration } = extractClass('../src/cloudflare.ts', 'TagStateStore');
  const method = declaration.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === 'receiveGatewayHttp');
  assert.ok(method);
  const { records, sink } = captureSink();
  const binding = {
    bindingId: 'binding_latency', deploymentId: 'dep', workspaceId: 'T_LATENCY',
    appId: 'A', botUserId: 'B', installedAt: 1,
  };
  const deliveryState = JSON.stringify({
    version: 1, bindingId: 'binding_latency', deploymentId: 'dep', installedAt: 1, mode: 'http', revision: 2,
  });
  let kind: 'gateway.delivery' | 'gateway.challenge' = 'gateway.delivery';
  let verifyFails = false;
  let delivery: object = gatewayEvent();
  let queued = 0;
  const woken: string[] = [];
  const Probe = vm.runInNewContext(
    ts.transpileModule(`class Probe { ${method.getText(source)} }\nProbe`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      JSON,
      Date: { now: () => GATEWAY_NOW },
      GATEWAY_BINDING_SETTING: 'binding',
      GATEWAY_HTTP_SETTING: 'slack.gateway.httpDelivery.v1',
      HttpDeliveryError,
      GatewayInboxConflictError: class extends Error {},
      parseHttpDeliveryState,
      httpDeliveryReceipt,
      gatewayUiReceiptNow,
      loadKeyFormFor: async () => undefined,
      loadCredentialKeyring: () => ({}),
      verifyHttpDelivery: async () => {
        if (verifyFails) throw new HttpDeliveryError(401, 'delivery_unauthorized');
        return {
          protocolVersion: 1, kind, bindingId: 'binding_latency', workspaceId: 'T_LATENCY', appId: 'A',
          deploymentId: 'dep', routeRevision: 2, keyId: 'k', issuedAt: GATEWAY_NOW - 240,
          ...(kind === 'gateway.delivery' ? { delivery } : { challengeId: 'c', proof: 'p' }),
        };
      },
      emitGatewayDelivery: (observation: Parameters<typeof emitGatewayDelivery>[0]) =>
        emitGatewayDelivery(observation, sink),
    },
  ) as new () => { receiveGatewayHttp(input: object): Promise<{ status: number; body: unknown }> };
  const probe = Object.assign(new Probe(), {
    env: {},
    admissionWakeAt: () => GATEWAY_NOW,
    armAlarmNoLaterThan: async () => {},
    wakeRunnerAtReceipt: (received: { kind: string }) => woken.push(received.kind),
    call(fn: (stores: object) => unknown) {
      try {
        return { ok: true, value: fn({
          settings: { getSetting: (key: string) => key === 'binding' ? JSON.stringify(binding) : deliveryState },
          config: { getWorkspaceInstallation: () => ({ transportMode: 'gateway', health: 'healthy',
            gatewayBindingId: 'binding_latency', appId: 'A', botUserId: 'B' }) },
          identity: { getAuthControl: () => undefined },
          gatewayInbox: { admit: () => { queued += 1; return 'accepted'; } },
          uiSurfaces: { get: () => undefined },
        }) };
      } catch {
        return { ok: false };
      }
    },
  });
  const input = { body: '{}', signature: 's', url: 'https://example.workers.dev/slack/gateway/delivery' };
  assert.equal((await probe.receiveGatewayHttp(input)).status, 200);
  kind = 'gateway.challenge';
  assert.equal((await probe.receiveGatewayHttp(input)).status, 200);
  verifyFails = true;
  assert.equal((await probe.receiveGatewayHttp(input)).status, 401);
  assert.deepEqual(records, [{
    component: 'runtime', event: 'gateway_delivery', transport: 'http', deliveryKind: 'event',
    eventType: 'app_mention', outcome: 'accepted', lagMs: 240, slackLagMs: 61_400,
  }], 'challenges and unauthenticated requests log nothing');
  records.forEach(assertContentFree);

  // A modal submission for no known card is answered in the receipt and never queued.
  kind = 'gateway.delivery';
  verifyFails = false;
  delivery = {
    protocolVersion: 1, kind: 'interaction.view_submission', deliveryId: 'view:1', bindingId: 'binding_latency',
    workspaceId: 'T_LATENCY', userId: 'U1', viewId: 'V1', callbackId: 'chickpea.ui.v1.form',
    privateMetadata: 'forged', state: {}, triggerId: null,
  };
  const answered = await probe.receiveGatewayHttp(input);
  assert.equal(answered.status, 200);
  assert.deepEqual((answered.body as { interaction?: unknown }).interaction, {
    responseAction: { response_action: 'clear' },
  });
  assert.equal(queued, 1, 'only the earlier event was queued');
  assert.deepEqual(woken, ['event.deliver'], 'only the accepted event woke a runner at receipt');
});
