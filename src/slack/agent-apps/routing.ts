import type { CustomAgentConfig } from '../../config/types.ts';
import { agentAppBots } from '../agent-app-bots.ts';
import { slackConversationKind } from '../thread-key.ts';
import type { NormalizedSlackTurn } from '../types.ts';
import { agentSlackAppsHost } from './host.ts';
import { agentAppIsLive } from './lifecycle.ts';

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export type AgentAppRouteSelection = { kind: 'select'; agentId: string } | { kind: 'ignore' };

/**
 * The bot an Agent posts as through its own Slack app: its app's bot while
 * that app is live and the host serves Agent apps. Undefined for any other
 * Agent, and for every Agent without the port, which then posts as Chickpea's.
 */
export function agentAppPostingBot(agent: CustomAgentConfig): string | undefined {
  return agentSlackAppsHost() && agentAppIsLive(agent.slackPresence) ? agent.slackPresence.app.botUserId : undefined;
}

/**
 * The Agent each Agent-app bot names, while the host serves Agent apps: every
 * app whose record names its bot, live or not, since Chickpea's bot answers
 * for an app that cannot.
 */
export function agentsByAppBot(agents: readonly CustomAgentConfig[]): Map<string, CustomAgentConfig> {
  return agentSlackAppsHost() ? appAgentsByBot(agents) : new Map();
}

function appAgentsByBot(agents: readonly CustomAgentConfig[]): Map<string, CustomAgentConfig> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return new Map(agentAppBots(agents).map(({ agentId, botUserId }) => [botUserId, byId.get(agentId)!]));
}

/**
 * An Agent app's own delivery selects its Agent only for a mention of its own
 * bot, in a Channel or a group DM, or a message in its own DM; anything else it
 * hears routes as it would on Chickpea's delivery. On Chickpea's delivery a
 * Channel or group DM message that names an Agent app's bot is ignored while
 * that app can answer there, so one bot answers whichever delivery arrives
 * first; it is routed here when the app cannot (`appAnswersHere`): its bot is
 * not a member, the app is not live, or its token cannot be read. The same
 * text in Chickpea's DM is Chickpea's.
 */
export async function agentAppRouteSelection(
  turn: Pick<NormalizedSlackTurn, 'text' | 'source' | 'channelType'>,
  agents: readonly CustomAgentConfig[],
  agentApp: { agentId: string } | undefined,
  appAnswersHere: (agent: CustomAgentConfig) => Promise<boolean>,
): Promise<AgentAppRouteSelection | undefined> {
  const conversation = slackConversationKind(turn);
  if (agentApp) {
    const ownAddress = conversation === 'im' ? turn.source === 'dm_message' : turn.source === 'app_mention';
    return ownAddress ? { kind: 'select', agentId: agentApp.agentId } : undefined;
  }
  if (conversation === 'im') return undefined;
  const apps = appAgentsByBot(agents);
  for (const match of turn.text.matchAll(USER_MENTION)) {
    const agent = apps.get(match[1]!);
    if (agent && await appAnswersHere(agent)) return { kind: 'ignore' };
  }
  return undefined;
}
