import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import type { WebClient } from '@slack/web-api';
import ts from 'typescript';

import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  emitRelayAlarm,
  emitRuntimeLatency,
  opaqueRunRef,
  opaqueTurnRef,
  recordStateRpc,
  resetStateRpcCountersForTest,
  startRelayAlarmMetrics,
  STATE_RPC_SAMPLE_EVERY,
  STATE_RPC_SLOW_MS,
  timedStateRpc,
  TurnLatencyTracker,
} from '../src/observability/runtime-latency.ts';
import type { SlackStateStore } from '../src/slack/claim-store.ts';
import { stopNodeTurnRelay, wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import {
  runTurn,
  WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT,
  type RunTurnOptions,
} from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { GatewayInboxStoreLogic } from '../src/slack/gateway/inbox.ts';
import type { GatewayEventDelivery } from '../src/slack/gateway/protocol.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { WorkStore } from '../src/work/types.ts';

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
  }]);
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
    `class AlarmProbe { ${alarmMethod.getText(cloudflareSource)} }\nAlarmProbe`,
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

test('turn_latency measures admission to the first acknowledged write and to final', () => {
  const time = clock(10_000);
  const { records, sink } = captureSink();
  const tracker = new TurnLatencyTracker(
    { admittedAt: 9_000, lane: 'cloudflare', executor: 'alarm' },
    { turnJobId: 'evt:T_LATENCY:1785509000.000100', runId: 'run-raw', attempt: 1 },
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
    outcome: 'returned',
    firstWrite: 'agent_session',
    final: 'delivered',
    admissionToStartMs: 1_000,
    admissionToFirstWriteMs: 1_500,
    admissionToFinalMs: 6_000,
    attemptMs: 5_100,
  }]);
  assertContentFree(records[0]!);
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
    outcome: 'returned',
    firstWrite: 'none',
    final: 'deferred',
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
  const calls = [...source.matchAll(/rpc\(\s*'(\w+)',\s*this\.stub\.(\w+)\(/g)];
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
