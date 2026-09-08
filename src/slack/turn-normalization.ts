import {
  isSlackAppMentionEvent,
  isSlackMessageEvent,
  isSlackReactionAddedEvent,
  type NormalizedSlackTurn,
  type SlackContextMode,
  type SlackEventFixture,
  type SlackAttachmentReference,
  type SlackAttachmentIntake,
  type SlackMessageEvent,
  type SlackTurnNormalization,
  type SlackTurnSource,
} from './types.ts';
import type { SlackInboundEnvelope } from './transport/types.ts';

interface SlackTurnNormalizationOptions {
  botUserId?: string;
}

/** Strip Slack's transport wrapper into the credential-free runtime envelope. */
export function normalizeSlackInboundEnvelope(
  payload: SlackEventFixture,
): SlackInboundEnvelope | undefined {
  if (
    payload.type !== 'event_callback' ||
    !payload.team_id ||
    !payload.event_id ||
    !Number.isFinite(payload.event_time)
  ) return undefined;
  return {
    workspaceId: payload.team_id,
    eventId: payload.event_id,
    eventTime: payload.event_time,
    event: payload.event,
  };
}

interface RunnableTurnInput {
  payload: SlackEventFixture;
  channelId: string;
  text: string;
  userId: string;
  messageTs: string;
  threadTs: string;
  sessionThreadTs?: string;
  source: SlackTurnSource;
  channelType?: string;
  contextMode: SlackContextMode;
  reaction?: string;
  reactionTargetTs?: string;
  attachments?: SlackAttachmentReference[];
  attachmentIntake?: SlackAttachmentIntake;
}

const MAX_SLACK_ATTACHMENTS_PER_TURN = 4;

export function normalizeSlackTurn(
  payload: SlackEventFixture,
  options: SlackTurnNormalizationOptions,
): SlackTurnNormalization {
  payload = stripSlackMessageAppContext(payload);
  if (!normalizeSlackInboundEnvelope(payload)) {
    return { status: 'ignored', reason: 'non_event_callback' };
  }

  if (isSlackAppMentionEvent(payload.event)) {
    if (isSlackSystemUser(payload.event.user)) {
      return { status: 'ignored', reason: 'slack_system_user' };
    }
    if (options.botUserId && payload.event.user === options.botUserId) {
      return { status: 'ignored', reason: 'self_message' };
    }
    // The self-check above only catches this app's own user id. Any OTHER app
    // that mentions this one would otherwise drive a full billable turn, and
    // this app's reply can mention it back — an unbounded two-bot loop with a
    // model call per hop. The message branch already refuses app-authored
    // events; mentions must refuse them on the same terms.
    if (isAppAuthoredMessage(payload.event)) {
      return { status: 'ignored', reason: 'bot_message' };
    }
    // A webhook-authored mention can arrive with no `user` at all. Without an
    // author there is no actor to authorize, so fail closed rather than run a
    // turn attributed to the empty string.
    if (!payload.event.user) {
      return { status: 'ignored', reason: 'missing_user' };
    }

    const attachmentSet = normalizeSlackAttachments(payload.event);
    return runnableTurn({
      payload,
      channelId: payload.event.channel,
      text: payload.event.text,
      userId: payload.event.user,
      messageTs: payload.event.ts,
      threadTs: payload.event.thread_ts ?? payload.event.ts,
      source: 'app_mention',
      contextMode: payload.event.thread_ts ? 'thread' : 'channel_history',
      ...(attachmentSet.references.length > 0 ? { attachments: attachmentSet.references } : {}),
      ...(attachmentSet.intake ? { attachmentIntake: attachmentSet.intake } : {}),
    });
  }

  if (isSlackReactionAddedEvent(payload.event)) {
    const event = payload.event;
    if (isSlackSystemUser(event.user)) {
      return { status: 'ignored', reason: 'slack_system_user' };
    }
    if (options.botUserId && event.user === options.botUserId) {
      return { status: 'ignored', reason: 'self_message' };
    }
    if (event.item.type !== 'message' || !event.item.channel || !event.item.ts) {
      return { status: 'ignored', reason: 'unsupported_reaction_item' };
    }
    if (!event.user || !event.reaction || !event.event_ts) {
      return { status: 'ignored', reason: 'missing_thread_metadata' };
    }
    return runnableTurn({
      payload,
      channelId: event.item.channel,
      text: `Reacted :${event.reaction}: to the Slack message at ${event.item.ts}.`,
      userId: event.user,
      messageTs: event.event_ts,
      threadTs: event.item.ts,
      source: 'reaction_added',
      contextMode: 'thread',
      reaction: event.reaction,
      reactionTargetTs: event.item.ts,
    });
  }

  if (!isSlackMessageEvent(payload.event)) {
    return { status: 'ignored', reason: 'unsupported_event_type' };
  }

  const event = payload.event;
  if (event.subtype && event.subtype !== 'file_share') {
    return { status: 'ignored', reason: 'message_subtype' };
  }
  if (isAppAuthoredMessage(event)) {
    return { status: 'ignored', reason: 'bot_message' };
  }
  if (!event.user) {
    return { status: 'ignored', reason: 'missing_user' };
  }
  if (isSlackSystemUser(event.user)) {
    return { status: 'ignored', reason: 'slack_system_user' };
  }
  if (options.botUserId && event.user === options.botUserId) {
    return { status: 'ignored', reason: 'self_message' };
  }
  const attachmentSet = normalizeSlackAttachments(event);
  const attachments = attachmentSet.references;
  const text = event.text?.trim() ||
    (attachmentSet.intake ? 'Please inspect the attached file.' : '');
  if (!text) {
    return { status: 'ignored', reason: 'empty_text' };
  }
  if (!event.channel || !event.ts) {
    return { status: 'ignored', reason: 'missing_thread_metadata' };
  }

  if (options.botUserId && text.includes(`<@${options.botUserId}>`)) {
    return runnableTurn({
      payload,
      channelId: event.channel,
      text,
      userId: event.user,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      source: 'app_mention',
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      contextMode: event.thread_ts ? 'thread' : 'channel_history',
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(attachmentSet.intake ? { attachmentIntake: attachmentSet.intake } : {}),
    });
  }

  if (isDirectConversation(event)) {
    if (!options.botUserId) {
      return { status: 'ignored', reason: 'missing_bot_user_id' };
    }

    return runnableTurn({
      payload,
      channelId: event.channel,
      text,
      userId: event.user,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      sessionThreadTs: 'dm',
      source: 'dm_message',
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      contextMode: event.thread_ts ? 'thread' : 'dm_history',
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(attachmentSet.intake ? { attachmentIntake: attachmentSet.intake } : {}),
    });
  }

  if (!isChannelConversation(event)) {
    return { status: 'ignored', reason: 'unsupported_channel_type' };
  }
  if (!event.thread_ts && /<!subteam\^[A-Z0-9]+(?:\|[^>]+)?>/i.test(text)) {
    return runnableTurn({
      payload,
      channelId: event.channel,
      text,
      userId: event.user,
      messageTs: event.ts,
      threadTs: event.ts,
      source: 'agent_mention',
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      contextMode: 'channel_history',
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(attachmentSet.intake ? { attachmentIntake: attachmentSet.intake } : {}),
    });
  }
  if (!event.thread_ts) {
    return { status: 'ignored', reason: 'unaddressed_channel_message' };
  }
  if (!options.botUserId) {
    return { status: 'ignored', reason: 'missing_bot_user_id' };
  }

  return runnableTurn({
    payload,
    channelId: event.channel,
    text,
    userId: event.user,
    messageTs: event.ts,
    threadTs: event.thread_ts,
    source: 'implicit_thread_reply',
    ...(event.channel_type ? { channelType: event.channel_type } : {}),
    contextMode: 'thread',
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(attachmentSet.intake ? { attachmentIntake: attachmentSet.intake } : {}),
  });
}

