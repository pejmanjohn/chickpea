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
  DEFAULT_SLACK_APPEND_BUDGET,
  SlackRunPresentationStoreLogic,
  type SlackPresentationFinalizationRecord,
} from '../src/slack/run-presentations.ts';

const START_MS = 1_785_700_100_000;
const WORKSPACE = 'T_PARALLEL';

/**
 * A fake clock whose timers fire only when the test advances it, so many
 * streams wait on one workspace budget the way concurrent turns would.
 */
function fakeClock() {
  let now = START_MS;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const settle = async () => {
    for (let turn = 0; turn < 30; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => now,
    wait: (milliseconds: number) => new Promise<void>((resolve) => {
      timers.push({ at: now + milliseconds, resolve });
    }),
    settle,
    /** Advance in steps until `promise` settles, as real time would. */
    async until<T>(promise: Promise<T>, step = 100): Promise<T> {
      let settled = false;
      const watched = promise.finally(() => { settled = true; });
      for (let guard = 0; !settled && guard < 10_000; guard += 1) await this.advance(step);
      assert.ok(settled, 'the promise settled');
      return watched;
    },
    async advance(milliseconds: number) {
      const end = now + milliseconds;
      for (;;) {
        await settle();
        timers.sort((left, right) => left.at - right.at);
        const due = timers[0];
        if (!due || due.at > end) break;
        timers.shift();
        now = Math.max(now, due.at);
        due.resolve();
      }
      now = end;
      await settle();
    },
  };
}

/** A small deterministic generator, so the jitter is spread but repeatable. */
function seededRandom(seed: number): () => number {
  let value = seed * 2_654_435_761 >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 2 ** 32;
  };
}

const observer: SlackPresentationDeliveryObserver = {
  async before() { return 'delivery_attempt'; },
  async after() {},
};

function parallelStreams(count: number) {
  const clock = fakeClock();
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db, clock.now);
  const appends: Array<{ at: number; stream: number }> = [];
  const records: SlackPresentationFinalizationRecord[] = [];
  const state: SlackPresentationStatePort = {
    getRunPresentation: (id) => store.get(id),
    getLatestThreadSessionGeneration: (root) => store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (value) => store.transition(value),
    reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: (instanceId, submissionId) => {
      const runId = submissionId!.replace('submission_', 'run_');
      return {
        turnJobId: `turn_${runId}`,
        instanceId,
        ...(submissionId ? { submissionId } : {}),
        generation: `turn_${runId}`,
        workCorrelation: { runId, runExecutionId: `execution_${runId}`, mode: 'observe' },
      };
    },
  };
  const streams = Array.from({ length: count }, (_, index) => {
    const runId = `run_parallel_${index}`;
    const root = {
      workspaceId: WORKSPACE,
      channelId: `C_PARALLEL_${index}`,
      threadTs: `1785700100.00${String(100 + index).padStart(4, '0')}`,
      requesterUserId: 'U_PARALLEL',
    };
    store.create({
      runId,
      turnJobId: `turn_${runId}`,
      bindingId: `binding_${index}`,
      workBindingGeneration: 1,
      runFencingToken: 0,
      root,
      schemaVersion: 3,
      owner: { kind: 'chickpea' },
      sessionGeneration: 1785700100000100 + index,
      currentActivity: {
        kind: 'preparing',
        action: 'Preparing',
        object: 'your request',
        generation: 1785700100000100 + index,
        sequence: 1,
        operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
      },
    });
    const client = {
      async apiCall() { return { ok: true }; },
      assistant: { threads: { async setTitle() { return { ok: true }; } } },
      chat: {
        async startStream() {
          return { ok: true, ts: `1785700101.${String(100 + index).padStart(6, '0')}` };
        },
        async appendStream() {
          appends.push({ at: clock.now(), stream: index });
          return { ok: true };
        },
        async stopStream() { return { ok: true }; },
        async postMessage() { return { ok: true, ts: '1785700199.000100' }; },
        async update() { return { ok: true }; },
        async delete() { return { ok: true }; },
      },
      conversations: { async replies() { return { ok: true, messages: [], has_more: false }; } },
    } as unknown as WebClient;
    const presentation = new SlackAgentViewPresentation({
      client,
      state,
      runId,
      runFencingToken: 0,
      footer: { agentName: 'Chickpea', agentId: 'agent_default' },
      minAppendIntervalMs: 750,
      now: clock.now,
      wait: clock.wait,
      random: seededRandom(index + 1),
      onFinalized: (record) => { records.push(structuredClone(record)); },
    });
    return { index, runId, presentation, submissionId: `submission_parallel_${index}` };
  });
  return { clock, db, store, streams, appends, records };
}

