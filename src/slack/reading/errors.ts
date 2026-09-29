import { slackPlatformErrorCode } from '../errors.ts';

/**
 * Why a Slack read did not return messages. Refusals never say whether a
 * private channel exists: `not_available` covers "no such channel", "not a
 * member", and "a DM that is not this conversation" alike. The more specific
 * codes are used only when the requester is already a member of the channel,
 * so they reveal nothing the requester cannot see in Slack.
 */
export type SlackReadErrorCode =
  | 'not_available'
  | 'needs_agent_access'
  | 'needs_bot_invite'
  | 'current_conversation_only'
  | 'shared_conversation_only'
  | 'requester_unavailable'
  | 'agent_unavailable'
  | 'rate_limited'
  | 'read_limit'
  | 'result_too_large'
  | 'invalid_link'
  | 'invalid_target'
  | 'invalid_cursor'
  | 'not_found'
  | 'unavailable';

export class SlackReadError extends Error {
  constructor(
    readonly code: SlackReadErrorCode,
    message: string = SLACK_READ_MESSAGES[code],
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'SlackReadError';
  }
}

export const SLACK_READ_MESSAGES: Record<SlackReadErrorCode, string> = {
  not_available: 'That conversation is not available to read here. It may not exist, the requester may not be a member, or it may be a direct message other than this one.',
  needs_agent_access: 'This Agent has not been added to that channel, so it cannot read it. An admin can add the Agent to the channel in Chickpea.',
  needs_bot_invite: 'The Chickpea app is not in that channel yet. Someone in the channel can invite it; the Agent also needs access there.',
  current_conversation_only: 'From here I can read only this conversation. To read another channel, ask an Agent that has been added there.',
  shared_conversation_only: 'In a channel shared with another organization, I can read only this conversation, so nothing from other channels is posted where the other organization can see it.',
  requester_unavailable: 'The person asking no longer has active Chickpea access.',
  agent_unavailable: 'This Agent is no longer available.',
  rate_limited: 'Slack lets this app read older messages about once a minute. Answer from what you have and say what you could not read yet.',
  read_limit: 'This request already made the maximum number of Slack reads. Answer from what you have.',
  result_too_large: 'The result exceeds the tool limit. Ask for fewer messages with limit.',
  invalid_link: 'That is not a Slack message or channel link from this workspace.',
  invalid_target: 'Pass a Slack link, or a channel id with an optional message timestamp.',
  invalid_cursor: 'That cursor does not belong to this conversation. Start again without a cursor.',
  not_found: 'That message or person was not found.',
  unavailable: 'Slack could not be read right now. Try again later or answer from what you have.',
};

/**
 * Slack's answers for a conversation the app cannot see: missing, private
 * without the bot, or withheld. All three read as "not available" so a
 * refusal never distinguishes a private channel from a nonexistent one.
 */
export function isConversationUnavailableError(error: unknown): boolean {
  const code = slackPlatformErrorCode(error);
  return code === 'channel_not_found' || code === 'not_in_channel' || code === 'access_denied';
}
