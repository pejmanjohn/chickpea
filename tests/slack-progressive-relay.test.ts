import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationStreamChunk } from '@flue/runtime';

import {
  ReceiptScopedTextRelay,
  type ProgressiveIntentTransition,
  type ProgressiveRelayInvalidationReason,
  type ProgressiveTextChunk,
} from '../src/slack/progressive-relay.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import type { SlackProgressiveIntent } from '../src/slack/run-presentations.ts';
import { decideProgressiveEligibility } from '../src/slack/progressive-eligibility.ts';
import { slackProgressiveStreamingEnabled } from '../src/slack/progressive-ops-flag.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';

function event(
  value: Record<string, unknown> & {
    type: ConversationStreamChunk['type'];
    position?: { batch: number; index: number };
  },
): ConversationStreamChunk {
  return {
    ...value,
    position: value.position ?? { batch: 1, index: 0 },
  } as ConversationStreamChunk;
}

function modelRelay(input: {
  initial?: SlackProgressiveIntent;
  failIntent?: ProgressiveIntentTransition['kind'];
  mode?: 'early' | 'final_answer';
} = {}) {
  const operations: string[] = [];
  const delivered: ProgressiveTextChunk[] = [];
  const relay = new ReceiptScopedTextRelay({
    submissionId: 'submission_model_intent',
    ...(input.mode ? { mode: input.mode } : {}),
    modelIntent: {
      initial: input.initial ?? { status: 'unresolved' },
      async transition(intent) {
        operations.push(`intent:${intent.kind}:${
          'toolCallId' in intent ? intent.toolCallId :
          intent.kind === 'denied' ? intent.reason : ''
        }`);
        if (intent.kind === input.failIntent) throw new Error('synthetic persistence failure');
      },
    },
    async append(chunk) {
      operations.push(`append:${chunk.delta}`);
      delivered.push(structuredClone(chunk));
    },
    async invalidate(reason) {
      operations.push(`invalidate:${reason}`);
    },
  });
  const emit = (value: Parameters<typeof event>[0]) => relay.onEvent(event(value));
  emit({
    type: 'message-started',
    conversationId: 'conversation_model_intent',
    messageId: 'message_model_intent',
    submissionId: 'submission_model_intent',
    position: { batch: 1, index: 0 },
  });
  return { relay, emit, operations, delivered };
}

function streamInput(position = { batch: 2, index: 0 }, toolCallId = 'stream_call_1') {
  return {
    type: 'tool-input' as const,
    conversationId: 'conversation_model_intent',
    messageId: 'message_model_intent',
    toolCallId,
    toolName: SLACK_STREAM_ANSWER_TOOL_NAME,
    input: {},
    position,
  };
}

function streamOutput(position = { batch: 3, index: 0 }, toolCallId = 'stream_call_1') {
  return {
    type: 'tool-output' as const,
    conversationId: 'conversation_model_intent',
    toolCallId,
    output: 'Delivery preference noted. Continue with the answer.',
    position,
  };
}

function answerDelta(delta: string, position: { batch: number; index: number }) {
  return {
    type: 'message-delta' as const,
    conversationId: 'conversation_model_intent',
    messageId: 'message_model_intent',
    kind: 'text' as const,
    delta,
    position,
  };
}

