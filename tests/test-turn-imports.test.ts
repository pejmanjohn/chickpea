import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reachable } from './helpers/import-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_RUN_MODULES = [
  'src/agents/test-turn.ts', 'src/agents/test-run-plan.ts',
  // The state store's side and the tools that start and read a run.
  'src/state/test-run-lifecycle.ts', 'src/state/test-run-instance.ts', 'src/management/test-runs.ts',
  'src/management/mcp-v5/test-runs.ts',
];

test('a test run reaches no Slack ingress, delivery or TurnJob, and no routine run, even through import()', () => {
  const reached = reachable(TEST_RUN_MODULES, true);
  for (const module of ['src/slack/run-turn.ts', 'src/slack/flue-dispatch.ts', 'src/slack/turn-executor.ts', 'src/routines/execution.ts']) {
    assert.equal(reached.has(module), false, `${module} through ${reached.get(module)?.join(' -> ')}`);
  }
});

test('Help-improve capture starts only from a Slack turn or a routine run, which a test run never reaches', () => {
  const starters = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && file !== join('review', 'capture.ts'))
    .filter((file) => /\bstartRunReview\b/.test(readFileSync(join(ROOT, 'src', file), 'utf8')))
    .map((file) => join('src', file))
    .sort();
  assert.deepEqual(starters, ['src/routines/execution.ts', 'src/slack/run-turn.ts']);
});
