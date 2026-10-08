import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

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
import {
  providerReportReader,
  type ModelRequestRecord,
  type ProviderReportReader,
} from '../../src/usage/model-requests.ts';
import { priceCatalogFor } from '../../src/usage/pricing/catalog.ts';
import { SqliteUsageStore } from '../../src/usage/store.ts';

// One OpenRouter credit is one US dollar: https://openrouter.ai/docs/faq ("OpenRouter
// uses a credit system where the base currency is US dollars").
const RECORDED_STREAM = `data: {"id":"gen-fixture-stream","object":"chat.completion.chunk","created":1791383960,"model":"deepseek/deepseek-v4.1-flash","provider":"InferenceNet","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"The","reasoning_details":[{"type":"reasoning.text","text":"The","format":"unknown","index":0}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-fixture-stream","object":"chat.completion.chunk","created":1791383960,"model":"deepseek/deepseek-v4.1-flash","provider":"InferenceNet","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":" user wants","reasoning_details":[{"type":"reasoning.text","text":" user wants","format":"unknown","index":0}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-fixture-stream","object":"chat.completion.chunk","created":1791383960,"model":"deepseek/deepseek-v4.1-flash","provider":"InferenceNet","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":" me to reply with the","reasoning_details":[{"type":"reasoning.text","text":" me to reply with the","format":"unknown","index":0}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-fixture-stream","object":"chat.completion.chunk","created":1791383960,"model":"deepseek/deepseek-v4.1-flash","provider":"InferenceNet","system_fingerprint":"inference.net","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":null},"finish_reason":"length","native_finish_reason":"length"}]}

data: {"id":"gen-fixture-stream","object":"chat.completion.chunk","created":1791383960,"model":"deepseek/deepseek-v4.1-flash","provider":"InferenceNet","system_fingerprint":"inference.net","service_tier":null,"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"length","native_finish_reason":"length"}],"usage":{"prompt_tokens":37,"completion_tokens":8,"total_tokens":45,"cost":0.000007765,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.000007765,"upstream_inference_prompt_cost":0.000005365,"upstream_inference_completions_cost":0.0000024},"completion_tokens_details":{"reasoning_tokens":8,"image_tokens":0,"audio_tokens":0}}}

data: [DONE]

`;

const RECORDED_JSON = `{"id":"gen-fixture-json","object":"chat.completion","created":1791383961,"model":"deepseek/deepseek-v4.1-flash","provider":"CoreWeave","system_fingerprint":null,"service_tier":null,"choices":[{"index":0,"logprobs":null,"finish_reason":"length","native_finish_reason":"length","message":{"role":"assistant","content":null,"refusal":null,"reasoning":"The user wants me to reply with the","reasoning_details":[{"type":"reasoning.text","text":"The user wants me to reply with the","format":"unknown","index":0}]}}],"usage":{"prompt_tokens":37,"completion_tokens":8,"total_tokens":45,"cost":0.0000126,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.0000126,"upstream_inference_prompt_cost":0.0000074,"upstream_inference_completions_cost":0.0000052},"completion_tokens_details":{"reasoning_tokens":8,"image_tokens":0,"audio_tokens":0}}}`;

const NOW = Date.UTC(2026, 9, 7, 12);
const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = 'sk-or-provider-cost-test-key';
const CONTEXT = { systemPrompt: 'probe', messages: [{ role: 'user' as const, content: 'hello', timestamp: 1 }] };

function deepseek(): Model<'openai-completions'> {
  const template = openrouterProvider().getModels().find((model) => model.id === 'deepseek/deepseek-v4-flash');
  assert.ok(template?.api === 'openai-completions', 'the library lists a DeepSeek flash model to copy');
  return { ...(template as Model<'openai-completions'>), id: DEEPSEEK, name: DEEPSEEK };
}

function recordedResponse(body: string = RECORDED_STREAM, contentType = 'text/event-stream'): Response {
  return new Response(body, { headers: { 'content-type': contentType } });
}

function grant(fundingSource: ModelAccessGrant['fundingSource'], installationId = 'chickpea'): ModelAccessGrant {
  return {
    installationId, providerId: 'openrouter', runId: `run_${fundingSource}`, fundingSource,
    credentialRefId: fundingSource === 'platform' ? 'platform:openrouter' : 'cred_openrouter', credentialVersion: 1,
  };
}

function call(model: Model<'openai-completions'>, options: { fetch?: typeof fetch } = {}): Promise<AssistantMessage> {
  return registeredPiProvider('openrouter')!.streamSimple(model, CONTEXT, options).result();
}

