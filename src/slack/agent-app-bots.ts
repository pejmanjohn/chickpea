import type { ConfigStore } from '../config/store.ts';
import { answeringUserGroupId, appRecordOf, type CustomAgentConfig } from '../config/types.ts';
import { agentSlackAppsHost } from './agent-apps/host.ts';

/**
 * An Agent's own Slack app: the bot user it posts as, and its app ID. A
 * removed app's record keeps the app but not its bot, so its posts are
 * known by the app ID alone.
 */
export type AgentAppBot =
  | { agentId: string; botUserId: string; appId?: string }
  | { agentId: string; appId: string; botUserId?: never };

/**
 * The Agent apps of this installation. An app counts while its record names
 * its bot (live, being removed, or needing attention), so a post Slack
 * delivers late still reads as its Agent's; and once installed, by its app
 * ID alone, so posts made before Slack removed it do too. An app still being
 * made has posted nothing and does not count.
 */
export function agentAppBots(agents: readonly Pick<CustomAgentConfig, 'id' | 'slackPresence'>[]): AgentAppBot[] {
  return agents.flatMap((agent): AgentAppBot[] => {
    const botUserId = appBotUserId(agent);
    const appId = installedAppId(agent);
    if (botUserId) return [{ agentId: agent.id, botUserId, ...(appId ? { appId } : {}) }];
    return appId ? [{ agentId: agent.id, appId }] : [];
  });
}

function installedAppId(agent: Pick<CustomAgentConfig, 'slackPresence'>): string | undefined {
  const lifecycle = appRecordOf(agent.slackPresence);
  if (lifecycle?.state !== 'active' && lifecycle?.state !== 'uninstalling' && lifecycle?.state !== 'needs_attention') return undefined;
  return lifecycle.app?.appId;
}

/** The bot users and app IDs of Agent apps, as a reader takes its siblings: posts by any of them are Agents'. */
export function agentAppSiblings(bots: readonly AgentAppBot[]): { siblingBotUserIds: string[]; siblingAppIds: string[] } {
  return {
    siblingBotUserIds: bots.flatMap((bot) => bot.botUserId ? [bot.botUserId] : []),
    siblingAppIds: bots.flatMap((bot) => bot.appId ? [bot.appId] : []),
  };
}

function appBotUserId(agent: Pick<CustomAgentConfig, 'slackPresence'>): string | undefined {
  const app = appRecordOf(agent.slackPresence);
  return app && 'botUserId' in app && app.botUserId ? app.botUserId : undefined;
}

/**
 * How a person addresses an Agent in Slack, for an exact command: the user
 * group that answers for it (a released group while it still answers), or its
 * own app's bot while the host serves Agent apps.
 */
export function agentSlackAddress(
  agent: Pick<CustomAgentConfig, 'slackPresence'> | undefined,
): { agentUserGroupId?: string; agentBotUserId?: string } {
  const userGroupId = answeringUserGroupId(agent?.slackPresence);
  const botUserId = agent && agentSlackAppsHost() ? appBotUserId(agent) : undefined;
  return { ...(userGroupId ? { agentUserGroupId: userGroupId } : {}), ...(botUserId ? { agentBotUserId: botUserId } : {}) };
}

/** Without the host's Agent-app port no app is served, and nothing is read. */
export async function listAgentAppBots(config: Pick<ConfigStore, 'listAgentAppBots'>): Promise<AgentAppBot[]> {
  return agentSlackAppsHost() ? config.listAgentAppBots() : [];
}
