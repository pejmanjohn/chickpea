import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
  type InstallationAdmission,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  ModelAccessError,
  configureModelAccessResolver,
  configureModelRequestRecorder,
  resetModelAccessForTests,
  sendImageRequest,
  withModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type PlatformFundedModel,
  type PlatformFundingAdmission,
} from '../src/config/platform-funding.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { ImageCallResult, ImageCallUsage } from '../src/images/openai-images-client.ts';
import { imageModelProfileReady, resolveImageProvider } from '../src/images/provider.ts';
import { imageRequestRecord } from '../src/images/request-record.ts';
import { findImageModel, type ImageModelProfile } from '../src/model-catalog/image-profiles.ts';
import type { ModelRequestRecord } from '../src/usage/model-requests.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const BASE_URL = 'https://images.openai.invalid/v1';
const FLARE = findImageModel('openai/gpt-image-2.5-flare') as ImageModelProfile;
const PIXEL_BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  LOCAL_STUB_URL: undefined,
};
/** 40 text and 10 image input tokens, 1,000 image output tokens. */
const USAGE = {
  input_tokens: 50,
  output_tokens: 1_000,
  total_tokens: 1_050,
  input_tokens_details: { text_tokens: 40, image_tokens: 10 },
};
/** $5, $8 and $30 per million text input, image input and image output tokens. */
const USAGE_PRICE_MICROS = 40 * 5 + 10 * 8 + 1_000 * 30;
const FLARE_PRICE_VERSION = 'openai-image-gpt-image-2.5-flare_2026-10-07';
/** After the 2026-10-07 image prices go stale. */
const PAST_FLARE_PRICE = Date.UTC(2027, 6, 1);

interface Sent {
  url: string;
  init: RequestInit;
}

function provider(respond: () => Response = () => imagesResponse()) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    sent.push({ url: String(input), init });
    return respond();
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function imagesResponse(status = 200, body: unknown = { data: [{ b64_json: PIXEL_BASE64 }], usage: USAGE }): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const generation = { prompt: 'a lighthouse at dusk', format: { format: 'png' as const }, deadlineMs: 5_000 };

/** Model access as a host composes it: every grant resolves to `apiKey`, every record lands in a real store. */
function proxy(t: TestContext, apiKey: string) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  resetInstallationAdmissionForTests();
  invalidateProviderKeyCache();
  const settings = new SqliteSettingsStore(':memory:');
  const store = new SqliteUsageStore(':memory:');
  const recorded: ModelRequestRecord[] = [];
  configureModelAccessResolver({ resolve: async () => ({ apiKey }) });
  configureModelRequestRecorder(async (record) => {
    recorded.push(record);
    return store.recordModelRequest(record);
  });
  t.after(() => {
    settings.close();
    store.close();
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
    invalidateProviderKeyCache();
  });
  return { settings, store, recorded };
}

/** A hosted installation on credits; the port remembers what it was asked. */
function creditsInstallation(
  t: TestContext,
  admit: (model: PlatformFundedModel) => PlatformFundingAdmission = () => 'admitted',
  admission: InstallationAdmission = 'admitted',
) {
  useDeploymentKeyring(t);
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_credits' }) as PlatformEnv;
  const port = { admit: [] as PlatformFundedModel[], charge: [] as ModelRequestRecord[] };
  configureInstallationAdmission(async () => admission);
  configurePlatformFunding({
    funding: async () => 'platform',
    admit: async (_grant, model) => {
      port.admit.push(model);
      return admit(model);
    },
    charge: async (record) => {
      port.charge.push(record);
    },
    priceMultiplier: async () => 1.5,
  });
  return { env, port };
}

async function imageClient(env: PlatformEnv | undefined, settings: SqliteSettingsStore, fetchImpl: typeof fetch) {
  const resolved = await resolveImageProvider(FLARE.id, env, settings, { baseUrl: BASE_URL, fetchImpl });
  assert.ok(resolved.ok, 'the image model resolves to a client');
  return resolved.client;
}

