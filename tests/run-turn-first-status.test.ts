import assert from 'node:assert/strict';
import { DEFAULT_INTERACTION_TIMEOUT_MS, type SlackInteractionIntent } from '../src/slack/interaction-intent.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { configureModelAccessResolver, resetModelAccessForTests } from '../src/config/model-access.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { SlackPresentationStatePort } from '../src/slack/agent-view-presentation.ts';
import { SlackRunPresentationStoreLogic, type SlackRunPresentation } from '../src/slack/run-presentations.ts';
import { CLEF_TIMEOUT_MS } from '../src/slack/clef-intent.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import type { FrozenRuntimePlanDecision } from '../src/slack/turn-job-types.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import { timedStateRpc } from '../src/observability/runtime-latency.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { fakeClefEnv } from './helpers/fake-clef.ts';
import { SCRIPTED_MODEL, scriptedMessage, scriptedProvider } from './helpers/scripted-provider.ts';

/**
 * How many state-store calls a turn makes before its first Slack write. In a
 * thread runner each of them is a round trip to the shared state store, so
 * they decide how soon a side thread shows its first status. The runner's own
 * presentation state is local and not counted; its state-store reads are.
 */

const directory = mkdtempSync(join(tmpdir(), 'chickpea-first-status-'));
const statePath = join(directory, 'state.sqlite');
let previousStatePath: string | undefined;

const assignment: ResolvedAssignment = {
  workspaceId: 'T_FIRST_STATUS',
  channelId: 'C_FIRST_STATUS',
  agentId: 'agent_first_status',
  model: 'local-stub/first-status',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_first_status',
    kind: 'user',
    revision: 1,
    name: 'First Status',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const store = new SqliteConfigStore(statePath, agentRoutineDeletion, { agents: [] });
  await store.createAgent(assignment.agent);
  const installation = await store.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await store.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  store.close();
});

after(() => {
  closeNodeStateStores();
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(directory, { recursive: true, force: true });
});

