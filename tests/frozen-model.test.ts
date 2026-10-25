import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { useFrozenModel } from '../src/agents/frozen-model.ts';

test('a frozen effort reaches the provider request, unless GLM forces thinking off', async () => {
  const requested: unknown[] = [];
  const answered = (_model: Model<string>, _context: unknown, options?: SimpleStreamOptions) => {
    requested.push(options?.reasoning);
    const output = createAssistantMessageEventStream();
    queueMicrotask(() => {
      output.push({ type: 'done', reason: 'stop', message: {
        role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'anthropic-messages',
        provider: 'effort-probe', model: 'probe', stopReason: 'stop', timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      output.end();
    });
    return output;
  };
  const provider = createProvider({
    id: 'effort-probe',
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [{
      id: 'probe', name: 'Probe', api: 'anthropic-messages', provider: 'effort-probe',
      baseUrl: 'https://provider.invalid', reasoning: true, input: ['text'],
      thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_024,
    } as Model<'anthropic-messages'>],
    api: { stream: () => assert.fail('Flue sends simple stream options'), streamSimple: answered },
  });
  function MaxEffort() {
    useFrozenModel('anthropic/claude-opus-5-5', 'effort-probe/probe', undefined, 'max');
    return 'Answer.';
  }
  function StandardEffort() {
    useFrozenModel('anthropic/claude-opus-5-5', 'effort-probe/probe', undefined, undefined);
    return 'Answer.';
  }
  function GlmWithEffort() {
    useFrozenModel('cloudflare/@cf/zai-org/glm-5.3-flash', 'effort-probe/probe', undefined, 'high');
    return 'Answer.';
  }
  const runtime = await start({
    agents: [
      { agent: MaxEffort, name: 'max-effort' },
      { agent: StandardEffort, name: 'standard-effort' },
      { agent: GlmWithEffort, name: 'glm-with-effort' },
    ],
    providers: [provider],
  });
  try {
    for (const agent of [MaxEffort, StandardEffort, GlmWithEffort]) {
      const instance = init(agent, { id: `${agent.name}-1` });
      await instance.read(await instance.dispatch({ message: 'Answer.' }));
    }
  } finally {
    await runtime.stop();
  }
  assert.deepEqual(requested, ['max', 'medium', undefined]);
});
