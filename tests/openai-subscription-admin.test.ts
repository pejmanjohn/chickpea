import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  invalidateProviderKeyCache,
  PROVIDER_KEY_SETTING_KEYS,
} from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type {
  OpenAiSubscriptionAuthorizationProtocol,
} from '../src/openai-subscription/device-auth.ts';
import { commitOpenAiSubscriptionCredentials } from '../src/openai-subscription/credentials.ts';
import { OpenAiSubscriptionError } from '../src/openai-subscription/errors.ts';
import { MODEL_CATALOG_SETTING_KEYS } from '../src/model-catalog/store.ts';
import { FAKE_PROVIDER_KEYS, FakeProvidersBackend } from './helpers/fake-providers.ts';
import { withEnv } from './helpers/env.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const ADMIN_TOKEN = 'provider-admin-token';

function auth(): HeadersInit {
  return testAdminHeaders(ADMIN_TOKEN);
}

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test('OpenAI subscription admin routes keep authorization capability browser-local and return safe status', async (t) => {
  let currentTime = 1_800_000_000_000;
  let polls = 0;
  const protocol: OpenAiSubscriptionAuthorizationProtocol = {
    start: async () => ({
      deviceAuthId: 'provider-device-secret',
      userCode: 'CHICK-PEA',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalMs: 5_000,
      expiresAt: currentTime + 60_000,
    }),
    poll: async () => {
      polls += 1;
      return {
        state: 'approved',
        authorizationCode: 'provider-authorization-secret',
        codeVerifier: 'provider-verifier-secret',
      };
    },
    exchange: async () => ({
      accessToken: 'provider-access-secret',
      refreshToken: 'provider-refresh-secret',
      idToken: 'provider-identity-secret',
      expiresAt: currentTime + 3_600_000,
      accountId: 'provider-account-secret',
    }),
  };
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    openAiSubscriptionProtocol: protocol,
    openAiSubscriptionNow: () => currentTime,
    openAiSubscriptionRandomBytes: (length) => new Uint8Array(length).fill(9),
  }));

  const startedResponse = await app.request('/admin/api/providers/openai/subscription/start', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json() as {
    state: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    nextPollAt: number;
    attemptCapability: string;
  };
  assert.equal(started.state, 'authorizing');
  assert.equal(started.userCode, 'CHICK-PEA');
  assert.ok(started.attemptCapability.length >= 32);

  const observer = await app.request('/admin/api/providers/openai/subscription', { headers: auth() });
  assert.deepEqual(await observer.json(), {
    status: { state: 'authorizing', updatedAt: currentTime },
  });
  const providerSummary = await app.request('/admin/api/providers', { headers: auth() });
  const summaryJson = JSON.stringify(await providerSummary.json());
  assert.match(summaryJson, /"activeAuthMethod":"api_key"/);
  assert.match(summaryJson, /"subscription":\{"state":"authorizing"/);
  assert.doesNotMatch(summaryJson, /CHICK-PEA|attemptCapability|provider-device-secret/);

  const earlyPoll = await app.request('/admin/api/providers/openai/subscription/poll', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ attemptCapability: started.attemptCapability }),
  });
  assert.equal(earlyPoll.status, 200);
  assert.equal(polls, 0);

  currentTime += 5_000;
  const connectedResponse = await app.request('/admin/api/providers/openai/subscription/poll', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ attemptCapability: started.attemptCapability }),
  });
  assert.equal(connectedResponse.status, 200);
  const connectedText = await connectedResponse.text();
  assert.match(connectedText, /"state":"connected"/);
  for (const secret of [
    'provider-access-secret',
    'provider-refresh-secret',
    'provider-identity-secret',
    'provider-account-secret',
    'provider-authorization-secret',
    'provider-verifier-secret',
  ]) {
    assert.doesNotMatch(connectedText, new RegExp(secret));
  }

  const subscriptionSelected = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await subscriptionSelected.json()), /"activeAuthMethod":"api_key"/);

  const fake = new FakeProvidersBackend();
  await withEnv(
    { OPENAI_API_KEY: undefined, OPENAI_API_URL: 'https://openai.fake/v1' },
    () => withFetch(fake.asFetch(), async () => {
      const apiConnected = await app.request('/admin/api/providers/openai/key', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openai }),
      });
      assert.equal(apiConnected.status, 200);
    }),
  );
  const apiSelected = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await apiSelected.json()), /"activeAuthMethod":"api_key"/);

  const apiDisconnected = await app.request('/admin/api/providers/openai/key', {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(apiDisconnected.status, 200);
  const subscriptionReselected = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await subscriptionReselected.json()), /"activeAuthMethod":"api_key"/);

  await withEnv(
    { OPENAI_API_KEY: undefined, OPENAI_API_URL: 'https://openai.fake/v1' },
    () => withFetch(fake.asFetch(), async () => {
      const apiReconnected = await app.request('/admin/api/providers/openai/key', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openai }),
      });
      assert.equal(apiReconnected.status, 200);
    }),
  );

  const disconnected = await app.request('/admin/api/providers/openai/subscription', {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), {
    status: { state: 'disconnected', updatedAt: currentTime },
  });
  const apiReselected = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await apiReselected.json()), /"activeAuthMethod":"api_key"/);
});

