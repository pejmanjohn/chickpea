import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { CfIdentityStore } from '../src/config/cf-state-proxies.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import type { IdentityRpcRequest } from '../src/identity/types.ts';
import { drainManagementReceiptOutbox, isAgentAppSwitchJob } from '../src/management/receipts.ts';
import { ManagementStoreLogic } from '../src/management/store.ts';
import type {
  ManagementAgentCreatedWelcome,
  ManagementReceiptOutboxRecord,
  ManagementRpcRequest,
} from '../src/management/types.ts';
import { agentAppSwitchOutbox, armAgentAppSwitch } from '../src/slack/agent-apps/live.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { hostedInstallation } from './helpers/installation-objects.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

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
const methods = ['identityExecute', 'managementExecute', 'armReceiptDrainAfter', 'armAlarmNoLaterThan', 'setAlarmNoLaterThan'].map((name) => {
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(source);
});
const writers = source.statements.find((node) => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(({ name }) => name.getText(source) === 'RECEIPT_OUTBOX_WRITERS'));
assert.ok(writers, 'production RECEIPT_OUTBOX_WRITERS exists');
const compiled = ts.transpileModule(
  `${writers.getText(source)}\nclass ManagementProbe { ${methods.join('\n')} }\nManagementProbe`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string } };
type Probe = {
  ctx: { storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> } };
  call: (callback: (stores: unknown) => unknown) => Result;
  identityExecute(request: IdentityRpcRequest): Promise<Result>;
  managementExecute(request: ManagementRpcRequest): Promise<Result>;
};
const ProbeClass = vm.runInNewContext(compiled, { Date }) as new () => Probe;

const NOW = 1_800_000_000_000;
/** The state store's next wake before the claim: a far-off sweep. */
const LATER_SWEEP = NOW + 7 * 60_000;

function welcomeReceipt(operationId: string): ManagementAgentCreatedWelcome {
  return {
    kind: 'agent_created_welcome',
    creationOperationId: operationId,
    turnJobId: 'turn_welcome',
    agentId: 'agent_new',
    agentName: 'New Agent',
    requesterMembershipId: 'member_1',
    surface: 'channel',
    persona: { name: 'New Agent' },
    publication: { status: 'complete', incomplete: [] },
  };
}

function welcomeOutbox(operationId: string, at: number): ManagementReceiptOutboxRecord {
  return {
    outboxId: `agent_welcome_${operationId}`,
    operationId,
    destination: {
      kind: 'thread', workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: '1800000000.000001',
    },
    receipt: welcomeReceipt(operationId),
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

test('queueing a welcome owed after a late handle arms the outbox drain at once', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const f = fixture(LATER_SWEEP);
  try {
    f.management.putOutbox({
      ...welcomeOutbox('op_late_handle', NOW - 60_000),
      status: 'delivered',
      attempts: 1,
      deliveryRef: 'slack:C_TEST:1800000000.000002',
      receipt: {
        ...welcomeReceipt('op_late_handle'),
        publication: { status: 'partial', incomplete: ['slack_presence'] },
        deliveryPersona: 'chickpea',
      },
    });
    const queued = await f.probe.managementExecute({
      kind: 'queue_owed_agent_welcome',
      input: { agentId: 'agent_new', agentName: 'New Agent', agentHandle: 'new-agent', at: NOW },
    });
    assert.equal(queued.ok, true);
    assert.equal(f.management.nextOutboxDueAt(), NOW);
    assert.deepEqual(f.writes, [NOW], 'the follow-up is drained now, not at the next unrelated wake');
  } finally { f.db.close(); }
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

test('a hosted first-Owner claim over the state RPC arms the outbox drain for Chickpea\'s introduction', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const tenant = hostedInstallation('inst_owner_introduction');
  const probe = new ProbeClass();
  let alarm: number | null = LATER_SWEEP;
  const writes: number[] = [];
  probe.call = (callback) => ({ ok: true, value: callback(tenant.stores) });
  probe.ctx = { storage: {
    async getAlarm() { return alarm; },
    async setAlarm(at) { writes.push(at); alarm = at; },
  } };
  const identity = new CfIdentityStore({
    identityExecute: (request: IdentityRpcRequest) => probe.identityExecute(request),
  } as unknown as TagStateRpc);
  await createSlackOwner(identity, { now: NOW, organizationId: tenant.organizationId });
  assert.equal(tenant.stores.management.nextOutboxDueAt(), NOW);
  assert.deepEqual(writes, [NOW], 'the introduction is drained now, not at the next unrelated wake');
});

// Defect caught: a teammate's welcome, claimed when they open Chickpea's
// Messages tab, waiting for an unrelated wake. The Worker claims it over this
// RPC, and no message admission arms a drain for it.
test('claiming Chickpea\'s introduction over the state RPC arms the outbox drain at once', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const f = fixture(LATER_SWEEP);
  try {
    const claimed = await f.probe.managementExecute({
      kind: 'claim_introduction',
      input: {
        organizationId: 'org_1', userId: 'user_1', workspaceId: 'T_TEST', slackUserId: 'U_TEST',
        trigger: 'first_interaction', usable: { agents: [], more: 0 }, at: NOW,
      },
    });
    assert.equal(claimed.ok, true);
    assert.equal(f.management.nextOutboxDueAt(), NOW);
    assert.deepEqual(f.writes, [NOW], 'the welcome is sent now, not at the next unrelated wake');
  } finally { f.db.close(); }
});

// Defects caught: an Agent app's switch armed at Allow that waits for an unrelated wake, or a second Allow of the
// same install arming a second switch.
test("an Agent app's switch job put over the state RPC arms the drain at once, and the same install arms it once", async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const f = fixture(LATER_SWEEP);
  try {
    const job = { agentId: 'agent_support', appId: 'A0APP1', teamId: 'T_TEST', ownerSlackUserId: 'U_OWNER' };
    for (const at of [NOW, NOW + 1]) {
      const put = await f.probe.managementExecute({ kind: 'put_outbox', record: agentAppSwitchOutbox(job, at) });
      assert.equal(put.ok, true);
    }
    assert.equal(f.management.nextOutboxDueAt(), NOW);
    assert.deepEqual(f.writes, [NOW], 'the switch runs now, not at the next unrelated wake');
    const claimed = f.management.claimDueOutbox(NOW, 10, NOW + 30_000);
    assert.deepEqual(claimed.map((record) => record.receipt), [{ kind: 'agent_app_switch', agentId: 'agent_support' }], 'one job');
    assert.equal(isAgentAppSwitchJob(claimed[0]!.receipt), true, 'the drain runs it rather than posting it');
  } finally { f.db.close(); }
});

