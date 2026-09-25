import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { drainManagementReceiptOutbox } from '../src/management/receipts.ts';
import { ManagementStoreLogic } from '../src/management/store.ts';
import type {
  ManagementReceiptOutboxRecord,
  ManagementRpcRequest,
} from '../src/management/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

// Execute the production TagStateStore RPC method and its alarm helper (not a
// copy of their arming rule) over a real management store. Under the thread
// runner, the Agent welcome is claimed from the runner's turn over this RPC,
// so this RPC is the only thing that can wake the outbox drain for it.
const source = ts.createSourceFile(
  'cloudflare.ts',
  readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const stateClass = source.statements.find((node) =>
  ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
assert.ok(stateClass && ts.isClassDeclaration(stateClass));
const methods = ['managementExecute', 'armAlarmNoLaterThan'].map((name) => {
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(source);
});
const compiled = ts.transpileModule(
  `class ManagementProbe { ${methods.join('\n')} }\nManagementProbe`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string } };
type Probe = {
  ctx: { storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> } };
  call: (callback: (stores: unknown) => unknown) => Result;
  managementExecute(request: ManagementRpcRequest): Promise<Result>;
};
const ProbeClass = vm.runInNewContext(compiled, { Date }) as new () => Probe;

const NOW = 1_800_000_000_000;
/** The state store's next wake before the claim: a far-off sweep. */
const LATER_SWEEP = NOW + 7 * 60_000;

function welcomeOutbox(operationId: string, at: number): ManagementReceiptOutboxRecord {
  return {
    outboxId: `agent_welcome_${operationId}`,
    operationId,
    destination: {
      kind: 'thread', workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: '1800000000.000001',
    },
    receipt: {
      kind: 'agent_created_welcome',
      creationOperationId: operationId,
      turnJobId: 'turn_welcome',
      agentId: 'agent_new',
      agentName: 'New Agent',
      requesterMembershipId: 'member_1',
      surface: 'channel',
      persona: { name: 'New Agent' },
      publication: { status: 'complete', incomplete: [] },
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

function claim(operationId = 'op_welcome'): ManagementRpcRequest {
  return {
    kind: 'claim_agent_creation_welcome',
    input: { operationId, setups: [], outbox: welcomeOutbox(operationId, NOW) },
  };
}

function claimResult(result: Result) {
  assert.equal(result.ok, true);
  return (result as { value: { result: { created: boolean; outbox: ManagementReceiptOutboxRecord } } })
    .value.result;
}

function fixture(initialAlarm: number | null) {
  const db = openStateDb(':memory:');
  const management = new ManagementStoreLogic(db);
  const probe = new ProbeClass();
  let alarm = initialAlarm;
  const writes: number[] = [];
  probe.call = (callback) => ({ ok: true, value: callback({ management }) });
  probe.ctx = { storage: {
    async getAlarm() { return alarm; },
    async setAlarm(at) { writes.push(at); alarm = at; },
  } };
  return { db, management, probe, writes, alarm: () => alarm };
}

test('claiming an Agent welcome over the state RPC arms the outbox drain at once', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  for (const initial of [null, LATER_SWEEP]) {
    const f = fixture(initial);
    try {
      assert.equal(claimResult(await f.probe.managementExecute(claim())).created, true);
      assert.equal(f.management.nextOutboxDueAt(), NOW);
      assert.equal(f.alarm(), NOW,
        'a pending welcome is drained now, not at the next unrelated wake');
      assert.deepEqual(f.writes, [NOW]);
    } finally { f.db.close(); }
  }
});

test('a welcome claim never pulls an earlier wake later, and reads arm nothing', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const f = fixture(NOW - 100);
  try {
    await f.probe.managementExecute(claim());
    assert.deepEqual(f.writes, [], 'an overdue alarm already covers the welcome');
  } finally { f.db.close(); }
  const g = fixture(LATER_SWEEP);
  try {
    await g.probe.managementExecute({ kind: 'get_setup', setupOperationId: 'none' });
    assert.deepEqual(g.writes, [], 'a read never touches the alarm');
  } finally { g.db.close(); }
});

test('a replayed welcome claim posts exactly one welcome and re-arms nothing once delivered', async (context) => {
  let clock = NOW;
  context.mock.method(Date, 'now', () => clock);
  const f = fixture(LATER_SWEEP);
  try {
    assert.equal(claimResult(await f.probe.managementExecute(claim())).created, true);
    assert.equal(claimResult(await f.probe.managementExecute(claim())).created, false,
      'a replayed claim reuses the one outbox row');
    const posted: string[] = [];
    const drain = () => drainManagementReceiptOutbox({
      management: f.management as never,
      now: () => clock,
      deliver: async (record) => {
        posted.push(record.outboxId);
        return { deliveryRef: 'slack:C_TEST:1800000001.000001' };
      },
    });
    assert.equal((await drain()).delivered, 1);
    clock += 1_000;
    assert.equal((await drain()).delivered, 0);
    f.writes.length = 0;
    const late = claimResult(await f.probe.managementExecute(claim()));
    assert.equal(late.created, false);
    assert.equal(late.outbox.status, 'delivered');
    assert.equal(f.management.nextOutboxDueAt(), undefined);
    assert.deepEqual(f.writes, [], 'a settled welcome needs no drain');
    assert.equal((await drain()).delivered, 0);
    assert.deepEqual(posted, ['agent_welcome_op_welcome'], 'exactly one welcome post');
  } finally { f.db.close(); }
});
