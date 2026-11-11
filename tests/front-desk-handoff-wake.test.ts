import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { wakeSlackAgentObject } from '../src/agents/turn-input.ts';
import { processSlackFrontDeskHandoff } from '../src/channels/slack.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { CfTurnJobsForRunner } from '../src/config/cf-state-proxies.ts';
import { installationOwnershipOf } from '../src/config/installation-scope.ts';
import { SettingsStoreLogic } from '../src/config/settings-store.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import type { ConfigStoreLogic } from '../src/config/store.ts';
import { IdentityStoreLogic } from '../src/identity/store.ts';
import { admissionStatusPresentation, showAdmissionStatus } from '../src/slack/admission-activity.ts';
import { admissionAgentInstance } from '../src/slack/admission-agent-wake.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import type { SlackCanonicalAdmissionInput, SlackFrontDeskHandoffNote } from '../src/slack/claim-store.ts';
import {
  frontDeskHandoffRunnerWake,
  frontDeskTakeoverEventId,
  type SlackFrontDeskHandoffRequest,
} from '../src/slack/front-desk.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { carriedGatewayIdentity, effectiveTurnSlackInstallationId } from '../src/slack/installation-execution.ts';
import { localSlackPresentationStatePort } from '../src/slack/presentation-state-port.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import type { RunTurnOptions } from '../src/slack/run-turn.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import type { ThreadRunnerJob, ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { runnerSlackPort } from '../src/slack/thread-runner-loop.ts';
import { threadRunnerStub } from '../src/slack/thread-runner-rpc.ts';
import { executeTurnJob, type TurnExecutionOptions, type TurnExecutionPorts } from '../src/slack/turn-executor.ts';
import { slackTurnExecutor } from '../src/slack/turn-executor-flag.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { ResidencyHold, residencyHoldMs } from '../src/state/residency-hold.ts';
import { delivery, message, withLane, type Lane, type Wake } from './helpers/gateway-admission-lane.ts';

/**
 * A DM the front desk hands to an Agent is two turns: Chickpea's decides and
 * posts its line, then the Agent's takeover answers. The decision is known
 * inside Chickpea's run about two seconds before the takeover is admitted, so
 * the runner tells the state store of it then (SlackStateStore.noteFrontDeskHandoff),
 * and the state store wakes the runner the takeover will be handed to and
 * keeps the decision time as that turn's receipt (TagStateStore.noteFrontDeskHandoff).
 */

// ---------------------------------------------------------------------------
// The runner's capture: the production turn executor over scripted ports.

type RunTurnScript = (options: RunTurnOptions) => Promise<void>;

const DECISION_TS = '1785900000.000100';

function chickpeaJob(): PendingTurnJob {
  return {
    id: `msg:D1:${DECISION_TS}`,
    evtKey: 'evt:Ev1',
    msgKey: `msg:D1:${DECISION_TS}`,
    turn: {
      workspaceId: 'T1', channelId: 'D1', channelType: 'im', eventId: 'Ev1', userId: 'U1',
      text: 'Check order 4821 on the portal.', messageTs: DECISION_TS, threadTs: DECISION_TS,
      source: 'dm_message', contextMode: 'thread',
    },
    assignment: { agentId: CHICKPEA_AGENT_ID, runtimeContract: 'chickpea-v1', ownerIncarnation: 1 },
    executionAuthority: 'legacy',
    attempts: 0,
    progress: {},
    enqueuedAt: 1_785_900_000_000,
    receivedAt: 1_785_899_999_000,
  } as PendingTurnJob;
}

const HANDOFF: SlackFrontDeskHandoffRequest = {
  turn: chickpeaJob().turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_support', agentName: 'Support Desk',
};

/** Ports that record the note and the order of the writes around it; `runTurn` follows the script. */
function executorPorts(script: RunTurnScript, answer?: (note: SlackFrontDeskHandoffNote) => Promise<void>) {
  const calls: string[] = [];
  const notes: SlackFrontDeskHandoffNote[] = [];
  const ports = {
    env: {},
    turnJobs: {
      recordAttempt() {},
      markRecoveryRequired() {},
      markDelivered: () => { calls.push('markDelivered'); return []; },
      markError() {},
      recordInteractionIntent() {},
    },
    slack: {
      setActiveWork() {},
      release() {},
      noteFrontDeskHandoff: (note: SlackFrontDeskHandoffNote) => {
        notes.push(note);
        calls.push('noteFrontDeskHandoff');
        return answer ? answer(note) : Promise.resolve();
      },
    },
    config: {},
    presentationState: { getRunPresentation: async () => undefined },
    settingsStore: { getSetting: async () => undefined },
    usageStore: {},
    workStore: {},
    appStores: {},
    managementApproval: () => ({}),
    telemetry: { capture() {} },
    resolveInstallation: async () => ({ workspaceId: 'T1', client: {} }),
    sandboxes: () => [],
    dispatchFrontDeskHandoff: async (request: SlackFrontDeskHandoffRequest) => {
      calls.push(`dispatchFrontDeskHandoff(${request.agentId})`);
    },
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
      await script(options);
    },
  } as unknown as TurnExecutionPorts;
  const options: TurnExecutionOptions = { latency: { lane: 'cloudflare', executor: 'runner' }, onRetry() {} };
  return { ports, options, calls, notes };
}

