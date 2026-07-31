import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InteractionUsageRecorder } from '../../src/usage/runtime-recorder.ts';
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
      profileId: 'agent_default',
      profileLabel: 'Default',
      requestedModel: 'openai/gpt-5.2',
      credentialRefId: null,
      credentialVersion: null,
      store,
      now: () => 2,
    });
    await recorder.admit();
    await recorder.recordTerminal({
      status: 'completed',
      returnedModel: { provider: 'openai', id: 'gpt-5.2' },
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
    });
    const detail = await store.getOperation('classification_T_TEST_C_TEST_Ev1');
    assert.equal(detail?.operation.operationKind, 'interaction_classification');
    assert.equal(detail?.operation.runId, undefined);
    assert.equal(detail?.operation.channelId, 'C_TEST');
    assert.equal(detail?.measurements[0]?.totalTokens, 24);
    assert.equal(JSON.stringify(detail).includes('message body'), false);
  } finally {
    store.close();
  }
});
