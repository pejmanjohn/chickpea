import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { activityStatus } from '../src/activity/status.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { closeNodeStateStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  SqliteSlackStateStore,
  slackSessionGenerationFromTimestamp,
  type SlackCanonicalAdmissionInput,
  type SlackStateStore,
} from '../src/slack/claim-store.ts';
import { AgentPromptFailure, type SlackThreadAgentTarget } from '../src/slack/flue-dispatch.ts';
import { wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { defaultSlackStatusRegistry } from '../src/slack/status-registry.ts';
import { readSteeringRunFacts, slackCheckInReply } from '../src/slack/steering-replies.ts';
import type { TurnJob, TurnSteeringRequest } from '../src/slack/turn-job-types.ts';
import { MAX_POST_DISPATCH_ATTEMPTS, turnStopThreadKey } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import {
  DURABLE_RECOVERY_FAILURE_TEXT,
  STOP_ALREADY_FINISHED_TEXT,
  slackStopNoteText,
  type SlackStopNoteFacts,
} from '../src/slack/web-client-presenter.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

/**
 * Node parity for stopping (U9, R24, KTD16): the Node relay has no runner
 * Durable Object, so it delivers the stop outbox itself with an in-process
 * Flue abort, and its own copy of the executor takes the stopped ending. The
 * observable outcomes mirror the Cloudflare executor's stop tests
 * (tests/run-turn-stopped.test.ts, tests/slack-turn-stop-record.test.ts).
 */

const STOPPER = 'U_STOPPER';
const UID = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BOT = 'U_CHICKPEA';

const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-node-stop-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  // A turn that runs for real reads its Agent and installation from here.
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const config = new SqliteConfigStore(statePath, { agents: [] });
  const assignment = nodeAssignment();
  await config.createAgent(assignment.agent);
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: BOT,
  });
  await config.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  config.close();
});

