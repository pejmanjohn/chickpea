import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/verify-openai-subscription-protocol.mjs', import.meta.url));

test('subscription proof offline contract runs without starting authorization', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline adapter contract verified/);
  assert.doesNotMatch(result.stdout, /Enter code:/);
});

test('subscription proof rejects an unreviewed model before authorization or network access', () => {
  const networkBlocker = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch=async()=>{throw new Error("network access forbidden")}',
  );
  const result = spawnSync(process.execPath, [
    '--import', networkBlocker,
    '--import', 'tsx',
    script,
    '--live',
    '--model', '../unsafe',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported_model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Enter code:|network access forbidden/);
});

test('subscription proof rejects a missing timeout value before authorization', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', script, '--live', '--request-timeout-ms',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /protocol_drift/);
  assert.doesNotMatch(result.stdout, /Enter code:/);
});
