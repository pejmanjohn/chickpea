import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { openStateDb } from '../src/state/node-state-db.ts';
import { runnerPresentationState } from '../src/slack/thread-runner-loop.ts';
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

/**
 * `runners`: each stream runs in its own thread runner (Cloudflare), with its
 * presentation in the runner's own SQLite and the workspace budgets in the
 * shared state store (`store`), reached through the runner's port.
 */
function parallelStreams(count: number, options: { appendErrors?: unknown[]; runners?: boolean } = {}) {
  const clock = fakeClock();
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db, clock.now);
  const runnerDbs: Array<ReturnType<typeof openStateDb>> = [];
  const appends: Array<{ at: number; stream: number; text: string }> = [];
  const records: SlackPresentationFinalizationRecord[] = [];
  const bookings: Array<{ at: number; outcome: string; stream?: number }> = [];
  const appendErrors = [...(options.appendErrors ?? [])];
  const state: SlackPresentationStatePort = {
    getRunPresentation: (id) => store.get(id),
    getLatestThreadSessionGeneration: (root) => store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (value) => store.transition(value),
    reserveSlackAppend: (workspaceId) => {
      const booking = store.reserveAppend(workspaceId);
      bookings.push({ at: clock.now(), outcome: booking.outcome });
      return booking;
    },
    slackAppendCooldownUntil: (workspaceId) => store.appendCooldownUntil(workspaceId),
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
  const runnerState = (index: number) => {
    const runnerDb = openStateDb(':memory:');
    runnerDbs.push(runnerDb);
    const local = new SlackRunPresentationStoreLogic(runnerDb, clock.now);
    const runner = runnerPresentationState({
      local,
      remote: {
        reserveSlackAppend: async (workspaceId) => {
          const booking = store.reserveAppend(workspaceId);
          bookings.push({ at: clock.now(), outcome: booking.outcome, stream: index });
          return booking;
        },
        slackAppendCooldownUntil: async (workspaceId) => store.appendCooldownUntil(workspaceId),
        applySlackAppendCooldown: async (workspaceId, retryAfterMs) =>
          store.applyAppendCooldown(workspaceId, retryAfterMs),
        reserveSlackActivityStatus: async (workspaceId) => store.reserveActivityStatus(workspaceId),
        applySlackActivityStatusCooldown: async (workspaceId, retryAfterMs) =>
          store.applyActivityStatusCooldown(workspaceId, retryAfterMs),
        matchFlueObservation: async (instanceId, submissionId) =>
          state.matchFlueObservation(instanceId, submissionId),
        getLatestThreadSessionGeneration: async () => undefined,
      },
      putRemote: async () => {},
      now: clock.now,
      publishIntervalMs: 0,
    });
    return { local, state: runner.state };
  };
  const streams = Array.from({ length: count }, (_, index) => {
    const own = options.runners ? runnerState(index) : { local: store, state };
    const runId = `run_parallel_${index}`;
    const root = {
      workspaceId: WORKSPACE,
      channelId: `C_PARALLEL_${index}`,
      threadTs: `1785700100.00${String(100 + index).padStart(4, '0')}`,
      requesterUserId: 'U_PARALLEL',
    };
    own.local.create({
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
        async appendStream(value: { chunks: Array<{ text?: string }> }) {
          const error = appendErrors.shift();
          if (error) throw error;
          appends.push({
            at: clock.now(), stream: index, text: value.chunks.map((chunk) => chunk.text ?? '').join(''),
          });
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
      state: own.state,
      runId,
      runFencingToken: 0,
      footer: { agentName: 'Chickpea', agentId: 'agent_default' },
      minAppendIntervalMs: 750,
      now: clock.now,
      wait: clock.wait,
      random: seededRandom(index + 1),
      onFinalized: (record) => { records.push(structuredClone(record)); },
    });
    return {
      index, runId, presentation, submissionId: `submission_parallel_${index}`,
      local: own.local, state: own.state,
    };
  });
  const close = () => {
    for (const runnerDb of runnerDbs) runnerDb.close();
    db.close();
  };
  return { clock, db, store, streams, appends, records, bookings, close };
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
      assert.deepEqual(
        Object.keys(record.appendBudget!).sort(),
        ['deferrals', 'deferredMs', 'rateLimited', 'yielded'],
      );
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

function delta(
  relay: Awaited<ReturnType<typeof openRelay>>['relay'],
  messageId: string,
  text: string,
  batch: number,
) {
  relay.onEvent({
    type: 'message-delta', conversationId: 'conversation', messageId,
    kind: 'text', delta: text, position: { batch, index: 0 },
  });
}

test('text held back from the stream keeps its slot instead of spending the workspace budget', async () => {
  const h = parallelStreams(2);
  try {
    const [table, prose] = await Promise.all(h.streams.map(openRelay));
    delta(table!.relay, table!.messageId, 'Here is the comparison.\n\n', 4);
    delta(prose!.relay, prose!.messageId, 'First line.\n', 4);
    await h.clock.advance(1_000);
    const before = h.bookings.length;
    // One table row written for 10 s: never streamable until its newline.
    for (let piece = 0; piece < 40; piece += 1) {
      delta(table!.relay, table!.messageId, `| cell ${piece} `, 5 + piece);
      await h.clock.advance(250);
    }
    const tableBookings = h.bookings.length - before;
    assert.ok(tableBookings <= 2, `a held row booked ${tableBookings} slots`);
    // The other stream still gets its slots on time.
    delta(prose!.relay, prose!.messageId, 'Second line.\n', 5);
    const at = h.clock.now();
    await h.clock.advance(1_000);
    const proseAppend = h.appends.find((append) => append.stream === 1 && append.at >= at);
    assert.ok(proseAppend && proseAppend.at - at <= 750, 'no wait caused by the held row');
    // The row completes and streams with the slot it kept.
    delta(table!.relay, table!.messageId, '|\n', 100);
    await h.clock.advance(1_000);
    assert.ok(h.appends.some((append) => append.stream === 0 && append.text.includes('| cell 39')));
  } finally {
    h.db.close();
  }
});

test('a cooldown applied after a slot was booked holds that slot too', async () => {
  const h = parallelStreams(1);
  try {
    const [stream] = h.streams;
    const { relay, messageId } = await openRelay(stream!);
    delta(relay, messageId, 'First line of the answer.\n', 4);
    await h.clock.advance(1_000);
    // Other threads take the burst, so the next append books a slot ahead.
    for (let index = 0; index < DEFAULT_SLACK_APPEND_BUDGET.capacity + 5; index += 1) {
      h.store.reserveAppend(WORKSPACE);
    }
    delta(relay, messageId, 'Second line of the answer.\n', 5);
    await h.clock.advance(100);
    assert.ok(h.bookings.some((booking) => booking.outcome === 'scheduled'), 'a slot was booked');
    // Slack rate limits another thread before the booked slot comes due.
    const { cooldownUntil } = h.store.applyAppendCooldown(WORKSPACE, 12_000);
    await h.clock.advance(20_000);
    assert.equal(h.appends.filter((append) => append.at < cooldownUntil).length, 0,
      'nothing reaches Slack inside the cooldown');
    assert.ok(h.appends.some((append) => append.text.includes('Second line')),
      'the text streams once the cooldown ends');
  } finally {
    h.db.close();
  }
});

test('a rate-limited append is counted, and the stream carries on after the cooldown', async () => {
  const rateLimited = Object.assign(new Error('ratelimited'), {
    code: ErrorCode.RateLimitedError,
    retryAfter: 2,
  });
  const h = parallelStreams(1, { appendErrors: [rateLimited] });
  try {
    const [stream] = h.streams;
    const { relay, messageId } = await openRelay(stream!);
    const lines = Array.from({ length: 10 }, (_, line) => `Line ${line + 1} of the answer.`);
    for (const [line, text] of lines.entries()) {
      delta(relay, messageId, `${text}\n`, 4 + line);
      await h.clock.advance(1_000);
    }
    assert.ok(h.appends.length >= 3, 'appends continue after the rate limit');
    assert.ok(h.appends.at(-1)!.text.length > 0);
    relay.onEvent({
      type: 'message-completed', conversationId: 'conversation', messageId,
      position: { batch: 100, index: 0 },
    });
    await h.clock.until(relay.closeAndDrain());
    await stream!.presentation.finalize(lines.join('\n'), 'markdown', 'complete', observer);
    await stream!.presentation.markCanonicalFinalized();
    const [record] = h.records;
    assert.equal(record!.appendBudget!.rateLimited, 1, 'the Slack rate limit stays visible');
    assert.ok(record!.acceptedBytes + record!.terminalSuffixBytes >= Buffer.byteLength(lines.join('\n')));
  } finally {
    h.db.close();
  }
});

test('past the booking horizon a stream gives its text to the next append, never loses it', async () => {
  const count = 50;
  const h = parallelStreams(count);
  try {
    const relays = await Promise.all(h.streams.map(openRelay));
    const lines = 40;
    const answers = h.streams.map((stream) => Array.from(
      { length: lines },
      (_, line) => `Stream ${stream.index} step ${line + 1}.`,
    ));
    for (let line = 0; line < lines; line += 1) {
      relays.forEach(({ relay, messageId }, index) =>
        delta(relay, messageId, `${answers[index]![line]}\n`, 4 + line));
      await h.clock.advance(1_000);
    }
    // Bookings never run more than the horizon ahead, and Slack sees at most Tier 4.
    const elapsed = lines * 1_000;
    assert.ok(h.appends.length <=
      DEFAULT_SLACK_APPEND_BUDGET.capacity + elapsed / DEFAULT_SLACK_APPEND_BUDGET.refillWindowMs + 1);
    await h.clock.until(Promise.all(relays.map(({ relay, messageId }) => {
      relay.onEvent({
        type: 'message-completed', conversationId: 'conversation', messageId,
        position: { batch: 4 + lines, index: 0 },
      });
      return relay.closeAndDrain();
    })));
    for (const [index, stream] of h.streams.entries()) {
      await stream.presentation.finalize(answers[index]!.join('\n'), 'markdown', 'complete', observer);
      await stream.presentation.markCanonicalFinalized();
    }
    assert.equal(h.records.length, count);
    assert.ok(h.records.some((record) => (record.appendBudget?.yielded ?? 0) > 0),
      'some streams gave text up at the horizon');
    for (const [index, record] of h.records.entries()) {
      const total = Buffer.byteLength(answers[index]!.join('\n'));
      assert.equal(record.acceptedBytes + record.terminalSuffixBytes, total, 'no text lost');
    }
  } finally {
    h.db.close();
  }
});

test('thread runners in one workspace stream from one shared append budget', async () => {
  // Amber F1: each runner booked from its own SQLite, so every thread had
  // its own 100/min and nothing was ever deferred across threads.
  const count = 4;
  const h = parallelStreams(count, { runners: true });
  try {
    const relays = await Promise.all(h.streams.map(openRelay));
    const lines = 60;
    const answers = h.streams.map((stream) => Array.from(
      { length: lines },
      (_, line) => `Runner ${stream.index} step ${line + 1}: keep the rollout reversible.`,
    ));
    for (let line = 0; line < lines; line += 1) {
      relays.forEach(({ relay, messageId }, index) =>
        delta(relay, messageId, `${answers[index]![line]}\n`, 4 + line));
      await h.clock.advance(250);
    }
    await h.clock.until(Promise.all(relays.map(({ relay, messageId }) => {
      relay.onEvent({
        type: 'message-completed', conversationId: 'conversation', messageId,
        position: { batch: 4 + lines, index: 0 },
      });
      return relay.closeAndDrain();
    })));
    // Every booking went to the shared store, first come first served
    // across threads: no thread takes two turns in a row for long.
    const booked = h.bookings.filter((booking) => booking.outcome !== 'exhausted');
    assert.deepEqual(new Set(booked.map((booking) => booking.stream)), new Set([0, 1, 2, 3]));
    const longestRun = booked.reduce((state, booking) => {
      const run = booking.stream === state.last ? state.run + 1 : 1;
      return { last: booking.stream, run, max: Math.max(state.max, run) };
    }, { last: -1 as number | undefined, run: 0, max: 0 }).max;
    assert.ok(longestRun <= 4, `bookings interleave across threads (longest run ${longestRun})`);
    assert.ok(booked.some((booking) => booking.outcome === 'scheduled'), 'threads waited for each other');
    // Together they stay within Slack's Tier 4 pace plus the burst.
    assert.ok(h.appends.length <=
      DEFAULT_SLACK_APPEND_BUDGET.capacity + (lines * 250) / DEFAULT_SLACK_APPEND_BUDGET.refillWindowMs + 1);
    for (const stream of h.streams) {
      assert.equal(stream.local.appendCooldownUntil(WORKSPACE), undefined);
      assert.equal(stream.local.reserveAppend(WORKSPACE).budgetVersion, 1,
        "the runner's own budget row was never used");
    }
    for (const [index, stream] of h.streams.entries()) {
      await stream.presentation.finalize(answers[index]!.join('\n'), 'markdown', 'complete', observer);
      await stream.presentation.markCanonicalFinalized();
    }
    assert.equal(h.records.length, count);
    for (const record of h.records) {
      assert.equal(record.degradation, 'none');
      assert.ok(record.appendBudget && record.appendBudget.deferrals > 0,
        'the finalization record carries the deferral across threads');
    }
  } finally {
    h.close();
  }
});

test("a Slack rate limit one thread runner hits holds another runner's appends", async () => {
  const h = parallelStreams(2, { runners: true });
  try {
    const [first, second] = h.streams;
    const relays = await Promise.all([first!, second!].map(openRelay));
    delta(relays[1]!.relay, relays[1]!.messageId, 'First line of the answer.\n', 4);
    await h.clock.advance(1_000);
    const before = h.appends.filter((append) => append.stream === 1).length;
    // The first runner is rate limited and applies the workspace cooldown.
    const { cooldownUntil } = await first!.state.applySlackAppendCooldown(WORKSPACE, 12_000);
    delta(relays[1]!.relay, relays[1]!.messageId, 'Second line of the answer.\n', 5);
    await h.clock.advance(20_000);
    const own = h.appends.filter((append) => append.stream === 1);
    assert.equal(own.slice(before).filter((append) => append.at < cooldownUntil).length, 0,
      'the other runner sends nothing inside the cooldown');
    assert.ok(own.some((append) => append.text.includes('Second line') && append.at >= cooldownUntil),
      'and streams once it ends');
    relays[1]!.relay.onEvent({
      type: 'message-completed', conversationId: 'conversation', messageId: relays[1]!.messageId,
      position: { batch: 6, index: 0 },
    });
    await h.clock.until(relays[1]!.relay.closeAndDrain());
    await second!.presentation.finalize(
      'First line of the answer.\nSecond line of the answer.', 'markdown', 'complete', observer,
    );
    await second!.presentation.markCanonicalFinalized();
    assert.ok(h.records[0]!.appendBudget!.deferrals > 0, 'the wait is in its finalization record');
  } finally {
    h.close();
  }
});