function proxiedOpenRouter(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  resetInstallationAdmissionForTests();
  registerBuiltinPiProvider('openrouter');
  const store = new SqliteUsageStore(':memory:');
  const recorded: ModelRequestRecord[] = [];
  configureModelAccessResolver({ resolve: async () => ({ apiKey: API_KEY }) });
  configureModelRequestRecorder(async (record) => {
    recorded.push(record);
    return store.recordModelRequest(record);
  });
  t.after(() => {
    store.close();
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  return { store, recorded };
}

function listPrice(input: number, output: number): { priceVersionId: string; listPriceUsdMicros: number } {
  const price = priceCatalogFor('standard_input_output', 'openrouter', DEEPSEEK, NOW);
  assert.ok(price, 'the model has a current list price');
  return {
    priceVersionId: price.version.id,
    listPriceUsdMicros: Math.round((input * price.rate.inputMicrosPerUnit + output * price.rate.outputMicrosPerUnit) /
      price.rate.unitScale),
  };
}

test('a streamed OpenRouter request records the cost OpenRouter reported, its response ID and its list price', async (t) => {
  const { store, recorded } = proxiedOpenRouter(t);
  const sent: string[] = [];
  const network: typeof fetch = async (input) => {
    sent.push(String(input));
    return recordedResponse();
  };

  const result = await withModelAccess(grant('customer'), undefined, 'reply', () => call(deepseek(), { fetch: network }));

  assert.equal(result.stopReason, 'length');
  assert.deepEqual(sent, [ENDPOINT]);
  assert.equal(recorded.length, 1);
  assert.deepEqual(await store.getModelRequest(recorded[0]!.requestId), {
    requestId: recorded[0]!.requestId,
    purpose: 'reply',
    installationId: 'chickpea',
    runId: 'run_customer',
    attemptId: recorded[0]!.attemptId,
    agentId: null,
    provider: 'openrouter',
    model: DEEPSEEK,
    fundingSource: 'customer',
    outcome: 'completed',
    inputTokens: 37,
    outputTokens: { total: 8, reasoning: 8 },
    cacheReadTokens: 0,
    cacheWriteTokens: { total: 0, oneHour: null },
    ...listPrice(37, 8),
    priceUnknownReason: null,
    providerCostUsdMicros: 8,
    providerResponseId: 'gen-fixture-stream',
    providerServiceTier: null,
    providerInferenceGeo: null,
    finishedAt: NOW,
  });
});

test('a platform-funded OpenRouter request is charged with the cost OpenRouter reported', async (t) => {
  const { store, recorded } = proxiedOpenRouter(t);
  configureInstallationAdmission(async () => 'admitted');
  const charged: ModelRequestRecord[] = [];
  configurePlatformFunding({
    funding: async () => 'platform',
    admit: async () => 'admitted',
    charge: async (record) => { charged.push(record); },
    priceMultiplier: async () => 1.5,
  });
  const network = t.mock.method(globalThis, 'fetch', async () => recordedResponse());
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_credits' }) as PlatformEnv;

  const result = await withModelAccess(grant('platform', 'inst_credits'), env, 'reply', () => call(deepseek()));

  assert.equal(result.stopReason, 'length');
  assert.equal(network.mock.callCount(), 1, 'the request reaches the network fetch looked up when it is sent');
  assert.equal(charged.length, 1);
  assert.deepEqual(charged, recorded, 'the charge carries the record the proxy wrote');
  assert.deepEqual(
    {
      fundingSource: charged[0]!.fundingSource,
      installationId: charged[0]!.installationId,
      providerCostUsdMicros: charged[0]!.providerCostUsdMicros,
      providerResponseId: charged[0]!.providerResponseId,
      priceVersionId: charged[0]!.priceVersionId,
      listPriceUsdMicros: charged[0]!.listPriceUsdMicros,
    },
    {
      fundingSource: 'platform',
      installationId: 'inst_credits',
      providerCostUsdMicros: 8,
      providerResponseId: 'gen-fixture-stream',
      ...listPrice(37, 8),
    },
  );
  assert.deepEqual(await store.getModelRequest(charged[0]!.requestId), charged[0]);
});

test('the library returns the same message through the proxy as it does called directly', async (t) => {
  proxiedOpenRouter(t);
  const model = deepseek();

  const proxied = await withModelAccess(grant('customer'), undefined, 'reply', () =>
    call(model, { fetch: async () => recordedResponse() }));
  const direct = await openrouterProvider().streamSimple(model, CONTEXT, {
    apiKey: API_KEY, fetch: async () => recordedResponse(),
  }).result();

  assert.equal(proxied.responseId, 'gen-fixture-stream');
  assert.deepEqual({ ...proxied, timestamp: 0 }, { ...direct, timestamp: 0 });
});

async function reportedCost(reader: ProviderReportReader): Promise<number | null> {
  return (await reader.report()).providerCostUsdMicros;
}

const encoder = new TextEncoder();

function streamedResponse(chunks: readonly Uint8Array[], failure?: Error): Response {
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else if (failure) controller.error(failure);
      else controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' } });
}

function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) chunks.push(bytes.slice(start, start + size));
  return chunks;
}

const FINAL_EVENT = RECORDED_STREAM.split('\n\n').find((event) => event.includes('"usage"'))!;
const CHATTER = [
  ': OPENROUTER PROCESSING\r\n\r\n',
  'event: message\nid: 1\ndata: {"id":"gen-fixture-chunks","choices":[{"delta":{"content":"Café ☕, naïve résumé 𝄞"}}]}\r\n\r\n',
].join('');
const MALFORMED_USAGE = `${FINAL_EVENT.slice(0, FINAL_EVENT.indexOf('"cost"') + 12)}\n\n`;

