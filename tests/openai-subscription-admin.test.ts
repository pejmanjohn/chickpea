import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  invalidateProviderKeyCache,
  PROVIDER_KEY_SETTING_KEYS,
  resolveProviderApiKey,
} from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { beginOnboardingJourney } from '../src/config/onboarding-state.ts';
import type {
  OpenAiSubscriptionAuthorizationProtocol,
} from '../src/openai-subscription/device-auth.ts';
import { commitOpenAiSubscriptionCredentials } from '../src/openai-subscription/credentials.ts';
import { OpenAiSubscriptionError } from '../src/openai-subscription/errors.ts';
import { OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID } from '../src/model-catalog/image-profiles.ts';
import { OPENAI_API_IMAGE_DEFAULT_MODEL_ID } from '../src/config/initial-image-default.ts';
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

async function installTestWorkspace(config: SqliteConfigStore): Promise<void> {
  await config.ensureWorkspaceInstallation({
    workspaceId: 'T_TEST',
    teamId: 'T_TEST',
    appId: 'A_TEST',
    botUserId: 'U_TEST_BOT',
    gatewayBindingId: 'test-gateway-binding',
    transportMode: 'gateway',
    runtimeContract: 'chickpea-v1',
  });
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
  await installTestWorkspace(config);
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
    subscriptionAvailable: true,
  });
  const providerSummary = await app.request('/admin/api/providers', { headers: auth() });
  const summaryJson = JSON.stringify(await providerSummary.json());
  assert.match(summaryJson, /"activeAuthMethod":"api_key"/);
  assert.match(summaryJson, /"subscriptionAvailable":true/);
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
  const initialImageRole = await config.getWorkspaceModelRole('T_TEST', 'image');
  assert.equal(initialImageRole?.modelId, OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID);
  assert.equal(initialImageRole?.revision, 1);
  assert.equal(initialImageRole?.lastChangedByMembershipId, 'membership_test_owner');
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

  const subscriptionConnected = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await subscriptionConnected.json()), /"activeAuthMethod":"api_key"/);

  const selectSubscription = await app.request('/admin/api/providers/openai/auth-method', {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'subscription' }),
  });
  assert.equal(selectSubscription.status, 200);
  assert.deepEqual(await selectSubscription.json(), { activeAuthMethod: 'subscription' });

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
  assert.equal(
    (await config.getWorkspaceModelRole('T_TEST', 'image'))?.modelId,
    OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
  );
  const apiSelected = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await apiSelected.json()), /"activeAuthMethod":"subscription"/);

  const apiDisconnected = await app.request('/admin/api/providers/openai/key', {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(apiDisconnected.status, 200);
  const subscriptionReselected = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await subscriptionReselected.json()), /"activeAuthMethod":"subscription"/);

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
  assert.match(JSON.stringify(await apiReselected.json()), /"activeAuthMethod":"subscription"/);
});

test('a first OpenAI API key initializes an unset image role without changing chat auth', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); invalidateProviderKeyCache(); });
  await installTestWorkspace(config);
  await settings.setSetting('provider.openai.authMethod', 'subscription');
  invalidateProviderKeyCache();
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
  }));

  const fake = new FakeProvidersBackend();
  const response = await withEnv(
    { OPENAI_API_KEY: undefined, OPENAI_API_URL: 'https://openai.fake/v1' },
    () => withFetch(fake.asFetch(), () => app.request('/admin/api/providers/openai/key', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openai }),
    })),
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    (await config.getWorkspaceModelRole('T_TEST', 'image'))?.modelId,
    OPENAI_API_IMAGE_DEFAULT_MODEL_ID,
  );
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'subscription');
});

