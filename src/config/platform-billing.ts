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
  /** The extra usage offer auto top-up buys on this plan unless an Owner picks another; the plan cards disclose it. */
  readonly autoTopUpPackKey?: string;
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

/** What the Owner chose in Stripe's portal to happen to the plan at `at` instead of renewing it: it ends, or moves to another plan. */
export type PendingPlanChange =
  | { readonly kind: 'ends'; readonly at: Date }
  | { readonly kind: 'plan'; readonly plan: { readonly name: string }; readonly at: Date };

/** A saved card. `brand` is Stripe's card brand, such as "visa" or "amex". */
export interface CardSummary {
  /** Optional: a summary without `kind` is a card. */
  readonly kind?: 'card';
  readonly brand: string;
  readonly last4: string;
}

/** A saved Stripe Link payment method, which has no card digits to show. */
export interface LinkSummary {
  readonly kind: 'link';
}

export type PaymentMethodSummary = CardSummary | LinkSummary;

/**
 * Why auto top-up stopped charging until an Owner acts: a declined card, a
 * charge the bank asks the cardholder to confirm on Stripe's hosted `url`,
 * billing details too incomplete to tax an invoice, or a past-due plan.
 */
export type AutoTopUpPause =
  | { readonly kind: 'declined'; readonly at: Date }
  | { readonly kind: 'needs_confirmation'; readonly amountCents: number; readonly url: string }
  | { readonly kind: 'billing_details' }
  | { readonly kind: 'past_due' };

/**
 * Auto top-up on an installation with a plan. `rule: 'plan'` follows the
 * plan ("same as your plan"); `fixed` is what an Owner chose. Amounts are US
 * cents before tax.
 */
export interface AutoTopUpView {
  readonly enabled: boolean;
  /** An Owner turned it off, so it stays off through a cancel and a new plan. */
  readonly explicitlyOff: boolean;
  /** The extra usage offer each top-up buys. */
  readonly pack: { readonly rule: 'plan' | 'fixed'; readonly key: string };
  /** How much top-ups may charge each billing period. */
  readonly limit: { readonly rule: 'plan' | 'fixed'; readonly cents: number };
  /** Paid automatic top-ups this period, net of full refunds. */
  readonly usedCents: number;
  /** When `usedCents` starts over: the renewal. Null without a period. */
  readonly resetsAt: Date | null;
  readonly pause: AutoTopUpPause | null;
  /** The payment method top-ups charge, a card or Link; null when the default payment method is neither. */
  readonly card: PaymentMethodSummary | null;
}

/**
 * The version of the off-session charge authorization Admin shows an Owner
 * who turns auto top-up on or raises it. The page sends the version of the
 * copy it shows, so bump it with that copy and its copy of this constant in
 * assets/admin-ui/admin.js.
 */
export const AUTO_TOP_UP_CONSENT_VERSION = '2026-11-04';

/** The Owner acting in Admin, for the host's consent records and the other Owners' DM. */
export interface BillingActor {
  readonly membershipId: string;
  /** Null when the Owner has no Slack identity in this workspace. */
  readonly slackUserId: string | null;
}

export type AutoTopUpChange =
  | { readonly kind: 'off' }
  /** Turns it on, or changes it while on. */
  | {
    readonly kind: 'on';
    readonly pack: { readonly rule: 'plan' } | { readonly rule: 'fixed'; readonly key: string };
    readonly limit: { readonly rule: 'plan' } | { readonly rule: 'fixed'; readonly cents: number };
  }
  /** Pays a fresh attempt once, after a pause an Owner fixed. */
  | { readonly kind: 'retry' };

export interface AutoTopUpUpdate {
  readonly change: AutoTopUpChange;
  readonly by: BillingActor;
  /**
   * The version of the authorization the Owner agreed to with this change,
   * `AUTO_TOP_UP_CONSENT_VERSION`; null when the change raised neither the
   * pack nor the limit, so Admin showed none.
   */
  readonly consentVersion: string | null;
  /** The page's key for a `retry`, so the host can charge it once if the request arrives twice. */
  readonly idempotencyKey?: string;
}

/** What a plan change would do, for the in-app confirm. */
export type PlanChangePreview =
  /** Charged now, prorated, before tax; `addedMicros` of usage is granted with it. */
  | { readonly kind: 'upgrade'; readonly todayCents: number; readonly addedMicros: UsageMicros }
  /** Takes effect at `at`, the renewal; nothing is charged now. */
  | { readonly kind: 'downgrade'; readonly at: Date };

