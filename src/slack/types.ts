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
  blocks?: unknown[];
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
  edited?: { ts: string };
  message?: SlackMessageEvent;
  previous_message?: SlackMessageEvent;
  bot_id?: string;
  app_id?: string;
  bot_profile?: {
    app_id?: string;
    id?: string;
  };
  files?: SlackFileEvent[];
  blocks?: unknown[];
  /** Agent View context is deliberately discarded before turn normalization. */
  app_context?: unknown;
}

interface SlackFileEvent {
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

interface SlackMemberJoinedChannelEvent {
  type: 'member_joined_channel';
  user: string;
  channel: string;
  channel_type?: string;
  team?: string;
  inviter?: string;
  event_ts: string;
}

interface SlackReactionAddedEvent {
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

interface SlackAppUninstalledEvent {
  type: 'app_uninstalled';
}

interface SlackTokensRevokedEvent {
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

/**
 * Someone pressed Stop on an Agent Session's working indicator (sent only to
 * apps subscribed to it). Slack does not move the session out of
 * `processing`: the app does, once its work has stopped. Parsed defensively
 * (`parseSlackAgentSessionStopped`); every field may be absent or malformed.
 */
export interface SlackAgentSessionStoppedEvent {
  type: 'agent_session_stopped';
  /** The person who pressed Stop. */
  user: string;
  channel: string;
  /** The Agent Session's thread. */
  thread_ts: string;
  /** When Stop was pressed: the stop's cutoff (KTD2). */
  event_ts: string;
  /** Streams Slack halted; empty when none was active. */
  streaming_message_ts?: string[];
}

export type SlackEvent =
  | SlackAgentSessionStoppedEvent
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
type SlackTurnIgnoreReason =
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
  /** Verified requester Slack profile timezone for schedule defaults. */
  requesterTimezone?: string;
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
  /**
   * A pending browser action this exact reply approved at admission, for the
   * same requester, thread, and Agent. The action is bound to this message's
   * timestamp; Slack text cannot supply the id.
   */
  approvedBrowserActionId?: string;
  /**
   * Set only by host click admission: this turn is a person's answer to a
   * durable Slack surface, not typed text. It never enters text-based approval
   * matching; only a host-namespace click can stamp an approval above.
   */
  uiResponse?: SlackUiResponse;
  /**
   * Set only by host admission of an Agent-to-Agent ask: another Chickpea
   * Agent mentioned this turn's Agent in a message it delivered. `userId` is
   * then the person whose message started the exchange (their access
   * authorizes the turn); `text` and `messageTs` are the asking Agent's
   * message. Slack text can never supply it.
   */
  agentAsk?: SlackAgentAsk;
  /**
   * Set only by host admission when one person's message mentioned several
   * Agents: all of them, in mention order, and this turn's place among them.
   * Each answers in turn in the thread; the first owns it.
   */
  coAddressed?: SlackCoAddressed;
}

export interface SlackCoAddressed {
  agents: Array<{ agentId: string; name: string; handle: string }>;
  position: number;
}

/** Who asked, and which person's message the exchange of asks started from. */
export interface SlackAgentAsk {
  fromAgentId: string;
  fromAgentName: string;
  fromAgentHandle?: string;
  /** The person's message that started this exchange; bounds its asks. */
  originMessageTs: string;
  /**
   * The thread's own Agent, when it started this chain of asks: a guest's
   * reply that asks nobody is handed back to it (see `processSlackAgentAsks`).
   */
  threadOwnerAgentId?: string;
  /** This turn is a teammate's answer handed back to the thread's own Agent. */
  handedBack?: true;
  /**
   * The person's message that started this exchange asked to remember or
   * forget something. Only the hand-back to the thread's own Agent acts on it.
   */
  personAskedToRemember?: true;
}

export interface SlackUiResponse {
  surfaceId: string;
  namespace: 'ui' | 'host';
  kind: string;
  /** Index of the chosen control on the surface. */
  choice: number;
  /** Selected values, for pickers and multi-selects. */
  values?: string[];
}

interface IgnoredSlackTurn {
  status: 'ignored';
  reason: SlackTurnIgnoreReason;
}

interface RunnableSlackTurn {
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

/** A Stop button press whose every field is usable (KTD5). */
export interface SlackStopButtonPress {
  userId: string;
  channelId: string;
  threadTs: string;
  /** The stop's cutoff: posted before it means held by the stop. */
  eventTs: string;
}

const SLACK_EVENT_ID = /^[A-Z0-9]{2,64}$/;
const SLACK_EVENT_TS = /^\d{1,12}\.\d{1,9}$/;

/**
 * A Slack message or event timestamp of the exact shape a stop's cutoff and
 * the rows it is compared with need (KTD2): seconds, a dot, a fraction.
 */
export function validSlackTs(value: unknown): value is string {
  return typeof value === 'string' && SLACK_EVENT_TS.test(value);
}

/**
 * Read an `agent_session_stopped` event defensively: Slack documents
 * `user`, `channel`, `thread_ts` and `event_ts`, and a press missing any of
 * them (or carrying an unexpected shape) cannot be tied to a run.
 */
export function parseSlackAgentSessionStopped(event: unknown): SlackStopButtonPress | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const value = event as Record<string, unknown>;
  if (value.type !== 'agent_session_stopped') return undefined;
  const { user, channel, thread_ts: threadTs, event_ts: eventTs } = value;
  if (typeof user !== 'string' || !SLACK_EVENT_ID.test(user)) return undefined;
  if (typeof channel !== 'string' || !SLACK_EVENT_ID.test(channel)) return undefined;
  if (!validSlackTs(threadTs) || !validSlackTs(eventTs)) return undefined;
  return { userId: user, channelId: channel, threadTs, eventTs };
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
