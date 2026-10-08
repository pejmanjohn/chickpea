import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import type { AssistantMessage, Context, StreamOptions } from '@earendil-works/pi-ai';

import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  configureModelRequestRecorder,
  resetModelAccessForTests,
  withModelAccess,
  type ModelAccessGrant,
} from '../../src/config/model-access.ts';
import { registerBuiltinPiProvider } from '../../src/config/pi-provider.ts';
import { registeredPiProvider } from '../../src/config/pi-provider-registry.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../../src/config/platform-funding.ts';
import type { PlatformEnv } from '../../src/config/state-backend.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID, registerModelCompatibilityApis } from '../../src/model-compat/provider.ts';
import type { ModelRequestRecord } from '../../src/usage/model-requests.ts';
import { priceCatalogFor } from '../../src/usage/pricing/catalog.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const API_KEY = 'sk-provider-modes-test-key';
const OFF_LIST_PRICE = '[chickpea] platform-funded model request served off list price';

function recording(name: string): string {
  return readFileSync(new URL(`../fixtures/usage/provider-modes/${name}`, import.meta.url), 'utf8');
}

const SONNET_STANDARD = recording('anthropic-sonnet-5-5-standard_only.sse');
const SONNET_GEO_US = recording('anthropic-sonnet-5-5-geo-us.sse');
const HAIKU_STANDARD = recording('anthropic-haiku-4-5-standard_only.sse');
const LUNA_DEFAULT = recording('openai-gpt-5.6-luna-default.sse');
const LUNA_FLEX = recording('openai-gpt-5.6-luna-flex.sse');

const CONTEXT: Context = {
  systemPrompt: 'probe',
  messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  tools: [{
    name: 'lookup',
    description: 'Look up a word.',
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
  }],
};

interface Route {
  readonly registeredId: string;
  readonly providerId: 'anthropic' | 'openai';
  readonly model: string;
}

const SONNET: Route = { registeredId: ANTHROPIC_COMPAT_PROVIDER_ID, providerId: 'anthropic', model: 'claude-sonnet-5-5' };
const HAIKU: Route = { registeredId: 'anthropic', providerId: 'anthropic', model: 'claude-haiku-4-5' };
const LUNA: Route = { registeredId: 'openai', providerId: 'openai', model: 'gpt-5.6-luna' };

function hostedEnv(installationId: string): PlatformEnv {
  return scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId }) as PlatformEnv;
}

function grant(
  providerId: Route['providerId'],
  fundingSource: ModelAccessGrant['fundingSource'],
  installationId = 'chickpea',
): ModelAccessGrant {
  return {
    installationId, providerId, runId: `run_${fundingSource}`, fundingSource,
    credentialRefId: fundingSource === 'platform' ? `platform:${providerId}` : `cred_${providerId}`, credentialVersion: 1,
  };
}

function onCredits(route: Route): [ModelAccessGrant, PlatformEnv] {
  return [grant(route.providerId, 'platform', 'inst_credits'), hostedEnv('inst_credits')];
}

function proxied(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  resetInstallationAdmissionForTests();
  registerModelCompatibilityApis();
  registerBuiltinPiProvider('anthropic');
  registerBuiltinPiProvider('openai');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: API_KEY }) });
  configureInstallationAdmission(async () => 'admitted');
  const recorded: ModelRequestRecord[] = [];
  configureModelRequestRecorder(async (record) => {
    recorded.push(record);
  });
  const charged: ModelRequestRecord[] = [];
  configurePlatformFunding({
    funding: async () => 'platform',
    admit: async () => 'admitted',
    charge: async (record) => {
      charged.push(record);
    },
    priceMultiplier: async () => 1.5,
  });
  const warn = t.mock.method(console, 'warn', () => undefined);
  t.after(() => {
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  return { recorded, charged, warnings: () => warn.mock.calls.map((call) => call.arguments) };
}

interface SentRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

async function send(
  route: Route,
  access: ModelAccessGrant,
  env: PlatformEnv | undefined,
  recorded: string,
  onPayload?: StreamOptions['onPayload'],
): Promise<{ result: AssistantMessage; sent: SentRequest[] }> {
  const sent: SentRequest[] = [];
  const network: typeof fetch = async (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(recorded, { headers: { 'content-type': 'text/event-stream' } });
  };
  const provider = registeredPiProvider(route.registeredId);
  const model = provider?.getModels().find((candidate) => candidate.id === route.model);
  assert.ok(provider && model, `${route.registeredId} lists ${route.model}`);
  const result = await withModelAccess(access, env, 'reply', () =>
    provider.streamSimple(model, CONTEXT, { fetch: network, ...(onPayload ? { onPayload } : {}) }).result());
  return { result, sent };
}

function listPriceUsdMicros(route: Route, input: number, output: number): number {
  const price = priceCatalogFor('standard_input_output', route.providerId, route.model, NOW);
  assert.ok(price, `${route.model} has a current list price`);
  return Math.round((input * price.rate.inputMicrosPerUnit + output * price.rate.outputMicrosPerUnit) /
    price.rate.unitScale);
}

function tools(body: Record<string, unknown>): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1, JSON.stringify(body.tools));
  return body.tools as Array<Record<string, unknown>>;
}

