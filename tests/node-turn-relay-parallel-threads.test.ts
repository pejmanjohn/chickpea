import assert from 'node:assert/strict';
import { test } from 'node:test';

// Keep the ambient config store the drain opens off any on-disk database.
process.env.SLACK_STATE_DB_PATH = ':memory:';

import type { SlackStateStore } from '../src/slack/claim-store.ts';
import type { WorkStore } from '../src/work/types.ts';
import {
  stopNodeTurnRelay,
  wakeNodeTurnRelay,
} from '../src/slack/node-turn-relay.ts';

const noop = async () => undefined;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pendingTurn(id: string, threadTs: string) {
  return {
    id,
    attempts: 0,
    turn: {
      workspaceId: 'T1',
      channelId: 'C1',
      threadTs,
      ts: `${threadTs}.${id}`,
      userId: 'U1',
      text: id,
      source: 'app_mention',
    },
    assignment: { agentId: 'analyst' },
    progress: {},
  };
}

/** In-memory durable turn rows: delivery removes a row, as the real store's
 * `delivered = 1` hides it from `listPendingTurns`. */
function relayHarness() {
  const rows: ReturnType<typeof pendingTurn>[] = [];
  const gates = new Map<string, Deferred>();
  const events: string[] = [];
  const started = new Map<string, number>();
  const remove = async (id: string) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) rows.splice(index, 1);
  };
  const state = {
    listPendingTurns: async () => rows.map((row) => ({ ...row })),
    freezeRuntimePlan: noop,
    prepareFlueDispatch: noop,
    reconcileFlueExistingInstance: noop,
    recordFlueReceipt: noop,
    recordFlueSettlement: noop,
    matchFlueObservation: noop,
    markTurnRecoveryRequired: noop,
    recordTurnAttempt: noop,
    recordInteractionIntent: noop,
    recordSlackInteractionProgress: noop,
    markTurnDelivered: remove,
    discardTurn: remove,
    setActiveWork: noop,
  } as unknown as SlackStateStore;
  const executeTurn = async (turn: { text: string }) => {
    const id = turn.text;
    started.set(id, Date.now());
    events.push(`start:${id}`);
    const gate = gates.get(id);
    if (gate) await gate.promise;
    events.push(`end:${id}`);
  };
  const overrides = {
    state,
    work: {} as unknown as WorkStore,
    executeTurn: executeTurn as never,
  };
  return {
    events,
    started,
    enqueue(id: string, threadTs: string, blocked = true) {
      if (blocked) gates.set(id, deferred());
      rows.push(pendingTurn(id, threadTs));
    },
    release(id: string) {
      gates.get(id)?.resolve();
    },
    wake: () => wakeNodeTurnRelay(undefined, overrides),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return done;
}

test('a slow thread holds only itself and stop waits for every thread loop', async () => {
  const relay = relayHarness();

  relay.enqueue('a1', '100.1');
  const wakeA = relay.wake();
  await waitFor(() => relay.started.has('a1'));

  // Thread B, admitted while A's turn is blocked, starts without waiting on A.
  relay.enqueue('b1', '200.1');
  const admittedB = Date.now();
  const wakeB = relay.wake();
  await waitFor(() => relay.started.has('b1'), 100);
  assert.ok(relay.started.get('b1')! - admittedB < 100);

  // A second message in A runs only after A's first; its wake does not join
  // the loop an earlier wake started.
  relay.enqueue('a2', '100.1');
  const wakeA2 = relay.wake();
  assert.equal(await settled(wakeA2), true, 'a wake never waits on an earlier loop');
  assert.equal(relay.started.has('a2'), false);
  assert.equal(await settled(wakeA), false, 'a wake waits on the loop it started');

  relay.release('a1');
  await waitFor(() => relay.started.has('a2'));
  assert.ok(relay.events.indexOf('end:a1') < relay.events.indexOf('start:a2'));
  assert.equal(await settled(wakeA), false, 'the loop re-listed and ran a2');

  // Shutdown waits for both in-flight threads.
  const stopped = stopNodeTurnRelay();
  assert.equal(await settled(stopped), false);
  relay.release('b1');
  await wakeB;
  assert.equal(await settled(stopped), false, 'thread A is still running');
  relay.release('a2');
  await stopped;
  await wakeA;
  assert.deepEqual(
    relay.events.filter((event) => event.startsWith('end:')).sort(),
    ['end:a1', 'end:a2', 'end:b1'],
  );
  // Shutdown refuses new wakes.
  relay.enqueue('c1', '300.1', false);
  await relay.wake();
  assert.equal(relay.started.has('c1'), false);
});
