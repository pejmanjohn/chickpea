import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
  isRevisionedAlias,
} from '../../model-catalog/provider-alias.ts';
import type { StateDb } from '../../state/state-db.ts';
import { addColumnIfMissing } from '../../state/schema-links.ts';
import { UsageStateError } from '../store-error.ts';
import { PRICE_CATALOGS_2026_07_28 } from './catalogs/2026-07-28.ts';
import { PRICE_CATALOGS_2026_10_06 } from './catalogs/2026-10-06.ts';
import { PRICE_CATALOGS_2026_10_07 } from './catalogs/2026-10-07.ts';
import { PRICE_CATALOGS_2026_10_07_OPENROUTER_MAKERS } from './catalogs/2026-10-07-openrouter-makers.ts';
import type { UsagePriceRate, UsagePriceVersion } from './types.ts';

export const RELEASE_PRICE_CATALOGS: UsagePriceVersion[] = [
  ...PRICE_CATALOGS_2026_07_28,
  ...PRICE_CATALOGS_2026_10_06,
  ...PRICE_CATALOGS_2026_10_07,
  ...PRICE_CATALOGS_2026_10_07_OPENROUTER_MAKERS,
];

export function installReleasePriceCatalogs(db: StateDb): UsagePriceVersion[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS usage_price_versions (
      price_version_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      effective_from INTEGER NOT NULL,
      reviewed_at INTEGER NOT NULL,
      stale_after INTEGER NOT NULL,
      currency TEXT NOT NULL,
      content_hash TEXT NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS usage_price_rates (
      price_version_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_aliases_json TEXT NOT NULL,
      currency TEXT NOT NULL,
      unit_scale INTEGER NOT NULL,
      input_micros_per_unit INTEGER NOT NULL,
      output_micros_per_unit INTEGER NOT NULL,
      cache_read_micros_per_unit INTEGER,
      cache_write_micros_per_unit INTEGER,
      basis TEXT NOT NULL,
      PRIMARY KEY (price_version_id, provider_id, model_id)
    )`,
  );
  addColumnIfMissing(db, 'usage_price_rates', 'cache_read_micros_per_unit', 'INTEGER');
  addColumnIfMissing(db, 'usage_price_rates', 'cache_write_micros_per_unit', 'INTEGER');
  addColumnIfMissing(db, 'usage_price_rates', 'cache_write_1h_micros_per_unit', 'INTEGER');
  addColumnIfMissing(db, 'usage_price_rates', 'long_context_json', 'TEXT');
  addColumnIfMissing(db, 'usage_price_rates', 'image_input_micros_per_unit', 'INTEGER');
  const installed: UsagePriceVersion[] = [];
  for (const catalog of RELEASE_PRICE_CATALOGS) {
    if (installVersion(db, catalog)) installed.push(catalog);
  }
  return installed;
}

export function priceCatalogFor<Basis extends UsagePriceRate['basis']>(
  basis: Basis,
  providerId: string,
  modelId: string,
  observedAt: number,
): { version: UsagePriceVersion; rate: Extract<UsagePriceRate, { basis: Basis }> } | null {
  const pricedProviderId = canonicalPriceProviderId(providerId);
  const candidates = RELEASE_PRICE_CATALOGS
    .filter((version) => version.providerId === pricedProviderId && version.effectiveFrom <= observedAt)
    .sort((left, right) => right.effectiveFrom - left.effectiveFrom);
  for (const version of candidates) {
    const rate = version.rates.find((candidate): candidate is Extract<UsagePriceRate, { basis: Basis }> =>
      candidate.basis === basis && candidate.modelAliases.includes(modelId));
    if (rate) return { version, rate };
  }
  return null;
}

/**
 * Catalog models run under bundled or revisioned alias providers, which bill
 * as the provider they route for. Subscription aliases stay unpriced: that
 * lane is a flat fee, not per-token spend.
 */
export function canonicalPriceProviderId(providerId: string): string {
  if (providerId === ANTHROPIC_COMPAT_PROVIDER_ID || isRevisionedAlias('anthropic', providerId)) {
    return 'anthropic';
  }
  if (providerId === OPENAI_PLATFORM_COMPAT_PROVIDER_ID || isRevisionedAlias('openaiPlatform', providerId)) {
    return 'openai';
  }
  return providerId;
}

function installVersion(db: StateDb, version: UsagePriceVersion): boolean {
  const existing = db.get(
    'SELECT content_hash FROM usage_price_versions WHERE price_version_id = ?',
    version.id,
  );
  if (existing && existing.content_hash !== version.contentHash) {
    throw new UsageStateError(
      'usage_price_version_conflict',
      'A release price version cannot be changed in place.',
      { priceVersionId: version.id },
    );
  }
  if (existing) return false;
  db.run(
    `INSERT OR IGNORE INTO usage_price_versions (
      price_version_id, provider_id, source_url, effective_from, reviewed_at,
      stale_after, currency, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    version.id,
    version.providerId,
    version.sourceUrl,
    version.effectiveFrom,
    version.reviewedAt,
    version.staleAfter,
    version.currency,
    version.contentHash,
  );
  for (const rate of version.rates) {
    const columns = rateColumns(rate);
    db.run(
      `INSERT OR IGNORE INTO usage_price_rates (
        price_version_id, provider_id, model_id, model_aliases_json, currency,
        unit_scale, input_micros_per_unit, output_micros_per_unit, basis
        , cache_read_micros_per_unit, cache_write_micros_per_unit
        , cache_write_1h_micros_per_unit, long_context_json, image_input_micros_per_unit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rate.priceVersionId,
      rate.providerId,
      rate.modelId,
      JSON.stringify(rate.modelAliases),
      rate.currency,
      rate.unitScale,
      columns.input,
      columns.output,
      rate.basis,
      columns.cacheRead,
      columns.cacheWrite,
      columns.cacheWrite1h,
      columns.longContextJson,
      columns.imageInput,
    );
  }
  return true;
}

/** Image rates keep text input and image output in the input and output columns; `basis` tells the kinds apart. */
function rateColumns(rate: UsagePriceRate) {
  if (rate.basis === 'image_tokens') {
    return {
      input: rate.textInputMicrosPerUnit,
      output: rate.imageOutputMicrosPerUnit,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite1h: null,
      longContextJson: null,
      imageInput: rate.imageInputMicrosPerUnit,
    };
  }
  return {
    input: rate.inputMicrosPerUnit,
    output: rate.outputMicrosPerUnit,
    cacheRead: rate.cacheReadMicrosPerUnit ?? null,
    cacheWrite: rate.cacheWriteMicrosPerUnit ?? null,
    cacheWrite1h: rate.cacheWrite1hMicrosPerUnit ?? null,
    longContextJson: rate.longContext ? JSON.stringify(rate.longContext) : null,
    imageInput: null,
  };
}
