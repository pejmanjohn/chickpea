import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Release tooling JavaScript helper.
import { writePrivateJson, readPrivateJson, writeDeploymentEvent } from '../scripts/lib/upgrade-receipt.mjs';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
// @ts-expect-error Release tooling JavaScript helper.
import { executePreparedUpgrade } from '../scripts/lib/upgrade-execution.mjs';

function harness(failure?: 'before' | 'after') {
  const receipt = { previous: { version: '0.1.0', commit: 'a' }, destination: { version: '0.1.1', commit: 'b' } };
  const initial = { version: '0.1.0', commit: 'a', fingerprint: 'old:100', workerVersion: 'old', resourceDigest: 'same' };
  let current = initial;
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-upgrade-events-'));
  directories.push(directory);
  const context = join(directory, 'context.json');
  const event = join(directory, 'deployment.json');
  let deployments = 0;
  const stages: string[] = [];
  const options = { receipt, initial, inspect: async () => current, readEvent: () => existsSync(event) ? readPrivateJson(event) : undefined,
    save: async (value: any) => { stages.push(value.stage); Object.assign(receipt, value); }, prepare: async () => {}, confirm: async () => true,
    deploy: async (source: any) => {
      deployments++;
      writePrivateJson(context, { source });
      writeDeploymentEvent(context, 'deploying');
      if (failure === 'before') throw new Error('pre-upload interruption');
      current = { ...initial, ...source, workerVersion: `new-${deployments}`, fingerprint: `new-${deployments}:100` };
      writeDeploymentEvent(context, 'uploaded', current.workerVersion);
      if (failure !== 'after') writeDeploymentEvent(context, 'ready', current.workerVersion);
      if (failure === 'after') throw new Error('readiness interruption');
    } };
  return { options, stages, count: () => deployments, repair: () => { failure = undefined; }, fail: (next: 'before' | 'after') => { failure = next; }, change: () => { current = { ...current, workerVersion: 'foreign', fingerprint: 'foreign:100' }; } };
}
test('confirmed upgrade verifies serving identity; cancellation makes no mutation', async () => {
  const value = harness();
  assert.equal(await executePreparedUpgrade(value.options), 'succeeded');
  assert.deepEqual(value.stages, ['deploying', 'succeeded']);
  const cancelled = harness(); cancelled.options.confirm = async () => false;
  assert.equal(await executePreparedUpgrade(cancelled.options), 'cancelled');
  assert.equal(cancelled.count(), 0);
});
test('pre-upload interruption can retry the prior serving state', async () => {
  const value = harness('before');
  await assert.rejects(executePreparedUpgrade(value.options), /pre-upload/);
  assert.equal(value.stages.at(-1), 'needs-inspection');
  value.repair();
  assert.equal(await executePreparedUpgrade(value.options), 'succeeded');
});
test('post-upload interruption supports independent prior-code recovery', async () => {
  const value = harness('after');
  await assert.rejects(executePreparedUpgrade(value.options), /readiness/);
  value.repair();
  assert.equal(await executePreparedUpgrade({ ...value.options, direction: 'recover' }), 'recovered');
});
test('a foreign serving version never becomes an authorized retry', async () => {
  const value = harness('after');
  await assert.rejects(executePreparedUpgrade(value.options));
  value.repair(); value.change();
  await assert.rejects(executePreparedUpgrade(value.options), /unrelated/);
  assert.equal(value.count(), 1);
});
test('a completed recovery can be resumed without another deployment', async () => {
  const value = harness('after');
  await assert.rejects(executePreparedUpgrade(value.options));
  value.repair();
  await executePreparedUpgrade({ ...value.options, direction: 'recover' });
  assert.equal(await executePreparedUpgrade({ ...value.options, direction: 'recover' }), 'recovered');
  assert.equal(value.count(), 2);
});

test('retry and recovery retain known uploads after another pre-upload interruption', async () => {
  for (const direction of ['upgrade', 'recover']) {
    const value = harness('after');
    await assert.rejects(executePreparedUpgrade(value.options), /readiness/);
    value.fail('before');
    await assert.rejects(executePreparedUpgrade({ ...value.options, direction }), /pre-upload/);
    value.repair();
    assert.equal(await executePreparedUpgrade({ ...value.options, direction: 'recover' }), 'recovered');
    // A bare resume honors the saved recovery direction and does not deploy.
    const count = value.count();
    assert.equal(await executePreparedUpgrade(value.options), 'recovered');
    assert.equal(value.count(), count);
  }
});
test('interrupted recovery resumes previous code using its saved direction', async () => {
  const value = harness('after');
  await assert.rejects(executePreparedUpgrade(value.options), /readiness/);
  await assert.rejects(executePreparedUpgrade({ ...value.options, direction: 'recover' }), /readiness/);
  value.repair();
  assert.equal(await executePreparedUpgrade(value.options), 'recovered');
});
