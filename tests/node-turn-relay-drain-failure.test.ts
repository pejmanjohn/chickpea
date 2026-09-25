import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Keep the ambient config store the drain opens off any on-disk database.
process.env.SLACK_STATE_DB_PATH = ':memory:';

import type { SlackStateStore } from '../src/slack/claim-store.ts';
import type { WorkStore } from '../src/work/types.ts';
import { wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';

const noop = async () => undefined;

/**
 * A store failure inside the drain must not reject the wake promise: every
 * production caller wakes the relay with `void wakeNodeTurnRelay(...)`, so a
 * rejection would terminate the Node process as an unhandled rejection.
 */
test('a failing drain resolves the wake and leaves the relay drainable', async () => {
  let listCalls = 0;
  const state = {
    // Satisfies the drain's capability gate so it reaches listPendingTurns.
    listPendingTurns: async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error('state db is locked');
      return [];
    },
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
    markTurnDelivered: noop,
    discardTurn: noop,
    setActiveWork: noop,
  } as unknown as SlackStateStore;

  const overrides = {
    state,
    work: {} as unknown as WorkStore,
    executeTurn: noop as never,
  };

  const errors = mock.method(console, 'error', () => undefined);
  // An injected state marks a test drain, so no retry timer may be scheduled.
  const timers = mock.method(globalThis, 'setTimeout');
  try {
    await assert.doesNotReject(() => wakeNodeTurnRelay(undefined, overrides));
    assert.equal(listCalls, 1);
    assert.equal(timers.mock.callCount(), 0);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(
      String(errors.mock.calls[0]?.arguments[0]),
      /node turn relay drain failed/,
    );

    // The relay is not wedged: the failed listing left no thread loop or
    // wake-level pass behind, so the next wake drains.
    await wakeNodeTurnRelay(undefined, overrides);
    assert.equal(listCalls, 2);
  } finally {
    mock.restoreAll();
  }
});

/**
 * A store that fails while the drain is being built (a failed SQLite open)
 * must resolve the wake too: the heartbeat and retry timers call it with `void`.
 */
test('a failure building the thread drain resolves the wake', async () => {
  const state = {
    get listPendingTurns(): never {
      throw new Error('unable to open database file');
    },
  } as unknown as SlackStateStore;
  const errors = mock.method(console, 'error', () => undefined);
  const timers = mock.method(globalThis, 'setTimeout');
  try {
    await assert.doesNotReject(() => wakeNodeTurnRelay(undefined, {
      state,
      work: {} as unknown as WorkStore,
      executeTurn: noop as never,
    }));
    assert.equal(timers.mock.callCount(), 0);
    assert.match(
      String(errors.mock.calls[0]?.arguments[0]),
      /node turn relay drain failed/,
    );
  } finally {
    mock.restoreAll();
  }
});

/**
 * A store failure inside one thread loop resolves that wake, releases the
 * thread, and does not stop the next wake from running the thread again.
 */
test('a failing thread loop resolves the wake and frees its thread', async () => {
  let attempts = 0;
  let delivered = false;
  const job = {
    id: 'turn_1',
    attempts: 0,
    turn: {
      workspaceId: 'T1', channelId: 'C1', threadTs: '100.1', ts: '100.1',
      userId: 'U1', text: 'hi', source: 'app_mention',
    },
    assignment: { agentId: 'analyst' },
    progress: {},
  };
  const state = {
    listPendingTurns: async () => (delivered ? [] : [{ ...job }]),
    freezeRuntimePlan: noop,
    prepareFlueDispatch: noop,
    reconcileFlueExistingInstance: noop,
    recordFlueReceipt: noop,
    recordFlueSettlement: noop,
    matchFlueObservation: noop,
    markTurnRecoveryRequired: noop,
    recordTurnAttempt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('state db is locked');
    },
    recordInteractionIntent: noop,
    recordSlackInteractionProgress: noop,
    markTurnDelivered: async () => { delivered = true; },
    discardTurn: noop,
    setActiveWork: noop,
  } as unknown as SlackStateStore;
  let executions = 0;
  const overrides = {
    state,
    work: {} as unknown as WorkStore,
    executeTurn: (async () => { executions += 1; }) as never,
  };

  const errors = mock.method(console, 'error', () => undefined);
  const timers = mock.method(globalThis, 'setTimeout');
  try {
    await assert.doesNotReject(() => wakeNodeTurnRelay(undefined, overrides));
    assert.equal(executions, 0);
    assert.equal(timers.mock.callCount(), 0);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(
      String(errors.mock.calls[0]?.arguments[0]),
      /node turn relay drain failed/,
    );

    // The failed loop released its thread, so the next wake runs the turn.
    await wakeNodeTurnRelay(undefined, overrides);
    assert.equal(executions, 1);
    assert.equal(delivered, true);
  } finally {
    mock.restoreAll();
  }
});