/** Settles within a second, or fails: the run never waits for the note. */
function promptly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('the run waited for the note')), 1_000).unref()),
  ]);
}

// Defects caught: no note (no_rpc), a note sent at delivery or at the dispatch
// rather than inside the capture, a second note, a note naming another message
// or Agent, and a note on a reply that handed nothing over (rpc_on_card: a
// card's decision never reaches the executor, so only the capture may note).
test('a hand-off decision tells the state store once, inside the capture, before the line is settled and the takeover admitted', async () => {
  const before = Date.now();
  let notesAtDecision: number | undefined;
  const h = executorPorts(async (options) => {
    options.onFrontDeskHandoff?.(HANDOFF);
    notesAtDecision = h.notes.length;
    await options.onDelivered?.('succeeded');
  });
  assert.equal(await executeTurnJob(chickpeaJob(), h.ports, h.options), true);
  assert.equal(notesAtDecision, 1, 'the note is sent inside the capture, not later');
  assert.deepEqual(h.calls, ['noteFrontDeskHandoff', 'markDelivered', 'dispatchFrontDeskHandoff(agent_support)']);
  const [note] = h.notes;
  assert.ok(note);
  const { decidedAt, ...where } = note;
  assert.deepEqual(where, { workspaceId: 'T1', channelId: 'D1', threadTs: DECISION_TS, messageTs: DECISION_TS, agentId: 'agent_support' });
  assert.ok(decidedAt >= before && decidedAt <= Date.now(), "the runner's clock at the decision");

  const plainReply = executorPorts(async (options) => { await options.onDelivered?.('succeeded'); });
  assert.equal(await executeTurnJob(chickpeaJob(), plainReply.ports, plainReply.options), true);
  assert.deepEqual(plainReply.notes, [], 'a reply that handed nothing over notes nothing');
});