/** Record every method call on a store, by store and method name. */
function counted<T extends object>(label: string, store: T, timeline: string[]): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args: unknown[]) => {
        timeline.push(`${label}.${property}`);
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

type Surface = 'channel_mention' | 'dm' | 'thread_follow_up';

function surfaceTurn(surface: Surface): NormalizedSlackTurn {
  const base = {
    workspaceId: assignment.workspaceId,
    userId: 'U_FIRST_STATUS',
    actorMembershipId: 'membership_first_status',
    text: 'Summarize what changed in the release notes this week.',
  };
  switch (surface) {
    case 'channel_mention':
      return {
        ...base,
        channelId: 'C_FIRST_STATUS',
        channelType: 'channel',
        eventId: 'Ev_FIRST_STATUS_CHANNEL',
        messageTs: '1788000000.000100',
        threadTs: '1788000000.000100',
        source: 'app_mention',
        contextMode: 'thread',
      };
    case 'dm':
      return {
        ...base,
        channelId: 'D_FIRST_STATUS',
        channelType: 'im',
        eventId: 'Ev_FIRST_STATUS_DM',
        messageTs: '1788000001.000100',
        threadTs: '1788000001.000100',
        source: 'dm_message',
        contextMode: 'dm_history',
      };
    case 'thread_follow_up':
      return {
        ...base,
        channelId: 'C_FIRST_STATUS',
        channelType: 'channel',
        eventId: 'Ev_FIRST_STATUS_THREAD',
        messageTs: '1788000002.000200',
        threadTs: '1788000000.000100',
        source: 'implicit_thread_reply',
        contextMode: 'thread',
        // Admission classified this candidate already.
        interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
      };
  }
}

let turns = 0;
/** The harness's Slack calls that read the thread rather than write to it. */
const SLACK_READS = new Set(['slack:conversations.replies', 'slack:conversations.history']);
/** Slack rejects the custom assistant status (a platform error), when set. */
let rejectCustomStatus = false;
let holdCustomStatus: ((timeline: string[]) => Promise<void>) | undefined;
let holdNativeStart: ((timeline: string[]) => Promise<void>) | undefined;
/** Holds Slack's answer to a thread read; its end is marked `answered:<method>`. */
let holdThreadRead: ((timeline: string[]) => Promise<void>) | undefined;
/** Holds Slack's answer to any write the turn makes, once the hook is set. */
let holdSlackWrite: ((method: string, timeline: string[]) => Promise<void>) | undefined;
type PresentationRead = () => SlackRunPresentation | undefined;
let holdClassifierAnswer: ((timeline: string[], presentation: PresentationRead) => Promise<void>) | undefined;
const REPLY_ANSWER = '{"disposition":"reply","reason":"substantive_request"}';
/** The classifier's JSON answer once released. */
let classifierAnswer = REPLY_ANSWER;
/** Runs inside the Agent stand-in before it answers. */
let holdAgentPrompt: ((timeline: string[], presentation: PresentationRead) => Promise<void>) | undefined;
/** The running turn's timeline, for a hook that waits on it. */
let currentTimeline: string[] = [];
/** The platform env the turn runs under; an `AI` on it is Clef's binding. */
let platformEnv: Record<string, unknown> | undefined;

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + DEFAULT_INTERACTION_TIMEOUT_MS / 4;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function firstStatusTimeline(
  surface: Surface,
  publicUrl?: string | null,
  overrides: Partial<RunTurnOptions> = {},
  turnAssignment: ResolvedAssignment = assignment,
  turnOverrides: Partial<NormalizedSlackTurn> = {},
) {
  const timeline: string[] = [];
  currentTimeline = timeline;
  const recordedIntents: SlackInteractionIntent[] = [];
  const reactionsAdded: Array<Record<string, unknown>> = [];
  let presentation: SlackRunPresentation | undefined;
  const readPresentation: PresentationRead = () => presentation;
  if (holdClassifierAnswer) {
    const hold = holdClassifierAnswer;
    scriptedProvider([async (model) => {
      await hold(timeline, readPresentation);
      return scriptedMessage(model, [{ type: 'text', text: classifierAnswer }], 'stop');
    }], { providerId: 'anthropic' });
  }
  turns += 1;
  const base = surfaceTurn(surface);
  // A distinct message per call, in the same Slack thread shape.
  const messageTs = `${base.messageTs.slice(0, -3)}${String(turns).padStart(3, '0')}`;
  const turn: NormalizedSlackTurn = {
    ...base,
    eventId: `${base.eventId}_${turns}`,
    messageTs,
    threadTs: surface === 'thread_follow_up' ? base.threadTs : messageTs,
    ...turnOverrides,
  };
  const real = resolveStores();
  const admitted = await real.work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: turnAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const stores = Object.fromEntries(
    Object.entries(real).map(([name, store]) => [name, counted(name, store as object, timeline)]),
  ) as unknown as AppStores;
  const db = openStateDb(':memory:');
  const presentations = new SlackRunPresentationStoreLogic(db);
  presentation = undefined;
  const refreshPresentation = () => { presentation = presentations.get(runId); };
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  presentations.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'First Status',
      avatarUrl: 'https://chickpea.example/assets/agents/first/avatar/1',
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
  // A runner owns this state locally, except the thread's generation fence,
  // which it reads from the state store.
  const presentationState: SlackPresentationStatePort = {
    getRunPresentation: (id) => {
      const current = presentations.get(id);
      if (id === runId) presentation = current;
      return current;
    },
    getLatestThreadSessionGeneration: (root) => {
      timeline.push('presentations.getLatestThreadSessionGeneration');
      return presentations.getLatestThreadSessionGeneration(root);
    },
    transitionRunPresentation: (input) => {
      const result = presentations.transition(input);
      refreshPresentation();
      return result;
    },
    reserveSlackAppend: (workspaceId) => presentations.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  } as SlackPresentationStatePort;
  const slack = (method: string) => async () => {
    timeline.push(`slack:${method}`);
    if (rejectCustomStatus && method === 'assistant.threads.setStatus') {
      throw Object.assign(new Error('not_allowed'), {
        code: ErrorCode.PlatformError,
        data: { ok: false, error: 'not_allowed' },
      });
    }
    if (holdCustomStatus && method === 'assistant.threads.setStatus') {
      await holdCustomStatus(timeline);
      timeline.push('acknowledged:assistant.threads.setStatus');
    }
    if (holdThreadRead && SLACK_READS.has(`slack:${method}`)) {
      await holdThreadRead(timeline);
      timeline.push(`answered:${method}`);
    }
    if (holdSlackWrite && !SLACK_READS.has(`slack:${method}`)) await holdSlackWrite(method, timeline);
    return { ok: true, ts: '1788000100.000100', channel: turn.channelId, messages: [] };
  };
  const client = {
    // agents.sessions.setStatus, labelled by the session status it sets.
    apiCall: async (_method: string, input: Record<string, unknown>) => {
      timeline.push(`slack:session:${String(input.status)}`);
      if (holdNativeStart && input.status === 'processing') {
        await holdNativeStart(timeline);
        timeline.push('acknowledged:session:processing');
      }
      return { ok: true };
    },
    assistant: { threads: { setStatus: slack('assistant.threads.setStatus') } },
    reactions: {
      add: async (input: Record<string, unknown>) => {
        reactionsAdded.push(input);
        return slack('reactions.add')();
      },
      remove: slack('reactions.remove'),
    },
    conversations: { replies: slack('conversations.replies'), history: slack('conversations.history') },
    chat: {
      postMessage: slack('chat.postMessage'),
      startStream: slack('chat.startStream'),
      appendStream: slack('chat.appendStream'),
      stopStream: slack('chat.stopStream'),
      update: slack('chat.update'),
      delete: slack('chat.delete'),
    },
  } as unknown as WebClient;
  const options: RunTurnOptions = {
    client,
    turnId: `turn_${runId}`,
    runId,
    runAttempt: 1,
    presentationState,
    appStores: stores,
    settingsStore: stores.settings,
    workStore: stores.work,
    usageStore: stores.usage,
    usageRecordingEnabled: false,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    // The runner's per-turn state-store writes (see runnerTurnJobsPort).
    onInteractionIntent: async (intent) => {
      timeline.push('turnJobs.recordInteractionIntent');
      recordedIntents.push(intent);
    },
    onRuntimePlan: async (candidate) => {
      timeline.push('turnJobs.freezeRuntimePlan');
      const { deriveRuntimePlanInstanceId } = await import('../src/agents/runtime-plan.ts');
      return { runtimePlan: candidate, instanceId: deriveRuntimePlanInstanceId(candidate) };
    },
    getBoundRuntimePlan: async () => {
      timeline.push('turnJobs.getBoundRuntimePlan');
      return undefined;
    },
    agentPrompt: async () => {
      timeline.push('agentPrompt');
      await holdAgentPrompt?.(timeline, readPresentation);
      return {
        text: 'Done.',
        requestedModel: assignment.model ?? null,
        returnedModel: null,
        reportedUsage: null,
        usageCompleteness: 'not_reported',
      };
    },
  };
  try {
    await runTurn(turn, turnAssignment, platformEnv, { ...options, ...overrides });
  } finally {
    refreshPresentation();
    db.close();
  }
  const first = timeline.findIndex((entry) => entry.startsWith('slack:'));
  assert.ok(first >= 0, 'the turn wrote to Slack');
  return {
    timeline,
    beforeFirstWrite: timeline.slice(0, first),
    // The thread's reads run beside these writes; they never come first (`firstSlackCall`).
    slackWrites: timeline.filter((entry) => entry.startsWith('slack:') && !SLACK_READS.has(entry)),
    firstSlackCall: timeline[first],
    firstWrite: first,
    presentation: readPresentation(),
    recordedIntents,
    reactionsAdded,
  };
}

/**
 * Before this ordering, a channel mention made 18 state-store calls (and the
 * classifier's model call) before its first Slack write, a DM 15, and a
 * thread follow-up 14: public URL, classification, memory, plan freeze, and
 * Work lifecycle, all serial. Now the first write is Slack's native
 * `processing` indicator (the fast write); the session is then handed over and
 * the admitted activity is written as the custom status, which replaces it
 * (#207). Only the public URL precedes the native start. Classification,
 * memory, the plan, and the Work lifecycle start once that call is issued
 * and run while Slack acknowledges it. The custom status waits for the
 * acknowledgement (its hand-over releases an acknowledged session) and is
 * issued next; the reads do not wait for it either. The thread's generation
 * fence (checked by the hand-over and by the custom write) is the status
 * path's only other state read; a thread runner answers it from its `begin`
 * round trip.
 */
for (const surface of ['channel_mention', 'dm', 'thread_follow_up'] as const) {
  test(`${surface}: native first, before any other read, then the custom status`, async () => {
    const { beforeFirstWrite, firstSlackCall, slackWrites, timeline } = await firstStatusTimeline(surface);
    assert.deepEqual(beforeFirstWrite, ['settings.getSetting'],
      'only the public URL is read before the native start');
    assert.equal(firstSlackCall, 'slack:session:processing', 'no Slack read goes before the native start');
    assert.deepEqual(slackWrites.slice(0, 3), [
      'slack:session:processing', // the fast first write
      'slack:session:active', // hand-over, so the custom text renders
      'slack:assistant.threads.setStatus', // the admitted activity replaces it
    ]);
    const custom = timeline.indexOf('slack:assistant.threads.setStatus');
    // The hand-over and the custom write each check the thread's generation
    // fence; a runner answers both from the cache its `begin` round trip seeds.
    assert.deepEqual(
      timeline.slice(0, custom).filter((entry) => entry.startsWith('presentations.')),
      [
        'presentations.getLatestThreadSessionGeneration',
        'presentations.getLatestThreadSessionGeneration',
      ],
      'the hand-over and the custom write add only the thread generation fence',
    );
    assert.equal(timeline.filter((entry) => entry === 'slack:session:processing').length, 1,
      'one native start');
  });

  test(`${surface}: a runner that read the public URL at begin writes to Slack first`, async () => {
    const { beforeFirstWrite, timeline } =
      await firstStatusTimeline(surface, 'https://chickpea.example');
    assert.deepEqual(beforeFirstWrite, [], 'the native start is the first thing the turn does');
    // The generation fence before the custom write: the runner seeds it from
    // the same `begin` round trip (see slack-thread-runner-execution tests).
    const custom = timeline.indexOf('slack:assistant.threads.setStatus');
    assert.deepEqual(timeline.slice(0, custom).filter((entry) => entry.startsWith('presentations.')), [
      'presentations.getLatestThreadSessionGeneration',
      'presentations.getLatestThreadSessionGeneration',
    ]);
    const none = await firstStatusTimeline(surface, null);
    assert.deepEqual(none.beforeFirstWrite, [], 'a resolved absent URL is not read again');
  });
}

test('a turn whose preparation fails after its first status releases that status turn', async () => {
  const registry = new SlackStatusRegistry();
  const failure = new Error('state store unavailable');
  await assert.rejects(
    firstStatusTimeline('dm', null, {
      statusRegistry: registry,
      onRuntimePlan: async () => { throw failure; },
    }),
    (error) => error === failure,
  );
  // A retry registers the same admitted generation; a leftover owner would
  // silence it as a concurrent duplicate.
  const key = `${assignment.workspaceId}:D_FIRST_STATUS:1788000001.000${String(turns).padStart(3, '0')}`;
  assert.equal(registry.owners(key)?.size ?? 0, 0);
});

test('memory preparation that fails while the plan is still reading fails the turn without an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const failure = new Error('memory preparation failed');
  const info = console.info;
  // Fault injection: this fixture's memory preparation ends on its quarantine
  // path, so failing that path's metric makes preparation itself reject.
  console.info = (...args: unknown[]) => {
    if (String(args[0]).includes('memory_metric')) throw failure;
    info(...args);
  };
  let releasePlanRead!: () => void;
  const planRead = new Promise<void>((resolve) => { releasePlanRead = resolve; });
  try {
    const run = firstStatusTimeline('dm', null, {
      getBoundRuntimePlan: async () => {
        await planRead;
        return undefined;
      },
    });
    const outcome = run.then(() => 'resolved', (error: unknown) => error);
    // Memory rejects while the plan's read is pending; the plan awaits the
    // epoch only after this delay.
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.info = info;
    releasePlanRead();
    assert.equal(await outcome, failure);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    console.info = info;
    releasePlanRead();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a rejected custom status shows native again, without a second start', async () => {
  rejectCustomStatus = true;
  try {
    const { slackWrites } = await firstStatusTimeline('channel_mention', null);
    assert.deepEqual(slackWrites.slice(0, 4), [
      'slack:session:processing',
      'slack:session:active',
      'slack:assistant.threads.setStatus', // rejected
      'slack:session:processing', // native shown again, not a second start
    ]);
  } finally {
    rejectCustomStatus = false;
  }
});

// Defects caught: the thread's context read waiting for the opening status
// writes again (the 864 ms chain in the Amber d3 trace), and the reply
// overtaking the admitted status.
test('classification, the plan and the thread context do not wait for the custom status acknowledgement; the reply does', async () => {
  const reads = ['turnJobs.recordInteractionIntent', 'turnJobs.freezeRuntimePlan', 'slack:conversations.replies'];
  holdCustomStatus = (timeline) => waitUntil(() => reads.every((read) => timeline.includes(read)));
  try {
    const { timeline } = await firstStatusTimeline('channel_mention', null);
    const acknowledged = timeline.indexOf('acknowledged:assistant.threads.setStatus');
    assert.ok(acknowledged > timeline.indexOf('slack:assistant.threads.setStatus'));
    for (const read of reads) {
      const at = timeline.indexOf(read);
      assert.ok(at >= 0, `${read} happens`);
      assert.ok(at < acknowledged, `${read} does not wait for the custom status acknowledgement`);
    }
    const reply = timeline.findIndex((entry) => entry.startsWith('slack:chat.'));
    assert.ok(reply > acknowledged, `the reply follows the admitted status: ${timeline.join(' ')}`);
  } finally {
    holdCustomStatus = undefined;
  }
});

test('classification and the plan start once the native start is issued, before Slack acknowledges it', async () => {
  const reads = ['turnJobs.recordInteractionIntent', 'turnJobs.getBoundRuntimePlan'];
  holdNativeStart = (timeline) => waitUntil(() => reads.every((read) => timeline.includes(read)));
  try {
    const { timeline } = await firstStatusTimeline('channel_mention', null);
    const issued = timeline.indexOf('slack:session:processing');
    const acknowledged = timeline.indexOf('acknowledged:session:processing');
    assert.ok(issued >= 0 && acknowledged > issued, 'the native start was issued and acknowledged');
    for (const read of reads) {
      const at = timeline.indexOf(read);
      assert.ok(at > issued, `${read} follows the native start`);
      assert.ok(at < acknowledged, `${read} does not wait for the native acknowledgement`);
    }
    assert.ok(timeline.indexOf('slack:session:active') > acknowledged,
      'the hand-over waits for the native acknowledgement');
  } finally {
    holdNativeStart = undefined;
  }
});

test('the context is read before the classifier answers; the dispatch waits for the answer and its record', async () => {
  holdClassifierAnswer = async (timeline) => {
    await waitUntil(() => timeline.some((entry) => entry.startsWith('slack:conversations.')));
    timeline.push('classifier:answered');
  };
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'anthropic-first-status-key';
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'anthropic-first-status-key' }) });
  try {
    const { timeline } = await firstStatusTimeline('dm', null, {}, {
      ...assignment,
      channelId: 'D_FIRST_STATUS',
      model: `anthropic/${SCRIPTED_MODEL}`,
      modelAttribution: { source: 'pinned', providerId: 'anthropic' },
    });
    const contextRead = timeline.findIndex((entry) => entry.startsWith('slack:conversations.'));
    const answered = timeline.indexOf('classifier:answered');
    const recorded = timeline.indexOf('turnJobs.recordInteractionIntent');
    const dispatched = timeline.indexOf('agentPrompt');
    assert.ok(contextRead >= 0 && answered >= 0 && recorded >= 0 && dispatched >= 0,
      `the turn read, classified, recorded and dispatched: ${timeline.join(' ')}`);
    assert.ok(contextRead < answered, `the context read does not wait for the classifier: ${timeline.join(' ')}`);
    assert.ok(answered < dispatched && recorded < dispatched,
      `the dispatch waits for the classifier's answer and its record: ${timeline.join(' ')}`);
  } finally {
    holdClassifierAnswer = undefined;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    resetModelAccessForTests();
  }
});

