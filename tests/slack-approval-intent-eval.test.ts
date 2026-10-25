import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const SCRIPT = 'scripts/evaluate-slack-approval-intent.mjs';

test('the offline evaluator checks the corpus and the production approval side call against a stubbed provider', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.ok(report.corpus.approve >= 15 && report.corpus.decline >= 8 && report.corpus.other >= 12);
  assert.equal(report.smoke, report.corpus.approve + report.corpus.decline + report.corpus.other);
});

test('live mode refuses a report inside a checkout before any call, and its flags need --live', () => {
  const inside = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--live', '--model', 'anthropic/claude-sonnet-5',
    '--output', `${process.cwd()}/tmp-slack-approval-report.json`], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-not-a-key' },
  });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside Git/);
  const flags = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--model', 'anthropic/claude-sonnet-5'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.notEqual(flags.status, 0);
  assert.match(flags.stderr, /--model requires --live/);
});
