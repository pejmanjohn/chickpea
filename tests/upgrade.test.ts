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

// @ts-expect-error Release tooling JavaScript helper.
import { createRecoveryAuthority, validateRecoveryAuthority } from '../scripts/lib/upgrade-receipt.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { requestDeliveryRecovery } from '../scripts/lib/upgrade-execution.mjs';

test('recovery authority is stable private material with a validated digest', () => {
  const authority = createRecoveryAuthority();
  assert.equal(authority.capability.length, 43);
  assert.deepEqual(validateRecoveryAuthority(authority), authority);
  assert.notEqual(createRecoveryAuthority().capability, authority.capability);
  assert.throws(() => validateRecoveryAuthority({ ...authority, digest: 'invalid' }), /authority/);
});

test('transport rollback precedes old code and retries lost responses without deploying old code', async () => {
  const value = harness();
  Object.assign(value.options.receipt, { recovery: createRecoveryAuthority() });
  await executePreparedUpgrade(value.options);
  let calls = 0;
  const recoverDelivery = async () => {
    calls++;
    assert.equal(value.count(), 1);
    if (calls === 1) throw new Error('lost rollback response');
  };
  await assert.rejects(executePreparedUpgrade({ ...value.options, direction: 'recover', recoverDelivery }), /lost rollback/);
  assert.equal(value.count(), 1);
  assert.equal(await executePreparedUpgrade({ ...value.options, recoverDelivery }), 'recovered');
  assert.equal(value.count(), 2);
  assert.equal(calls, 2);
  assert.equal(await executePreparedUpgrade({ ...value.options, recoverDelivery }), 'recovered');
  assert.equal(calls, 2);
});

test('interrupted candidate upload is repaired and armed before delivery rollback', async () => {
  const value = harness('after');
  Object.assign(value.options.receipt, { recovery: createRecoveryAuthority() });
  await assert.rejects(executePreparedUpgrade(value.options), /readiness/);
  value.repair();
  const recoverDelivery = async (current: any) => {
    assert.equal(value.count(), 2);
    assert.equal(current.commit, value.options.receipt.destination.commit);
    assert.equal(value.options.readEvent().stage, 'ready');
  };
  assert.equal(await executePreparedUpgrade({ ...value.options, direction: 'recover', recoverDelivery }), 'recovered');
  assert.equal(value.count(), 3);
});

test('failed authority repair never rolls back delivery or deploys previous source', async () => {
  const value = harness('after');
  Object.assign(value.options.receipt, { recovery: createRecoveryAuthority() });
  await assert.rejects(executePreparedUpgrade(value.options));
  let calls = 0;
  await assert.rejects(executePreparedUpgrade({ ...value.options, direction: 'recover', recoverDelivery: async () => { calls++; } }), /readiness/);
  assert.equal(calls, 0);
  assert.equal(value.options.readEvent().knownVersions.every((item: any) => item.commit === 'b'), true);
});

test('transport recovery fails closed on missing hook, foreign version, and cancellation', async () => {
  const value = harness();
  Object.assign(value.options.receipt, { recovery: createRecoveryAuthority() });
  await executePreparedUpgrade(value.options);
  await assert.rejects(executePreparedUpgrade({ ...value.options, direction: 'recover' }), /Transport recovery/);
  let calls = 0;
  const recoverDelivery = async () => { calls++; };
  value.options.confirm = async () => false;
  assert.equal(await executePreparedUpgrade({ ...value.options, recoverDelivery }), 'cancelled');
  assert.equal(calls, 0);
  value.change();
  await assert.rejects(executePreparedUpgrade({ ...value.options, recoverDelivery }), /unrelated/);
  assert.equal(value.count(), 1);
});

test('recovery request pins serving version and refuses redirects or failure statuses', async () => {
  const authority = createRecoveryAuthority();
  for (const status of [204, 302, 404, 503]) {
    const request = requestDeliveryRecovery({ url: 'https://test.workers.dev', workerVersion: 'serving-version', capability: authority.capability,
      fetchImpl: async (url: URL, options: RequestInit) => {
        assert.equal(url.pathname, '/internal/deployment/recover-delivery');
        assert.equal(options.redirect, 'manual');
        assert.equal((options.headers as any)['X-Chickpea-Target-Version'], 'serving-version');
        assert.equal((options.headers as any).Authorization, `Bearer ${authority.capability}`);
        return new Response(null, { status });
      } });
    if (status === 204) await request;
    else await assert.rejects(request, /not verified/);
  }
});

test('failed previous-code upload repeats durable rollback after repairing candidate readiness', async () => {
  const value = harness();
  Object.assign(value.options.receipt, { recovery: createRecoveryAuthority() });
  await executePreparedUpgrade(value.options);
  let rollbacks = 0;
  const recoverDelivery = async () => { rollbacks++; };
  value.fail('before');
  await assert.rejects(executePreparedUpgrade({ ...value.options, direction: 'recover', recoverDelivery }), /pre-upload/);
  assert.equal(rollbacks, 1);
  value.repair();
  assert.equal(await executePreparedUpgrade({ ...value.options, recoverDelivery }), 'recovered');
  assert.equal(rollbacks, 2);
});

test('another deployment during rollback blocks previous-code deployment', async () => {
  const value = harness();
  Object.assign(value.options.receipt, { recovery: createRecoveryAuthority() });
  await executePreparedUpgrade(value.options);
  await assert.rejects(executePreparedUpgrade({ ...value.options, direction: 'recover', recoverDelivery: async () => value.change() }), /serving installation changed/);
  assert.equal(value.count(), 1);
});