test('the reader returns the fetched response itself, byte for byte, and reads the cost from a copy split anywhere', async () => {
  for (const [label, text, expected] of [
    ['a malformed usage event alone', CHATTER + MALFORMED_USAGE, null],
    ['a valid usage event after a malformed one, ending the body without a blank line', CHATTER + MALFORMED_USAGE + FINAL_EVENT, 8],
    ['a later usage event without a cost after a valid one', `${CHATTER}${FINAL_EVENT}\n\ndata: {"usage":null}\n\ndata: [DONE]\n\n`, 8],
  ] as const) {
    const bytes = encoder.encode(text);
    const chunks = chunksOf(bytes, 7);
    assert.ok(chunks.some((chunk) => (chunk[0]! & 0xc0) === 0x80), 'a chunk starts inside a multibyte character');
    const fetched = streamedResponse(chunks);
    const reader = providerReportReader('openrouter', async () => fetched);

    const returned = await reader.fetch(ENDPOINT, { method: 'POST' });

    assert.strictEqual(returned, fetched, label);
    assert.deepEqual(new Uint8Array(await returned.arrayBuffer()), bytes, label);
    assert.equal(await reportedCost(reader), expected, label);
  }
});

test('a response that is not streamed gives the cost in its JSON body', async (t) => {
  const fetched = recordedResponse(RECORDED_JSON, 'application/json');
  const reader = providerReportReader('openrouter', undefined);
  t.mock.method(globalThis, 'fetch', async () => fetched);

  const returned = await reader.fetch(ENDPOINT);

  assert.strictEqual(returned, fetched);
  assert.equal(await returned.text(), RECORDED_JSON);
  assert.equal(await reportedCost(reader), 13);

  assert.equal(0.0001245 * 1_000_000, 124.49999999999999, 'binary floating point lands below the half micro-USD');
  const halfMicro = providerReportReader('openrouter', async () => recordedResponse('{"usage":{"cost":0.0001245}}', 'application/json'));
  await (await halfMicro.fetch(ENDPOINT)).text();
  assert.equal(await reportedCost(halfMicro), 125, 'half a micro-USD rounds up');
});

test('a missing or unusable cost gives null and the response as fetched', async () => {
  for (const [label, body] of [
    ['no usage', '{"id":"gen-fixture-json","choices":[]}'],
    ['a cost in a string', '{"usage":{"cost":"0.0000126"}}'],
    ['a negative cost', '{"usage":{"cost":-0.0000126}}'],
    ['a null cost', '{"usage":{"cost":null}}'],
    ['a cost past every number', '{"usage":{"cost":1e400}}'],
    ['a cost past a safe integer of micro-USD', '{"usage":{"cost":1e300}}'],
  ] as const) {
    for (const [contentType, text] of [
      ['application/json', body],
      ['text/event-stream', `data: ${body}\n\ndata: [DONE]\n\n`],
    ] as const) {
      const fetched = recordedResponse(text, contentType);
      const reader = providerReportReader('openrouter', async () => fetched);

      assert.strictEqual(await reader.fetch(ENDPOINT), fetched, label);
      assert.equal(await fetched.text(), text, label);
      assert.equal(await reportedCost(reader), null, `${label} (${contentType})`);
    }
  }
});

test('an error status or another content type is never copied, whatever its body says', async (t) => {
  const clone = t.mock.method(Response.prototype, 'clone');
  for (const fetched of [
    new Response(RECORDED_JSON, { status: 429, headers: { 'content-type': 'application/json' } }),
    recordedResponse(RECORDED_JSON, 'text/plain'),
  ]) {
    const reader = providerReportReader('openrouter', async () => fetched);

    assert.strictEqual(await reader.fetch(ENDPOINT), fetched);
    assert.equal(await reportedCost(reader), null);
    assert.equal(await fetched.text(), RECORDED_JSON);
  }
  assert.equal(clone.mock.callCount(), 0);
});

test('a body that fails part way gives null, and the caller sees the failure as it would without the reader', async () => {
  const failure = new Error('connection reset');
  const bytes = encoder.encode(RECORDED_STREAM);
  const fetched = streamedResponse([bytes.slice(0, RECORDED_STREAM.indexOf('"usage"'))], failure);
  const reader = providerReportReader('openrouter', async () => fetched);

  const returned = await reader.fetch(ENDPOINT);

  assert.strictEqual(returned, fetched);
  await assert.rejects(returned.text(), (error: unknown) => error === failure);
  assert.equal(await reportedCost(reader), null);
});

test('a copy that never ends gives null after the bounded wait', { timeout: 5_000 }, async () => {
  const fetched = new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), {
    headers: { 'content-type': 'text/event-stream' },
  });
  const reader = providerReportReader('openrouter', async () => fetched);
  await reader.fetch(ENDPOINT);
  const started = performance.now();

  assert.equal(await reportedCost(reader), null);

  const waited = performance.now() - started;
  assert.ok(waited >= 900 && waited < 2_000, `waited ${waited} ms`);
});
