import { formatTasks, type TaskRates } from '../admin/billing-tasks.ts';
import { deploymentTenancy } from '../config/installation-scope.ts';
import type { BillingActor, BillingFunding, CardSummary } from '../config/platform-billing.ts';
import type { DailyLimitScope } from '../config/platform-funding.ts';
import { getConfigStore, getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { IdentityStore } from '../identity/types.ts';
import { formatCard, formatPriceCents, formatUsageDollars, usagePercent, type UsageMicros } from '../usage/usage-display.ts';
import { activeOwnerSlackUserIds, sendOwnerDm } from './credits-ask.ts';
import {
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from './installation-execution.ts';
import { slackDate, slackDateTime } from './ui/text.ts';

const MICROS_PER_CENT = 10_000;

export interface UsageAlert {
  readonly threshold: 75 | 90 | 100;
  readonly usedMicros: UsageMicros;
  readonly includedMicros: UsageMicros;
  readonly periodEnd: Date;
  readonly onPacePercent: number | null;
  readonly runOutAt: Date | null;
  /** @deprecated Ignored; auto-upgrade is gone. A later Core removes it. */
  readonly nextPlan?: { readonly key: string; readonly priceCents: number } | null;
  readonly planPageUrl: string;
  /** Absent or null when the host doesn't say, which keeps the copy that names no auto top-up. */
  readonly autoTopUp?:
    | { readonly enabled: true; readonly packCents: number; readonly limitCents: number; readonly usedCents: number }
    | { readonly enabled: false }
    | null;
  /** At 100 only: the extra usage the Agents draw on now. */
  readonly extraUsage?: {
    readonly remainingMicros: UsageMicros;
    readonly tasks?: ({ readonly funding: BillingFunding } & TaskRates) | null;
  } | null;
}

/** The first time in a day an installation's platform-funded usage is paused by a daily limit. */
export interface DailyLimitNotice {
  readonly scope: DailyLimitScope;
  readonly resumesAt: Date;
  readonly planPageUrl: string;
}

interface PlanAmounts { readonly priceCents: number; readonly includedMicros: UsageMicros }

/** An auto top-up event, or a pause, every active Owner hears about. */
export type OwnerBillingNotice = { readonly planPageUrl: string } & (
  | {
    readonly kind: 'top_up_added';
    readonly packCents: number;
    readonly usedCents: number;
    readonly limitCents: number;
    readonly validMonths: number;
    readonly card?: CardSummary | null;
    readonly receiptUrl?: string | null;
  }
  | {
    readonly kind: 'top_up_limit';
    readonly limitCents: number;
    readonly usedCents: number;
    readonly resumesAt: Date | null;
    readonly plan?: PlanAmounts | null;
    readonly nextPlan?: PlanAmounts | null;
  }
  | { readonly kind: 'top_up_declined'; readonly card?: CardSummary | null }
  | { readonly kind: 'top_up_unconfirmed'; readonly amountCents: number }
  | { readonly kind: 'billing_details' }
  | {
    readonly kind: 'auto_top_up_changed';
    /** Hears nothing: they made the change. */
    readonly by: BillingActor;
    readonly change:
      | { readonly kind: 'off' }
      | {
        readonly kind: 'on' | 'changed';
        readonly packCents: number;
        readonly limitCents: number;
        readonly previous?: { readonly packCents: number; readonly limitCents: number } | null;
      };
  }
  | { readonly kind: 'out'; readonly resumesAt: Date | null }
);

export interface UsageAlertMessage { readonly text: string; readonly blocks: readonly Record<string, unknown>[] }

export interface UsageAlertDependencies {
  identity?: Pick<IdentityStore, 'listMemberships' | 'listExternalIdentities'>;
  config?: Pick<ConfigStore, 'listWorkspaceInstallations'>;
  installationExecution?: SlackInstallationExecutionResolver;
}

/** Where on the Plan page a button opens it. */
type PlanStep = 'add' | 'upgrade' | 'raise-limit' | 'card' | 'auto-top-up';

type ButtonKind =
  | 'upgrade' | 'upgrade_plan' | 'choose_plan' | 'add_extra_usage' | 'add_usage' | 'see_options' | 'open_plan'
  | 'change_auto_top_up' | 'turn_on_auto_top_up' | 'raise_limit' | 'view_receipt'
  | 'update_card' | 'try_again' | 'confirm_payment' | 'update_billing_details';

/** URL buttons: nothing handles their actions, but Slack wants each id unique within its block. */
const BUTTONS: Record<ButtonKind, { readonly actionId: string; readonly label: string; readonly step: PlanStep | null }> = {
  upgrade: { actionId: 'chickpea.usage.v1.upgrade', label: 'Upgrade', step: 'upgrade' },
  upgrade_plan: { actionId: 'chickpea.usage.v1.upgrade', label: 'Upgrade plan', step: 'upgrade' },
  /** The same plan page; a trial workspace has no plan to upgrade. */
  choose_plan: { actionId: 'chickpea.usage.v1.upgrade', label: 'Choose a plan', step: null },
  add_extra_usage: { actionId: 'chickpea.usage.v1.add_extra_usage', label: 'Add extra usage', step: 'add' },
  add_usage: { actionId: 'chickpea.usage.v1.add_extra_usage', label: 'Add usage', step: 'add' },
  see_options: { actionId: 'chickpea.usage.v1.see_options', label: 'See options', step: null },
  open_plan: { actionId: 'chickpea.usage.v1.open_plan', label: 'Open Plan', step: null },
  change_auto_top_up: { actionId: 'chickpea.usage.v1.change_auto_top_up', label: 'Change auto top-up', step: 'auto-top-up' },
  turn_on_auto_top_up: { actionId: 'chickpea.usage.v1.turn_on_auto_top_up', label: 'Turn on auto top-up', step: 'auto-top-up' },
  raise_limit: { actionId: 'chickpea.usage.v1.raise_limit', label: 'Raise limit', step: 'raise-limit' },
  view_receipt: { actionId: 'chickpea.usage.v1.view_receipt', label: 'View receipt', step: null },
  update_card: { actionId: 'chickpea.usage.v1.update_card', label: 'Update card', step: 'card' },
  try_again: { actionId: 'chickpea.usage.v1.try_again', label: 'Try again', step: 'card' },
  confirm_payment: { actionId: 'chickpea.usage.v1.confirm_payment', label: 'Confirm payment', step: 'card' },
  update_billing_details: { actionId: 'chickpea.usage.v1.update_billing_details', label: 'Update billing details', step: 'card' },
};

type Button = ButtonKind | { readonly kind: ButtonKind; readonly label?: string; readonly url?: string };

interface MessageCopy {
  readonly text: string;
  /** A second paragraph. */
  readonly detail?: string;
  /** Small print under the text. */
  readonly context?: string;
  readonly buttons: readonly Button[];
  /** Styles the first button as the one to press. */
  readonly primary?: boolean;
}

const ALERT_COPY: Record<UsageAlert['threshold'], (alert: UsageAlert) => MessageCopy> = {
  75: (alert) => {
    const usage = usageSentence(alert);
    const topUp = alert.autoTopUp;
    if (!topUp) return { text: usage, buttons: [] };
    return topUp.enabled
      ? { text: `${usage} If it runs out, auto top-up adds ${formatPriceCents(topUp.packCents)} so nothing stops.`, buttons: [] }
      : {
        text: `${usage} If it runs out, your Agents pause until your plan renews ${slackDate(alert.periodEnd.getTime())}.`,
        buttons: ['see_options'],
      };
  },
  90: (alert) => {
    const usage = usageSentence(alert);
    const topUp = alert.autoTopUp;
    if (!topUp) return { text: `${usage} Add extra usage or upgrade so nothing stops.`, buttons: ['upgrade', 'add_extra_usage'] };
    if (topUp.enabled && topUp.usedCents + topUp.packCents > topUp.limitCents) {
      return {
        text: `${usage} When it runs out, your Agents pause until ${slackDate(alert.periodEnd.getTime())}, because auto top-up ` +
          'reached its limit for this month. Raise the limit or upgrade so nothing stops.',
        buttons: ['raise_limit', 'upgrade_plan'],
        primary: true,
      };
    }
    if (topUp.enabled) {
      const left = topUp.limitCents - topUp.usedCents;
      return {
        text: `${usage} When it runs out, auto top-up adds ${formatPriceCents(topUp.packCents)} of extra usage so nothing stops. ` +
          `It can add up to ${formatPriceCents(left)} this month.`,
        buttons: ['change_auto_top_up'],
      };
    }
    return {
      text: `${usage} When it runs out, your Agents pause until ${slackDate(alert.periodEnd.getTime())}. ` +
        'Add usage, upgrade, or turn on auto top-up so nothing stops.',
      buttons: ['add_usage', 'upgrade_plan', 'turn_on_auto_top_up'],
      primary: true,
    };
  },
  100: (alert) => {
    const extra = alert.extraUsage;
    if (!extra || extra.remainingMicros <= 0) {
      return {
        text: "You've used all of your plan's usage. Add extra usage or upgrade to keep going.",
        buttons: ['upgrade', 'add_extra_usage'],
      };
    }
    const tasks = extra.tasks ? formatTasks(extra.remainingMicros, extra.tasks.funding, extra.tasks) : null;
    const taskCount = !tasks || tasks === '0' ? '' : `, ${tasks} ${tasks === '1' ? 'task' : 'tasks'}`;
    return {
      text: "You've used all of your plan's usage for this month. Your Agents are now using extra usage, " +
        `with ${formatUsageDollars(extra.remainingMicros, 'down')} left${taskCount}.`,
      buttons: [],
    };
  },
};

export function usageAlertMessage(alert: UsageAlert): UsageAlertMessage {
  return ownerMessage(ALERT_COPY[alert.threshold](alert), alert.planPageUrl);
}

/** The limit's day can end in the reader's afternoon, so the copy never says "today". */
export function dailyLimitNoticeMessage(notice: DailyLimitNotice): UsageAlertMessage {
  const until = slackDateTime(notice.resumesAt.getTime());
  const text = notice.scope === 'workspace'
    ? `This workspace has reached its daily trial limit, so Chickpea is paused until ${until}. ` +
      'Choose a plan to continue now.'
    : `Chickpea has paused trial usage for now, so this workspace's requests are paused until ${until}. ` +
      'Choose a plan to continue now.';
  return ownerMessage({ text, buttons: ['choose_plan'] }, notice.planPageUrl);
}

export function ownerBillingNoticeMessage(notice: OwnerBillingNotice): UsageAlertMessage {
  return ownerMessage(noticeCopy(notice), notice.planPageUrl);
}

function noticeCopy(notice: OwnerBillingNotice): MessageCopy {
  switch (notice.kind) {
    case 'top_up_added': {
      const limit = notice.usedCents >= notice.limitCents
        ? `That's your ${formatPriceCents(notice.limitCents)} limit for this month.`
        : `That's ${formatPriceCents(notice.usedCents)} of your ${formatPriceCents(notice.limitCents)} limit this month.`;
      const receiptUrl = httpsUrl(notice.receiptUrl);
      return {
        text: `Auto top-up added ${formatPriceCents(notice.packCents)} of extra usage, so your Agents keep working.`,
        context: `Charged to ${formatCard(notice.card) ?? 'your card'}, plus tax. ` +
          `Extra usage keeps ${notice.validMonths} ${notice.validMonths === 1 ? 'month' : 'months'} while you have a plan. ${limit}`,
        buttons: [
          ...(receiptUrl ? [{ kind: 'view_receipt', url: receiptUrl } as const] : []),
          ...(notice.usedCents + notice.packCents > notice.limitCents ? ['raise_limit' as const] : []),
        ],
      };
    }
    case 'top_up_limit': {
      const paused = notice.resumesAt ? `paused until ${slackDate(notice.resumesAt.getTime())}.` : 'paused.';
      const { plan, nextPlan } = notice;
      return {
        text: `Your workspace has used this month's usage and its ${formatPriceCents(notice.limitCents)} auto top-up, ` +
          `so your Agents are ${paused}`,
        ...(plan && nextPlan
          ? {
            detail: `Your ${formatPriceCents(plan.priceCents)} plan and ${formatPriceCents(notice.usedCents)} of top-ups ` +
              `covered ${formatUsageDollars((plan.includedMicros + notice.usedCents * MICROS_PER_CENT) as UsageMicros)} of usage this month. ` +
              `The ${formatPriceCents(nextPlan.priceCents)} plan includes ${formatUsageDollars(nextPlan.includedMicros)} ` +
              'of usage a month.',
          }
          : {}),
        buttons: nextPlan
          ? [{ kind: 'upgrade', label: `Upgrade to ${formatPriceCents(nextPlan.priceCents)}` }, 'raise_limit']
          : ['raise_limit'],
        primary: true,
      };
    }
    case 'top_up_declined':
      return {
        text: `Auto top-up couldn't charge ${formatCard(notice.card) ?? 'your card'}. ` +
          'The card was declined, so your Agents are paused.',
        buttons: ['update_card', 'try_again'],
        primary: true,
      };
    case 'top_up_unconfirmed':
      return {
        text: `Your bank wants you to confirm a ${formatPriceCents(notice.amountCents)} auto top-up charge. ` +
          'Confirm it to keep your Agents working.',
        buttons: ['confirm_payment'],
        primary: true,
      };
    case 'billing_details':
      return {
        text: "Auto top-up couldn't add usage because your billing details are incomplete. " +
          'Update them to keep your Agents working.',
        buttons: ['update_billing_details'],
        primary: true,
      };
    case 'auto_top_up_changed': {
      const name = actorName(notice.by);
      const { change } = notice;
      if (change.kind === 'off') {
        return {
          text: `${name} turned off auto top-up. When usage runs out, your Agents pause until your plan renews.`,
          buttons: ['open_plan'],
        };
      }
      const { previous } = change;
      if (change.kind === 'changed' && previous && previous.packCents === change.packCents &&
        previous.limitCents !== change.limitCents) {
        const moved = change.limitCents > previous.limitCents ? 'raised' : 'lowered';
        return { text: `${name} ${moved} the auto top-up limit to ${formatPriceCents(change.limitCents)} a month.`, buttons: [] };
      }
      return {
        text: `${name} ${change.kind === 'on' ? 'turned on' : 'changed'} auto top-up. When usage runs out, it adds ` +
          `${formatPriceCents(change.packCents)} of extra usage, up to ${formatPriceCents(change.limitCents)} a month.`,
        buttons: ['open_plan'],
      };
    }
    case 'out':
      return notice.resumesAt
        ? {
          text: 'Your workspace is out of usage, so your Agents are paused until your plan renews ' +
            `${slackDate(notice.resumesAt.getTime())}.`,
          buttons: ['add_usage', 'upgrade_plan', 'turn_on_auto_top_up'],
          primary: true,
        }
        : { text: 'Your workspace is out of usage, so your Agents are paused.', buttons: ['add_usage'], primary: true };
  }
}

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

function actorName(by: BillingActor): string {
  return by.slackUserId && SLACK_USER_ID.test(by.slackUserId) ? `<@${by.slackUserId}>` : 'An Owner';
}

export async function deliverUsageAlert(
  env: PlatformEnv | undefined,
  alert: UsageAlert,
  dependencies: UsageAlertDependencies = {},
): Promise<'sent' | 'no_owner'> {
  return deliverToOwners(env, usageAlertMessage(alert), dependencies);
}

export async function deliverDailyLimitNotice(
  env: PlatformEnv | undefined,
  notice: DailyLimitNotice,
  dependencies: UsageAlertDependencies = {},
): Promise<'sent' | 'no_owner'> {
  return deliverToOwners(env, dailyLimitNoticeMessage(notice), dependencies);
}

export async function deliverOwnerBillingNotice(
  env: PlatformEnv | undefined,
  notice: OwnerBillingNotice,
  dependencies: UsageAlertDependencies = {},
): Promise<'sent' | 'no_owner'> {
  const except = notice.kind === 'auto_top_up_changed' ? notice.by : undefined;
  return deliverToOwners(env, ownerBillingNoticeMessage(notice), dependencies, except);
}

function ownerMessage(copy: MessageCopy, planPageUrl: string): UsageAlertMessage {
  const blocks: Record<string, unknown>[] = [section(copy.text)];
  if (copy.detail) blocks.push(section(copy.detail));
  if (copy.context) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: copy.context }] });
  const elements = copy.buttons.flatMap((button) => {
    const use = typeof button === 'string' ? { kind: button } : button;
    const spec = BUTTONS[use.kind];
    const url = use.url ?? planUrl(planPageUrl, spec.step);
    if (!url) return [];
    return [{
      type: 'button',
      action_id: spec.actionId,
      text: { type: 'plain_text', text: use.label ?? spec.label, emoji: false },
      url,
    }];
  });
  if (elements.length > 0) {
    blocks.push({
      type: 'actions',
      elements: elements.map((element, index) => copy.primary && index === 0 ? { ...element, style: 'primary' } : element),
    });
  }
  return { text: copy.text, blocks };
}

