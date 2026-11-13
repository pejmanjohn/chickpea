import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { wakeSlackAgentObject } from '../src/agents/turn-input.ts';
import { installationOwnershipOf } from '../src/config/installation-scope.ts';
import { SettingsStoreLogic } from '../src/config/settings-store.ts';
import type { ConfigStoreLogic } from '../src/config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { IdentityStoreLogic } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { admissionStatusPresentation, showAdmissionStatus } from '../src/slack/admission-activity.ts';
import { admissionAgentInstance } from '../src/slack/admission-agent-wake.ts';
import { withAgentAppExecution } from '../src/slack/agent-apps/live.ts';
import { configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import type { SlackCanonicalAdmissionInput, SlackDeliveryNote } from '../src/slack/claim-store.ts';
import { generateCredentialKeyring, workerCredentialKeySlot } from '../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
} from '../src/slack/installation-credentials.ts';
import {
  cacheSlackInstallationExecutionContexts,
  carriedGatewayIdentity,
  effectiveTurnSlackInstallationId,
  resetIdentityVerificationsForTests,
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionContext,
} from '../src/slack/installation-execution.ts';
import { localSlackPresentationStatePort } from '../src/slack/presentation-state-port.ts';
import { receiptRunnerWake } from '../src/slack/receipt-runner-wake.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import type { CredentialKeyring } from '../src/slack/secret-envelope.ts';
import type { ThreadRunnerJob } from '../src/slack/thread-runner-jobs.ts';
import { threadRunnerStub } from '../src/slack/thread-runner-rpc.ts';
import { slackTurnExecutor } from '../src/slack/turn-executor-flag.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { SlackEvent } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { ResidencyHold, storeResidencyHoldMs } from '../src/state/residency-hold.ts';
import { DM, settled, withDirectWorker, WORKER_MENTION } from './helpers/direct-worker.ts';
import { AGENT_MENTION, delivery, message, withLane, type Lane } from './helpers/gateway-admission-lane.ts';

