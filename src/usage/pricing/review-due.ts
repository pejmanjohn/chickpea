import { RELEASE_PRICE_CATALOGS, priceCatalogFor } from './catalog.ts';
import type { UsagePriceRate, UsagePriceVersion } from './types.ts';

const DAY = 24 * 60 * 60 * 1_000;

/** Run in a Chickpea Core checkout; `docs/runbooks/price-review.md` covers the review. */
export const PRICE_REVIEW_COMMAND = 'npm run prices:review';

export interface CurrentPrice {
  readonly providerId: string;
  readonly modelId: string;
  readonly version: UsagePriceVersion;
  readonly rate: UsagePriceRate;
}

/** The price each catalog model is charged at `at`, picked the way serving picks it. */
export function currentPrices(at: number): CurrentPrice[] {
  const seen = new Set<string>();
  const prices: CurrentPrice[] = [];
  for (const { providerId, rates } of RELEASE_PRICE_CATALOGS) {
    for (const { basis, modelId } of rates) {
      const key = `${providerId}\n${basis}\n${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const price = priceCatalogFor(basis, providerId, modelId, at);
      if (price) prices.push({ providerId, modelId, version: price.version, rate: price.rate });
    }
  }
  return prices;
}

export interface PriceReviewDue {
  readonly providerId: string;
  readonly basis: UsagePriceRate['basis'];
  readonly modelId: string;
  readonly priceVersionId: string;
  readonly reviewDueAt: number;
  readonly overdue: boolean;
}

/** Current prices whose review is due within `withinDays` of `at`, or overdue, soonest first. */
export function priceReviewsDue(
  at: number,
  options: { withinDays: number; providers?: readonly string[] },
): PriceReviewDue[] {
  const horizon = at + options.withinDays * DAY;
  return currentPrices(at)
    .filter(({ providerId, version }) =>
      version.reviewDueAt <= horizon && (!options.providers || options.providers.includes(providerId)))
    .map(({ providerId, modelId, version, rate }) => ({
      providerId,
      basis: rate.basis,
      modelId,
      priceVersionId: version.id,
      reviewDueAt: version.reviewDueAt,
      overdue: version.reviewDueAt <= at,
    }))
    .sort((left, right) =>
      left.reviewDueAt - right.reviewDueAt ||
      left.providerId.localeCompare(right.providerId) ||
      left.modelId.localeCompare(right.modelId));
}