/** A purchase on the saved card: paid or scheduled, or a Stripe page to finish it on. */
export type SavedCardResult =
  | { readonly kind: 'done' }
  /** The bank asks the cardholder to confirm (SCA), or there is no saved card and Checkout takes over. */
  | { readonly kind: 'redirect'; readonly url: string };

/** The Owner's latest purchase, shown when they come back from Stripe; `granted` once its usage is added. */
export type RecentPurchase =
  | { readonly kind: 'extra_usage'; readonly granted: boolean; readonly usageMicros: UsageMicros }
  /**
   * `first` for the installation's first plan. `newPeriod` says whether the
   * purchase started a billing period, a first plan or a new plan after one
   * ended, so its usage is the whole period's; false for an upgrade, whose
   * `addedMicros` covers the rest of the period. Without `newPeriod`, only a
   * first plan reads as a new period.
   */
  | {
    readonly kind: 'plan'; readonly granted: boolean; readonly first: boolean; readonly addedMicros: UsageMicros;
    readonly newPeriod?: boolean;
  };

export interface BillingSummary {
  readonly funding: BillingFunding;
  /** Null without a plan: a trial, or an own-key installation that never chose one. */
  readonly plan: { readonly key: string; readonly name: string; readonly priceCents: number } | null;
  /** The billing period `use` covers; its end is when the plan renews. */
  readonly period: { readonly start: Date; readonly end: Date } | null;
  /** Null when the plan renews unchanged, or there is no plan. */
  readonly pendingChange: PendingPlanChange | null;
  /** The plan's meter; null without a plan period. */
  readonly planUsage: {
    readonly usedMicros: UsageMicros;
    readonly includedMicros: UsageMicros;
    readonly onPacePercent: number | null;
  } | null;
  readonly rollover: { readonly remainingMicros: UsageMicros; readonly expiresAt: Date } | null;
  /**
   * Remaining extra usage; frozen while `plan` is null, with the soonest
   * expiry. `totalMicros` is what the packs that still have usage left held
   * when bought, for the extra usage bar; without it Admin shows no bar.
   */
  readonly extraUsage: {
    readonly remainingMicros: UsageMicros;
    readonly frozen: boolean;
    readonly expiresAt: Date;
    readonly totalMicros?: UsageMicros;
  } | null;
  /** `grantedMicros` is what the trial started with. */
  readonly trial: { readonly remainingMicros: UsageMicros; readonly grantedMicros: UsageMicros; readonly expiresAt: Date } | null;
  readonly debtMicros: UsageMicros;
  /** @deprecated Admin no longer reads it, and a later Core removes it. */
  readonly autoUpgrade?: { readonly enabled: boolean; readonly usedThisPeriod: boolean } | null;
  /**
   * Absent where the host offers no auto top-up, and Admin shows none of it.
   * Null where it offers it but there is no plan to top up.
   */
  readonly autoTopUp?: AutoTopUpView | null;
  /** Absent where the host does not report it; Admin then shows no return banner. */
  readonly lastPurchase?: RecentPurchase | null;
  /**
   * Plan usage this period the host holds for the installation's own key,
   * such as an own-key-only discount's share, and grants when it switches to
   * its own key. Absent where the host does not report it; null when it holds
   * none.
   */
  readonly heldForOwnKey?: { readonly usageMicros: UsageMicros } | null;
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
    /** The flat usage a task draws on top of its model tokens, unless extra usage pays it. */
    readonly taskFeeMicros: UsageMicros;
    /** The flat usage a task paid from extra usage draws. Absent where the host charges `taskFeeMicros` either way. */
    readonly extraUsageTaskFeeMicros?: UsageMicros;
    /** The flat usage a chat reply draws on top of its model tokens. */
    readonly chatReplyFeeMicros: UsageMicros;
    /**
     * The model tokens a typical task draws on the default model with models
     * included, the chat around it counted in. Task estimates with models
     * included assume it.
     */
    readonly typicalTaskMicros: UsageMicros;
    /** How many months unused plan usage carries over at renewal; 0 for none. */
    readonly rolloverMonths: number;
  };
}

export type CheckoutRequest =
  | { readonly kind: 'plan'; readonly key: string }
  | { readonly kind: 'extra_usage'; readonly key: string };

/** A Stripe page to send the Owner to. */
export interface BillingRedirect {
  readonly url: string;
}

export type BillingRefusalReason =
  | 'plan_required'
  | 'own_key_plan_required'
  /** Auto top-up, or a purchase on the saved card, needs a card or Link. */
  | 'card_required'
  /** The plan's last invoice is unpaid, so the host takes no new charge. */
  | 'past_due';

