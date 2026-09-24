import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { QA_TARGETS } from '../src/config/qa-targets.ts';
// @ts-expect-error The dependency-free lane list is plain JavaScript.
import { isQaLane, QA_LANES } from '../scripts/lib/qa-lanes.mjs';
// @ts-expect-error Lane tooling JavaScript helper.
import { LANE_SECRET_TARGETS } from '../scripts/lib/lane-secrets.mjs';

test('scripts and the TypeScript config name the same QA lanes', () => {
  assert.deepEqual([...QA_LANES], [...QA_TARGETS]);
  assert.equal(LANE_SECRET_TARGETS, QA_LANES);
  assert.ok(Object.isFrozen(QA_LANES));
  for (const lane of QA_TARGETS) assert.equal(isQaLane(lane), true);
  for (const value of ['production', 'Amber', '', undefined, null, 1]) assert.equal(isQaLane(value), false);
});

test('the lane list module stays dependency-free for the production deploy path', () => {
  const source = readFileSync(new URL('../scripts/lib/qa-lanes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
});

test('scripts do not keep their own copy of the lane list', () => {
  for (const file of ['scripts/deploy-with-epilogue.mjs', 'scripts/lib/lane-secrets.mjs', 'scripts/diagnose-request.mjs']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\[\s*'amber',\s*'cobalt'/, file);
  }
});
