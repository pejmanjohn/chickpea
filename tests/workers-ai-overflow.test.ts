import assert from 'node:assert/strict';
import test from 'node:test';
import { init, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { createCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import { createWorkersAiRestPiProvider } from '../src/config/pi-provider.ts';

const modelId = '@cf/zai-org/glm-5.3-flash';
function response(content: string, input = 10, tool = false) {
  return new Response(`data: ${JSON.stringify({
    choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call_read', type: 'function',
      function: { name: 'read_fixture', arguments: '{}' } }] } : { content }, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: 3, total_tokens: input + 3 },
  })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('GLM 5.3 uses its real context window in both Workers AI transports', () => {
  for (const provider of [
    createCloudflareBindingProvider({ run: async () => response('unused') }),
    createWorkersAiRestPiProvider({ baseUrl: 'https://example.invalid', contextWindowFloor: 32768, maxTokens: 2048 }),
  ]) assert.equal(provider.getModels().find((model) => model.id === modelId)?.contextWindow, 1_048_576);
});

for (const method of ['stream', 'streamSimple'] as const) {
  test(`Workers AI ${method} reports silent overflow as a failed completion`, async () => {
    const provider = createCloudflareBindingProvider({ run: async () => response('partial', 40_000) });
    const model = { ...provider.getModels().find((model) => model.id === modelId)!, contextWindow: 32_768 };
    const result = await provider[method](model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }).result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage ?? '', /exceeds the context window/);
    assert.equal(result.usage.input, 40_000);
  });
}

test('real Flue overflow compaction resumes after a successful tool without executing it twice', { timeout: 15_000 }, async () => {
  let reads = 0;
  function OverflowProbe() {
    useModel(`cloudflare/${modelId}`);
    useTool({ name: 'read_fixture', description: 'Read the synthetic fixture.',
      run: () => { reads++; return 'synthetic fixture'; } });
    return 'Follow the scripted synthetic fixture.';
  }
  let calls = 0;
  const provider = createCloudflareBindingProvider({ run: async () => {
    calls++;
    if (calls === 1) return response('First answer.');
    if (calls === 2) return response('', 10, true);
    if (calls === 3) return response('Partial answer.', 40_000);
    if (calls === 4) return response('Compacted synthetic context.');
    if (calls === 5) return response('Recovered answer.');
    throw new Error('Unexpected additional model call.');
  } });
  // Force a real overflow in a small deterministic fixture, independently of
  // production GLM metadata. The unguarded Flue 2.0 path throws here after
  // compaction because its canonical context still ends with an assistant.
  const catalog = provider.getModels();
  provider.getModels = () => catalog.map((model) => ({ ...model, contextWindow: 32_768 }));
  const runtime = await start({ agents: [{ agent: OverflowProbe, name: 'workers-ai-overflow-probe' }], providers: [provider] });
  try {
    const agent = init(OverflowProbe, { id: 'synthetic-overflow' });
    await agent.read(await agent.dispatch('First synthetic context. '.repeat(5000)));
    const reply = await agent.read(await agent.dispatch('Second synthetic context. '.repeat(2000)));
    assert.match(reply.text, /Recovered answer\.$/);
    assert.equal(reads, 1, 'recovery must retain the completed tool result');
    assert.equal(calls, 5, 'one failed completion, one compaction and one recovery');
  } finally {
    await runtime.stop();
  }
});