test('an upgraded Subscription selection is normalized and cannot reactivate the hidden lane', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  await settings.setSetting(MODEL_CATALOG_SETTING_KEYS.mode, 'bundled');
  await settings.setSetting('provider.openai.authMethod', 'subscription');
  await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openai, 'stored-openai-key');
  invalidateProviderKeyCache();
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    knownProviders: new Set(['openai', 'anthropic']),
  }));

  await commitOpenAiSubscriptionCredentials({
    accessToken: 'installation-subscription-access',
    refreshToken: 'installation-subscription-refresh',
    idToken: undefined,
    expiresAt: Date.now() + 3_600_000,
    accountId: 'installation-account',
  }, { settings, randomBytes: (length) => new Uint8Array(length).fill(6) });

  const upgradedProviders = await app.request('/admin/api/providers', { headers: auth() });
  assert.equal(upgradedProviders.status, 200);
  const upgradedOpenAi = ((await upgradedProviders.json()) as {
    providers: Array<{ id: string; activeAuthMethod?: string }>;
  }).providers.find((provider) => provider.id === 'openai');
  assert.equal(upgradedOpenAi?.activeAuthMethod, 'api_key');
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'api_key');

  const modelPicker = await app.request('/admin/api/models', { headers: auth() });
  assert.equal(modelPicker.status, 200);
  const openAiProvider = ((await modelPicker.json()) as {
    providers: Array<{
      id: string;
      configured: boolean;
      source: string;
      authMethods?: { activeMethod?: string };
    }>;
  }).providers.find((provider) => provider.id === 'openai');
  assert.equal(openAiProvider?.configured, true);
  assert.notEqual(openAiProvider?.source, 'ChatGPT subscription');
  assert.equal(openAiProvider?.authMethods?.activeMethod, 'api_key');

  const selectedSubscription = await app.request('/admin/api/providers/openai/auth-method', {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'subscription' }),
  });
  assert.equal(selectedSubscription.status, 410);
  assert.deepEqual(await selectedSubscription.json(), {
    error: 'openai_auth_method_unsupported',
    message: 'OpenAI now uses Platform API keys only.',
  });
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'api_key');

  const apiDisconnected = await app.request('/admin/api/providers/openai/key', {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(apiDisconnected.status, 200);
  const afterDelete = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await afterDelete.json()), /"activeAuthMethod":"api_key"/);
});

test('OpenAI subscription admin routes map safe failure codes to stable HTTP statuses', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  let startError: unknown = new Error('unexpected provider detail');
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    openAiSubscriptionProtocol: {
      start: async () => { throw startError; },
      poll: async () => ({ state: 'pending' }),
      exchange: async () => { throw new Error('must not exchange'); },
    },
  }));

  const cases = [
    ['attempt_forbidden', 403],
    ['authorization_expired', 410],
    ['authorization_rate_limited', 429],
    ['authorization_missing', 409],
    ['authorization_pending', 409],
    ['account_change_confirmation_required', 409],
    ['auth_reconnect_required', 409],
    ['unsupported_model', 422],
  ] as const;
  for (const [code, status] of cases) {
    startError = new OpenAiSubscriptionError(code);
    const response = await app.request('/admin/api/providers/openai/subscription/start', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code }, code);
  }

  startError = new Error('raw provider secret');
  const unexpected = await app.request('/admin/api/providers/openai/subscription/start', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unexpected.status, 502);
  assert.deepEqual(await unexpected.json(), { error: 'provider_unavailable' });
});
