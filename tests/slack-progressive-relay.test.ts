import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationStreamChunk } from '@flue/runtime';

import {
  ReceiptScopedTextRelay,
  type ProgressiveRelayInvalidationReason,
  type ProgressiveTextChunk,
} from '../src/slack/progressive-relay.ts';
import { decideProgressiveEligibility } from '../src/slack/progressive-eligibility.ts';
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
      memorySelected: false,
      recoveryRequired: false,
      concurrentAttributionProven: true,
      replacementCapable: false,
      ...overrides,
    });

  assert.deepEqual(decide(), { allowed: true, reason: 'safe_early_release' });
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
