/**
 * Platform billing: what an installation that pays with Chickpea credits
 * sees and buys in Admin. The host keeps the balance and talks to Stripe;
 * Core only shows its answers and opens the URLs it returns.
 *
 * The host installs one port at module scope. With no port, as on
 * standalone, Admin has no Plan and credits page and onboarding offers no
 * credits.
 */

/** How an installation pays for its model requests. */
export type BillingFunding = 'credits' | 'own_key';

/** A plan the host's rate card sells. */
export interface CreditPlanOffer {
  readonly key: string;
  readonly name: string;
  /** The monthly price, in US cents. */
  readonly priceCents: number;
  /** Whole credits each billing period. */
  readonly credits: number;
}

/** A one-off credit pack the host's rate card sells. */
export interface TopUpOffer {
  readonly key: string;
  readonly priceCents: number;
  readonly credits: number;
  readonly validMonths: number;
}

/** Whole credits drawn this period by one Agent or one person; a null id is use with no Agent or person. */
export interface CreditUse {
  readonly id: string | null;
  readonly credits: number;
}

export interface CreditsBillingSummary {
  readonly funding: 'credits';
  /** Whole credits. Below zero only by requests that were already running when it reached zero. */
  readonly balance: number;
  /** The subscribed plan; null while the installation has only trial or top-up credits. */
  readonly plan: { readonly key: string; readonly name: string } | null;
  /** The billing period `use` covers; its end is when the plan renews. */
  readonly period: { readonly start: Date; readonly end: Date };
  readonly use: {
    /** Keyed by Agent ID. */
    readonly byAgent: readonly CreditUse[];
    /** Keyed by the Chickpea membership ID of the person who started the work. */
    readonly byPerson: readonly CreditUse[];
  };
  readonly offers: { readonly plans: readonly CreditPlanOffer[]; readonly topUps: readonly TopUpOffer[] };
}

export type BillingSummary = { readonly funding: 'own_key' } | CreditsBillingSummary;

export type CheckoutRequest =
  | { readonly kind: 'plan'; readonly key: string }
  | { readonly kind: 'top_up'; readonly key: string };

/** A Stripe page to send the Owner to. */
export interface BillingRedirect {
  readonly url: string;
}

export interface PlatformBillingPort {
  summary(installationId: string): Promise<BillingSummary>;
  /**
   * Stripe Checkout for a plan or a top-up. `returnPath` is the Admin path,
   * on the host's own origin, where Stripe sends the Owner back.
   */
  checkout(installationId: string, request: CheckoutRequest, returnPath: string): Promise<BillingRedirect>;
  /** The Stripe customer portal: cards, invoices, and plan changes. */
  portal(installationId: string, returnPath: string): Promise<BillingRedirect>;
  /** Onboarding's choice. Choosing the same funding again changes nothing. */
  chooseFunding(installationId: string, funding: BillingFunding): Promise<void>;
}

let port: PlatformBillingPort | undefined;

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configurePlatformBilling(next: PlatformBillingPort | undefined): void {
  port = next;
}

export function platformBilling(): PlatformBillingPort | undefined {
  return port;
}
