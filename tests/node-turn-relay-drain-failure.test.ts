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

    // The relay is not wedged: `draining` was cleared, so the next wake drains.
    await wakeNodeTurnRelay(undefined, overrides);
    assert.equal(listCalls, 2);
  } finally {
    mock.restoreAll();
  }
});
