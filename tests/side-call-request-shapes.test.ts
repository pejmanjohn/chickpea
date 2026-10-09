import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { withStatelessModelAccess } from '../src/config/installation-model-access.ts';
import { configureModelAccessResolver } from '../src/config/model-access.ts';
import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { runStatelessVisionCall } from '../src/images/inspect-output.ts';
import { BUNDLED_MODEL_CATALOG } from '../src/model-catalog/bundled.ts';
import { bootstrapRuntimeProviders } from '../src/runtime-bootstrap.ts';
import { classifySlackInteraction } from '../src/slack/interaction-intent.ts';

process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
configureModelAccessResolver({ resolve: async () => ({ apiKey: 'test-not-a-key' }) } as never);
bootstrapRuntimeProviders();

// What the provider refuses with a 400, per its model reference.
// claude-opus-5 accepts disabled thinking at its default effort (high).
const REFUSES: Record<string, { temperature: boolean; disabledThinking: boolean }> = {
  'anthropic/claude-fable-5-1': { temperature: true, disabledThinking: true },
  'anthropic/claude-opus-5-5': { temperature: true, disabledThinking: true },
  'anthropic/claude-sonnet-5-5': { temperature: true, disabledThinking: true },
  'anthropic/claude-opus-5': { temperature: true, disabledThinking: false },
  'anthropic/claude-sonnet-5': { temperature: true, disabledThinking: false },
};
const ANTHROPIC_MODELS = BUNDLED_MODEL_CATALOG.map(({ id }) => id).filter((id) => id.startsWith('anthropic/'));

function sse(text: string): string {
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** A Messages endpoint that refuses what `model` refuses and otherwise answers `text`. */
function strictAnthropic(t: TestContext, model: string, text: string): Array<Record<string, any>> {
  const bodies: Array<Record<string, any>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Request(input, init).json() as Record<string, any>;
    bodies.push(body);
    const refuses = REFUSES[model]!;
    const refused = refuses.temperature && 'temperature' in body ? 'temperature'
      : refuses.disabledThinking && body.thinking?.type === 'disabled' ? 'thinking.type disabled' : undefined;
    if (refused) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${refused} is not supported` } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(sse(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return bodies;
}

test('every Anthropic catalog model has its refusals recorded here', () => {
  assert.deepEqual([...ANTHROPIC_MODELS].sort(), Object.keys(REFUSES).sort());
});

for (const model of ANTHROPIC_MODELS) {
  test(`the intent check answers on ${model}`, async (t) => {
    const bodies = strictAnthropic(t, model, JSON.stringify({ disposition: 'work', reason: 'substantive_request', memoryIntent: 'none', checklist: ['Findings'] }));
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => settings.close());
    const classification = await classifySlackInteraction({
      workspaceId: 'T_SHAPE', channelId: 'C_SHAPE', eventId: 'Ev_shape', text: 'Is this result significant?',
      source: 'app_mention', guaranteed: true, profileInstructions: 'Answer as a teammate.', requestedModel: model,
    }, undefined, undefined, undefined, { settings });
    assert.equal(bodies.length, 1);
    assert.equal(classification.failed, false, `request sent ${JSON.stringify({ thinking: bodies[0]!.thinking, temperature: bodies[0]!.temperature })}`);
    assert.equal(classification.intent.disposition, 'work');
    if (bodies[0]!.thinking?.type === 'adaptive') assert.deepEqual(bodies[0]!.output_config, { effort: 'low' });
  });

  test(`a visual check answers on ${model}`, async (t) => {
    const bodies = strictAnthropic(t, model, 'A blue square.');
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => settings.close());
    const { model: runtimeModel } = await resolveRuntimeModel('vision-shape', model, { settings });
    const answer = await withStatelessModelAccess(runtimeModel, { env: undefined, settings, runId: 'vision-shape', purpose: 'vision' },
      () => runStatelessVisionCall(runtimeModel, { systemPrompt: 'Describe.', content: [{ type: 'text', text: 'What is shown?' }] }));
    assert.equal(answer, 'A blue square.');
    assert.equal(bodies.length, 1);
  });
}
