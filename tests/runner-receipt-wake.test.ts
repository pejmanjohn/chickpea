import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { assertInstallationOwnership, objectInstallationEnv } from '../src/config/installation-scope.ts';
import type { ConfigStoreLogic } from '../src/config/store.ts';
import {
  opaqueTurnRef,
  resetRunnerActivationsForTest,
  RunnerBootMarks,
} from '../src/observability/runtime-latency.ts';
import type { GatewayInboundDelivery } from '../src/slack/gateway/protocol.ts';
import { seedGatewayIdentity } from '../src/slack/installation-execution.ts';
import { parseAdmissionAgentWake } from '../src/slack/admission-agent-wake.ts';
import { receiptRunnerWake } from '../src/slack/receipt-runner-wake.ts';
import { parseAdmissionStatusMark } from '../src/slack/admission-activity.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { createRunnerSupersedeState, runnerLoopScheduler } from '../src/slack/thread-runner-loop.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import type { SlackEvent } from '../src/slack/types.ts';
import { DoSqlStateDb } from '../src/state/do-state-db.ts';
import { ResidencyHold, residencyHoldMs } from '../src/state/residency-hold.ts';
import {
  AGENT_MENTION,
  delivery,
  HELP_GROUP,
  message,
  receiptStore,
  withLane,
} from './helpers/gateway-admission-lane.ts';
import { FakeObjectRestoreContext, FakeObjectStorage } from './helpers/installation-objects.ts';

/** Settles within a second, or fails: the receipt never waits for the wake. */
function promptly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('the receipt waited for the wake')), 1_000).unref()),
  ]);
}

// Defects caught: a wake keyed apart from the hand-off (a fixed owner
// incarnation, the thread key of a non-v1 installation, another thread
// coordinate), a turnRef that is not the turn's, and a wake sent only after
// admission rather than at receipt.
test('a delivery that can become a turn wakes, at its receipt, the runner its hand-off then addresses', async () => {
  await withLane(async ({ config, help, jobs, admit }) => {
    // A thread @help already owns for the second time: its runner is that tenure's.
    config.putAgentThreadRoute({
      workspaceId: 'T1', channelId: 'C1', threadTs: '7000.000100', agentId: help.id,
      agentGeneration: help.configurationGeneration ?? help.revision, ownerIncarnation: 2,
    });
    const cases: Array<[string, SlackEvent]> = [
      ['a mention of an Agent', AGENT_MENTION],
      ['a reply in the thread it opened', message({ ts: '5000.000200', thread_ts: '5000.000100', text: 'and since Monday?' })],
      ['a DM', message({ channel: 'D1', ts: '6000.000100', text: 'hello' })],
      ['a reply in a thread its owner holds again', message({ ts: '7000.000200', thread_ts: '7000.000100', text: 'go on' })],
    ];
    for (const [name, event] of cases) {
      const store = receiptStore(config);
      const received = delivery(event);
      assert.deepEqual(JSON.parse(JSON.stringify(await store.probe.admitGatewayDelivery(received))), { ok: true, value: 'accepted' });
      assert.equal(store.wakes.length, 1, `${name}: one wake at receipt, before admission`);
      assert.equal(store.armed(), 1);
      jobs.length = 0;
      await admit(received);
      const [job] = jobs;
      assert.ok(job, `${name} became a turn`);
      assert.equal(store.wakes[0]!.turnJobId, job.id, `${name}: the wake names the turn it becomes`);
      assert.equal(await store.probe.admitToRunner(job), true);
      assert.deepEqual(store.handoffs, [store.wakes[0]!.name], `${name}: the hand-off addresses the runner the wake reached`);
    }
    assert.match(threadKeyOf(jobs[0]!), /:owner-i2$/, 'the last reply was handed to the second tenure');
  });
});

function threadKeyOf(job: TurnJob): string {
  return slackAgentThreadKey(job.turn, job.assignment);
}

// Defects caught: an awaited wake (the gateway's acknowledgement waits on a
// runner's activation), a rejection left unhandled, and a synchronous throw
// that fails the receipt.
test('a wake that never answers, rejects or throws leaves the receipt as it was', async () => {
  await withLane(async ({ config }) => {
    const failures: Array<[string, () => Promise<void>]> = [
      ['never answers', () => new Promise<void>(() => undefined)],
      ['rejects', () => Promise.reject(new Error('runner unavailable'))],
      ['throws', () => { throw new Error('no such method'); }],
    ];
    for (const [name, wake] of failures) {
      const store = receiptStore(config, { wake });
      const result = await promptly(store.probe.admitGatewayDelivery(delivery(AGENT_MENTION)));
      assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, value: 'accepted' }, name);
      assert.equal(store.wakes.length, 1, `${name}: the wake was sent`);
      assert.equal(store.armed(), 1, `${name}: admission was still armed`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  });
});