/** The DM assignment whose classifier runs on the scripted anthropic provider. */
const classifiedAssignment: ResolvedAssignment = {
  ...assignment,
  channelId: 'D_FIRST_STATUS',
  model: `anthropic/${SCRIPTED_MODEL}`,
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
};

async function withScriptedClassifier<T>(run: () => Promise<T>): Promise<T> {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'anthropic-first-status-key';
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'anthropic-first-status-key' }) });
  try {
    return await run();
  } finally {
    holdClassifierAnswer = undefined;
    holdAgentPrompt = undefined;
    platformEnv = undefined;
    classifierAnswer = REPLY_ANSWER;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    resetModelAccessForTests();
  }
}

const WORK_ANSWER = JSON.stringify({
  disposition: 'work', reason: 'substantive_request', checklist: ['Release summary', 'Notable changes'],
});

/** Releases the classifier once the Agent has been dispatched. */
const answerAfterDispatch = async (timeline: string[]) => {
  await waitUntil(() => timeline.includes('agentPrompt'));
  timeline.push('classifier:answered');
};

// Defect caught: the gain is lost because the dispatch still waits for the
// model, or the dispatch no longer waits for the recorded basis.
test('a confident Clef reply dispatches on its record before the classifier answers', async () => {
  const clef = fakeClefEnv('reply');
  platformEnv = clef.env;
  holdClassifierAnswer = answerAfterDispatch;
  await withScriptedClassifier(async () => {
    const { timeline, recordedIntents } = await firstStatusTimeline('dm', null, {}, classifiedAssignment);
    const recorded = timeline.indexOf('turnJobs.recordInteractionIntent');
    const dispatched = timeline.indexOf('agentPrompt');
    const answered = timeline.indexOf('classifier:answered');
    assert.ok(recorded >= 0 && dispatched >= 0 && answered >= 0,
      `the turn recorded, dispatched, and the classifier answered: ${timeline.join(' ')}`);
    assert.ok(recorded < dispatched, `the dispatch waits for the record: ${timeline.join(' ')}`);
    assert.ok(dispatched < answered, `the dispatch does not wait for the classifier: ${timeline.join(' ')}`);
    assert.deepEqual(recordedIntents, [{ disposition: 'reply', reason: 'substantive_request' }]);
    assert.equal(clef.calls.length, 1);
  });
});

