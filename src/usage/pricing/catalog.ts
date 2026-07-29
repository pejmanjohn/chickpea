import type { StateDb } from '../../state/state-db.ts';
import { UsageStateError } from '../store-error.ts';
import { RELEASE_PRICE_CATALOGS } from './catalogs/2026-07-28.ts';
import type { UsagePriceRate, UsagePriceVersion } from './types.ts';

export { RELEASE_PRICE_CATALOGS } from './catalogs/2026-07-28.ts';

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
      basis TEXT NOT NULL,
      PRIMARY KEY (price_version_id, provider_id, model_id)
    )`,
  );
  const installed: UsagePriceVersion[] = [];
  for (const catalog of RELEASE_PRICE_CATALOGS) {
    if (installVersion(db, catalog)) installed.push(catalog);
  }
  return installed;
}

export function priceCatalogFor(
  providerId: string,
  modelId: string,
  observedAt: number,
): { version: UsagePriceVersion; rate: UsagePriceRate } | null {
  const candidates = RELEASE_PRICE_CATALOGS
    .filter((version) => version.providerId === providerId && version.effectiveFrom <= observedAt)
    .sort((left, right) => right.effectiveFrom - left.effectiveFrom);
  for (const version of candidates) {
    const rate = version.rates.find((candidate) => candidate.modelAliases.includes(modelId));
    if (rate) return { version, rate };
  }
  return null;
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
    db.run(
      `INSERT OR IGNORE INTO usage_price_rates (
        price_version_id, provider_id, model_id, model_aliases_json, currency,
        unit_scale, input_micros_per_unit, output_micros_per_unit, basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rate.priceVersionId,
      rate.providerId,
      rate.modelId,
      JSON.stringify(rate.modelAliases),
      rate.currency,
      rate.unitScale,
      rate.inputMicrosPerUnit,
      rate.outputMicrosPerUnit,
      rate.basis,
    );
  }
  return true;
}
