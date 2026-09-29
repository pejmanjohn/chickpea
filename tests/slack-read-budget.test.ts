import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode } from '@slack/web-api';

import {
  CfSlackStateStore,
  FreshTagStateStubs,
  StateStoreDisconnectedError,
} from '../src/config/cf-state-proxies.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { localSlackStateStore } from '../src/slack/local-state-store.ts';
import {
  UNGATED_SLACK_READS,
  createSlackReadGate,
  isSlackRateLimitError,
  slackRetryAfterMs,
} from '../src/slack/read-budget.ts';
import {
  DEFAULT_SLACK_READ_BUDGET,
  SlackPresentationStateError,
  SlackRunPresentationStoreLogic,
  type SlackReadMethod,
} from '../src/slack/run-presentations.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const START = 1_800_000_000_000;
const HISTORY = 'conversations.history';
const REPLIES = 'conversations.replies';

function disconnectError(): Error {
  return Object.assign(new Error('Durable Object reset because its code was updated.'), {
    retryable: true,
  });
}

/** A TagStateRpc stub answering the read-budget calls from one shared store. */
function readBudgetStub(store: SlackRunPresentationStoreLogic, calls: string[] = []): TagStateRpc {
  return {
    async slackReserveRead(workspaceId: string, method: SlackReadMethod) {
      calls.push(`reserve:${method}`);
      return { ok: true, value: store.reserveSlackRead(workspaceId, method) };
    },
    async slackApplyReadCooldown(workspaceId: string, method: SlackReadMethod, retryAfterMs: number) {
      calls.push(`cooldown:${method}`);
      return { ok: true, value: store.applySlackReadCooldown(workspaceId, method, retryAfterMs) };
    },
  } as unknown as TagStateRpc;
}

test('Slack read budget allows one read per method per workspace each minute', () => {
  const db = openStateDb(':memory:');
  let now = START;
  try {
    const firstIsolate = new SlackRunPresentationStoreLogic(db, () => now);
    const secondIsolate = new SlackRunPresentationStoreLogic(db, () => now);
    assert.deepEqual(DEFAULT_SLACK_READ_BUDGET, { capacity: 1, refillWindowMs: 60_000 });

    assert.equal(firstIsolate.reserveSlackRead('T_READ', HISTORY).outcome, 'reserved');
    const blocked = secondIsolate.reserveSlackRead('T_READ', HISTORY);
    assert.equal(blocked.outcome, 'exhausted', 'the second isolate shares the one read');
    assert.equal(blocked.outcome === 'exhausted' && blocked.retryAt, START + 60_000);

    // Each method has its own budget, and so does each workspace.
    assert.equal(secondIsolate.reserveSlackRead('T_READ', REPLIES).outcome, 'reserved');
    assert.equal(firstIsolate.reserveSlackRead('T_READ', REPLIES).outcome, 'exhausted');
    assert.equal(firstIsolate.reserveSlackRead('T_OTHER', HISTORY).outcome, 'reserved');
    assert.equal(firstIsolate.reserveSlackRead('T_OTHER', REPLIES).outcome, 'reserved');

    now = START + 59_999;
    assert.equal(firstIsolate.reserveSlackRead('T_READ', HISTORY).outcome, 'exhausted');
    now = START + 60_000;
    assert.equal(secondIsolate.reserveSlackRead('T_READ', HISTORY).outcome, 'reserved');
    assert.equal(firstIsolate.reserveSlackRead('T_READ', HISTORY).outcome, 'exhausted');
    // A long idle stretch refills to one read, never a burst.
    now = START + 10 * 60_000;
    assert.equal(firstIsolate.reserveSlackRead('T_READ', HISTORY).outcome, 'reserved');
    assert.equal(firstIsolate.reserveSlackRead('T_READ', HISTORY).outcome, 'exhausted');
  } finally {
    db.close();
  }
});