// Defects caught: waking for every message (an unowned thread's reply, a
// people group, a reaction, an edit, profile and membership events, a bot's
// post), for a click, for a redelivered duplicate, or when turns do not go to
// thread runners at all.
test('a delivery that cannot become a turn wakes no runner', async () => {
  await withLane(async ({ config, help }) => {
    // The same mention wakes a runner here, so each case below is refused by its own difference.
    assert.equal(await receiptStoreWakes(config, delivery(AGENT_MENTION)), 1);
    config.createAgent({
      ...help, id: 'agent_paused', name: 'Paused', enabled: false,
      slackPresence: {
        requestedHandle: 'paused', normalizedHandle: 'paused', desiredState: 'active', health: 'healthy', userGroupId: 'SPAUSED',
        avatar: { kind: 'generated', revision: 1, seed: 'paused', url: 'https://example.com/paused.svg' },
      },
    });
    const silent: Array<[string, GatewayInboundDelivery, Parameters<typeof receiptStore>[1]?]> = [
      ['an unaddressed Channel message', delivery(message({ ts: '8000.000100', text: 'lunch?' }))],
      ['a reply in a thread no Agent owns', delivery(message({ ts: '8000.000200', thread_ts: '8000.000100', text: 'yes' }))],
      ['a mention of a group of people', delivery(message({ ts: '8000.000300', text: '<!subteam^SPEOPLE|@people> standup?' }))],
      ['a mention of a disabled Agent', delivery(message({ ts: '8000.000310', text: '<!subteam^SPAUSED|@paused> around?' }))],
      ['a reaction', delivery({
        type: 'reaction_added', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '5000.000100' },
        event_ts: '8000.000400',
      })],
      ['an edit', delivery({
        type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel',
        message: { type: 'message', user: 'U1', ts: '5000.000100', text: `<!subteam^${HELP_GROUP}|@help> what changed today?`, edited: { user: 'U1', ts: '8000.000500' } },
        previous_message: { type: 'message', user: 'U1', ts: '5000.000100', text: `<!subteam^${HELP_GROUP}|@help> what changed?` },
      } as unknown as SlackEvent)],
      ['a profile change', delivery({ type: 'user_change', event_ts: '8000.000600', user: { id: 'U1', team_id: 'T1' } })],
      ['a Channel join', delivery({ type: 'member_joined_channel', user: 'U2', channel: 'C1', event_ts: '8000.000700' })],
      ["a bot's post", delivery(message({ ts: '8000.000800', text: '<@UBOT> hi', bot_id: 'B1' }))],
      ['a click', {
        protocolVersion: 1, kind: 'interaction.ui_action', deliveryId: 'ui_1', bindingId: 'binding1', workspaceId: 'T1',
        userId: 'U1', containerType: 'message', channelId: 'C1', messageTs: '5000.000300', threadTs: '5000.000100',
        isEphemeral: false, viewId: null, actionId: 'chickpea.host.v1.approve', blockId: 'b', actionType: 'button',
        value: 'v', selected: [], state: {}, actionTs: '8000.000900', triggerId: 't',
      } as unknown as GatewayInboundDelivery],
      ['a redelivered mention', delivery(AGENT_MENTION), { outcome: 'duplicate' }],
      ['a mention while turns run on the alarm', delivery(AGENT_MENTION), { env: { SLACK_TAG_TURN_EXECUTOR: 'alarm' } }],
      ['a mention without a runner binding', delivery(AGENT_MENTION), { env: { SLACK_THREAD_RUNNER: undefined } }],
    ];
    for (const [name, received, options] of silent) {
      assert.equal(await receiptStoreWakes(config, received, options), 0, `${name} wakes no runner`);
    }
  });
});

// Defects caught: the prediction refusing a direct installation (the direct
// path's receipt, TagStateStore.noteSlackDelivery, then wakes nothing), keying
// it apart from the gateway's, or waking without the bot identity it needs.
test("a direct installation's delivery predicts the runner the gateway's would", async () => {
  await withLane(async ({ config }) => {
    const received = delivery(AGENT_MENTION);
    assert.equal(received.kind, 'event.deliver');
    const predicted = receiptRunnerWake(received, config);
    assert.ok(predicted);
    config.updateWorkspaceInstallation('T1', { transportMode: 'direct', gatewayBindingId: null });
    assert.deepEqual(receiptRunnerWake({ kind: 'event.deliver', envelope: received.envelope }, config), predicted,
      'the direct path asks with the event alone');
    config.updateWorkspaceInstallation('T1', { botUserId: null });
    assert.equal(receiptRunnerWake(received, config), undefined, 'an installation without its bot identity is refused');
  });
});

