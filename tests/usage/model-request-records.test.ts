import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelRequestRecord } from '../../src/usage/model-requests.ts';
import { USAGE_RAW_RETENTION_DAYS } from '../../src/usage/retention.ts';
import { SqliteUsageStore, UsageStateError } from '../../src/usage/store.ts';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 9, 7, 12);

function storedRecord(overrides: Partial<ModelRequestRecord> = {}): ModelRequestRecord {
  return {
    requestId: 'request-1',
    installationId: 'installation-1',
    runId: 'submission-1',
    attemptId: 'attempt-1',
    agentId: 'agent_default',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    fundingSource: 'customer',
    outcome: 'completed',
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 400,
    cacheWrite1hTokens: null,
    reasoningTokens: 120,
    priceVersionId: 'anthropic-sonnet-5-5_2026-10-06',
    listPriceUsdMicros: 8_400,
    priceUnknownReason: null,
    finishedAt: NOW,
    ...overrides,
  };
}

test('a request record is written once: a second write under its request ID leaves the first', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    const first = storedRecord();
    assert.deepEqual(await store.recordModelRequest(first), first);
    assert.deepEqual(await store.recordModelRequest(first), first);
    const rewritten = storedRecord({ outcome: 'error', inputTokens: 9, agentId: null, finishedAt: NOW + 5 });
    assert.deepEqual(await store.recordModelRequest(rewritten), first);
    assert.deepEqual(await store.getModelRequest('request-1'), first);
    assert.equal(await store.getModelRequest('request-missing'), undefined);
  } finally {
    store.close();
  }
});

test('a request record is validated where the store receives it', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    for (const invalid of [
      storedRecord({ inputTokens: -1 }),
      storedRecord({ outputTokens: 1.5 }),
      storedRecord({ requestId: '' }),
      storedRecord({ outcome: 'cancelled' as ModelRequestRecord['outcome'] }),
      storedRecord({ fundingSource: 'platform' as ModelRequestRecord['fundingSource'] }),
      storedRecord({ listPriceUsdMicros: null }),
      storedRecord({ priceUnknownReason: 'price_unknown' }),
      storedRecord({ priceVersionId: null, listPriceUsdMicros: null }),
      storedRecord({ priceVersionId: null, priceUnknownReason: 'price_unknown' }),
    ]) {
      await assert.rejects(
        store.recordModelRequest(invalid),
        (error: unknown) => error instanceof UsageStateError && error.code === 'usage_invalid_input',
      );
    }
    const unpriced = storedRecord({
      requestId: 'request-unpriced',
      priceVersionId: null,
      listPriceUsdMicros: null,
      priceUnknownReason: 'price_unknown',
    });
    assert.deepEqual(await store.recordModelRequest(unpriced), unpriced);
  } finally {
    store.close();
  }
});

test('retention deletes request records past the raw cutoff and keeps fresh ones', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    const expired = storedRecord({ requestId: 'request-expired', finishedAt: NOW - (USAGE_RAW_RETENTION_DAYS + 1) * DAY });
    const fresh = storedRecord({ requestId: 'request-fresh', finishedAt: NOW - (USAGE_RAW_RETENTION_DAYS - 1) * DAY });
    await store.recordModelRequest(expired);
    await store.recordModelRequest(fresh);

    const result = await store.cleanupRetention(NOW);

    assert.equal(result.modelRequestsDeleted, 1);
    assert.equal(await store.getModelRequest('request-expired'), undefined);
    assert.deepEqual(await store.getModelRequest('request-fresh'), fresh);
  } finally {
    store.close();
  }
});

test('a request record leaves the per-turn usage operations and measurements empty', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    await store.recordModelRequest(storedRecord());
    const query = { from: NOW - DAY, to: NOW + DAY };
    assert.deepEqual((await store.listOperations(query)).items, []);
    const summary = await store.summarize(query);
    assert.equal(summary.totals.operationCount, 0);
    assert.equal(summary.totals.inputTokens, null);
  } finally {
    store.close();
  }
});
