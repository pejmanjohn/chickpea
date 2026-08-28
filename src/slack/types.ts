import type { SlackInteractionIntent } from './interaction-intent.ts';

export interface SlackAppMentionEvent {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
  // Slack stamps these on app-authored mentions exactly as it does on
  // app-authored messages. They must be observable here so the same echo filter
  // can run: without it another bot that mentions this app starts a paid turn,
  // and this app's reply can mention it back.
  bot_id?: string;
  app_id?: string;
  bot_profile?: { app_id?: string };
  files?: SlackFileEvent[];
}

export interface SlackMessageEvent {
  type: 'message';
  channel: string;
  ts: string;
  event_ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  channel_type?: string;
  subtype?: string;
  deleted_ts?: string;
  message?: SlackMessageEvent;
  previous_message?: SlackMessageEvent;
  bot_id?: string;
  app_id?: string;
  bot_profile?: {
    app_id?: string;
    id?: string;
  };
  files?: SlackFileEvent[];
  /** Agent View context is deliberately discarded before turn normalization. */
  app_context?: unknown;
}

export interface SlackFileEvent {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
}

export interface SlackAttachmentReference {
  fileId: string;
}

export interface SlackAttachmentIntake {
  status: 'ok' | 'too_many' | 'invalid_metadata';
  count: number;
}

export interface SlackAppHomeOpenedEvent {
  type: 'app_home_opened';
  user: string;
  channel?: string;
  tab?: string;
  event_ts: string;
  /** Lifecycle context is presentation metadata, not execution input. */
  context?: unknown;
}

export interface SlackAppContextChangedEvent {
  type: 'app_context_changed';
  user: string;
  event_ts: string;
  /** Lifecycle context is acknowledged and discarded in this release. */
  context?: unknown;
}

export interface SlackMemberJoinedChannelEvent {
  type: 'member_joined_channel';
  user: string;
  channel: string;
  channel_type?: string;
  team?: string;
  inviter?: string;
  event_ts: string;
}

export interface SlackReactionAddedEvent {
  type: 'reaction_added';
  user: string;
  reaction: string;
  item: {
    type: string;
    channel?: string;
    ts?: string;
  };
  item_user?: string;
  event_ts: string;
}

export interface SlackAppUninstalledEvent {
  type: 'app_uninstalled';
}

export interface SlackTokensRevokedEvent {
  type: 'tokens_revoked';
  tokens?: {
    oauth?: string[];
    bot?: string[];
  };
}

export interface SlackUserChangeEvent {
  type: 'user_change';
  event_ts: string;
  user: {
    id: string;
    team_id?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
  };
}

export type SlackEvent =
  | SlackAppMentionEvent
  | SlackMessageEvent
  | SlackAppHomeOpenedEvent
  | SlackAppContextChangedEvent
  | SlackMemberJoinedChannelEvent
  | SlackReactionAddedEvent
  | SlackAppUninstalledEvent
  | SlackTokensRevokedEvent
  | SlackUserChangeEvent;

export interface SlackEventFixture {
  token: string;
  team_id: string;
  api_app_id: string;
  event_id: string;
  event_time: number;
  type: 'event_callback';
  event: SlackEvent;
}

export type SlackTurnSource =
  | 'app_mention'
  | 'agent_mention'
  | 'implicit_thread_reply'
  | 'dm_message'
  | 'reaction_added';
export type SlackContextMode = 'thread' | 'channel_history' | 'dm_history';
export type SlackTurnIgnoreReason =
  | 'non_event_callback'
  | 'self_message'
  | 'missing_bot_user_id'
  | 'unsupported_event_type'
  | 'message_subtype'
  | 'bot_message'
  | 'slack_system_user'
  | 'missing_user'
  | 'empty_text'
  | 'missing_thread_metadata'
  | 'unsupported_channel_type'
  | 'unaddressed_channel_message'
  | 'unsupported_reaction_item';

export interface NormalizedSlackTurn {
  workspaceId: string;
  channelId: string;
  eventId: string;
  text: string;
  userId: string;
  /** Product membership resolved from verified Slack truth before admission. */
  actorMembershipId?: string;
  messageTs: string;
  threadTs: string;
  sessionThreadTs?: string;
  source: SlackTurnSource;
  channelType?: string;
  contextMode: SlackContextMode;
  reaction?: string;
  reactionTargetTs?: string;
  /** Slack-verified text of the message that received an inbound reaction. */
  reactionTargetText?: string;
  /** Slack-authenticated file handles. File bytes and private URLs never enter durable state. */
  attachments?: SlackAttachmentReference[];
  /** Content-free intake result retained so rejected files never disappear silently. */
  attachmentIntake?: SlackAttachmentIntake;
  /** Content-free state snapshot used by the durable explicit-turn classifier. */
  activeWorkAtAdmission?: boolean;
  /** Host-validated preflight result carried into the durable TurnJob. */
  interactionIntent?: SlackInteractionIntent;
  /**
   * Opaque proposal selected by trusted admission from the exact requester,
   * Slack conversation, and acting Agent binding. Slack text cannot supply this id.
   */
  managementApprovalProposalId?: string;
}

export interface IgnoredSlackTurn {
  status: 'ignored';
  reason: SlackTurnIgnoreReason;
}

export interface RunnableSlackTurn {
  status: 'runnable';
  turn: NormalizedSlackTurn;
}

export type SlackTurnNormalization = RunnableSlackTurn | IgnoredSlackTurn;

export function isSlackAppMentionEvent(event: SlackEvent): event is SlackAppMentionEvent {
  return event.type === 'app_mention';
}

export function isSlackMessageEvent(event: SlackEvent): event is SlackMessageEvent {
  return event.type === 'message';
}

export function isSlackMemberJoinedChannelEvent(
  event: SlackEvent,
): event is SlackMemberJoinedChannelEvent {
  return event.type === 'member_joined_channel';
}

export function isSlackReactionAddedEvent(
  event: SlackEvent,
): event is SlackReactionAddedEvent {
  return event.type === 'reaction_added';
}
