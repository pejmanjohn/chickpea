import { deploymentTenancy } from '../config/installation-scope.ts';
import { getConfigStore, getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { IdentityStore } from '../identity/types.ts';
import { formatPriceCents, formatUsageDollars, usagePercent, type UsageMicros } from '../usage/usage-display.ts';
import { activeOwnerSlackUserIds, sendOwnerDm } from './credits-ask.ts';
import {
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from './installation-execution.ts';

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

export interface UsageAlertMessage { readonly text: string; readonly blocks: readonly Record<string, unknown>[] }

export interface UsageAlertDependencies {
  identity?: Pick<IdentityStore, 'listMemberships' | 'listExternalIdentities'>;
  config?: Pick<ConfigStore, 'listWorkspaceInstallations'>;
  installationExecution?: SlackInstallationExecutionResolver;
}

type UsageAlertButton = 'upgrade' | 'add_extra_usage' | 'turn_off_auto_upgrade';

const BUTTONS: Record<UsageAlertButton, { readonly actionId: string; readonly label: string }> = {
  upgrade: { actionId: 'chickpea.usage.v1.upgrade', label: 'Upgrade' },
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

const UTC_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function usageAlertMessage(alert: UsageAlert): UsageAlertMessage {
  const { text, buttons } = ALERT_COPY[alert.threshold](alert);
  const section = { type: 'section', text: { type: 'mrkdwn', text } };
  if (buttons.length === 0) return { text, blocks: [section] };
  const actions = {
    type: 'actions',
    elements: buttons.map((button) => ({
      type: 'button',
      action_id: BUTTONS[button].actionId,
      text: { type: 'plain_text', text: BUTTONS[button].label, emoji: false },
      url: alert.planPageUrl,
    })),
  };
  return { text, blocks: [section, actions] };
}

export async function deliverUsageAlert(
  env: PlatformEnv | undefined,
  alert: UsageAlert,
  dependencies: UsageAlertDependencies = {},
): Promise<'sent' | 'no_owner'> {
  if (deploymentTenancy(env) !== 'installation') return 'no_owner';
  const identity = dependencies.identity ?? getIdentityStore(env);
  const config = dependencies.config ?? getConfigStore(env);
  const resolveExecution = dependencies.installationExecution ??
    ((workspaceId: string) => resolveSlackInstallationExecutionContext(workspaceId, env));
  const message = usageAlertMessage(alert);
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
    ? `${used}, on pace to run out around ${slackDate(alert.runOutAt)}.`
    : `${used}. Usage resets ${slackDate(alert.periodEnd)}.`;
}

function slackDate(date: Date): string {
  return `<!date^${Math.floor(date.getTime() / 1000)}^{date_short}|${UTC_DATE.format(date)}>`;
}