// Defect caught: the eyes wait for the model's labels, or the labels never
// reach the presentation once the model answers.
test('a confident Clef work shows the eyes before the classifier answers and adopts its labels late', async () => {
  const clef = fakeClefEnv('work');
  platformEnv = clef.env;
  classifierAnswer = WORK_ANSWER;
  holdClassifierAnswer = answerAfterDispatch;
  holdAgentPrompt = async (_timeline, presentation) => {
    await waitUntil(() => presentation()?.plan !== undefined);
  };
  await withScriptedClassifier(async () => {
    const { timeline, presentation, recordedIntents } = await firstStatusTimeline('dm', null, {}, classifiedAssignment);
    const eyes = timeline.indexOf('slack:reactions.add');
    const dispatched = timeline.indexOf('agentPrompt');
    const answered = timeline.indexOf('classifier:answered');
    assert.ok(eyes >= 0 && eyes < dispatched && dispatched < answered,
      `the eyes precede the dispatch, which precedes the classifier: ${timeline.join(' ')}`);
    assert.deepEqual(recordedIntents, [{ disposition: 'work', reason: 'substantive_request', checklist: [] }],
      'the record keeps an empty checklist; the labels are presentation');
    assert.deepEqual(
      presentation?.plan?.tasks.map((task) => task.title),
      ['Release summary', 'Notable changes'],
      'the model\'s labels became the plan while the stream was absent',
    );
    assert.equal(clef.calls.length, 1);
  });
});

// Defect caught: a plan attaches to a finished reply, or its refusal warns on
// every such turn.
test('labels that arrive after the final began attach no plan and raise no warning', async () => {
  platformEnv = fakeClefEnv('work').env;
  classifierAnswer = WORK_ANSWER;
  holdClassifierAnswer = async (timeline, presentation) => {
    await waitUntil(() => {
      const current = presentation();
      return current?.schemaVersion === 3 && current.terminalDelivery.state !== 'none';
    });
    timeline.push('classifier:answered');
  };
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(' ')); };
  try {
    await withScriptedClassifier(async () => {
      const { timeline, presentation } = await firstStatusTimeline('dm', null, {}, classifiedAssignment);
      assert.ok(timeline.indexOf('agentPrompt') < timeline.indexOf('classifier:answered'), timeline.join(' '));
      assert.equal(presentation?.schemaVersion === 3 && presentation.terminalDelivery.state !== 'none', true);
      assert.equal(presentation?.plan, undefined);
      assert.deepEqual(warnings.filter((entry) => entry.includes('late native plan')), []);
    });
  } finally {
    console.warn = warn;
  }
});

