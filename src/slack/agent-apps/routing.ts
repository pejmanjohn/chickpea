import type { CustomAgentConfig } from '../../config/types.ts';
import type { NormalizedSlackTurn } from '../types.ts';
import { agentAppIsLive } from './lifecycle.ts';

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export type AgentAppRouteSelection = { kind: 'select'; agentId: string } | { kind: 'ignore' };

/**
 * An Agent app's own ingress selects its Agent. On Chickpea's ingress a
 * Channel message that mentions a live Agent-app bot is that bot's to answer,
 * so it is ignored here; the same text in Chickpea's DM is Chickpea's.
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
