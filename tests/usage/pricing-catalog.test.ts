import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openStateDb } from '../../src/state/node-state-db.ts';
import { UsageStoreLogic } from '../../src/usage/store.ts';
import {
  installReleasePriceCatalogs,
  RELEASE_PRICE_CATALOGS,
} from '../../src/usage/pricing/catalog.ts';

test('release catalog contains only fixture-proven priced routes with immutable provenance', () => {
  assert.deepEqual(
    RELEASE_PRICE_CATALOGS.map((version) => version.providerId),
    ['anthropic', 'openai', 'openrouter', 'cloudflare-workers-ai', 'cloudflare'],
  );
  for (const version of RELEASE_PRICE_CATALOGS) {
    assert.match(version.contentHash, /^[a-f0-9]{64}$/);
    assert.match(version.sourceUrl, /^https:\/\//);
    assert.equal(version.currency, 'USD');
    assert.ok(version.staleAfter > version.reviewedAt);
    assert.equal(version.rates.length, 1);
    assert.equal(version.rates[0]?.basis, 'standard_input_output');
  }
  const workersPrices = RELEASE_PRICE_CATALOGS
    .filter((version) => ['cloudflare-workers-ai', 'cloudflare'].includes(version.providerId))
    .map((version) => version.rates[0]);
  assert.equal(workersPrices.length, 2);
  assert.deepEqual(
    workersPrices.map((rate) => [rate?.modelId, rate?.inputMicrosPerUnit, rate?.outputMicrosPerUnit]),
    [
      ['@cf/zai-org/glm-5.2', 1_400_000, 4_400_000],
      ['@cf/zai-org/glm-5.2', 1_400_000, 4_400_000],
    ],
  );
});

test('catalog tables install transactionally and repeated install cannot duplicate rates', () => {
  const db = openStateDb(':memory:');
  try {
    installReleasePriceCatalogs(db);
    installReleasePriceCatalogs(db);
    const versions = db.get('SELECT COUNT(*) AS count FROM usage_price_versions');
    const rates = db.get('SELECT COUNT(*) AS count FROM usage_price_rates');
    assert.equal(versions?.count, RELEASE_PRICE_CATALOGS.length);
    assert.equal(rates?.count, RELEASE_PRICE_CATALOGS.length);
    const source = db.get(
      `SELECT source_url, content_hash FROM usage_price_versions
       WHERE price_version_id = 'openai_2026-07-28'`,
    );
    assert.equal(source?.source_url, 'https://developers.openai.com/api/docs/models/gpt-4.1-mini');
    assert.match(String(source?.content_hash), /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test('installing binding price coverage backfills unknown estimates once without breaking terminal idempotency', () => {
  const db = openStateDb(':memory:');
  const observedAt = Date.UTC(2026, 6, 30, 16);
  const terminal = {
    operationId: 'binding_demo_operation',
    executionId: 'binding_demo_execution',
    status: 'completed' as const,
    finishedAt: observedAt,
    observedAt,
    providerRoute: 'cloudflare',
    requestedProvider: 'cloudflare',
    requestedModel: '@cf/zai-org/glm-5.2',
    returnedProvider: 'cloudflare',
    returnedModel: '@cf/zai-org/glm-5.2',
    credentialRefId: null,
    credentialVersion: null,
    usageCompleteness: 'complete' as const,
    inputTokens: 58_666,
    outputTokens: 28,
    totalTokens: 58_694,
    usageUnknownReason: null,
    estimateCompleteness: 'unknown' as const,
    estimateAmountMicros: null,
    estimateCurrency: null,
    priceVersionId: null,
    priceUnknownReason: 'price_unknown' as const,
  };
  try {
    const before = new UsageStoreLogic(db, () => observedAt);
    before.admitOperation({
      operationId: terminal.operationId,
      operationKind: 'interactive_turn',
      sourceId: terminal.operationId,
      startedAt: observedAt - 1,
      installationId: 'test',
      workspaceId: 'T_TEST',
      agentId: 'agent_default',
      agentLabel: 'Default',
      channelId: 'C_TEST',
      channelLabel: 'bot-test',
      conversationKind: 'named_channel',
      requestedProvider: terminal.requestedProvider,
      requestedModel: terminal.requestedModel,
      credentialRefId: null,
      credentialVersion: null,
    });
    before.recordTerminal(terminal);

    db.run(
      'DELETE FROM usage_price_rates WHERE price_version_id = ?',
      'cloudflare-binding_2026-07-30',
    );
    db.run(
      'DELETE FROM usage_price_versions WHERE price_version_id = ?',
      'cloudflare-binding_2026-07-30',
    );

    const after = new UsageStoreLogic(db, () => observedAt + 1);
    const measurement = after.getOperation(terminal.operationId)?.measurements[0];
    assert.equal(measurement?.estimateCompleteness, 'complete');
    assert.equal(measurement?.estimateAmountMicros, 82_256);
    assert.equal(measurement?.estimateCurrency, 'USD');
    assert.equal(measurement?.priceVersionId, 'cloudflare-binding_2026-07-30');
    assert.equal(measurement?.priceUnknownReason, null);
    assert.equal(
      after.listUsageAuditEvents().some((event) =>
        event.eventType === 'usage.estimates_backfilled' &&
        JSON.parse(event.metadataJson).measurementCount === 1),
      true,
    );

    assert.doesNotThrow(() => after.recordTerminal(terminal));
    const reinitialized = new UsageStoreLogic(db, () => observedAt + 2);
    assert.equal(
      reinitialized.listUsageAuditEvents().filter((event) =>
        event.eventType === 'usage.estimates_backfilled').length,
      1,
    );
  } finally {
    db.close();
  }
});
