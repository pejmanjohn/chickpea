import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHICKPEA_GATEWAY_PROTOCOL_VERSION } from '../src/slack/gateway/protocol.ts';

test('the retained initial recipe covers populated state and every recovery boundary', () => {
  const recipe = JSON.parse(readFileSync(new URL('../fixtures/upgrades/v0.1.0.json', import.meta.url), 'utf8'));
  assert.equal(recipe.applicationVersion, '0.1.0');
  assert.equal(recipe.gatewayProtocolVersion, CHICKPEA_GATEWAY_PROTOCOL_VERSION);
  assert.equal(recipe.actors.length, 2);
  assert.equal(recipe.schedule.occurrenceBudget, 2);
  for (const state of ['owner-and-member-access', 'agent-id-instructions-and-channel-grants', 'memory-content-and-scope', 'connection-id-owner-and-real-provider-read', 'schedule-id-prompt-destination-and-pause-state']) assert.ok(recipe.preserve.includes(state));
  assert.deepEqual(recipe.transitions, ['compatible-upgrade', 'interruption-before-upload-and-retry', 'interruption-after-upload-and-code-recovery']);
  assert.doesNotMatch(JSON.stringify(recipe), /xox[baprs]-|workers\.dev|@.*\.com/);
});