test('a customer-funded image generation returns its images as before and writes one priced record', async (t) => {
  const { settings, store, recorded } = proxy(t, 'sk-customer-images');
  await withEnv({ ...NO_DEPLOYMENT_KEYS, OPENAI_API_KEY: 'sk-customer-images' }, async () => {
    const { sent, fetchImpl } = provider();
    const result = await (await imageClient(undefined, settings, fetchImpl)).generate(generation);

    assert.ok(result.ok);
    assert.equal(result.images.length, 1);
    assert.deepEqual(result.usage, USAGE, 'the Agent still sees the provider usage');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, `${BASE_URL}/images/generations`);
    assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, 'Bearer sk-customer-images');
    assert.equal(recorded.length, 1);
    assert.deepEqual(await store.getModelRequest(recorded[0]!.requestId), {
      requestId: recorded[0]!.requestId,
      installationId: 'chickpea',
      runId: 'image-generation',
      attemptId: recorded[0]!.attemptId,
      agentId: null,
      provider: 'openai',
      model: 'gpt-image-2.5-flare',
      fundingSource: 'customer',
      outcome: 'completed',
      inputTokens: 50,
      outputTokens: { total: 1_000, reasoning: null },
      cacheReadTokens: 0,
      cacheWriteTokens: { total: 0, oneHour: null },
      priceVersionId: FLARE_PRICE_VERSION,
      listPriceUsdMicros: USAGE_PRICE_MICROS,
      priceUnknownReason: null,
      finishedAt: NOW,
    });
  });
});

test('an image request goes to the endpoint its access names over the catalog endpoint', async (t) => {
  proxy(t, 'sk-gateway-images');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-gateway-images', baseUrl: 'https://gateway.invalid/v1/' }) });
  const { sent, fetchImpl } = provider();
  const grant: ModelAccessGrant = {
    installationId: 'chickpea', providerId: 'openai', credentialRefId: 'cred_openai', credentialVersion: 1,
    runId: 'image-generation', fundingSource: 'customer',
  };
  await sendImageRequest({ grant, env: undefined, model: FLARE.model, baseUrl: BASE_URL, fetchImpl }, async (send, endpoint) => {
    assert.equal(endpoint, 'https://gateway.invalid/v1');
    await send('/images/generations', { headers: {}, body: '{}', signal: new AbortController().signal });
    return { ok: false, reason: 'unreachable', detail: 'probe' };
  });
  assert.deepEqual(sent.map(({ url }) => url), ['https://gateway.invalid/v1/images/generations']);
});

test('an admitted image call that never fetches is neither recorded nor charged', async (t) => {
  const { recorded } = proxy(t, 'sk-platform-images');
  const { env, port } = creditsInstallation(t);
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const grant: ModelAccessGrant = {
      installationId: 'inst_credits', providerId: 'openai', credentialRefId: 'platform:openai', credentialVersion: 1,
      runId: 'image-generation', fundingSource: 'platform',
    };
    const { fetchImpl } = provider();
    const result = await sendImageRequest({ grant, env, model: FLARE.model, baseUrl: 'http://insecure.invalid', fetchImpl },
      async () => ({ ok: false, reason: 'misconfigured', detail: 'invalid_base_url' }));
    assert.equal(result.ok, false);
    assert.equal(port.admit.length, 1);
    assert.deepEqual(recorded, []);
    assert.deepEqual(port.charge, []);
  });
});

test('an image request inside a run is recorded against that run', async (t) => {
  const { settings, recorded } = proxy(t, 'sk-run-images');
  await withEnv({ ...NO_DEPLOYMENT_KEYS, OPENAI_API_KEY: 'sk-run-images' }, async () => {
    const { fetchImpl } = provider();
    const run: ModelAccessGrant = {
      installationId: 'chickpea', providerId: 'anthropic', credentialRefId: 'cred_anthropic', credentialVersion: 1,
      runId: 'run_with_image', fundingSource: 'customer',
    };
    await withModelAccess(run, undefined, async () => {
      assert.ok((await (await imageClient(undefined, settings, fetchImpl)).generate(generation)).ok);
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.runId, 'run_with_image');
  });
});

test('an image request the provider refuses is recorded once at no cost; one never sent is not recorded', async (t) => {
  const { settings, recorded } = proxy(t, 'sk-refused-images');
  await withEnv({ ...NO_DEPLOYMENT_KEYS, OPENAI_API_KEY: 'sk-refused-images' }, async () => {
    const refused = provider(() => imagesResponse(400, { error: { code: 'moderation_blocked', message: 'no' } }));
    const result = await (await imageClient(undefined, settings, refused.fetchImpl)).generate(generation);
    assert.equal(result.ok, false);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.outcome, 'error');
    assert.equal(recorded[0]!.inputTokens, 0);
    assert.equal(recorded[0]!.listPriceUsdMicros, 0);

    const invalid = provider();
    const client = await imageClient(undefined, settings, invalid.fetchImpl);
    assert.deepEqual(await client.generate({ ...generation, prompt: ' ' }),
      { ok: false, reason: 'invalid-request', detail: 'empty_prompt' });
    assert.equal(invalid.sent.length, 0);
    assert.equal(recorded.length, 1, 'a request that never reached the provider writes no record');
  });
});

