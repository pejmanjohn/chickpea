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
} = {}) {
  const operations: string[] = [];
  const delivered: ProgressiveTextChunk[] = [];
  const relay = new ReceiptScopedTextRelay({
    submissionId: 'submission_model_intent',
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

test('progressive eligibility closes every replacement and external-effect path', () => {
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
  assert.deepEqual(decide({
    runtimePlan: { ...basePlan, sandbox: { mode: 'cloudflare' } },
  }), { allowed: false, reason: 'sandbox' });
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
    assert.deepEqual(decide({ runtimePlan }), { allowed: false, reason: 'effect_capable' });
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
