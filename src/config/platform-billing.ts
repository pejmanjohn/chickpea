/**
 * Platform billing: what an installation that uses Chickpea's models sees
 * and buys in Admin. The host keeps the plan and its usage and talks to
 * Stripe; Core only shows its answers and opens the URLs it returns.
 *
 * The host installs one port at module scope. With no port, as on
 * standalone, Admin has no Plan page and onboarding offers only the
 * installation's own key.
 */

import type { UsageMicros } from '../usage/usage-display.ts';

export type { UsageMicros };

/** How an installation pays for its model requests. */
export type BillingFunding = 'platform' | 'own_key';

/** A plan the host's rate card sells. */
export interface PlanOffer {
  readonly key: string;
  readonly name: string;
  /** The monthly price, in US cents. */
  readonly priceCents: number;
  /** Usage each billing period: the price with its bonus. */
  readonly includedMicros: UsageMicros;
  /** At or above the lowest plan for an installation's own key. */
  readonly ownKeyEligible: boolean;
}

/** Extra usage the host's rate card sells, at face value. */
export interface ExtraUsageOffer {
  readonly key: string;
  readonly priceCents: number;
  readonly usageMicros: UsageMicros;
  readonly validMonths: number;
}

/** Usage this period by one Agent or one person; a null id is use with no Agent or person. */
export interface UsageRow {
  readonly id: string | null;
  readonly usageMicros: UsageMicros;
}

export interface BillingSummary {
  readonly funding: BillingFunding;
  /** Null without a plan: a trial, or an own-key installation that never chose one. */
  readonly plan: { readonly key: string; readonly name: string; readonly priceCents: number } | null;
  /** The billing period `use` covers; its end is when the plan renews. */
  readonly period: { readonly start: Date; readonly end: Date } | null;
  /** The plan's meter; null without a plan period. */
  readonly planUsage: {
    readonly usedMicros: UsageMicros;
    readonly includedMicros: UsageMicros;
    readonly onPacePercent: number | null;
  } | null;
  readonly rollover: { readonly remainingMicros: UsageMicros; readonly expiresAt: Date } | null;
  /** Remaining extra usage; frozen while `plan` is null, with the soonest expiry. */
  readonly extraUsage: { readonly remainingMicros: UsageMicros; readonly frozen: boolean; readonly expiresAt: Date } | null;
  readonly trial: { readonly remainingMicros: UsageMicros; readonly expiresAt: Date } | null;
  readonly debtMicros: UsageMicros;
  readonly ownKeyGraceUntil: Date | null;
  readonly autoUpgrade: { readonly enabled: boolean; readonly usedThisPeriod: boolean } | null;
  readonly use: {
    /** Each row's `id` is an Agent ID. */
    readonly byAgent: readonly UsageRow[];
    /** Each row's `id` is the Chickpea membership ID of the person who started the work. */
    readonly byPerson: readonly UsageRow[];
  };
  readonly offers: {
    /** The plans on sale, never a retired one. */
    readonly plans: readonly PlanOffer[];
    readonly extraUsage: readonly ExtraUsageOffer[];
    readonly ownKeyMinimumPlanKey: string;
  };
}

export type CheckoutRequest =
  | { readonly kind: 'plan'; readonly key: string }
  | { readonly kind: 'extra_usage'; readonly key: string };

/** A Stripe page to send the Owner to. */
export interface BillingRedirect {
  readonly url: string;
}

export interface PlatformBillingPort {
  summary(installationId: string): Promise<BillingSummary>;
  /**
   * Stripe Checkout for a plan or extra usage. `returnPath` is the Admin path,
   * on the host's own origin, where Stripe sends the Owner back.
   */
  checkout(installationId: string, request: CheckoutRequest, returnPath: string): Promise<BillingRedirect>;
  /** The Stripe customer portal: cards, invoices, and plan changes. */
  portal(installationId: string, returnPath: string): Promise<BillingRedirect>;
  /** An Owner's choice, in onboarding or later on the Plan page. Choosing the same funding again changes nothing. */
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
