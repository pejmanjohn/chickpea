import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { experimental_readRawConfig } from 'wrangler';

// @ts-expect-error The cross-platform executable .mjs intentionally has no declaration file.
import { ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS, applyCloudflareDeploymentProfile, classifyCloudflareDeploymentProfile, resolveCloudflareDeploymentProfile, resolveCloudflareDeploymentTarget } from '../scripts/cloudflare-deployment-profile.mjs';

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

  assert.equal(config.name, 'chickpea');
  assert.deepEqual(config.d1_databases, [{
    binding: 'AUTH_DB',
    database_name: 'chickpea-auth-db',
    database_id: '',
    migrations_dir: 'migrations/better-auth',
  }]);
  assert.equal(config.vars?.CHICKPEA_DEPLOY_TARGET, undefined);

  assert.equal(
    bindings.some((binding: { name?: string }) => binding.name === 'SANDBOX'),
    false,
  );
  assert.deepEqual(config.containers ?? [], []);
  assert.deepEqual(
    (config.migrations ?? []).map((migration: { tag?: string }) => migration.tag),
    ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'],
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
  assert.deepEqual(
    config.migrations?.find((migration: { tag?: string }) => migration.tag === 'v9')
      ?.new_sqlite_classes,
    ['SlackGatewaySession'],
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

test('amber and cobalt resolve distinct Worker, D1, and stamped schema identities', async () => {
  assert.deepEqual(ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS, ['amber', 'cobalt']);
  const tuples = [];

  for (const target of ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS) {
    const config = await authoredConfig();
    const tuple = applyCloudflareDeploymentProfile(config, {
      CHICKPEA_DEPLOY_TARGET: target,
    });
    tuples.push(tuple);

    assert.deepEqual(tuple, {
      target,
      workerName: `chickpea-${target}-live`,
      authDatabaseBinding: 'AUTH_DB',
      authDatabaseName: `chickpea-auth-db-${target}-live`,
      authDatabaseId: undefined,
      d1SchemaGeneration: '0002_mcp_oauth',
      durableObjectSchemaGeneration: 'v9',
      schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
      stateMode: 'disposable',
    });
    assert.equal(config.name, tuple.workerName);
    assert.equal(config.topLevelName, tuple.workerName);
    assert.deepEqual(config.d1_databases, [{
      binding: 'AUTH_DB',
      database_name: tuple.authDatabaseName,
      database_id: '',
      migrations_dir: 'migrations/better-auth',
    }]);
    assert.deepEqual(config.vars, {
      CHICKPEA_DEPLOY_TARGET: target,
      CHICKPEA_AUTH_DB_SCHEMA_GENERATION: '0002_mcp_oauth',
      CHICKPEA_DURABLE_OBJECT_SCHEMA_GENERATION: 'v9',
      CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
      CHICKPEA_DEPLOY_STATE_MODE: 'disposable',
    });
  }

  assert.equal(new Set(tuples.map((tuple) => tuple.workerName)).size, 2);
  assert.equal(new Set(tuples.map((tuple) => tuple.authDatabaseName)).size, 2);
  assert.throws(() => resolveCloudflareDeploymentTarget('fern'), /Invalid CHICKPEA_DEPLOY_TARGET/);

  const unregistered = await authoredConfig();
  assert.throws(
    () => applyCloudflareDeploymentProfile(unregistered, {
      CHICKPEA_DEPLOY_TARGET: 'dedicated-qa',
    }),
    /Invalid CHICKPEA_DEPLOY_TARGET.*amber, cobalt/,
  );
  assert.equal(unregistered.name, 'chickpea');
});

test('standalone profiles refuse the parked Enterprise deployment names', async () => {
  const config = await authoredConfig();
  assert.throws(() => applyCloudflareDeploymentProfile(config, {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'legacy-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
  }, {
    registeredTargetIdentities: [{
      target: 'amber', workerName: 'chickpea-amber',
      authDatabaseBinding: 'AUTH_DB', authDatabaseName: 'chickpea-auth-db-amber',
      authDatabaseId: 'legacy-database-id',
    }],
  }), /immutable AUTH_DB identity/i);
  assert.equal(config.name, 'chickpea');
});

test('an immutable D1 ID is accepted only for the selected target name and AUTH_DB binding', async () => {
  const config = await authoredConfig();
  config.d1_databases[0].database_id = 'production-database-id';
  const tuple = applyCloudflareDeploymentProfile(config, {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'amber-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
  }, {
    registeredTargetIdentities: [{
      target: 'amber',
      workerName: 'chickpea-amber-live',
      authDatabaseBinding: 'AUTH_DB',
      authDatabaseName: 'chickpea-auth-db-amber-live',
      authDatabaseId: 'amber-database-id',
    }],
  });

  assert.equal(tuple.authDatabaseId, 'amber-database-id');
  assert.equal(tuple.stateMode, 'permanent');
  assert.equal(config.d1_databases[0].database_id, 'amber-database-id');
  assert.equal(config.vars.CHICKPEA_DEPLOY_STATE_MODE, 'permanent');

  for (const registration of [
    { authDatabaseBinding: 'OTHER_DB', authDatabaseName: 'chickpea-auth-db-amber-live' },
    { authDatabaseBinding: 'AUTH_DB', authDatabaseName: 'other-database' },
  ]) {
    const invalid = await authoredConfig();
    assert.throws(
      () => applyCloudflareDeploymentProfile(invalid, {
        CHICKPEA_DEPLOY_TARGET: 'amber',
        CHICKPEA_DEPLOY_AUTH_DB_ID: 'amber-database-id',
        CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
      }, {
        registeredTargetIdentities: [{
          target: 'amber',
          workerName: 'chickpea-amber-live',
          authDatabaseId: 'amber-database-id',
          ...registration,
        }],
      }),
      /immutable AUTH_DB identity.*amber/i,
    );
  }
});

test('a D1 ID registered to another active target fails before the config is mutated', async () => {
  const config = await authoredConfig();

  assert.throws(
    () => applyCloudflareDeploymentProfile(config, {
      CHICKPEA_DEPLOY_TARGET: 'amber',
      CHICKPEA_DEPLOY_AUTH_DB_ID: 'shared-database-id',
      CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    }, {
      registeredTargetIdentities: [{
        target: 'cobalt',
        workerName: 'chickpea-cobalt-live',
        authDatabaseBinding: 'AUTH_DB',
        authDatabaseName: 'chickpea-auth-db-cobalt-live',
        authDatabaseId: 'shared-database-id',
      }],
    }),
    /AUTH_DB identity.*cobalt.*amber/i,
  );
  assert.equal(config.name, 'chickpea');
  assert.equal(config.d1_databases[0].database_name, 'chickpea-auth-db');
});

test('target resolution rejects ambiguous AUTH_DB bindings before changing Worker identity', async () => {
  const config = await authoredConfig();
  config.d1_databases.push(structuredClone(config.d1_databases[0]));

  assert.throws(
    () => applyCloudflareDeploymentProfile(config, { CHICKPEA_DEPLOY_TARGET: 'cobalt' }),
    /exactly one AUTH_DB binding/i,
  );
  assert.equal(config.name, 'chickpea');
});

test('migration-bearing target state is disposable or explicitly advanced to the current generation', async () => {
  const disposable = await authoredConfig();
  assert.equal(
    applyCloudflareDeploymentProfile(disposable, { CHICKPEA_DEPLOY_TARGET: 'cobalt' })
      .stateMode,
    'disposable',
  );

  for (const generation of [undefined, 'd1:0001_better_auth;do:v8']) {
    const permanent = await authoredConfig();
    assert.throws(
      () => applyCloudflareDeploymentProfile(permanent, {
        CHICKPEA_DEPLOY_TARGET: 'cobalt',
        CHICKPEA_DEPLOY_AUTH_DB_ID: 'cobalt-database-id',
        ...(generation ? { CHICKPEA_DEPLOY_SCHEMA_GENERATION: generation } : {}),
      }),
      /permanent target cobalt.*schema generation.*d1:0002_mcp_oauth;do:v9/i,
    );
  }
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