test('a platform-funded image generation is admitted against credits, priced, and charged once', async (t) => {
  const { settings, recorded } = proxy(t, 'sk-platform-images');
  const { env, port } = creditsInstallation(t);
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { sent, fetchImpl } = provider();
    const result = await (await imageClient(env, settings, fetchImpl)).generate(generation);

    assert.ok(result.ok);
    assert.deepEqual(port.admit, [{ provider: 'openai', model: 'gpt-image-2.5-flare' }]);
    assert.equal(sent.length, 1);
    assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, 'Bearer sk-platform-images');
    assert.equal(port.charge.length, 1, 'charged once');
    assert.deepEqual(port.charge, recorded);
    assert.equal(port.charge[0]!.installationId, 'inst_credits');
    assert.equal(port.charge[0]!.fundingSource, 'platform');
    assert.equal(port.charge[0]!.priceVersionId, FLARE_PRICE_VERSION);
    assert.equal(port.charge[0]!.listPriceUsdMicros, USAGE_PRICE_MICROS);
  });
});

test('a platform-funded image request at zero credits is refused with the credits refusal before anything is sent', async (t) => {
  const { settings, recorded } = proxy(t, 'sk-platform-images');
  const { env, port } = creditsInstallation(t, () => 'credits_exhausted');
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { sent, fetchImpl } = provider();
    const result = await (await imageClient(env, settings, fetchImpl)).generate(generation);

    assert.deepEqual(result, { ok: false, reason: 'unreachable', detail: 'credits_exhausted' });
    assert.equal(port.admit.length, 1);
    assert.equal(sent.length, 0);
    assert.deepEqual(recorded, []);
    assert.deepEqual(port.charge, []);
  });
});

test('an image request of an installation that is not admitted is refused before anything is sent', async (t) => {
  const { settings, recorded } = proxy(t, 'sk-platform-images');
  const { env, port } = creditsInstallation(t, () => 'admitted', 'refused');
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { sent, fetchImpl } = provider();
    assert.deepEqual(await (await imageClient(env, settings, fetchImpl)).generate(generation),
      { ok: false, reason: 'unreachable', detail: 'installation_not_admitted' });
    assert.equal(sent.length, 0);
    assert.deepEqual(port.admit, []);
    assert.deepEqual(recorded, []);
  });
});

test('a platform-funded image request for a model with no current price is refused before admission', async (t) => {
  proxy(t, 'sk-platform-images');
  const { env, port } = creditsInstallation(t);
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { sent, fetchImpl } = provider();
    const grant: ModelAccessGrant = {
      installationId: 'inst_credits', providerId: 'openai', credentialRefId: 'platform:openai', credentialVersion: 1,
      runId: 'image-generation', fundingSource: 'platform',
    };
    const call = async (): Promise<ImageCallResult> => ({ ok: false, reason: 'unreachable', detail: 'not_called' });
    const refusedUnpriced = (error: unknown) => error instanceof ModelAccessError && error.code === 'funding_not_offered';
    await assert.rejects(
      sendImageRequest({ grant, env, model: 'gpt-image-unpriced', baseUrl: BASE_URL, fetchImpl }, call),
      refusedUnpriced,
    );
    t.mock.timers.setTime(PAST_FLARE_PRICE);
    await assert.rejects(
      sendImageRequest({ grant, env, model: 'gpt-image-2.5-flare', baseUrl: BASE_URL, fetchImpl }, call),
      refusedUnpriced,
      'a stale price is no price',
    );
    assert.deepEqual(port.admit, []);
    assert.equal(sent.length, 0);
  });
});

