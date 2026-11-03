import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { activityStatus } from '../src/activity/status.ts';
import { deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { showAdmissionStatus } from '../src/slack/admission-activity.ts';
import { SlackAgentViewPresentation } from '../src/slack/agent-view-presentation.ts';
import type { FoldedMessage } from '../src/slack/follow-ups.ts';
import type { SlackStopNoteFacts } from '../src/slack/web-client-presenter.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackRunPresentation,
  type SlackRunPresentationV3,
} from '../src/slack/run-presentations.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

/**
 * Maintainer ruling: "send native first and then replace with custom". A V3
 * turn starts Slack's native processing indicator (the fast write), then hands
 * the session to the custom assistant status: Slack acknowledges but does not
 * render custom text while the session is in native processing (seen live on
 * Violet, #198), so the session leaves native processing just before the
 * custom write, which moves it back to processing carried by the custom text.
 */

const assignment: ResolvedAssignment = {
  workspaceId: 'T_NATIVE_FIRST',
  channelId: 'C_NATIVE_FIRST',
  agentId: 'agent_native_first',
  model: 'local-stub/native-first',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_native_first',
    kind: 'user',
    revision: 1,
    name: 'Native First',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

// A turn that reaches the Agent prepares memory from the local state store.
const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-native-first-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

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
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

function surfaceTurn(surface: 'channel' | 'dm', messageTs: string): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: surface === 'dm' ? 'D_NATIVE_FIRST' : 'C_NATIVE_FIRST',
    channelType: surface === 'dm' ? 'im' : 'channel',
    eventId: `Ev_NATIVE_FIRST_${surface}_${messageTs}`,
    text: 'Summarize the release notes.',
    userId: 'U_NATIVE_FIRST',
    messageTs,
    threadTs: messageTs,
    source: surface === 'dm' ? 'dm_message' : 'app_mention',
    contextMode: surface === 'dm' ? 'dm_history' : 'thread',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

function harness(turn: NormalizedSlackTurn, options: {
  rejectCustom?: boolean;
  /** Per-workspace activity reservations, in order; reserved once they run out. */
  reservations?: Array<'reserved' | 'cooldown'>;
  /** Slack rejects the native session start. */
  rejectNativeStart?: boolean;
  /** An admitted canonical Run, for turns that reach the Agent. */
  runId?: string;
} = {}) {
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const runId = options.runId ?? `run_native_first_${turn.messageTs.replace('.', '_')}`;
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Native First',
      avatarUrl: 'https://chickpea.example/assets/agents/native/avatar/1',
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
  const effects: string[] = [];
  const client = {
    apiCall: async (_method: string, input: Record<string, unknown>) => {
      if (options.rejectNativeStart && input.status === 'processing') {
        effects.push('session:processing:rejected');
        throw Object.assign(new Error('not_allowed'), {
          code: ErrorCode.PlatformError,
          data: { ok: false, error: 'not_allowed' },
        });
      }
      effects.push(`session:${String(input.status)}`);
      return { ok: true };
    },
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      if (input.status && options.rejectCustom) {
        effects.push('custom:rejected');
        throw Object.assign(new Error('not_allowed'), {
          code: ErrorCode.PlatformError,
          data: { ok: false, error: 'not_allowed' },
        });
      }
      effects.push(input.status ? `custom:${String(input.status)}` : 'custom:clear');
      return { ok: true };
    } } },
    conversations: {
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    reactions: { add: async () => { effects.push('reaction'); return { ok: true }; } },
    chat: {
      startStream: async () => { effects.push('final'); return { ok: true, ts: '1790000100.000100' }; },
      stopStream: async () => ({ ok: true }),
      postMessage: async () => { effects.push('final'); return { ok: true, ts: '1790000100.000100' }; },
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
    ...(options.reservations
      ? {
          // A refused reservation (a workspace cooldown) makes no Slack call
          // and does not latch the status off, unlike a Slack rejection.
          reserveSlackActivityStatus: () => {
            const outcome = options.reservations!.shift() ?? 'reserved';
            effects.push(`reserve:${outcome}`);
            return outcome === 'reserved'
              ? { outcome: 'reserved' as const, budgetVersion: 1 }
              : { outcome: 'cooldown' as const, retryAt: Date.now() + 1_000, budgetVersion: 1 };
          },
          applySlackActivityStatusCooldown: () => ({ cooldownUntil: Date.now() + 1_000, budgetVersion: 1 }),
        }
      : {}),
  };
  return { db, store, runId, effects, client, state };
}

