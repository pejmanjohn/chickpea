import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SlackStateStore } from '../src/slack/claim-store.ts';
import { slackPresentationStatePort } from '../src/slack/node-turn-relay.ts';

const noop = () => undefined;

function coreState(overrides: Record<string, unknown> = {}): SlackStateStore {
  return {
    getRunPresentation: noop,
    getLatestThreadSessionGeneration: noop,
    transitionRunPresentation: noop,
    reserveSlackAppend: noop,
    applySlackAppendCooldown: noop,
    matchFlueObservation: noop,
    ...overrides,
  } as unknown as SlackStateStore;
}

test('optional activity budget methods do not disable the core presentation port', () => {
  const withoutBudget = slackPresentationStatePort(coreState());
  assert.ok(withoutBudget);
  assert.equal(withoutBudget.reserveSlackActivityStatus, undefined);
  assert.equal(withoutBudget.applySlackActivityStatusCooldown, undefined);

  const incompleteBudget = slackPresentationStatePort(coreState({
    reserveSlackActivityStatus: noop,
  }));
  assert.ok(incompleteBudget);
  assert.equal(incompleteBudget.reserveSlackActivityStatus, undefined);

  const completeBudget = slackPresentationStatePort(coreState({
    reserveSlackActivityStatus: noop,
    applySlackActivityStatusCooldown: noop,
  }));
  assert.ok(completeBudget?.reserveSlackActivityStatus);
  assert.ok(completeBudget?.applySlackActivityStatusCooldown);
});
