import type { ConfigStore } from '../config/store.ts';
import { answeringUserGroupId, appRecordOf, type CustomAgentConfig } from '../config/types.ts';
import { agentSlackAppsHost } from './agent-apps/host.ts';

/** The bot user an Agent's own Slack app posts as. */
export interface AgentAppBot {
  agentId: string;
  botUserId: string;
}

/**
 * The bots of this installation's Agent apps. An app counts while its record
 * names its bot (live, being removed, or needing attention), so a post Slack
 * delivers late still reads as its Agent's.
 */
export function agentAppBots(agents: readonly Pick<CustomAgentConfig, 'id' | 'slackPresence'>[]): AgentAppBot[] {
  return agents.flatMap((agent) => {
    const botUserId = appBotUserId(agent);
    return botUserId ? [{ agentId: agent.id, botUserId }] : [];
  });
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

/**
 * Without the host's Agent-app port no app is served, and nothing is read;
 * nor when the installation record the caller already holds says no Agent
 * here has an app record (`agentApps: false`).
 */
export async function listAgentAppBots(
  config: Pick<ConfigStore, 'listAgentAppBots'>,
  installation: { agentApps?: boolean } | undefined,
): Promise<AgentAppBot[]> {
  return agentSlackAppsHost() && installation?.agentApps !== false ? config.listAgentAppBots() : [];
}
