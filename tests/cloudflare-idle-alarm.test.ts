import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import {
  emitRelayAlarm,
  startRelayAlarmMetrics,
  type RelayAlarmMetrics,
} from '../src/observability/runtime-latency.ts';
import { StopAbortFence } from '../src/slack/runner-stops.ts';

// The production alarm() and its idle drain (no turn pending), over stubbed
// stores whose drains advance a scripted clock, so each part's timing is
// exact. The complete Worker is exercised by verify:cf-smoke.
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
  `${['earliestDefined'].map(moduleStatement).join('\n')}
class IdleAlarmProbe { ${[
    'alarm', 'drainRelayAlarm', 'deliverStopNotices', 'armAlarmNoLaterThan',
  ].map(stateMethod).join('\n')} }\nIdleAlarmProbe`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

const NOW = 1_800_000_000_000;

type LogRecord = { [field: string]: number | boolean | string };

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

/**
 * A state store with no turn pending, whose idle drains each take the given
 * time on a clock the test owns. `records` collects the relay_alarm records
 * as they would be logged.
 */
function idleStore(costs: PartCosts, options: { nextOutboxDueAt?: number } = {}) {
  let clock = NOW;
  const records: LogRecord[] = [];
  let alarm: number | null = null;
  const writes: number[] = [];
  const advance = (ms: number | undefined) => async () => {
    clock += ms ?? 0;
    return {};
  };
  const Probe = vm.runInNewContext(compiled, {
    Date: { now: () => clock },
    console: { warn() {} },
    startRelayAlarmMetrics: () => startRelayAlarmMetrics(() => clock),
    emitRelayAlarm: (metrics: RelayAlarmMetrics) =>
      emitRelayAlarm(metrics, () => clock, { info: (record) => records.push(record as LogRecord) }),
    createPlatformProductTelemetry: () => ({}),
    localSettingsStore: () => ({}),
    localGatewayAppStores: () => ({ config: {} }),
    slackTurnExecutor: () => 'alarm',
    MAX_TURN_DRAIN_BATCH: 16,
    ALARM_PENDING_PER_THREAD: 4,
    RELAY_RETRY_BACKOFF_MS: 2_000,
    drainGatewayInbox: async () => false,
    deliverDueStopNotices: async () => undefined,
    drainLedgerRuns: advance(costs.ledger),
    drainSlackInteractionCleanups: advance(costs.cleanups),
    drainTerminalPresentationRepairs: advance(costs.repairs),
    drainCloudflareScheduleActions: advance(costs.schedule),
    drainCloudflareManagementReceipts: advance(costs.receipts),
    runDriverRetryDelayMs: (_drain: object, retryDelay: number) => retryDelay,
  }) as new () => {
    env: object;
    ctx: object;
    stores: object;
    stopAborts: StopAbortFence;
    carriedAlarmTurns: Map<string, string>;
    createAlarmIdentityResolver(): unknown;
    alarm(): Promise<void>;
  };
  const probe = new Probe();
  probe.env = {};
  probe.ctx = { storage: {
    async getAlarm() { return alarm; },
    async setAlarm(at: number) { writes.push(at); alarm = at; },
  } };
  // Class fields the method-only probe does not carry.
  probe.stopAborts = new StopAbortFence();
  probe.carriedAlarmTurns = new Map();
  probe.createAlarmIdentityResolver = () => async () => ({ client: {} });
  probe.stores = {
    management: {
      cleanupRetention() { clock += costs.retention; },
      nextOutboxDueAt: () => options.nextOutboxDueAt,
    },
    turnJobs: {
      listPendingByThread: () => [],
      hasPending: () => false,
      hasPendingSlackInteractionCleanup: () => costs.cleanups !== undefined,
      hasHandoffs: () => false,
      nextStopNoticeDueAt: () => undefined,
    },
    gatewayInbox: { hasPending: () => false, nextPendingDueAt: () => undefined },
  };
  return {
    probe,
    records,
    writes,
    alarm: () => alarm,
    armAt(at: number) { alarm = at; },
  };
}

for (const cleanupPending of [false, true]) {
  test(`an idle alarm's record times each of its parts (${cleanupPending ? 'a' : 'no'} cleanup pending)`, async () => {
    const costs: PartCosts = {
      retention: 300, ledger: 100, ...(cleanupPending ? { cleanups: 50 } : {}),
      repairs: 70, schedule: 20, receipts: 400,
    };
    const store = idleStore(costs);
    await store.probe.alarm();
    assert.equal(store.records.length, 1);
    const record = store.records[0]!;
    assert.equal(record.outcome, 'idle');
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