// Defect caught: Clef's emoji or target is used (right 19 of 35 and 1 of 35
// times), or a confident react_only dispatches the Agent.
test('a confident Clef react_only takes the classifier\'s reaction and target and never dispatches', async () => {
  const clef = fakeClefEnv('react_only');
  platformEnv = clef.env;
  classifierAnswer = JSON.stringify({ disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' });
  holdClassifierAnswer = async (timeline) => { timeline.push('classifier:answered'); };
  await withScriptedClassifier(async () => {
    const { timeline, recordedIntents, reactionsAdded } = await firstStatusTimeline('dm', null, {}, classifiedAssignment);
    assert.equal(timeline.includes('agentPrompt'), false, `no dispatch: ${timeline.join(' ')}`);
    assert.deepEqual(recordedIntents, [
      { disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' },
    ]);
    assert.deepEqual(reactionsAdded.map((reaction) => reaction.name), ['eyes']);
    assert.equal(clef.calls.length, 1);
  });
});

// Defects caught: a thread read started for a turn its start already knows
// will not dispatch (a command, a stop, a basis restored as react_only), and
// one a turn judged react_only later leaves running after it returns.
test("a turn reads its thread beside its preparation only if it may dispatch, and never returns before that read ends", async () => {
  const threadReads = (timeline: string[]) => timeline.filter((entry) => SLACK_READS.has(entry)).length;
  const dispatching = await firstStatusTimeline('dm', null, {}, dmAssignment);
  assert.equal(threadReads(dispatching.timeline), 1, 'the same turn shape reads its thread once');
  const command = await firstStatusTimeline('dm', null, {}, dmAssignment, { text: '!memory help' });
  const stopped = await firstStatusTimeline('dm', null, {
    stopEnding: {
      beforeDispatch: true,
      finish: async () => ({ stopperUserId: 'U_STOPPER', unread: 1, pullRequests: [], windingDown: false }),
    },
  }, dmAssignment);
  const restored = await firstStatusTimeline('dm', null, {}, dmAssignment, {
    interactionIntent: { disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' },
  });
  for (const [name, { timeline }] of [['a command', command], ['a stopped turn', stopped], ['a restored react_only', restored]] as const) {
    assert.equal(threadReads(timeline), 0, `${name} reads no thread: ${timeline.join(' ')}`);
  }

  platformEnv = fakeClefEnv('react_only').env;
  classifierAnswer = JSON.stringify({ disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' });
  holdClassifierAnswer = async () => undefined;
  holdThreadRead = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await withScriptedClassifier(async () => {
      const { timeline } = await firstStatusTimeline('dm', null, {}, classifiedAssignment);
      assert.equal(timeline.includes('agentPrompt'), false, `judged react_only, it never dispatches: ${timeline.join(' ')}`);
      assert.equal(threadReads(timeline), 1, 'the read it started beside its preparation is its only one');
      assert.ok(timeline.some((entry) => entry.startsWith('answered:')), `the attempt waited for it: ${timeline.join(' ')}`);
    });
  } finally {
    holdThreadRead = undefined;
  }
});

// Defect caught: a retry judges again and may answer differently from the
// basis the first attempt recorded.
test('a restored intent asks neither Clef nor the classifier and records nothing', async () => {
  const clef = fakeClefEnv('reply');
  platformEnv = clef.env;
  try {
    const { timeline } = await firstStatusTimeline('thread_follow_up');
    assert.equal(clef.calls.length, 0);
    assert.equal(timeline.includes('turnJobs.recordInteractionIntent'), false);
  } finally {
    platformEnv = undefined;
  }
});

// Defect caught: Clef's management signal or a waiting change set never
// reaches the dispatch, or a quiet, failed, or timed-out management call
// mounts the change tools anyway.
test('Clef\'s management signal or a waiting change set reaches the dispatch; a quiet, failed, or slow call does not', async () => {
  const carried = async (
    manage: number | 'error' | 'hang',
    turnOverrides: Partial<NormalizedSlackTurn> = {},
  ) => {
    let dispatched: boolean | undefined | 'not dispatched' = 'not dispatched';
    platformEnv = fakeClefEnv('reply', { manage }).env;
    holdClassifierAnswer = async () => undefined;
    await withScriptedClassifier(() => firstStatusTimeline('dm', null, {
      agentPrompt: async (input) => {
        dispatched = input.workspaceChangeTools;
        return {
          text: 'Done.', requestedModel: classifiedAssignment.model ?? null, returnedModel: null,
          reportedUsage: null, usageCompleteness: 'not_reported',
        };
      },
    }, classifiedAssignment, turnOverrides));
    return dispatched;
  };
  assert.equal(await carried(0.97), true, 'Clef fired');
  assert.equal(await carried(0.1), undefined, 'Clef stayed quiet');
  assert.equal(await carried('error'), undefined, 'the call failed');
  const started = Date.now();
  assert.equal(await carried('hang'), undefined, 'the call never answered');
  assert.ok(Date.now() - started < CLEF_TIMEOUT_MS + 2_000, 'the turn went on at Clef\'s bound');
  assert.equal(await carried(0.1, { managementProposalPending: true }), true, 'a change set waits on the requester');
});

/** The DM's own Agent, so its memory prepares and the turn reaches the dispatch. */
const dmAssignment: ResolvedAssignment = { ...assignment, channelId: 'D_FIRST_STATUS' };

const AGENT_ANSWER = {
  text: 'Done.',
  requestedModel: assignment.model ?? null,
  returnedModel: null,
  reportedUsage: null,
  usageCompleteness: 'not_reported' as const,
};

// Defects caught: the wake goes out before the plan is saved (or names an
// instance the freeze did not record), more than once, after the staging, or
// not at all; the turn record loses its lead.
test('a turn wakes its Agent object once its plan is saved, before it stages, and records the lead', async (t) => {
  const latency: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if ((record as { event?: unknown } | undefined)?.event === 'turn_latency') {
      latency.push(record as Record<string, unknown>);
    }
  });
  const events: string[] = [];
  let instanceId: string | undefined;
  await firstStatusTimeline('dm', null, {
    turnLatency: { lane: 'cloudflare', executor: 'runner' },
    onRuntimePlan: async (candidate) => {
      events.push('freeze');
      await new Promise((resolve) => setTimeout(resolve, 10));
      instanceId = deriveRuntimePlanInstanceId(candidate);
      events.push('freeze:saved');
      return { runtimePlan: candidate, instanceId };
    },
    wakeAgentObject: async (id) => { events.push(`wake:${id}`); },
    agentPrompt: async ({ onAgentStaged }) => {
      events.push('stage');
      await new Promise((resolve) => setTimeout(resolve, 25));
      onAgentStaged?.(0);
      return AGENT_ANSWER;
    },
  }, dmAssignment);
  assert.deepEqual(events, ['freeze', 'freeze:saved', `wake:${instanceId}`, 'stage']);
  assert.equal(latency.length, 1);
  assert.ok(Number(latency[0]?.agentWakeLeadMs) >= 25, `the lead covers the wait to stage: ${latency[0]?.agentWakeLeadMs}`);
});

// Defects caught: the turn's observation never reaches the shadow (no
// answer_release record), the record names another run, the shadow time
// comes out later than the answer Slack showed, or neither record names the
// turn's model.
test('a turn logs what the host release rule would have done with its reply', async (t) => {
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    const event = (record as { event?: unknown } | undefined)?.event;
    if (event === 'turn_latency' || event === 'answer_release') logs.push(record as Record<string, unknown>);
  });
  const answer = 'The synthetic forecast lists three dry days and one windy afternoon. '.repeat(12).trim();
  const submissionId = 'submission_shadow';
  await firstStatusTimeline('dm', null, {
    turnLatency: { receivedAt: Date.now() - 400, admittedAt: Date.now() - 300, lane: 'cloudflare', executor: 'runner' },
    agentPrompt: async ({ onConversationChunk }) => {
      let batch = 0;
      const read = (body: Record<string, unknown>) => onConversationChunk?.({
        conversationId: 'conversation_shadow', ...body, position: { batch: (batch += 1), index: 0 },
      } as Parameters<NonNullable<typeof onConversationChunk>>[0], submissionId);
      read({ type: 'message-started', messageId: 'message_shadow', submissionId });
      for (const delta of answer.split(/(?= )/)) {
        read({ type: 'message-delta', messageId: 'message_shadow', kind: 'text', delta });
      }
      read({ type: 'message-completed', messageId: 'message_shadow' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...AGENT_ANSWER, text: answer };
    },
  }, dmAssignment);
  const latency = logs.find((record) => record.event === 'turn_latency');
  const release = logs.find((record) => record.event === 'answer_release');
  assert.ok(latency && release, `both records: ${JSON.stringify(logs)}`);
  assert.equal(release.outcome, 'released');
  assert.equal(release.runRef, latency.runRef);
  assert.equal(release.answerSteps, 1);
  assert.equal(release.modelToken, 'local_stub_first_status', `from ${dmAssignment.model}`);
  assert.equal(latency.modelToken, release.modelToken);
  assert.equal(release.taskCardStream, false);
  assert.ok(Number(release.receiptToReleaseMs) >= 400);
  assert.equal(latency.firstAnswerText, 'final');
  assert.ok(Number(latency.receiptToShadowAnswerTextMs) + 20 <= Number(latency.receiptToFirstAnswerTextMs),
    `the release precedes the final: ${latency.receiptToShadowAnswerTextMs} < ${latency.receiptToFirstAnswerTextMs}`);
  assert.equal(JSON.stringify(logs).includes('forecast'), false);
});

// Defects caught: runTurn never wires the dispatch's model start or the
// observed work into turn_latency, or never counts the attempt's state store
// calls.
test('a turn logs its model start, its model work and its state store calls', async (t) => {
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    const event = (record as { event?: unknown } | undefined)?.event;
    if (event === 'turn_latency' || event === 'state_rpc_summary') records.push(record as Record<string, unknown>);
  });
  const receivedAt = Date.now() - 2_500;
  await firstStatusTimeline('dm', null, {
    turnLatency: { receivedAt, admittedAt: receivedAt + 1_500, lane: 'cloudflare', executor: 'runner' },
    agentPrompt: async ({ onDispatchSent, onTurnWork }) => {
      await timedStateRpc('settingGet', Promise.resolve({ ok: true }));
      onDispatchSent?.();
      onTurnWork?.({ modelSteps: 2, toolCalls: 1, toolMs: 640 });
      return AGENT_ANSWER;
    },
  }, dmAssignment);
  const latency = records.find((record) => record.event === 'turn_latency');
  assert.ok(Number(latency?.receiptToModelStartMs) >= 2_500, `model start counts from receipt: ${latency?.receiptToModelStartMs}`);
  assert.ok(Number(latency?.admissionToModelStartMs) >= 1_000);
  assert.ok(Number(latency?.receiptToFinalMs) >= Number(latency?.receiptToModelStartMs));
  assert.deepEqual([latency?.modelSteps, latency?.toolCalls, latency?.toolMs], [2, 1, 640]);
  const rpcs = records.find((record) => record.event === 'state_rpc_summary');
  assert.equal(rpcs?.scope, 'turn');
  assert.equal(rpcs?.turnRef, latency?.turnRef);
  assert.ok(Number(rpcs?.callsBeforeModelStart) >= 1, 'the call before the dispatch counts');
});

