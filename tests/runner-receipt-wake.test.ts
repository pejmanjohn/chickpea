import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import {
  assertInstallationOwnership,
  installationOwnershipOf,
  objectInstallationEnv,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import { closeNodeStateStores, resolveStores, type AppStores, type PlatformEnv } from '../src/config/state-backend.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  opaqueTurnRef,
  resetRunnerActivationsForTest,
  RunnerBootMarks,
} from '../src/observability/runtime-latency.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { GATEWAY_HTTP_SETTING, parseHttpDeliveryState } from '../src/slack/gateway/http-delivery.ts';
import type { GatewayInboundDelivery } from '../src/slack/gateway/protocol.ts';
import { gatewayUiReceiptNow } from '../src/slack/gateway/ui-receipt.ts';
import {
  carriedGatewayIdentity,
  effectiveTurnSlackInstallationId,
  seedGatewayIdentity,
} from '../src/slack/installation-execution.ts';
import { receiptRunnerWake } from '../src/slack/receipt-runner-wake.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { createRunnerSupersedeState, runnerLoopScheduler } from '../src/slack/thread-runner-loop.ts';
import { threadRunnerStub } from '../src/slack/thread-runner-rpc.ts';
import { slackTurnExecutor } from '../src/slack/turn-executor-flag.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import type { SlackEvent } from '../src/slack/types.ts';
import { promisify } from '../src/state/async-facade.ts';
import { DoSqlStateDb } from '../src/state/do-state-db.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { FakeObjectRestoreContext, FakeObjectStorage } from './helpers/installation-objects.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

