import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { CodingTaskStopReport } from '../src/sandbox/coding-task-stop.ts';
import { SlackStateLogic } from '../src/slack/claim-store.ts';
import { AgentPromptFailure, AgentRunAborted } from '../src/slack/flue-dispatch.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn, type RunTurnOptions, type SlackStopEnding } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import {
  executeTurnJob,
  stopRefusedDispatch,
  type SandboxTurnReader,
  type TurnExecutionOptions,
  type TurnExecutionPorts,
} from '../src/slack/turn-executor.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import {
  MAX_POST_DISPATCH_ATTEMPTS,
  TurnJobStoreLogic,
  turnJobStopGate,
  turnStopThreadKey,
  type PendingTurnJob,
} from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import {
  AGENT_FAILURE_TEXT,
  STOP_ALREADY_FINISHED_TEXT,
  slackStopNoteText,
  type SlackStopNoteFacts,
} from '../src/slack/web-client-presenter.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { promisify } from '../src/state/async-facade.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { SqliteWorkStore, WorkStoreLogic } from '../src/work/store.ts';
import type { WorkStore } from '../src/work/types.ts';

/**
 * The stopped ending (U3, KTD3): an aborted settlement on a stopped row, or a
 * stopped row that never dispatched, ends with one stop note, never the
 * generic failure text; the Agent Session settles `active`, and the rows the
 * stop held are dropped and counted before the turn is marked delivered.
 */

// ── copy ───────────────────────────────────────────────────────────────

test('the stop note names the stopper, what was done, whether coding may still run, and the unread count', () => {
  assert.equal(
    slackStopNoteText({ stopperUserId: 'U_STOPPER', unread: 0, pullRequests: [], windingDown: false }),
    'Stopped by <@U_STOPPER>.',
  );
  const note = slackStopNoteText({
    stopperUserId: 'U_STOPPER',
    unread: 2,
    pullRequests: [
      { number: 12, url: 'https://github.com/acme/app/pull/12', repository: 'acme/app', branch: 'fix/login' },
      // The same pull request seen twice (task report and Sandbox progress) is listed once.
      { number: 12, url: 'https://github.com/acme/app/pull/12', repository: 'acme/app', branch: 'fix/login' },
    ],
    windingDown: true,
  });
  assert.equal(note, [
    'Stopped by <@U_STOPPER>.',
    '',
    'Already done, not undone:',
    '- Pushed branch `fix/login` and opened pull request [acme/app#12](https://github.com/acme/app/pull/12).',
    '',
    'Coding work may still be winding down.',
    '',
    '2 messages were not read and can be sent again.',
  ].join('\n'));
  assert.match(
    slackStopNoteText({ stopperUserId: 'U_STOPPER', unread: 1, pullRequests: [], windingDown: false }),
    /1 message was not read and can be sent again\.$/,
  );
  assert.doesNotMatch(note, new RegExp(AGENT_FAILURE_TEXT.slice(0, 30)));
});

// ── the executor, against the real TurnJob store ────────────────────────

const NOW = 1_800_000_000_000;
const THREAD_TS = '1800000000.000100';
const UID = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const STOPPER = 'U_STOPPER';

function channelTurn(messageTs: string): NormalizedSlackTurn {
  return {
    workspaceId: 'T_STOP', channelId: 'C_STOP', eventId: `Ev_${messageTs}`,
    text: 'Do the work', userId: 'U_MEMBER', messageTs, threadTs: THREAD_TS,
    source: 'app_mention', contextMode: 'thread', channelType: 'channel',
  };
}

function stopAssignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_STOP', channelId: 'C_STOP', agentId: 'agent_stop', model: 'local-stub/stop',
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_stop', kind: 'user', revision: 1, name: 'Stop', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
}

