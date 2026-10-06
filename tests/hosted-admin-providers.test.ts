import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { invalidateProviderKeyCache, PROVIDER_KEY_SETTING_KEYS } from '../src/config/provider-keys.ts';
import { invalidateProviderModelCache } from '../src/config/provider-models.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { FAKE_PROVIDER_KEYS, FakeProvidersBackend } from './helpers/fake-providers.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { withEnv } from './helpers/env.ts';

const ADMIN_TOKEN = 'hosted-provider-admin-token';
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;

function hostedAdmin() {
  invalidateProviderModelCache();
  invalidateProviderKeyCache();
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  app.route('/', createAdminRoutes({ store: config, settings, usage, ...testAdminAuthority(ADMIN_TOKEN) }));
  const env = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_hosted_admin' });
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { ...testAdminHeaders(ADMIN_TOKEN), 'content-type': 'application/json', ...init.headers },
  }, env);
  return {
    settings,
    request,
    close: () => { config.close(); settings.close(); usage.close(); invalidateProviderModelCache(); invalidateProviderKeyCache(); },
  };
}

async function withHostedProviders(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-hosted-admin-'));
  const fake = new FakeProvidersBackend();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fake.asFetch();
  try {
    await withEnv({
      CHICKPEA_TENANCY: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      ANTHROPIC_API_URL: 'https://anthropic.fake',
      CHICKPEA_CREDENTIAL_KEYRING_PATH: join(dir, 'deployment-keyring.json'),
    }, run);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hosted Admin saves, lists and deletes only this installation\'s own encrypted keys', async () => {
  await withHostedProviders(async () => {
    const { settings, request, close } = hostedAdmin();
    try {
      const saved = await request('/admin/api/providers/anthropic/key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.anthropic }),
      });
      assert.equal(saved.status, 200);
      assert.deepEqual((await saved.json() as { provider: unknown }).provider, { id: 'anthropic', status: 'stored', modelCount: 7 });
      assert.equal(await settings.getSetting(PROVIDER_KEY_SETTING_KEYS.anthropic), undefined, 'never saved in the clear');
      assert.equal((await settings.getEncryptedCredentialRevision('model_provider.anthropic'))?.revision, 'v1');

      // The live model list reads the saved key for this installation.
      invalidateProviderModelCache();
      const models = await request('/admin/api/providers/anthropic/models?refresh=1');
      assert.equal(models.status, 200);
      assert.ok(((await models.json()) as { models: unknown[] }).models.length > 0);

      const listing = await request('/admin/api/providers');
      assert.deepEqual(await listing.json(), {
        providers: [
          { id: 'anthropic', status: 'stored', modelCount: 7 },
          { id: 'openai', status: 'missing', modelCount: null, activeAuthMethod: 'api_key', subscriptionAvailable: false },
          { id: 'openrouter', status: 'missing', modelCount: null },
        ],
      });

      const removed = await request('/admin/api/providers/anthropic/key', { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.equal(((await removed.json()) as { provider: { status: string } }).provider.status, 'missing');
      assert.equal(await settings.getEncryptedCredentialRevision('model_provider.anthropic'), undefined);
      assert.deepEqual(await settings.getSettings(['provider.anthropic.credentialVersion', 'provider.anthropic.credentialActive']),
        ['2', 'false']);
    } finally {
      close();
    }
  });
});

test('hosted Admin reports a saved key it cannot open as missing in the model list', async () => {
  await withHostedProviders(async () => {
    const { request, close } = hostedAdmin();
    try {
      const saved = await request('/admin/api/providers/anthropic/key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.anthropic }),
      });
      assert.equal(saved.status, 200);
      // Other material under the same key ID: the envelope no longer opens.
      const path = process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!;
      const { currentKeyId } = JSON.parse(readFileSync(path, 'utf8')) as { currentKeyId: string };
      writeFileSync(path, `${JSON.stringify({ version: 1, ...generateCredentialKeyring(currentKeyId) })}\n`, { mode: 0o600 });

      invalidateProviderModelCache();
      const models = await request('/admin/api/providers/anthropic/models?refresh=1');
      assert.equal(models.status, 409);
      assert.equal(((await models.json()) as { error: string }).error, 'provider_key_missing');
    } finally {
      close();
    }
  });
});

test('hosted Admin says saved keys are temporarily unavailable while the keyring will not load, never missing', async (t) => {
  await withHostedProviders(async () => {
    const { request, close } = hostedAdmin();
    t.mock.method(console, 'warn', () => {});
    try {
      const saved = await request('/admin/api/providers/anthropic/key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.anthropic }),
      });
      assert.equal(saved.status, 200);
      writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, 'not a keyring', { mode: 0o600 });

      const providers = await request('/admin/api/providers');
      assert.equal(providers.status, 503);
      assert.deepEqual(await providers.json(), {
        error: 'model_credentials_unavailable',
        message: 'Model provider keys are temporarily unavailable. Try again shortly.',
      });
      invalidateProviderModelCache();
      const models = await request('/admin/api/providers/anthropic/models?refresh=1');
      assert.equal(models.status, 503);
      assert.equal(((await models.json()) as { error: string }).error, 'model_credentials_unavailable');
    } finally {
      close();
    }
  });
});

test('hosted Admin offers no Workers AI, ChatGPT plan or OpenAI subscription lane', async () => {
  await withHostedProviders(async () => {
    const { request, close } = hostedAdmin();
    try {
      for (const [method, path, body] of [
        ['PUT', '/admin/api/providers/workers-ai/enabled', { enabled: true }],
        ['GET', '/admin/api/providers/workers-ai/models'],
        ['GET', '/admin/api/providers/workers-ai/favorites'],
        ['GET', '/admin/api/providers/openai/subscription'],
        ['DELETE', '/admin/api/providers/openai/subscription'],
        ['POST', '/admin/api/providers/openai/subscription/start', {}],
        ['POST', '/admin/api/providers/openai/chatgpt-plan/prepare', {}],
        ['PUT', '/admin/api/providers/openai/auth-method', { method: 'subscription' }],
      ] as const) {
        const response = await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.deepEqual(await response.json(), { error: 'unknown_provider' }, `${method} ${path}`);
      }

      const models = (await (await request('/admin/api/models')).json()) as {
        providers: Array<{ id: string; authMethods?: { subscriptionAvailable: boolean; subscription?: unknown } }>;
      };
      assert.deepEqual(models.providers.map((provider) => provider.id).sort(), ['anthropic', 'openai', 'openrouter']);
      const openai = models.providers.find((provider) => provider.id === 'openai');
      assert.equal(openai?.authMethods?.subscriptionAvailable, false);
      assert.equal(openai?.authMethods?.subscription, undefined);

      const installation = (await (await request('/admin/api/installation')).json()) as { providers: Record<string, string> };
      assert.equal(installation.providers['workers-ai'], 'missing');
    } finally {
      close();
    }
  });
});