test('receipt-scoped relay serializes only exact assistant text and drains before close', async () => {
  const delivered: ProgressiveTextChunk[] = [];
  let active = 0;
  let maxActive = 0;
  const relay = new ReceiptScopedTextRelay({
    submissionId: 'submission_owned',
    async append(chunk) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, chunk.delta === 'Hello' ? 5 : 0));
      delivered.push(structuredClone(chunk));
      active -= 1;
    },
    async invalidate(reason) {
      assert.fail(`unexpected invalidation: ${reason}`);
    },
  });

  relay.onEvent(event({
    type: 'conversation-reset',
    conversationId: 'conversation_1',
    snapshot: { v: 1, conversationId: 'conversation_1', offset: '0', messages: [], settlements: [] },
    position: { batch: 0, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-started', conversationId: 'conversation_1', messageId: 'message_other',
    submissionId: 'submission_other', position: { batch: 1, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_1', messageId: 'message_other',
    kind: 'text', delta: 'private other root', position: { batch: 2, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-started', conversationId: 'conversation_1', messageId: 'message_owned',
    submissionId: 'submission_owned', position: { batch: 3, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_1', messageId: 'message_owned',
    kind: 'reasoning', delta: 'private reasoning', position: { batch: 4, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_1', messageId: 'message_owned',
    kind: 'text', delta: 'Hello', position: { batch: 5, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-metadata', conversationId: 'conversation_1', messageId: 'message_owned',
    metadata: { private: 'must not enter the relay' },
    position: { batch: 6, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_1', messageId: 'message_owned',
    kind: 'text', delta: ' world', position: { batch: 7, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-completed', conversationId: 'conversation_1', messageId: 'message_owned',
    position: { batch: 8, index: 0 },
  }));

  const summary = await relay.closeAndDrain();
  assert.equal(maxActive, 1);
  assert.deepEqual(delivered, [
    {
      messageId: 'message_owned',
      delta: 'Hello',
      position: { batch: 5, index: 0 },
    },
    {
      messageId: 'message_owned',
      delta: ' world',
      position: { batch: 7, index: 0 },
    },
  ]);
  assert.deepEqual(summary, {
    acceptedChunks: 2,
    acceptedBytes: 11,
    targetMessageCompleted: true,
    invalidated: false,
  });

  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_1', messageId: 'message_owned',
    kind: 'text', delta: ' late', position: { batch: 9, index: 0 },
  }));
  assert.equal(delivered.length, 2, 'late chunks no-op after the relay is closed');
});

test('model-selected relay persists successful intent before exact post-declaration text', async () => {
  const h = modelRelay();
  h.emit(streamInput());
  h.emit(streamOutput());
  h.emit(answerDelta('Hello', { batch: 4, index: 0 }));
  h.emit(answerDelta(' world', { batch: 5, index: 0 }));

  const summary = await h.relay.closeAndDrain();
  assert.deepEqual(h.operations, [
    'intent:candidate:stream_call_1',
    'intent:requested:stream_call_1',
    'append:Hello world',
  ]);
  assert.equal(summary.acceptedChunks, 2);
  assert.equal(summary.acceptedBytes, 11);
  assert.equal(h.delivered.map((chunk) => chunk.delta).join(''), 'Hello world');
});

test('no declaration accepts no progressive text and records not_requested', async () => {
  const h = modelRelay();
  h.emit(answerDelta('Short terminal answer.', { batch: 2, index: 0 }));

  const summary = await h.relay.closeAndDrain();
  assert.deepEqual(h.operations, ['intent:not_requested:']);
  assert.equal(summary.acceptedBytes, 0);
  assert.deepEqual(h.delivered, []);
});

test('late, repeated, failed, mixed-tool, and structured declarations fail closed', async () => {
  const cases: Array<{
    name: string;
    events: Array<Parameters<ReturnType<typeof modelRelay>['emit']>[0]>;
    reason: string;
  }> = [
    {
      name: 'late',
      events: [answerDelta('too early', { batch: 2, index: 0 }), streamInput({ batch: 3, index: 0 })],
      reason: 'late_declaration',
    },
    {
      name: 'repeated',
      events: [streamInput(), streamInput({ batch: 3, index: 0 }, 'stream_call_2')],
      reason: 'repeated_declaration',
    },
    {
      name: 'failed',
      events: [streamInput(), {
        type: 'tool-output-error', conversationId: 'conversation_model_intent',
        toolCallId: 'stream_call_1', errorText: 'private failure',
        position: { batch: 3, index: 0 },
      }],
      reason: 'declaration_failed',
    },
    {
      name: 'mixed',
      events: [streamInput(), {
        type: 'tool-input', conversationId: 'conversation_model_intent',
        messageId: 'message_model_intent', toolCallId: 'lookup_1', toolName: 'lookup', input: {},
        position: { batch: 3, index: 0 },
      }],
      reason: 'non_presentation_tool',
    },
    {
      name: 'structured',
      events: [{
        type: 'data-part', conversationId: 'conversation_model_intent',
        messageId: 'message_model_intent', name: 'result', data: { answer: 'private' },
        position: { batch: 2, index: 0 },
      }],
      reason: 'structured_output',
    },
  ];

  for (const scenario of cases) {
    const h = modelRelay();
    for (const candidate of scenario.events) h.emit(candidate);
    h.emit(answerDelta('must remain terminal', { batch: 9, index: 0 }));
    await h.relay.closeAndDrain();
    assert.ok(
      h.operations.some((operation) => operation === `intent:denied:${scenario.reason}`),
      scenario.name,
    );
    assert.deepEqual(h.delivered, [], scenario.name);
  }
});

function stepStarted(batch: number) {
  return {
    type: 'message-started' as const,
    conversationId: 'conversation_model_intent',
    messageId: 'message_model_intent',
    submissionId: 'submission_model_intent',
    position: { batch, index: 0 },
  };
}

function stepCompleted(batch: number) {
  return {
    type: 'message-completed' as const,
    conversationId: 'conversation_model_intent',
    messageId: 'message_model_intent',
    position: { batch, index: 0 },
  };
}

function effectInput(batch: number, toolCallId = 'lookup_1', index = 0) {
  return {
    type: 'tool-input' as const,
    conversationId: 'conversation_model_intent',
    messageId: 'message_model_intent',
    toolCallId,
    toolName: 'lookup',
    input: {},
    position: { batch, index },
  };
}

function effectOutcome(batch: number, toolCallId = 'lookup_1', failed = false) {
  return failed
    ? {
        type: 'tool-output-error' as const,
        conversationId: 'conversation_model_intent',
        toolCallId,
        errorText: 'private failure',
        position: { batch, index: 0 },
      }
    : {
        type: 'tool-output' as const,
        conversationId: 'conversation_model_intent',
        toolCallId,
        output: 'private lookup result',
        position: { batch, index: 0 },
      };
}

test('final-answer relay streams a declaration made after settled tool work', async () => {
  for (const failed of [false, true]) {
    const h = modelRelay({ mode: 'final_answer' });
    h.emit(effectInput(2));
    h.emit(stepCompleted(3));
    h.emit(effectOutcome(4, 'lookup_1', failed));
    h.emit(stepStarted(5));
    h.emit(streamInput({ batch: 6, index: 0 }));
    h.emit(stepCompleted(7));
    h.emit(streamOutput({ batch: 8, index: 0 }));
    h.emit(stepStarted(9));
    h.emit(answerDelta('Final ', { batch: 10, index: 0 }));
    h.emit(answerDelta('answer.', { batch: 11, index: 0 }));
    h.emit(stepCompleted(12));

    const summary = await h.relay.closeAndDrain();
    assert.deepEqual(h.operations, [
      'intent:candidate:stream_call_1',
      'intent:requested:stream_call_1',
      'append:Final answer.',
    ], `failed=${failed}`);
    assert.equal(summary.invalidated, false);
  }
});

test('final-answer relay ignores earlier-step narration but not same-step text', async () => {
  const earlier = modelRelay({ mode: 'final_answer' });
  earlier.emit(answerDelta('Let me look that up. ', { batch: 2, index: 0 }));
  earlier.emit(effectInput(3));
  earlier.emit(stepCompleted(4));
  earlier.emit(effectOutcome(5));
  earlier.emit(stepStarted(6));
  earlier.emit(streamInput({ batch: 7, index: 0 }));
  earlier.emit(streamOutput({ batch: 8, index: 0 }));
  earlier.emit(stepStarted(9));
  earlier.emit(answerDelta('Found it.', { batch: 10, index: 0 }));
  await earlier.relay.closeAndDrain();
  assert.deepEqual(earlier.operations, [
    'intent:candidate:stream_call_1',
    'intent:requested:stream_call_1',
    'append:Found it.',
  ]);

  const sameStep = modelRelay({ mode: 'final_answer' });
  sameStep.emit(effectInput(2));
  sameStep.emit(effectOutcome(3));
  sameStep.emit(stepStarted(4));
  sameStep.emit(answerDelta('Text before the declaration. ', { batch: 5, index: 0 }));
  sameStep.emit(streamInput({ batch: 6, index: 0 }));
  sameStep.emit(streamOutput({ batch: 7, index: 0 }));
  sameStep.emit(stepStarted(8));
  sameStep.emit(answerDelta('must remain terminal', { batch: 9, index: 0 }));
  await sameStep.relay.closeAndDrain();
  assert.deepEqual(sameStep.operations, ['intent:denied:late_declaration']);
  assert.deepEqual(sameStep.delivered, []);
});

test('final-answer declarations beside or ahead of unsettled tools fail closed', async () => {
  const cases: Array<{
    name: string;
    events: Array<Parameters<ReturnType<typeof modelRelay>['emit']>[0]>;
    reason: string;
  }> = [
    {
      name: 'sibling before',
      events: [effectInput(2), streamInput({ batch: 3, index: 0 })],
      reason: 'concurrent_tool',
    },
    {
      name: 'sibling after',
      events: [streamInput({ batch: 2, index: 0 }), effectInput(3)],
      reason: 'concurrent_tool',
    },
    {
      name: 'unsettled earlier call',
      events: [effectInput(2), stepStarted(3), streamInput({ batch: 4, index: 0 })],
      reason: 'concurrent_tool',
    },
    {
      name: 'sibling after an acknowledged declaration',
      events: [
        streamInput({ batch: 2, index: 0 }),
        streamOutput({ batch: 3, index: 0 }),
        effectInput(4),
      ],
      reason: 'concurrent_tool',
    },
    {
      name: 'structured output before the declaration',
      events: [{
        type: 'data-part', conversationId: 'conversation_model_intent',
        messageId: 'message_model_intent', name: 'slackMemoryUpdate', data: {},
        position: { batch: 2, index: 0 },
      }, stepStarted(3), streamInput({ batch: 4, index: 0 })],
      reason: 'structured_output',
    },
    {
      name: 'failed declaration',
      events: [streamInput({ batch: 2, index: 0 }), {
        type: 'tool-output-error', conversationId: 'conversation_model_intent',
        toolCallId: 'stream_call_1', errorText: 'unavailable',
        position: { batch: 3, index: 0 },
      }],
      reason: 'declaration_failed',
    },
  ];
  for (const scenario of cases) {
    const h = modelRelay({ mode: 'final_answer' });
    for (const candidate of scenario.events) h.emit(candidate);
    h.emit(stepStarted(20));
    h.emit(answerDelta('must remain terminal', { batch: 21, index: 0 }));
    await h.relay.closeAndDrain();
    assert.ok(
      h.operations.includes(`intent:denied:${scenario.reason}`),
      `${scenario.name}: ${h.operations.join(', ')}`,
    );
    assert.deepEqual(h.delivered, [], scenario.name);
  }
});

test('a refused tool after a final-answer declaration keeps the stream only while nothing is relayed', async () => {
  // Declared, then a refused tool with no text yet: the next step streams.
  const quiet = modelRelay({ mode: 'final_answer' });
  quiet.emit(streamInput({ batch: 2, index: 0 }));
  quiet.emit(streamOutput({ batch: 3, index: 0 }));
  quiet.emit(stepStarted(4));
  quiet.emit(effectInput(5, 'refused_1'));
  quiet.emit(effectOutcome(6, 'refused_1', true));
  quiet.emit(stepStarted(7));
  quiet.emit(answerDelta('Answer from gathered facts.', { batch: 8, index: 0 }));
  const quietSummary = await quiet.relay.closeAndDrain();
  assert.deepEqual(quiet.operations, [
    'intent:candidate:stream_call_1',
    'intent:requested:stream_call_1',
    'append:Answer from gathered facts.',
  ]);
  assert.equal(quietSummary.invalidated, false);

  // Text in the refused tool's own step is not the final step's text.
  const sameStep = modelRelay({ mode: 'final_answer' });
  sameStep.emit(streamInput({ batch: 2, index: 0 }));
  sameStep.emit(streamOutput({ batch: 3, index: 0 }));
  sameStep.emit(stepStarted(4));
  sameStep.emit(effectInput(5, 'refused_1'));
  sameStep.emit(answerDelta('narration', { batch: 6, index: 0 }));
  await sameStep.relay.closeAndDrain();
  assert.deepEqual(sameStep.delivered, []);
  assert.ok(sameStep.operations.includes('intent:denied:non_presentation_tool'));

  // Relayed text followed by a refused tool cannot be reconciled: correct it.
  const relayed = modelRelay({ mode: 'final_answer' });
  relayed.emit(streamInput({ batch: 2, index: 0 }));
  relayed.emit(streamOutput({ batch: 3, index: 0 }));
  relayed.emit(stepStarted(4));
  relayed.emit(answerDelta('Streamed prefix. ', { batch: 5, index: 0 }));
  relayed.emit(effectInput(6, 'refused_1'));
  const relayedSummary = await relayed.relay.closeAndDrain();
  assert.deepEqual(relayed.operations, [
    'intent:candidate:stream_call_1',
    'intent:requested:stream_call_1',
    'append:Streamed prefix. ',
    'intent:denied:non_presentation_tool',
    'invalidate:tool_activity',
  ]);
  assert.equal(relayedSummary.invalidationReason, 'tool_activity');
});

test('early mode still denies any tool before the declaration', async () => {
  const h = modelRelay();
  h.emit(effectInput(2));
  h.emit(effectOutcome(3));
  h.emit(stepStarted(4));
  h.emit(streamInput({ batch: 5, index: 0 }));
  h.emit(answerDelta('must remain terminal', { batch: 6, index: 0 }));
  await h.relay.closeAndDrain();
  assert.deepEqual(h.operations, ['intent:denied:non_presentation_tool']);
  assert.deepEqual(h.delivered, []);
});

test('foreign tool outcomes cannot deny a valid pending declaration', async () => {
  const h = modelRelay();
  h.emit(streamInput());
  h.emit(streamOutput({ batch: 3, index: 0 }, 'foreign_tool_call'));
  h.emit(streamOutput({ batch: 4, index: 0 }));
  h.emit(answerDelta('safe answer', { batch: 5, index: 0 }));

  await h.relay.closeAndDrain();
  assert.deepEqual(h.operations, [
    'intent:candidate:stream_call_1',
    'intent:requested:stream_call_1',
    'append:safe answer',
  ]);
});

test('requested-intent persistence failure accepts no text and enters recovery invalidation', async () => {
  const h = modelRelay({ failIntent: 'requested' });
  h.emit(streamInput());
  h.emit(streamOutput());
  h.emit(answerDelta('must not escape', { batch: 4, index: 0 }));

  const summary = await h.relay.closeAndDrain();
  assert.deepEqual(h.operations, [
    'intent:candidate:stream_call_1',
    'intent:requested:stream_call_1',
    'invalidate:intent_persistence_failed',
  ]);
  assert.deepEqual(h.delivered, []);
  assert.equal(summary.invalidationReason, 'intent_persistence_failed');
});

test('receipt replay reuses persisted requested intent without repeating its transition', async () => {
  const h = modelRelay({
    initial: {
      status: 'requested',
      toolCallId: 'stream_call_1',
      requestedAt: 1_800_000_000_000,
    },
  });
  h.emit(streamInput());
  h.emit(streamOutput());
  h.emit(answerDelta('replayed answer', { batch: 4, index: 0 }));

  await h.relay.closeAndDrain();
  assert.deepEqual(h.operations, ['append:replayed answer']);
});

test('joined submissions and replayed positions cannot cross the receipt fence', async () => {
  const delivered: ProgressiveTextChunk[] = [];
  const relay = new ReceiptScopedTextRelay({
    submissionId: 'submission_joined',
    async append(chunk) { delivered.push(structuredClone(chunk)); },
    async invalidate() {},
  });
  const hostStart = event({
    type: 'message-started', conversationId: 'conversation_2', messageId: 'message_host',
    submissionId: 'submission_host', position: { batch: 1, index: 0 },
  });
  const hostText = event({
    type: 'message-delta', conversationId: 'conversation_2', messageId: 'message_host',
    kind: 'text', delta: 'host answer', position: { batch: 2, index: 0 },
  });
  relay.onEvent(hostStart);
  relay.onEvent(hostText);
  relay.onEvent(hostStart);
  relay.onEvent(hostText);
  assert.deepEqual(delivered, []);
  assert.equal((await relay.closeAndDrain()).acceptedChunks, 0);
});

test('tool activity closes the text path before later intermediate output', async () => {
  const operations: string[] = [];
  const relay = new ReceiptScopedTextRelay({
    submissionId: 'submission_tool',
    async append(chunk) { operations.push(`append:${chunk.delta}`); },
    async invalidate(reason) { operations.push(`invalidate:${reason}`); },
  });
  relay.onEvent(event({
    type: 'message-started', conversationId: 'conversation_tool', messageId: 'message_tool',
    submissionId: 'submission_tool', position: { batch: 1, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_tool', messageId: 'message_tool',
    kind: 'text', delta: 'safe prefix', position: { batch: 2, index: 0 },
  }));
  relay.onEvent(event({
    type: 'tool-input', conversationId: 'conversation_tool', messageId: 'message_tool',
    toolCallId: 'tool_1', toolName: 'lookup', input: { secret: true },
    position: { batch: 3, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_tool', messageId: 'message_tool',
    kind: 'text', delta: 'unsafe later output', position: { batch: 4, index: 0 },
  }));

  const summary = await relay.closeAndDrain();
  assert.deepEqual(operations, ['append:safe prefix', 'invalidate:tool_activity']);
  assert.equal(summary.invalidationReason, 'tool_activity');
});

test('a reset after accepted text invalidates in-order and blocks later chunks', async () => {
  const operations: string[] = [];
  const relay = new ReceiptScopedTextRelay({
    submissionId: 'submission_reset',
    async append(chunk) { operations.push(`append:${chunk.delta}`); },
    async invalidate(reason) { operations.push(`invalidate:${reason}`); },
  });
  relay.onEvent(event({
    type: 'message-started', conversationId: 'conversation_3', messageId: 'message_reset',
    submissionId: 'submission_reset', position: { batch: 1, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_3', messageId: 'message_reset',
    kind: 'text', delta: 'prefix', position: { batch: 2, index: 0 },
  }));
  relay.onEvent(event({
    type: 'conversation-reset', conversationId: 'conversation_3',
    snapshot: { v: 1, conversationId: 'conversation_3', offset: '9', messages: [], settlements: [] },
    position: { batch: 3, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_3', messageId: 'message_reset',
    kind: 'text', delta: 'must not escape', position: { batch: 4, index: 0 },
  }));

  const summary = await relay.closeAndDrain();
  assert.deepEqual(operations, ['append:prefix', 'invalidate:conversation_reset']);
  assert.equal(summary.invalidated, true);
  assert.equal(summary.invalidationReason, 'conversation_reset');
});

test('sink failure becomes one bounded invalidation and closes the content queue', async () => {
  const invalidations: ProgressiveRelayInvalidationReason[] = [];
  const relay = new ReceiptScopedTextRelay({
    submissionId: 'submission_failure',
    async append() { throw new Error('private downstream detail'); },
    async invalidate(reason) { invalidations.push(reason); },
  });
  relay.onEvent(event({
    type: 'message-started', conversationId: 'conversation_4', messageId: 'message_failure',
    submissionId: 'submission_failure', position: { batch: 1, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_4', messageId: 'message_failure',
    kind: 'text', delta: 'first', position: { batch: 2, index: 0 },
  }));
  relay.onEvent(event({
    type: 'message-delta', conversationId: 'conversation_4', messageId: 'message_failure',
    kind: 'text', delta: 'second', position: { batch: 3, index: 0 },
  }));

  const summary = await relay.closeAndDrain();
  assert.deepEqual(invalidations, ['sink_failed']);
  assert.equal(summary.invalidated, true);
  assert.equal(summary.acceptedChunks, 0);
});

test('progressive eligibility closes replacement paths and holds effect-capable plans to a final answer', () => {
  const basePlan = {
    schemaVersion: 2,
    continuityPolicy: 'slack-runtime-v2',
    agentId: 'agent_default',
    conversation: {
      workspaceId: 'T1', channelId: 'D1', threadTs: '1.0',
      surface: 'direct_message', continuityKey: 'agent_continuity',
    },
    model: 'local-stub/x',
    instructions: 'Help.',
    memoryEpoch: 1,
    skills: [],
    mcpConnections: [],
    apiConnections: [],
    repositories: [],
    sandbox: { mode: 'bash' },
    artifactDestination: { kind: 'slack_conversation', channelId: 'D1' },
    harnessRevision: 'a'.repeat(64),
  } satisfies RuntimePlanV2;
  const decide = (overrides: Partial<Parameters<typeof decideProgressiveEligibility>[0]> = {}) =>
    decideProgressiveEligibility({
      runtimePlan: basePlan,
      operationsEnabled: true,
      memorySelected: false,
      recoveryRequired: false,
      concurrentAttributionProven: true,
      replacementCapable: false,
      ...overrides,
    });

  assert.deepEqual(decide(), { allowed: true, reason: 'safe_early_release' });
  assert.deepEqual(decide({ operationsEnabled: false }), {
    allowed: false, reason: 'operations_disabled',
  });
  assert.deepEqual(decide({ memorySelected: true }), { allowed: false, reason: 'memory' });
  assert.deepEqual(decide({ recoveryRequired: true }), {
    allowed: false, reason: 'recovery',
  });
  assert.deepEqual(decide({ concurrentAttributionProven: false }), {
    allowed: false, reason: 'concurrent_join',
  });
  assert.deepEqual(decide({ replacementCapable: true }), {
    allowed: false, reason: 'other',
  });
  assert.deepEqual(decideProgressiveEligibility({
    operationsEnabled: true,
    memorySelected: false,
    recoveryRequired: false,
    concurrentAttributionProven: true,
    replacementCapable: false,
  }), { allowed: false, reason: 'other' });
  // A Cloudflare sandbox is only selected with repository grants, which make
  // it effect-capable. On the Worker replacement-capable decides first, so
  // container Agents stay terminal-only.
  assert.deepEqual(decide({
    runtimePlan: {
      ...basePlan,
      repositories: [{ id: 'repo_1', fullName: 'acme/example' }],
      sandbox: { mode: 'cloudflare' },
    },
  }), { allowed: true, reason: 'final_answer_release' });
  assert.deepEqual(decide({
    runtimePlan: {
      ...basePlan,
      repositories: [{ id: 'repo_1', fullName: 'acme/example' }],
      sandbox: { mode: 'cloudflare' },
    },
    replacementCapable: true,
  }), { allowed: false, reason: 'other' });
  // Effect-capable plans may stream only a declared final answer.
  for (const runtimePlan of [
    { ...basePlan, mcpConnections: [{
      id: 'mcp_1', url: 'https://mcp.example.test', transport: 'streamable-http' as const,
      authMode: 'none' as const, headerNames: [], allowedTools: ['lookup'], optional: true,
    }] },
    { ...basePlan, apiConnections: [{
      id: 'api_1', allowedHosts: ['api.example.test'], pathPrefixes: ['/v1'],
      allowedMethods: ['GET'], headerName: 'Authorization', authMode: 'credential' as const,
    }] },
    { ...basePlan, repositories: [{ id: 'repo_1', fullName: 'acme/example' }] },
  ]) {
    assert.deepEqual(decide({ runtimePlan }), { allowed: true, reason: 'final_answer_release' });
    // Every earlier rule still wins over the final-answer release.
    assert.deepEqual(decide({ runtimePlan, operationsEnabled: false }), {
      allowed: false, reason: 'operations_disabled',
    });
    assert.deepEqual(decide({ runtimePlan, recoveryRequired: true }), {
      allowed: false, reason: 'recovery',
    });
    assert.deepEqual(decide({ runtimePlan, memorySelected: true }), {
      allowed: false, reason: 'memory',
    });
    assert.deepEqual(decide({ runtimePlan, replacementCapable: true }), {
      allowed: false, reason: 'other',
    });
    assert.deepEqual(decide({ runtimePlan, concurrentAttributionProven: false }), {
      allowed: false, reason: 'concurrent_join',
    });
  }
});

test('the deployment-only progressive gate defaults on and recognizes explicit false values', () => {
  assert.equal(slackProgressiveStreamingEnabled(undefined, {}), true);
  for (const raw of ['false', 'FALSE', ' 0 ', 'off', 'NO']) {
    assert.equal(
      slackProgressiveStreamingEnabled(undefined, { SLACK_TAG_PROGRESSIVE_STREAMING: raw }),
      false,
      raw,
    );
  }
  for (const raw of ['', 'true', '1', 'on', 'yes', 'unexpected']) {
    assert.equal(
      slackProgressiveStreamingEnabled(undefined, { SLACK_TAG_PROGRESSIVE_STREAMING: raw }),
      true,
      raw,
    );
  }
  assert.equal(
    slackProgressiveStreamingEnabled(
      { SLACK_TAG_PROGRESSIVE_STREAMING: 'off' },
      { SLACK_TAG_PROGRESSIVE_STREAMING: 'true' },
    ),
    false,
  );
});