test('a Slack read cooldown holds every reader of that method until it ends, and only extends', () => {
  const db = openStateDb(':memory:');
  let now = START;
  try {
    const firstIsolate = new SlackRunPresentationStoreLogic(db, () => now);
    const secondIsolate = new SlackRunPresentationStoreLogic(db, () => now);

    const applied = firstIsolate.applySlackReadCooldown('T_COOL', REPLIES, 120_000);
    assert.equal(applied.cooldownUntil, START + 120_000);
    const held = secondIsolate.reserveSlackRead('T_COOL', REPLIES);
    assert.deepEqual(held, {
      outcome: 'cooldown',
      retryAt: START + 120_000,
      budgetVersion: applied.budgetVersion,
    });
    // The other method and other workspaces are not held.
    assert.equal(secondIsolate.reserveSlackRead('T_COOL', HISTORY).outcome, 'reserved');
    assert.equal(secondIsolate.reserveSlackRead('T_ELSEWHERE', REPLIES).outcome, 'reserved');

    // A shorter retry-after never shortens the running cooldown; a longer one extends it.
    now = START + 10_000;
    assert.equal(secondIsolate.applySlackReadCooldown('T_COOL', REPLIES, 1_000).cooldownUntil,
      START + 120_000);
    assert.equal(secondIsolate.applySlackReadCooldown('T_COOL', REPLIES, 300_000).cooldownUntil,
      START + 310_000);
    now = START + 309_999;
    assert.equal(firstIsolate.reserveSlackRead('T_COOL', REPLIES).outcome, 'cooldown');
    now = START + 310_000;
    assert.equal(firstIsolate.reserveSlackRead('T_COOL', REPLIES).outcome, 'reserved');
  } finally {
    db.close();
  }
});

test('Slack read budget rejects an unknown method and an invalid retry delay', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => START);
    const invalid = (error: unknown) =>
      error instanceof SlackPresentationStateError && error.code === 'invalid_input';
    for (const method of ['chat.postMessage', 'toString', '__proto__', '']) {
      assert.throws(() => store.reserveSlackRead('T_READ', method as SlackReadMethod), invalid);
      assert.throws(() => store.applySlackReadCooldown('T_READ', method as SlackReadMethod, 1_000),
        invalid);
    }
    assert.throws(() => store.reserveSlackRead('', HISTORY), invalid);
    for (const delay of [0, -1, 1.5, 15 * 60_000 + 1]) {
      assert.throws(() => store.applySlackReadCooldown('T_READ', HISTORY, delay), invalid);
    }
  } finally {
    db.close();
  }
});

test('the Node state store books Slack reads from the shared presentation store', async () => {
  const db = openStateDb(':memory:');
  try {
    const presentations = new SlackRunPresentationStoreLogic(db, () => START);
    const state = localSlackStateStore({
      slack: {} as never,
      work: {} as never,
      turnJobs: {} as never,
      presentations,
    });
    assert.equal((await state.reserveSlackRead!('T_NODE', HISTORY)).outcome, 'reserved');
    assert.equal((await state.reserveSlackRead!('T_NODE', HISTORY)).outcome, 'exhausted');
    const { cooldownUntil } = await state.applySlackReadCooldown!('T_NODE', REPLIES, 5_000);
    assert.equal(cooldownUntil, START + 5_000);
    assert.equal(presentations.reserveSlackRead('T_NODE', REPLIES).outcome, 'cooldown');
  } finally {
    db.close();
  }
});

test('the Cloudflare state proxy books Slack reads in the state store', async () => {
  const db = openStateDb(':memory:');
  try {
    const shared = new SlackRunPresentationStoreLogic(db, () => START);
    const calls: string[] = [];
    // Thread runners reach the budget through this same proxy: one row per
    // workspace and method, whoever reads.
    const worker = new CfSlackStateStore(readBudgetStub(shared, calls));
    const runnerTurn = new CfSlackStateStore(readBudgetStub(shared, calls));

    assert.equal((await worker.reserveSlackRead('T_CF', HISTORY)).outcome, 'reserved');
    assert.equal((await runnerTurn.reserveSlackRead('T_CF', HISTORY)).outcome, 'exhausted',
      'a thread runner turn and the Worker book from one row');
    await runnerTurn.applySlackReadCooldown('T_CF', REPLIES, 30_000);
    assert.equal((await worker.reserveSlackRead('T_CF', REPLIES)).outcome, 'cooldown');
    assert.deepEqual(calls, [
      'reserve:conversations.history', 'reserve:conversations.history',
      'cooldown:conversations.replies', 'reserve:conversations.replies',
    ]);
  } finally {
    db.close();
  }
});