// Defects caught: awaiting the note (wake_awaited: a store that never answers
// would hang the run), a refused or thrown note failing the run or skipping
// the takeover's dispatch, and a refused note left as an unhandled rejection.
test('a note the state store refuses, never answers, or cannot take neither delays nor fails the run or the hand-off', async () => {
  const cases: Array<[string, (note: SlackFrontDeskHandoffNote) => Promise<void>]> = [
    ['refused', () => Promise.reject(new Error('state store unavailable'))],
    ['never answered', () => new Promise<void>(() => undefined)],
    ['thrown', () => { throw new Error('stub replaced'); }],
  ];
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  try {
    for (const [name, answer] of cases) {
      const h = executorPorts(async (options) => {
        options.onFrontDeskHandoff?.(HANDOFF);
        await options.onDelivered?.('succeeded');
      }, answer);
      assert.equal(await promptly(executeTurnJob(chickpeaJob(), h.ports, h.options)), true, name);
      assert.deepEqual(h.calls, ['noteFrontDeskHandoff', 'markDelivered', 'dispatchFrontDeskHandoff(agent_support)'], name);
    }
    // The refused note settles after the run returned: its rejection is the capture's to take.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, [], 'a refused note is taken where it was sent');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

// Defects caught: a runner port that drops the note (no_rpc on Cloudflare), one
// that replays it, and a port offering the note where the store has none.
test("the runner's slack port carries the note to the state store's RPC once; a store without the note offers none", async () => {
  const sent: SlackFrontDeskHandoffNote[] = [];
  const stub = {
    noteFrontDeskHandoff: async (note: SlackFrontDeskHandoffNote) => { sent.push(note); return { ok: true, value: null }; },
  } as unknown as TagStateRpc;
  const rows = new CfTurnJobsForRunner(() => stub);
  const jobs = { owesActiveClear() {} } as unknown as ThreadRunnerJobStore;
  const remote = {
    setActiveWork: async () => undefined,
    markCodingActiveWork: async () => undefined,
    isCodingActiveWork: async () => false,
    release: async () => undefined,
  };
  const note: SlackFrontDeskHandoffNote = {
    workspaceId: 'T1', channelId: 'D1', threadTs: DECISION_TS, messageTs: DECISION_TS, agentId: 'agent_support', decidedAt: 1_000,
  };
  const port = runnerSlackPort({ ...remote, noteFrontDeskHandoff: (received) => rows.noteFrontDeskHandoff(received) }, jobs);
  await port.noteFrontDeskHandoff!(note);
  assert.deepEqual(sent, [note]);
  assert.equal(runnerSlackPort(remote, jobs).noteFrontDeskHandoff, undefined);
});

// ---------------------------------------------------------------------------
// The state store: the production note and hand-off methods over real rows.

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
const HandoffProbe = vm.runInNewContext(
  ts.transpileModule(
    `${['RELAY_BATCH_WINDOW_MS', 'KEEP_WARM_WINDOW_MS', 'KEEP_WARM_TICK_MS', 'localSlackPresentationState'].map(moduleStatement).join('\n')}
class HandoffProbe { ${[
      'noteFrontDeskHandoff', 'sendRunnerWake', 'admitSlackTurn', 'afterSlackAdmission', 'admitToRunner', 'wakeAgentAtHandoff',
      'showStatusAtHandoff', 'armAlarmNoLaterThan', 'setAlarmNoLaterThan', 'admissionWakeAt', 'runnerMode', 'keepWarmTickAt', 'hold',
    ].map(stateMethod).join('\n')} }\nHandoffProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  {
    Date,
    Promise,
    ResidencyHold,
    residencyHoldMs,
    console: { warn() {} },
    frontDeskHandoffRunnerWake,
    threadRunnerStub,
    slackTurnExecutor: (env: Record<string, unknown>) => slackTurnExecutor(env, {}),
    slackAgentThreadKey,
    installationOwnershipOf,
    effectiveTurnSlackInstallationId,
    carriedGatewayIdentity,
    admissionAgentInstance,
    wakeSlackAgentObject,
    CHICKPEA_SLACK_AGENT_BINDING,
    admissionStatusPresentation,
    showAdmissionStatus,
    localSlackPresentationStatePort,
  },
) as new () => {
  noteFrontDeskHandoff(note: SlackFrontDeskHandoffNote): Promise<unknown>;
  admitSlackTurn(input: SlackCanonicalAdmissionInput): Promise<{ ok: boolean }>;
  admitToRunner(job: TurnJob | PendingTurnJob, firstHandoff?: boolean): Promise<boolean>;
};

/** A value made in the probe's context, as plain data. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * A state store over its own turn rows and the lane's config, with runners
 * that record wakes and admit every hand-off.
 */
function handoffStore(config: ConfigStoreLogic, options: {
  env?: Record<string, unknown>;
  clock?: { now: number };
} = {}) {
  const db = openStateDb(':memory:');
  const clock = options.clock ?? { now: 10_000 };
  const turnJobs = new TurnJobStoreLogic(db, () => clock.now);
  const presentations = new SlackRunPresentationStoreLogic(db);
  const identity = new IdentityStoreLogic(db, { now: () => clock.now });
  const settings = new SettingsStoreLogic(db, () => clock.now);
  const wakes: Wake[] = [];
  const handed: Array<{ name: string; job: ThreadRunnerJob }> = [];
  const namespace = {
    getByName: (name: string) => ({
      wake: async (sentAt: number, turnJobId?: string) => {
        wakes.push({ name, sentAt, ...(turnJobId === undefined ? {} : { turnJobId }) });
      },
      admit: async (job: ThreadRunnerJob) => {
        handed.push({ name, job: plain(job) });
        return { admitted: true };
      },
    }),
  };
  const env = { SLACK_THREAD_RUNNER: namespace, ...options.env };
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
  const probe = Object.assign(new HandoffProbe(), {
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
  return { probe, turnJobs, wakes, handed, row, close: () => db.close() };
}

/** Slack's record of a conversation as the transport's mapper requires it: the lane's public Channel, or a DM with U1. */
function conversation(id: string) {
  return id.startsWith('D')
    ? { id, is_im: true, user: 'U1', is_private: true, is_member: true, is_archived: false }
    : { id, name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false };
}

/** The lane's gateway as the takeover's admission reaches it: a DM with U1, answered from a table. */
function takeoverGateway(): GatewayDeploymentClient {
  return {
    workspaceId: 'T1',
    async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
    async call(operation: string, args: Record<string, unknown>) {
      if (operation === 'users.info') {
        return { user: {
          id: args.user, team_id: 'T1', name: String(args.user), deleted: false, is_bot: false, is_app_user: false,
          is_restricted: false, is_ultra_restricted: false, is_stranger: false,
        } };
      }
      if (operation === 'conversations.info') return { channel: conversation(String(args.channel)) };
      if (operation === 'conversations.members') return { members: ['U1', 'UBOT'] };
      if (operation === 'users.conversations') return { channels: [conversation('C1')] };
      if (operation === 'chat.postMessage') return { ok: true, ts: '9000.000002', channel: args.channel };
      if (operation === 'reactions.add') return { ok: true };
      throw new Error(`Unexpected gateway operation: ${operation}`);
    },
  } as unknown as GatewayDeploymentClient;
}

/** Chickpea's root DM turn on `ts`, admitted by production admission; the thread's route is then Chickpea's. */
async function chickpeaRootDm(lane: Lane, ts: string): Promise<TurnJob> {
  lane.jobs.length = 0;
  await lane.admit(delivery(message({ channel: 'D1', ts, text: 'Check order 4821 on the portal.' })));
  const [job] = lane.jobs;
  assert.ok(job, 'the DM became a turn');
  assert.equal(job.assignment.agentId, CHICKPEA_AGENT_ID);
  const route = lane.config.getAgentThreadRoute('T1', 'D1', ts);
  assert.deepEqual([route?.agentId, route?.ownerIncarnation], [CHICKPEA_AGENT_ID, 1], "the thread is Chickpea's");
  return job;
}

/** The takeover `processSlackFrontDeskHandoff` admits for a delivered hand-off, over the lane's stores. */
async function admittedTakeover(lane: Lane, request: SlackFrontDeskHandoffRequest): Promise<TurnJob[]> {
  const jobs: TurnJob[] = [];
  await processSlackFrontDeskHandoff(request, undefined, {
    stores: lane.stores,
    gatewayClient: takeoverGateway(),
    enqueueTurn: async (job) => { jobs.push(job); return { ok: true as const, value: null }; },
  });
  return jobs;
}

const ROOT = '7100.000100';

function noteOf(threadTs: string, agentId: string, decidedAt = 8_200): SlackFrontDeskHandoffNote {
  return { workspaceId: 'T1', channelId: 'D1', threadTs, messageTs: threadTs, agentId, decidedAt };
}

// Defects caught: no wake at the decision, a wake keyed with the route's own
// incarnation or a fixed one rather than the takeover's (wrong_key), a job id
// that is not the takeover's (wrong_job_id), a wake sent only once the
// takeover is admitted, and a receipt the takeover's row ignores
// (receipt_ignored: it then measures from its enqueue).
test("a hand-off decision wakes, at the decision, the runner the takeover's admission then addresses, with the decision as its receipt", async () => {
  await withLane(async (lane) => {
    const chickpea = await chickpeaRootDm(lane, ROOT);
    const store = handoffStore(lane.config, { clock: { now: 10_000 } });
    const note = noteOf(ROOT, lane.help.id);
    assert.deepEqual(plain(await store.probe.noteFrontDeskHandoff(note)), { ok: true, value: null });
    assert.equal(store.wakes.length, 1, 'one wake at the decision, before the takeover exists');
    const [wake] = store.wakes;
    assert.ok(wake);
    assert.equal(wake.turnJobId, `msg:D1:${ROOT}:handoff`, 'the wake names the takeover turn');
    assert.equal(wake.name, slackAgentThreadKey({ workspaceId: 'T1', channelId: 'D1', threadTs: ROOT },
      { runtimeContract: 'chickpea-v1', ownerIncarnation: 2 }), "the runner is the thread's next owner incarnation");
    assert.equal(store.handed.length, 0, 'the note hands nothing over');

    // The takeover, admitted by production admission as the executor admits it once the line is settled.
    const [takeover, ...others] = await admittedTakeover(lane, {
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: lane.help.id, agentName: 'Support',
    });
    assert.ok(takeover, 'the takeover was admitted');
    assert.deepEqual(others, []);
    assert.equal(takeover.id, wake.turnJobId, 'the takeover is the turn the wake named');
    assert.equal(takeover.turn.eventId, frontDeskTakeoverEventId('D1', ROOT));
    assert.equal(takeover.assignment.agentId, lane.help.id);
    assert.equal(takeover.assignment.ownerIncarnation, 2);
    assert.equal(slackAgentThreadKey(takeover.turn, takeover.assignment), wake.name, 'admission keys the same runner');

    // Handed over by the state store: to the runner the wake reached, with a row that measures from the decision.
    assert.equal((await store.probe.admitSlackTurn({ turnJob: takeover } as unknown as SlackCanonicalAdmissionInput)).ok, true);
    assert.deepEqual(store.handed.map(({ name }) => name), [wake.name], 'the hand-off addresses the runner the wake reached');
    assert.deepEqual(store.row(takeover.id), { enqueued_at: 10_000, received_at: 8_200 },
      'the takeover measures from the decision, 1.8 s before its admission');
    store.close();
  });
});

// Defects caught: waking for a thread the Agent already owns (wake_on_owner:
// the hand-off was made before), for one Chickpea never took, when turns run
// on the alarm or no runner binding exists, on a revoked installation, or on
// one that is not chickpea-v1; and keeping a receipt for a refused note.
test('a decision admission would hand nothing over on wakes no runner and keeps no receipt', async () => {
  await withLane(async (lane) => {
    const chickpea = await chickpeaRootDm(lane, ROOT);
    const wakesFor = async (note: SlackFrontDeskHandoffNote, env?: Record<string, unknown>) => {
      const store = handoffStore(lane.config, env ? { env } : {});
      assert.deepEqual(plain(await store.probe.noteFrontDeskHandoff(note)), { ok: true, value: null });
      store.close();
      return store.wakes.length;
    };
    const note = noteOf(ROOT, lane.help.id);
    // The same decision wakes a runner here, so each case below is refused by its own difference.
    assert.equal(await wakesFor(note), 1);
    assert.equal(await wakesFor(noteOf('7100.000900', lane.help.id)), 0, 'a thread Chickpea never took wakes no runner');
    assert.equal(await wakesFor(note, { SLACK_TAG_TURN_EXECUTOR: 'alarm' }), 0, 'a decision while turns run on the alarm wakes no runner');
    assert.equal(await wakesFor(note, { SLACK_THREAD_RUNNER: undefined }), 0, 'a decision without a runner binding wakes no runner');

    const [takeover] = await admittedTakeover(lane, {
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: lane.help.id, agentName: 'Support',
    });
    assert.ok(takeover);
    assert.equal(lane.config.getAgentThreadRoute('T1', 'D1', ROOT)?.agentId, lane.help.id, 'the thread is the Agent\'s now');
    const owned = handoffStore(lane.config, { clock: { now: 10_000 } });
    assert.deepEqual(plain(await owned.probe.noteFrontDeskHandoff(note)), { ok: true, value: null });
    assert.equal(owned.wakes.length, 0, "a route already the Agent's wakes no runner: its hand-off was made before");
    owned.turnJobs.enqueue(takeover);
    assert.deepEqual(owned.row(takeover.id), { enqueued_at: 10_000, received_at: 10_000 }, 'a refused note keeps no receipt');
    owned.close();

    // Another root DM Chickpea holds, so the installation's state is each case's only difference.
    const second = '7200.000100';
    await chickpeaRootDm(lane, second);
    const again = noteOf(second, lane.help.id);
    assert.equal(await wakesFor(again), 1);
    lane.config.updateWorkspaceInstallation('T1', { health: 'revoked' });
    assert.equal(await wakesFor(again), 0, 'a revoked installation wakes no runner');
    lane.config.updateWorkspaceInstallation('T1', { health: 'healthy' });
    lane.config.updateWorkspaceInstallation('T1', { runtimeContract: 'legacy' });
    assert.equal(await wakesFor(again), 0, 'an installation that is not chickpea-v1 wakes no runner');
    lane.config.updateWorkspaceInstallation('T1', { runtimeContract: 'chickpea-v1' });
    assert.equal(await wakesFor(again), 1, 'restored, the same decision wakes a runner again');
  });
});
