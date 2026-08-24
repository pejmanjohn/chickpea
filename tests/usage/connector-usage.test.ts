import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteUsageStore } from '../../src/usage/store.ts';
import { COMPOSIO_CONNECTOR_PRICE_VERSION } from '../../src/usage/connectors/pricing.ts';
import type { RecordConnectorUsageInput } from '../../src/usage/connectors/types.ts';

const START = Date.UTC(2026, 7, 23, 12);

function attempt(
  overrides: Partial<RecordConnectorUsageInput> = {},
): RecordConnectorUsageInput {
  return {
    attemptId: 'connector_attempt_1',
    workspaceId: 'T_TEST',
    agentId: 'agent_support',
    connectionAccountId: 'connection_gmail',
    operationId: 'operation_1',
    runId: 'run_1',
    runExecutionId: 'execution_1',
    adapterId: 'composio',
    toolkit: 'gmail',
    capability: 'gmail.messages.search',
    providerTool: 'GMAIL_FETCH_EMAILS',
    providerVersion: '20260817_00',
    effectClass: 'read',
    outcome: 'success',
    retryClassification: 'none',
    startedAt: START,
    finishedAt: START + 125,
    latencyMs: 125,
    remoteCallCount: 1,
    providerToolCallCount: 1,
    resultBytes: 4_045,
    httpStatus: null,
    rateLimitRemaining: 1_999,
    retryAfterMs: null,
    providerLogId: 'log_safe_1',
    priceVersionId: COMPOSIO_CONNECTOR_PRICE_VERSION.id,
    estimatedCostMicros: 600,
    estimateCurrency: 'USD',
    ...overrides,
  };
}

test('connector telemetry is idempotent, correlated, and summarized apart from LLM usage', async () => {
  const store = new SqliteUsageStore(':memory:', () => START + 500);
  try {
    const recorded = await store.recordConnectorUsage(attempt());
    assert.equal(recorded.operationId, 'operation_1');
    assert.equal(recorded.runExecutionId, 'execution_1');
    assert.equal(recorded.estimatedCostMicros, 600);
    assert.equal(recorded.resultBytes, 4_045);
    assert.deepEqual(await store.recordConnectorUsage(attempt()), recorded);

    await store.recordConnectorUsage(attempt({
      attemptId: 'connector_attempt_2',
      operationId: null,
      runId: null,
      runExecutionId: null,
      outcome: 'throttled',
      retryClassification: 'retry_after',
      startedAt: START + 1_000,
      finishedAt: START + 1_250,
      latencyMs: 250,
      httpStatus: 429,
      retryAfterMs: 30_000,
      providerLogId: null,
      resultBytes: null,
    }));

    const summary = await store.summarizeConnectorUsage({
      from: START,
      to: START + 10_000,
      workspaceId: 'T_TEST',
    });
    assert.equal(summary.attemptCount, 2);
    assert.equal(summary.retainedFrom, null);
    assert.equal(summary.isComplete, true);
    assert.equal(summary.successCount, 1);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.throttledCount, 1);
    assert.equal(summary.measuredConnectionAccountCount, 1);
    assert.equal(summary.remoteCallCount, 2);
    assert.equal(summary.providerToolCallCount, 2);
    assert.equal(summary.totalResultBytes, 4_045);
    assert.equal(summary.estimatedCostMicros, 1_200);
    assert.equal(summary.averageLatencyMs, 188);
    assert.equal(summary.minimumRateLimitRemaining, 1_999);
    assert.equal(summary.maximumRetryAfterMs, 30_000);
    assert.equal(summary.groups.length, 2);
    assert.equal(summary.groups[0]?.workspaceId, 'T_TEST');
    assert.equal(summary.groups[0]?.agentId, 'agent_support');
    assert.equal(
      summary.groups.reduce((sum, group) => sum + group.totalResultBytes, 0),
      4_045,
    );
  } finally {
    store.close();
  }
});

test('connector telemetry rejects content and credential-shaped identifiers', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    await assert.rejects(
      store.recordConnectorUsage(attempt({
        providerLogId: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      })),
      /provider log ID is invalid/,
    );
    await assert.rejects(
      store.recordConnectorUsage(attempt({ latencyMs: 124 })),
      /latency does not match/,
    );
  } finally {
    store.close();
  }
});

test('connector quota reservations are provider-wide, atomic, and idempotent', async () => {
  const store = new SqliteUsageStore(':memory:', () => START + 500);
  const base = {
    workspaceId: 'T_ONE',
    adapterId: 'composio',
    toolkit: 'youtube',
    bucket: 'general_units',
    units: 60,
    limit: 100,
    periodStart: START,
    periodEnd: START + 24 * 60 * 60 * 1_000,
  };
  try {
    const first = await store.reserveConnectorQuota({
      ...base,
      reservationId: 'connector:attempt_1:general_units',
    });
    assert.equal(first.used, 60);
    assert.equal(first.remaining, 40);
    assert.deepEqual(await store.reserveConnectorQuota({
      ...base,
      reservationId: 'connector:attempt_1:general_units',
    }), first);

    await assert.rejects(store.reserveConnectorQuota({
      ...base,
      reservationId: 'connector:attempt_2:general_units',
      workspaceId: 'T_TWO',
      units: 41,
    }), (error: unknown) =>
      error instanceof Error && 'code' in error &&
      error.code === 'usage_connector_quota_exceeded');

    const second = await store.reserveConnectorQuota({
      ...base,
      reservationId: 'connector:attempt_3:general_units',
      workspaceId: 'T_TWO',
      units: 40,
    });
    assert.equal(second.used, 100);
    assert.equal(second.remaining, 0);
    assert.equal(await store.releaseConnectorQuota({
      ...base,
      reservationId: 'connector:attempt_3:general_units',
      workspaceId: 'T_TWO',
      units: 40,
    }), true);
    assert.equal(await store.releaseConnectorQuota({
      ...base,
      reservationId: 'connector:attempt_3:general_units',
      workspaceId: 'T_TWO',
      units: 40,
    }), false);
    const replacement = await store.reserveConnectorQuota({
      ...base,
      reservationId: 'connector:attempt_4:general_units',
      workspaceId: 'T_TWO',
      units: 40,
    });
    assert.equal(replacement.used, 100);
  } finally {
    store.close();
  }
});
