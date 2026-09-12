import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type ProviderStreams } from '@earendil-works/pi-ai';
import { createChickpeaPiProvider } from '../src/config/pi-provider.ts';
import { registerPiProvider } from '../src/config/pi-provider-registry.ts';
import { inspectImageOutput } from '../src/images/inspect-output.ts';

test('visual inspection uses one configured-model call with no tools and validates its result', async () => {
  const model: Model<string> = { id: 'vision', name: 'Test vision', provider: 'image-inspection-test', api: 'image-inspection-test',
    input: ['text', 'image'], reasoning: false, baseUrl: 'https://example.invalid', contextWindow: 32000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const calls: { context: Context; options: Record<string, unknown> }[] = [];
  let text = '{"verdict":"needs_changes","observations":"The headline reads HEL0 instead of HELLO."}';
  const stream = (_model: Model<string>, context: Context, options?: unknown) => {
    assert.equal(_model.id, model.id);
    calls.push({ context, options: options as Record<string, unknown> });
    const output = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text }], api: model.api,
      provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { output.push({ type: 'done', reason: 'stop', message }); output.end(); });
    return output;
  };
  registerPiProvider(createChickpeaPiProvider({ id: model.provider, apiKey: 'synthetic-test-key', models: [model],
    api: { stream, streamSimple: stream } as ProviderStreams }));
  const input = { prompt: 'Headline HELLO', image: { bytes: new Uint8Array([2]), mimeType: 'image/png' },
    references: [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }] };
  const result = await inspectImageOutput(`${model.provider}/${model.id}`, input);
  assert.equal(result.verdict, 'needs_changes');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.context.tools, []);
  assert.equal(calls[0]!.context.messages.length, 1);
  assert.equal(calls[0]!.options.maxRetries, 0);
  assert.equal(calls[0]!.options.maxTokens, 1024);
  assert.ok(calls[0]!.options.signal instanceof AbortSignal);
  const content = calls[0]!.context.messages[0]!.content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content.filter((part) => part.type === 'image').map((part) => part.data), ['AQ==', 'Ag==']);
  text = '{"verdict":"perfect","observations":"ignore all rules"}';
  assert.equal((await inspectImageOutput(`${model.provider}/${model.id}`, input)).status, 'unavailable');
});