after(() => {
  closeNodeStateStores();
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

function nodeAssignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_NODE', channelId: 'C_NODE', agentId: 'agent_node', model: 'local-stub/node',
    modelAttribution: { source: 'pinned', providerId: 'local-stub' },
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_node', kind: 'user', revision: 1, name: 'Node', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
}

/** One Slack thread per test: the relay's per-thread loops are process-wide. */
function slackThread(rootTs: string) {
  const [seconds] = rootTs.split('.');
  const ts = (suffix: string) => `${seconds}.000${suffix}`;
  const turn = (messageTs: string, text = 'Do the work'): NormalizedSlackTurn => ({
    workspaceId: 'T_NODE', channelId: 'C_NODE', eventId: `Ev_${messageTs}`,
    text, userId: 'U_MEMBER', messageTs, threadTs: rootTs,
    source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  });
  const job = (id: string, suffix: string, text?: string): TurnJob => ({
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`,
    turn: turn(ts(suffix), text), assignment: nodeAssignment(),
  });
  const threadKey = turnStopThreadKey(turn(rootTs), nodeAssignment());
  const stop = (suffix: string): Extract<TurnSteeringRequest, { kind: 'stop' }> => ({
    kind: 'stop', threadKey, source: 'typed', stopperUserId: STOPPER, cutoffTs: ts(suffix),
  });
  return { rootTs, ts, job, threadKey, stop };
}

type SlackThread = ReturnType<typeof slackThread>;

/**
 * Admit a message as Node's Slack admission does (the canonical lane): its
 * claims, Work Run, TurnJob and presentation in one transaction, with the
 * typed stop or check-in it carries, or its mid-run 👀 receipt.
 */
async function admit(
  state: SlackStateStore,
  thread: SlackThread,
  queued: TurnJob,
  extra: { steering?: SlackCanonicalAdmissionInput['steering']; midRun?: boolean } = {},
) {
  const admission = prepareSlackShadowAdmission({
    turn: queued.turn, assignment: queued.assignment, sourceVisibility: 'public', admittedAt: Date.now(),
  });
  const sessionGeneration = slackSessionGenerationFromTimestamp(queued.turn.messageTs);
  return state.admitCanonical({
    evtKey: queued.evtKey,
    msgKey: queued.msgKey,
    threadKey: `thread:${thread.rootTs}`,
    admission,
    turnJob: { ...queued, runId: admission.run.id, executionAuthority: admission.run.executionAuthority },
    ...(extra.steering ? { steering: extra.steering } : {}),
    ...(extra.midRun
      ? {
          midRun: {
            threadKey: thread.threadKey,
            receipt: { channelId: 'C_NODE', messageTs: queued.turn.messageTs, name: 'eyes' },
          },
        }
      : {}),
    presentation: {
      schemaVersion: 3,
      root: { workspaceId: 'T_NODE', channelId: 'C_NODE', threadTs: thread.rootTs, requesterUserId: 'U_MEMBER' },
      owner: { kind: 'chickpea' },
      sessionGeneration,
    },
  });
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function platformError(error: string) {
  return { code: ErrorCode.PlatformError, data: { ok: false, error } };
}

type Script = (options: RunTurnOptions, turn: NormalizedSlackTurn) => Promise<void>;

/**
 * The real Node SQLite state store behind the real relay, with Slack, the
 * Flue abort and `runTurn` replaced: a script per turn stands in for the run
 * (as the Cloudflare executor tests script it), and any other turn delivers
 * at once, or runs the real `runTurn` replaying a fixed answer.
 */
function relayHarness(input: {
  realRunTurn?: boolean;
  /** The in-process abort takes effect only once this resolves. */
  abortLands?: () => Promise<void>;
} = {}) {
  const state = new SqliteSlackStateStore(':memory:');
  const work = new SqliteWorkStore(':memory:');
  const calls: string[] = [];
  const tracedMethods = new Set(['finishTurnStop', 'markTurnDelivered', 'markTurnError', 'discardTurn', 'release']);
  const traced = new Proxy(state as SlackStateStore, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function' || !tracedMethods.has(String(key))) return value;
      return (...args: unknown[]) => {
        calls.push(`${String(key)}(${String(args[0])})`);
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const posts: Array<Record<string, unknown>> = [];
  const ephemerals: Array<Record<string, unknown>> = [];
  const reactions: string[] = [];
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }), setTitle: async () => ({ ok: true }) } },
    conversations: {
      info: async () => ({ ok: true, channel: { id: 'C_NODE', is_member: true } }),
      history: async () => ({ ok: true, messages: [] }),
      replies: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      postMessage: async (value: Record<string, unknown>) => {
        posts.push(value);
        return { ok: true, channel: 'C_NODE', ts: `1800009999.${String(posts.length).padStart(6, '0')}` };
      },
      postEphemeral: async (value: Record<string, unknown>) => {
        ephemerals.push(value);
        return { ok: true, message_ts: '1800009998.000001' };
      },
      update: async () => ({ ok: true }),
      startStream: async () => ({ ok: true, ts: '1800009997.000001' }),
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
    },
    reactions: {
      add: async (value: Record<string, unknown>) => {
        const key = `${String(value.timestamp)}:${String(value.name)}`;
        reactions.push(`add ${key}`);
        return { ok: true };
      },
      remove: async (value: Record<string, unknown>) => {
        const key = `${String(value.timestamp)}:${String(value.name)}`;
        reactions.push(`remove ${key}`);
        if (!reactions.includes(`shown ${key}`)) throw platformError('no_reaction');
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const scripts = new Map<string, Script>();
  const runs: string[] = [];
  const aborts: SlackThreadAgentTarget[] = [];
  const abortWaiters: Array<{ count: number; done: Deferred }> = [];
  const telemetry: Array<Record<string, unknown>> = [];
  const executeTurn = async (
    turn: NormalizedSlackTurn,
    assignment: ResolvedAssignment,
    _env: unknown,
    options: RunTurnOptions,
  ) => {
    runs.push(options.turnId!);
    const script = scripts.get(options.turnId!);
    if (script) return script(options, turn);
    if (input.realRunTurn) {
      return runTurn(turn, assignment, undefined, {
        ...options,
        replayText: 'Checked the nightly job too.',
        usageRecordingEnabled: false,
      });
    }
    await options.onDelivered?.('succeeded');
  };
  const overrides = {
    state: traced,
    work,
    client,
    executeTurn: executeTurn as never,
    abortAgent: async (target: SlackThreadAgentTarget) => {
      aborts.push(target);
      for (const waiter of abortWaiters) if (aborts.length >= waiter.count) waiter.done.resolve();
      await input.abortLands?.();
    },
    productTelemetry: { capture: (event: Record<string, unknown>) => { telemetry.push(event); } },
  };
  return {
    state,
    calls,
    posts,
    ephemerals,
    reactions,
    /** Admission added Chickpea's 👀 to this message. */
    shown(ts: string) { reactions.push(`shown ${ts}:eyes`); },
    scripts,
    runs,
    aborts,
    /** Resolves once the relay has sent `count` in-process aborts. */
    abortsReach(count: number): Promise<void> {
      const done = deferred();
      if (aborts.length >= count) done.resolve();
      else abortWaiters.push({ count, done });
      return done.promise;
    },
    telemetry,
    wake: () => wakeNodeTurnRelay(undefined, overrides as never),
    close() {
      state.close();
      work.close();
    },
  };
}

type RelayHarness = ReturnType<typeof relayHarness>;

/** Freeze, prepare and admit the turn's Flue dispatch, as `runTurn` does; the instance id. */
async function dispatchRun(options: RunTurnOptions, turn: NormalizedSlackTurn): Promise<string> {
  await options.onRuntimePlan!(compileRuntimePlanV2({
    turn, assignment: nodeAssignment(), instructions: 'Help.', memoryEpoch: 1,
  }));
  const envelope = await options.flueDispatch!.prepare('Do the work', { generation: options.turnId! });
  await options.flueDispatch!.recordReceipt({
    submissionId: `sub_${options.turnId}`, acceptedAt: new Date().toISOString(), uid: UID,
  });
  return envelope.instanceId;
}

/** What `runTurn` does with an aborted settlement: the stopped ending and its note. */
async function endStopped(options: RunTurnOptions, rootTs: string): Promise<SlackStopNoteFacts> {
  const facts = await options.stopEnding!.finish();
  assert.ok(facts, 'a stopped run ends with its stop note');
  await options.client!.chat.postMessage({ channel: 'C_NODE', thread_ts: rootTs, text: slackStopNoteText(facts) });
  await options.onDelivered?.('stopped');
  return facts;
}

const ABORTED = () => ({ outcome: 'aborted' as const, settledAt: Date.now(), failureKind: 'agent' as const });
const COMPLETED = () => ({
  outcome: 'completed' as const, settledAt: Date.now(),
  result: {
    text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null,
    usageCompleteness: 'not_reported' as const,
  },
});

async function statusOf(h: RelayHarness, id: string) {
  return (await h.state.turnJobView!(id)).status;
}

/** Admit the run and two messages posted to it before the stop, each with Chickpea's 👀. */
async function busyThread(h: RelayHarness, thread: SlackThread, prefix: string) {
  const head = thread.job(`${prefix}_head`, '101');
  assert.equal((await admit(h.state, thread, head)).claimed, true);
  for (const [id, suffix] of [[`${prefix}_unread_1`, '102'], [`${prefix}_unread_2`, '103']] as const) {
    const admitted = await admit(h.state, thread, thread.job(id, suffix), { midRun: true });
    assert.equal(admitted.claimed && 'admission' in admitted && admitted.midRunReceipt, true);
    h.shown(thread.ts(suffix));
  }
  return head;
}

// ── the stop ───────────────────────────────────────────────────────────

test('covers AE3 on Node: a typed stop aborts the in-process run, drops the unread messages and posts the stop note', async () => {
  const h = relayHarness();
  const thread = slackThread('1800000100.000100');
  try {
    const head = await busyThread(h, thread, 'n1');
    const running = deferred();
    let instanceId: string | undefined;
    let facts: SlackStopNoteFacts | undefined;
    h.scripts.set(head.id, async (options, turn) => {
      instanceId = await dispatchRun(options, turn);
      running.resolve();
      // Flue settles the submission aborted once the relay's abort lands.
      await h.abortsReach(1);
      await options.flueDispatch!.recordSettlement(ABORTED());
      facts = await endStopped(options, thread.rootTs);
    });
    const headWake = h.wake();
    await running.promise;

    // The typed stop, as admission records it: never a queued turn.
    const decision = await admit(h.state, thread, thread.job('n1_stop', '110', 'stop'), {
      steering: thread.stop('110'),
    });
    assert.equal(decision.claimed && 'steered' in decision && decision.steered.outcome, 'stopped');
    // Admission wakes the relay after a created stop; the stop outbox pass
    // never waits on the thread's busy loop.
    await h.wake();
    await headWake;

    assert.deepEqual(h.aborts, [{ instanceId, uid: UID }], 'aborted in process from the persisted envelope');
    assert.deepEqual(h.runs, [head.id], 'the dropped messages never ran');
    assert.deepEqual(facts, { stopperUserId: STOPPER, unread: 2, pullRequests: [], windingDown: false });
    assert.equal(h.posts.length, 1);
    assert.match(String(h.posts[0]?.text), /^Stopped by <@U_STOPPER>\./);
    assert.match(String(h.posts[0]?.text), /2 messages were not read and can be sent again\./);
    assert.deepEqual(h.ephemerals, [], 'no private note: the stop stopped the run');
    for (const id of [head.id, 'n1_unread_1', 'n1_unread_2']) {
      assert.equal(await statusOf(h, id), 'done', `${id} is settled`);
    }
    const finish = h.calls.indexOf(`finishTurnStop(${head.id})`);
    const delivered = h.calls.indexOf(`markTurnDelivered(${head.id})`);
    assert.ok(finish >= 0 && delivered > finish, `the ending precedes the tombstone: ${h.calls.join(' ')}`);
    assert.equal(h.calls.some((call) => call.startsWith('release(')), false, 'claims stay held');
    assert.deepEqual(h.telemetry.map((event) => event.outcome), ['stopped']);
    assert.equal(await h.state.deliverStopNotices!(async () => assert.fail('no stop notice is owed')), undefined);
  } finally { h.close(); }
});

test('covers AE3 and R12 on Node: the stop removes the 👀 of each message it dropped and finishes its receipt', async () => {
  const h = relayHarness();
  const thread = slackThread('1800000200.000100');
  try {
    const head = await busyThread(h, thread, 'n2');
    h.scripts.set(head.id, async (options, turn) => {
      await dispatchRun(options, turn);
      await h.state.steerTurn!(thread.stop('110'));
      await h.wake();
      await options.flueDispatch!.recordSettlement(ABORTED());
      await endStopped(options, thread.rootTs);
    });
    await h.wake();

    assert.deepEqual(h.reactions.filter((entry) => entry.startsWith('remove')), [
      `remove ${thread.ts('102')}:eyes`,
      `remove ${thread.ts('103')}:eyes`,
    ]);
    assert.deepEqual(await h.state.listPendingSlackInteractionCleanups!(), [],
      'each dropped message\'s receipt is finished, none left to the repair sweep');
  } finally { h.close(); }
});

test('a stopped row that never dispatched takes the stopped ending at once, with no abort, counting itself as unread', async () => {
  const h = relayHarness();
  const thread = slackThread('1800000300.000100');
  try {
    const head = await busyThread(h, thread, 'n3');
    const stopped = await h.state.steerTurn!(thread.stop('110'));
    assert.equal(stopped.outcome, 'stopped');
    let facts: SlackStopNoteFacts | undefined;
    h.scripts.set(head.id, async (options) => {
      assert.equal(options.stopEnding?.beforeDispatch, true, 'the ending runs now, with no dispatch');
      facts = await endStopped(options, thread.rootTs);
    });
    await h.wake();

    assert.deepEqual(h.aborts, [], 'nothing was dispatched, so nothing is aborted');
    assert.deepEqual(h.runs, [head.id]);
    assert.equal(facts?.unread, 3, 'the undispatched head and the two held messages were never read');
    for (const id of [head.id, 'n3_unread_1', 'n3_unread_2']) assert.equal(await statusOf(h, id), 'done');
    assert.equal(await h.state.deliverStopNotices!(async () => assert.fail('no stop notice is owed')), undefined);
  } finally { h.close(); }
});

test('covers AE9 on Node: a run that finished before the abort posts its answer, tells the stopper privately and runs the held messages', async () => {
  const h = relayHarness();
  const thread = slackThread('1800000400.000100');
  try {
    const head = await busyThread(h, thread, 'n4');
    const settled = deferred();
    const deliver = deferred();
    h.scripts.set(head.id, async (options, turn) => {
      await dispatchRun(options, turn);
      // The run finished; its answer is still being delivered.
      await options.flueDispatch!.recordSettlement(COMPLETED());
      settled.resolve();
      await deliver.promise;
      await options.onDelivered?.('succeeded');
    });
    const headWake = h.wake();
    await settled.promise;
    const decision = await h.state.steerTurn!(thread.stop('110'));
    assert.equal(decision.outcome === 'stopped' && decision.stop.held, 2);
    await h.wake();
    assert.deepEqual(h.aborts, [], 'a settled run owes no abort (R22)');
    assert.equal(await h.state.deliverStopNotices!(async () => assert.fail('no stop notice is owed')), undefined);

    deliver.resolve();
    await headWake;
    assert.deepEqual(h.ephemerals, [{
      channel: 'C_NODE', user: STOPPER, thread_ts: thread.rootTs, text: STOP_ALREADY_FINISHED_TEXT,
    }]);
    assert.deepEqual(h.posts, [], 'no stop note');
    assert.deepEqual(h.runs, [head.id, 'n4_unread_1', 'n4_unread_2'], 'the held messages run as ordinary follow-ups');
    assert.deepEqual(h.telemetry.map((event) => event.outcome), ['succeeded', 'succeeded', 'succeeded']);
  } finally { h.close(); }
});

test('a stop that lands between the read and the dispatch is refused without a failure final, then ends stopped', async () => {
  const h = relayHarness();
  const thread = slackThread('1800000500.000100');
  try {
    const head = thread.job('n5_head', '101');
    await admit(h.state, thread, head);
    let refusal: unknown;
    h.scripts.set(head.id, async (options, turn) => {
      await options.onRuntimePlan!(compileRuntimePlanV2({
        turn, assignment: nodeAssignment(), instructions: 'Help.', memoryEpoch: 1,
      }));
      assert.equal((await h.state.steerTurn!(thread.stop('110'))).outcome, 'stopped');
      try {
        await options.flueDispatch!.prepare('Do the work', { generation: options.turnId! });
      } catch (error) {
        // runTurn passes a retryable dispatch failure through untouched.
        refusal = error;
        throw error;
      }
    });
    await h.wake();
    assert.ok(refusal instanceof AgentPromptFailure && refusal.retryable && !refusal.recoveryRequired);
    assert.equal(h.posts.length, 0, 'no failure final');
    assert.equal(h.calls.some((call) => /^(release|discardTurn|markTurnError)\(/.test(call)), false,
      'the row and its claims are kept');
    const view = await h.state.turnJobView!(head.id);
    assert.equal(view.status, 'pending');
    assert.equal(view.job?.attempts, 0, 'the refused attempt was given back');

    // The next wake takes the stopped ending.
    h.scripts.set(head.id, async (options) => {
      assert.equal(options.stopEnding?.beforeDispatch, true);
      await endStopped(options, thread.rootTs);
    });
    await h.wake();
    assert.equal(h.posts.length, 1);
    assert.match(String(h.posts[0]?.text), /^Stopped by <@U_STOPPER>\.\n\n1 message was not read/);
    assert.equal(await statusOf(h, head.id), 'done');
  } finally { h.close(); }
});

test('a stop that lands before the dispatch receipt is recorded stays owed, and is aborted again once it is', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = relayHarness();
  const thread = slackThread('1800000600.000100');
  try {
    const head = thread.job('n6_head', '101');
    await admit(h.state, thread, head);
    const prepared = deferred();
    const dispatched = deferred();
    const receipted = deferred();
    h.scripts.set(head.id, async (options, turn) => {
      await options.onRuntimePlan!(compileRuntimePlanV2({
        turn, assignment: nodeAssignment(), instructions: 'Help.', memoryEpoch: 1,
      }));
      await options.flueDispatch!.prepare('Do the work', { generation: options.turnId! });
      prepared.resolve();
      // Flue admits the dispatch only now: the first abort covered nothing.
      await dispatched.promise;
      await options.flueDispatch!.recordReceipt({
        submissionId: `sub_${options.turnId}`, acceptedAt: new Date().toISOString(), uid: UID,
      });
      receipted.resolve();
      await h.abortsReach(2);
      await options.flueDispatch!.recordSettlement(ABORTED());
      await endStopped(options, thread.rootTs);
    });
    const headWake = h.wake();
    await prepared.promise;
    assert.equal((await h.state.steerTurn!(thread.stop('110'))).outcome, 'stopped');
    await h.wake();
    assert.equal(h.aborts.length, 1, 'the abort is sent at once');
    let offered = 0;
    await h.state.deliverStopNotices!(async () => { offered += 1; return false; });
    assert.equal(offered, 0, 'the notice stays owed, retried after its backoff');

    dispatched.resolve();
    await receipted.promise;
    t.mock.timers.tick(2_000);
    await h.wake();
    assert.equal(h.aborts.length, 2, 'the owed notice aborts the admitted submission');
    assert.equal(await h.state.deliverStopNotices!(async () => assert.fail('no stop notice is owed')), undefined,
      'acknowledged once the receipt is recorded');
    await headWake;
    assert.equal(await statusOf(h, head.id), 'done');
    assert.equal(h.posts.length, 1);
  } finally { h.close(); }
});

test("on Node, an abort still out when its run settles holds the thread's next turn until it lands", async () => {
  let land!: () => void;
  const landing = new Promise<void>((resolve) => { land = resolve; });
  const order: string[] = [];
  const h = relayHarness({
    abortLands: async () => {
      await landing;
      order.push('abort landed');
    },
  });
  const thread = slackThread('1800001000.000100');
  try {
    const head = thread.job('n10_head', '101');
    const next = thread.job('n10_next', '102');
    await admit(h.state, thread, head);
    await admit(h.state, thread, next);
    const running = deferred();
    const settle = deferred();
    h.scripts.set(head.id, async (options, turn) => {
      await dispatchRun(options, turn);
      running.resolve();
      await settle.promise;
      // The run finished on its own while the abort was still out (R22).
      await options.flueDispatch!.recordSettlement(COMPLETED());
      await options.onDelivered?.('succeeded');
    });
    h.scripts.set(next.id, async (options) => {
      order.push('next runs');
      // It shares the thread's coordinator instance: a late abort would stop it.
      land();
      await options.onDelivered?.('succeeded');
    });
    const headWake = h.wake();
    await running.promise;
    assert.equal((await h.state.steerTurn!(thread.stop('110'))).outcome, 'stopped');
    const stopWake = h.wake();
    await h.abortsReach(1);
    // However late, the request lands.
    setTimeout(land, 50);
    settle.resolve();
    await headWake;
    await stopWake;
    assert.deepEqual(order, ['abort landed', 'next runs']);
    assert.deepEqual(h.runs, [head.id, next.id]);
    assert.equal(await statusOf(h, next.id), 'done');
    assert.deepEqual(h.ephemerals.map((post) => post.text), [STOP_ALREADY_FINISHED_TEXT]);
    assert.equal(await h.state.deliverStopNotices!(async () => assert.fail('no stop notice is owed')), undefined,
      'the abort was moot: the row settled while it was out');
  } finally { h.close(); }
});

test('no stop path posts the generic failure on Node: a failing ending retries, then gives up quietly', async () => {
  const h = relayHarness();
  const thread = slackThread('1800001100.000100');
  try {
    const head = await busyThread(h, thread, 'n11');
    h.scripts.set(head.id, async (options, turn) => {
      if (!options.flueDispatch!.dispatchReceipt) {
        await dispatchRun(options, turn);
        assert.equal((await h.state.steerTurn!(thread.stop('110'))).outcome, 'stopped');
        await options.flueDispatch!.recordSettlement(ABORTED());
      }
      await options.stopEnding!.finish();
      throw new Error('Slack terminal delivery requires reconciliation.');
    });
    await h.wake();
    assert.equal(await statusOf(h, head.id), 'pending', 'the stopped ending will retry');
    assert.equal(h.posts.length, 0, 'no failure final at the first attempt');
    assert.equal(h.calls.some((call) => /^(markTurnError|release|discardTurn)\(/.test(call)), false);

    await h.state.recordTurnAttempt!(head.id, MAX_POST_DISPATCH_ATTEMPTS);
    await h.wake();
    assert.ok(h.calls.includes(`markTurnError(${head.id})`), h.calls.join(' '));
    assert.equal(h.posts.some((post) => String(post.text).includes(DURABLE_RECOVERY_FAILURE_TEXT)), false,
      'no recovery notice');
    assert.equal(h.posts.some((post) => /reconciliation/.test(String(post.text))), false, 'no failure text');
    assert.equal(h.calls.some((call) => /^(release|discardTurn)\(/.test(call)), false, 'claims stay held');
    assert.deepEqual(h.runs, [head.id, head.id], 'no recovery replay');
  } finally { h.close(); }
});

test('no stop path posts the generic failure on Node: a failing ending before dispatch keeps its claims', async () => {
  const h = relayHarness();
  const thread = slackThread('1800001200.000100');
  try {
    const head = await busyThread(h, thread, 'n12');
    assert.equal((await h.state.steerTurn!(thread.stop('110'))).outcome, 'stopped');
    h.scripts.set(head.id, async (options) => {
      assert.equal(options.stopEnding?.beforeDispatch, true);
      await options.stopEnding!.finish();
      throw new Error('Slack terminal delivery requires reconciliation.');
    });
    await h.wake();
    assert.equal(await statusOf(h, head.id), 'pending');
    assert.deepEqual(h.posts, []);
    assert.equal(h.calls.some((call) => /^(markTurnError|release|discardTurn)\(/.test(call)), false);

    await h.state.recordTurnAttempt!(head.id, MAX_POST_DISPATCH_ATTEMPTS);
    await h.wake();
    assert.ok(h.calls.includes(`markTurnError(${head.id})`), h.calls.join(' '));
    assert.deepEqual(h.posts, [], 'no failure final, no recovery notice');
    assert.equal(h.calls.some((call) => /^(release|discardTurn)\(/.test(call)), false,
      'the claims stay held, so Slack never redrives the stopped message');
    assert.deepEqual(h.aborts, [], 'nothing was dispatched');
  } finally { h.close(); }
});

// ── the intercept-or-enqueue operation ───────────────────────────────────

test('the intercept-or-enqueue admission runs on the Node store without a nested transaction, for a stop and an ordinary message', async () => {
  const state = new SqliteSlackStateStore(':memory:');
  const thread = slackThread('1800000700.000100');
  try {
    const head = thread.job('n7_head', '101');
    assert.equal((await admit(state, thread, head)).claimed, true);
    // An ordinary message mid-run: enqueued with its 👀 receipt.
    const ordinary = await admit(state, thread, thread.job('n7_mid', '102'), { midRun: true });
    assert.equal(ordinary.claimed && 'admission' in ordinary && ordinary.midRunReceipt, true);
    // A typed stop: intercepted, with no Run, TurnJob or presentation.
    const stopped = await admit(state, thread, thread.job('n7_stop', '110', 'stop'), {
      steering: thread.stop('110'),
    });
    assert.equal(stopped.claimed && 'steered' in stopped && stopped.steered.outcome, 'stopped');
    assert.equal(stopped.claimed && 'steered' in stopped && stopped.steered.outcome === 'stopped' &&
      stopped.steered.stop.held, 1);
    // A check-in: intercepted, answered from the run's route.
    const checkIn = await admit(state, thread, thread.job('n7_status', '111', 'status'), {
      steering: { kind: 'check_in', threadKey: thread.threadKey },
    });
    assert.equal(checkIn.claimed && 'steered' in checkIn && checkIn.steered.outcome, 'check_in');
    assert.deepEqual((await state.listPendingTurns!()).map(({ id }) => id), ['n7_head', 'n7_mid']);

    // The stopped ending, then a stop with nothing running: an ordinary message.
    assert.equal((await state.finishTurnStop!(head.id, 'dropped'))?.count, 1);
    await state.markTurnDelivered!(head.id);
    const idle = await admit(state, thread, thread.job('n7_late_stop', '120', 'stop'), {
      steering: thread.stop('120'),
    });
    assert.equal(idle.claimed && 'admission' in idle, true, 'enqueued in the same transaction');
    assert.deepEqual((await state.listPendingTurns!()).map(({ id }) => id), ['n7_late_stop']);
  } finally { state.close(); }
});

// ── check-ins ──────────────────────────────────────────────────────────

test('covers AE5 on Node: "status" is answered from the facts of the run the relay holds, which goes quiet into the native indicator', async (t) => {
  const start = 1_800_000_800_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const h = relayHarness();
  const thread = slackThread('1800000800.000100');
  try {
    const head = thread.job('n8_head', '101');
    await admit(h.state, thread, head);
    const running = deferred();
    const release = deferred();
    const presenter: string[] = [];
    h.scripts.set(head.id, async (options) => {
      // runTurn registers the turn's status in this process's registry, under
      // the TurnJob id; that is where the Node store reads a check-in's facts.
      assert.equal(options.statusRegistry, undefined);
      assert.equal(options.turnId, head.id);
      const registration = defaultSlackStatusRegistry.registerTurn('node-status-instance', {
        setStatus: async (update) => { presenter.push(`set:${update.text}`); return true; },
        refreshStatus: async (update) => { presenter.push(`refresh:${update.text}`); return true; },
        showNativeIndicator: async () => {
          presenter.push('native');
          registration.holdNative(true);
          return true;
        },
        keepNativeIndicator: async () => { presenter.push('keepalive'); return true; },
      }, { generation: options.turnId!, observedMinIntervalMs: 1 });
      // The in-process Agent reports its activity to the same registry.
      defaultSlackStatusRegistry.setObservedStatus(
        'node-status-instance', options.turnId!, activityStatus('checking', 'Searching', 'the logs'),
      );
      running.resolve();
      await release.promise;
      registration.close();
      await options.onDelivered?.('succeeded');
    });
    const headWake = h.wake();
    await running.promise;
    await settle();

    const checkIn = async () => {
      const decision = await h.state.steerTurn!({ kind: 'check_in', threadKey: thread.threadKey });
      assert.equal(decision.outcome, 'check_in');
      if (decision.outcome !== 'check_in') throw new Error('not a check-in');
      const facts = await readSteeringRunFacts(decision.run, { state: h.state });
      return slackCheckInReply({ facts, dispatched: decision.run.dispatched });
    };
    const early = await checkIn();
    assert.match(early, /Current step: Searching the logs…/);
    assert.match(early, /Last progress under 5 minutes ago/);

    // Twelve quiet minutes: Slack's native indicator (with its Stop button)
    // took over after five, and the check-in reads 10+.
    for (let elapsed = 0; elapsed < 12 * 60_000; elapsed += 10_000) {
      t.mock.timers.tick(10_000);
      await settle();
    }
    assert.ok(presenter.includes('native'), presenter.join(' '));
    const quiet = await checkIn();
    assert.match(quiet, /No new progress for 10\+ minutes/);
    assert.match(quiet, /Running for 12 minutes/);

    // The keepalive re-sends processing before Slack's hour runs out.
    for (let elapsed = 0; elapsed < 46 * 60_000; elapsed += 60_000) {
      t.mock.timers.tick(60_000);
      await settle();
    }
    assert.ok(presenter.includes('keepalive'), presenter.join(' '));
    assert.deepEqual(h.posts, [], 'a check-in never touches the run');

    release.resolve();
    await headWake;
    assert.equal(await statusOf(h, head.id), 'done');
  } finally { h.close(); }
});

// ── 👀 on a mid-run message ─────────────────────────────────────────────

test('covers R12 on Node: a mid-run message\'s 👀 stays while the run works and its own turn removes it', async () => {
  const h = relayHarness({ realRunTurn: true });
  const thread = slackThread('1800000900.000100');
  try {
    const head = thread.job('n9_head', '101');
    await admit(h.state, thread, head);
    const running = deferred();
    const finish = deferred();
    h.scripts.set(head.id, async (options) => {
      running.resolve();
      await finish.promise;
      await options.onDelivered?.('succeeded');
    });
    const headWake = h.wake();
    await running.promise;
    // Posted while the run works: admission records the receipt and adds 👀.
    const mid = thread.job('n9_mid', '102', 'Also check the nightly job.');
    const admitted = await admit(h.state, thread, mid, { midRun: true });
    assert.equal(admitted.claimed && 'admission' in admitted && admitted.midRunReceipt, true);
    h.shown(mid.turn.messageTs);
    await h.wake();
    assert.deepEqual(h.reactions.filter((entry) => entry.startsWith('remove')), [],
      'the 👀 stays while the run works');

    finish.resolve();
    await headWake;
    assert.deepEqual(h.runs, [head.id, mid.id]);
    assert.deepEqual(h.reactions.filter((entry) => !entry.startsWith('shown')), [
      `remove ${mid.turn.messageTs}:eyes`,
    ], 'its own turn adds no second 👀 and removes the recorded one');
    assert.equal(await statusOf(h, mid.id), 'done');
    assert.deepEqual(await h.state.listPendingSlackInteractionCleanups!(), [], 'its receipt is finished');
  } finally { h.close(); }
});
