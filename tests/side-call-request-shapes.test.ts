import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { withStatelessModelAccess } from '../src/config/installation-model-access.ts';
import { configureModelAccessResolver } from '../src/config/model-access.ts';
import { invalidateProviderModelCache, primeProviderModelCache } from '../src/config/provider-models.ts';
import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { runStatelessVisionCall } from '../src/images/inspect-output.ts';
import { BUNDLED_MODEL_CATALOG } from '../src/model-catalog/bundled.ts';
import { bootstrapRuntimeProviders } from '../src/runtime-bootstrap.ts';
import { classifySlackInteraction } from '../src/slack/interaction-intent.ts';

process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.OPENAI_API_KEY = 'test-not-a-key';
process.env.OPENROUTER_API_KEY = 'test-not-a-key';
configureModelAccessResolver({ resolve: async () => ({ apiKey: 'test-not-a-key' }) } as never);
bootstrapRuntimeProviders();

// What the provider refuses with a 400, per its model reference.
// claude-opus-5 accepts disabled thinking at its default effort (high).
const ANTHROPIC_REFUSES: Record<string, { temperature: boolean; disabledThinking: boolean }> = {
  'anthropic/claude-fable-5-1': { temperature: true, disabledThinking: true },
  'anthropic/claude-opus-5-5': { temperature: true, disabledThinking: true },
  'anthropic/claude-sonnet-5-5': { temperature: true, disabledThinking: true },
  'anthropic/claude-opus-5': { temperature: true, disabledThinking: false },
  'anthropic/claude-sonnet-5': { temperature: true, disabledThinking: false },
};
const CATALOG = BUNDLED_MODEL_CATALOG.map(({ id }) => id);
const ANTHROPIC_MODELS = CATALOG.filter((id) => id.startsWith('anthropic/'));
const OPENAI_MODELS = CATALOG.filter((id) => id.startsWith('openai/'));

// Output tokens a model spends thinking before it answers. Thinking and the
// answer share the output cap, so a cap without room for both ends with no answer.
const THOUGHT_TOKENS = 3_000;
const ANSWER_TOKENS = 200;

const INTENT = JSON.stringify({ disposition: 'work', reason: 'substantive_request', memoryIntent: 'none', checklist: ['Findings'] });
const VISION_ANSWER = 'A blue square.';

