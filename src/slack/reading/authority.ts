import type { WebClient } from '@slack/web-api';

import { CHICKPEA_AGENT_ID } from '../../config/agent-id.ts';
import { isRecord } from '../../security/content-validation.ts';
import { slackPlatformErrorCode } from '../errors.ts';
import { channelIncludesMember, type SlackApiInput, type SlackApiResult } from '../transport/shared.ts';
import { isConversationUnavailableError, SLACK_READ_AGENT_APP_INVITE, SlackReadError } from './errors.ts';

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
  /** @Chickpea itself: reads only the current conversation. */
  managementAgent: boolean;
  /** The Agent reads as its own Slack app's bot, so a channel without that bot needs it, not Chickpea's. */
  agentAppBot?: boolean;
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
  if (ports.managementAgent) throw new SlackReadError('current_conversation_only');
  await assertCurrentConversationNotShared(ports);

  const target = await ports.conversation(channelId);
  if (!target || target.im || target.mpim) throw new SlackReadError('not_available');
  if (target.teamId !== undefined && target.teamId !== ports.workspaceId) throw new SlackReadError('not_available');
  // Membership first: until the requester is known to be in the channel, no
  // answer may differ from "not available".
  if (!(await ports.isMember(channelId, ports.requesterSlackUserId))) throw new SlackReadError('not_available');
  if (!(await ports.hasActiveGrant(channelId))) throw new SlackReadError('needs_agent_access');
  if (!target.member) throw new SlackReadError('needs_bot_invite', ports.agentAppBot ? SLACK_READ_AGENT_APP_INVITE : undefined);
  return {
    id: channelId,
    ...(target.name ? { name: target.name } : {}),
    kind: conversationKind(target),
    current: false,
  };
}

/**
 * Rule 4, for anything read or looked up beyond the current conversation:
 * unknown facts fail closed, and a Slack Connect or org-shared conversation
 * refuses with `message` or the standard text.
 */
export async function assertCurrentConversationNotShared(
  ports: Pick<SlackReadAuthorityPorts, 'conversation' | 'current'>,
  message?: string,
): Promise<void> {
  const current = await ports.conversation(ports.current.channelId);
  if (!current) throw new SlackReadError('unavailable');
  if (current.shared) throw new SlackReadError('shared_conversation_only', message);
}

/** conversations.info's channel object as authority facts. */
export function slackReadConversationFacts(raw: unknown): SlackReadConversationFacts | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const channel = raw;
  const pending = Array.isArray(channel.pending_shared) && channel.pending_shared.length > 0;
  const teamId = typeof channel.context_team_id === 'string'
    ? channel.context_team_id
    : typeof channel.team_id === 'string' ? channel.team_id : undefined;
  return {
    id: raw.id,
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

/**
 * Authority ports over a Slack client. Both caches, conversation facts and
 * membership answers, live as long as the ports do: one render, so one turn.
 * The next turn asks Slack again, so a requester who left a channel cannot
 * read it on the next request. A transient failure is not cached.
 */
export function slackReadAuthorityPorts(input: {
  workspaceId: string;
  agentId: string;
  requesterSlackUserId: string;
  current: SlackReadCurrentConversation;
  client: Pick<WebClient, 'conversations'>;
  agentAppBot?: boolean;
  assertActive: SlackReadAuthorityPorts['assertActive'];
  hasActiveGrant: SlackReadAuthorityPorts['hasActiveGrant'];
}): SlackReadAuthorityPorts {
  const conversations = new Map<string, Promise<SlackReadConversationFacts | undefined>>();
  const members = new Map<string, Promise<boolean>>();
  const membersPage = async (page: SlackApiInput): Promise<SlackApiResult> =>
    (await input.client.conversations.members(page as { channel: string; limit?: number; cursor?: string })) as unknown as SlackApiResult;
  return {
    workspaceId: input.workspaceId,
    managementAgent: input.agentId === CHICKPEA_AGENT_ID,
    ...(input.agentAppBot ? { agentAppBot: true } : {}),
    requesterSlackUserId: input.requesterSlackUserId,
    current: input.current,
    assertActive: input.assertActive,
    hasActiveGrant: input.hasActiveGrant,
    conversation(channelId) {
      let facts = conversations.get(channelId);
      if (!facts) {
        facts = (async () => {
          try {
            const response = await input.client.conversations.info({ channel: channelId });
            return slackReadConversationFacts(response.channel);
          } catch (error) {
            if (isConversationUnavailableError(error)) return undefined;
            conversations.delete(channelId);
            throw new SlackReadError('unavailable');
          }
        })();
        conversations.set(channelId, facts);
      }
      return facts;
    },
    isMember(channelId, userId) {
      const key = `${channelId}\u0000${userId}`;
      const cached = members.get(key);
      if (cached) return cached;
      const member = (async () => {
        try {
          return await channelIncludesMember(membersPage, channelId, userId);
        } catch (error) {
          // A channel the app cannot see, or one too large to page through
          // (pagination_limit), fails closed.
          if (isConversationUnavailableError(error) || slackPlatformErrorCode(error) === 'pagination_limit') return false;
          members.delete(key);
          throw new SlackReadError('unavailable');
        }
      })();
      members.set(key, member);
      return member;
    },
  };
}