// Defect caught: the plan's model, image-role, browser and login reads
// waiting for its workspace, connection and previous-plan reads: two rounds
// to the state store, one after the other, instead of one.
test("the plan's independent reads go to the state store in one round", async () => {
  const { timeline } = await firstStatusTimeline('dm', null, {
    // The previous plan's read answers only once the image role was asked for (or after the bound).
    getBoundRuntimePlan: async () => {
      currentTimeline.push('turnJobs.getBoundRuntimePlan');
      await waitUntil(() => currentTimeline.includes('config.getAgentModelRole'));
      currentTimeline.push('answered:turnJobs.getBoundRuntimePlan');
      return undefined;
    },
  }, dmAssignment);
  const role = timeline.indexOf('config.getAgentModelRole');
  assert.ok(role >= 0, `the image role was read: ${timeline.join(' ')}`);
  assert.ok(role < timeline.indexOf('answered:turnJobs.getBoundRuntimePlan'),
    `it did not wait for the previous plan's read: ${timeline.join(' ')}`);
  assert.ok(timeline.includes('agentPrompt'), 'the turn dispatched');
});

// Defects caught: a freeze that wakes the object admission already woke (two
// wakes per turn), a lead counted from the freeze when admission's wake came
// first; and when admission woke another instance, a freeze that then skips
// its own object's wake or counts its lead from admission's.
test("admission's wake of the instance the plan names stands; one of another instance changes nothing", async (t) => {
  const latency: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if ((record as { event?: unknown } | undefined)?.event === 'turn_latency') {
      latency.push(record as Record<string, unknown>);
    }
  });
  const frozenInstance = `agent_${'d'.repeat(40)}`;
  const run = async (admissionAgentWake?: RunTurnOptions['admissionAgentWake']) => {
    const events: string[] = [];
    await firstStatusTimeline('dm', null, {
      turnLatency: { lane: 'cloudflare', executor: 'runner' },
      ...(admissionAgentWake ? { admissionAgentWake } : {}),
      onRuntimePlan: async (candidate) => {
        events.push('freeze');
        return { runtimePlan: candidate, instanceId: frozenInstance };
      },
      wakeAgentObject: async (id) => { events.push(`wake:${id}`); },
      agentPrompt: async ({ onAgentStaged }) => {
        events.push('stage');
        await new Promise((resolve) => setTimeout(resolve, 25));
        onAgentStaged?.(0);
        return AGENT_ANSWER;
      },
    }, dmAssignment);
    return { events, record: latency.at(-1)! };
  };
  const sentAt = Date.now() - 5_000;
  const admitted = await run({ instanceId: frozenInstance, sentAt });
  assert.deepEqual(admitted.events, ['freeze', 'stage'], 'no second wake of the object admission woke');
  assert.equal(admitted.record.agentWakeSource, 'admission');
  assert.ok(Number(admitted.record.agentWakeLeadMs) >= 5_000, `the lead counts from admission's wake: ${admitted.record.agentWakeLeadMs}`);

  const baseline = await run();
  const other = await run({ instanceId: `agent_${'e'.repeat(40)}`, sentAt });
  assert.deepEqual(other.events, baseline.events, 'the turn freezes, wakes and stages as with no admission wake');
  assert.deepEqual(other.events, ['freeze', `wake:${frozenInstance}`, 'stage']);
  assert.equal(other.record.agentWakeSource, 'plan');
  assert.ok(Number(other.record.agentWakeLeadMs) < 5_000, `the lead counts from the freeze's wake: ${other.record.agentWakeLeadMs}`);
});

