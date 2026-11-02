import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { withEnv } from './helpers/env.ts';

/** A Workers AI binding as the Cloudflare entry sees it; never called here. */
const binding = {
  run: async () => { throw new Error('the binding is not called at registration'); },
  models: async () => [],
} as unknown as Parameters<typeof registerCloudflareBindingProvider>[0];

test('a deployment serving many installations registers no Workers AI model provider from its binding', async () => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    assert.equal(registerCloudflareBindingProvider(binding, { CHICKPEA_TENANCY: 'installation', AI: binding }), false,
      'the env says installation tenancy: nothing registered');
  });
  await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
    assert.equal(registerCloudflareBindingProvider(binding, { AI: binding }), false,
      'the process says installation tenancy: nothing registered');
  });
});

test('a standalone deployment registers the Workers AI model provider from its binding', async () => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    assert.equal(registerCloudflareBindingProvider(binding, { AI: binding }), true);
    assert.ok(registeredPiProvider('cloudflare'), 'the keyless cloudflare/* provider is registered');
  });
});