// Defect caught: a switch whose job failed every attempt left with no driver, because the outbox keeps the settled
// row and arming the same ID again inserts nothing; and an Owner's second press arming a second job beside one waiting.
test("an Agent app's switch job that settled unfinished is armed afresh, and one still waiting is never armed twice", async () => {
  const f = fixture(null);
  try {
    const job = { agentId: 'agent_support', appId: 'A0APP1', teamId: 'T_TEST', ownerSlackUserId: 'U_OWNER' };
    const management = { putOutbox: async (record: ManagementReceiptOutboxRecord) => f.management.putOutbox(record) };
    const unsettled = () => f.db.all(
      `SELECT outbox_id FROM management_receipt_outbox WHERE status IN ('pending', 'delivering') ORDER BY outbox_id`,
    ).map((row) => (row as { outbox_id: string }).outbox_id);
    const first = agentAppSwitchOutbox(job, NOW).outboxId;
    let now = NOW;
    await armAgentAppSwitch(management, job, now);
    await armAgentAppSwitch(management, job, now + 1);
    assert.deepEqual(unsettled(), [first], 'a second press beside a waiting job arms nothing');

    // Slack down for longer than the outbox retries: the job fails every attempt and settles failed.
    for (let due = f.management.nextOutboxDueAt(); due !== undefined; due = f.management.nextOutboxDueAt()) {
      now = Math.max(now, due);
      await drainManagementReceiptOutbox({
        management: f.management as never, now: () => now,
        deliver: async () => { throw Object.assign(new Error('Slack is down'), { name: 'slack_unreachable' }); },
      });
    }
    assert.equal(f.management.getOutboxForOperation(first)?.status, 'failed');
    assert.deepEqual(unsettled(), [], 'nothing drives the switch');

    await armAgentAppSwitch(management, job, now);
    await armAgentAppSwitch(management, job, now + 1);
    assert.deepEqual(unsettled(), [`${first}:1`], 'Finish setting up arms one new job');
    assert.equal(f.management.nextOutboxDueAt(), now, 'which is due at once');

    // A job that ran while the app was not live settles delivered; the switch it left is armed again too.
    await drainManagementReceiptOutbox({
      management: f.management as never, now: () => now, deliver: async () => ({ deliveryRef: 'agent_app_switch:not_live' }),
    });
    await armAgentAppSwitch(management, job, now);
    assert.deepEqual(unsettled(), [`${first}:2`]);
  } finally { f.db.close(); }
});