test('an explicitly cleared image role remains unset when an OpenAI API key is first added', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); invalidateProviderKeyCache(); });
  await installTestWorkspace(config);
  await config.putWorkspaceModelRole({ workspaceId: 'T_TEST', role: 'image' }, 0);
  invalidateProviderKeyCache();
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
  }));

  const fake = new FakeProvidersBackend();
  const response = await withEnv(
    { OPENAI_API_KEY: undefined, OPENAI_API_URL: 'https://openai.fake/v1' },
    () => withFetch(fake.asFetch(), () => app.request('/admin/api/providers/openai/key', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openai }),
    })),
  );

  assert.equal(response.status, 200, await response.clone().text());
  const clearedRole = await config.getWorkspaceModelRole('T_TEST', 'image');
  assert.equal(clearedRole?.modelId, undefined);
  assert.equal(clearedRole?.revision, 1);
});

test('a concurrent image choice wins the first-key default without failing key completion', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); invalidateProviderKeyCache(); });
  await installTestWorkspace(config);
  invalidateProviderKeyCache();
  const originalPut = config.putWorkspaceModelRole.bind(config);
  let raced = false;
  const racingConfig = new Proxy(config, {
    get(target, property, receiver) {
      if (property === 'putWorkspaceModelRole') {
        return async (...args: Parameters<typeof config.putWorkspaceModelRole>) => {
          if (!raced && args[0].role === 'image' && args[1] === 0) {
            raced = true;
            await originalPut({
              workspaceId: args[0].workspaceId,
              role: 'image',
              modelId: 'openai/gpt-image-2.5-sunburst',
              lastChangedByMembershipId: 'membership_concurrent_owner',
            }, 0);
          }
          return originalPut(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: racingConfig,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
  }));

  const fake = new FakeProvidersBackend();
  const response = await withEnv(
    { OPENAI_API_KEY: undefined, OPENAI_API_URL: 'https://openai.fake/v1' },
    () => withFetch(fake.asFetch(), () => app.request('/admin/api/providers/openai/key', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openai }),
    })),
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    (await config.getWorkspaceModelRole('T_TEST', 'image'))?.modelId,
    'openai/gpt-image-2.5-sunburst',
  );
});

test('an image-role storage failure does not fail or expose a completed API-key connection', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); invalidateProviderKeyCache(); });
  await installTestWorkspace(config);
  invalidateProviderKeyCache();
  const privateFailure = 'private sqlite failure with sk-must-never-log';
  const failingConfig = new Proxy(config, {
    get(target, property, receiver) {
      if (property === 'putWorkspaceModelRole') {
        return async () => { throw new Error(privateFailure); };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: failingConfig,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
  }));

  const fake = new FakeProvidersBackend();
  const response = await withEnv(
    { OPENAI_API_KEY: undefined, OPENAI_API_URL: 'https://openai.fake/v1' },
    () => withFetch(fake.asFetch(), () => app.request('/admin/api/providers/openai/key', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openai }),
    })),
  );

  assert.equal(response.status, 200, await response.clone().text());
  const credential = await resolveProviderApiKey('openai', undefined, settings);
  assert.equal(credential.source, 'stored');
  assert.equal(credential.apiKey, FAKE_PROVIDER_KEYS.openai);
  assert.equal(await config.getWorkspaceModelRole('T_TEST', 'image'), undefined);
  assert.deepEqual(errors, [[
    '[chickpea] optional image default initialization failed',
  ]]);
  assert.doesNotMatch(JSON.stringify(errors), /private sqlite|sk-must-never-log/);
});

