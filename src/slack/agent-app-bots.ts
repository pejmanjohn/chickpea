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
export function agentAppBots(agents: readonly CustomAgentConfig[]): AgentAppBot[] {
  return agents.flatMap((agent) => {
    const app = agent.slackPresence?.kind === 'agent_app' ? agent.slackPresence.app : undefined;
    return app && 'botUserId' in app && app.botUserId ? [{ agentId: agent.id, botUserId: app.botUserId }] : [];
  });
}

/** Without the host's Agent-app port no app is served, and nothing is read. */
export async function listAgentAppBots(config: Pick<ConfigStore, 'listAgents'>): Promise<AgentAppBot[]> {
  return agentSlackAppsHost() ? agentAppBots(await config.listAgents()) : [];
}
