import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { openStateDb } from '../src/state/node-state-db.ts';
import {
  SlackAgentViewPresentation,
  type SlackPresentationDeliveryObserver,
  type SlackPresentationStatePort,
} from '../src/slack/agent-view-presentation.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationTransitionInput,
} from '../src/slack/run-presentations.ts';

// An append records its intent on the presentation row and awaits
// chat.appendStream. An activity-status write (for example a status retry
// after an exhausted shared budget) lands on the same row meanwhile. The
// acknowledgement must still apply, and a stream stranded with a pending
// append must still deliver its final instead of exhausting attempts.

const START_MS = 1_785_700_100_000;
const RUN_ID = 'run_append_race';
const ROOT = {
  workspaceId: 'T_APPEND_RACE',
  channelId: 'C_APPEND_RACE',
  threadTs: '1785700100.000100',
  requesterUserId: 'U_APPEND_RACE',
};
const STREAM_TS = '1785700101.000100';
const LINES = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of a long answer.`);
const ANSWER = LINES.join('\n');

function harness(options: {
  /** Awaited inside the first chat.appendStream call. */
  duringFirstAppend?: (presentation: SlackAgentViewPresentation) => Promise<void>;
  /** The first append acknowledgement after the stream start never persists. */
  loseFirstAcknowledgement?: boolean;
} = {}) {
  let now = START_MS;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db, () => now);
  store.create({
    runId: RUN_ID,
    turnJobId: `turn_${RUN_ID}`,
    bindingId: 'binding_append_race',
    workBindingGeneration: 1,
    runFencingToken: 0,
    root: ROOT,
    schemaVersion: 3,
    owner: { kind: 'chickpea' },
    sessionGeneration: 1785700100000100,
    currentActivity: {
      kind: 'preparing',
      action: 'Preparing',
      object: 'your request',
      generation: 1785700100000100,
      sequence: 1,
      operation: { operationId: `activity_${RUN_ID}_1`, certainty: 'pending' },
    },
  });
  const state = {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: typeof ROOT) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: SlackPresentationTransitionInput) => {
      // Every write of the first append's acknowledgement fails, including
      // re-reads: the write never lands, as when an attempt ends mid-call.
      if (options.loseFirstAcknowledgement &&
          input.mutation.kind === 'append_acknowledged' && input.mutation.cursor === 2) {
        return { outcome: 'stale' as const };
      }
      return store.transition(input);
    },
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    slackAppendCooldownUntil: (workspaceId: string) => store.appendCooldownUntil(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, ms: number) =>
      store.applyAppendCooldown(workspaceId, ms),
    matchFlueObservation: (instanceId: string, submissionId: string) => ({
      turnJobId: `turn_${RUN_ID}`,
      instanceId,
      submissionId,
      generation: `turn_${RUN_ID}`,
      workCorrelation: { runId: RUN_ID, runExecutionId: `execution_${RUN_ID}`, mode: 'observe' },
    }),
  } as unknown as SlackPresentationStatePort;
  const calls = { append: 0, stop: 0, update: [] as string[], post: 0 };
  let presentation!: SlackAgentViewPresentation;
  const client = {
    async apiCall() { return { ok: true }; },
    assistant: {
      threads: {
        async setTitle() { return { ok: true }; },
        async setStatus() { return { ok: true }; },
      },
    },
    chat: {
      async startStream() { return { ok: true, ts: STREAM_TS }; },
      async appendStream() {
        calls.append += 1;
        if (calls.append === 1) await options.duringFirstAppend?.(presentation);
        return { ok: true };
      },
      async stopStream() { calls.stop += 1; return { ok: true }; },
      async postMessage() { calls.post += 1; return { ok: true, ts: '1785700199.000100' }; },
      async update(input: { text: string }) { calls.update.push(input.text); return { ok: true }; },
      async delete() { return { ok: true }; },
    },
    conversations: {
      async replies() { return { ok: true, messages: [], has_more: false }; },
    },
  } as unknown as WebClient;
  const create = () => new SlackAgentViewPresentation({
    client,
    state,
    runId: RUN_ID,
    runFencingToken: 0,
    footer: { agentName: 'Chickpea', agentId: 'agent_default' },
    minAppendIntervalMs: 0,
    now: () => now,
    wait: async (ms: number) => { now += ms; },
    random: () => 0,
  });
  presentation = create();

  async function streamAnswer(): Promise<void> {
    const eligibility = { allowed: true, reason: 'safe_early_release' } as const;
    await presentation.freezeProgressiveEligibility(eligibility);
    const relay = await presentation.prepareReceipt({
      instanceId: 'instance_append_race',
      receipt: { submissionId: 'submission_append_race', acceptedAt: 'now', uid: 'u' },
      eligibility,
    });
    assert.ok(relay, 'an eligible receipt opens a relay');
    const messageId = 'message_append_race';
    const conversationId = 'conversation_append_race';
    relay.onEvent({
      type: 'message-started', conversationId, submissionId: 'submission_append_race',
      messageId, position: { batch: 1, index: 0 },
    } as never);
    relay.onEvent({
      type: 'tool-input', conversationId, messageId, toolCallId: 'stream_call',
      toolName: 'stream_answer', input: {}, position: { batch: 2, index: 0 },
    } as never);
    relay.onEvent({
      type: 'tool-output', conversationId, toolCallId: 'stream_call', output: 'ok',
      position: { batch: 3, index: 0 },
    } as never);
    for (let i = 0; i < LINES.length; i += 1) {
      relay.onEvent({
        type: 'message-delta', conversationId, messageId, kind: 'text',
        delta: `${LINES[i]}\n`, position: { batch: 4 + i, index: 0 },
      } as never);
      for (let k = 0; k < 20; k += 1) await new Promise((resolve) => setImmediate(resolve));
      now += 1_000;
    }
    relay.onEvent({
      type: 'message-completed', conversationId, messageId, position: { batch: 99, index: 0 },
    } as never);
    await relay.closeAndDrain();
  }

  const observer: SlackPresentationDeliveryObserver = {
    async before() { return 'attempt_append_race'; },
    async after() {},
  };
  return {
    store,
    calls,
    observer,
    streamAnswer,
    presentation: () => presentation,
    fresh: () => { presentation = create(); return presentation; },
    close: () => db.close(),
  };
}

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

function terminalCertainty(runId: string, store: SlackRunPresentationStoreLogic): string | undefined {
  const row = store.get(runId);
  return row?.schemaVersion === 3 && row.terminalDelivery.state === 'intended'
    ? row.terminalDelivery.operation.certainty
    : undefined;
}

test('an activity-status write during an awaited append does not strand the append', async () => {
  const h = harness({
    duringFirstAppend: async (presentation) => {
      // The deferred status retry lands while chat.appendStream is in flight.
      await presentation.beginActivity(
        { kind: 'writing', action: 'Drafting', object: 'the answer', text: 'Drafting the answer' },
        'assistant_status',
      );
    },
  });
  const { warnings } = await captureWarnings(async () => {
    await h.streamAnswer();
    const streaming = h.store.get(RUN_ID)!;
    assert.equal(streaming.stream.state, 'streaming');
    assert.equal(streaming.stream.pendingAppend, undefined, 'the racing ack still applied');
    assert.ok(h.calls.append > 1, 'appends continued after the concurrent status write');
    const result = await h.presentation().finalize(ANSWER, 'markdown', 'complete', h.observer);
    assert.equal(result.handled, true);
  });
  assert.deepEqual(warnings.filter((line) => line.includes('sink failed')), []);
  const settled = h.store.get(RUN_ID)!;
  assert.equal(h.calls.stop, 1, 'the stream is stopped once');
  assert.equal(h.calls.post, 0, 'no second message');
  assert.ok(['artifact_delivered', 'finalized'].includes(settled.stream.state));
  assert.equal(terminalCertainty(RUN_ID, h.store), 'acknowledged');
  h.close();
});

test('a lost append acknowledgement logs, degrades, and still delivers one final', async () => {
  const h = harness({ loseFirstAcknowledgement: true });
  const { warnings } = await captureWarnings(async () => {
    await h.streamAnswer();
    const stranded = h.store.get(RUN_ID)!;
    assert.ok(stranded.stream.pendingAppend, 'the lost ack leaves the append pending');
    const appendsBeforeFinal = h.calls.append;
    const result = await h.presentation().finalize(ANSWER, 'markdown', 'complete', h.observer);
    assert.equal(result.handled, true);
    assert.equal(h.calls.append, appendsBeforeFinal, 'the degraded stream appends nothing more');
  });
  assert.ok(
    warnings.includes('[chickpea] stream append sink failed stale_writer'),
    `sink failure is logged: ${JSON.stringify(warnings)}`,
  );
  assert.ok(warnings.every((line) => !line.includes('Line ')), 'logs carry no answer text');
  const settled = h.store.get(RUN_ID)!;
  assert.equal(h.calls.stop, 1, 'the stream is stopped');
  assert.equal(h.calls.update.length, 1, 'its contents are replaced with the final');
  assert.match(h.calls.update[0]!, /Line 20 of a long answer\./);
  assert.equal(h.calls.post, 0, 'no second message');
  assert.equal(settled.stream.pendingAppend, undefined);
  assert.ok(['artifact_delivered', 'finalized'].includes(settled.stream.state));
  assert.equal(terminalCertainty(RUN_ID, h.store), 'acknowledged');
  h.close();
});

test('a stream stranded with a pending append and an intended terminal recovers on the next attempt', async () => {
  const h = harness({ loseFirstAcknowledgement: true });
  await captureWarnings(() => h.streamAnswer());
  // The failing attempt had frozen the terminal before close refused it.
  let row = h.store.get(RUN_ID)!;
  const applied = h.store.transition({
    runId: RUN_ID,
    workBindingGeneration: row.workBindingGeneration,
    runFencingToken: row.runFencingToken,
    expectedProjectionVersion: row.projectionVersion,
    expectedStreamState: row.stream.state,
    mutation: {
      kind: 'record_terminal_delivery_intent',
      operationId: 'terminal_append_race_answer',
      result: 'answer',
    },
  });
  assert.equal(applied.outcome, 'applied');
  row = h.store.get(RUN_ID)!;
  assert.equal(row.stream.state, 'streaming');
  assert.ok(row.stream.pendingAppend);
  assert.equal(terminalCertainty(RUN_ID, h.store), 'pending');

  const { warnings } = await captureWarnings(() =>
    h.fresh().finalize(ANSWER, 'markdown', 'complete', h.observer));
  assert.ok(warnings.some((line) => line.includes('append unreconciled')));
  const settled = h.store.get(RUN_ID)!;
  assert.equal(h.calls.stop, 1, 'the stream is stopped');
  assert.equal(h.calls.update.length, 1, 'the final replaces the stream contents');
  assert.equal(h.calls.post, 0, 'no failure notice or duplicate final');
  assert.equal(settled.stream.pendingAppend, undefined);
  assert.ok(['artifact_delivered', 'finalized'].includes(settled.stream.state));
  assert.equal(terminalCertainty(RUN_ID, h.store), 'acknowledged');
  h.close();
});