async function openRelay(stream: ReturnType<typeof parallelStreams>['streams'][number]) {
  const eligibility = { allowed: true, reason: 'safe_early_release' } as const;
  await stream.presentation.freezeProgressiveEligibility(eligibility);
  const relay = await stream.presentation.prepareReceipt({
    instanceId: `instance_${stream.index}`,
    receipt: { submissionId: stream.submissionId, acceptedAt: 'now', uid: 'uid' },
    eligibility,
  });
  assert.ok(relay);
  const messageId = `message_${stream.index}`;
  relay.onEvent({
    type: 'message-started', conversationId: 'conversation',
    submissionId: stream.submissionId, messageId, position: { batch: 1, index: 0 },
  });
  relay.onEvent({
    type: 'tool-input', conversationId: 'conversation', messageId,
    toolCallId: `stream_call_${stream.index}`, toolName: 'stream_answer', input: {},
    position: { batch: 2, index: 0 },
  });
  relay.onEvent({
    type: 'tool-output', conversationId: 'conversation', toolCallId: `stream_call_${stream.index}`,
    output: 'Delivery preference noted. Continue with the answer.',
    position: { batch: 3, index: 0 },
  });
  return { relay, messageId };
}

test('eight threads streaming at once in one workspace all keep progressing', async () => {
  const count = 8;
  const h = parallelStreams(count);
  try {
    const relays = await Promise.all(h.streams.map(openRelay));
    const lines = 60;
    const answers = h.streams.map((stream) => Array.from(
      { length: lines },
      (_, line) => `Stream ${stream.index} step ${line + 1}: keep the rollout reversible.`,
    ));
    // Every model writes one line every 250 ms, together, for 15 seconds.
    for (let line = 0; line < lines; line += 1) {
      relays.forEach(({ relay, messageId }, index) => relay.onEvent({
        type: 'message-delta', conversationId: 'conversation', messageId,
        kind: 'text', delta: `${answers[index]![line]}\n`,
        position: { batch: 4 + line, index: 0 },
      }));
      await h.clock.advance(250);
    }
    const acknowledgedBeforeClose = h.streams.map((stream) =>
      h.store.get(stream.runId)!.stream.acknowledgedByteLength);
    await h.clock.until(Promise.all(relays.map(({ relay, messageId }) => {
      relay.onEvent({
        type: 'message-completed', conversationId: 'conversation', messageId,
        position: { batch: 4 + lines, index: 0 },
      });
      return relay.closeAndDrain();
    })));

    if (process.env.DEBUG_BUDGET) {
      console.log(h.streams.map((stream) => h.appends.filter((a) => a.stream === stream.index)
        .map((a) => a.at - START_MS).join(',')).join('\n'));
    }
    // Slots go round in arrival order: each stream appends about every
    // count x 600 ms, with every chunk that arrived meanwhile.
    const turn = count * DEFAULT_SLACK_APPEND_BUDGET.refillWindowMs;
    for (const stream of h.streams) {
      const own = h.appends.filter((append) => append.stream === stream.index);
      assert.ok(own.length >= 4, `stream ${stream.index} appended ${own.length} times`);
      for (let index = 1; index < own.length; index += 1) {
        assert.ok(own[index]!.at - own[index - 1]!.at <= turn + 1_000,
          `stream ${stream.index} never waits much more than one turn`);
      }
      // Still appending in the last third of the answer: lower cadence, not frozen.
      assert.ok(own.at(-1)!.at >= START_MS + 10_000, `stream ${stream.index} kept streaming`);
      const total = Buffer.byteLength(answers[stream.index]!.join('\n'));
      assert.ok(acknowledgedBeforeClose[stream.index]! > total / 2,
        `stream ${stream.index} showed most of its answer before the end`);
    }
    // The workspace never exceeds Slack's Tier 4 pace plus the burst.
    const elapsed = lines * 250;
    assert.ok(h.appends.length <=
      DEFAULT_SLACK_APPEND_BUDGET.capacity + elapsed / DEFAULT_SLACK_APPEND_BUDGET.refillWindowMs + 1);

    for (const [index, stream] of h.streams.entries()) {
      await stream.presentation.finalize(answers[index]!.join('\n'), 'markdown', 'complete', observer);
      await stream.presentation.markCanonicalFinalized();
    }
    assert.equal(h.records.length, count);
    for (const record of h.records) {
      assert.equal(record.deliveryOutcome, 'progressive');
      assert.equal(record.degradation, 'none', 'waiting for the budget never degrades a stream');
      assert.ok(record.appendBudget && record.appendBudget.deferrals > 0,
        'deferrals are counted, content-free');
      assert.deepEqual(Object.keys(record.appendBudget!).sort(), ['deferrals', 'deferredMs', 'yielded']);
    }
  } finally {
    h.db.close();
  }
});