async function receiptStoreWakes(
  config: ConfigStoreLogic,
  received: GatewayInboundDelivery,
  options?: Parameters<typeof receiptStore>[1],
): Promise<number> {
  const store = receiptStore(config, options);
  await store.probe.admitGatewayDelivery(received);
  return store.wakes.length;
}

// The runner itself, transpiled whole and constructed over a fake object's
// storage, as the platform constructs it for a call.
const runnerSource = ts.createSourceFile(
  'thread-runner.ts',
  readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const runnerClass = runnerSource.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'SlackThreadRunner');
const leadWindow = runnerSource.statements.find((node) => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some((declaration) => declaration.name.getText(runnerSource) === 'RUNNER_WAKE_LEAD_WINDOW_MS'));
assert.ok(runnerClass && leadWindow);

interface RunnerProbe {
  wake(sentAt?: unknown, turnJobId?: unknown): Promise<void>;
  admit(job: unknown): Promise<{ admitted: boolean }>;
  takeHandoff(jobId: string): { latency: Record<string, unknown>; agentWake?: unknown };
}

function runnerOver(storage: FakeObjectStorage, clock: { now: number }, records: Array<Record<string, unknown>>) {
  const sink = { info: (record: Record<string, unknown>) => records.push(record) };
  const Runner = vm.runInNewContext(
    ts.transpileModule(
      `${leadWindow!.getText(runnerSource)}\n${runnerClass!.getText(runnerSource).replace(/^export /, '')}\nSlackThreadRunner`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      Date: { now: () => clock.now },
      console,
      DurableObject: class {
        constructor(readonly ctx: unknown, readonly env: unknown) {}
      },
      RunnerBootMarks: class extends RunnerBootMarks {
        constructor() {
          super(() => clock.now, sink);
        }
      },
      objectInstallationEnv,
      assertInstallationOwnership,
      seedGatewayIdentity,
      parseAdmissionAgentWake,
      parseAdmissionStatusMark,
      ThreadRunnerJobStore,
      DoSqlStateDb,
      SlackStatusRegistry,
      createRunnerSupersedeState,
      runnerLoopScheduler,
      ResidencyHold,
      residencyHoldMs,
    },
  ) as new (ctx: unknown, env: unknown) => RunnerProbe;
  const runner = new Runner(new FakeObjectRestoreContext(storage, { name: 'T1:C1:5000.000100:owner-i1' }), {});
  return { runner, settled: () => new Promise((resolve) => setImmediate(resolve)) };
}

// Defects caught: a wake that creates the job tables (a runner the receipt
// woke in vain would hold storage the inventory never recorded), one reported
// as another method or without the turn, a lead the hand-off drops or keeps
// for a later turn, a stale wake counted, and a resume check the wake skips.
test('a wake activates a fresh runner without storing anything, and the hand-off that follows counts its lead', async () => {
  resetRunnerActivationsForTest();
  const clock = { now: 10_000 };
  const records: Array<Record<string, unknown>> = [];
  const storage = new FakeObjectStorage();
  const { runner, settled } = runnerOver(storage, clock, records);
  await settled();
  await runner.wake(9_400, 'msg:C1:5000.000100');
  assert.deepEqual(storage.tables(), [], 'a woken runner stores nothing');
  assert.equal(storage.alarm, null);
  assert.deepEqual(records, [{
    component: 'runtime', event: 'runner_boot', firstMethod: 'wake', cold: true,
    turnRef: opaqueTurnRef('msg:C1:5000.000100'), sentToConstructMs: 600, constructMs: 0, constructToFirstCallMs: 0,
  }]);

  clock.now = 10_900;
  await runner.admit({ id: 'msg:C1:5000.000100', threadKey: 'T1:C1:5000.000100:owner-i1', payload: {}, sentAt: 9_700 });
  assert.equal(records.length, 1, 'the hand-off found the woken activation');
  assert.deepEqual({ ...runner.takeHandoff('msg:C1:5000.000100').latency }, { handoffMs: 1_200, runnerWakeLeadMs: 300 });
  await runner.admit({ id: 'msg:C1:5000.000200', threadKey: 'T1:C1:5000.000100:owner-i1', payload: {}, sentAt: 10_800 });
  assert.deepEqual({ ...runner.takeHandoff('msg:C1:5000.000200').latency }, { handoffMs: 100 }, 'one wake leads one hand-off');

  await runner.wake(11_000);
  clock.now = 80_000;
  await runner.admit({ id: 'msg:C1:5000.000300', threadKey: 'T1:C1:5000.000100:owner-i1', payload: {}, sentAt: 79_000 });
  assert.deepEqual({ ...runner.takeHandoff('msg:C1:5000.000300').latency }, { handoffMs: 1_000 }, 'a wake over a minute old leads nothing');

  // A runner that held a running turn still resumes it when a wake activates it.
  const held = new FakeObjectStorage();
  const jobs = new ThreadRunnerJobStore(new DoSqlStateDb(held.asDurableObjectStorage()));
  jobs.admit({ id: 'running', threadKey: 'T1:C1:5000.000100:owner-i1', payload: null }, 1);
  jobs.markRunning('running');
  clock.now = 90_000;
  const resumed = runnerOver(held, clock, []);
  await resumed.settled();
  assert.equal(held.alarm, 90_000);
});

