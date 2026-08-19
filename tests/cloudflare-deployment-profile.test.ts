import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { experimental_readRawConfig } from 'wrangler';

// @ts-expect-error The cross-platform executable .mjs intentionally has no declaration file.
import { applyCloudflareDeploymentProfile, classifyCloudflareDeploymentProfile, resolveCloudflareDeploymentProfile } from '../scripts/cloudflare-deployment-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function authoredConfig() {
  const { rawConfig } = await experimental_readRawConfig({
    config: path.join(ROOT, 'wrangler.jsonc'),
  });
  return structuredClone(rawConfig);
}

test('root Cloudflare config is the slim core profile while retaining every migration', async () => {
  const config = await authoredConfig();
  const bindings = config.durable_objects?.bindings ?? [];

  assert.equal(
    bindings.some((binding: { name?: string }) => binding.name === 'SANDBOX'),
    false,
  );
  assert.deepEqual(config.containers ?? [], []);
  assert.deepEqual(
    (config.migrations ?? []).map((migration: { tag?: string }) => migration.tag),
    ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'],
  );
  assert.deepEqual(
    config.migrations?.find((migration: { tag?: string }) => migration.tag === 'v3')
      ?.new_sqlite_classes,
    ['Sandbox'],
  );
  assert.deepEqual(
    config.migrations?.find((migration: { tag?: string }) => migration.tag === 'v7')
      ?.new_sqlite_classes,
    ['AuthGuard'],
  );
  assert.deepEqual(
    config.migrations?.find((migration: { tag?: string }) => migration.tag === 'v8')
      ?.deleted_classes,
    ['AuthGuard'],
  );
});

test('deployment profile selector defaults to core and rejects unknown values', () => {
  assert.equal(resolveCloudflareDeploymentProfile(undefined), 'core');
  assert.equal(resolveCloudflareDeploymentProfile(''), 'core');
  assert.equal(resolveCloudflareDeploymentProfile('core'), 'core');
  assert.equal(resolveCloudflareDeploymentProfile('sandbox'), 'sandbox');
  assert.throws(
    () => resolveCloudflareDeploymentProfile('experimental'),
    /CHICKPEA_DEPLOY_PROFILE.*core.*sandbox/,
  );
});

test('sandbox overlay adds exactly one reviewed binding and container without changing core state', async () => {
  const core = await authoredConfig();
  const sandbox = structuredClone(core);
  applyCloudflareDeploymentProfile(sandbox, {
    CHICKPEA_DEPLOY_PROFILE: 'sandbox',
  });

  assert.equal(classifyCloudflareDeploymentProfile(core), 'core');
  assert.equal(classifyCloudflareDeploymentProfile(sandbox), 'sandbox');
  assert.deepEqual(sandbox.migrations, core.migrations);
  assert.deepEqual(sandbox.d1_databases, core.d1_databases);
  assert.deepEqual(
    sandbox.durable_objects.bindings.slice(0, core.durable_objects.bindings.length),
    core.durable_objects.bindings,
  );
  assert.deepEqual(sandbox.durable_objects.bindings.slice(-1), [
    { name: 'SANDBOX', class_name: 'Sandbox' },
  ]);
  assert.deepEqual(sandbox.containers, [
    {
      class_name: 'Sandbox',
      image: path.join(ROOT, 'Dockerfile'),
      instance_type: 'standard-1',
      max_instances: 25,
    },
  ]);
});

test('deploy-button name override keeps Worker and generated container identities paired', async () => {
  const config = await authoredConfig();
  applyCloudflareDeploymentProfile(config, {
    CHICKPEA_DEPLOY_PROFILE: 'sandbox',
    WRANGLER_CI_OVERRIDE_NAME: 'chickpea-consumer-fixture',
  });

  assert.equal(config.name, 'chickpea-consumer-fixture');
  assert.equal(config.topLevelName, 'chickpea-consumer-fixture');
  assert.equal(config.containers?.[0]?.name, undefined);
  assert.equal(
    `${config.topLevelName}-${config.containers?.[0]?.class_name}`.toLowerCase(),
    'chickpea-consumer-fixture-sandbox',
  );
});

test('profile classifier rejects partial and duplicate Sandbox infrastructure', async () => {
  const core = await authoredConfig();
  const bindingOnly = structuredClone(core);
  bindingOnly.durable_objects.bindings.push({ name: 'SANDBOX', class_name: 'Sandbox' });
  assert.throws(() => classifyCloudflareDeploymentProfile(bindingOnly), /partial or duplicate/i);

  const duplicate = structuredClone(core);
  applyCloudflareDeploymentProfile(duplicate, { CHICKPEA_DEPLOY_PROFILE: 'sandbox' });
  duplicate.containers.push(structuredClone(duplicate.containers[0]));
  assert.throws(() => classifyCloudflareDeploymentProfile(duplicate), /partial or duplicate/i);

  const wrongCapacity = structuredClone(core);
  applyCloudflareDeploymentProfile(wrongCapacity, { CHICKPEA_DEPLOY_PROFILE: 'sandbox' });
  wrongCapacity.containers[0].max_instances = 1;
  assert.throws(() => classifyCloudflareDeploymentProfile(wrongCapacity), /partial or duplicate/i);
});