test('subscription reauthorization does not initialize an image role', async (t) => {
  let currentTime = 1_800_000_100_000;
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  await installTestWorkspace(config);
  await commitOpenAiSubscriptionCredentials({
    accessToken: 'existing-access',
    refreshToken: 'existing-refresh',
    idToken: undefined,
    expiresAt: currentTime + 3_600_000,
    accountId: 'existing-account',
  }, {
    settings,
    now: () => currentTime,
    randomBytes: (length) => new Uint8Array(length).fill(4),
  });
  const protocol: OpenAiSubscriptionAuthorizationProtocol = {
    start: async () => ({
      deviceAuthId: 'reauth-device',
      userCode: 'REAUTH-CODE',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalMs: 1,
      expiresAt: currentTime + 60_000,
    }),
    poll: async () => ({
      state: 'approved',
      authorizationCode: 'reauth-code',
      codeVerifier: 'reauth-verifier',
    }),
    exchange: async () => ({
      accessToken: 'renewed-access',
      refreshToken: 'renewed-refresh',
      idToken: undefined,
      expiresAt: currentTime + 3_600_000,
      accountId: 'existing-account',
    }),
  };
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    openAiSubscriptionProtocol: protocol,
    openAiSubscriptionNow: () => currentTime,
    openAiSubscriptionRandomBytes: (length) => new Uint8Array(length).fill(4),
  }));

  const startedResponse = await app.request('/admin/api/providers/openai/subscription/start', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: '{}',
  });
  const started = await startedResponse.json() as { attemptCapability: string };
  currentTime += 1;
  const connected = await app.request('/admin/api/providers/openai/subscription/poll', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ attemptCapability: started.attemptCapability }),
  });

  assert.equal(connected.status, 200, await connected.clone().text());
  assert.equal((await connected.json() as { state: string }).state, 'connected');
  assert.equal(await config.getWorkspaceModelRole('T_TEST', 'image'), undefined);
});

test('a stored Subscription selection remains explicit across summaries, models, and API-key changes', async (t) => {
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
  assert.equal(upgradedOpenAi?.activeAuthMethod, 'subscription');
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'subscription');

  const modelPicker = await app.request('/admin/api/models', { headers: auth() });
  assert.equal(modelPicker.status, 200);
  const openAiProvider = ((await modelPicker.json()) as {
    providers: Array<{
      id: string;
      configured: boolean;
      source: string;
      suggestions?: string[];
      authMethods?: { activeMethod?: string; subscriptionAvailable?: boolean };
    }>;
  }).providers.find((provider) => provider.id === 'openai');
  assert.equal(openAiProvider?.configured, true);
  assert.equal(openAiProvider?.source, 'ChatGPT subscription');
  assert.equal(openAiProvider?.authMethods?.activeMethod, 'subscription');
  assert.equal(openAiProvider?.authMethods?.subscriptionAvailable, true);
  assert.ok(openAiProvider?.suggestions?.includes('openai/gpt-5.6-sol'));

  const providerModels = await app.request('/admin/api/providers/openai/models', { headers: auth() });
  assert.equal(providerModels.status, 200);
  const providerModelsJson = await providerModels.json() as {
    provider: string;
    models: Array<{ id: string }>;
  };
  assert.equal(providerModelsJson.provider, 'openai');
  assert.ok(providerModelsJson.models.some((model) => model.id === 'gpt-5.6-sol'));

  const selectedSubscription = await app.request('/admin/api/providers/openai/auth-method', {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'subscription' }),
  });
  assert.equal(selectedSubscription.status, 200);
  assert.deepEqual(await selectedSubscription.json(), {
    activeAuthMethod: 'subscription',
  });
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'subscription');

  const apiDisconnected = await app.request('/admin/api/providers/openai/key', {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(apiDisconnected.status, 200);
  const afterDelete = await app.request('/admin/api/providers', { headers: auth() });
  assert.match(JSON.stringify(await afterDelete.json()), /"activeAuthMethod":"subscription"/);
});