/** A billing action the host refused for a reason the Owner can fix, which Admin shows instead of an outage. */
export class BillingRefusal extends Error {
  constructor(readonly reason: BillingRefusalReason) {
    super(`The host refused the billing action: ${reason}.`);
    this.name = 'BillingRefusal';
  }
}

/**
 * One run's billed usage on one UTC day, whatever paid for it: model and fee
 * charges less what creditBack restored. Usage is
 * `modelMicros + feeMicros - creditedBackMicros`.
 */
export interface BilledUsageRow {
  /**
   * The run key Core gave the ledger: `RunRef.runId`, `FeePost.runId` and
   * `ModelRequestRecord.runId`, which is the Flue submission ID, not Core's
   * Work run ID. Null for rows that name no run.
   */
  readonly runId: string | null;
  /** The UTC day the rows were written, `YYYY-MM-DD`. */
  readonly day: string;
  readonly modelMicros: UsageMicros;
  /** Chat and task fees. */
  readonly feeMicros: UsageMicros;
  /** Whether a task fee is among `feeMicros`. */
  readonly task: boolean;
  /** What creditBack restored, as a positive amount. */
  readonly creditedBackMicros: UsageMicros;
}

export interface BilledUsage {
  readonly rows: readonly BilledUsageRow[];
}

export interface PlatformBillingPort {
  summary(installationId: string): Promise<BillingSummary>;
  /**
   * Stripe Checkout for a plan or extra usage. `returnPath` is the Admin path,
   * on the host's own origin, where Stripe sends the Owner back. Throws
   * `BillingRefusal` for extra usage without a plan (`plan_required`) or a
   * plan below the lowest one for an own key (`own_key_plan_required`); any
   * other throw is an outage. `by` is the Owner who started it, for the
   * consent record a plan's Checkout writes; Admin always passes it.
   */
  checkout(installationId: string, request: CheckoutRequest, returnPath: string, by?: BillingActor): Promise<BillingRedirect>;
  /** The Stripe customer portal: cards, invoices, and plan changes. */
  portal(installationId: string, returnPath: string): Promise<BillingRedirect>;
  /**
   * An Owner's choice, in onboarding or later on the Plan page. Choosing the
   * same funding again changes nothing. Throws `BillingRefusal`
   * (`own_key_plan_required`) for an own key below the lowest plan for it;
   * any other throw is an outage.
   */
  chooseFunding(installationId: string, funding: BillingFunding): Promise<void>;
  /**
   * Optional. Billed usage written in `[from, to)`, by run and UTC day,
   * whatever paid for it. Over a billing period the rows total
   * `use.byAgent`, the Plan page's "Usage this period". The plan meter,
   * `planUsage.usedMicros`, differs when rollover or extra usage paid, a
   * top-up paid off debt, debt was carried in, or a refund revoked part of
   * the plan grant. Admin's Usage page shows amounts only while the host
   * answers; without the method, or when it throws, the page shows activity
   * counts.
   */
  usage?(installationId: string, range: { readonly from: Date; readonly to: Date }): Promise<BilledUsage>;
  /**
   * An Owner's auto top-up change. Takes effect at once; the host writes a
   * consent record when `consentVersion` is set and DMs the other Owners.
   * Throws `BillingRefusal` (`plan_required`, `card_required`, `past_due`).
   */
  updateAutoTopUp?(installationId: string, update: AutoTopUpUpdate): Promise<void>;
  /** With `changePlan`, the in-app plan change; without both, a plan change opens Checkout. */
  previewPlanChange?(installationId: string, planKey: string): Promise<PlanChangePreview>;
  /**
   * Changes the plan on the saved card: an upgrade is charged now, a
   * downgrade waits for the renewal. `consentVersion` is set when the upgrade
   * raises auto top-up's limit or pack that follow the plan. Throws `BillingRefusal`
   * (`card_required`, `past_due`).
   */
  changePlan?(installationId: string, request: {
    readonly planKey: string; readonly by: BillingActor; readonly consentVersion: string | null;
    /** One per confirm the Owner opened, so the host charges a repeated request once. */
    readonly idempotencyKey?: string;
  }): Promise<SavedCardResult>;
  /** Extra usage on the saved card; without it, extra usage opens Checkout. `idempotencyKey` as for `changePlan`. */
  buyExtraUsage?(installationId: string, request: {
    readonly key: string; readonly by: BillingActor; readonly idempotencyKey?: string;
  }): Promise<SavedCardResult>;
}

let port: PlatformBillingPort | undefined;

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configurePlatformBilling(next: PlatformBillingPort | undefined): void {
  port = next;
}

export function platformBilling(): PlatformBillingPort | undefined {
  return port;
}