/**
 * On Chickpea Cloud, Slack reaches Core's direct path: the Worker verifies a
 * delivery and admits it over the state store's RPCs. At the receipt it tells
 * the state store (SlackStateStore.noteDelivery, TagStateStore.noteSlackDelivery),
 * which wakes the runner the turn will be handed to, keeps the receipt time for
 * that turn, and verifies the installation's identity ahead of the admission
 * status write, the way the gateway's receipt already does.
 */

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
const moduleStatement = (name: string) => {
  const statement = cloudflare.statements.find((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      declaration.name.getText(cloudflare) === name)));
  assert.ok(statement, `production ${name} exists`);
  return statement.getText(cloudflare);
};
const ReceiptProbe = vm.runInNewContext(
  ts.transpileModule(
    `${['RELAY_BATCH_WINDOW_MS', 'KEEP_WARM_WINDOW_MS', 'KEEP_WARM_TICK_MS', 'localSlackPresentationState'].map(moduleStatement).join('\n')}
class ReceiptProbe { ${[
      'noteSlackDelivery', 'wakeRunnerAtReceipt', 'sendRunnerWake', 'createAlarmIdentityResolver', 'admitSlackTurn', 'afterSlackAdmission', 'admitToRunner',
      'wakeAgentAtHandoff', 'showStatusAtHandoff', 'armAlarmNoLaterThan', 'setAlarmNoLaterThan', 'admissionWakeAt', 'runnerMode', 'keepWarmTickAt', 'hold',
    ].map(stateMethod).join('\n')} }\nReceiptProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  {
    Date,
    Promise,
    ResidencyHold,
    storeResidencyHoldMs,
    emitResidencyHold: () => undefined,
    console: { warn() {} },
    receiptRunnerWake,
    threadRunnerStub,
    slackTurnExecutor: (env: Record<string, unknown>) => slackTurnExecutor(env, {}),
    slackAgentThreadKey: (await import('../src/slack/thread-key.ts')).slackAgentThreadKey,
    installationOwnershipOf,
    effectiveTurnSlackInstallationId,
    carriedGatewayIdentity,
    admissionAgentInstance,
    wakeSlackAgentObject,
    CHICKPEA_SLACK_AGENT_BINDING,
    admissionStatusPresentation,
    showAdmissionStatus,
    localSlackPresentationStatePort,
    resolveSlackInstallationExecutionContext,
    withAgentAppExecution,
    cacheSlackInstallationExecutionContexts,
  },
) as new () => {
  noteSlackDelivery(note: SlackDeliveryNote): Promise<unknown>;
  admitSlackTurn(input: SlackCanonicalAdmissionInput): Promise<{ ok: boolean }>;
  admitToRunner(job: TurnJob | PendingTurnJob, firstHandoff?: boolean): Promise<boolean>;
  createAlarmIdentityResolver(stores: unknown): (workspaceId: string) => Promise<SlackInstallationExecutionContext>;
};

/** A value made in the probe's context, as plain data. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}


/** Settles within a second, or fails: the note never waits for the wake or the identity. */
function promptly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('the note waited')), 1_000).unref()),
  ]);
}

interface Wake { name: string; sentAt: number; turnJobId?: string }

let notes = 0;

/** The Worker's note of a delivery it verified `receivedAt` (its clock), for event `eventId`. */
function note(event: SlackEvent, options: { eventId?: string; receivedAt?: number } = {}): SlackDeliveryNote {
  notes += 1;
  return {
    workspaceId: 'T1', eventId: options.eventId ?? `EvDirect${notes}`, eventTime: 2_000 + notes, event,
    receivedAt: options.receivedAt ?? Date.now(),
  };
}

/** The lane's installation becomes a direct one, as a Chickpea Cloud workspace's is. */
function toDirect(config: ConfigStoreLogic): void {
  config.updateWorkspaceInstallation('T1', { transportMode: 'direct', gatewayBindingId: null });
}

/** A standalone direct installation's encrypted bot credentials, and the keyring that decrypts them. */
async function directCredentials(now: () => number, botToken = 'xoxb-direct-wake'): Promise<{
  identity: IdentityStoreLogic;
  keyring: CredentialKeyring;
  close(): void;
}> {
  const db = openStateDb(':memory:');
  const identity = new IdentityStoreLogic(db, { now });
  const keyring = generateCredentialKeyring('key_v1');
  const dependencies = { state: identity as unknown as IdentityStore, keyring };
  const staged = await stageSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'connected_credentials', expectedActiveRevision: null, appId: 'A1', teamId: 'T1', botUserId: 'UBOT',
    grantedScopes: ['chat:write'], validatedAt: now(),
    secrets: { botToken, signingSecret: 'direct-wake-signing-secret' },
  });
  await promoteSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: staged.revision, expectedActiveRevision: null,
  });
  return { identity, keyring, close: () => db.close() };
}

/**
 * A state store over its own turn rows, the lane's config, and runners that
 * record wakes and admit every hand-off; with `credentials`, the installation's
 * encrypted bot credentials and the keyring its env carries.
 */
function directStore(config: ConfigStoreLogic, options: {
  env?: Record<string, unknown>;
  wake?: () => Promise<void>;
  clock?: { now: number };
  credentials?: { identity: IdentityStoreLogic; keyring: CredentialKeyring };
} = {}) {
  const db = openStateDb(':memory:');
  const clock = options.clock ?? { now: 10_000 };
  const turnJobs = new TurnJobStoreLogic(db, () => clock.now);
  const presentations = new SlackRunPresentationStoreLogic(db);
  const identity = options.credentials?.identity ?? new IdentityStoreLogic(db, { now: () => clock.now });
  const settings = new SettingsStoreLogic(db, () => clock.now);
  const wakes: Wake[] = [];
  const handed: Array<{ name: string; job: ThreadRunnerJob }> = [];
  const namespace = {
    getByName: (name: string) => ({
      wake: (sentAt: number, turnJobId?: string) => {
        wakes.push({ name, sentAt, ...(turnJobId === undefined ? {} : { turnJobId }) });
        return options.wake ? options.wake() : Promise.resolve();
      },
      admit: async (job: ThreadRunnerJob) => {
        handed.push({ name, job: plain(job) });
        return { admitted: true };
      },
    }),
  };
  const keyring = options.credentials?.keyring;
  const env = {
    SLACK_THREAD_RUNNER: namespace,
    ...(keyring ? {
      CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
      [workerCredentialKeySlot(keyring.currentKeyId)]: keyring.keys[keyring.currentKeyId],
    } : {}),
    ...options.env,
  };
  const stores = {
    config,
    turnJobs,
    presentations,
    identity,
    settings,
    objectInventory: { recordAgentInstance() {} },
    slack: {
      admitCanonical: (input: { turnJob: TurnJob }) => {
        turnJobs.enqueue(input.turnJob);
        return { claimed: true, admission: {} };
      },
    },
  };
  const probe = Object.assign(new ReceiptProbe(), {
    env,
    stores,
    firstHandoffs: new Set<string>(),
    call(run: (value: typeof stores) => unknown) {
      try {
        return { ok: true, value: run(stores) };
      } catch {
        return { ok: false, error: { code: 'internal', message: 'failed' } };
      }
    },
    ctx: { storage: { getAlarm: async () => null, setAlarm: async () => undefined } },
  });
  /** The turn row's clocks, as turn_latency reads them. */
  const row = (id: string) => {
    const [found] = db.all('SELECT enqueued_at, received_at FROM turn_jobs WHERE id = ?', id) as
      Array<{ enqueued_at: number; received_at: number }>;
    return found ? { enqueued_at: Number(found.enqueued_at), received_at: Number(found.received_at) } : undefined;
  };
  return { probe, stores, turnJobs, wakes, handed, env, row, close: () => db.close() };
}

/** A turn admitted by production admission for `event`, while the lane's installation is the gateway's. */
async function admittedTurn(lane: Lane, event: SlackEvent): Promise<TurnJob> {
  lane.jobs.length = 0;
  await lane.admit(delivery(event));
  const [job] = lane.jobs;
  assert.ok(job, 'the delivery became a turn');
  return job;
}

const APP_MENTION = {
  type: 'app_mention', channel: 'C1', user: 'U1', ts: '5000.000300', text: '<@UBOT> what changed?',
} as unknown as SlackEvent;

// Defects caught: no wake at the direct path's receipt, a wake keyed apart
// from the hand-off (wrong_key: a fixed owner incarnation, another thread
// coordinate), a job id that is not admission's (wrong_job_id), and a wake
// sent only after the turn is admitted rather than at receipt.
test('a direct delivery that can become a turn wakes, at its receipt, the runner its hand-off then addresses', async () => {
  await withLane(async (lane) => {
    const { config, help } = lane;
    // A thread @help already owns for the second time: its runner is that tenure's.
    config.putAgentThreadRoute({
      workspaceId: 'T1', channelId: 'C1', threadTs: '7000.000100', agentId: help.id,
      agentGeneration: help.configurationGeneration ?? help.revision, ownerIncarnation: 2,
    });
    const cases: Array<[string, SlackEvent]> = [
      ['a mention of an Agent', AGENT_MENTION],
      ['a mention of the app', APP_MENTION],
      ['a reply in the thread it opened', message({ ts: '5000.000200', thread_ts: '5000.000100', text: 'and since Monday?' })],
      ['a DM', message({ channel: 'D1', ts: '6000.000100', text: 'hello' })],
      ['a reply in a thread its owner holds again', message({ ts: '7000.000200', thread_ts: '7000.000100', text: 'go on' })],
    ];
    const jobs = new Map<string, TurnJob>();
    for (const [name, event] of cases) jobs.set(name, await admittedTurn(lane, event));
    toDirect(config);
    for (const [name, event] of cases) {
      const store = directStore(config);
      const job = jobs.get(name)!;
      assert.deepEqual(plain(await store.probe.noteSlackDelivery(note(event, { eventId: job.turn.eventId }))), { ok: true, value: null });
      assert.equal(store.wakes.length, 1, `${name}: one wake at receipt, before admission`);
      assert.equal(store.wakes[0]!.turnJobId, job.id, `${name}: the wake names the turn it becomes`);
      assert.equal(store.handed.length, 0, `${name}: nothing was handed over by the note`);
      assert.equal(await store.probe.admitToRunner(job), true);
      assert.deepEqual(store.handed.map(({ name: runner }) => runner), [store.wakes[0]!.name],
        `${name}: the hand-off addresses the runner the wake reached`);
      store.close();
    }
  });
});

// Defects caught: waking for a gateway installation from the direct path's
// note (wake_on_gateway), for a reaction (wake_on_reaction), an edit, a bot's
// post, an unaddressed Channel message, a reply in a thread no Agent owns, a
// group of people, or when turns do not go to thread runners at all; and a
// gateway installation's note keeping a receipt time.
test('a direct note that cannot become a turn wakes no runner', async () => {
  await withLane(async (lane) => {
    const { config } = lane;
    const job = await admittedTurn(lane, AGENT_MENTION);
    // The installation is still the gateway's: its receipts are the gateway's.
    const gateway = directStore(config);
    assert.deepEqual(plain(await gateway.probe.noteSlackDelivery(note(AGENT_MENTION, { eventId: job.turn.eventId, receivedAt: 1 }))),
      { ok: true, value: null });
    assert.equal(gateway.wakes.length, 0, 'a gateway installation wakes no runner from the direct path');
    gateway.turnJobs.enqueue(job);
    const kept = gateway.row(job.id)!;
    assert.equal(kept.received_at, kept.enqueued_at, 'a gateway installation keeps no receipt time from the direct path');
    gateway.close();

    toDirect(config);
    const wakesFor = async (event: SlackEvent, env?: Record<string, unknown>) => {
      const store = directStore(config, env ? { env } : {});
      assert.deepEqual(plain(await store.probe.noteSlackDelivery(note(event))), { ok: true, value: null });
      store.close();
      return store.wakes.length;
    };
    // The same mention wakes a runner here, so each case below is refused by its own difference.
    assert.equal(await wakesFor(AGENT_MENTION), 1);
    const silent: Array<[string, SlackEvent, Record<string, unknown>?]> = [
      ['an unaddressed Channel message', message({ ts: '8000.000100', text: 'lunch?' })],
      ['a reply in a thread no Agent owns', message({ ts: '8000.000200', thread_ts: '8000.000100', text: 'yes' })],
      ['a mention of a group of people', message({ ts: '8000.000300', text: '<!subteam^SPEOPLE|@people> standup?' })],
      ['a reaction', {
        type: 'reaction_added', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '5000.000100' },
        event_ts: '8000.000400',
      } as SlackEvent],
      ['an edit', {
        type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel',
        message: { type: 'message', user: 'U1', ts: '5000.000100', text: '<@UBOT> what changed today?', edited: { user: 'U1', ts: '8000.000500' } },
        previous_message: { type: 'message', user: 'U1', ts: '5000.000100', text: '<@UBOT> what changed?' },
      } as unknown as SlackEvent],
      ["a bot's post", message({ ts: '8000.000800', text: '<@UBOT> hi', bot_id: 'B1' })],
      ['a mention while turns run on the alarm', AGENT_MENTION, { SLACK_TAG_TURN_EXECUTOR: 'alarm' }],
      ['a mention without a runner binding', AGENT_MENTION, { SLACK_THREAD_RUNNER: undefined }],
    ];
    for (const [name, event, env] of silent) {
      assert.equal(await wakesFor(event, env), 0, `${name} wakes no runner`);
    }
  });
});

// Defects caught: the note keeping no receipt time (receipt_ignored: the turn
// then measures from its enqueue), a receipt later than the enqueue, and a
// note nothing admitted kept past the minute (note_leak).
test("a turn admitted after the note carries the delivery's receipt, and a note nothing admitted is gone within the minute", async () => {
  await withLane(async (lane) => {
    const job = await admittedTurn(lane, AGENT_MENTION);
    toDirect(lane.config);
    const clock = { now: 10_000 };
    const store = directStore(lane.config, { clock });
    await store.probe.noteSlackDelivery(note(AGENT_MENTION, { eventId: job.turn.eventId, receivedAt: 8_200 }));
    assert.equal((await store.probe.admitSlackTurn({ turnJob: job } as unknown as SlackCanonicalAdmissionInput)).ok, true);
    assert.equal(store.handed.length, 1, 'the turn was handed to its runner');
    assert.deepEqual(store.row(job.id), { enqueued_at: 10_000, received_at: 8_200 },
      'the row measures from the receipt the Worker noted, 1.8 s before admission');

    // A delivery noted and never admitted; a minute on, another note is made.
    const leaked = { ...job, id: 'msg:C1:5000.000900', evtKey: 'evt:EvLeak', msgKey: 'msg:C1:5000.000900',
      turn: { ...job.turn, eventId: 'EvLeak', messageTs: '5000.000900' } };
    await store.probe.noteSlackDelivery(note(message({ ts: '5000.000900', text: 'leak?' }), { eventId: 'EvLeak', receivedAt: 10_500 }));
    clock.now = 71_001;
    const later = { ...job, id: 'msg:C1:5000.000910', evtKey: 'evt:EvLater', msgKey: 'msg:C1:5000.000910',
      turn: { ...job.turn, eventId: 'EvLater', messageTs: '5000.000910' } };
    await store.probe.noteSlackDelivery(note(message({ ts: '5000.000910', text: 'later' }), { eventId: 'EvLater', receivedAt: 70_900 }));
    store.turnJobs.enqueue(leaked);
    store.turnJobs.enqueue(later);
    assert.deepEqual(store.row(leaked.id), { enqueued_at: 71_001, received_at: 71_001 }, 'the minute-old note is gone');
    assert.deepEqual(store.row(later.id), { enqueued_at: 71_001, received_at: 70_900 }, 'the fresh note stands');
    store.close();
  });
});

/** Slack's Web API, answering auth.test as `identity` says; every call is listed in `calls`. */
function slackAuthTest(identity: () => Record<string, unknown>) {
  const calls: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const method = new URL(input instanceof Request ? input.url : String(input)).pathname.split('/').at(-1)!;
    calls.push(method);
    return Response.json(method === 'auth.test' ? identity() : { ok: true });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

// Defects caught: the note not verifying the identity (identity_not_seeded:
// the admission status write then pays auth.test inside its cap), a failing
// verification failing the note, the wake, the receipt time or the turn's
// admission (receipt_failure_propagates), and the token or identity logged.
test("the note verifies the installation's identity for the admission status write, and a failure there fails nothing", async (t) => {
  const logged: string[] = [];
  for (const level of ['error', 'warn', 'log'] as const) {
    t.mock.method(console, level, (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); });
  }
  await withLane(async (lane) => {
    const job = await admittedTurn(lane, AGENT_MENTION);
    toDirect(lane.config);
    const clock = { now: 10_000 };
    const credentials = await directCredentials(() => clock.now);
    let identity: Record<string, unknown> = { ok: true, team_id: 'T1', user_id: 'UBOT', app_id: 'A1', bot_id: 'B1', team: 'Team', user: 'chickpea' };
    const slack = slackAuthTest(() => identity);
    try {
      resetIdentityVerificationsForTests();
      invalidateSlackInstallationCredentialCache();
      const store = directStore(lane.config, { clock, credentials });
      assert.deepEqual(plain(await promptly(store.probe.noteSlackDelivery(note(AGENT_MENTION, { eventId: job.turn.eventId })))),
        { ok: true, value: null });
      await settled(() => slack.calls.includes('auth.test'));
      assert.deepEqual(slack.calls, ['auth.test'], 'the receipt verified the identity once');
      // The admission status write resolves the installation as showStatusAtHandoff does.
      const context = await store.probe.createAlarmIdentityResolver(store.stores)('T1');
      assert.equal(context.botUserId, 'UBOT');
      assert.deepEqual(slack.calls, ['auth.test'], 'the status write found the receipt\'s verification: no second auth.test');
      store.close();

      // Slack refuses the token at receipt: the delivery is admitted as before.
      resetIdentityVerificationsForTests();
      identity = { ok: false, error: 'invalid_auth' };
      const refused = directStore(lane.config, { clock, credentials });
      assert.deepEqual(plain(await promptly(refused.probe.noteSlackDelivery(note(AGENT_MENTION, { eventId: job.turn.eventId, receivedAt: 9_000 })))),
        { ok: true, value: null });
      await settled(() => slack.calls.length === 2);
      assert.equal(refused.wakes.length, 1, 'the wake was still sent');
      assert.equal((await refused.probe.admitSlackTurn({ turnJob: job } as unknown as SlackCanonicalAdmissionInput)).ok, true);
      assert.equal(refused.handed.length, 1, 'the turn was still handed to its runner');
      assert.deepEqual(refused.row(job.id), { enqueued_at: 10_000, received_at: 9_000 }, 'with its receipt time');
      await new Promise((resolve) => setImmediate(resolve));
      refused.close();
    } finally {
      slack.restore();
      credentials.close();
      invalidateSlackInstallationCredentialCache();
    }
  });
  assert.deepEqual(logged.filter((line) => /xoxb-|UBOT/.test(line)), [], 'neither the token nor the identity is logged');
});


// Defects caught: no note from the Worker (no_rpc), a note awaited before the
// Worker's own chain, a note sent after a Slack read, a note for a delivery
// Slack did not verify, a note of the wrong delivery, and notes for a
// reaction, App Home, or a gateway installation.
test('on the Cloudflare target the Worker notes a verified message to the state store once, before its first Slack read', async (t) => {
  await withDirectWorker(t, async (worker) => {
    for (const [name, event] of [['a mention of the app', WORKER_MENTION], ['a DM', DM]] as const) {
      worker.log.length = 0;
      worker.notes.length = 0;
      const kept: Array<Promise<unknown>> = [];
      const before = Date.now();
      const payload = worker.event(event);
      const response = await worker.deliver(payload, { waitUntil: (promise) => { kept.push(promise); }, passThroughOnException() {}, props: {} });
      assert.equal(response.status, 200, name);
      await settled(() => worker.log.includes('rpc:admitSlackTurn') || worker.failures.length > 0);
      assert.deepEqual(worker.failures, [], `${name}: the Worker admitted the delivery`);
      assert.equal(worker.notes.length, 1, `${name}: one note`);
      const [sent] = worker.notes;
      assert.deepEqual({ ...sent, receivedAt: undefined }, {
        workspaceId: 'T1', eventId: payload.event_id, eventTime: payload.event_time, event, receivedAt: undefined,
      }, `${name}: the note is the verified delivery`);
      assert.ok(sent!.receivedAt >= before && sent!.receivedAt <= Date.now(), `${name}: received at the Worker's clock`);
      const noted = worker.log.indexOf('rpc:noteSlackDelivery');
      const firstSlack = worker.log.findIndex((entry) => entry.startsWith('slack:'));
      assert.ok(firstSlack > noted, `${name}: the note precedes the first Slack read (${worker.log.join(' ')})`);
      assert.deepEqual([...new Set(worker.log.slice(0, noted))].filter((entry) =>
        !['rpc:identityExecute', 'rpc:configGetWorkspaceInstallation', 'rpc:settingGet', 'rpc:settingGetMany'].includes(entry)), [],
        `${name}: only verification and the installation read precede the note`);
      assert.equal(kept.length > 0, true, `${name}: the note outlives the response (waitUntil)`);
      assert.ok(worker.stores.turnJobs.runnerView(`msg:${event.channel}:${event.ts}`).status !== 'missing',
        `${name}: the turn was admitted`);
    }
    for (const [name, event] of [
      ['a reaction', { type: 'reaction_added', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '5000.000100' }, event_ts: '8000.000400' }],
      ['App Home', { type: 'app_home_opened', user: 'U1', channel: 'DHOME', tab: 'home' }],
    ] as const) {
      worker.notes.length = 0;
      assert.equal((await worker.deliver(worker.event(event))).status, 200, name);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(worker.notes.length, 0, `${name}: no note`);
    }
    worker.stores.config.updateWorkspaceInstallation('T1', { transportMode: 'gateway', gatewayBindingId: 'binding1' });
    worker.notes.length = 0;
    assert.equal((await worker.deliver(worker.event(WORKER_MENTION))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(worker.notes.length, 0, 'a gateway installation gets no note from the direct path');
  });
});

