import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeContext } from '@earendil-works/pi-ai';
import { hasProvider, resetModelsForTests, resolveModel } from '@flue/runtime/internal';

import { registerCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import { ModelAccessError } from '../src/config/model-access.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { withEnv } from './helpers/env.ts';

function bindingSpy() {
  const calls: unknown[] = [];
  const binding = {
    run: async (...args: unknown[]) => { calls.push(args); throw new Error('the binding must not be called'); },
    models: async () => [],
  } as unknown as Parameters<typeof registerCloudflareBindingProvider>[0];
  return { binding, calls };
}

test('a deployment serving many installations registers a closed cloudflare provider: present, empty, refusing', async () => {
  resetModelsForTests();
  const { binding, calls } = bindingSpy();
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    assert.equal(registerCloudflareBindingProvider(binding, { CHICKPEA_TENANCY: 'installation', AI: binding }), false);
  });
  // Flue's generated entry installs its own binding provider only when none is registered.
  assert.equal(hasProvider('cloudflare'), true, 'the closed provider stands in for Flue\'s guarded default');
  const closed = registeredPiProvider('cloudflare');
  assert.ok(closed);
  assert.deepEqual(closed.getModels(), [], 'no cloudflare/<model> id resolves');
  assert.throws(() => resolveModel('cloudflare/@cf/zai-org/glm-4.7-flash'), /Unknown model|cloudflare/i);
  assert.throws(
    () => closed.streamSimple({ id: '@cf/x', provider: 'cloudflare' } as never, normalizeContext({ messages: [] }), {}),
    (error: unknown) => error instanceof ModelAccessError,
    'a request that reaches the provider is refused',
  );
  assert.equal(calls.length, 0, 'the binding is never called');
  await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
    assert.equal(registerCloudflareBindingProvider(binding, { AI: binding }), false, 'the process says installation tenancy');
    assert.equal(registeredPiProvider('cloudflare')!.getModels().length, 0);
  });
  await withEnv({ CHICKPEA_TENANCY: 'not-a-tenancy' }, async () => {
    assert.equal(registerCloudflareBindingProvider(binding, { AI: binding }), false, 'a tenancy the deployment cannot read fails closed');
  });
});

test('a standalone deployment registers the open cloudflare provider from its binding', async () => {
  resetModelsForTests();
  const { binding } = bindingSpy();
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    assert.equal(registerCloudflareBindingProvider(binding, { AI: binding }), true);
    assert.equal(hasProvider('cloudflare'), true);
    assert.ok(registeredPiProvider('cloudflare')!.getModels().length > 0, 'the open provider lists its models');
  });
});