function assertNoModeKeys(body: Record<string, unknown>, keys: readonly string[], label = ''): void {
  for (const key of keys) assert.ok(!(key in body), `${label} sends no ${key}: ${Object.keys(body).join(', ')}`);
}

test('a platform-funded Anthropic request is pinned to standard_only with no region or speed, and charged at list price', async (t) => {
  const { recorded, charged, warnings } = proxied(t);

  const { result, sent } = await send(SONNET, ...onCredits(SONNET), SONNET_STANDARD);

  assert.equal(result.stopReason, 'stop');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0]!.body.service_tier, 'standard_only');
  assertNoModeKeys(sent[0]!.body, ['inference_geo', 'speed']);
  assert.ok(tools(sent[0]!.body).every((tool) => tool.type === undefined || tool.type === 'custom'),
    'every tool is a custom tool, none a server tool');
  assert.equal(charged.length, 1);
  assert.deepEqual(charged, recorded);
  const [record] = charged;
  assert.deepEqual(
    [record!.fundingSource, record!.inputTokens, record!.outputTokens.total, record!.listPriceUsdMicros],
    ['platform', 18, 4, listPriceUsdMicros(SONNET, 18, 4)],
  );
  assert.deepEqual([record!.providerServiceTier, record!.providerInferenceGeo], ['standard', 'global']);
  assert.deepEqual(warnings(), []);
});

test('a caller payload hook runs first and cannot move a platform-funded request off list price', async (t) => {
  proxied(t);
  const callerHook: StreamOptions['onPayload'] = async (payload) => ({
    ...(payload as Record<string, unknown>),
    service_tier: 'auto', inference_geo: 'us', speed: 'fast', metadata: { user_id: 'probe-user' },
  });

  const { sent } = await send(SONNET, ...onCredits(SONNET), SONNET_STANDARD, callerHook);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.service_tier, 'standard_only');
  assertNoModeKeys(sent[0]!.body, ['inference_geo', 'speed']);
  assert.deepEqual(sent[0]!.body.metadata, { user_id: 'probe-user' }, 'the caller\'s other fields are kept');
});

test('a platform-funded request whose caller hook returns something other than an object is never sent', async (t) => {
  proxied(t);
  for (const returned of [null, ['not', 'an', 'object'], 'payload']) {
    const { result, sent } = await send(SONNET, ...onCredits(SONNET), SONNET_STANDARD, () => returned);

    assert.equal(result.stopReason, 'error', JSON.stringify(returned));
    assert.deepEqual(sent, [], JSON.stringify(returned));
  }
});

test('a platform-funded OpenAI request is pinned to the default tier on the global endpoint', async (t) => {
  const { recorded, charged, warnings } = proxied(t);

  const { result, sent } = await send(LUNA, ...onCredits(LUNA), LUNA_DEFAULT);

  assert.equal(result.stopReason, 'stop');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent[0]!.body.service_tier, 'default');
  assert.ok(tools(sent[0]!.body).every((tool) => tool.type === 'function'), 'every tool is a function tool');
  assert.equal(charged.length, 1);
  assert.deepEqual(charged, recorded);
  const [record] = charged;
  assert.deepEqual(
    [record!.inputTokens, record!.outputTokens.total, record!.listPriceUsdMicros],
    [13, 5, listPriceUsdMicros(LUNA, 13, 5)],
  );
  assert.deepEqual([record!.providerServiceTier, record!.providerInferenceGeo], ['default', null]);
  assert.deepEqual(warnings(), []);
});

