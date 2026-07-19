import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { registerProvider } from '@flue/runtime';
import type { CloudflareAIBinding } from '@flue/runtime/cloudflare';
import {
  hasRegisteredProvider,
  resetProviderRuntime,
  resolveModel,
} from '@flue/runtime/internal';

import { registerCloudflareBindingProvider } from '../src/cloudflare-provider.ts';

beforeEach(() => resetProviderRuntime());
afterEach(() => resetProviderRuntime());

test('the Cloudflare-only helper has no registration side effect when merely imported', () => {
  assert.equal(hasRegisteredProvider('cloudflare'), false);
});

test('the Workers AI binding registration opts out of the default AI Gateway', () => {
  const binding: CloudflareAIBinding = {
    run: async () => ({ response: 'ok' }),
  };

  registerProvider('cloudflare', {
    api: 'cloudflare-ai-binding',
    binding,
  });
  const defaultRoutedModel = resolveModel('cloudflare/@cf/test/default-routed');
  assert.deepEqual(Object.getOwnPropertyDescriptor(defaultRoutedModel, 'gateway')?.value, {
    id: 'default',
  });

  registerCloudflareBindingProvider(binding);
  const model = resolveModel('cloudflare/@cf/test/private');

  assert.equal(model.provider, 'cloudflare');
  assert.equal(model.api, 'cloudflare-ai-binding');
  assert.equal(Object.getOwnPropertyDescriptor(model, 'binding')?.value, binding);
  assert.equal(Object.getOwnPropertyDescriptor(model, 'gateway')?.value, undefined);
});

test('the Cloudflare binding registration does not alter the REST Workers AI provider', () => {
  registerProvider('cloudflare-workers-ai', {
    baseUrl: 'https://workers-ai.example.invalid/v1',
    apiKey: 'test-key',
  });
  registerCloudflareBindingProvider({ run: async () => ({ response: 'ok' }) });

  const model = resolveModel('cloudflare-workers-ai/@cf/test/rest');

  assert.equal(model.provider, 'cloudflare-workers-ai');
  assert.equal(model.baseUrl, 'https://workers-ai.example.invalid/v1');
  assert.equal(Object.hasOwn(model, 'binding'), false);
  assert.equal(Object.hasOwn(model, 'gateway'), false);
});
