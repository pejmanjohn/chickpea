import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { activityStatus } from '../src/activity/status.ts';
import { deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { SlackAgentViewPresentation } from '../src/slack/agent-view-presentation.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
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
  const store = new SqliteConfigStore(statePath, { agents: [] });
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
  /** The answer was streamed: its stop is the final. */
  streamed?: boolean;
  /** The stream is old enough that Slack may have sealed it (#180). */
  agedStream?: boolean;
  /** Slack confirms a rejection of the first final post. */
  rejectFirstFinal?: boolean;
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
    chat: {
      startStream: async () => {
        if (options.rejectFirstFinal) {
          effects.push('final:rejected');
          throw Object.assign(new Error('not_allowed'), {
            code: ErrorCode.PlatformError,
            data: { ok: false, error: 'not_allowed' },
          });
        }
        effects.push(options.streamed ? 'start' : 'final');
        return { ok: true, ts: '1790000100.000100' };
      },
      stopStream: async () => {
        if (options.streamed) effects.push('final');
        return { ok: true };
      },
      postMessage: async () => {
        if (options.rejectFirstFinal) {
          options.rejectFirstFinal = false;
          effects.push('final:rejected');
          throw Object.assign(new Error('not_allowed'), {
            code: ErrorCode.PlatformError,
            data: { ok: false, error: 'not_allowed' },
          });
        }
        effects.push(options.streamed ? 'post' : 'final');
        return { ok: true, ts: '1790000100.000100' };
      },
      update: async () => { effects.push('update'); return { ok: true }; },
      delete: async () => { effects.push('delete'); return { ok: true }; },
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
  if (options.streamed) {
    // The answer's stream was started while the Agent worked.
    for (const mutation of [
      { kind: 'stream_start_intent' } as const,
      { kind: 'stream_started', messageTs: options.agedStream
        ? '1790000100.000100'
        : `${Math.floor(Date.now() / 1_000)}.000100`, flue: {
        instanceId: 'instance_native_first', submissionId: 'submission_native_first',
      } } as const,
    ]) {
      const current = store.get(runId)!;
      assert.equal(store.transition({
        runId,
        workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken,
        expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state,
        mutation,
      }).outcome, 'applied');
    }
  }
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
        'session:active', // leaves processing so the final does not re-expose it
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
    assert.deepEqual(h.effects, [
      'session:active', // the earlier custom status is released for the final
      'final',
      'session:active', // settled
      'custom:clear',
    ], 'no handover: only the release for the final, the settle, and the clear');
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
      'session:active', // released for the final
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

/**
 * Slack drops the custom status when the reply posts, which re-exposes native
 * processing ("<Agent> is working…") until the settle (seen live on Amber,
 * #207). While the custom status carries the session, the session leaves
 * processing just before the final; the durable settle still follows it.
 */
for (const surface of ['channel', 'dm'] as const) {
  for (const streamed of [false, true]) {
    test(`${surface}, ${streamed ? 'streamed' : 'not streamed'}: the session leaves processing before the final`, async () => {
      const turn = surfaceTurn(surface, `17900001${surface === 'dm' ? 1 : 2}${streamed ? 1 : 0}.000100`);
      const h = harness(turn, { streamed });
      const sessionReceipts: string[] = [];
      const transition = h.state.transitionRunPresentation;
      h.state.transitionRunPresentation = (input) => {
        const result = transition(input);
        if (result.outcome === 'applied' && result.presentation.schemaVersion === 3) {
          const session = result.presentation.agentSession;
          sessionReceipts.push(`${session.desired}/${session.acknowledged}`);
        }
        return result;
      };
      try {
        await answer(turn, h);
        assert.deepEqual(h.effects.slice(h.effects.indexOf('custom:Preparing your request…')), [
          'custom:Preparing your request…',
          'session:active', // transport only: nothing re-exposes native processing
          'final',
          'session:active', // the durable settle
          'custom:clear',
        ]);
        const final = h.effects.indexOf('final');
        assert.equal(h.effects.filter((effect, index) => index < final && effect === 'final').length, 0);
        // The release records nothing: the session leaves processing durably once, after the final.
        assert.deepEqual(sessionReceipts.filter((entry, index, all) => all.indexOf(entry) === index), [
          'processing/none',
          'processing/processing',
          'active/processing',
          'active/active',
        ]);
      } finally { h.db.close(); }
    });
  }
}

test('native processing that still shows at the final is not released', async () => {
  const turn = surfaceTurn('channel', '1790000130.000100');
  const h = harness(turn, { rejectCustom: true });
  try {
    await answer(turn, h);
    const final = h.effects.indexOf('final');
    assert.equal(h.effects[final - 1], 'session:processing',
      'the reasserted native indicator carries the turn up to the final');
  } finally { h.db.close(); }
});

test('a final that fails after the release keeps the session for one settle on retry', async () => {
  const turn = surfaceTurn('dm', '1790000140.000100');
  const h = harness(turn, { rejectFirstFinal: true });
  try {
    await assert.rejects(answer(turn, h));
    assert.equal(h.effects.includes('final'), false);
    const releasedAt = h.effects.lastIndexOf('session:active');
    assert.ok(releasedAt > h.effects.indexOf('custom:Preparing your request…'), 'released for the final');
    assert.equal(h.effects.slice(releasedAt).filter((effect) => effect.startsWith('session:')).length, 1,
      'no settle without a delivered final');
    let stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion !== 3) return;
    assert.equal(stored.agentSession.desired, 'processing', 'the durable session has not left processing');
    assert.equal(stored.agentSession.acknowledged, 'processing');

    h.effects.length = 0;
    await answer(turn, h);
    assert.equal(h.effects.filter((effect) => effect === 'final').length, 1, 'the retry delivers the final once');
    assert.equal(h.effects.at(-2), 'session:active', 'then settles');
    stored = h.store.get(h.runId);
    if (stored?.schemaVersion !== 3) return;
    assert.equal(stored.agentSession.desired, 'active');
    assert.equal(stored.agentSession.acknowledged, 'active');
  } finally { h.db.close(); }
});

test('an aged stream is retired and the final posted fresh, both after the release', async () => {
  const turn = surfaceTurn('channel', '1790000150.000100');
  const h = harness(turn, { streamed: true, agedStream: true });
  try {
    await answer(turn, h);
    assert.deepEqual(h.effects.slice(h.effects.indexOf('custom:Preparing your request…')), [
      'custom:Preparing your request…',
      'session:active', // released before anything posts
      'final', // the aged stream is stopped (#180)
      'post', // the final, posted fresh
      'session:active',
      'custom:clear',
    ]);
  } finally { h.db.close(); }
});
