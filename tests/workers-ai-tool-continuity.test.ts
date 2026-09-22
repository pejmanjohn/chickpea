import assert from 'node:assert/strict';
import { test } from 'node:test';
import { init, useAgentFinish, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';
import { createCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import { ReceiptScopedTextRelay } from '../src/slack/progressive-relay.ts';
import { SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT, SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';

test('a retried Workers AI response resets the Slack relay and returns only the replacement answer', { timeout: 20_000 }, async () => {
  let generations = 0;
  let observePartial!: () => void;
  const partialObserved = new Promise<void>((resolve) => { observePartial = resolve; });
  const partial = 'An abandoned partial answer.';
  const replacement = 'The corrected complete answer.';
  function RetryProbe() {
    useModel('cloudflare/@cf/zai-org/glm-5.3-flash');
    useTool({
      name: SLACK_STREAM_ANSWER_TOOL_NAME,
      description: 'Declare progressive delivery before answering.',
      output: v.string(),
      run: () => ({ output: SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT }),
    });
    return 'Use the scripted response.';
  }
  const frame = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const provider = createCloudflareBindingProvider({ run: async () => {
    generations += 1;
    assert.ok(generations <= 3, 'one interrupted generation should need only one replacement');
    const headers = { 'content-type': 'text/event-stream' };
    if (generations === 1) {
      return new Response(frame({ tool_calls: [{ index: 0, id: 'call_stream_retry', type: 'function',
        function: { name: SLACK_STREAM_ANSWER_TOOL_NAME, arguments: '{}' } }] }, 'tool_calls') +
        'data: [DONE]\n\n', { headers });
    }
    if (generations === 2) {
      // Wait for real durable readback before truncating the provider stream.
      // This proves reset handling after text has reached Chickpea's relay.
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame({ content: partial })));
          void partialObserved.then(() => controller.close());
        },
      }), { headers });
    }
    return new Response(frame({ content: replacement }, 'stop') + 'data: [DONE]\n\n', { headers });
  } });
  const runtime = await start({ agents: [{ agent: RetryProbe, name: 'workers-ai-stream-retry' }], providers: [provider] });
  try {
    const agent = init(RetryProbe, { id: 'stream-retry' });
    const receipt = await agent.dispatch('Give the scripted answer.');
    const operations: string[] = [];
    const relay = new ReceiptScopedTextRelay({
      submissionId: receipt.submissionId,
      modelIntent: { initial: { status: 'unresolved' }, async transition() {} },
      async append(chunk) { operations.push(`append:${chunk.delta}`); },
      async invalidate(reason) { operations.push(`invalidate:${reason}`); },
    });
    const reply = await agent.read(receipt, { onEvent(chunk) {
      relay.onEvent(chunk);
      if (chunk.type === 'message-delta' && chunk.kind === 'text' && chunk.delta.includes(partial)) {
        observePartial();
      }
    } });
    const summary = await relay.closeAndDrain();
    assert.equal(reply.text, replacement);
    assert.equal(generations, 3);
    assert.ok(operations.includes(`append:${partial}`), 'the interrupted text reached the relay');
    assert.equal(summary.invalidationReason, 'conversation_reset');
    assert.equal(operations.filter((operation) => operation === 'invalidate:conversation_reset').length, 1);
    assert.equal(operations.some((operation) => operation === `append:${replacement}`), false,
      'replacement text must use terminal delivery after the incremental stream is invalidated');
    assert.equal((await agent.read(receipt)).text, replacement, 'receipt replay retains only the successful answer');
    assert.equal(generations, 3, 'replaying the receipt must not call the provider again');
  } finally { await runtime.stop(); }
});

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
    if (generations > 3) throw new Error('Unexpected additional continuity model call.');
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

test('a conversation with a failed post-tool finish accepts a new turn without rerunning its tool', { timeout: 15_000 }, async () => {
  let fixed = false;
  let calls = 0;
  let finishFailures = 0;
  let generations = 0;
  function LegacyProbe() {
    useModel('cloudflare/@cf/zai-org/glm-5.3-flash');
    useTool({ name: 'read_fixture', description: 'Read a fixture.', output: v.string(),
      run: () => { calls += 1; return { output: 'CEDAR' }; } });
    useAgentFinish(() => {
      if (!fixed) {
        finishFailures += 1;
        throw new Error('Synthetic post-tool finish failure.');
      }
    });
    return 'Read the fixture.';
  }
  LegacyProbe.durability = { maxAttempts: 1, timeoutMs: 10_000 };
  const binding = { run: async (_model: string, inputs: Record<string, unknown>) => {
    generations += 1;
    if (generations > 3) throw new Error('Unexpected additional recovery model call.');
    if (fixed) {
      const messages = JSON.stringify(inputs.messages);
      assert.match(messages, /RETAINED_REQUEST/);
      assert.match(messages, /CEDAR/);
    }
    const delta = generations === 1
      ? { tool_calls: [{ index: 0, id: 'call_legacy', type: 'function',
        function: { name: 'read_fixture', arguments: '{}' } }] }
      : { content: fixed ? 'Retained conversation resumed.' : 'The fixture was read.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  } };
  const provider = createCloudflareBindingProvider(binding);
  const runtime = await start({ agents: [{ agent: LegacyProbe, name: 'legacy-tool-continuity' }], providers: [provider] });
  try {
    const agent = init(LegacyProbe, { id: 'retained-tool-failure' });
    await assert.rejects(async () => agent.read(await agent.dispatch('RETAINED_REQUEST: read the fixture.')));
    assert.equal(finishFailures, 1, 'the scripted finish failure must cause the rejected submission');
    assert.equal(calls, 1, 'the original tool completed before the finish hook failed');
    fixed = true;
    const reply = await agent.read(await agent.dispatch('Continue this same conversation.'));
    assert.equal(reply.text, 'Retained conversation resumed.');
    assert.equal(calls, 1, 'the old tool must not run again');
    assert.equal(generations, 3);
  } finally { await runtime.stop(); }
});
