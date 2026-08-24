import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openStateDb } from '../../src/state/node-state-db.ts';
import { SqliteUsageStore } from '../../src/usage/store.ts';
import { USAGE_RAW_RETENTION_DAYS, usageRetentionCutoffs } from '../../src/usage/retention.ts';
import { COMPOSIO_CONNECTOR_PRICE_VERSION } from '../../src/usage/connectors/pricing.ts';

const NOW = Date.UTC(2026, 6, 28, 12);
const DAY = 24 * 60 * 60 * 1_000;

test('usage retention preserves daily aggregates before deleting operation detail', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-usage-retention-')), 'state.db');
  const store = new SqliteUsageStore(path, () => NOW);
  try {
    const startedAt = NOW - (USAGE_RAW_RETENTION_DAYS + 2) * DAY;
    await store.admitOperation({
      operationId: 'op_expired', operationKind: 'interactive_turn', sourceId: 'source_expired',
      startedAt, installationId: 'installation', workspaceId: 'T_USAGE', agentId: 'agent_default',
      agentLabel: 'Default', channelId: 'C_USAGE', channelLabel: 'usage', conversationKind: 'named_channel',
      requestedProvider: 'openai', requestedModel: 'gpt-4.1-mini', credentialRefId: 'cred_openai', credentialVersion: 1,
    });
    await store.recordTerminal({
      operationId: 'op_expired', executionId: 'exec_expired', status: 'completed', finishedAt: startedAt + 1_000,
      observedAt: startedAt + 1_000, providerRoute: 'openai', requestedProvider: 'openai', requestedModel: 'gpt-4.1-mini',
      returnedProvider: 'openai', returnedModel: 'gpt-4.1-mini', credentialRefId: 'cred_openai', credentialVersion: 1,
      usageCompleteness: 'complete', inputTokens: 100, outputTokens: 25, totalTokens: 125, usageUnknownReason: null,
      estimateCompleteness: 'complete', estimateAmountMicros: 50, estimateCurrency: 'USD',
      priceVersionId: 'openai_2026-07-28', priceUnknownReason: null,
    });
    await store.reserveConnectorQuota({
      reservationId: 'quota_expired',
      workspaceId: 'T_USAGE',
      adapterId: 'composio',
      toolkit: 'youtube',
      bucket: 'general_units',
      units: 1,
      limit: 10_000,
      periodStart: NOW - DAY,
      periodEnd: NOW,
    });
    for (const [attemptId, finishedAt] of [
      ['connector_raw_expired', NOW - (USAGE_RAW_RETENTION_DAYS + 2) * DAY],
      ['connector_rollup_expired', Date.UTC(2025, 4, 1, 12)],
    ] as const) {
      await store.recordConnectorUsage({
        attemptId,
        workspaceId: 'T_USAGE',
        agentId: 'agent_default',
        connectionAccountId: 'connection_gmail',
        operationId: null,
        runId: null,
        runExecutionId: null,
        adapterId: 'composio',
        toolkit: 'gmail',
        capability: 'gmail.messages.search',
        providerTool: 'GMAIL_FETCH_EMAILS',
        providerVersion: '20260817_00',
        effectClass: 'read',
        outcome: 'success',
        retryClassification: 'none',
        startedAt: finishedAt - 100,
        finishedAt,
        latencyMs: 100,
        remoteCallCount: 1,
        providerToolCallCount: 1,
        resultBytes: 100,
        httpStatus: null,
        rateLimitRemaining: null,
        retryAfterMs: null,
        providerLogId: null,
        priceVersionId: COMPOSIO_CONNECTOR_PRICE_VERSION.id,
        estimatedCostMicros: 600,
        estimateCurrency: 'USD',
      });
    }

    const result = await store.cleanupRetention(NOW);
    assert.equal(result.operationsDeleted, 1);
    assert.equal(result.measurementsDeleted, 1);
    assert.equal(result.connectorAttemptsDeleted, 2);
    assert.equal(result.connectorAggregateDaysDeleted, 1);
    assert.equal(result.connectorQuotaReservationsDeleted, 1);
    assert.equal(await store.getOperation('op_expired'), undefined);
    assert.equal(result.rawRetainedFrom, usageRetentionCutoffs(NOW).rawBefore);
    const connectorSummary = await store.summarizeConnectorUsage({
      from: NOW - 100 * DAY,
      to: NOW + 1,
      workspaceId: 'T_USAGE',
    });
    assert.equal(connectorSummary.retainedFrom, usageRetentionCutoffs(NOW).rawBefore);
    assert.equal(connectorSummary.isComplete, false);
    assert.equal(connectorSummary.attemptCount, 0);
    assert.equal((await store.listUsageAuditEvents()).some((event) => event.eventType === 'usage.retention_applied'), true);
  } finally {
    store.close();
  }

  const db = openStateDb(path);
  try {
    const rollup = db.get('SELECT * FROM usage_daily_rollups');
    assert.equal(rollup?.operation_count, 1);
    assert.equal(rollup?.total_tokens, 125);
    assert.equal(rollup?.estimate_amount_micros_usd, 50);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM usage_connector_attempts')?.count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM usage_connector_daily_rollups')?.count, 1);
  } finally {
    db.close();
  }
});
test('usage retention cutoffs are deterministic UTC boundaries', () => {
  const result = usageRetentionCutoffs(NOW);
  assert.equal(result.rawBefore, NOW - 90 * DAY);
  assert.equal(new Date(result.aggregatesBefore).toISOString(), '2025-06-28T00:00:00.000Z');
  assert.throws(() => usageRetentionCutoffs(-1));
});
