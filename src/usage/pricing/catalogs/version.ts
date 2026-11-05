import { createHash } from 'node:crypto';

import type { UsagePriceRate, UsagePriceVersion } from '../types.ts';

export type RateInput = UsagePriceRate extends infer Rate
  ? Rate extends UsagePriceRate ? Omit<Rate, 'priceVersionId'> : never
  : never;

/** A release price version whose content hash pins its rates and provenance. */
export function version(
  input: Omit<UsagePriceVersion, 'contentHash' | 'rates'> & { rates: RateInput[] },
): UsagePriceVersion {
  const rates: UsagePriceRate[] = input.rates.map((rate) => ({ ...rate, priceVersionId: input.id }));
  // Installed stores compare this hash, and versions hashed before
  // `reviewDueAt` was named spell it `staleAfter` in the same position.
  const hashed = Object.fromEntries(
    Object.entries({ ...input, rates }).map(([key, value]) => [key === 'reviewDueAt' ? 'staleAfter' : key, value]),
  );
  const contentHash = createHash('sha256').update(JSON.stringify(hashed)).digest('hex');
  return { ...input, contentHash, rates };
}