test('customer-funded Anthropic and OpenAI requests are sent and recorded as before, whatever mode served them', async (t) => {
  const { recorded, charged, warnings } = proxied(t);
  const cases = [
    ['standalone Anthropic', SONNET, grant('anthropic', 'customer'), undefined, SONNET_GEO_US],
    ['hosted OpenAI', LUNA, grant('openai', 'customer', 'inst_byok'), hostedEnv('inst_byok'), LUNA_FLEX],
  ] as const;

  for (const [label, route, access, env, fixture] of cases) {
    const { result, sent } = await send(route, access, env, fixture);

    assert.equal(result.stopReason, 'stop', label);
    assert.equal(sent.length, 1, label);
    assertNoModeKeys(sent[0]!.body, ['service_tier', 'inference_geo', 'speed'], label);
  }
  assert.deepEqual(
    recorded.map((record) => [record.fundingSource, record.providerServiceTier, record.providerInferenceGeo]),
    [['customer', null, null], ['customer', null, null]],
  );
  assert.deepEqual(charged, []);
  assert.deepEqual(warnings(), []);
});

async function assertChargedAtListPriceWithOneWarning(
  t: TestContext,
  route: Route,
  fixture: string,
  usage: { readonly input: number; readonly output: number },
  reported: { readonly serviceTier: string; readonly inferenceGeo: string | null },
): Promise<void> {
  const { recorded, charged, warnings } = proxied(t);

  await send(route, ...onCredits(route), fixture);

  assert.equal(charged.length, 1);
  assert.deepEqual(charged, recorded);
  const [record] = charged;
  assert.deepEqual(warnings(), [[OFF_LIST_PRICE, {
    route: route.registeredId,
    model: route.model,
    requestId: record!.requestId,
    ...reported,
  }]]);
  assert.equal(record!.listPriceUsdMicros, listPriceUsdMicros(route, usage.input, usage.output));
  assert.deepEqual(
    [record!.providerServiceTier, record!.providerInferenceGeo],
    [reported.serviceTier, reported.inferenceGeo],
  );
}

test('a platform-funded Anthropic response served in the US-only region warns once and is charged at list price', (t) =>
  assertChargedAtListPriceWithOneWarning(t, SONNET, SONNET_GEO_US, { input: 18, output: 4 }, {
    serviceTier: 'standard', inferenceGeo: 'us',
  }));

test('a platform-funded Anthropic response on priority tier (derived from the standard recording; priority cannot be recorded without a commitment) warns once and is charged at list price', (t) => {
  const priority = SONNET_STANDARD.replace('"service_tier":"standard"', '"service_tier":"priority"');
  assert.notEqual(priority, SONNET_STANDARD);
  return assertChargedAtListPriceWithOneWarning(t, SONNET, priority, { input: 18, output: 4 }, {
    serviceTier: 'priority', inferenceGeo: 'global',
  });
});

test('a platform-funded OpenAI response on flex tier warns once and is charged at list price', (t) =>
  assertChargedAtListPriceWithOneWarning(t, LUNA, LUNA_FLEX, { input: 13, output: 5 }, {
    serviceTier: 'flex', inferenceGeo: null,
  }));

test('a platform-funded Haiku 4.5 request served with no region to report (not_available) does not warn', async (t) => {
  const { charged, warnings } = proxied(t);

  const { sent } = await send(HAIKU, ...onCredits(HAIKU), HAIKU_STANDARD);

  assert.equal(sent[0]?.body.service_tier, 'standard_only');
  assert.equal(charged.length, 1);
  assert.deepEqual([charged[0]!.providerServiceTier, charged[0]!.providerInferenceGeo], ['standard', 'not_available']);
  assert.deepEqual(warnings(), []);
});
