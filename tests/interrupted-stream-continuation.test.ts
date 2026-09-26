import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AssistantMessage, Context, Model, Provider } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';

import {
  CONTINUATION_INSTRUCTION,
  inspectInterruptedStreamPartials,
  registerPiProvider,
  registeredPiProvider,
  restoreInterruptedStreamPartials,
} from '../src/config/pi-provider-registry.ts';
import { joinContinuation } from '../src/slack/flue-dispatch.ts';

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

/** Flue renders a signal into model context as user text (dispatch renderSignalMessage). */
function signal(type: string, content: string, timestamp: number): Context['messages'][number] {
  return { role: 'user', content: [{ type: 'text', text: `<signal type="${type}">\n${content}\n</signal>` }], timestamp };
}

/** What Flue hands the provider after a code update interrupted the stream. */
function recoveredContext(partial: AssistantMessage): Context {
  return {
    systemPrompt: 'system',
    messages: [
      { role: 'user', content: 'Write the migration plan.', timestamp: 1 },
      partial,
      signal('stream_interrupted', 'The previous assistant stream was interrupted.', 2),
      signal('stream_continued', 'Continue from the durable partial assistant response.', 3),
    ],
  };
}

const PARTIAL = assistant({
  stopReason: 'aborted',
  errorMessage: 'Stream interrupted before completion.',
  content: [
    { type: 'thinking', thinking: 'plan it', thinkingSignature: '{"id":"rs_1"}' },
    { type: 'text', text: '## Plan\n\n1. Inventory the col', textSignature: '{"v":1,"id":"msg_1","phase":"final_answer"}' },
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
  assert.deepEqual(partial.content, [{ type: 'text', text: '## Plan\n\n1. Inventory the col',
    textSignature: '{"v":1,"id":"","phase":"final_answer"}' }],
    'text only: no reasoning without its item, no id of an incomplete item, the phase kept');
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

test('an aborted step without Flue\'s two recovery signals right after it is left alone', () => {
  const [prompt, partial, interrupted, continued] = recoveredContext(PARTIAL).messages;
  for (const messages of [
    [prompt!, partial!],
    [prompt!, partial!, interrupted!],
    [prompt!, partial!, continued!, interrupted!],
    [prompt!, partial!, { role: 'user' as const, content: 'The previous assistant stream was interrupted.', timestamp: 2 }, continued!],
  ]) {
    const context = { systemPrompt: 'system', messages };
    assert.equal(restoreInterruptedStreamPartials(context), context);
  }
});

test('the restored partial reaches the real OpenAI Responses and chat-completions payloads', async () => {
  const { convertResponsesMessages } = await import('@earendil-works/pi-ai/api/openai-responses-shared');
  const responses = convertResponsesMessages(model, restoreInterruptedStreamPartials(recoveredContext(PARTIAL)),
    new Set(['openai'])) as unknown as Array<Record<string, unknown>>;
  const assistantItems = responses.filter((item) => item.role === 'assistant' || item.type === 'reasoning');
  assert.equal(assistantItems.length, 1, 'one message item and no orphaned reasoning item');
  const item = assistantItems[0]!;
  assert.equal(item.type, 'message');
  assert.match(String(item.id), /^msg_pi_/, 'a local id, never the incomplete provider item');
  assert.equal(item.phase, 'final_answer');
  assert.deepEqual(item.content, [{ type: 'output_text', text: '## Plan\n\n1. Inventory the col', annotations: [] }]);
  assert.equal(convertResponsesMessages(model, recoveredContext(PARTIAL), new Set(['openai']))
    .filter((entry) => (entry as { role?: string }).role === 'assistant').length, 0, 'unrepaired: dropped');

  const { convertMessages } = await import('@earendil-works/pi-ai/api/openai-completions');
  const completionsModel = { ...model, api: 'openai-completions', provider: 'cloudflare', id: 'gpt-test' } as unknown as Model<'openai-completions'>;
  const partial = { ...PARTIAL, api: 'openai-completions', provider: 'cloudflare' } as AssistantMessage;
  const chat = convertMessages(completionsModel, restoreInterruptedStreamPartials(recoveredContext(partial)),
    {} as never) as unknown as Array<{ role: string; content: unknown }>;
  const assistantTurns = chat.filter((message) => message.role === 'assistant');
  assert.equal(assistantTurns.length, 1);
  assert.match(JSON.stringify(assistantTurns[0]!.content), /Inventory the col/);
  assert.doesNotMatch(JSON.stringify(chat), /plan it/, 'no reasoning replayed');
});

test('Flue renders both recovery signals the same way for every provider; the shape carries no provider marks', () => {
  // dispatch renderSignalMessage: `<signal type="...">\n<content>\n</signal>` as user text, whatever
  // the model. Flue materializes the in-flight text block without a signature (the item never
  // completed), so a Responses partial carries no phase and no reasoning item the gate could trip on.
  const flueResponsesPartial = assistant({ stopReason: 'aborted', errorMessage: 'Stream interrupted before completion.',
    content: [
      { type: 'thinking', thinking: 'plan', thinkingSignature: undefined as never },
      { type: 'text', text: '## Plan\n\nPartial', textSignature: undefined as never },
    ] });
  const flueAnthropicPartial = { ...flueResponsesPartial, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-test' } as AssistantMessage;
  for (const partial of [flueResponsesPartial, flueAnthropicPartial]) {
    const { report, context } = inspectInterruptedStreamPartials(recoveredContext(partial));
    assert.deepEqual(report, { restored: true, messages: 4, assistantMessages: 1, abortedMessages: 1, userSignals: 2 });
    assert.deepEqual((context.messages[1] as AssistantMessage).content, [{ type: 'text', text: '## Plan\n\nPartial' }]);
  }
});

test('the report names why a recovery-shaped request did not restore its partial, and ordinary requests report nothing', () => {
  const [prompt, , interrupted, continued] = recoveredContext(PARTIAL).messages;
  const reasonFor = (messages: Context['messages']) =>
    inspectInterruptedStreamPartials({ systemPrompt: 's', messages }).report?.reason;
  assert.equal(inspectInterruptedStreamPartials({ systemPrompt: 's', messages: [prompt!] }).report, undefined);
  assert.equal(reasonFor([prompt!, PARTIAL]), 'signals_missing');
  assert.equal(reasonFor([prompt!, PARTIAL, continued!, interrupted!]), 'signals_out_of_order');
  assert.equal(reasonFor([prompt!, PARTIAL, interrupted!, interrupted!]), 'signals_out_of_order');
  assert.equal(reasonFor([prompt!, interrupted!, continued!]), 'no_aborted_step');
  assert.equal(reasonFor([prompt!, assistant({ content: [{ type: 'text', text: 'done' }] }), interrupted!, continued!]), 'gate_mismatch');
  assert.equal(reasonFor([prompt!, assistant({ stopReason: 'aborted', content: [
    { type: 'text', text: 'Checking' }, { type: 'toolCall', id: 'call_1', name: 'read', arguments: {} }] }), interrupted!, continued!]),
  'contains_tool_call');
  assert.equal(reasonFor([prompt!, assistant({ stopReason: 'aborted', content: [{ type: 'thinking', thinking: 'hmm' }] }),
    interrupted!, continued!]), 'no_text');
});

test('a restored partial carries the continuation instruction on the request copy of the last signal only', () => {
  const context = recoveredContext(PARTIAL);
  const sent = restoreInterruptedStreamPartials(context);
  const last = sent.messages.at(-1) as { content: Array<{ type: string; text: string }> };
  assert.equal(last.content.at(-1)!.text, CONTINUATION_INSTRUCTION);
  assert.equal((context.messages.at(-1) as { content: unknown[] }).content.length, 1, 'Flue\'s record is unchanged');
  // A later request in the same turn (after a tool call) is not re-instructed.
  const later = { ...context, messages: [...context.messages,
    assistant({ content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }] }),
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 4 },
  ] } as Context;
  const laterSent = restoreInterruptedStreamPartials(later);
  assert.equal((laterSent.messages[3] as { content: unknown[] }).content.length, 1);
});

/** Build the real registered provider for an API and capture the request payload it would send. */
async function sentPayload(
  register: () => void, providerId: string, pick: (model: Model<string>) => boolean,
): Promise<{ payload: string; logs: unknown[] }> {
  register();
  const provider = registeredPiProvider(providerId)!;
  const model = provider.getModels().find(pick)!;
  assert.ok(model, `a ${providerId} model`);
  const partial = assistant({ api: model.api, provider: model.provider, model: model.id, stopReason: 'aborted',
    errorMessage: 'Stream interrupted before completion.', content: [
      { type: 'thinking', thinking: 'REASONING', thinkingSignature: undefined as never },
      { type: 'text', text: '## Plan\n\nPARTIAL ANSWER TEXT', textSignature: undefined as never }] });
  const logs: unknown[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => { if (args[0] === '[chickpea] partial restore') logs.push(args[1]); };
  let payload: unknown;
  try {
    const stream = provider.streamSimple(model, recoveredContext(partial), {
      apiKey: 'test-key', reasoning: 'medium',
      onPayload: (body: unknown) => { payload = body; throw new Error('captured'); },
    } as never);
    for await (const _event of stream) { /* the captured payload ends the stream */ }
  } finally {
    console.info = info;
  }
  assert.ok(payload, 'the request was built');
  return { payload: JSON.stringify(payload), logs };
}

test('the restored partial and instruction reach the real OpenAI Responses, Anthropic, and chat-completions requests', async () => {
  const { setBuiltinPiProvider, setLocalStubPiProvider } = await import('../src/config/pi-provider.ts');
  const cases = [
    { api: 'openai-responses', id: 'openai', register: () => setBuiltinPiProvider('openai', { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9' }),
      pick: (m: Model<string>) => m.api === 'openai-responses' && m.reasoning },
    { api: 'anthropic-messages', id: 'anthropic', register: () => setBuiltinPiProvider('anthropic', { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9' }),
      pick: (m: Model<string>) => m.api === 'anthropic-messages' && m.reasoning },
    { api: 'openai-completions', id: 'local-stub', register: () => setLocalStubPiProvider({ baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', modelIds: ['stub-model'] }),
      pick: () => true },
  ];
  for (const { api, id, register, pick } of cases) {
    const { payload, logs } = await sentPayload(register, id, pick);
    assert.match(payload, /PARTIAL ANSWER TEXT/, `${api}: the partial is in the request`);
    assert.doesNotMatch(payload, /REASONING/, `${api}: no orphaned reasoning`);
    assert.ok(payload.includes(JSON.stringify(CONTINUATION_INSTRUCTION).slice(1, -1)), `${api}: the instruction is in the request`);
    assert.ok(payload.indexOf('PARTIAL ANSWER TEXT') < payload.indexOf('stream_interrupted'), `${api}: partial before the signals`);
    assert.deepEqual(logs, [{ provider: id, api, restored: true, messages: 4, assistantMessages: 1, abortedMessages: 1, userSignals: 2 }]);
    assert.doesNotMatch(JSON.stringify(logs), /PARTIAL|Plan/, 'the log carries no content');
  }
});

test('overlap trimming: repeated last words, re-opened sections, and no false trims', () => {
  const partial = 'Intro paragraph that sets the scene for the reader.\n\n## 3. Water\n\nWater early in the day, before the heat. Keep a log of volunteer';
  // Repeated tail without a heading.
  assert.deepEqual(joinContinuation(partial, 'before the heat. Keep a log of volunteer hours.'),
    { text: `${partial} hours.`, trimmedChars: 'before the heat. Keep a log of volunteer'.length });
  // Whitespace differences do not hide the repeat.
  assert.equal(joinContinuation(partial, 'the  heat.\nKeep a log  of volunteer hours.').text, `${partial} hours.`);
  // Re-opened heading with the section rewritten in other words: the rewrite, once.
  const rewrite = '## 3. Water\n\nMorning watering keeps roots cool.';
  assert.equal(joinContinuation(partial, rewrite).text,
    'Intro paragraph that sets the scene for the reader.\n\n## 3. Water\n\nMorning watering keeps roots cool.');
  // A partial that stopped right after the heading: drop the repeated heading only.
  const headed = 'Intro paragraph that sets the scene for the reader.\n\n## 3. Water\n';
  assert.deepEqual(joinContinuation(headed, '## 3. Water\nWater early.'), { text: `${headed}Water early.`, trimmedChars: '## 3. Water\n'.length });
  // Legitimate continuations are untouched.
  for (const continuation of [
    ' hours and tasks.',
    's and their tasks.',
    'volunteer hours.', // a short overlap proves nothing
    ' hours.\n\n## 4. Harvest\n\nWater early in the day, before the heat. Keep a log of volunteer hours again.',
    ' hours. As in 3. Water, keep it short.',
  ]) {
    assert.deepEqual(joinContinuation(partial, continuation), { text: partial + continuation, trimmedChars: 0 }, continuation);
  }
  // A heading repeated far from the continuation's start is not a re-open.
  const far = `${' hours.'.padEnd(500, ' filler')}\n## 3. Water\n`;
  assert.equal(joinContinuation(partial, far).trimmedChars, 0);
  // A short answer is always continued.
  assert.deepEqual(joinContinuation('## Pl', '## Plan'), { text: '## Pl## Plan', trimmedChars: 0 });
});