function runnableTurn(input: RunnableTurnInput): SlackTurnNormalization {
  const turn: NormalizedSlackTurn = {
    workspaceId: input.payload.team_id,
    channelId: input.channelId,
    eventId: input.payload.event_id,
    text: input.text,
    userId: input.userId,
    messageTs: input.messageTs,
    threadTs: input.threadTs,
    ...(input.sessionThreadTs ? { sessionThreadTs: input.sessionThreadTs } : {}),
    source: input.source,
    ...(input.channelType ? { channelType: input.channelType } : {}),
    contextMode: input.contextMode,
    ...(input.reaction ? { reaction: input.reaction } : {}),
    ...(input.reactionTargetTs ? { reactionTargetTs: input.reactionTargetTs } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.attachmentIntake ? { attachmentIntake: input.attachmentIntake } : {}),
  };

  return { status: 'runnable', turn };
}

function normalizeSlackAttachments(
  event: Pick<SlackMessageEvent, 'files'>,
): { references: SlackAttachmentReference[]; intake?: SlackAttachmentIntake } {
  if (!Array.isArray(event.files) || event.files.length === 0) return { references: [] };
  const count = event.files.length;
  if (count > MAX_SLACK_ATTACHMENTS_PER_TURN) {
    return { references: [], intake: { status: 'too_many', count } };
  }
  const references: SlackAttachmentReference[] = [];
  for (const file of event.files) {
    if (!file || typeof file !== 'object' || typeof file.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(file.id)) {
      return { references: [], intake: { status: 'invalid_metadata', count } };
    }
    references.push({ fileId: file.id });
  }
  return { references, intake: { status: 'ok', count } };
}

function isDirectConversation(event: SlackMessageEvent): boolean {
  return (
    event.channel_type === 'im' ||
    (event.channel.startsWith('D') && !event.channel_type)
  );
}

/**
 * Remove Agent View's active-context attachment before any turn classifier,
 * dedupe coordinate, prompt, or durable state can observe it. Active context
 * is intentionally deferred until it has its own authorization contract.
 */
export function stripSlackMessageAppContext(payload: SlackEventFixture): SlackEventFixture {
  if (
    payload.event.type !== 'message' ||
    !Object.hasOwn(payload.event, 'app_context')
  ) {
    return payload;
  }
  const { app_context: _discarded, ...event } = payload.event;
  return { ...payload, event };
}

function isChannelConversation(event: SlackMessageEvent): boolean {
  return event.channel_type === 'channel' || event.channel_type === 'group';
}

function isAppAuthoredMessage(event: {
  bot_id?: string;
  app_id?: string;
  bot_profile?: { app_id?: string };
}): boolean {
  return Boolean(event.bot_id || event.app_id || event.bot_profile?.app_id);
}

function isSlackSystemUser(userId: string): boolean {
  return userId === 'USLACK' || userId === 'USLACKBOT';
}
