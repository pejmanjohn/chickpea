import type { ConfigStore } from '../config/store.ts';
import type { CustomAgentConfig } from '../config/types.ts';
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
  const app = agent.slackPresence?.kind === 'agent_app' ? agent.slackPresence.app : undefined;
  return app && 'botUserId' in app && app.botUserId ? app.botUserId : undefined;
}

/**
 * How a person addresses an Agent in Slack, for an exact command: its user
 * group, or its own app's bot while the host serves Agent apps.
 */
export function agentSlackAddress(
  agent: Pick<CustomAgentConfig, 'slackPresence'> | undefined,
): { agentUserGroupId?: string; agentBotUserId?: string } {
  const userGroupId = agent?.slackPresence?.userGroupId;
  const botUserId = agent && agentSlackAppsHost() ? appBotUserId(agent) : undefined;
  return { ...(userGroupId ? { agentUserGroupId: userGroupId } : {}), ...(botUserId ? { agentBotUserId: botUserId } : {}) };
}

/** Without the host's Agent-app port no app is served, and nothing is read. */
export async function listAgentAppBots(config: Pick<ConfigStore, 'listAgentAppBots'>): Promise<AgentAppBot[]> {
  return agentSlackAppsHost() ? config.listAgentAppBots() : [];
}
