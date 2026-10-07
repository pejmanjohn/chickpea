import { createHash } from 'node:crypto';

import type { UsagePriceRate, UsagePriceVersion } from '../types.ts';

type RateInput = UsagePriceRate extends infer Rate
  ? Rate extends UsagePriceRate ? Omit<Rate, 'priceVersionId'> : never
  : never;

/** A release price version whose content hash pins its rates and provenance. */
export function version(
  input: Omit<UsagePriceVersion, 'contentHash' | 'rates'> & { rates: RateInput[] },
): UsagePriceVersion {
  const rates: UsagePriceRate[] = input.rates.map((rate) => ({ ...rate, priceVersionId: input.id }));
  const contentHash = createHash('sha256').update(JSON.stringify({ ...input, rates })).digest('hex');
  return { ...input, contentHash, rates };
}
