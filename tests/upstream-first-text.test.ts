import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { normalizeContext, type AssistantMessageEvent, type Context } from '@earendil-works/pi-ai';
import type { FlueExecutionOperation, FlueObservation } from '@flue/runtime';

import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  configureModelRequestRecorder,
  modelAccessRequest,
  resetModelAccessForTests,
  withModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registerBuiltinPiProvider } from '../src/config/pi-provider.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../src/config/platform-funding.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { ModelStepMarks } from '../src/observability/runtime-latency.ts';
import type { ModelRequestRecord } from '../src/usage/model-requests.ts';
import { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } from './helpers/platform-funding.ts';

type Provider = 'anthropic' | 'openai';

const MODEL: Readonly<Record<Provider, string>> = { anthropic: 'claude-opus-5-5', openai: 'gpt-5.6-luna' };
const CONTEXT: Context = { systemPrompt: 'probe', messages: [{ role: 'user', content: 'hello', timestamp: 1 }] };
const STEP: FlueExecutionOperation = { type: 'model', turnId: 'step_1' };

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Each provider's reasoning, empty text and answer text events, as its API streams them. */
const WIRE: Readonly<Record<Provider, { reasoning: string; emptyText: string; text(text: string): string }>> = {
  anthropic: {
    reasoning: sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan the answer.' } }),
    emptyText: sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '' } }),
    text: (text) => sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }),
  },
  openai: {
    reasoning: sse({
      type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0,
      delta: 'Plan the answer.',
    }),
    emptyText: sse({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: '' }),
    text: (delta) => sse({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta }),
  },
};

function pushedBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (started) => { controller = started; } });
  const encoder = new TextEncoder();
  return {
    body,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const NOT_YET = Symbol('not yet');

/** The promise's value when it settles before the next macrotask: no timer and no wait for later bytes. */
function atOnce<T>(promise: Promise<T>): Promise<T | typeof NOT_YET> {
  return Promise.race([promise, new Promise<typeof NOT_YET>((resolve) => setImmediate(() => resolve(NOT_YET)))]);
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

async function within<T>(ms: number, promise: Promise<T>, failure: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(failure)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observation(event: Record<string, unknown>): FlueObservation {
  return event as unknown as FlueObservation;
}

function stepMarks() {
  let now = 5_000;
  const records: Record<string, unknown>[] = [];
  const steps = new ModelStepMarks(() => now, { info: (record) => records.push(record) });
  steps.observe(observation({ type: 'turn_request', turnId: 'step_1', purpose: 'agent' }));
  return {
    steps,
    advance: (ms: number) => {
      now += ms;
    },
    /** The step's model_step record, once Flue ends the step. */
    end: () => {
      steps.observe(observation({
        type: 'turn', turnId: 'step_1', purpose: 'agent', durationMs: 2_000, isError: false,
        response: { finishReason: 'stop' },
      }));
      const record = records.at(-1);
      assert.equal(record?.event, 'model_step');
      return record!;
    },
  };
}

function grant(providerId: Provider, fundingSource: ModelAccessGrant['fundingSource'], installationId = 'chickpea'): ModelAccessGrant {
  return {
    installationId, providerId, runId: `run_${fundingSource}`, fundingSource,
    credentialRefId: fundingSource === 'platform' ? `platform:${providerId}` : `cred_${providerId}`, credentialVersion: 1,
  };
}

function proxied(t: TestContext) {
  resetModelAccessForTests();
  registerBuiltinPiProvider('anthropic');
  registerBuiltinPiProvider('openai');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-upstream-first-text-test' }) });
  t.after(resetModelAccessForTests);
}

function modelOf(provider: Provider) {
  const model = registeredPiProvider(provider)?.getModels().find((candidate) => candidate.id === MODEL[provider]);
  assert.ok(model, `${provider} lists ${MODEL[provider]}`);
  return model;
}

const eventStream = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

// Defects caught: a stamp from reasoning, from an empty text delta, from a
// later text event, or before an event's last bytes arrive; a request fetch
// that waits for any byte before it returns, holds a chunk from the caller,
// or hands the caller another response or other bytes.
for (const provider of ['anthropic', 'openai'] as const) {
  test(`${provider}: model_step stamps the first answer text as it reaches the proxy, and the caller reads each chunk as it arrives`, async (t) => {
    proxied(t);
    const step = stepMarks();
    const wire = pushedBody();
    const served = eventStream(wire.body);
    const network: typeof fetch = async () => served;
    await withModelAccess(grant(provider, 'customer'), undefined, 'reply', () => step.steps.intercept(STEP, async () => {
      const sentFetch = modelAccessRequest(provider, modelOf(provider), { fetch: network }).options.fetch;
      assert.ok(sentFetch && sentFetch !== network, 'a request inside a model step has its response read on the way');
      const response = await atOnce(sentFetch('https://provider.invalid/v1/stream', { method: 'POST' }));
      assert.equal(response, served, 'the caller gets the provider response itself before any byte arrives');
      const caller = served.body!.getReader();
      const decoder = new TextDecoder();
      const text = WIRE[provider].text('Hello');
      const split = text.indexOf('Hello');
      const chunks: Array<readonly [number, string]> = [
        [100, WIRE[provider].reasoning],
        [100, WIRE[provider].emptyText],
        [700, text.slice(0, split)],
        [50, text.slice(split)],
        [100, WIRE[provider].text(' there')],
      ];
      for (const [ms, chunk] of chunks) {
        step.advance(ms);
        wire.push(chunk);
        const read = await atOnce(caller.read());
        assert.notEqual(read, NOT_YET, `${JSON.stringify(chunk)} reached the caller at once`);
        assert.equal(decoder.decode((read as ReadableStreamReadResult<Uint8Array>).value), chunk);
        await settled();
      }
      wire.end();
      assert.equal((await caller.read()).done, true);
    }));
    assert.equal(step.end().upstreamFirstTextMs, 950);
  });
}

// Defects caught: a stamp that replaces the provider report reader's fetch
// (a platform-funded step would lose its service tier and region), a stamp
// pi-ai's own request never reaches, and text pi-ai sees only once the
// response ends.
test('a platform-funded Anthropic step through pi-ai keeps its provider report, streams its text before the response ends, and logs upstreamFirstTextMs', async (t) => {
  proxied(t);
  resetPlatformFundingForTests();
  resetInstallationAdmissionForTests();
  t.after(() => {
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  configureInstallationAdmission(async () => 'admitted');
  const recorded: ModelRequestRecord[] = [];
  configureModelRequestRecorder(async (record) => {
    recorded.push(record);
  });
  configurePlatformFunding({
    ...EVERY_PROVIDER_FUNDED,
    funding: async () => 'platform',
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
  });
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_upstream' }) as PlatformEnv;
  const step = stepMarks();
  const wire = pushedBody();
  let fetched!: () => void;
  const sent = new Promise<void>((resolve) => { fetched = resolve; });
  const network: typeof fetch = async () => {
    fetched();
    return eventStream(wire.body);
  };
  const provider = registeredPiProvider('anthropic')!;
  await withModelAccess(grant('anthropic', 'platform', 'inst_upstream'), env, 'reply', () => step.steps.intercept(STEP, async () => {
    const stream = provider.streamSimple(modelOf('anthropic'), normalizeContext(CONTEXT), { fetch: network });
    const events = stream[Symbol.asyncIterator]();
    await within(2_000, sent, 'pi-ai never sent the request');
    await settled();
    step.advance(400);
    wire.push([
      sse({
        type: 'message_start',
        message: {
          id: 'msg_upstream', type: 'message', role: 'assistant', model: MODEL.anthropic, content: [],
          usage: { input_tokens: 12, output_tokens: 1, service_tier: 'standard', inference_geo: 'global' },
        },
      }),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      WIRE.anthropic.reasoning,
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_upstream' } }),
      sse({ type: 'content_block_stop', index: 0 }),
    ].join(''));
    await settled();
    step.advance(800);
    wire.push(sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + WIRE.anthropic.text('Hello'));
    for (;;) {
      const next = await within(2_000, events.next(), 'pi-ai saw no text before the response ended');
      assert.equal(next.done, false);
      const event: AssistantMessageEvent = next.value;
      if (event.type === 'text_delta') {
        assert.equal(event.delta, 'Hello');
        break;
      }
    }
    step.advance(300);
    wire.push([
      sse({ type: 'content_block_stop', index: 1 }),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      sse({ type: 'message_stop' }),
    ].join(''));
    wire.end();
    while (!(await events.next()).done);
    assert.equal((await stream.result()).stopReason, 'stop');
  }));
  assert.equal(step.end().upstreamFirstTextMs, 1_200);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.providerServiceTier, 'standard');
  assert.equal(recorded[0]?.providerInferenceGeo, 'global');
});

// Defects caught: a copy of every response made outside a model step (the
// classifier and other stateless calls), a stamp bound for another
// operation, and a stamp on a step that wrote no answer text.
test('a request outside a model step keeps its own fetch, and a tool-call step logs no upstreamFirstTextMs', async (t) => {
  proxied(t);
  const network: typeof fetch = async () => new Response('');
  const step = stepMarks();
  await withModelAccess(grant('anthropic', 'customer'), undefined, 'reply', async () => {
    assert.equal(modelAccessRequest('anthropic', modelOf('anthropic'), { fetch: network }).options.fetch, network);
    await step.steps.intercept({ type: 'tool', toolCallId: 'call_1', toolName: 'lookup' }, async () => {
      assert.equal(modelAccessRequest('anthropic', modelOf('anthropic'), { fetch: network }).options.fetch, network);
    });
  });
  const wire = pushedBody();
  wire.push([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"word":"text_delta"}' } }),
    sse({ type: 'content_block_stop', index: 0 }),
  ].join(''));
  wire.end();
  const toolCallNetwork: typeof fetch = async () => eventStream(wire.body);
  await withModelAccess(grant('anthropic', 'customer'), undefined, 'reply', () => step.steps.intercept(STEP, async () => {
    const sentFetch = modelAccessRequest('anthropic', modelOf('anthropic'), { fetch: toolCallNetwork }).options.fetch;
    await (await sentFetch!('https://provider.invalid/v1/stream')).text();
    await settled();
  }));
  assert.equal('upstreamFirstTextMs' in step.end(), false);
});