// Defects caught: the receipt clock started inside Core's handler, after the
// host's own work (a health gate, a cold state store), so turn_latency hid it;
// a host time in the future accepted; and the delivery's state store calls
// unlogged, or logged before its admission chain ends.
test("a host's arrival time is a direct delivery's receipt, and the delivery logs its state store calls", async (t) => {
  const summaries: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if ((record as { event?: unknown } | undefined)?.event === 'state_rpc_summary') summaries.push(record as Record<string, unknown>);
  });
  await withDirectWorker(t, async (worker) => {
    const arrivedAt = Date.now() - 1_800;
    assert.equal((await worker.deliver(worker.event(WORKER_MENTION), undefined, arrivedAt)).status, 200);
    await settled(() => summaries.length > 0 || worker.failures.length > 0);
    assert.deepEqual(worker.failures, []);
    assert.equal(worker.notes[0]?.receivedAt, arrivedAt, "the note carries the host's arrival");
    assert.ok(worker.log.includes('rpc:admitSlackTurn'), 'the summary follows admission');
    const [summary] = summaries;
    assert.equal(summary?.scope, 'slack_delivery');
    assert.ok(Number(summary?.receiptToStartMs) >= 1_800, `the wait before Core's handler: ${summary?.receiptToStartMs}`);
    const calls = Number(summary?.calls);
    assert.ok(calls >= 3 && calls <= worker.log.filter((entry) => entry.startsWith('rpc:')).length, `calls: ${calls}`);
    assert.ok(Number(summary?.rounds) >= 1 && Number(summary?.rounds) <= calls);
    assert.match(String(summary?.slowestMethod), /^[a-z][A-Za-z]+$/);

    worker.notes.length = 0;
    const before = Date.now();
    assert.equal((await worker.deliver(worker.event(DM), undefined, Date.now() + 60_000)).status, 200);
    await settled(() => worker.notes.length > 0);
    assert.ok(worker.notes[0]!.receivedAt >= before && worker.notes[0]!.receivedAt <= Date.now(),
      'a host time in the future is not a receipt');
  });
});