async function answer(turn: NormalizedSlackTurn, h: ReturnType<typeof harness>) {
  await runTurn(turn, assignment, undefined, {
    client: h.client,
    runId: h.runId,
    turnId: `turn_${h.runId}`,
    presentationState: h.state,
    replayText: 'Release notes summarized.',
    usageRecordingEnabled: false,
  });
}

for (const surface of ['channel', 'dm'] as const) {
  test(`${surface}: native processing starts first, then hands over to the custom status`, async () => {
    const turn = surfaceTurn(surface, surface === 'dm' ? '1790000001.000100' : '1790000002.000100');
    const h = harness(turn);
    try {
      await answer(turn, h);
      assert.deepEqual(h.effects, [
        'session:processing', // the fast first write
        'session:active', // leaves native processing so the custom text renders
        'custom:Preparing your request…',
        'final',
        'session:active', // settled after the final
        'custom:clear',
      ]);
      const stored = h.store.get(h.runId);
      assert.equal(stored?.schemaVersion, 3);
      if (stored?.schemaVersion !== 3) return;
      // Durable receipts: the session was acknowledged processing, then settled.
      assert.equal(stored.agentSession.desired, 'active');
      assert.equal(stored.agentSession.acknowledged, 'active');
      assert.equal(stored.agentSession.operation?.certainty, 'acknowledged');
      assert.equal(stored.currentActivity?.operation.certainty, 'acknowledged');
      assert.equal(stored.activityProjection.state, 'cleared');
      assert.equal(stored.repairRequired, false);
    } finally { h.db.close(); }
  });
}

test('the native start is recorded durably before the handover, which records nothing', async () => {
  const turn = surfaceTurn('channel', '1790000003.000100');
  const h = harness(turn);
  const sessionReceipts: string[] = [];
  const transition = h.state.transitionRunPresentation;
  h.state.transitionRunPresentation = (input) => {
    const result = transition(input);
    if (result.outcome === 'applied' && result.presentation.schemaVersion === 3) {
      const session = result.presentation.agentSession;
      sessionReceipts.push(`${session.desired}/${session.acknowledged}/${session.operation?.certainty}`);
    }
    return result;
  };
  try {
    await answer(turn, h);
    assert.deepEqual(sessionReceipts.filter((entry, index, all) => all.indexOf(entry) === index), [
      'processing/none/pending',
      'processing/processing/acknowledged',
      'active/processing/pending',
      'active/active/acknowledged',
    ], 'the session is recorded as processing until the turn settles it');
  } finally { h.db.close(); }
});

test('a rejected custom status shows native processing again, without a second start', async () => {
  const turn = surfaceTurn('channel', '1790000004.000100');
  const h = harness(turn, { rejectCustom: true });
  try {
    await answer(turn, h);
    assert.deepEqual(h.effects.filter((effect) => effect !== 'custom:clear'), [
      'session:processing',
      'session:active',
      'custom:rejected',
      'session:processing', // reasserted: nothing custom is visible
      'final',
      'session:active',
    ]);
  } finally { h.db.close(); }
});

test('a retry that stopped after the native start hands over before its custom write', async () => {
  const turn = surfaceTurn('dm', '1790000005.000100');
  const h = harness(turn);
  try {
    // The earlier attempt started native processing and stopped there.
    const view = new SlackAgentViewPresentation({
      client: h.client, state: h.state, runId: h.runId, runFencingToken: 0,
      footer: { agentName: 'Native First', agentId: assignment.agentId },
    });
    assert.equal(await view.beginAgentSessionProcessing(), true);
    h.effects.length = 0;
    await answer(turn, h);
    assert.deepEqual(h.effects.slice(0, 2), ['session:active', 'custom:Preparing your request…'],
      'no second native start; the handover precedes the custom write');
  } finally { h.db.close(); }
});

