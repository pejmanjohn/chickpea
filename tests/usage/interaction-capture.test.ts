import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InteractionUsageRecorder, interactionReportedUsage } from '../../src/usage/runtime-recorder.ts';
import { SqliteUsageStore } from '../../src/usage/store.ts';

test('interaction classifier usage is assignment-scoped and content-free', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const recorder = new InteractionUsageRecorder({
      operationId: 'classification_T_TEST_C_TEST_Ev1',
      executionId: 'classification_exec_Ev1',
      startedAt: 1,
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      channelLabel: 'bot-test',
      agentId: 'agent_default',
      agentLabel: 'Default',
      requestedModel: 'openai/gpt-5.2',
      requesterMembershipId: 'membership_test',
      executionPrincipalId: 'agent_default',
      modelAttribution: { source: 'pinned', providerId: 'openai' },
      credentialRefId: null,
      credentialVersion: null,
      store,
      now: () => 2,
    });
    await recorder.admit();
    await recorder.recordTerminal({
      status: 'completed',
      returnedModel: { provider: 'openai', id: 'gpt-5.2' },
      usage: {
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
        totalTokens: 34,
      },
    });
    const detail = await store.getOperation('classification_T_TEST_C_TEST_Ev1');
    assert.equal(detail?.operation.operationKind, 'interaction_classification');
    assert.equal(detail?.operation.runId, undefined);
    assert.equal(detail?.operation.channelId, 'C_TEST');
    assert.equal(detail?.operation.requesterMembershipId, 'membership_test');
    assert.equal(detail?.operation.executionPrincipalId, 'agent_default');
    assert.equal(detail?.operation.modelSource, 'pinned');
    assert.equal(detail?.operation.workspaceDefaultRevision, null);
    assert.equal(detail?.measurements[0]?.cacheReadTokens, 8);
    assert.equal(detail?.measurements[0]?.cacheWriteTokens, 2);
    assert.equal(detail?.measurements[0]?.totalTokens, 34);
    assert.equal(JSON.stringify(detail).includes('message body'), false);
  } finally {
    store.close();
  }
});

test('classifier usage needs every count, and keeps one-hour cache writes', async () => {
  const reported = {
    inputTokens: 20,
    outputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: 2,
    totalTokens: 34,
  };
  assert.equal(interactionReportedUsage(undefined), null);
  for (const missing of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    assert.equal(interactionReportedUsage({ ...reported, [missing]: null }), null, missing);
  }
  assert.deepEqual(
    interactionReportedUsage({ ...reported, cacheReadTokens: null, cacheWriteTokens: null }),
    { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 34 },
  );
  assert.deepEqual(interactionReportedUsage(reported), reported);
  const long = interactionReportedUsage({ ...reported, cacheWrite1hTokens: 2 });
  assert.equal(long?.cacheWrite1hTokens, 2);

  const store = new SqliteUsageStore(':memory:');
  try {
    const at = Date.UTC(2026, 9, 5, 6);
    for (const [suffix, usage] of [['short', reported], ['long', long]] as const) {
      const recorder = new InteractionUsageRecorder({
        operationId: `classification_${suffix}`,
        executionId: `classification_exec_${suffix}`,
        startedAt: at,
        workspaceId: 'T_TEST',
        channelId: 'C_TEST',
        agentId: 'agent_default',
        agentLabel: 'Default',
        requestedModel: 'anthropic/claude-haiku-4-5',
        credentialRefId: null,
        credentialVersion: null,
        store,
        now: () => at + 1_000,
      });
      await recorder.admit();
      await recorder.recordTerminal({
        status: 'completed',
        returnedModel: { provider: 'anthropic', id: 'claude-haiku-4-5' },
        usage,
      });
    }
    const estimate = async (suffix: string) =>
      (await store.getOperation(`classification_${suffix}`))?.measurements[0]?.estimateCompleteness;
    assert.equal(await estimate('short'), 'complete');
    assert.equal(await estimate('long'), 'partial');
  } finally {
    store.close();
  }
});