function section(text: string): Record<string, unknown> {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/** The Plan page opened at `step`; null when the host's URL doesn't parse, which drops the button. */
function planUrl(planPageUrl: string, step: PlanStep | null): string | null {
  if (!step) return planPageUrl;
  try {
    const url = new URL(planPageUrl);
    url.searchParams.set('step', step);
    return url.toString();
  } catch {
    return null;
  }
}

function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

async function deliverToOwners(
  env: PlatformEnv | undefined,
  message: UsageAlertMessage,
  dependencies: UsageAlertDependencies,
  except?: BillingActor,
): Promise<'sent' | 'no_owner'> {
  if (deploymentTenancy(env) !== 'installation') return 'no_owner';
  const identity = dependencies.identity ?? getIdentityStore(env);
  const config = dependencies.config ?? getConfigStore(env);
  const resolveExecution = dependencies.installationExecution ??
    ((workspaceId: string) => resolveSlackInstallationExecutionContext(workspaceId, env));
  const installations = await config.listWorkspaceInstallations().catch(() => {
    console.warn('[chickpea] A usage alert could not read the workspace installations');
    return [];
  });
  let sent = 0;
  for (const installation of installations) {
    if (installation.health === 'revoked') continue;
    try {
      let owners = await activeOwnerSlackUserIds(identity, installation.workspaceId);
      if (except) {
        const actor = await actorSlackUserIds(identity, except);
        owners = owners.filter((owner) => !actor.has(owner));
      }
      if (owners.length === 0) continue;
      const { client } = await resolveExecution(installation.workspaceId);
      for (const owner of owners) {
        if (await sendOwnerDm(client, owner, message)) sent += 1;
      }
    } catch {
      console.warn("[chickpea] A usage alert could not reach this workspace's Owners");
    }
  }
  return sent > 0 ? 'sent' : 'no_owner';
}

async function actorSlackUserIds(
  identity: Pick<IdentityStore, 'listExternalIdentities'>,
  actor: BillingActor,
): Promise<Set<string>> {
  const bindings = await identity.listExternalIdentities();
  const ids = bindings.filter((binding) => binding.membershipId === actor.membershipId).map((binding) => binding.slackUserId);
  return new Set(actor.slackUserId ? [...ids, actor.slackUserId] : ids);
}

function usageSentence(alert: UsageAlert): string {
  const used = `You've used ${usagePercent(alert.usedMicros, alert.includedMicros)}% of your plan ` +
    `(${formatUsageDollars(alert.usedMicros, 'down')} of ${formatUsageDollars(alert.includedMicros)})`;
  return alert.runOutAt
    ? `${used}, on pace to run out around ${slackDate(alert.runOutAt.getTime())}.`
    : `${used}. Usage resets ${slackDate(alert.periodEnd.getTime())}.`;
}
