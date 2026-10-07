import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openStateDb } from '../../src/state/node-state-db.ts';
import { UsageStoreLogic } from '../../src/usage/store.ts';
import {
  installReleasePriceCatalogs,
  RELEASE_PRICE_CATALOGS,
} from '../../src/usage/pricing/catalog.ts';
import { PRICE_CATALOGS_2026_10_07 } from '../../src/usage/pricing/catalogs/2026-10-07.ts';
import type { TokenPriceRate, UsagePriceVersion } from '../../src/usage/pricing/types.ts';

const EARLIER_RELEASES = RELEASE_PRICE_CATALOGS.filter((version) => !PRICE_CATALOGS_2026_10_07.includes(version));

function tokenRate(version: UsagePriceVersion): TokenPriceRate {
  const rate = version.rates[0];
  assert.equal(rate?.basis, 'standard_input_output', version.id);
  return rate as TokenPriceRate;
}

test('release catalog contains only fixture-proven priced routes with immutable provenance', () => {
  assert.deepEqual(
    EARLIER_RELEASES.map((version) => version.providerId),
    [
      'anthropic',
      'openai',
      'openrouter',
      'cloudflare-workers-ai',
      'cloudflare',
      'cloudflare',
      'cloudflare-workers-ai',
      'cloudflare',
      'cloudflare-workers-ai',
      'cloudflare',
      'cloudflare-workers-ai',
      'anthropic',
      'anthropic',
      'anthropic',
      'anthropic',
      'openai',
      'openrouter',
    ],
  );
  for (const version of RELEASE_PRICE_CATALOGS) {
    assert.match(version.contentHash, /^[a-f0-9]{64}$/);
    assert.match(version.sourceUrl, /^https:\/\//);
    assert.equal(version.currency, 'USD');
    assert.ok(version.staleAfter > version.reviewedAt);
    assert.equal(version.rates.length, 1);
  }
  for (const version of EARLIER_RELEASES) tokenRate(version);
  const workersPrices = EARLIER_RELEASES
    .filter((version) => ['cloudflare-workers-ai', 'cloudflare'].includes(version.providerId))
    .map(tokenRate);
  assert.equal(workersPrices.length, 8);
  assert.deepEqual(
    workersPrices.map((rate) => [
      rate?.modelId,
      rate?.inputMicrosPerUnit,
      rate?.outputMicrosPerUnit,
      rate?.cacheReadMicrosPerUnit ?? null,
    ]),
    [
      ['@cf/zai-org/glm-5.2', 1_400_000, 4_400_000, null],
      ['@cf/zai-org/glm-5.2', 1_400_000, 4_400_000, null],
      ['@cf/zai-org/glm-5.2', 1_400_000, 4_400_000, 260_000],
      ['@cf/zai-org/glm-5.2', 1_400_000, 4_400_000, 260_000],
      ['@cf/zai-org/glm-5.3-flash', 150_000, 500_000, 30_000],
      ['@cf/zai-org/glm-5.3-flash', 150_000, 500_000, 30_000],
      ['@cf/zai-org/glm-4.7-flash', 60_000, 400_000, null],
      ['@cf/zai-org/glm-4.7-flash', 60_000, 400_000, null],
    ],
  );
  assert.deepEqual(
    EARLIER_RELEASES
      .filter((version) => version.providerId === 'anthropic')
      .map((version) => [
        version.id,
        version.effectiveFrom,
        tokenRate(version).modelId,
        tokenRate(version).inputMicrosPerUnit,
        tokenRate(version).outputMicrosPerUnit,
        tokenRate(version).cacheReadMicrosPerUnit ?? null,
        tokenRate(version).cacheWriteMicrosPerUnit ?? null,
      ]),
    [
      ['anthropic_2026-07-28', Date.UTC(2026, 6, 28), 'claude-haiku-4-5', 1_000_000, 5_000_000, null, null],
      ['anthropic-cache_2026-10-04', Date.UTC(2026, 9, 4), 'claude-haiku-4-5', 1_000_000, 5_000_000, 100_000, 1_250_000],
      ['anthropic-sonnet-5-5_2026-10-06', Date.UTC(2026, 9, 6), 'claude-sonnet-5-5', 2_000_000, 10_000_000, 200_000, 2_500_000],
      ['anthropic-sonnet-5_2026-10-06', Date.UTC(2026, 9, 6), 'claude-sonnet-5', 2_000_000, 10_000_000, 200_000, 2_500_000],
      ['anthropic-haiku-4-5_2026-10-06', Date.UTC(2026, 9, 6), 'claude-haiku-4-5', 1_000_000, 5_000_000, 100_000, 1_250_000],
    ],
  );
  assert.deepEqual(
    EARLIER_RELEASES
      .filter((version) => ['openai', 'openrouter'].includes(version.providerId))
      .map((version) => [
        version.id,
        version.staleAfter,
        tokenRate(version).modelId,
        tokenRate(version).inputMicrosPerUnit,
        tokenRate(version).outputMicrosPerUnit,
      ]),
    [
      ['openai_2026-07-28', Date.UTC(2026, 9, 26), 'gpt-4.1-mini', 400_000, 1_600_000],
      ['openrouter_2026-07-28', Date.UTC(2026, 9, 26), 'openai/gpt-4.1', 2_000_000, 8_000_000],
      ['openai_2026-10-06', Date.UTC(2027, 0, 4), 'gpt-4.1-mini', 400_000, 1_600_000],
      ['openrouter_2026-10-06', Date.UTC(2027, 0, 4), 'openai/gpt-4.1', 2_000_000, 8_000_000],
    ],
  );
});

test('the 2026-10-07 catalog copies each page\'s list price, cache rates, and long-context tier', () => {
  const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing';
  const openaiModel = (id: string) => `https://developers.openai.com/api/docs/models/${id}`;
  const tokenPrices = PRICE_CATALOGS_2026_10_07
    .filter((version) => version.rates[0]?.basis === 'standard_input_output')
    .map((version) => {
      const rate = tokenRate(version);
      return [
        version.id,
        version.sourceUrl,
        rate.modelAliases.join(' '),
        rate.inputMicrosPerUnit,
        rate.outputMicrosPerUnit,
        rate.cacheReadMicrosPerUnit ?? null,
        rate.cacheWriteMicrosPerUnit ?? null,
        rate.cacheWrite1hMicrosPerUnit ?? null,
        rate.longContext
          ? [
            rate.longContext.fromPromptTokens,
            rate.longContext.inputMicrosPerUnit,
            rate.longContext.outputMicrosPerUnit,
            rate.longContext.cacheReadMicrosPerUnit,
            rate.longContext.cacheWriteMicrosPerUnit,
          ]
          : null,
      ];
    });
  assert.deepEqual(tokenPrices, [
    ['anthropic-fable-5-1_2026-10-07', anthropic, 'claude-fable-5-1', 10_000_000, 50_000_000, 250_000, 12_500_000, 20_000_000, null],
    ['anthropic-fable-5_2026-10-07', anthropic, 'claude-fable-5', 10_000_000, 50_000_000, 1_000_000, 12_500_000, 20_000_000, null],
    ['anthropic-opus-5-5_2026-10-07', anthropic, 'claude-opus-5-5', 4_000_000, 20_000_000, 200_000, 5_000_000, 8_000_000, null],
    ['anthropic-opus-5_2026-10-07', anthropic, 'claude-opus-5', 5_000_000, 25_000_000, 500_000, 6_250_000, 10_000_000, null],
    ['anthropic-sonnet-5-5_2026-10-07', anthropic, 'claude-sonnet-5-5', 2_000_000, 10_000_000, 200_000, 2_500_000, 4_000_000, null],
    ['anthropic-sonnet-5_2026-10-07', anthropic, 'claude-sonnet-5', 2_000_000, 10_000_000, 200_000, 2_500_000, 4_000_000, null],
    ['anthropic-haiku-4-5_2026-10-07', anthropic, 'claude-haiku-4-5 claude-haiku-4-5-20251001', 1_000_000, 5_000_000, 100_000, 1_250_000, 2_000_000, null],
    ['openai-gpt-6-astra_2026-10-07', openaiModel('gpt-6-astra'), 'gpt-6-astra', 10_000_000, 50_000_000, 1_000_000, 12_500_000, null, [272_001, 20_000_000, 75_000_000, 2_000_000, 25_000_000]],
    ['openai-gpt-6-sol_2026-10-07', openaiModel('gpt-6-sol'), 'gpt-6-sol', 2_000_000, 10_000_000, 200_000, 2_500_000, null, [272_001, 4_000_000, 15_000_000, 400_000, 5_000_000]],
    ['openai-gpt-6-luna_2026-10-07', openaiModel('gpt-6-luna'), 'gpt-6-luna', 100_000, 500_000, 10_000, 125_000, null, [272_001, 200_000, 750_000, 20_000, 250_000]],
    ['openai-gpt-5.6-sol_2026-10-07', openaiModel('gpt-5.6-sol'), 'gpt-5.6-sol', 4_000_000, 20_000_000, 400_000, 5_000_000, null, [272_001, 8_000_000, 30_000_000, 800_000, 10_000_000]],
    ['openai-gpt-5.6-terra_2026-10-07', openaiModel('gpt-5.6-terra'), 'gpt-5.6-terra', 2_000_000, 12_000_000, 200_000, 2_500_000, null, [272_001, 4_000_000, 18_000_000, 400_000, 5_000_000]],
    ['openai-gpt-5.6-luna_2026-10-07', openaiModel('gpt-5.6-luna'), 'gpt-5.6-luna', 200_000, 1_200_000, 20_000, 250_000, null, [272_001, 400_000, 1_800_000, 40_000, 500_000]],
    ['openrouter-claude-sonnet-5_2026-10-07', 'https://openrouter.ai/anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5 anthropic/claude-sonnet-5-20260630', 2_000_000, 10_000_000, 200_000, 2_500_000, 4_000_000, null],
    ['openrouter-gpt-5.6-terra_2026-10-07', 'https://openrouter.ai/openai/gpt-5.6-terra', 'openai/gpt-5.6-terra openai/gpt-5.6-terra-20260709', 2_000_000, 12_000_000, 200_000, 2_500_000, null, [272_000, 4_000_000, 18_000_000, 400_000, 5_000_000]],
    ['openrouter-deepseek-v4.1-flash_2026-10-07', 'https://openrouter.ai/deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash deepseek/deepseek-v4.1-flash-20260910', 50_000, 1_200_000, 20_000, null, null, null],
    ['openrouter-glm-5.3-flash_2026-10-07', 'https://openrouter.ai/z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash z-ai/glm-5.3-flash-20260826', 36_000, 500_000, 36_000, null, null, null],
    ['openrouter-kimi-k3_2026-10-07', 'https://openrouter.ai/moonshotai/kimi-k3', 'moonshotai/kimi-k3 moonshotai/kimi-k3-20260715', 615_000, 13_000_000, 450_000, null, null, null],
  ]);
  assert.deepEqual(
    PRICE_CATALOGS_2026_10_07.flatMap((version) => {
      const rate = version.rates[0];
      return rate?.basis === 'image_tokens'
        ? [[version.id, version.sourceUrl, rate.modelId, rate.textInputMicrosPerUnit, rate.imageInputMicrosPerUnit, rate.imageOutputMicrosPerUnit]]
        : [];
    }),
    [
      ['openai-image-gpt-image-2.5-flare_2026-10-07', openaiModel('gpt-image-2.5-flare'), 'gpt-image-2.5-flare', 5_000_000, 8_000_000, 30_000_000],
      ['openai-image-gpt-image-2.5-sunburst_2026-10-07', openaiModel('gpt-image-2.5-sunburst'), 'gpt-image-2.5-sunburst', 5_000_000, 8_000_000, 30_000_000],
    ],
  );
  const reviewedAt = Date.UTC(2026, 9, 7);
  for (const version of PRICE_CATALOGS_2026_10_07) {
    assert.equal(version.effectiveFrom, reviewedAt, version.id);
    assert.equal(version.reviewedAt, reviewedAt, version.id);
    assert.equal(
      version.staleAfter,
      version.id === 'openai-gpt-5.6-sol_2026-10-07' ? Date.UTC(2026, 10, 22) : Date.UTC(2027, 0, 5),
      version.id,
    );
  }
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

test('catalog install upgrades a legacy rate table before adding cache-aware prices', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec(
      `CREATE TABLE usage_price_rates (
        price_version_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_aliases_json TEXT NOT NULL,
        currency TEXT NOT NULL,
        unit_scale INTEGER NOT NULL,
        input_micros_per_unit INTEGER NOT NULL,
        output_micros_per_unit INTEGER NOT NULL,
        basis TEXT NOT NULL,
        PRIMARY KEY (price_version_id, provider_id, model_id)
      )`,
    );

    installReleasePriceCatalogs(db);
    installReleasePriceCatalogs(db);

    const columns = db.all('PRAGMA table_info(usage_price_rates)');
    assert.equal(columns.some((row) => row.name === 'cache_read_micros_per_unit'), true);
    assert.equal(columns.some((row) => row.name === 'cache_write_micros_per_unit'), true);
    const cached = db.get(
      `SELECT cache_read_micros_per_unit, cache_write_micros_per_unit
       FROM usage_price_rates
       WHERE price_version_id = 'cloudflare-binding-cache_2026-08-17'`,
    );
    assert.equal(cached?.cache_read_micros_per_unit, 260_000);
    assert.equal(cached?.cache_write_micros_per_unit, 1_400_000);
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
