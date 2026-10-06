import { createHash } from 'node:crypto';

import type { UsagePriceRate, UsagePriceVersion } from '../types.ts';

/** A release price version whose content hash pins its rates and provenance. */
export function version(
  input: Omit<UsagePriceVersion, 'contentHash' | 'rates'> & {
    rates: Array<Omit<UsagePriceRate, 'priceVersionId'>>;
  },
): UsagePriceVersion {
  const rates = input.rates.map((rate) => ({ ...rate, priceVersionId: input.id }));
  const contentHash = createHash('sha256').update(JSON.stringify({ ...input, rates })).digest('hex');
  return { ...input, contentHash, rates };
}
