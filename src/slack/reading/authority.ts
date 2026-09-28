import { SlackReadError, SLACK_READ_MESSAGES } from './errors.ts';

/** What Slack says about a conversation, reduced to what authority needs. */
export interface SlackReadConversationFacts {
  id: string;
  name?: string;
  /** context_team_id, else team_id: the workspace that owns the conversation. */
  teamId?: string;
  im: boolean;
  mpim: boolean;
  private: boolean;
  /** The app's bot is in the conversation. */
  member: boolean;
  /** Any Slack Connect or cross-workspace sharing, pending or not. */
  shared: boolean;
}

export interface SlackReadCurrentConversation {
  channelId: string;
  threadTs: string;
  messageTs: string;
}

export interface SlackReadAuthorityPorts {
  workspaceId: string;
  agentId: string;
  /** @Chickpea itself: reads only the current conversation. */
  managementAgent: boolean;
  requesterSlackUserId: string;
  current: SlackReadCurrentConversation;
  /** Throws a SlackReadError when the requester or the Agent is no longer active. */
  assertActive(): Promise<void>;
  /** undefined when Slack does not show the conversation to the app. */
  conversation(channelId: string): Promise<SlackReadConversationFacts | undefined>;
  /** Whether a Slack user is in the conversation. Throws on a transient failure. */
  isMember(channelId: string, userId: string): Promise<boolean>;
  /** Whether this Agent holds an active grant for the channel. */
  hasActiveGrant(channelId: string): Promise<boolean>;
}

export interface AuthorizedSlackConversation {
  id: string;
  name?: string;
  kind: 'channel' | 'private_channel' | 'dm';
  current: boolean;
}

/**
 * Decide, at the tool boundary and on every call, whether the Agent may read
 * a conversation for this requester. Model text, links, and message content
 * never expand this: the rules read only stored grants and live Slack truth.
 *
 * 1. The requester is still an active Chickpea member and the Agent enabled.
 * 2. The current conversation is always readable.
 * 3. @Chickpea reads nothing else.
 * 4. From a Slack Connect or org-shared conversation, nothing else is read,
 *    so internal content never lands where another organization can see it.
 * 5. Another conversation must be in this workspace, not a DM or group DM,
 *    have the requester as a member, an active grant for this Agent, and the
 *    app's bot as a member. A refusal reveals nothing the requester cannot
 *    already see in Slack.
 */
export async function authorizeSlackRead(
  ports: SlackReadAuthorityPorts,
  channelId: string,
): Promise<AuthorizedSlackConversation> {
  await ports.assertActive();
  if (channelId === ports.current.channelId) {
    const facts = await ports.conversation(channelId).catch(() => undefined);
    return {
      id: channelId,
      ...(facts?.name ? { name: facts.name } : {}),
      kind: facts ? conversationKind(facts) : channelId.startsWith('D') ? 'dm' : 'channel',
      current: true,
    };
  }
  if (ports.managementAgent) throw refusal('current_conversation_only');

  const current = await ports.conversation(ports.current.channelId);
  if (!current) throw refusal('unavailable');
  if (current.shared) throw refusal('shared_conversation_only');

  const target = await ports.conversation(channelId);
  if (!target || target.im || target.mpim) throw refusal('not_available');
  if (target.teamId !== undefined && target.teamId !== ports.workspaceId) throw refusal('not_available');
  // Membership first: until the requester is known to be in the channel, no
  // answer may differ from "not available".
  if (!(await ports.isMember(channelId, ports.requesterSlackUserId))) throw refusal('not_available');
  if (!(await ports.hasActiveGrant(channelId))) throw refusal('needs_agent_access');
  if (!target.member) throw refusal('needs_bot_invite');
  return {
    id: channelId,
    ...(target.name ? { name: target.name } : {}),
    kind: conversationKind(target),
    current: false,
  };
}

/** conversations.info's channel object as authority facts. */
export function slackReadConversationFacts(raw: unknown): SlackReadConversationFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const channel = raw as Record<string, unknown>;
  if (typeof channel.id !== 'string') return undefined;
  const pending = Array.isArray(channel.pending_shared) && channel.pending_shared.length > 0;
  const teamId = typeof channel.context_team_id === 'string'
    ? channel.context_team_id
    : typeof channel.team_id === 'string' ? channel.team_id : undefined;
  return {
    id: channel.id,
    ...(typeof channel.name === 'string' && channel.name ? { name: channel.name } : {}),
    ...(teamId ? { teamId } : {}),
    im: channel.is_im === true,
    mpim: channel.is_mpim === true,
    private: channel.is_private === true || channel.is_group === true,
    member: channel.is_member === true,
    shared: channel.is_shared === true || channel.is_ext_shared === true ||
      channel.is_org_shared === true || channel.is_pending_ext_shared === true || pending,
  };
}

function conversationKind(facts: SlackReadConversationFacts): AuthorizedSlackConversation['kind'] {
  if (facts.im) return 'dm';
  return facts.private ? 'private_channel' : 'channel';
}

function refusal(code: 'not_available' | 'needs_agent_access' | 'needs_bot_invite' |
  'current_conversation_only' | 'shared_conversation_only' | 'unavailable'): SlackReadError {
  return new SlackReadError(code, SLACK_READ_MESSAGES[code]);
}