test('subscription-only readiness supports workspace defaults and onboarding model selection', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  await settings.setSetting(MODEL_CATALOG_SETTING_KEYS.mode, 'bundled');
  await settings.setSetting('provider.openai.authMethod', 'subscription');
  await commitOpenAiSubscriptionCredentials({
    accessToken: 'subscription-only-access',
    refreshToken: 'subscription-only-refresh',
    idToken: undefined,
    expiresAt: Date.now() + 3_600_000,
    accountId: 'subscription-only-account',
  }, { settings, randomBytes: (length) => new Uint8Array(length).fill(7) });
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: 'TSUBSCRIPTION',
    teamId: 'TSUBSCRIPTION',
    appId: 'ASUBSCRIPTION',
    botUserId: 'USUBSCRIPTIONBOT',
    gatewayBindingId: 'subscription-gateway-binding',
    transportMode: 'gateway',
    runtimeContract: 'chickpea-v1',
  });
  await config.putWorkspaceModelDefault({
    workspaceId: installation.workspaceId,
    modelId: 'openai/gpt-5.6-sol',
    provenance: 'admin_selected',
    lastChangedByMembershipId: 'membership_test_owner',
  }, 1);
  const onboarding = await beginOnboardingJourney(settings, Date.now());
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    knownProviders: new Set(),
  }));

  const workspaceDefault = await app.request('/admin/api/workspace-model-default', { headers: auth() });
  assert.equal(workspaceDefault.status, 200);
  assert.deepEqual((await workspaceDefault.json() as {
    workspaceDefault: { health: unknown };
  }).workspaceDefault.health, { status: 'ready', providerId: 'openai' });

  const selected = await app.request('/admin/api/onboarding/provider', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: onboarding.revision,
      providerId: 'openai',
    }),
  });
  assert.equal(selected.status, 200);
  const selectedJson = await selected.json() as {
    stage: string;
    providerId: string;
    models: string[];
  };
  assert.equal(selectedJson.stage, 'choose_model');
  assert.equal(selectedJson.providerId, 'openai');
  assert.ok(selectedJson.models.includes('openai/gpt-5.6-sol'));
});

test('Cloudflare rejects subscription authorization and selection before protocol work but permits cleanup', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  await settings.setSetting('provider.openai.authMethod', 'subscription');
  let protocolCalls = 0;
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    openAiSubscriptionProtocol: {
      start: async () => {
        protocolCalls += 1;
        throw new Error('must not start');
      },
      poll: async () => {
        protocolCalls += 1;
        throw new Error('must not poll');
      },
      exchange: async () => {
        protocolCalls += 1;
        throw new Error('must not exchange');
      },
    },
  }));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Cloudflare-Workers' },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  const summary = await app.request('/admin/api/providers', { headers: auth() });
  const openAi = ((await summary.json()) as {
    providers: Array<{ id: string; activeAuthMethod?: string; subscriptionAvailable?: boolean }>;
  }).providers.find((provider) => provider.id === 'openai');
  assert.deepEqual(openAi && {
    activeAuthMethod: openAi.activeAuthMethod,
    subscriptionAvailable: openAi.subscriptionAvailable,
  }, { activeAuthMethod: 'subscription', subscriptionAvailable: false });

  for (const [path, body] of [
    ['/admin/api/providers/openai/subscription/start', {}],
    ['/admin/api/providers/openai/subscription/poll', { attemptCapability: 'a'.repeat(43) }],
    ['/admin/api/providers/openai/subscription/confirm-account', { attemptCapability: 'a'.repeat(43) }],
  ] as const) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 409, path);
    assert.deepEqual(await response.json(), { error: 'unsupported_runtime' }, path);
  }
  const selection = await app.request('/admin/api/providers/openai/auth-method', {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'subscription' }),
  });
  assert.equal(selection.status, 409);
  assert.equal((await selection.json() as { error: string }).error, 'unsupported_runtime');
  const models = await app.request('/admin/api/providers/openai/models', { headers: auth() });
  assert.equal(models.status, 409);
  assert.deepEqual(await models.json(), { error: 'unsupported_runtime', provider: 'openai' });
  assert.equal(protocolCalls, 0);
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'subscription');

  const cancel = await app.request('/admin/api/providers/openai/subscription/cancel', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ attemptCapability: 'a'.repeat(43) }),
  });
  assert.equal(cancel.status, 409);
  assert.deepEqual(await cancel.json(), { error: 'authorization_missing' });
  const disconnected = await app.request('/admin/api/providers/openai/subscription', {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(disconnected.status, 200);
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'subscription');
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
    ['unsupported_runtime', 409],
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
