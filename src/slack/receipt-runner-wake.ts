import type { ConfigStoreLogic } from '../config/store.ts';
import { parseAgentUserGroupMentions } from './agent-routing.ts';
import type { GatewayInboundDelivery } from './gateway/protocol.ts';
import { slackAgentThreadKey } from './thread-key.ts';
import { normalizeSlackTurn } from './turn-normalization.ts';

/** The state store's own reads at a delivery's receipt; no Slack call. */
export type ReceiptWakeReads = Pick<ConfigStoreLogic, 'getWorkspaceInstallation' | 'getAgentThreadRoute' | 'listAgents'>;

export interface ReceiptRunnerWake {
  /** The key the turn's hand-off addresses its runner by (`slackAgentThreadKey`). */
  threadKey: string;
  /** The turn the delivery would become: admission keys a person's message by its channel and ts. */
  turnJobId: string;
}

/**
 * The thread runner a just-received delivery's turn will be handed to, keyed
 * as `slackAgentThreadKey` keys it once admission has routed the turn; or
 * undefined when the delivery cannot become a turn by what the state store
 * knows at receipt.
 *
 * Only a person's message is woken for: one that mentions the app, a DM, a
 * top-level mention of one of this installation's Agents, or a reply in a
 * thread an Agent already owns. Never a reaction (its thread is found by a
 * Slack read), a click or modal submission, an edit or delete, a join, a
 * profile or lifecycle event, a bot or system message, an unaddressed
 * Channel message, a reply in a thread no Agent owns, or a delivery to an
 * installation that is not chickpea-v1. The owner is the stored route's: a
 * message that hands the thread to another Agent is admitted under the next
 * incarnation, so its wake reached the previous owner's runner.
 */
export function receiptRunnerWake(
  delivery: GatewayInboundDelivery,
  reads: ReceiptWakeReads,
): ReceiptRunnerWake | undefined {
  if (delivery.kind !== 'event.deliver') return undefined;
  const { envelope } = delivery;
  const installation = reads.getWorkspaceInstallation(envelope.workspaceId);
  if (
    !installation || installation.health === 'revoked' || installation.transportMode !== 'gateway' ||
    installation.runtimeContract !== 'chickpea-v1' || !installation.botUserId
  ) return undefined;
  const normalized = normalizeSlackTurn({
    token: '',
    team_id: envelope.workspaceId,
    api_app_id: installation.appId ?? '',
    event_id: envelope.eventId,
    event_time: envelope.eventTime,
    type: 'event_callback',
    event: envelope.event,
  }, { botUserId: installation.botUserId });
  if (normalized.status !== 'runnable') return undefined;
  const { turn } = normalized;
  const route = reads.getAgentThreadRoute(turn.workspaceId, turn.channelId, turn.threadTs);
  const becomesTurn = turn.source === 'app_mention' || turn.source === 'dm_message' ||
    (turn.source === 'implicit_thread_reply' && route !== undefined) ||
    (turn.source === 'agent_mention' && mentionsAnAgent(turn.text, reads));
  if (!becomesTurn) return undefined;
  return {
    threadKey: slackAgentThreadKey(turn, {
      runtimeContract: 'chickpea-v1',
      ownerIncarnation: route?.ownerIncarnation ?? 1,
    }),
    turnJobId: `msg:${turn.channelId}:${turn.messageTs}`,
  };
}

/** A group the text mentions is one of this installation's Agents, not a group of people. */
function mentionsAnAgent(text: string, reads: Pick<ReceiptWakeReads, 'listAgents'>): boolean {
  const groups = new Set(parseAgentUserGroupMentions(text));
  return reads.listAgents().some((agent) =>
    agent.kind === 'user' && agent.slackPresence?.userGroupId !== undefined &&
    groups.has(agent.slackPresence.userGroupId));
}