test('a retry whose custom status is known visible keeps it, with no handover', async () => {
  const turn = surfaceTurn('channel', '1790000007.000100');
  const h = harness(turn);
  try {
    // The earlier attempt started native, handed over, and its custom status
    // was acknowledged visible before it stopped.
    const view = new SlackAgentViewPresentation({
      client: h.client, state: h.state, runId: h.runId, runFencingToken: 0,
      footer: { agentName: 'Native First', agentId: assignment.agentId },
    });
    assert.equal(await view.beginAgentSessionProcessing(), true);
    const write = await view.beginActivity(
      { kind: 'preparing', action: 'Preparing', object: 'your request', text: 'Preparing your request…' },
      'assistant_status',
    );
    assert.ok(write);
    await view.recordActivityReceipt(write.operationId, 'acknowledged');
    h.effects.length = 0;
    await answer(turn, h);
    assert.equal(h.effects.includes('session:processing'), false, 'no native write');
    assert.deepEqual(h.effects.slice(-2), ['session:active', 'custom:clear'], 'settled, then cleared');
    assert.equal(h.effects.filter((effect) => effect === 'session:active').length, 1,
      'the only session write is the settle: no handover');
  } finally { h.db.close(); }
});

test('the handover never touches a thread whose newer message another turn presents', async () => {
  const turn = surfaceTurn('channel', '1790000008.000100');
  const h = harness(turn);
  try {
    const view = new SlackAgentViewPresentation({
      client: h.client, state: h.state, runId: h.runId, runFencingToken: 0,
      footer: { agentName: 'Native First', agentId: assignment.agentId },
    });
    assert.equal(await view.releaseNativeProcessing(), false, 'nothing to release before a native start');
    assert.equal(await view.beginAgentSessionProcessing(), true);
    h.state.getLatestThreadSessionGeneration = () => Number.MAX_SAFE_INTEGER;
    h.effects.length = 0;
    assert.equal(await view.releaseNativeProcessing(), false);
    assert.equal(await view.reassertNativeProcessing(), false);
    assert.deepEqual(h.effects, []);
  } finally { h.db.close(); }
});

