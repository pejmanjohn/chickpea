import assert from 'node:assert/strict';

import { parseSlackManagementSignal, type SlackManagementSignal } from '../../src/management/slack-tools.ts';
import { handBackMayRemember, personRequestText } from '../../src/slack/agent-asks.ts';
import type { NormalizedSlackTurn } from '../../src/slack/types.ts';

export function slackTurnSignal(input: {
  turn: Pick<NormalizedSlackTurn, 'text' | 'agentAsk' | 'eventId' | 'messageTs'>;
  agentId: string;
  conversation: { workspaceId: string; channelId: string; threadTs: string };
  conversationKind: 'channel' | 'im';
  slackUserId: string;
  threadGuest?: true;
}): SlackManagementSignal {
  const requesterText = personRequestText(input.turn);
  const assignment = input.threadGuest ? { threadGuest: input.threadGuest } : {};
  const signal = parseSlackManagementSignal({
    kind: 'signal',
    type: 'slack.message',
    tagName: 'slack_message',
    body: input.turn.text,
    attributes: {
      ...input.conversation,
      conversationKind: input.conversationKind,
      slackUserId: input.slackUserId,
      eventId: input.turn.eventId,
      messageTs: input.turn.messageTs,
      turnJobId: `turn_${input.turn.eventId}`,
      ...(requesterText === undefined ? {} : { requesterText }),
      ...(handBackMayRemember(input.turn, assignment) ? { personAskedToRemember: 'true' } : {}),
    },
  } as Parameters<typeof parseSlackManagementSignal>[0], {
    agentId: input.agentId,
    conversation: input.conversation,
  } as Parameters<typeof parseSlackManagementSignal>[1]);
  assert.ok(signal);
  return signal;
}
