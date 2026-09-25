import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import type { ResolvedAssignment } from '../src/config/types.ts';
import { SlackAgentViewPresentation } from '../src/slack/agent-view-presentation.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

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

function harness(turn: NormalizedSlackTurn, options: { rejectCustom?: boolean } = {}) {
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const runId = `run_native_first_${turn.messageTs.replace('.', '_')}`;
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
    assert.equal(await view.startAgentSessionProcessing(), 'started');
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
    assert.equal(await view.startAgentSessionProcessing(), 'started');
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
    assert.equal(await view.startAgentSessionProcessing(), 'started');
    h.state.getLatestThreadSessionGeneration = () => Number.MAX_SAFE_INTEGER;
    h.effects.length = 0;
    assert.equal(await view.releaseNativeProcessing(), false);
    assert.equal(await view.reassertNativeProcessing(), false);
    assert.deepEqual(h.effects, []);
  } finally { h.db.close(); }
});
