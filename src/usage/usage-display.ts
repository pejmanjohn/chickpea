/** Millionths of a dollar of usage at metered rates. */
export type UsageMicros = number & { readonly __unit: 'usage_micros' };

const MICROS_PER_CENT = 10_000;
const WHOLE_DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `down` is for an amount used beside a percent, so the two never disagree at the plan's edge. */
export function formatUsageDollars(micros: UsageMicros, rounding: 'half_up' | 'down' = 'half_up'): string {
  const half = rounding === 'half_up' ? MICROS_PER_CENT / 2 : 0;
  const cents = Math.floor((Math.abs(micros) + half) / MICROS_PER_CENT);
  return formatPriceCents(micros < 0 ? -cents : cents);
}

export function formatPriceCents(cents: number): string {
  const magnitude = Math.abs(cents);
  const dollars = WHOLE_DOLLARS.format(Math.floor(magnitude / 100));
  const remainder = magnitude % 100;
  const amount = remainder === 0 ? `$${dollars}` : `$${dollars}.${String(remainder).padStart(2, '0')}`;
  return cents < 0 ? `-${amount}` : amount;
}

const CARD_BRANDS: Readonly<Record<string, string>> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover',
  diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay',
};

/** "Visa ending 4242" from Stripe's card brand and last four digits. */
export function formatCard(card: { readonly brand: string; readonly last4: string }): string {
  return `${CARD_BRANDS[card.brand] ?? 'Card'} ending ${card.last4}`;
}

export function usagePercent(used: UsageMicros, included: UsageMicros): number {
  return included > 0 ? Math.floor(used * 100 / included) : 0;
}
