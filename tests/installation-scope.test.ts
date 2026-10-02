import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertInstallationOwnership,
  deploymentTenancy,
  installationObjectName,
  installationOwnershipOf,
  installationScopeOf,
  installationScopeOfObjectName,
  objectInstallationEnv,
  parseInstallationOwnership,
  requireInstallationScope,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import { tagStateInstanceName, tagStateStub } from '../src/config/state-rpc.ts';

const hosted = { CHICKPEA_TENANCY: 'installation', MY_BINDING: { kind: 'binding' } };
const ownershipA = { version: 1, installationId: 'inst_a' } as const;

test('standalone deployments keep every name and need no scope', () => {
  assert.equal(deploymentTenancy(undefined), 'standalone');
  assert.equal(deploymentTenancy({}), 'standalone');
  assert.equal(requireInstallationScope({}), undefined);
  assert.equal(installationObjectName({}, 'T1:C1:1.0'), 'T1:C1:1.0');
  assert.equal(tagStateInstanceName({}), 'singleton');
  assert.equal(deploymentTenancy({ CHICKPEA_TENANCY: 'standalone' }), 'standalone');
  const env = {};
  assert.equal(objectInstallationEnv({ id: { name: 'singleton' } }, env), env);
  assert.throws(() => objectInstallationEnv({ id: { name: 'i1~inst_a~singleton' } }, env), /serves no installation/);
  assert.throws(() => scopeInstallationEnv({}, { installationId: 'inst_a' }), /installation tenancy/);
  assert.throws(() => deploymentTenancy({ CHICKPEA_TENANCY: 'hosted' }), /must be "standalone", "installation" or unset/);
});

test('an installation scope is an immutable copy that keeps every binding', () => {
  const scoped = scopeInstallationEnv(hosted, { installationId: 'inst_a' });
  assert.notEqual(scoped, hosted);
  assert.equal(installationScopeOf(hosted), undefined);
  assert.deepEqual(installationScopeOf(scoped), { installationId: 'inst_a' });
  assert.equal(scoped.MY_BINDING, hosted.MY_BINDING);
  assert.ok(Object.isFrozen(scoped));
  assert.equal(scopeInstallationEnv(scoped, { installationId: 'inst_a' }), scoped);
  assert.throws(
    () => scopeInstallationEnv(scoped, { installationId: 'inst_b' }),
    (error: Error & { code?: string }) => error.code === 'installation_context_mismatch',
  );
  // A deployment variable or JSON payload cannot impersonate the scope.
  const forged = { ...hosted, installationId: 'inst_a', scope: { installationId: 'inst_a' } };
  assert.equal(installationScopeOf(forged), undefined);
  assert.throws(() => scopeInstallationEnv(hosted, { installationId: '../x' }), /malformed/);
});

test('installation tenancy names every object under its installation and refuses an unscoped env', () => {
  const a = scopeInstallationEnv(hosted, { installationId: 'inst_a' });
  const b = scopeInstallationEnv(hosted, { installationId: 'inst_b' });
  assert.equal(installationObjectName(a, 'T1:C1:1.0'), 'i1~inst_a~T1:C1:1.0');
  assert.equal(installationObjectName(b, 'T1:C1:1.0'), 'i1~inst_b~T1:C1:1.0');
  assert.equal(tagStateInstanceName(a), 'i1~inst_a~singleton');
  assert.throws(
    () => installationObjectName(hosted, 'T1:C1:1.0'),
    (error: Error & { code?: string }) => error.code === 'installation_context_missing',
  );
  assert.throws(() => tagStateInstanceName(hosted), /has none/);
  assert.throws(
    () => tagStateInstanceName({ ...a, TAG_STATE_INSTANCE_NAME: 'agent-first-v1' }),
    /cannot be set with installation tenancy/,
  );

});

test('two installations with colliding resource names address different state stores', () => {
  const names: string[] = [];
  const binding = { getByName(name: string) { names.push(name); return {} as never; } };
  const deployment = { ...hosted, TAG_STATE: binding };
  tagStateStub(scopeInstallationEnv(deployment, { installationId: 'inst_a' }));
  tagStateStub(scopeInstallationEnv(deployment, { installationId: 'inst_b' }));
  assert.deepEqual(names, ['i1~inst_a~singleton', 'i1~inst_b~singleton']);
  assert.throws(() => tagStateStub(deployment), /has none/);
  assert.equal(names.length, 2);
});

test('an object recovers its installation from its own name, and an unscoped name fails closed', () => {
  assert.deepEqual(installationScopeOfObjectName('i1~inst_a~T1:C1:1.0'), { installationId: 'inst_a' });
  assert.equal(installationScopeOfObjectName('T1:C1:1.0'), undefined);
  assert.equal(installationScopeOfObjectName('i1~inst_a~'), undefined);
  assert.equal(installationScopeOfObjectName('i1~bad id~x'), undefined);
  assert.equal(installationScopeOfObjectName(undefined), undefined);

  const restored = objectInstallationEnv({ id: { name: 'i1~inst_a~singleton' } }, hosted);
  assert.deepEqual(installationScopeOf(restored), { installationId: 'inst_a' });
  assert.equal(tagStateInstanceName(restored), 'i1~inst_a~singleton');
  const unnamed = objectInstallationEnv({ id: {} }, hosted);
  assert.equal(unnamed, hosted);
  assert.throws(() => tagStateInstanceName(unnamed), /has none/);
});

test('persisted ownership parses strictly and must match the acting installation', () => {
  assert.deepEqual(parseInstallationOwnership(ownershipA), ownershipA);
  for (const bad of [
    undefined,
    { ...ownershipA, version: 2 },
    { ...ownershipA, installationId: '' },
    { ...ownershipA, organizationId: 'org_a' },
    { installationId: 'inst_a' },
  ]) {
    assert.throws(() => parseInstallationOwnership(bad), /malformed/);
  }
  const a = scopeInstallationEnv(hosted, { installationId: 'inst_a' });
  const b = scopeInstallationEnv(hosted, { installationId: 'inst_b' });
  assert.equal(installationOwnershipOf({}), undefined);
  assert.deepEqual(installationOwnershipOf(a), ownershipA);
  assert.throws(() => installationOwnershipOf(hosted), /has none/);
  assertInstallationOwnership(undefined, {});
  assertInstallationOwnership(ownershipA, a);
  for (const [ownership, env] of [
    [ownershipA, b],
    [undefined, a],
    [ownershipA, {}],
  ] as const) {
    assert.throws(
      () => assertInstallationOwnership(ownership, env),
      (error: Error & { code?: string }) => error.code === 'installation_context_mismatch',
    );
  }
  assert.throws(() => assertInstallationOwnership(ownershipA, hosted), /has none/);
});
