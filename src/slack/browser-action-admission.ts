import { resolveBrowserActionReply } from '../browser/actions.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { slackBrowserActionReply } from './interaction-intent.ts';
import { conversationThreadTs } from './thread-key.ts';
import type { NormalizedSlackTurn } from './types.ts';

/**
 * Admission for an exact "approve" or "stop" that answers a browser step the
 * routed Agent is holding for this same person in this same thread. On a
 * match the pending action is answered, an approval is stamped onto the turn
 * (bound to this message), and the turn is marked to reach the Agent, which
 * reads the reply. Returns whether the reply answered a pending action.
 */
export async function admitSlackBrowserActionReply(input: {
  turn: NormalizedSlackTurn;
  assignment: Pick<ResolvedAssignment, 'agent' | 'runtimeContract'>;
  settings: SettingsStore;
  actorMembershipId?: string | undefined;
  now?: number;
}): Promise<boolean> {
  const word = slackBrowserActionReply(input.turn.text);
  if (!word) return false;
  const { turn } = input;
  const answer = await resolveBrowserActionReply({
    settings: input.settings,
    word,
    scope: {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      // The same thread coordinate the Agent's Slack signal carries.
      threadTs: conversationThreadTs(turn, input.assignment.runtimeContract),
      agentId: input.assignment.agent.id,
      actorSlackUserId: turn.userId,
      ...(input.actorMembershipId ? { actorMembershipId: input.actorMembershipId } : {}),
    },
    messageTs: turn.messageTs,
    ...(input.now === undefined ? {} : { now: input.now }),
  }).catch(() => undefined);
  if (!answer) return false;
  if (answer.kind === 'approved') turn.approvedBrowserActionId = answer.id;
  turn.interactionIntent = { disposition: 'reply', reason: 'substantive_request' };
  return true;
}