function job(id: string, suffix: string): TurnJob {
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`,
    turn: channelTurn(`1800000000.000${suffix}`), assignment: stopAssignment(),
  };
}

function stopRequest(suffix: string) {
  return {
    kind: 'stop' as const, threadKey: `T_STOP:C_STOP:${THREAD_TS}`, source: 'typed' as const,
    stopperUserId: STOPPER, cutoffTs: `1800000000.000${suffix}`,
  };
}

/** Freeze, prepare and admit the row's Flue dispatch, as a running turn has. */
function dispatch(turns: TurnJobStoreLogic, queued: TurnJob, codingWorkspace = false): void {
  turns.freezeRuntimePlan(queued.id, compileRuntimePlanV2({
    turn: queued.turn, assignment: queued.assignment, instructions: 'Help.', memoryEpoch: 1,
    codingWorkspace,
  }));
  turns.prepareFlueDispatch(queued.id, 'Do the work', { generation: queued.id });
  turns.recordFlueReceipt(queued.id, {
    submissionId: `sub_${queued.id}`, acceptedAt: '2026-09-26T12:00:00.000Z', uid: UID,
  });
}

function store() {
  const clock = { now: NOW };
  const db = openStateDb(':memory:');
  return { db, turns: new TurnJobStoreLogic(db, () => clock.now), clock };
}

function pendingOf(turns: TurnJobStoreLogic, id: string): PendingTurnJob {
  const view = turns.runnerView(id);
  assert.equal(view.status, 'pending');
  return view.job!;
}

/**
 * Executor ports over a real TurnJob store: every call is recorded in order,
 * Slack writes are captured, and `runTurn` follows the given script.
 */
function executor(
  turns: TurnJobStoreLogic,
  script: (options: RunTurnOptions) => Promise<void>,
  input: { sandboxes?: SandboxTurnReader[] } = {},
) {
  const calls: string[] = [];
  const slackPosts: Array<{ method: string; input: Record<string, unknown> }> = [];
  const runs: RunTurnOptions[] = [];
  const telemetry: Array<Record<string, unknown>> = [];
  const client = {
    conversations: { info: async () => ({ ok: true, channel: { id: 'C_STOP', is_member: true } }) },
    chat: {
      postEphemeral: async (value: Record<string, unknown>) => {
        slackPosts.push({ method: 'chat.postEphemeral', input: value });
        return { ok: true, message_ts: '1800000000.000900' };
      },
      postMessage: async (value: Record<string, unknown>) => {
        slackPosts.push({ method: 'chat.postMessage', input: value });
        return { ok: true, ts: '1800000000.000901' };
      },
    },
  } as unknown as WebClient;
  const traced = <K extends keyof TurnJobStoreLogic>(name: K) =>
    (...args: unknown[]) => {
      calls.push(`${String(name)}(${JSON.stringify(args[0])}${args[1] === undefined ? '' : `,${JSON.stringify(args[1])}`})`);
      return (turns[name] as (...values: unknown[]) => unknown).apply(turns, args);
    };
  const ports = {
    env: {},
    turnJobs: {
      recordAttempt: traced('recordAttempt'),
      markRecoveryRequired: traced('markRecoveryRequired'),
      prepareFlueDispatch: traced('prepareFlueDispatch'),
      reconcileFlueExistingInstance: traced('reconcileFlueExistingInstance'),
      recordFlueReceipt: traced('recordFlueReceipt'),
      recordFlueSettlement: traced('recordFlueSettlement'),
      recordPullRequest: traced('recordPullRequest'),
      freezeRuntimePlan: traced('freezeRuntimePlan'),
      getBoundRuntimePlan: traced('getBoundRuntimePlan'),
      recordUsagePersistence: () => undefined,
      recordInteractionIntent: traced('recordInteractionIntent'),
      recordSlackInteractionProgress: traced('recordSlackInteractionProgress'),
      markDelivered: traced('markDelivered'),
      markError: traced('markError'),
      finishStop: traced('finishStop'),
    },
    slack: {
      setActiveWork: (_key: string, id: string, active: boolean) => {
        calls.push(`setActiveWork(${id},${active})`);
      },
      markCodingActiveWork: () => undefined,
      isCodingActiveWork: () => false,
      release: (key: string) => { calls.push(`release(${key})`); },
    },
    config: {},
    presentationState: {},
    telemetry: { capture: (event: Record<string, unknown>) => { telemetry.push(event); } },
    resolveInstallation: async () => ({ workspaceId: 'T_STOP', client }),
    sandboxes: () => (input.sandboxes ?? []).map((reader) => () => reader),
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
      runs.push(options);
      await script(options);
    },
  } as unknown as TurnExecutionPorts;
  const retries: Array<number | undefined> = [];
  const options: TurnExecutionOptions = {
    latency: { lane: 'cloudflare', executor: 'runner' },
    onRetry: (afterMs) => { retries.push(afterMs); },
  };
  return { ports, options, calls, runs, retries, slackPosts, telemetry };
}

/** A running head with two unread messages after it, then a typed stop. */
function stoppedThread(input: { dispatched?: boolean; codingWorkspace?: boolean } = {}) {
  const s = store();
  const head = job('head', '101');
  s.turns.enqueue(head);
  s.turns.enqueue(job('unread_1', '102'));
  s.turns.enqueue(job('unread_2', '103'));
  if (input.dispatched !== false) dispatch(s.turns, head, input.codingWorkspace);
  const decision = s.turns.steer(stopRequest('110'));
  assert.equal(decision.outcome, 'stopped');
  return s;
}

const ABORTED = { outcome: 'aborted' as const, settledAt: NOW, failureKind: 'agent' as const };

test('covers AE3: an aborted stopped run drops the two unread messages before it is marked delivered', async () => {
  const { db, turns } = stoppedThread();
  try {
    turns.recordFlueSettlement('head', ABORTED);
    // An earlier attempt recorded the pull request the run opened.
    const pullRequest = { number: 9, url: 'https://github.com/acme/app/pull/9', repository: 'acme/app', branch: 'fix/9' };
    turns.recordPullRequest('head', pullRequest);
    let facts: SlackStopNoteFacts | undefined;
    const h = executor(turns, async (options) => {
      assert.equal(options.replayText, undefined, 'a stopped turn never replays a pull-request answer');
      assert.equal(options.stopEnding?.beforeDispatch, undefined);
      facts = await options.stopEnding!.finish();
      await options.onDelivered?.('stopped');
    });
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options), true);
    assert.deepEqual(facts, { stopperUserId: STOPPER, unread: 2, pullRequests: [pullRequest], windingDown: false });
    const finish = h.calls.indexOf('finishStop("head","dropped")');
    const delivered = h.calls.indexOf('markDelivered("head")');
    assert.ok(finish >= 0 && delivered > finish, `the ending precedes the tombstone: ${h.calls.join(' ')}`);
    for (const id of ['unread_1', 'unread_2']) {
      const view = turns.runnerView(id);
      assert.equal(view.status, 'done', `${id} is dropped under the existing done status`);
    }
    assert.deepEqual(h.telemetry.map((event) => event.outcome), ['stopped']);
    assert.deepEqual(h.slackPosts, [], 'no private note: the stop stopped the run');
    assert.deepEqual(h.retries, []);
  } finally { db.close(); }
});

test('a replayed ending after a crash reports the same count, and markDelivered never releases the dropped rows', async () => {
  const { db, turns } = stoppedThread();
  try {
    turns.recordFlueSettlement('head', ABORTED);
    const counts: number[] = [];
    // The first attempt ends the stop, then its isolate dies before the note posts.
    const crashed = executor(turns, async (options) => {
      counts.push((await options.stopEnding!.finish())!.unread);
      throw new Error('isolate lost');
    });
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), crashed.ports, crashed.options), false);
    assert.equal(crashed.slackPosts.length, 0);
    assert.deepEqual(crashed.telemetry, []);
    assert.deepEqual(crashed.retries.length, 1, 'retried, never a failure final');
    assert.equal(crashed.calls.some((call) => call.startsWith('markError')), false);
    const replay = executor(turns, async (options) => {
      counts.push((await options.stopEnding!.finish())!.unread);
      await options.onDelivered?.('stopped');
    });
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), replay.ports, replay.options), true);
    assert.deepEqual(counts, [2, 2], 'the first ending stands');
    for (const id of ['unread_1', 'unread_2']) assert.equal(turns.runnerView(id).status, 'done');
  } finally { db.close(); }
});

test('a stopped row that never dispatched takes the stopped ending at once, counting itself as unread', async () => {
  const { db, turns } = stoppedThread({ dispatched: false });
  try {
    let facts: SlackStopNoteFacts | undefined;
    const h = executor(turns, async (options) => {
      assert.equal(options.stopEnding?.beforeDispatch, true);
      facts = await options.stopEnding!.finish();
      await options.onDelivered?.('stopped');
    });
    const head = pendingOf(turns, 'head');
    assert.equal(head.stop?.role, 'stopped');
    assert.equal(head.dispatchReceipt, undefined);
    assert.equal(await executeTurnJob(head, h.ports, h.options), true);
    assert.equal(h.runs.length, 1, 'the ending runs now, not after a 5 s retry');
    assert.deepEqual(h.retries, []);
    assert.equal(facts?.unread, 3, 'the undispatched head and the two held messages were never read');
    assert.equal(h.calls.some((call) => call.startsWith('prepareFlueDispatch')), false);
    assert.equal(turns.runnerView('head').status, 'done');
  } finally { db.close(); }
});

test('no stop path posts the generic failure: a failing ending retries, then gives up quietly', async () => {
  const { db, turns } = stoppedThread({ dispatched: false });
  try {
    const failing = async (options: RunTurnOptions) => {
      await options.stopEnding!.finish();
      throw new Error('Slack terminal delivery requires reconciliation.');
    };
    const early = executor(turns, failing);
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), early.ports, early.options), false);
    assert.equal(early.retries.length, 1);
    assert.deepEqual(early.slackPosts, [], 'no failure final at the first attempt bound');
    assert.equal(early.calls.some((call) => call.startsWith('markError')), false);
    const late = executor(turns, failing);
    const exhausted = { ...pendingOf(turns, 'head'), attempts: MAX_POST_DISPATCH_ATTEMPTS };
    assert.equal(await executeTurnJob(exhausted, late.ports, late.options), true);
    assert.deepEqual(late.slackPosts, [], 'no failure final, no recovery notice');
    assert.equal(late.runs.length, 1, 'no recovery replay');
    assert.ok(late.calls.includes('markError("head")'));
    assert.equal(late.calls.some((call) => call.startsWith('release(')), false, 'claims stay held');
  } finally { db.close(); }
});

test('covers AE9: a run that finished before the stop posts its answer, tells the stopper privately and releases held rows', async () => {
  const { db, turns } = stoppedThread();
  try {
    // The abort lost the race: Flue settled the run as completed.
    turns.recordFlueSettlement('head', {
      outcome: 'completed', settledAt: NOW,
      result: {
        text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null,
        usageCompleteness: 'not_reported',
      },
    });
    const h = executor(turns, async (options) => {
      await options.onDelivered?.('succeeded');
    });
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options), true);
    assert.deepEqual(h.slackPosts, [{
      method: 'chat.postEphemeral',
      input: { channel: 'C_STOP', user: STOPPER, thread_ts: THREAD_TS, text: STOP_ALREADY_FINISHED_TEXT },
    }]);
    assert.deepEqual(h.telemetry.map((event) => event.outcome), ['succeeded']);
    for (const id of ['unread_1', 'unread_2']) {
      const view = turns.runnerView(id);
      assert.equal(view.status, 'pending', `${id} runs as an ordinary follow-up`);
      assert.equal(view.job?.stop?.role, 'released');
    }
  } finally { db.close(); }
});

test('a runner that learned of the stop after reading the row still tells the stopper (R22)', async () => {
  const s = store();
  try {
    const head = job('head', '101');
    s.turns.enqueue(head);
    dispatch(s.turns, head);
    const read = pendingOf(s.turns, 'head');
    // The stop lands while the answer is being delivered.
    s.turns.steer(stopRequest('110'));
    const h = executor(s.turns, async (options) => {
      await options.onDelivered?.('succeeded');
    });
    const noticed = { ...h.options, stopRecorded: () => true };
    assert.equal(read.stop, undefined);
    assert.equal(await executeTurnJob(read, h.ports, noticed), true);
    assert.equal(h.slackPosts.length, 1);
    assert.equal(h.slackPosts[0]?.input.text, STOP_ALREADY_FINISHED_TEXT);
    // An ordinary turn with no stop tells no one anything.
    const plain = store();
    try {
      plain.turns.enqueue(job('plain', '101'));
      const quiet = executor(plain.turns, async (options) => { await options.onDelivered?.('succeeded'); });
      await executeTurnJob(pendingOf(plain.turns, 'plain'), quiet.ports, quiet.options);
      assert.deepEqual(quiet.slackPosts, []);
      assert.equal(quiet.calls.some((call) => call.startsWith('finishStop')), false);
    } finally { plain.db.close(); }
  } finally { s.db.close(); }
});

const unconfirmedReport: CodingTaskStopReport = {
  recordsRead: true,
  allSettled: false,
  tasks: [{
    taskKey: 'task_1', toolCallId: 'call_1', workspace: 'default', workspaceId: 'ws_1',
    instanceId: 'worker_1', submissionId: 'wsub_1', confirmed: false, outcome: 'unconfirmed',
    pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', repository: 'acme/app', branch: 'stop/x' },
  }],
};

test('covers AE1 and R23: the coding report names the pushed branch, and an unconfirmed worker may still be winding down', async () => {
  const { db, turns } = stoppedThread({ codingWorkspace: true });
  try {
    turns.recordFlueSettlement('head', ABORTED);
    let facts: SlackStopNoteFacts | undefined;
    const h = executor(turns, async (options) => {
      facts = await options.stopEnding!.finish();
      await options.onDelivered?.('stopped');
    });
    const reported = { ...h.options, codingStopReport: async () => unconfirmedReport };
    const head = { ...pendingOf(turns, 'head') };
    head.turn = { ...head.turn, interactionIntent: { disposition: 'work', checklist: ['Fix it', 'Test it'] } as never };
    assert.equal(await executeTurnJob(head, h.ports, reported), true);
    assert.equal(facts?.windingDown, true);
    assert.deepEqual(facts?.pullRequests.map((pullRequest) => pullRequest.branch), ['stop/x']);
    assert.equal(h.calls.includes('setActiveWork(head,false)'), false,
      'the coding marker stays while the worker may still run');
    // A confirmed stop says nothing about winding down and clears the marker.
    const settled = stoppedThread({ codingWorkspace: true });
    try {
      settled.turns.recordFlueSettlement('head', ABORTED);
      let confirmed: SlackStopNoteFacts | undefined;
      const c = executor(settled.turns, async (options) => {
        confirmed = await options.stopEnding!.finish();
        await options.onDelivered?.('stopped');
      });
      const report: CodingTaskStopReport = {
        recordsRead: true, allSettled: true,
        tasks: [{ ...unconfirmedReport.tasks[0]!, confirmed: true, outcome: 'stopped' }],
      };
      const settledHead = { ...pendingOf(settled.turns, 'head') };
      settledHead.turn = { ...settledHead.turn, interactionIntent: { disposition: 'work', checklist: ['Fix it', 'Test it'] } as never };
      await executeTurnJob(settledHead, c.ports, { ...c.options, codingStopReport: async () => report });
      assert.equal(confirmed?.windingDown, false);
      assert.ok(c.calls.includes('setActiveWork(head,false)'));
    } finally { settled.db.close(); }
  } finally { db.close(); }
});

test('R23 on the alarm executor: no coding report for a run that used its coding Sandbox reads as winding down', async () => {
  const { db, turns } = stoppedThread({ codingWorkspace: true });
  try {
    turns.recordFlueSettlement('head', ABORTED);
    const sandbox: SandboxTurnReader = {
      getTurnId: async () => 'head',
      getTurnProgress: async () => ({
        pullRequest: { number: 3, url: 'https://github.com/acme/app/pull/3', repository: 'acme/app', branch: 'b' },
      }),
    };
    let facts: SlackStopNoteFacts | undefined;
    const h = executor(turns, async (options) => {
      facts = await options.stopEnding!.finish();
      await options.onDelivered?.('stopped');
    }, { sandboxes: [sandbox] });
    await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options);
    assert.equal(facts?.windingDown, true);
    assert.deepEqual(facts?.pullRequests.map((pullRequest) => pullRequest.number), [3]);
  } finally { db.close(); }
});

test('an aborted run without a stop record still ends as an ordinary failure', async () => {
  const s = store();
  try {
    const head = job('head', '101');
    s.turns.enqueue(head);
    dispatch(s.turns, head);
    s.turns.recordFlueSettlement('head', ABORTED);
    let facts: SlackStopNoteFacts | undefined | 'unset' = 'unset';
    const h = executor(s.turns, async (options) => {
      facts = await options.stopEnding!.finish();
      await options.onDelivered?.('failed');
    });
    await executeTurnJob(pendingOf(s.turns, 'head'), h.ports, h.options);
    assert.equal(facts, undefined);
  } finally { s.db.close(); }
});

test('the first turn after a stop carries the previous-run-stopped fact, and only that turn', async () => {
  const { db, turns, clock } = stoppedThread();
  try {
    turns.recordFlueSettlement('head', ABORTED);
    clock.now += 1_000;
    // Posted after the stop: an ordinary turn, queued behind the stopped head.
    turns.enqueue(job('after', '120'));
    assert.equal(pendingOf(turns, 'after').previousStop, undefined, 'the head has not ended yet');
    const h = executor(turns, async (options) => {
      await options.stopEnding!.finish();
      await options.onDelivered?.('stopped');
    });
    await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options);
    const after = pendingOf(turns, 'after');
    assert.deepEqual(after.previousStop, { stopperUserId: STOPPER, stoppedAt: NOW });
    const next = executor(turns, async (options) => { await options.onDelivered?.('succeeded'); });
    await executeTurnJob(after, next.ports, next.options);
    assert.deepEqual(next.runs[0]?.previousStop, { stopperUserId: STOPPER, stoppedAt: NOW });
    clock.now += 1_000;
    turns.enqueue(job('later', '130'));
    assert.equal(pendingOf(turns, 'later').previousStop, undefined, 'only the first turn after the stop');
  } finally { db.close(); }
});

test('a stop that only raced a finished run marks no later turn as following a stopped run', async () => {
  const { db, turns, clock } = stoppedThread();
  try {
    turns.recordFlueSettlement('head', {
      outcome: 'completed', settledAt: NOW,
      result: {
        text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null,
        usageCompleteness: 'not_reported',
      },
    });
    const h = executor(turns, async (options) => { await options.onDelivered?.('succeeded'); });
    await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options);
    clock.now += 1_000;
    turns.enqueue(job('after', '120'));
    assert.equal(pendingOf(turns, 'after').previousStop, undefined);
  } finally { db.close(); }
});

// ── runTurn, with a durable presentation and a recorded Slack ────────────

const assignment: ResolvedAssignment = {
  workspaceId: 'T_STOPPED',
  channelId: 'D_STOPPED',
  agentId: 'agent_stopped',
  model: 'local-stub/stopped',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_stopped',
    kind: 'user',
    revision: 1,
    name: 'Stopped Agent',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

// A turn that reaches the Agent prepares memory from the local state store.
const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-stopped-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const config = new SqliteConfigStore(statePath, { agents: [] });
  await config.createAgent(assignment.agent);
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await config.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  config.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

function dmTurn(messageTs: string): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: 'D_STOPPED',
    channelType: 'im',
    eventId: `Ev_STOPPED_${messageTs}`,
    text: 'Refactor the login flow.',
    userId: 'U_REQUESTER',
    messageTs,
    threadTs: messageTs,
    source: 'dm_message',
    contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

async function presentationHarness(
  turn: NormalizedSlackTurn,
  options: { stopStreamError?: unknown; work?: WorkStore & { close(): void } } = {},
) {
  const work = options.work ?? new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Stopped Agent',
      avatarUrl: 'https://chickpea.example/assets/agents/stopped/avatar/1',
      avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing',
      action: 'Preparing',
      object: 'your request',
      generation: sessionGeneration,
      sequence: 1,
      operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      requesterUserId: turn.userId,
    },
  });
  const slack: Array<{ method: string; input: Record<string, unknown> }> = [];
  const sessions: string[] = [];
  const statuses: string[] = [];
  const client = {
    apiCall: async (_method: string, input: Record<string, unknown>) => {
      sessions.push(String(input.status));
      return { ok: true };
    },
    assistant: { threads: {
      setStatus: async (input: Record<string, unknown>) => {
        statuses.push(String(input.status ?? ''));
        return { ok: true };
      },
      setTitle: async () => ({ ok: true }),
    } },
    conversations: {
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async (input: Record<string, unknown>) => {
        slack.push({ method: 'chat.startStream', input });
        return { ok: true, ts: `${turn.messageTs.split('.')[0]}.000500` };
      },
      appendStream: async (input: Record<string, unknown>) => {
        slack.push({ method: 'chat.appendStream', input });
        return { ok: true };
      },
      stopStream: async (input: Record<string, unknown>) => {
        slack.push({ method: 'chat.stopStream', input });
        if (options.stopStreamError) throw options.stopStreamError;
        return { ok: true };
      },
      postMessage: async (input: Record<string, unknown>) => {
        slack.push({ method: 'chat.postMessage', input });
        return { ok: true, ts: `${turn.messageTs.split('.')[0]}.000600` };
      },
      update: async (input: Record<string, unknown>) => {
        slack.push({ method: 'chat.update', input });
        return { ok: true };
      },
      delete: async (input: Record<string, unknown>) => {
        slack.push({ method: 'chat.delete', input });
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const state = {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<typeof store.getLatestThreadSessionGeneration>[0]) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) => store.transition(input),
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
  const close = () => { db.close(); work.close(); };
  return { db, store, work, runId, slack, sessions, statuses, client, state, close };
}

type PresentationHarness = Awaited<ReturnType<typeof presentationHarness>>;

const FACTS: SlackStopNoteFacts = {
  stopperUserId: STOPPER,
  unread: 0,
  pullRequests: [{ number: 12, url: 'https://github.com/acme/app/pull/12', repository: 'acme/app', branch: 'fix/login' }],
  windingDown: false,
};

function stopEnding(facts: SlackStopNoteFacts | undefined, extra: Partial<SlackStopEnding> = {}) {
  const finished: string[] = [];
  const ending: SlackStopEnding = {
    finish: async () => { finished.push('finish'); return facts; },
    ...extra,
  };
  return { ending, finished };
}

function stoppedRun(
  turn: NormalizedSlackTurn,
  h: PresentationHarness,
  options: Partial<RunTurnOptions> = {},
) {
  return runTurn(turn, assignment, undefined, {
    client: h.client,
    runId: h.runId,
    turnId: `turn_${h.runId}`,
    presentationState: h.state,
    statusRegistry: new SlackStatusRegistry(),
    workStore: h.work,
    usageRecordingEnabled: false,
    agentPrompt: async () => { throw new AgentRunAborted(); },
    ...options,
  });
}

/** Every Slack message text the run wrote, in order. */
function written(h: PresentationHarness): string[] {
  return h.slack.flatMap(({ method, input }) => {
    if (method === 'chat.startStream' || method === 'chat.stopStream') {
      return ((input.chunks ?? []) as Array<{ type: string; text?: string }>)
        .filter((chunk) => chunk.type === 'markdown_text').map((chunk) => chunk.text ?? '');
    }
    if (method === 'chat.postMessage' || method === 'chat.update') return [String(input.text ?? '')];
    return [];
  });
}

test('covers AE1: a stopped run posts one note naming the stopper and the pushed branch, and the session ends active', async () => {
  const turn = dmTurn('1790100001.000100');
  const h = await presentationHarness(turn);
  const outcomes: Array<string | undefined> = [];
  try {
    const { ending, finished } = stopEnding(FACTS);
    await stoppedRun(turn, h, {
      stopEnding: ending,
      onDelivered: (outcome) => { outcomes.push(outcome); },
      beforeDelivery: async () => 'Pull request #12 is already open.',
    });
    assert.deepEqual(finished, ['finish']);
    assert.deepEqual(outcomes, ['stopped']);
    const texts = written(h);
    assert.equal(texts.length, 1, JSON.stringify(h.slack));
    assert.match(texts[0]!, /^Stopped by <@U_STOPPER>\./);
    assert.match(texts[0]!, /Pushed branch `fix\/login`/);
    assert.doesNotMatch(texts.join('\n'), /failed before completion/);
    assert.doesNotMatch(texts.join('\n'), /already open/, 'no replayed pull-request answer');
    assert.equal(h.sessions.at(-1), 'active', 'the Agent Session settles active, not suspended');
    assert.equal(h.sessions.includes('suspended'), false);
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion !== 3) return;
    assert.equal(stored.terminalDelivery.state, 'intended');
    if (stored.terminalDelivery.state !== 'intended') return;
    assert.equal(stored.terminalDelivery.result, 'answer');
    assert.equal(stored.terminalDelivery.reason, 'stopped');
    assert.equal(stored.agentSession.acknowledged, 'active');
    assert.equal(stored.activityProjection.state, 'cleared');
    assert.equal(stored.repairRequired, false);
    const run = await h.work.getRun(h.runId);
    assert.equal(run?.terminalDisposition, 'cancelled', 'the Run is cancelled, not failed');
  } finally { h.close(); }
});

test('a stop mid-stream seals the partial answer with the note, with no second message and no update', async () => {
  const turn = dmTurn('1790100002.000100');
  const h = await presentationHarness(turn);
  try {
    const apply = (mutation: Parameters<typeof h.store.transition>[0]['mutation']) => {
      const current = h.store.get(h.runId)!;
      const result = h.store.transition({
        runId: current.runId,
        workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken,
        expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state,
        mutation,
      });
      assert.equal(result.outcome, 'applied');
    };
    // The answer had begun streaming, a moment ago, when the stop took effect.
    const streamTs = `${Math.floor(Date.now() / 1000)}.000400`;
    apply({ kind: 'freeze_progressive_eligibility', eligibility: { allowed: true, reason: 'safe_early_release' } });
    apply({ kind: 'stream_start_intent' });
    apply({ kind: 'stream_started', messageTs: streamTs,
      flue: { instanceId: 'instance_stopped', submissionId: 'submission_stopped', messageId: 'message_stopped' } });
    apply({ kind: 'append_intent', position: { batch: 5, index: 0 }, from: 0, to: 18, hash: 'a'.repeat(64) });
    apply({ kind: 'append_acknowledged', cursor: 1, acknowledgedPrefixHash: 'a'.repeat(64) });
    await stoppedRun(turn, h, { stopEnding: stopEnding(FACTS).ending });
    assert.deepEqual(h.slack.map((call) => call.method), ['chat.stopStream']);
    const stop = h.slack[0]!.input;
    assert.equal(stop.ts, streamTs);
    const chunks = stop.chunks as Array<{ type: string; text: string }>;
    assert.equal(chunks[0]?.type, 'markdown_text');
    assert.match(chunks[0]!.text, /^\n\nStopped by <@U_STOPPER>\./, 'the partial answer stays, marked stopped');
    assert.ok(Array.isArray(stop.blocks) && (stop.blocks as unknown[]).length === 1, 'the Agent footer closes it');
    const stored = h.store.get(h.runId);
    assert.equal(stored?.stream.state, 'finalized');
    assert.equal(stored?.stream.presentationOutcome, 'progressive');
  } finally { h.close(); }
});

/** Stream the start of an answer on the harness's presentation, as a running turn has. */
function streamPartialAnswer(h: PresentationHarness): string {
  const apply = (mutation: Parameters<typeof h.store.transition>[0]['mutation']) => {
    const current = h.store.get(h.runId)!;
    const result = h.store.transition({
      runId: current.runId,
      workBindingGeneration: current.workBindingGeneration,
      runFencingToken: current.runFencingToken,
      expectedProjectionVersion: current.projectionVersion,
      expectedStreamState: current.stream.state,
      mutation,
    });
    assert.equal(result.outcome, 'applied');
  };
  const streamTs = `${Math.floor(Date.now() / 1000)}.000400`;
  apply({ kind: 'freeze_progressive_eligibility', eligibility: { allowed: true, reason: 'safe_early_release' } });
  apply({ kind: 'stream_start_intent' });
  apply({ kind: 'stream_started', messageTs: streamTs,
    flue: { instanceId: 'instance_stopped', submissionId: 'submission_stopped', messageId: 'message_stopped' } });
  apply({ kind: 'append_intent', position: { batch: 5, index: 0 }, from: 0, to: 18, hash: 'a'.repeat(64) });
  apply({ kind: 'append_acknowledged', cursor: 1, acknowledgedPrefixHash: 'a'.repeat(64) });
  return streamTs;
}

for (const [label, halted] of [
  ['Slack\'s Stop button halted the stream', { code: ErrorCode.PlatformError, data: { ok: false, error: 'message_not_in_streaming_state' } }],
  ['the gateway relays a stream conflict', new SlackTransportError('chat.stopStream', 'streaming_state_conflict')],
] as const) {
  test(`a stop whose stream is already halted (${label}) keeps the partial answer and posts the note as a new reply`, async () => {
    const turn = dmTurn(`17901000${label.length}.000100`);
    const h = await presentationHarness(turn, { stopStreamError: halted });
    try {
      const streamTs = streamPartialAnswer(h);
      const outcomes: Array<string | undefined> = [];
      await stoppedRun(turn, h, {
        stopEnding: stopEnding(FACTS).ending,
        onDelivered: (outcome) => { outcomes.push(outcome); },
      });
      assert.deepEqual(h.slack.map((call) => call.method), ['chat.stopStream', 'chat.postMessage'],
        'never chat.update (which would replace the partial answer) and never chat.delete');
      assert.equal(h.slack[0]!.input.ts, streamTs);
      const post = h.slack[1]!.input;
      assert.equal(post.channel, turn.channelId);
      assert.equal(post.thread_ts, turn.threadTs, 'a threaded reply');
      const blocks = post.blocks as Array<{ type: string; text?: string }>;
      assert.equal(blocks[0]?.type, 'markdown');
      assert.match(String(blocks[0]?.text), /^Stopped by <@U_STOPPER>\./);
      assert.equal(blocks.at(-1)?.type, 'context', 'the Agent footer closes it');
      assert.equal(post.username, 'Stopped Agent', 'posted as the Agent');
      assert.equal(post.icon_url, 'https://chickpea.example/assets/agents/stopped/avatar/1');
      assert.ok(typeof post.client_msg_id === 'string', 'the post is idempotent per terminal');
      assert.deepEqual(outcomes, ['stopped']);
      assert.equal(h.sessions.at(-1), 'active');
      const stored = h.store.get(h.runId);
      assert.equal(stored?.stream.state, 'finalized');
      assert.equal(stored?.stream.messageTs, `${turn.messageTs.split('.')[0]}.000600`, 'the note is the terminal');
      assert.equal(stored?.repairRequired, false);
    } finally { h.close(); }
  });
}

test('a crash after the note posted and before the delivery was recorded replays without a second note', async () => {
  const turn = dmTurn('1790100003.000100');
  const h = await presentationHarness(turn);
  try {
    await assert.rejects(stoppedRun(turn, h, {
      stopEnding: stopEnding(FACTS).ending,
      onDelivered: () => { throw new Error('isolate lost'); },
    }));
    const outcomes: Array<string | undefined> = [];
    await stoppedRun(turn, h, {
      stopEnding: stopEnding(FACTS).ending,
      onDelivered: (outcome) => { outcomes.push(outcome); },
    });
    assert.equal(written(h).filter((text) => text.includes('Stopped by')).length, 1, JSON.stringify(h.slack));
    assert.deepEqual(outcomes, ['stopped'], 'the replay still records the delivery');
  } finally { h.close(); }
});

test('a stopped run records interrupted usage and a stopped turn_latency outcome, never failed', async () => {
  const turn = dmTurn('1790100004.000100');
  const h = await presentationHarness(turn);
  const usage = new SqliteUsageStore(':memory:');
  const logged: Array<Record<string, unknown>> = [];
  const info = console.info;
  console.info = (record?: unknown) => {
    if (record && typeof record === 'object') logged.push(record as Record<string, unknown>);
  };
  try {
    await stoppedRun(turn, h, {
      stopEnding: stopEnding(FACTS).ending,
      usageRecordingEnabled: true,
      usageStore: usage,
      turnLatency: { lane: 'cloudflare', executor: 'runner' },
    });
    console.info = info;
    const operation = await usage.getOperation(`turn_${h.runId}`);
    assert.equal(operation?.operation.status, 'interrupted');
    const latency = logged.filter((record) => record.event === 'turn_latency');
    assert.deepEqual(latency.map((record) => record.outcome), ['stopped']);
    assert.equal(latency[0]?.final, 'delivered');
  } finally {
    console.info = info;
    usage.close();
    h.close();
  }
});

test('an abort with no stop record still posts the ordinary failure', async () => {
  const turn = dmTurn('1790100005.000100');
  const h = await presentationHarness(turn);
  try {
    await stoppedRun(turn, h, { stopEnding: stopEnding(undefined).ending });
    assert.deepEqual(written(h), [AGENT_FAILURE_TEXT]);
    assert.equal(h.sessions.at(-1), 'suspended');
  } finally { h.close(); }
});

test('a stopped turn that never dispatched ends with the note and no classification or model call', async () => {
  const turn = dmTurn('1790100006.000100');
  delete (turn as { interactionIntent?: unknown }).interactionIntent;
  const h = await presentationHarness(turn);
  try {
    const outcomes: Array<string | undefined> = [];
    await stoppedRun(turn, h, {
      stopEnding: stopEnding({ ...FACTS, pullRequests: [], unread: 1 }, { beforeDispatch: true }).ending,
      agentPrompt: async () => assert.fail('a stopped turn never reaches the Agent'),
      onRuntimePlan: async () => assert.fail('a stopped turn freezes no plan'),
      onInteractionIntent: async () => assert.fail('a stopped turn is never classified'),
      onDelivered: (outcome) => { outcomes.push(outcome); },
    });
    assert.deepEqual(outcomes, ['stopped']);
    const texts = written(h);
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /^Stopped by <@U_STOPPER>\.\n\n1 message was not read and can be sent again\.$/);
    assert.equal(h.sessions.includes('processing'), false, 'no working indicator is started for it');
    assert.equal(h.sessions.at(-1), 'active');
  } finally { h.close(); }
});

test('the prompt of the first turn after a stop says the previous run was stopped and by whom', async () => {
  const turn = dmTurn('1790100007.000100');
  const h = await presentationHarness(turn);
  try {
    const prompts: string[] = [];
    await stoppedRun(turn, h, {
      previousStop: { stopperUserId: STOPPER },
      agentPrompt: async ({ message }) => {
        prompts.push(message);
        return {
          text: 'Done.',
          requestedModel: assignment.model ?? null,
          returnedModel: null,
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /The previous run in this thread was stopped by <@U_STOPPER> before it finished\./);
    const current = prompts[0]!.indexOf('Current Slack request');
    assert.ok(prompts[0]!.indexOf('stopped by <@U_STOPPER>') < current, 'framed before the current request');
    const plain: string[] = [];
    const other = dmTurn('1790100008.000100');
    const h2 = await presentationHarness(other);
    try {
      await stoppedRun(other, h2, {
        agentPrompt: async ({ message }) => {
          plain.push(message);
          return {
            text: 'Done.', requestedModel: assignment.model ?? null, returnedModel: null,
            reportedUsage: null, usageCompleteness: 'not_reported',
          };
        },
      });
      assert.doesNotMatch(plain[0]!, /previous run in this thread was stopped/);
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('covers AE3: the stop clears its status although the dropped messages were admitted after it', async () => {
  const turn = dmTurn('1790100009.000100');
  const h = await presentationHarness(turn);
  try {
    const head = h.store.get(h.runId)!;
    assert.equal(head.schemaVersion, 3);
    if (head.schemaVersion !== 3) return;
    await stoppedRun(turn, h, {
      stopEnding: stopEnding({ ...FACTS, unread: 1 }).ending,
      agentPrompt: async () => {
        // A message posted during the run was admitted with the thread's next
        // session generation; the stop dropped it, so it never runs.
        h.store.create({
          schemaVersion: 3,
          runId: 'run_dropped_follow_up',
          turnJobId: 'turn_dropped_follow_up',
          bindingId: 'binding_dropped_follow_up',
          workBindingGeneration: 1,
          runFencingToken: 0,
          owner: head.owner,
          sessionGeneration: head.sessionGeneration + 1,
          root: head.root,
        });
        throw new AgentRunAborted();
      },
    });
    assert.ok(h.statuses.some((status) => status !== ''), 'the run showed its status');
    assert.equal(h.statuses.at(-1), '', 'the stopped run clears it: no later turn will');
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion === 3 ? stored.activityProjection.state : undefined, 'cleared');
    assert.equal(h.sessions.at(-1), 'active');
  } finally { h.close(); }
});

test('a replayed aborted settlement ends with the stop note, without the Agent or its memory', async () => {
  const turn = dmTurn('1790100010.000100');
  const h = await presentationHarness(turn);
  try {
    const unreachable = () => assert.fail('a settled abort never reaches Flue again');
    const outcomes: Array<string | undefined> = [];
    await runTurn(turn, assignment, undefined, {
      client: h.client,
      runId: h.runId,
      turnId: `turn_${h.runId}`,
      presentationState: h.state,
      statusRegistry: new SlackStatusRegistry(),
      workStore: h.work,
      usageRecordingEnabled: false,
      // The live attempt recorded the aborted settlement, then its isolate died.
      flueDispatch: {
        dispatchEnvelope: { instanceId: 'agent_stopped' } as never,
        dispatchReceipt: { submissionId: 'sub_stopped', acceptedAt: '2026-09-26T12:00:00.000Z', uid: UID },
        flueSettlement: ABORTED,
        prepare: unreachable,
        recordReceipt: unreachable,
        recordSettlement: unreachable,
        reconcileExistingInstance: unreachable,
        markRecoveryRequired: unreachable,
      },
      stopEnding: stopEnding(FACTS).ending,
      onDelivered: (outcome) => { outcomes.push(outcome); },
    });
    assert.deepEqual(outcomes, ['stopped']);
    assert.match(written(h).join('\n'), /^Stopped by <@U_STOPPER>\./);
    assert.doesNotMatch(written(h).join('\n'), /failed before completion/);
  } finally { h.close(); }
});

test('a stop refused at dispatch after the Run prepared its execution ends with the note, and the Run settles cancelled', async () => {
  const turn = dmTurn('1790100011.000100');
  // One state database, as on either lane: the TurnJob, its stop and the Work Run.
  const db = openStateDb(':memory:');
  const work = new WorkStoreLogic(db);
  const h = await presentationHarness(turn, { work: promisify(work, { close: () => db.close() }) });
  try {
    const turns = new TurnJobStoreLogic(db);
    const headId = `turn_${h.runId}`;
    turns.enqueue({
      id: headId, evtKey: `evt:${headId}`, msgKey: `msg:${headId}`, turn, assignment,
      runId: h.runId, executionAuthority: 'legacy',
    });
    turns.freezeRuntimePlan(headId, compileRuntimePlanV2({
      turn, assignment, instructions: 'Answer directly.', memoryEpoch: 1,
    }));
    // Attempt 1 persists its prompt and opens its execution; the stop lands
    // before it asks for the dispatch, which the stop refuses.
    await assert.rejects(stoppedRun(turn, h, {
      agentPrompt: async ({ message }) => {
        assert.equal(turns.steer({
          kind: 'stop', threadKey: turnStopThreadKey(turn, assignment), source: 'typed',
          stopperUserId: STOPPER, cutoffTs: '1790100011.000200',
        }).outcome, 'stopped');
        try {
          turns.prepareFlueDispatch(headId, message, { generation: headId });
        } catch (error) {
          throw stopRefusedDispatch(error);
        }
        return assert.fail('a refused dispatch never reaches Flue');
      },
    }), (error: unknown) => error instanceof AgentPromptFailure && error.retryable);
    assert.equal((await h.work.getRun(h.runId))?.status, 'executing');
    assert.equal(turnJobStopGate(turns.runnerView(headId).job!), 'stopped_before_dispatch');
    // Attempt 2: the stopped ending, which drops through the state store's stop ending.
    const slack = new SlackStateLogic(db);
    const outcomes: Array<string | undefined> = [];
    await stoppedRun(turn, h, {
      stopEnding: {
        beforeDispatch: true,
        finish: async () => slack.finishTurnStop(headId, 'dropped', turns, work, h.store)
          ? { stopperUserId: STOPPER, unread: 1, pullRequests: [], windingDown: false }
          : undefined,
      },
      agentPrompt: async () => assert.fail('a stopped turn never reaches the Agent'),
      onDelivered: (outcome) => { outcomes.push(outcome); },
    });
    assert.deepEqual(outcomes, ['stopped']);
    assert.match(written(h).join('\n'), /^Stopped by <@U_STOPPER>\./);
    const run = await h.work.getRun(h.runId);
    assert.equal(run?.status, 'settled', 'the prepared Run is not left executing');
    assert.equal(run?.terminalDisposition, 'cancelled');
    assert.equal(run?.safeFailureCode, 'run_stopped');
    assert.equal(run?.deliveryStatus, 'not_applicable');
    const [execution] = await h.work.listRunExecutions(h.runId);
    assert.equal(execution?.outcome, 'not_submitted');
    assert.equal(execution?.modelInvocationStatus, 'not_invoked');
  } finally { h.close(); }
});