test('after native is shown again, the next custom write hands over again', async () => {
  // A DM: its Agent memory has an owner in this fixture, so the turn reaches the Agent.
  const turn = surfaceTurn('dm', '1790000009.000100');
  const dmAssignment: ResolvedAssignment = { ...assignment, channelId: turn.channelId };
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: dmAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const h = harness(turn, { reservations: ['cooldown'], runId: admitted.run.id });
  const registry = new SlackStatusRegistry();
  const observed = activityStatus('reading', 'Reading', 'the thread');
  try {
    await runTurn(turn, dmAssignment, undefined, {
      client: h.client,
      runId: h.runId,
      turnId: `turn_${h.runId}`,
      presentationState: h.state,
      statusRegistry: registry,
      workStore: work,
      usageRecordingEnabled: false,
      agentPrompt: async ({ runtimePlan, conversationKey }) => {
        // Activity the Agent reports while it works: a later custom write.
        const instanceId = runtimePlan ? deriveRuntimePlanInstanceId(runtimePlan) : conversationKey;
        assert.equal(registry.setObservedStatus(instanceId, `turn_${h.runId}`, observed), true);
        for (let tries = 0; tries < 50 && !h.effects.includes(`custom:${observed.text}`); tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          text: 'Done.',
          requestedModel: assignment.model ?? null,
          returnedModel: null,
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
    });
    const start = h.effects.slice(0, h.effects.indexOf('final'));
    assert.deepEqual(start, [
      'session:processing',
      'session:active', // handed over
      'reserve:cooldown', // the first custom write is refused; nothing custom shows
      'session:processing', // native shown again
      'session:active', // handed over again
      'reserve:reserved',
      `custom:${observed.text}`,
    ]);
  } finally { h.db.close(); work.close(); }
});

test('a retry whose native start failed but whose custom status is visible starts no native', async () => {
  const turn = surfaceTurn('dm', '1790000010.000100');
  const h = harness(turn, { rejectNativeStart: true });
  try {
    // The earlier attempt's native start was rejected; its custom status was
    // then shown and acknowledged before it stopped.
    const view = new SlackAgentViewPresentation({
      client: h.client, state: h.state, runId: h.runId, runFencingToken: 0,
      footer: { agentName: 'Native First', agentId: assignment.agentId },
    });
    assert.equal(await view.beginAgentSessionProcessing(), false);
    const write = await view.beginActivity(
      { kind: 'preparing', action: 'Preparing', object: 'your request', text: 'Preparing your request…' },
      'assistant_status',
    );
    assert.ok(write);
    await view.recordActivityReceipt(write.operationId, 'acknowledged');
    h.effects.length = 0;
    await answer(turn, h);
    assert.equal(h.effects.some((effect) => effect.startsWith('session:processing')), false,
      'a native start would hide the visible custom text');
    assert.deepEqual(h.effects.slice(-2), ['session:active', 'custom:clear'], 'settled, then cleared');
  } finally { h.db.close(); }
});

test('a quiet run shows native processing again, and progress releases it before the custom text', async () => {
  // A DM: its Agent memory has an owner in this fixture, so the turn reaches the Agent.
  const turn = surfaceTurn('dm', '1790000011.000100');
  const dmAssignment: ResolvedAssignment = { ...assignment, channelId: turn.channelId };
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: dmAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const h = harness(turn, { runId: admitted.run.id });
  // Five quiet minutes, shortened for the test.
  const registry = new SlackStatusRegistry({ quietAfterMs: 50 });
  const observed = activityStatus('reading', 'Reading', 'the thread');
  const waitFor = async (condition: () => boolean) => {
    for (let tries = 0; tries < 100 && !condition(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(condition(), JSON.stringify(h.effects));
  };
  try {
    await runTurn(turn, dmAssignment, undefined, {
      client: h.client,
      runId: h.runId,
      turnId: `turn_${h.runId}`,
      presentationState: h.state,
      statusRegistry: registry,
      workStore: work,
      usageRecordingEnabled: false,
      agentPrompt: async ({ runtimePlan, conversationKey }) => {
        const shown = 'custom:Preparing your request…';
        await waitFor(() => h.effects.lastIndexOf('session:processing') > h.effects.indexOf(shown) &&
          h.effects.includes(shown));
        // Tool activity after the quiet stretch: real progress.
        const instanceId = runtimePlan ? deriveRuntimePlanInstanceId(runtimePlan) : conversationKey;
        assert.equal(registry.setObservedStatus(instanceId, `turn_${h.runId}`, observed), true);
        await waitFor(() => h.effects.includes(`custom:${observed.text}`));
        return {
          text: 'Done.',
          requestedModel: assignment.model ?? null,
          returnedModel: null,
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
    });
    assert.deepEqual(h.effects.slice(0, 6), [
      'session:processing',
      'session:active', // handed over
      'custom:Preparing your request…',
      'session:processing', // quiet: Slack's working indicator and its Stop button
      'session:active', // released first, so the custom text renders
      `custom:${observed.text}`,
    ]);
    assert.deepEqual(h.effects.slice(-2), ['session:active', 'custom:clear'], 'settled, then cleared');
  } finally { h.db.close(); work.close(); }
});

test('KTD6: a quiet stretch keeps native processing alive, the next custom write releases it first, and the terminal ends it', async () => {
  // A DM: its Agent memory has an owner in this fixture, so the turn reaches the Agent.
  const turn = surfaceTurn('dm', '1790000012.000100');
  const dmAssignment: ResolvedAssignment = { ...assignment, channelId: turn.channelId };
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: dmAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const h = harness(turn, { runId: admitted.run.id });
  // Five quiet minutes and the 45-minute keepalive, shortened for the test.
  const registry = new SlackStatusRegistry({ quietAfterMs: 50, nativeKeepaliveMs: 60 });
  const observed = activityStatus('reading', 'Reading', 'the thread');
  const shown = 'custom:Preparing your request…';
  const waitFor = async (condition: () => boolean) => {
    for (let tries = 0; tries < 100 && !condition(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(condition(), JSON.stringify(h.effects));
  };
  const nativeAfterShown = () => h.effects.slice(h.effects.indexOf(shown) + 1)
    .filter((effect) => effect === 'session:processing').length;
  try {
    await runTurn(turn, dmAssignment, undefined, {
      client: h.client,
      runId: h.runId,
      turnId: `turn_${h.runId}`,
      presentationState: h.state,
      statusRegistry: registry,
      workStore: work,
      usageRecordingEnabled: false,
      agentPrompt: async ({ runtimePlan, conversationKey }) => {
        // Quiet: the native indicator, then a keepalive of it.
        await waitFor(() => h.effects.includes(shown) && nativeAfterShown() >= 2);
        // Tool activity after the quiet stretch: real progress.
        const instanceId = runtimePlan ? deriveRuntimePlanInstanceId(runtimePlan) : conversationKey;
        assert.equal(registry.setObservedStatus(instanceId, `turn_${h.runId}`, observed), true);
        await waitFor(() => h.effects.includes(`custom:${observed.text}`));
        return {
          text: 'Done.',
          requestedModel: assignment.model ?? null,
          returnedModel: null,
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
    });
    const custom = h.effects.indexOf(`custom:${observed.text}`);
    assert.deepEqual(h.effects.slice(0, 3), ['session:processing', 'session:active', shown]);
    const quiet = h.effects.slice(3, custom - 1);
    assert.ok(quiet.length >= 2, JSON.stringify(h.effects));
    assert.ok(
      quiet.every((effect) => effect === 'session:processing'),
      'quiet: Slack\'s working indicator, then keepalives of it (its Stop button stays)',
    );
    assert.deepEqual(h.effects.slice(custom - 1, custom + 1), [
      'session:active', // the keepalive left native held: released first, so the custom text renders
      `custom:${observed.text}`,
    ]);
    const settled = h.effects.length;
    assert.deepEqual(h.effects.slice(-2), ['session:active', 'custom:clear'], 'settled, then cleared');
    // The terminal ends the keepalive: nothing re-sends processing afterwards.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(h.effects.length, settled, JSON.stringify(h.effects.slice(settled)));
  } finally { h.db.close(); work.close(); }
});

test('KTD6: a run that ends while quiet stops its keepalive at the terminal', async () => {
  const turn = surfaceTurn('dm', '1790000013.000100');
  const dmAssignment: ResolvedAssignment = { ...assignment, channelId: turn.channelId };
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: dmAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const h = harness(turn, { runId: admitted.run.id });
  const registry = new SlackStatusRegistry({ quietAfterMs: 50, nativeKeepaliveMs: 40 });
  const shown = 'custom:Preparing your request…';
  const nativeAfterShown = () => h.effects.slice(h.effects.indexOf(shown) + 1)
    .filter((effect) => effect === 'session:processing').length;
  try {
    await runTurn(turn, dmAssignment, undefined, {
      client: h.client,
      runId: h.runId,
      turnId: `turn_${h.runId}`,
      presentationState: h.state,
      statusRegistry: registry,
      workStore: work,
      usageRecordingEnabled: false,
      agentPrompt: async () => {
        for (let tries = 0; tries < 100 && !(h.effects.includes(shown) && nativeAfterShown() >= 3); tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(nativeAfterShown() >= 3, JSON.stringify(h.effects));
        return {
          text: 'Done.',
          requestedModel: assignment.model ?? null,
          returnedModel: null,
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
    });
    const final = h.effects.indexOf('final');
    assert.ok(final > 0, JSON.stringify(h.effects));
    assert.equal(h.effects.slice(final).includes('session:processing'), false, JSON.stringify(h.effects));
    const settled = h.effects.length;
    assert.deepEqual(h.effects.slice(-2), ['session:active', 'custom:clear'], 'settled, then cleared');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(h.effects.length, settled, 'no keepalive after the terminal');
  } finally { h.db.close(); work.close(); }
});

/**
 * The status the state store shows before a turn's hand-off
 * (showAdmissionStatus, called by TagStateStore.showStatusAtHandoff), on the
 * harness's row. Returns the time the hand-off carries.
 */
async function showAtAdmission(h: ReturnType<typeof harness>): Promise<number> {
  const presentation = h.store.get(h.runId) as SlackRunPresentationV3;
  const mark = await showAdmissionStatus({
    presentation,
    agentId: assignment.agentId,
    state: h.state,
    client: async () => h.client,
    commit: (shown) => h.store.putSnapshot(shown),
  });
  assert.ok(mark.shownAt !== undefined, 'the status showed before the hand-off');
  return mark.shownAt;
}

/** What a person sees of a Run at its end, and what its record says shows. */
function visibleEnd(h: ReturnType<typeof harness>) {
  const stored = h.store.get(h.runId) as SlackRunPresentation;
  assert.equal(stored.schemaVersion, 3);
  const custom = h.effects.filter((effect) => effect.startsWith('custom:'));
  const sessions = h.effects.filter((effect) => effect.startsWith('session:'));
  return {
    statusLeftShowing: custom.length > 0 && custom.at(-1) !== 'custom:clear',
    sessionLastWord: sessions.at(-1),
    replied: h.effects.includes('final') || h.effects.includes('reaction'),
    projectionState: stored.schemaVersion === 3 && stored.activityProjection.state === 'visible' ? 'visible' : 'not_visible',
    sessionAcknowledged: stored.schemaVersion === 3 ? stored.agentSession.acknowledged : undefined,
  };
}

// Defects caught: a runner that starts native processing (which would hide
// the status admission showed) or writes the opening status again, on its
// start or as an immediate refresh, and one that leaves it showing.
test('a status the state store showed before the hand-off is kept: no native start, no second write, then settled and cleared', async () => {
  const run = async (ts: string, shownFirst: boolean) => {
    const turn = surfaceTurn('dm', ts);
    const dmAssignment: ResolvedAssignment = { ...assignment, channelId: turn.channelId };
    const work = new SqliteWorkStore(':memory:');
    const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
      turn, assignment: dmAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
    }));
    const h = harness(turn, { runId: admitted.run.id });
    try {
      const shownAt = shownFirst ? await showAtAdmission(h) : undefined;
      if (shownFirst) {
        assert.deepEqual(h.effects, ['custom:Preparing your request…'],
          'admission shows the custom status itself, with no native processing to hide it');
      }
      await runTurn(turn, dmAssignment, undefined, {
        client: h.client,
        runId: h.runId,
        turnId: `turn_${h.runId}`,
        presentationState: h.state,
        statusRegistry: new SlackStatusRegistry(),
        workStore: work,
        usageRecordingEnabled: false,
        // The hand-off's mark, as the runner gives it to the first attempt.
        ...(shownAt === undefined
          ? {}
          : { turnLatency: { lane: 'cloudflare' as const, executor: 'runner' as const, admissionStatusAt: shownAt } }),
        agentPrompt: async () => {
          // Long enough for a refresh made at the start to land.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            text: 'Done.', requestedModel: assignment.model ?? null, returnedModel: null,
            reportedUsage: null, usageCompleteness: 'not_reported',
          };
        },
      });
      return { effects: [...h.effects], end: visibleEnd(h) };
    } finally { h.db.close(); work.close(); }
  };
  const today = await run('1790000020.000100', false);
  const shown = await run('1790000021.000100', true);
  assert.deepEqual(today.effects.slice(0, 3), ['session:processing', 'session:active', 'custom:Preparing your request…']);
  assert.deepEqual(shown.effects, [
    'custom:Preparing your request…', // admission's, before the hand-off
    ...today.effects.slice(3), // then what today follows the runner's own opening write with
  ]);
  assert.deepEqual(shown.end, today.end, 'it ends as a turn the runner opened itself');
});

// Defects caught: a write that misses the cap yet reaches the record (the
// runner would then skip its opening writes, or find the activity mid-write
// and show nothing), and a late landing that moves the record afterwards.
test('a status write that misses the cap leaves the record as admitted, and the runner opens the turn as today', async () => {
  const turn = surfaceTurn('channel', '1790000023.000100');
  const h = harness(turn);
  let land!: () => void;
  const landing = new Promise<void>((resolve) => { land = resolve; });
  const late: string[] = [];
  const slow = {
    apiCall: async (_method: string, input: Record<string, unknown>) => {
      late.push(`session:${String(input.status)}`);
      return { ok: true };
    },
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      await landing;
      late.push(`custom:${String(input.status)}`);
      return { ok: true };
    } } },
  } as unknown as WebClient;
  try {
    const admitted = h.store.get(h.runId) as SlackRunPresentationV3;
    const mark = await showAdmissionStatus({
      presentation: admitted,
      agentId: assignment.agentId,
      state: h.state,
      client: async () => slow,
      commit: (shown) => h.store.putSnapshot(shown),
      capMs: 20,
    });
    assert.equal(mark.shownAt, undefined);
    assert.ok(mark.waitedMs >= 19, JSON.stringify(mark));
    land();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(late, ['custom:Preparing your request…'], 'the write landed after the cap');
    assert.deepEqual(h.store.get(h.runId), admitted, 'and moved no record');
    await answer(turn, h);
    assert.deepEqual(h.effects, [
      'session:processing',
      'session:active',
      'custom:Preparing your request…',
      'final',
      'session:active',
      'custom:clear',
    ], 'the runner opens the turn as it does with no write before the hand-off');
  } finally { h.db.close(); }
});

// Defect caught: a status admission showed carries the session, so native
// processing never started; without a start the quiet hand-back fails and the
// run keeps its custom text with no Stop button.
test("after the state store showed the status, a quiet run starts native processing, and progress releases it", async () => {
  const turn = surfaceTurn('dm', '1790000022.000100');
  const dmAssignment: ResolvedAssignment = { ...assignment, channelId: turn.channelId };
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: dmAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const h = harness(turn, { runId: admitted.run.id });
  const registry = new SlackStatusRegistry({ quietAfterMs: 50 });
  const observed = activityStatus('reading', 'Reading', 'the thread');
  const shown = 'custom:Preparing your request…';
  const waitFor = async (condition: () => boolean) => {
    for (let tries = 0; tries < 100 && !condition(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(condition(), JSON.stringify(h.effects));
  };
  try {
    const shownAt = await showAtAdmission(h);
    await runTurn(turn, dmAssignment, undefined, {
      client: h.client,
      runId: h.runId,
      turnId: `turn_${h.runId}`,
      presentationState: h.state,
      statusRegistry: registry,
      workStore: work,
      usageRecordingEnabled: false,
      turnLatency: { lane: 'cloudflare', executor: 'runner', admissionStatusAt: shownAt, admissionStatusMs: 5 },
      agentPrompt: async ({ runtimePlan, conversationKey }) => {
        await waitFor(() => h.effects.includes('session:processing'));
        const instanceId = runtimePlan ? deriveRuntimePlanInstanceId(runtimePlan) : conversationKey;
        assert.equal(registry.setObservedStatus(instanceId, `turn_${h.runId}`, observed), true);
        await waitFor(() => h.effects.includes(`custom:${observed.text}`));
        return {
          text: 'Done.',
          requestedModel: assignment.model ?? null,
          returnedModel: null,
          reportedUsage: null,
          usageCompleteness: 'not_reported',
        };
      },
    });
    assert.deepEqual(h.effects.slice(0, 4), [
      shown, // admission's
      'session:processing', // quiet: Slack's working indicator and its Stop button, started now
      'session:active', // released first, so the custom text renders
      `custom:${observed.text}`,
    ]);
    assert.deepEqual(h.effects.slice(-2), ['session:active', 'custom:clear'], 'settled, then cleared');
  } finally { h.db.close(); work.close(); }
});

const STOP_FACTS: SlackStopNoteFacts = { stopperUserId: 'U_NATIVE_FIRST', unread: 1, pullRequests: [], windingDown: false };
const TEAMMATE_NOTE: FoldedMessage = {
  turnJobId: 'follow_up', userId: 'U_NATIVE_FIRST', messageTs: '1790000030.000200', text: 'Only the API changes, please.',
};

// Defects caught: an ending that leaves admission's status showing (a stop
// that refused the turn's dispatch, a turn judged react_only after
// admission, a turn that read queued messages), or one whose replacement or
// clear differs from the turn the runner opened itself.
test('a stopped, reacted or folded turn after the state store showed its status ends as it does today', async () => {
  const done = async () => ({
    text: 'Done.', requestedModel: assignment.model ?? null, returnedModel: null,
    reportedUsage: null, usageCompleteness: 'not_reported' as const,
  });
  const endings: Array<[string, Partial<NormalizedSlackTurn>, Partial<RunTurnOptions>]> = [
    ['stopped before its dispatch', {}, { stopEnding: { beforeDispatch: true, finish: async () => STOP_FACTS } }],
    ['judged react_only', {
      text: 'thanks',
      interactionIntent: { disposition: 'react_only', reason: 'pure_ack', reaction: 'appreciation', target: 'trigger' },
    }, {}],
    ['reading a queued message', {}, { claimFold: async () => ({ messages: [TEAMMATE_NOTE], requesterText: '' }) }],
  ];
  let ts = 1790000040;
  for (const [name, turnFields, options] of endings) {
    const run = async (shownFirst: boolean) => {
      const turn = { ...surfaceTurn('dm', `${ts++}.000100`), ...turnFields };
      const dmAssignment: ResolvedAssignment = { ...assignment, channelId: turn.channelId };
      const work = new SqliteWorkStore(':memory:');
      const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
        turn, assignment: dmAssignment, sourceVisibility: 'private', admittedAt: Date.now(),
      }));
      const h = harness(turn, { runId: admitted.run.id });
      try {
        const shownAt = shownFirst ? await showAtAdmission(h) : undefined;
        await runTurn(turn, dmAssignment, undefined, {
          client: h.client,
          runId: h.runId,
          turnId: `turn_${h.runId}`,
          presentationState: h.state,
          statusRegistry: new SlackStatusRegistry(),
          workStore: work,
          usageRecordingEnabled: false,
          agentPrompt: done,
          ...(shownAt === undefined
            ? {}
            : { turnLatency: { lane: 'cloudflare' as const, executor: 'runner' as const, admissionStatusAt: shownAt } }),
          ...options,
        });
        return { effects: [...h.effects], end: visibleEnd(h) };
      } finally { h.db.close(); work.close(); }
    };
    const today = await run(false);
    const shown = await run(true);
    const trace = JSON.stringify([today.effects, shown.effects]);
    assert.deepEqual(shown.end, today.end, `${name}: ${trace}`);
    assert.equal(shown.end.statusLeftShowing, false, `${name}: nothing left showing`);
    assert.equal(shown.effects.includes('session:processing'), false, `${name}: no native start: ${trace}`);
    const writes = (effects: string[]) => effects.filter((effect) => effect.startsWith('custom:') && effect !== 'custom:clear');
    // A turn that runs writes what it writes today, admission's first in
    // place of the runner's own; a stop that came after admission's write
    // ends with it cleared, where today the runner never showed one.
    assert.deepEqual(writes(shown.effects), writes(today.effects).length > 0
      ? writes(today.effects)
      : ['custom:Preparing your request…'], `${name}: ${trace}`);
  }
});