// Defects caught: a note awaited on the request path (wake_awaited: a state
// store that never answers or refuses the note then delays or fails the
// delivery's admission), and a rejected note left unhandled.
test('a note the state store never answers or refuses neither delays nor fails the admission', async (t) => {
  for (const [name, answer] of [
    ['never answers', () => new Promise<unknown>(() => undefined)],
    ['refuses', () => Promise.reject(new Error('object unavailable'))],
  ] as const) {
    await withDirectWorker(t, async (worker) => {
      const payload = worker.event(WORKER_MENTION);
      const response = await promptly(worker.deliver(payload));
      assert.equal(response.status, 200, name);
      await settled(() => worker.log.includes('rpc:admitSlackTurn') || worker.failures.length > 0);
      assert.deepEqual(worker.failures, [], `${name}: the Worker admitted the delivery`);
      assert.equal(worker.notes.length, 1, `${name}: the note was sent`);
      assert.ok(worker.stores.turnJobs.runnerView('msg:C1:5000.000100').status !== 'missing', `${name}: the turn was admitted`);
      await new Promise((resolve) => setImmediate(resolve));
    }, { note: answer });
  }
});

// Defect caught: the direct path learning the Agent apps' bots by loading
// every Agent's config (configListAgents) on every delivery.
test("the Worker's direct path reads the Agent apps' bots without loading any Agent's config", async (t) => {
  const calls = async (withAgentApps: boolean) => {
    configureAgentSlackApps(withAgentApps ? {
      requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
      redirectUri: 'https://cloud.test/slack/agent-apps/callback',
      allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
    } : undefined);
    let log: string[] = [];
    try {
      await withDirectWorker(t, async (worker) => {
        assert.equal((await worker.deliver(worker.event(DM))).status, 200);
        await settled(() => worker.log.includes('rpc:admitSlackTurn') || worker.failures.length > 0);
        assert.deepEqual(worker.failures, []);
        log = worker.log.filter((entry) => entry.startsWith('rpc:config'));
      });
    } finally {
      configureAgentSlackApps(undefined);
    }
    const count = (method: string) => log.filter((entry) => entry === `rpc:${method}`).length;
    return { agents: count('configListAgents'), bots: count('configListAgentAppBots') };
  };
  const without = await calls(false);
  const withApps = await calls(true);
  assert.equal(without.bots, 0, 'without the Agent-app port no bot is read');
  assert.deepEqual(withApps, { agents: without.agents, bots: 1 }, 'the port adds one bot read and no Agent list');
});
