import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { SlackPresentationStatePort } from '../src/slack/agent-view-presentation.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

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
  const store = new SqliteConfigStore(statePath, { agents: [] });
  await store.createAgent(assignment.agent);
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

async function firstStatusTimeline(
  surface: Surface,
  publicUrl?: string | null,
  overrides: Partial<RunTurnOptions> = {},
) {
  const timeline: string[] = [];
  turns += 1;
  const base = surfaceTurn(surface);
  // A distinct message per call, in the same Slack thread shape.
  const messageTs = `${base.messageTs.slice(0, -3)}${String(turns).padStart(3, '0')}`;
  const turn: NormalizedSlackTurn = {
    ...base,
    eventId: `${base.eventId}_${turns}`,
    messageTs,
    threadTs: surface === 'thread_follow_up' ? base.threadTs : messageTs,
  };
  const real = resolveStores();
  const admitted = await real.work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const stores = Object.fromEntries(
    Object.entries(real).map(([name, store]) => [name, counted(name, store as object, timeline)]),
  ) as unknown as AppStores;
  const db = openStateDb(':memory:');
  const presentations = new SlackRunPresentationStoreLogic(db);
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
    getRunPresentation: (id) => presentations.get(id),
    getLatestThreadSessionGeneration: (root) => {
      timeline.push('presentations.getLatestThreadSessionGeneration');
      return presentations.getLatestThreadSessionGeneration(root);
    },
    transitionRunPresentation: (input) => presentations.transition(input),
    reserveSlackAppend: (workspaceId) => presentations.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  } as SlackPresentationStatePort;
  const slack = (method: string) => async () => {
    timeline.push(`slack:${method}`);
    return { ok: true, ts: '1788000100.000100', channel: turn.channelId, messages: [] };
  };
  const client = {
    apiCall: slack('assistant.threads.setStatus(session)'),
    assistant: { threads: { setStatus: slack('assistant.threads.setStatus') } },
    reactions: { add: slack('reactions.add'), remove: slack('reactions.remove') },
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
    onInteractionIntent: async () => { timeline.push('turnJobs.recordInteractionIntent'); },
    onRuntimePlan: async (candidate) => {
      timeline.push('turnJobs.freezeRuntimePlan');
      const { deriveRuntimePlanInstanceId } = await import('../src/agents/runtime-plan.ts');
      return { runtimePlan: candidate, instanceId: deriveRuntimePlanInstanceId(candidate) };
    },
    getBoundRuntimePlan: async () => {
      timeline.push('turnJobs.getBoundRuntimePlan');
      return undefined;
    },
    agentPrompt: async () => ({
      text: 'Done.',
      requestedModel: assignment.model ?? null,
      returnedModel: null,
      reportedUsage: null,
      usageCompleteness: 'not_reported',
    }),
  };
  try {
    await runTurn(turn, assignment, undefined, { ...options, ...overrides });
  } finally {
    db.close();
  }
  const first = timeline.findIndex((entry) => entry.startsWith('slack:'));
  assert.ok(first >= 0, 'the turn wrote to Slack');
  const status = timeline.indexOf('slack:assistant.threads.setStatus');
  assert.ok(status > first, 'the admitted activity status follows the session status');
  return {
    timeline,
    beforeFirstWrite: timeline.slice(0, first),
    beforeStatus: timeline.slice(0, status).filter((entry) => !entry.startsWith('slack:')),
    slackWrites: timeline.filter((entry) => entry.startsWith('slack:')),
    firstWrite: first,
  };
}

/**
 * Before this ordering, a channel mention made 18 state-store calls (and the
 * classifier's model call) before its first Slack write, a DM 15, and a
 * thread follow-up 14: public URL, classification, memory, plan freeze, and
 * Work lifecycle, all serial. Now only the public URL precedes it, and a
 * thread runner already read that in its `begin` round trip.
 */
for (const surface of ['channel_mention', 'dm', 'thread_follow_up'] as const) {
  test(`${surface}: the first Slack write precedes classification, memory, and the plan`, async () => {
    const { beforeFirstWrite, beforeStatus, slackWrites, timeline, firstWrite } =
      await firstStatusTimeline(surface);
    assert.deepEqual(beforeFirstWrite, ['settings.getSetting'], 'only the public URL');
    assert.deepEqual(
      beforeStatus,
      ['settings.getSetting', 'presentations.getLatestThreadSessionGeneration'],
      'the admitted activity adds only the thread generation fence',
    );
    assert.deepEqual(slackWrites.slice(0, 2), [
      'slack:assistant.threads.setStatus(session)',
      'slack:assistant.threads.setStatus',
    ]);
    for (const later of ['turnJobs.freezeRuntimePlan', 'work.getRun']) {
      assert.ok(timeline.indexOf(later) > firstWrite, `${later} runs after the first status`);
    }
    if (surface !== 'thread_follow_up') {
      // Classified late: the admitted activity shows before the disposition.
      assert.ok(timeline.indexOf('turnJobs.recordInteractionIntent') > firstWrite);
    }
  });

  test(`${surface}: a runner that read the public URL at begin writes to Slack first`, async () => {
    const { beforeFirstWrite } = await firstStatusTimeline(surface, 'https://chickpea.example');
    assert.deepEqual(beforeFirstWrite, []);
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