function anthropicStream(text: string | undefined): string {
  const usage = { input_tokens: 10, output_tokens: 1 };
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage } },
    ...(text === undefined ? [] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
    ]),
    { type: 'message_delta', delta: { stop_reason: text === undefined ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function openAiStream(text: string | undefined): string {
  const message = (status: string, content: unknown[]) => ({ type: 'message', id: 'msg_1', role: 'assistant', status, content });
  return [
    { type: 'response.created', response: { id: 'resp_1' } },
    ...(text === undefined ? [] : [
      { type: 'response.output_item.added', item: message('in_progress', []) },
      { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', delta: text },
      { type: 'response.output_item.done', item: message('completed', [{ type: 'output_text', text, annotations: [] }]) },
    ]),
    {
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } } },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function refusal(message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
}

/**
 * A provider endpoint for `model` that refuses what the model refuses, thinks
 * THOUGHT_TOKENS whenever thinking or reasoning is on, and answers `text` only
 * when the output cap leaves room for it.
 */
function strictProvider(t: TestContext, model: string, text: string): Array<Record<string, any>> {
  const bodies: Array<Record<string, any>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Request(input, init).json() as Record<string, any>;
    bodies.push(body);
    if (model.startsWith('anthropic/')) {
      const refuses = ANTHROPIC_REFUSES[model]!;
      if (refuses.temperature && 'temperature' in body) return refusal('temperature is not supported');
      if (refuses.disabledThinking && body.thinking?.type === 'disabled') return refusal('thinking.type disabled is not supported');
      const thinks = body.thinking !== undefined && body.thinking.type !== 'disabled';
      const room = body.max_tokens - (thinks ? THOUGHT_TOKENS : 0) >= ANSWER_TOKENS;
      return new Response(anthropicStream(room ? text : undefined), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const thinks = body.reasoning?.effort !== 'none';
    const room = body.max_output_tokens - (thinks ? THOUGHT_TOKENS : 0) >= ANSWER_TOKENS;
    return new Response(openAiStream(room ? text : undefined), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return bodies;
}

test('the intent check on an OpenRouter Anthropic route caches only its instructions', async (t) => {
  primeProviderModelCache('openrouter', [{ id: 'anthropic/claude-opus-5.5' }], undefined);
  t.after(() => invalidateProviderModelCache('openrouter'));
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(await new Request(input, init).json());
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await classifySlackInteraction({
    workspaceId: 'T_SHAPE', channelId: 'C_SHAPE', eventId: 'Ev_shape', text: 'Is this result significant?',
    source: 'app_mention', guaranteed: true, profileInstructions: 'Answer as a teammate.',
    requestedModel: 'openrouter/anthropic/claude-opus-5.5',
  }, undefined, undefined, undefined, { settings });
  assert.equal(bodies.length, 1);
  const markers = bodies[0]!.messages.map(({ role, content }) =>
    [role, (content as Array<{ cache_control?: unknown }>).map((block) => block.cache_control ?? null)]);
  assert.deepEqual(markers, [['system', [{ type: 'ephemeral' }]], ['user', [null]]]);
});

test('every Anthropic catalog model has its refusals recorded here', () => {
  assert.deepEqual([...ANTHROPIC_MODELS].sort(), Object.keys(ANTHROPIC_REFUSES).sort());
});

for (const model of [...ANTHROPIC_MODELS, ...OPENAI_MODELS]) {
  test(`the intent check answers on ${model}, after a thought when the model cannot skip one`, async (t) => {
    const bodies = strictProvider(t, model, INTENT);
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => settings.close());
    const classification = await classifySlackInteraction({
      workspaceId: 'T_SHAPE', channelId: 'C_SHAPE', eventId: 'Ev_shape', text: 'Is this result significant?',
      source: 'app_mention', guaranteed: true, profileInstructions: 'Answer as a teammate.', requestedModel: model,
    }, undefined, undefined, undefined, { settings });
    assert.equal(bodies.length, 1);
    const { thinking, reasoning, temperature, output_config: outputConfig } = bodies[0]!;
    assert.equal(classification.failed, false, `request sent ${JSON.stringify({ thinking, reasoning, temperature })}`);
    assert.equal(classification.intent.disposition, 'work');
    assert.equal(temperature, undefined, 'no side call sends a temperature');
    if (thinking?.type === 'adaptive') assert.deepEqual(outputConfig, { effort: 'low' });
    if (reasoning && reasoning.effort !== 'none') assert.equal(reasoning.effort, 'low');
    if (model.startsWith('anthropic/')) {
      const { system, messages } = bodies[0]!;
      assert.deepEqual(system.map((block: { cache_control?: unknown }) => block.cache_control), [{ type: 'ephemeral' }],
        'the classifier instructions, the same on every call, are cached');
      assert.equal(JSON.stringify(messages).includes('cache_control'), false, 'the message classified on this call is not');
    }
  });

  test(`a visual check answers on ${model}, after a thought when the model cannot skip one`, async (t) => {
    const bodies = strictProvider(t, model, VISION_ANSWER);
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => settings.close());
    const { model: runtimeModel } = await resolveRuntimeModel('vision-shape', model, { settings });
    const answer = await withStatelessModelAccess(runtimeModel, { env: undefined, settings, runId: 'vision-shape', purpose: 'vision' },
      () => runStatelessVisionCall(runtimeModel, { systemPrompt: 'Describe.', content: [{ type: 'text', text: 'What is shown?' }] }));
    assert.equal(answer, VISION_ANSWER);
    assert.equal(bodies.length, 1);
  });
}
