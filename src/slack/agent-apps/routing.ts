import type { CustomAgentConfig } from '../../config/types.ts';
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
 * An Agent app's own ingress selects its Agent. On Chickpea's ingress a
 * Channel message that mentions a live Agent-app bot is that bot's to answer,
 * so it is ignored there unless the caller finds a user-group Agent named in it
 * too; the same text in Chickpea's DM is Chickpea's.
 */
export function agentAppRouteSelection(
  turn: Pick<NormalizedSlackTurn, 'text'>,
  surface: 'channel' | 'direct',
  agents: readonly CustomAgentConfig[],
  agentApp: { agentId: string } | undefined,
): AgentAppRouteSelection | undefined {
  if (agentApp) return { kind: 'select', agentId: agentApp.agentId };
  if (surface !== 'channel') return undefined;
  const liveBots = new Set(
    agents.flatMap((agent) => agentAppIsLive(agent.slackPresence) ? [agent.slackPresence.app.botUserId] : []),
  );
  if (liveBots.size === 0) return undefined;
  for (const match of turn.text.matchAll(USER_MENTION)) {
    if (liveBots.has(match[1]!)) return { kind: 'ignore' };
  }
  return undefined;
}