// Defect caught: a wake hung on anything but this attempt's freeze (an
// instance already known, the thread key) reaches a turn that never stages.
test('a replayed turn, a command, and a turn stopped before dispatch send no wake', async () => {
  const wakes: string[] = [];
  const wakeAgentObject = async (id: string) => { wakes.push(id); };
  let decision: FrozenRuntimePlanDecision | undefined;
  const fresh = await firstStatusTimeline('dm', null, {
    wakeAgentObject,
    onRuntimePlan: async (candidate) => {
      decision = { runtimePlan: candidate, instanceId: deriveRuntimePlanInstanceId(candidate) };
      return decision;
    },
  }, dmAssignment);
  assert.ok(fresh.timeline.includes('agentPrompt'), 'the same turn shape dispatches when it freezes its plan');
  assert.equal(wakes.length, 1, 'and wakes its Agent object');
  wakes.length = 0;
  const replayed = await firstStatusTimeline('dm', null, {
    wakeAgentObject,
    replayText: 'The recorded answer.',
    ...(decision ? { runtimePlanDecision: decision } : {}),
  }, dmAssignment);
  const command = await firstStatusTimeline('dm', null, { wakeAgentObject }, dmAssignment, { text: '!memory help' });
  const stopped = await firstStatusTimeline('dm', null, {
    wakeAgentObject,
    stopEnding: {
      beforeDispatch: true,
      finish: async () => ({ stopperUserId: 'U_STOPPER', unread: 1, pullRequests: [], windingDown: false }),
    },
  }, dmAssignment);
  for (const { timeline } of [replayed, command, stopped]) {
    assert.equal(timeline.includes('agentPrompt'), false, `it never dispatches: ${timeline.join(' ')}`);
  }
  assert.deepEqual(wakes, []);
});

// Defects caught: the turn awaits the wake, or lets its failure escape.
test('a wake that rejects, throws, or never answers does not hold or fail the turn', async () => {
  const wakes = [
    async () => { throw new Error('no such method'); },
    () => { throw new Error('binding unavailable'); },
    () => new Promise<void>(() => undefined),
  ] as Array<(id: string) => Promise<void>>;
  for (const wakeAgentObject of wakes) {
    const { timeline } = await firstStatusTimeline('dm', null, { wakeAgentObject }, dmAssignment);
    assert.ok(timeline.includes('agentPrompt'), `the turn still dispatched: ${timeline.join(' ')}`);
  }
});

// Defect caught: a turn already judged react_only, which never stages, wakes anyway.
test('a turn judged react_only before its plan is saved sends no wake', async () => {
  platformEnv = fakeClefEnv('react_only').env;
  classifierAnswer = JSON.stringify({ disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' });
  holdClassifierAnswer = async () => undefined;
  const wakes: string[] = [];
  let judged!: () => void;
  const judgment = new Promise<void>((resolve) => { judged = resolve; });
  await withScriptedClassifier(async () => {
    const { timeline } = await firstStatusTimeline('dm', null, {
      wakeAgentObject: async (id) => { wakes.push(id); },
      onInteractionIntent: async () => { judged(); },
      onRuntimePlan: async (candidate) => {
        await judgment;
        return { runtimePlan: candidate, instanceId: deriveRuntimePlanInstanceId(candidate) };
      },
    }, classifiedAssignment);
    assert.equal(timeline.includes('agentPrompt'), false, `no dispatch: ${timeline.join(' ')}`);
  });
  assert.deepEqual(wakes, []);
});

/**
 * `store` with `methods` held until `held` resolves, once the Agent is
 * prompted (the classifier records its usage before); each landing is marked
 * `landed:<label>.<method>`.
 */
function heldUntil<T extends object>(label: string, store: T, methods: readonly string[], held: Promise<void>): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || !methods.includes(String(property)) ||
          !currentTimeline.includes('agentPrompt')) return value;
      return async (...args: unknown[]) => {
        currentTimeline.push(`${label}.${String(property)}`);
        await held;
        const result = await (value as (...values: unknown[]) => unknown).apply(target, args);
        currentTimeline.push(`landed:${label}.${String(property)}`);
        return result;
      };
    },
  });
}

