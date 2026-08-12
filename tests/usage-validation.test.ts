import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeAdmitUsageOperation,
  normalizeRecordUsageTerminal,
  normalizeUsageQuery,
} from '../src/usage/validation.ts';
import { UsageStateError } from '../src/usage/store.ts';

test('usage validation bounds IDs and rejects credential-like captured labels', () => {
  assert.throws(
    () => normalizeAdmitUsageOperation({
      operationId: 'op_valid',
      operationKind: 'interactive_turn',
      sourceId: 'source_valid',
      startedAt: 1,
      installationId: 'installation',
      workspaceId: 'T1',
      agentId: 'agent_default',
      agentLabel: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      channelId: 'C1',
      channelLabel: 'general',
      conversationKind: 'named_channel',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4.1-mini',
      credentialRefId: 'cred_openai',
      credentialVersion: 1,
    }),
    (error: unknown) => error instanceof UsageStateError && error.code === 'usage_invalid_input',
  );
});

test('interaction-classification usage can be assignment-scoped without a Run', () => {
  const normalized = normalizeAdmitUsageOperation({
    operationId: 'classification_T1_C1_E1',
    operationKind: 'interaction_classification' as never,
    sourceId: 'classification_T1_C1_E1',
    startedAt: 1,
    installationId: 'installation',
    workspaceId: 'T1',
    agentId: 'agent_default',
    agentLabel: 'Default',
    channelId: 'C1',
    channelLabel: 'general',
    conversationKind: 'named_channel',
    requestedProvider: 'openai',
    requestedModel: 'gpt-4.1-mini',
    credentialRefId: null,
    credentialVersion: null,
  });
  assert.equal(normalized.operationKind, 'interaction_classification');
  assert.equal(normalized.runId, undefined);
});
test('terminal validation requires nullable unknowns instead of synthetic zero usage', () => {
  assert.throws(
    () => normalizeRecordUsageTerminal({
      operationId: 'op_valid',
      executionId: 'exec_valid',
      status: 'completed',
      finishedAt: 2,
      observedAt: 2,
      providerRoute: 'custom',
      requestedProvider: 'custom',
      requestedModel: 'model',
      returnedProvider: 'custom',
      returnedModel: 'model',
      credentialRefId: 'cred_custom',
      credentialVersion: 1,
      usageCompleteness: 'not_reported',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageUnknownReason: 'usage_not_reported',
      estimateCompleteness: 'not_priced',
      estimateAmountMicros: null,
      estimateCurrency: null,
      priceVersionId: null,
      priceUnknownReason: 'price_unknown',
    }),
    (error: unknown) => error instanceof UsageStateError && error.code === 'usage_invalid_input',
  );
});

test('usage queries cap time range, pagination, grouping, and filter cardinality', () => {
  const query = normalizeUsageQuery({
    from: 1_000,
    to: 2_000,
    limit: 50,
    groupBy: 'provider',
    filters: { provider: ['openai', 'anthropic'] },
  });
  assert.equal(query.limit, 50);
  assert.deepEqual(query.filters?.provider, ['openai', 'anthropic']);

  assert.throws(
    () => normalizeUsageQuery({ from: 0, to: 400 * 24 * 60 * 60 * 1_000 }),
    (error: unknown) => error instanceof UsageStateError && error.code === 'usage_query_invalid',
  );
});