test('a Slack read booking is never replayed on a disconnect', async () => {
  const calls: string[] = [];
  const mint = () => ({
    async slackReserveRead() { calls.push('reserve'); throw disconnectError(); },
  }) as unknown as TagStateRpc;
  const worker = new CfSlackStateStore(new FreshTagStateStubs(mint));
  await assert.rejects(worker.reserveSlackRead('T_CF', HISTORY),
    (error) => error instanceof StateStoreDisconnectedError);
  assert.deepEqual(calls, ['reserve'], 'one attempt: a lost reply only wastes that read');
});

test('an ungated Slack read gate always reads and records nothing', async () => {
  let touched = false;
  const gate = createSlackReadGate({
    state: {
      reserveSlackRead: async () => { touched = true; throw new Error('not called'); },
      applySlackReadCooldown: async () => { touched = true; throw new Error('not called'); },
    },
    workspaceId: 'T_UNGATED',
    gated: false,
  });
  assert.equal(gate, UNGATED_SLACK_READS);
  assert.equal(gate.gated, false);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await gate.reserve(HISTORY), { ok: true });
  await gate.rateLimited(HISTORY, 60_000);
  assert.deepEqual(await gate.reserve(HISTORY), { ok: true });
  assert.equal(touched, false);
});

test('a gated Slack read gate maps the shared budget and reports rate limits to it', async () => {
  const db = openStateDb(':memory:');
  let now = START;
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => now);
    const cooldowns: unknown[][] = [];
    const state = {
      reserveSlackRead: async (workspaceId: string, method: SlackReadMethod) =>
        store.reserveSlackRead(workspaceId, method),
      applySlackReadCooldown: async (workspaceId: string, method: SlackReadMethod, ms: number) => {
        cooldowns.push([workspaceId, method, ms]);
        return store.applySlackReadCooldown(workspaceId, method, ms);
      },
    };
    const gate = createSlackReadGate({ state, workspaceId: 'T_GATED', gated: true, now: () => now });
    const other = createSlackReadGate({ state, workspaceId: 'T_GATED', gated: true, now: () => now });
    assert.equal(gate.gated, true);

    assert.deepEqual(await gate.reserve(HISTORY), { ok: true });
    assert.deepEqual(await other.reserve(HISTORY), { ok: false, retryAt: START + 60_000 },
      'exhausted: every gate of the workspace shares the read');
    assert.deepEqual(await other.reserve(REPLIES), { ok: true });

    now = START + 60_000;
    await gate.rateLimited(HISTORY, 30_000);
    assert.deepEqual(await other.reserve(HISTORY), { ok: false, retryAt: START + 90_000 },
      'a cooldown one reader hit holds the others');
    await gate.rateLimited(REPLIES, undefined);
    await gate.rateLimited(REPLIES, 0);
    await gate.rateLimited(REPLIES, 24 * 60 * 60_000);
    await gate.rateLimited(REPLIES, 1.2);
    assert.deepEqual(cooldowns.map((call) => call[2]), [30_000, 60_000, 1, 900_000, 2],
      'undefined means one minute; delays are clamped to 1..900000 ms');
    assert.deepEqual(await other.reserve(REPLIES), { ok: false, retryAt: START + 60_000 + 900_000 });
  } finally {
    db.close();
  }
});

test('a gated Slack read gate without the shared budget paces reads in this isolate', async () => {
  let now = START;
  for (const state of [undefined, {}, { reserveSlackRead: async () => ({ outcome: 'reserved' }) }]) {
    const workspaceId = `T_MIXED_${now}`;
    const gate = createSlackReadGate({
      state: state as never,
      workspaceId,
      gated: true,
      now: () => now,
    });
    const peer = createSlackReadGate({ state: undefined, workspaceId, gated: true, now: () => now });
    assert.equal(gate.gated, true);
    assert.deepEqual(await gate.reserve(HISTORY), { ok: true }, 'an older build does not stop reads');
    assert.deepEqual(await peer.reserve(HISTORY), { ok: false, retryAt: now + 60_000 },
      'but reads in this isolate stay at one a minute');
    assert.deepEqual(await gate.reserve(REPLIES), { ok: true });
    now += 60_000;
    assert.deepEqual(await peer.reserve(HISTORY), { ok: true });
    await gate.rateLimited(HISTORY, 120_000);
    now += 60_000;
    assert.deepEqual(await gate.reserve(HISTORY), { ok: false, retryAt: now + 60_000 },
      'a rate limit extends the local pacing');
    now += 60_000;
    assert.deepEqual(await gate.reserve(HISTORY), { ok: true });
    now += 1_000_000;
  }
});