// Defect caught: turn_latency marks the reply's text only at final, after the
// stream's stop, the reply's cards and the status clear.
test('the reply text is marked visible when Slack acknowledges the stream start, before the stop', async (t) => {
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if ((record as { event?: unknown } | undefined)?.event === 'turn_latency') records.push(record as Record<string, unknown>);
  });
  holdSlackWrite = async (method) => {
    if (method === 'chat.stopStream') await new Promise((resolve) => setTimeout(resolve, 40));
  };
  const receivedAt = Date.now() - 1_000;
  try {
    await firstStatusTimeline('dm', null, {
      turnLatency: { receivedAt, admittedAt: receivedAt + 500, lane: 'cloudflare', executor: 'runner' },
    }, dmAssignment);
  } finally {
    holdSlackWrite = undefined;
  }
  const latency = records.find((record) => record.event === 'turn_latency');
  const visible = Number(latency?.receiptToAnswerVisibleMs);
  assert.ok(visible >= 1_000, `visible counts from receipt: ${latency?.receiptToAnswerVisibleMs}`);
  assert.equal(visible - Number(latency?.admissionToAnswerVisibleMs), 500);
  assert.ok(visible + 40 <= Number(latency?.receiptToFinalMs),
    `the stop's 40 ms come after the text: ${visible} < ${latency?.receiptToFinalMs}`);
});

// Defect caught: the reply waits for the answer's usage record and its Work
// settlement, response and delivery records before Slack sees it, each up to
// its 100 ms budget.
test('the reply goes out before its usage and Work records land, and the usage record lands before the turn is marked delivered', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => { warnings.push(values.map(String).join(' ')); });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const real = resolveStores();
  holdSlackWrite = async (method, timeline) => {
    if (method === 'chat.startStream') {
      timeline.push('records released at the stream start');
      release();
    }
  };
  let timeline: string[];
  try {
    ({ timeline } = await firstStatusTimeline('dm', null, {
      usageRecordingEnabled: true,
      usageStore: heldUntil('usage', real.usage, ['recordTerminal'], held),
      workStore: heldUntil('work', real.work, ['settleRunExecution', 'recordRunResponse', 'startRunDelivery'], held),
      onDelivered: async () => { currentTimeline.push('delivered'); },
    }, dmAssignment));
  } finally {
    holdSlackWrite = undefined;
    release();
  }
  const at = (entry: string) => {
    const index = timeline.indexOf(entry);
    assert.ok(index >= 0, `${entry} in ${JSON.stringify(timeline)}`);
    return index;
  };
  const start = at('slack:chat.startStream');
  for (const record of ['usage.recordTerminal', 'work.settleRunExecution']) {
    assert.ok(at(record) < start, `${record} starts before the reply`);
    assert.ok(start < at(`landed:${record}`), `the reply does not wait for ${record}`);
  }
  assert.ok(start < at('work.recordRunResponse'), 'the response record queues behind the held settlement');
  assert.ok(at('landed:usage.recordTerminal') < at('delivered'), 'the usage record lands before the turn is marked delivered');
  assert.deepEqual(warnings.filter((warning) => /budget|timed_out/.test(warning)), [],
    'no record outlived its budget while the reply waited');
});

// Defect caught: the answer's display components are read only after its
// settlement record lands, one more round before the reply.
test("the answer's display components are read beside its settlement record", async () => {
  const { timeline } = await firstStatusTimeline('dm', null, {
    agentPrompt: async ({ onSettlementObserved }) => {
      onSettlementObserved?.(AGENT_ANSWER);
      await waitUntil(() => currentTimeline.includes('slackState.executeUiSurface'));
      currentTimeline.push('settlement recorded');
      return AGENT_ANSWER;
    },
  }, dmAssignment);
  assert.ok(timeline.indexOf('slackState.executeUiSurface') >= 0, JSON.stringify(timeline));
  assert.ok(timeline.indexOf('slackState.executeUiSurface') < timeline.indexOf('settlement recorded'),
    'the components are read while the settlement is recorded');
});

// Defect caught: the reply's thread-context record holds the reply's cards
// and the status clear behind it.
test("the reply's thread context is recorded beside its cleanup, before the turn is marked delivered", async () => {
  const clears = () => currentTimeline.filter((entry) => entry === 'slack:assistant.threads.setStatus').length;
  const { timeline } = await firstStatusTimeline('dm', null, {
    onPublicMessageDelivered: async () => {
      currentTimeline.push('public context');
      await waitUntil(() => clears() >= 2);
      currentTimeline.push('public context recorded');
    },
    onDelivered: async () => { currentTimeline.push('delivered'); },
  }, dmAssignment);
  const clear = timeline.lastIndexOf('slack:assistant.threads.setStatus');
  assert.ok(timeline.indexOf('public context') < clear, JSON.stringify(timeline));
  assert.ok(clear < timeline.indexOf('public context recorded'), 'the status clears while the context is recorded');
  assert.ok(timeline.indexOf('public context recorded') < timeline.indexOf('delivered'));
});

// Defect caught: the turn looks for the approval card it owes only after the
// reply and its other cards are out, two more reads before its status clears.
test('the approval a reply owes is looked up while the reply is delivered', async () => {
  const lookedUp = () => currentTimeline.indexOf('identity.resolveSlackIdentity', currentTimeline.indexOf('agentPrompt')) >= 0;
  holdSlackWrite = async (method) => {
    if (method === 'chat.stopStream') await waitUntil(lookedUp);
  };
  let timeline: string[];
  try {
    ({ timeline } = await firstStatusTimeline('dm', null, {}, dmAssignment));
  } finally {
    holdSlackWrite = undefined;
  }
  const lookups = timeline.slice(timeline.indexOf('agentPrompt'))
    .filter((entry) => entry === 'identity.resolveSlackIdentity').length;
  const lookup = timeline.indexOf('identity.resolveSlackIdentity', timeline.indexOf('agentPrompt'));
  assert.ok(lookup >= 0, JSON.stringify(timeline));
  assert.ok(lookup < timeline.indexOf('slack:chat.stopStream'), 'the lookup ran before the stream stopped');
  assert.equal(lookups, 1, 'the card posts from that lookup, without a second one');
});
