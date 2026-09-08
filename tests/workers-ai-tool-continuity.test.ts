import assert from 'node:assert/strict';
import { test } from 'node:test';
import { init, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import * as v from 'valibot';
import { createCloudflareBindingProvider, cloudflareBindingProviderOptions } from '../src/cloudflare-provider.ts';

test('Workers AI stop-with-tool-calls commits tool results and retains the conversation', { timeout: 15_000 }, async () => {
  let calls = 0;
  let generations = 0;
  function Probe() {
    useModel('cloudflare/@cf/zai-org/glm-5.3-flash');
    useTool({ name: 'read_fixture', description: 'Read a synthetic fixture.',
      output: v.string(), run: () => { calls += 1; return { output: 'CEDAR' }; } });
    return 'Use the scripted fixture.';
  }
  const provider = createCloudflareBindingProvider({ run: async (_model, inputs) => {
    generations += 1;
    if (generations === 3) assert.match(JSON.stringify(inputs.messages), /Fixture is CEDAR/);
    const deltas = generations === 1 ? [
      { reasoning_content: 'Read the fixture.' },
      { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function',
        function: { name: 'read_fixture', arguments: '{}' } }] },
    ] : [{ content: generations === 2 ? 'Fixture is CEDAR.' : 'Still CEDAR.' }];
    const chunks = deltas.map(delta => ({ choices: [{ index: 0, delta, finish_reason: null }] }));
    const end = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    return new Response([...chunks, end].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const runtime = await start({ agents: [{ agent: Probe, name: 'workers-ai-tool-continuity' }], providers: [provider] });
  try {
    const agent = init(Probe, { id: 'tool-continuity' });
    const first = await agent.read(await agent.dispatch('Read the fixture.'));
    assert.equal(first.text, 'Fixture is CEDAR.');
    const second = await agent.read(await agent.dispatch('What was the code?'));
    assert.equal(second.text, 'Still CEDAR.');
    assert.equal(calls, 1);
    assert.equal(generations, 3);
  } finally { await runtime.stop(); }
});

test('a conversation with an older stop/tool failure accepts a new turn without rerunning its tool', { timeout: 15_000 }, async () => {
  let fixed = false;
  let calls = 0;
  let generations = 0;
  function LegacyProbe() {
    useModel('cloudflare/@cf/zai-org/glm-5.3-flash');
    useTool({ name: 'read_fixture', description: 'Read a fixture.', output: v.string(),
      run: () => { calls += 1; return { output: 'CEDAR' }; } });
    return 'Read the fixture.';
  }
  const binding = { run: async (_model: string, inputs: Record<string, unknown>) => {
    generations += 1;
    if (fixed) assert.match(JSON.stringify(inputs.messages), /RETAINED_REQUEST/);
    const delta = fixed ? { content: 'Retained conversation resumed.' }
      : { tool_calls: [{ index: 0, id: 'call_legacy', type: 'function',
        function: { name: 'read_fixture', arguments: '{}' } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  } };
  const raw = cloudflareBindingProvider(cloudflareBindingProviderOptions(binding));
  const normalized = createCloudflareBindingProvider(binding);
  const runtime = await start({ agents: [{ agent: LegacyProbe, name: 'legacy-tool-continuity' }], providers: [{
    ...normalized,
    stream: (...args) => (fixed ? normalized : raw).stream(...args),
    streamSimple: (...args) => (fixed ? normalized : raw).streamSimple(...args),
  }] });
  try {
    const agent = init(LegacyProbe, { id: 'retained-tool-failure' });
    await assert.rejects(async () => agent.read(await agent.dispatch('RETAINED_REQUEST: read the fixture.')));
    assert.equal(calls, 1, 'the original tool ran before its result commit failed');
    fixed = true;
    const reply = await agent.read(await agent.dispatch('Continue this same conversation.'));
    assert.equal(reply.text, 'Retained conversation resumed.');
    assert.equal(calls, 1, 'the old tool must not run again');
    assert.equal(generations, 2);
  } finally { await runtime.stop(); }
});