test('a Slack read gate whose state store throws paces locally and never throws', async () => {
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    let now = START;
    const gate = createSlackReadGate({
      state: {
        reserveSlackRead: async () => { throw new StateStoreDisconnectedError(disconnectError()); },
        applySlackReadCooldown: async () => { throw new Error('state store unavailable'); },
      },
      workspaceId: 'T_THROWS',
      gated: true,
      now: () => now,
    });
    assert.deepEqual(await gate.reserve(HISTORY), { ok: true });
    assert.deepEqual(await gate.reserve(HISTORY), { ok: false, retryAt: START + 60_000 });
    await gate.rateLimited(HISTORY, 180_000);
    now += 60_000;
    assert.deepEqual(await gate.reserve(HISTORY), { ok: false, retryAt: START + 180_000 },
      'the rate limit this isolate saw holds its local pacing');
    now = START + 180_000;
    assert.deepEqual(await gate.reserve(HISTORY), { ok: true });
    assert.ok(warnings.length >= 1 && warnings.length < 5,
      'at most one warning a minute, not one per failed call');
    assert.equal(warnings[0]![0], '[chickpea] Slack reads paced locally');
  } finally {
    console.warn = warn;
  }
});

test('Slack rate-limit errors are recognized in both the Web API and gateway shapes', () => {
  const webApi = Object.assign(new Error('A rate limit was exceeded (url: conversations.history, retry-after: 42)'), {
    code: ErrorCode.RateLimitedError,
    retryAfter: 42,
  });
  assert.equal(ErrorCode.RateLimitedError, 'slack_webapi_rate_limited_error');
  assert.equal(isSlackRateLimitError(webApi), true);
  assert.equal(slackRetryAfterMs(webApi), 42_000);

  const gateway = new SlackTransportError('conversations.replies', 'ratelimited', {
    retryAfterMs: 17_500,
  });
  assert.equal(isSlackRateLimitError(gateway), true);
  assert.equal(slackRetryAfterMs(gateway), 17_500);
  const gatewayNoHint = new SlackTransportError('conversations.replies', 'ratelimited');
  assert.equal(isSlackRateLimitError(gatewayNoHint), true);
  assert.equal(slackRetryAfterMs(gatewayNoHint), undefined);

  const platform = Object.assign(new Error('An API error occurred: ratelimited'), {
    code: ErrorCode.PlatformError,
    data: { ok: false, error: 'ratelimited' },
  });
  assert.equal(isSlackRateLimitError(platform), true);
  assert.equal(slackRetryAfterMs(platform), undefined);
  const http429 = Object.assign(new Error('An HTTP protocol error occurred: statusCode = 429'), {
    code: ErrorCode.HTTPError,
    statusCode: 429,
  });
  assert.equal(isSlackRateLimitError(http429), true);

  for (const error of [
    new SlackTransportError('conversations.history', 'channel_not_found'),
    Object.assign(new Error('not_in_channel'), {
      code: ErrorCode.PlatformError,
      data: { ok: false, error: 'not_in_channel' },
    }),
    Object.assign(new Error('bad gateway'), { code: ErrorCode.HTTPError, statusCode: 502 }),
    new Error('ratelimited'),
    undefined,
    null,
    'ratelimited',
  ]) {
    assert.equal(isSlackRateLimitError(error), false, String(error));
  }
  assert.equal(slackRetryAfterMs(Object.assign(new Error('x'), {
    code: ErrorCode.RateLimitedError,
    retryAfter: Number.NaN,
  })), undefined);
  assert.equal(slackRetryAfterMs(undefined), undefined);
});