// The production receipt and hand-off methods of TagStateStore, not copies.
const cloudflare = ts.createSourceFile(
  'cloudflare.ts',
  readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const stateClass = cloudflare.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
assert.ok(stateClass);
const stateMethod = (name: string) => {
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(cloudflare) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(cloudflare);
};
const ReceiptProbe = vm.runInNewContext(
  ts.transpileModule(
    `class ReceiptProbe { ${['admitGatewayDelivery', 'wakeRunnerAtReceipt', 'runnerMode', 'admitToRunner']
      .map(stateMethod).join('\n')} }\nReceiptProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  {
    Date,
    Promise,
    console: { warn() {} },
    GATEWAY_HTTP_SETTING,
    parseHttpDeliveryState,
    gatewayUiReceiptNow,
    receiptRunnerWake,
    threadRunnerStub,
    slackTurnExecutor: (env: Record<string, unknown>) => slackTurnExecutor(env, {}),
    slackAgentThreadKey,
    installationOwnershipOf,
    effectiveTurnSlackInstallationId,
    carriedGatewayIdentity,
  },
) as new () => {
  admitGatewayDelivery(delivery: GatewayInboundDelivery): Promise<unknown>;
  admitToRunner(job: TurnJob): Promise<boolean>;
};

interface Wake { name: string; sentAt: number; turnJobId?: string }

/**
 * A state store that receives deliveries into an inbox answering `outcome`,
 * over `config`, and hands turns to the runners its env's namespace names.
 */
function receiptStore(config: ConfigStoreLogic, options: {
  env?: Record<string, unknown>;
  outcome?: 'accepted' | 'duplicate';
  wake?: () => Promise<void>;
} = {}) {
  const wakes: Wake[] = [];
  const handoffs: string[] = [];
  let armed = 0;
  const namespace = {
    getByName: (name: string) => ({
      wake: (sentAt: number, turnJobId?: string) => {
        wakes.push({ name, sentAt, ...(turnJobId === undefined ? {} : { turnJobId }) });
        return options.wake ? options.wake() : Promise.resolve();
      },
      admit: async () => {
        handoffs.push(name);
        return { admitted: true };
      },
    }),
  };
  const env = scopeInstallationEnv(
    { CHICKPEA_TENANCY: 'installation', SLACK_THREAD_RUNNER: namespace, ...options.env } as PlatformEnv,
    { installationId: 'inst_receipt_wake' },
  );
  const stores = {
    settings: { getSetting: () => undefined },
    uiSurfaces: { get: () => undefined },
    gatewayInbox: { admit: () => options.outcome ?? 'accepted' },
    config,
    presentations: { get: () => undefined },
    turnJobs: { confirmRunner() {} },
  };
  const probe = Object.assign(new ReceiptProbe(), {
    env,
    stores,
    call(fn: (value: typeof stores) => unknown) {
      try {
        return { ok: true, value: fn(stores) };
      } catch {
        return { ok: false, error: { code: 'internal', message: 'failed' } };
      }
    },
    admissionWakeAt: () => 0,
    armAlarmNoLaterThan: async () => {
      armed += 1;
    },
  });
  return { probe, wakes, handoffs, armed: () => armed };
}

const HELP_GROUP = 'SHELP';

interface Lane {
  config: ConfigStoreLogic;
  help: CustomAgentConfig;
  jobs: TurnJob[];
  /** Admit a delivery as the state store's inbox drain does. */
  admit(delivery: GatewayInboundDelivery): Promise<void>;
}

/**
 * Workspace T1 on the shared gateway with Channel C1, where the Agent @help
 * (group SHELP) is granted; U1 is its Owner. Admission reads the same config
 * the state store reads at receipt.
 */
async function withLane(scenario: (lane: Lane) => Promise<void>): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const db = openStateDb(':memory:');
  const config = new ConfigStoreLogic(db, agentRoutineDeletion);
  const stores: AppStores = {
    ...resolveStores(),
    config: promisify(config, { close: () => db.close() }) as unknown as AppStores['config'],
  };
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1', runtimeContract: 'chickpea-v1',
    });
    await stores.config.materializeChickpeaAgent();
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'team', lifecycle: 'active' }, 0);
    const help = await stores.config.createAgent({
      id: 'agent_help', name: 'Support', instructions: 'Help.', enabled: true, lifecycle: 'active',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins', model: 'local-stub/help',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'help', normalizedHandle: 'help', desiredState: 'active', health: 'healthy',
        userGroupId: HELP_GROUP, avatar: { kind: 'generated', revision: 1, seed: 'help', url: 'https://example.com/help.svg' },
      },
    });
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: help.id, status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'team', channelIsPrivate: false,
    }, 0);
    const channel = { id: 'C1', name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false };
    const groups = [{ id: HELP_GROUP, name: 'Support', handle: 'help', description: '', date_delete: 0, date_update: 1 }];
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
      async call(operation: string, args: Record<string, unknown>) {
        if (operation === 'users.info') {
          return { user: {
            id: args.user, team_id: 'T1', name: String(args.user), deleted: false, is_bot: false, is_app_user: false,
            is_restricted: false, is_ultra_restricted: false, is_stranger: false,
          } };
        }
        if (operation === 'conversations.info') return { channel };
        if (operation === 'conversations.members') return { members: ['U1', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [channel] };
        if (operation === 'usergroups.list') return { usergroups: groups };
        if (operation === 'chat.postMessage') return { ok: true, ts: '9000.000001', channel: args.channel };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
    const jobs: TurnJob[] = [];
    const enqueueTurn = async (job: TurnJob) => {
      jobs.push(job);
      return { ok: true as const, value: null };
    };
    await scenario({
      config,
      help,
      jobs,
      async admit(delivery) {
        assert.equal(delivery.kind, 'event.deliver');
        if (delivery.kind !== 'event.deliver') return;
        assert.equal(await processGatewaySlackEnvelope(delivery.envelope, undefined, gateway, { stores, enqueueTurn }), 'accepted');
      },
    });
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    db.close();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
}

let deliveries = 0;

function delivery(event: SlackEvent): GatewayInboundDelivery {
  deliveries += 1;
  return {
    protocolVersion: 1, kind: 'event.deliver', deliveryId: `delivery_${deliveries}`, bindingId: 'binding1',
    workspaceId: 'T1', envelope: { workspaceId: 'T1', eventId: `Ev${deliveries}`, eventTime: 1_000 + deliveries, event },
  };
}

function message(fields: { ts: string; text: string; channel?: string; thread_ts?: string; bot_id?: string }): SlackEvent {
  const channel = fields.channel ?? 'C1';
  return {
    type: 'message', channel, channel_type: channel.startsWith('D') ? 'im' : 'channel', user: 'U1', ...fields,
  } as SlackEvent;
}

const AGENT_MENTION = message({ ts: '5000.000100', text: `<!subteam^${HELP_GROUP}|@help> what changed?` });

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
  await withLane(async ({ config }) => {
    // The same mention wakes a runner here, so each case below is refused by its own difference.
    assert.equal(await receiptStoreWakes(config, delivery(AGENT_MENTION)), 1);
    const silent: Array<[string, GatewayInboundDelivery, Parameters<typeof receiptStore>[1]?]> = [
      ['an unaddressed Channel message', delivery(message({ ts: '8000.000100', text: 'lunch?' }))],
      ['a reply in a thread no Agent owns', delivery(message({ ts: '8000.000200', thread_ts: '8000.000100', text: 'yes' }))],
      ['a mention of a group of people', delivery(message({ ts: '8000.000300', text: '<!subteam^SPEOPLE|@people> standup?' }))],
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
  takeHandoff(jobId: string): Record<string, unknown>;
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
      ThreadRunnerJobStore,
      DoSqlStateDb,
      SlackStatusRegistry,
      createRunnerSupersedeState,
      runnerLoopScheduler,
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
  assert.deepEqual({ ...runner.takeHandoff('msg:C1:5000.000100') }, { handoffMs: 1_200, runnerWakeLeadMs: 300 });
  await runner.admit({ id: 'msg:C1:5000.000200', threadKey: 'T1:C1:5000.000100:owner-i1', payload: {}, sentAt: 10_800 });
  assert.deepEqual({ ...runner.takeHandoff('msg:C1:5000.000200') }, { handoffMs: 100 }, 'one wake leads one hand-off');

  await runner.wake(11_000);
  clock.now = 80_000;
  await runner.admit({ id: 'msg:C1:5000.000300', threadKey: 'T1:C1:5000.000100:owner-i1', payload: {}, sentAt: 79_000 });
  assert.deepEqual({ ...runner.takeHandoff('msg:C1:5000.000300') }, { handoffMs: 1_000 }, 'a wake over a minute old leads nothing');

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
