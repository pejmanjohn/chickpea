import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openStateDb } from '../../src/state/node-state-db.ts';
import { SqliteUsageStore } from '../../src/usage/store.ts';
import { USAGE_RAW_RETENTION_DAYS, usageRetentionCutoffs } from '../../src/usage/retention.ts';

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

    const result = await store.cleanupRetention(NOW);
    assert.equal(result.operationsDeleted, 1);
    assert.equal(result.measurementsDeleted, 1);
    assert.equal(await store.getOperation('op_expired'), undefined);
    assert.equal(result.rawRetainedFrom, usageRetentionCutoffs(NOW).rawBefore);
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
