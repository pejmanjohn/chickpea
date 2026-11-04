import { deploymentTenancy } from '../config/installation-scope.ts';
import type { DailyLimitScope } from '../config/platform-funding.ts';
import { getConfigStore, getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { IdentityStore } from '../identity/types.ts';
import { formatPriceCents, formatUsageDollars, usagePercent, type UsageMicros } from '../usage/usage-display.ts';
import { activeOwnerSlackUserIds, sendOwnerDm } from './credits-ask.ts';
import {
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from './installation-execution.ts';
import { slackDate, slackDateTime } from './ui/text.ts';

export interface UsageAlert {
  readonly threshold: 75 | 90 | 100;
  readonly usedMicros: UsageMicros;
  readonly includedMicros: UsageMicros;
  readonly periodEnd: Date;
  readonly onPacePercent: number | null;
  readonly runOutAt: Date | null;
  /** The plan auto-upgrade would move to, when enabled and unused this period; null otherwise. */
  readonly nextPlan: { readonly key: string; readonly priceCents: number } | null;
  readonly planPageUrl: string;
}

/** The first time in a day an installation's platform-funded usage is paused by a daily limit. */
export interface DailyLimitNotice {
  readonly scope: DailyLimitScope;
  readonly resumesAt: Date;
  readonly planPageUrl: string;
}

export interface UsageAlertMessage { readonly text: string; readonly blocks: readonly Record<string, unknown>[] }

export interface UsageAlertDependencies {
  identity?: Pick<IdentityStore, 'listMemberships' | 'listExternalIdentities'>;
  config?: Pick<ConfigStore, 'listWorkspaceInstallations'>;
  installationExecution?: SlackInstallationExecutionResolver;
}

type UsageAlertButton = 'upgrade' | 'choose_plan' | 'add_extra_usage' | 'turn_off_auto_upgrade';

const BUTTONS: Record<UsageAlertButton, { readonly actionId: string; readonly label: string }> = {
  upgrade: { actionId: 'chickpea.usage.v1.upgrade', label: 'Upgrade' },
  /** The same plan page; a trial workspace has no plan to upgrade. */
  choose_plan: { actionId: 'chickpea.usage.v1.upgrade', label: 'Choose a plan' },
  add_extra_usage: { actionId: 'chickpea.usage.v1.add_extra_usage', label: 'Add extra usage' },
  turn_off_auto_upgrade: { actionId: 'chickpea.usage.v1.turn_off_auto_upgrade', label: 'Turn off auto-upgrade' },
};

interface AlertCopy { readonly text: string; readonly buttons: readonly UsageAlertButton[] }

const ALERT_COPY: Record<UsageAlert['threshold'], (alert: UsageAlert) => AlertCopy> = {
  75: (alert) => ({ text: usageSentence(alert), buttons: [] }),
  90: (alert) => alert.nextPlan
    ? {
      text: `${usageSentence(alert)} When it runs out we'll move you to the ` +
        `${formatPriceCents(alert.nextPlan.priceCents)} plan so nothing stops. ` +
        'You can add extra usage instead, or turn auto-upgrade off.',
      buttons: ['add_extra_usage', 'turn_off_auto_upgrade'],
    }
    : {
      text: `${usageSentence(alert)} Add extra usage or upgrade so nothing stops.`,
      buttons: ['upgrade', 'add_extra_usage'],
    },
  100: () => ({
    text: "You've used all of your plan's usage. Add extra usage or upgrade to keep going.",
    buttons: ['upgrade', 'add_extra_usage'],
  }),
};

export function usageAlertMessage(alert: UsageAlert): UsageAlertMessage {
  const { text, buttons } = ALERT_COPY[alert.threshold](alert);
  return ownerMessage({ text, buttons }, alert.planPageUrl);
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

function ownerMessage({ text, buttons }: AlertCopy, planPageUrl: string): UsageAlertMessage {
  const section = { type: 'section', text: { type: 'mrkdwn', text } };
  if (buttons.length === 0) return { text, blocks: [section] };
  const actions = {
    type: 'actions',
    elements: buttons.map((button) => ({
      type: 'button',
      action_id: BUTTONS[button].actionId,
      text: { type: 'plain_text', text: BUTTONS[button].label, emoji: false },
      url: planPageUrl,
    })),
  };
  return { text, blocks: [section, actions] };
}

async function deliverToOwners(
  env: PlatformEnv | undefined,
  message: UsageAlertMessage,
  dependencies: UsageAlertDependencies,
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
      const owners = await activeOwnerSlackUserIds(identity, installation.workspaceId);
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

function usageSentence(alert: UsageAlert): string {
  const used = `You've used ${usagePercent(alert.usedMicros, alert.includedMicros)}% of your plan ` +
    `(${formatUsageDollars(alert.usedMicros, 'down')} of ${formatUsageDollars(alert.includedMicros)})`;
  return alert.runOutAt
    ? `${used}, on pace to run out around ${slackDate(alert.runOutAt.getTime())}.`
    : `${used}. Usage resets ${slackDate(alert.periodEnd.getTime())}.`;
}
