import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AssistantMessage, Context, Model, Provider } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';

import {
  registerPiProvider,
  registeredPiProvider,
  restoreInterruptedStreamPartials,
} from '../src/config/pi-provider-registry.ts';

const model = {
  id: 'gpt-test', name: 'gpt-test', api: 'openai-responses', provider: 'openai',
  baseUrl: 'https://example.invalid', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
} as unknown as Model<'openai-responses'>;

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 1, content: [], ...overrides,
  };
}

/** What Flue hands the provider after a code update interrupted the stream. */
function recoveredContext(partial: AssistantMessage): Context {
  return {
    systemPrompt: 'system',
    messages: [
      { role: 'user', content: 'Write the migration plan.', timestamp: 1 },
      partial,
      { role: 'user', content: 'The previous assistant stream was interrupted.', timestamp: 2 },
      { role: 'user', content: 'Continue from the durable partial assistant response.', timestamp: 3 },
    ],
  };
}

const PARTIAL = assistant({
  stopReason: 'aborted',
  errorMessage: 'Stream interrupted before completion.',
  content: [
    { type: 'thinking', thinking: 'plan it', thinkingSignature: '{"id":"rs_1"}' },
    { type: 'text', text: '## Plan\n\n1. Inventory the col', textSignature: '{"v":1,"id":"msg_1"}' },
  ],
});

test('pi-ai drops the interrupted partial Flue asks the model to continue (why a redeploy regenerated the answer)', () => {
  const sent = transformMessages(recoveredContext(PARTIAL).messages, model);
  assert.equal(sent.filter((message) => message.role === 'assistant').length, 0,
    'without the repair the model sees "continue" but not what to continue from');
});

test('the provider seam hands the model its partial text, so it continues instead of regenerating', () => {
  const context = recoveredContext(PARTIAL);
  const restored = restoreInterruptedStreamPartials(context);
  const sent = transformMessages(restored.messages, model);
  const partial = sent.find((message) => message.role === 'assistant') as AssistantMessage | undefined;
  assert.ok(partial, 'the partial reaches the request');
  assert.deepEqual(partial.content, [{ type: 'text', text: '## Plan\n\n1. Inventory the col' }],
    'text only: no reasoning without its item, no signature of an incomplete item');
  assert.equal(partial.stopReason, 'stop');
  assert.equal(partial.errorMessage, undefined);
  // Flue's own record is untouched.
  assert.equal(context.messages[1], PARTIAL);
  assert.equal(PARTIAL.stopReason, 'aborted');
  assert.equal(PARTIAL.content.length, 2);
});

test('only a text partial without tool calls is restored; everything else is passed through unchanged', () => {
  const withTool = assistant({ stopReason: 'aborted', content: [
    { type: 'text', text: 'Checking' },
    { type: 'toolCall', id: 'call_1', name: 'read', arguments: {} },
  ] });
  const reasoningOnly = assistant({ stopReason: 'aborted', content: [{ type: 'thinking', thinking: 'hmm' }] });
  const errored = assistant({ stopReason: 'error', content: [{ type: 'text', text: 'partial' }] });
  for (const message of [withTool, reasoningOnly, errored]) {
    const context = recoveredContext(message);
    assert.equal(restoreInterruptedStreamPartials(context), context);
  }
});

test('every registered provider streams through the seam and keeps its other members', () => {
  const seen: Context[] = [];
  class ClassProvider {
    readonly id = 'continuation-test';
    readonly name = 'Continuation test';
    readonly auth = { apiKey: { resolve: async () => undefined } } as unknown as Provider['auth'];
    #models = [model];
    getModels() { return this.#models; }
    stream(_model: Model<string>, context: Context) { seen.push(context); return undefined as never; }
    streamSimple(_model: Model<string>, context: Context) { seen.push(context); return undefined as never; }
  }
  registerPiProvider(new ClassProvider() as unknown as Provider);
  const registered = registeredPiProvider('continuation-test')!;
  assert.deepEqual(registered.getModels(), [model], 'private members still reachable');
  registered.streamSimple(model, recoveredContext(PARTIAL));
  registered.stream(model, recoveredContext(PARTIAL));
  for (const context of seen) {
    assert.equal((context.messages[1] as AssistantMessage).stopReason, 'stop');
  }
  assert.equal(seen.length, 2);
});
