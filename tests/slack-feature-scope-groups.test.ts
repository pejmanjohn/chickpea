import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_APP_BOT_SCOPES,
  recoverableSlackFeatureScopeSets,
  REQUESTED_SLACK_BOT_SCOPES,
  REQUIRED_SLACK_BOT_SCOPES,
  SLACK_FEATURE_SCOPE_GROUPS,
  SLACK_FEATURE_SCOPES,
  subsets,
} from '../src/slack/scopes.ts';

const FEATURE_SCOPES = ['lists:read', 'lists:write', 'mpim:history'];

test('the feature scope groups flatten to the pinned feature scopes, none required, all requested', () => {
  assert.deepEqual(SLACK_FEATURE_SCOPE_GROUPS.flat(), FEATURE_SCOPES);
  assert.deepEqual([...SLACK_FEATURE_SCOPES], FEATURE_SCOPES);
  assert.deepEqual(FEATURE_SCOPES.filter((scope) => REQUIRED_SLACK_BOT_SCOPES.includes(scope)), []);
  assert.deepEqual(FEATURE_SCOPES.filter((scope) => !REQUESTED_SLACK_BOT_SCOPES.includes(scope)), []);
  assert.deepEqual(new Set(FEATURE_SCOPES).size, FEATURE_SCOPES.length, 'no scope sits in two groups');
});

test('recoverable feature scope sets start with the grant, hold every whole-group combination, and never a partial group', () => {
  const bound = 1 + 2 ** SLACK_FEATURE_SCOPE_GROUPS.length;
  const wholeGroupSets = subsets(SLACK_FEATURE_SCOPE_GROUPS).map((groups) => groups.flat());
  assert.equal(wholeGroupSets.length, 2 ** SLACK_FEATURE_SCOPE_GROUPS.length);
  const keys = (sets: readonly (readonly string[])[]) => sets.map((scopes) => scopes.join(','));

  for (const granted of [
    [], ['chat:write'], ['lists:read'], [...SLACK_FEATURE_SCOPES], [...REQUESTED_SLACK_BOT_SCOPES],
    [...SLACK_FEATURE_SCOPES].reverse(), [SLACK_FEATURE_SCOPE_GROUPS.at(-1)![0]!],
  ]) {
    const sets = recoverableSlackFeatureScopeSets(granted);
    assert.ok(sets.length <= bound, `${granted.join(',')}: ${sets.length} sets`);
    assert.deepEqual(sets[0], SLACK_FEATURE_SCOPES.filter((scope) => granted.includes(scope)), 'the grant comes first, in manifest order');
    for (const whole of wholeGroupSets) assert.ok(keys(sets).includes(whole.join(',')), `${granted.join(',')} lacks ${whole.join(',')}`);
    assert.equal(new Set(keys(sets)).size, sets.length, 'deduplicated');
    for (const scopes of sets.slice(1)) {
      for (const group of SLACK_FEATURE_SCOPE_GROUPS) {
        const held = group.filter((scope) => scopes.includes(scope)).length;
        assert.ok(held === 0 || held === group.length, `${scopes.join(',')} holds part of ${group.join(',')}`);
      }
    }
  }

  // A grant that is itself a whole-group combination adds no set of its own.
  assert.equal(recoverableSlackFeatureScopeSets([...REQUESTED_SLACK_BOT_SCOPES]).length, bound - 1);
  assert.equal(recoverableSlackFeatureScopeSets([]).length, bound - 1);
  // A grant that is a partial group is the one set beyond the whole groups.
  const partial = SLACK_FEATURE_SCOPE_GROUPS.find((group) => group.length > 1);
  if (partial) {
    const sets = recoverableSlackFeatureScopeSets([partial[0]!]);
    assert.equal(sets.length, bound);
    assert.deepEqual(sets[0], [partial[0]]);
  }
});

test('an Agent\'s own app asks for none of the feature scopes added after group DMs', () => {
  for (const scope of SLACK_FEATURE_SCOPE_GROUPS.slice(3).flat()) {
    assert.equal(AGENT_APP_BOT_SCOPES.includes(scope), false, scope);
  }
});