test('an append that finds the budget spent waits for it instead of ending the stream', async () => {
  const h = parallelStreams(1);
  try {
    const [stream] = h.streams;
    const { relay, messageId } = await openRelay(stream!);
    const text = Array.from({ length: 8 }, (_, line) => `Line ${line + 1} of the answer.`);
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId,
      kind: 'text', delta: `${text[0]}\n`, position: { batch: 4, index: 0 },
    });
    await h.clock.advance(1_000);
    assert.equal(h.store.get(stream!.runId)!.stream.state, 'streaming');
    // Other threads spend the whole burst just before this stream's next append.
    for (let index = 0; index < DEFAULT_SLACK_APPEND_BUDGET.capacity; index += 1) {
      assert.equal(h.store.reserveAppend(WORKSPACE).outcome, 'reserved');
    }
    for (let line = 1; line < text.length; line += 1) {
      relay.onEvent({
        type: 'message-delta', conversationId: 'conversation', messageId,
        kind: 'text', delta: `${text[line]}\n`, position: { batch: 4 + line, index: 0 },
      });
      await h.clock.advance(1_000);
    }
    const acknowledged = h.store.get(stream!.runId)!.stream.acknowledgedByteLength;
    assert.ok(h.appends.length >= 5, 'appends continue after the one that waited');
    assert.ok(acknowledged >= Buffer.byteLength(text.slice(0, 7).join('\n')),
      'the stream shows nearly the whole answer before the end');
    relay.onEvent({
      type: 'message-completed', conversationId: 'conversation', messageId,
      position: { batch: 4 + text.length, index: 0 },
    });
    await h.clock.until(relay.closeAndDrain());
    await stream!.presentation.finalize(text.join('\n'), 'markdown', 'complete', observer);
    await stream!.presentation.markCanonicalFinalized();
    const [record] = h.records;
    assert.equal(record!.degradation, 'none');
    assert.ok(record!.appendBudget!.deferrals >= 1);
    assert.equal(record!.appendBudget!.yielded, 0);
  } finally {
    h.db.close();
  }
});

test('a closing reader does not wait out a long shared cooldown', async () => {
  const h = parallelStreams(1);
  try {
    const [stream] = h.streams;
    const { relay, messageId } = await openRelay(stream!);
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId,
      kind: 'text', delta: 'First line of the answer.\n', position: { batch: 4, index: 0 },
    });
    await h.clock.advance(1_000);
    assert.equal(h.store.get(stream!.runId)!.stream.state, 'streaming');
    h.store.applyAppendCooldown(WORKSPACE, 15_000);
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId,
      kind: 'text', delta: 'Second line of the answer.\n', position: { batch: 5, index: 0 },
    });
    await h.clock.advance(2_000);
    relay.onEvent({
      type: 'message-completed', conversationId: 'conversation', messageId,
      position: { batch: 6, index: 0 },
    });
    // Within one wait slice the append gives way to the terminal.
    const before = h.clock.now();
    await h.clock.until(relay.closeAndDrain());
    assert.ok(h.clock.now() - before <= 1_000);
    assert.ok(h.clock.now() < START_MS + 15_000);
    assert.equal(h.appends.length, 0, 'the cooldown held the second append');
    await stream!.presentation.finalize(
      'First line of the answer.\nSecond line of the answer.', 'markdown', 'complete', observer,
    );
    await stream!.presentation.markCanonicalFinalized();
    assert.equal(h.records[0]!.degradation, 'none');
    assert.equal(h.records[0]!.appendBudget!.yielded, 1);
  } finally {
    h.db.close();
  }
});
