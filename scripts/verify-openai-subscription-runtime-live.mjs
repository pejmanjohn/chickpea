#!/usr/bin/env node
/**
 * Explicit live product-path check for a previously authorized Node settings
 * database. It consumes a minimal amount of ChatGPT subscription quota, never
 * prints credentials or model output, and installs an invalid Platform key so
 * any accidental billing-lane fallback fails rather than charging the API.
 */

import assert from 'node:assert/strict';

import { resolveModel } from '@flue/runtime/internal';
import { getApiProvider } from '@earendil-works/pi-ai/compat';

import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { saveOpenAiAuthMethod } from '../src/config/openai-auth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(value, next);
    index += 1;
  } else {
    args.set(value, true);
  }
}

if (args.has('--help')) {
  console.log('Usage: npm run verify:openai-subscription-runtime:live -- --live --state-db <path>');
  console.log('Requires an authorized Node settings database and consumes ChatGPT subscription quota.');
  process.exit(0);
}

assert.equal(args.has('--live'), true, 'refusing model traffic without the explicit --live flag');
const statePath = String(args.get('--state-db') ?? '');
assert.ok(statePath, '--state-db is required');
assert.equal(
  process.env.TAG_OPENAI_SUBSCRIPTION_ENABLED,
  '1',
  'TAG_OPENAI_SUBSCRIPTION_ENABLED must be exactly 1',
);

process.env.OPENAI_API_KEY = 'sk-chickpea-intentionally-invalid-no-fallback';
const nativeFetch = globalThis.fetch;
const destinations = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  destinations.push(new URL(url).hostname);
  return nativeFetch(input, init);
};

const profile = {
  id: 'live_subscription_runtime',
  name: 'Live Subscription Runtime',
  instructions: 'Return only the requested compatibility marker.',
  enabled: true,
  model: 'openai/gpt-5.3-codex-spark',
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};
const settings = new SqliteSettingsStore(statePath);

try {
  await saveOpenAiAuthMethod(settings, 'subscription');
  const route = await resolveRuntimeModel(profile.id, profile.model, {
    settings,
  });
  assert.deepEqual(route, {
    model: 'openai-subscription/gpt-5.3-codex-spark',
    providerAuthRoute: 'openai_subscription',
  });

  const model = resolveModel(route.model);
  const api = getApiProvider(model.api);
  assert.ok(api, 'subscription API provider must be registered');
  const result = await api.stream(
    model,
    {
      messages: [{
        role: 'user',
        content: 'Return exactly CHICKPEA_RUNTIME_SUBSCRIPTION_OK and nothing else.',
        timestamp: Date.now(),
      }],
    },
    { apiKey: process.env.OPENAI_API_KEY, maxTokens: 64 },
  ).result();

  const text = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  assert.equal(result.provider, 'openai-subscription');
  assert.match(text, /CHICKPEA_RUNTIME_SUBSCRIPTION_OK/);
  assert.ok(destinations.includes('chatgpt.com'));
  assert.equal(destinations.includes('api.openai.com'), false);
  assert.equal(
    destinations.every((host) => host === 'chatgpt.com' || host === 'auth.openai.com'),
    true,
    'subscription runtime contacted an unexpected host',
  );
  console.log(JSON.stringify({
    ok: true,
    providerAuthRoute: route.providerAuthRoute,
    provider: result.provider,
    destination: 'chatgpt.com',
    apiFallbackObserved: false,
  }));
} finally {
  settings.close();
}