test('an installation on credits is offered the priced image models without a saved key', async (t) => {
  const { settings } = proxy(t, 'sk-unused');
  const { env } = creditsInstallation(t);
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    assert.equal(await imageModelProfileReady(FLARE, env, settings), true);
    t.mock.timers.setTime(PAST_FLARE_PRICE);
    assert.equal(await imageModelProfileReady(FLARE, env, settings), false, 'a stale price is not offered');
    configurePlatformFunding(undefined);
    assert.equal(await imageModelProfileReady(FLARE, env, settings), false, 'without credits a missing key hides it');
  });
});

test('image usage the image rates cannot price records its tokens with no price', () => {
  const end = {
    requestId: 'req_image', attribution: { installationId: 'chickpea', runId: 'run', attemptId: 'attempt', agentId: null },
    provider: 'openai', model: 'gpt-image-2.5-flare', fundingSource: 'platform' as const, finishedAt: NOW,
  };
  const completed = (usage?: ImageCallUsage): ImageCallResult => ({
    ok: true, images: [new Uint8Array([1])], appliedModel: FLARE.id, appliedSize: 'auto', appliedFormat: 'png',
    ...(usage ? { usage } : {}),
  });
  const priced = imageRequestRecord({ ...end, result: completed(USAGE) });
  assert.equal(priced.listPriceUsdMicros, USAGE_PRICE_MICROS);
  for (const [why, usage] of [
    ['no usage reported', undefined],
    ['input parts that do not add up', { ...USAGE, input_tokens_details: { text_tokens: 40 } }],
    ['text output, which has no image rate', { ...USAGE, output_tokens_details: { text_tokens: 5, image_tokens: 995 } }],
    ['no output count', { input_tokens: 0 }],
  ] as const) {
    const record = imageRequestRecord({ ...end, result: completed(usage) });
    assert.equal(record.listPriceUsdMicros, null, why);
    assert.equal(record.priceVersionId, null, why);
    assert.equal(record.priceUnknownReason, 'pricing_dimension_unknown', why);
  }
  assert.equal(imageRequestRecord({ ...end, model: 'gpt-image-unpriced', result: completed(USAGE) }).priceUnknownReason,
    'price_unknown');
  assert.equal(imageRequestRecord({ ...end, finishedAt: PAST_FLARE_PRICE, result: completed(USAGE) }).priceUnknownReason,
    'price_stale');
  assert.equal(imageRequestRecord({ ...end, result: { ok: false, reason: 'timeout', detail: 'aborted' } }).outcome,
    'stopped');
});

test('an image the provider billed is charged even when Chickpea cannot use the answer; a refusal is not', async (t) => {
  const { settings, recorded } = proxy(t, 'sk-platform-images');
  const { env, port } = creditsInstallation(t);
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const undecodable = provider(() => imagesResponse(200, { data: [{ b64_json: 'not base64!' }], usage: USAGE }));
    const result = await (await imageClient(env, settings, undecodable.fetchImpl)).generate(generation);
    assert.equal(result.ok, false);
    assert.equal(port.charge.length, 1);
    assert.equal(port.charge[0]!.outcome, 'error');
    assert.equal(port.charge[0]!.inputTokens, 50);
    assert.equal(port.charge[0]!.listPriceUsdMicros, USAGE_PRICE_MICROS);

    const refused = provider(() => imagesResponse(400, { error: { code: 'moderation_blocked', message: 'no' } }));
    assert.equal((await (await imageClient(env, settings, refused.fetchImpl)).generate(generation)).ok, false);
    assert.equal(port.charge.length, 2);
    assert.equal(port.charge[1]!.listPriceUsdMicros, 0, 'a refusal with no usage costs nothing');

    const lost = provider(() => { throw new TypeError('socket closed'); });
    assert.equal((await (await imageClient(env, settings, lost.fetchImpl)).generate(generation)).ok, false);
    const oversized = provider(() => new Response('{}', { headers: { 'content-length': String(64 * 1024 * 1024) } }));
    assert.equal((await (await imageClient(env, settings, oversized.fetchImpl)).generate(generation)).ok, false);
    assert.equal(port.charge.length, 4);
    for (const unread of port.charge.slice(2)) {
      assert.equal(unread.listPriceUsdMicros, null, 'a request sent with no answer read is never priced at zero');
      assert.equal(unread.priceUnknownReason, 'pricing_dimension_unknown');
    }
    assert.deepEqual(port.charge, recorded);
  });
});
