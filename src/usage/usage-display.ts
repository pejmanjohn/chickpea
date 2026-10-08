/** Millionths of a dollar of usage at metered rates. */
export type UsageMicros = number & { readonly __unit: 'usage_micros' };

const MICROS_PER_CENT = 10_000;
const WHOLE_DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatUsageDollars(micros: UsageMicros): string {
  const cents = Math.floor((Math.abs(micros) + MICROS_PER_CENT / 2) / MICROS_PER_CENT);
  return formatPriceCents(micros < 0 ? -cents : cents);
}

export function formatPriceCents(cents: number): string {
  const magnitude = Math.abs(cents);
  const dollars = WHOLE_DOLLARS.format(Math.floor(magnitude / 100));
  const remainder = magnitude % 100;
  const amount = remainder === 0 ? `$${dollars}` : `$${dollars}.${String(remainder).padStart(2, '0')}`;
  return cents < 0 ? `-${amount}` : amount;
}

export function usagePercent(used: UsageMicros, included: UsageMicros): number {
  return included > 0 ? Math.floor(used * 100 / included) : 0;
}