// Defects caught: the runner drops admission's Agent wake (the turn's freeze
// then wakes the object again and counts its lead from itself), keeps it for
// a later attempt, stores it, takes a malformed one, or takes one over a
// minute old (its object may have been evicted since).
test("a hand-off carries admission's Agent wake to its turn's first attempt only, within the minute", async () => {
  const clock = { now: 20_000 };
  const storage = new FakeObjectStorage();
  const { runner, settled } = runnerOver(storage, clock, []);
  await settled();
  const threadKey = 'T1:C1:5000.000100:owner-i1';
  const agentWake = { instanceId: `agent_${'a'.repeat(40)}`, sentAt: 19_900 };
  await runner.admit({ id: 'j1', threadKey, payload: { agentWake }, sentAt: 19_950 });
  assert.deepEqual({ ...runner.takeHandoff('j1').agentWake as object }, agentWake);
  assert.equal(runner.takeHandoff('j1').agentWake, undefined, 'a later attempt carries none');
  assert.equal(JSON.stringify(storage.database.prepare('SELECT * FROM runner_jobs').all()).includes('agentWake'), false,
    'the wake is never stored');
  await runner.admit({ id: 'j2', threadKey, payload: { agentWake: { instanceId: threadKey, sentAt: 19_900 } }, sentAt: 19_950 });
  assert.equal(runner.takeHandoff('j2').agentWake, undefined, 'a wake of no Agent instance is none');
  await runner.admit({ id: 'j3', threadKey, payload: { agentWake }, sentAt: 19_950 });
  clock.now = agentWake.sentAt + 60_001;
  assert.equal(runner.takeHandoff('j3').agentWake, undefined, 'a wake over a minute old at the attempt is none');
});

// Defects caught: the runner drops admission's status mark (turn_latency then
// counts the first write from the runner's later one), gives it to a later
// attempt, stores it, or takes a malformed one.
test("a hand-off carries admission's status mark to its turn's first attempt only", async () => {
  const clock = { now: 30_000 };
  const storage = new FakeObjectStorage();
  const { runner, settled } = runnerOver(storage, clock, []);
  await settled();
  const threadKey = 'T1:C1:5000.000100:owner-i1';
  await runner.admit({ id: 's1', threadKey, payload: { admissionStatus: { waitedMs: 320, shownAt: 29_900 } }, sentAt: 29_950 });
  assert.deepEqual({ ...runner.takeHandoff('s1').latency },
    { handoffMs: 50, admissionStatusMs: 320, admissionStatusAt: 29_900 });
  assert.deepEqual({ ...runner.takeHandoff('s1').latency }, {}, 'a later attempt carries none');
  assert.equal(JSON.stringify(storage.database.prepare('SELECT * FROM runner_jobs').all()).includes('admissionStatus'), false,
    'the mark is never stored');
  // A write that missed the cap: its wait only.
  await runner.admit({ id: 's2', threadKey, payload: { admissionStatus: { waitedMs: 600 } }, sentAt: 29_950 });
  assert.deepEqual({ ...runner.takeHandoff('s2').latency }, { handoffMs: 50, admissionStatusMs: 600 });
  for (const [name, admissionStatus] of [
    ['no wait', { shownAt: 29_900 }],
    ['a negative wait', { waitedMs: -1, shownAt: 29_900 }],
    ['a wait that is not a number', { waitedMs: '320', shownAt: 29_900 }],
  ] as const) {
    await runner.admit({ id: name, threadKey, payload: { admissionStatus }, sentAt: 29_950 });
    assert.deepEqual({ ...runner.takeHandoff(name).latency }, { handoffMs: 50 }, `${name}: no mark`);
  }
});
