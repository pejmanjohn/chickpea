import type { View } from '@slack/types';

import { createSlackWebClient } from '../web-client.ts';
import { slackClientMessageId } from './message-id.ts';
import {
  SlackTransportError,
  type SlackAppHomeReference,
  type SlackChannel,
  type SlackMember,
  type SlackMessageReference,
  type SlackTransport,
  type SlackUserGroup,
} from './types.ts';

type SlackApiInput = Record<string, unknown>;
type SlackApiResult = Record<string, unknown>;
type SlackApiMethod = (input?: SlackApiInput) => Promise<unknown>;

/** Narrow SDK seam used for direct-adapter tests and alternative runtimes. */
export interface DirectSlackApiClient {
  users: { info: SlackApiMethod; conversations: SlackApiMethod };
  conversations: {
    info: SlackApiMethod;
    join: SlackApiMethod;
    list: SlackApiMethod;
    members: SlackApiMethod;
    open: SlackApiMethod;
  };
  usergroups: {
    list: SlackApiMethod;
    create: SlackApiMethod;
    update: SlackApiMethod;
    disable: SlackApiMethod;
    enable: SlackApiMethod;
  };
  views: { publish: SlackApiMethod };
  chat: { postMessage: SlackApiMethod };
}

/** Construct a direct customer-owned adapter while keeping the token captured. */
export function createDirectSlackTransport(botToken: string): SlackTransport {
  const client = createSlackWebClient(botToken) as unknown as DirectSlackApiClient;
  return createDirectSlackTransportFromClient(client);
}

/**
 * Wrap an already-created client. The closure prevents both the client and its
 * credentials from becoming properties on the Agent-facing transport object.
 */
export function createDirectSlackTransportFromClient(
  client: DirectSlackApiClient,
): SlackTransport {
  return {
    mode: 'direct',

    async lookupMember(userId): Promise<SlackMember> {
      const result = await call(client.users.info, 'users.info', { user: userId });
      return mapMember(requiredRecord(result.user, 'users.info'));
    },

    async lookupChannel(channelId): Promise<SlackChannel> {
      const result = await call(client.conversations.info, 'conversations.info', {
        channel: channelId,
      });
      return mapPolicyChannel(requiredRecord(result.channel, 'conversations.info'));
    },

    async listChannels() {
      return collectChannels((cursor) => call(client.conversations.list, 'conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: CHANNEL_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }));
    },

    async listMemberChannels(userId): Promise<ReadonlySet<string>> {
      const channels = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const result = await call(client.users.conversations, 'users.conversations', {
          user: userId,
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const channel of Array.isArray(result.channels) ? result.channels : []) {
          const id = stringValue(record(channel).id);
          if (id) channels.add(id);
        }
        cursor = stringValue(record(result.response_metadata).next_cursor).trim() || undefined;
        if (!cursor) return channels;
      }
      throw new SlackTransportError('users.conversations', 'pagination_limit', {
        retryable: true,
      });
    },

    async channelHasMember(channelId, userId): Promise<boolean> {
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const result = await call(client.conversations.members, 'conversations.members', {
          channel: channelId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        if (Array.isArray(result.members) && result.members.includes(userId)) return true;
        cursor = stringValue(record(result.response_metadata).next_cursor).trim() || undefined;
        if (!cursor) return false;
      }
      throw new SlackTransportError('conversations.members', 'pagination_limit', {
        retryable: true,
      });
    },

    async openDirectConversation(userId): Promise<SlackChannel> {
      const result = await call(client.conversations.open, 'conversations.open', {
        users: userId,
      });
      return mapOpenedDirectConversation(requiredRecord(result.channel, 'conversations.open'));
    },

    async joinPublicChannel(channelId): Promise<SlackChannel> {
      const result = await call(client.conversations.join, 'conversations.join', {
        channel: channelId,
      });
      return mapJoinedPublicChannel(requiredRecord(result.channel, 'conversations.join'));
    },

    async lookupUserGroup(userGroupId): Promise<SlackUserGroup | undefined> {
      const result = await call(client.usergroups.list, 'usergroups.list', {
        include_disabled: true,
      });
      if (!Array.isArray(result.usergroups)) return undefined;
      for (const candidate of result.usergroups) {
        const group = mapUserGroup(requiredRecord(candidate, 'usergroups.list'));
        if (group.id === userGroupId) return group;
      }
      return undefined;
    },

    async listUserGroups(options = {}): Promise<SlackUserGroup[]> {
      const result = await call(client.usergroups.list, 'usergroups.list', {
        include_disabled: options.includeDisabled ?? false,
      });
      return Array.isArray(result.usergroups)
        ? result.usergroups.map((group) => mapUserGroup(requiredRecord(group, 'usergroups.list')))
        : [];
    },

    async createUserGroup(input): Promise<SlackUserGroup> {
      const result = await call(client.usergroups.create, 'usergroups.create', {
        name: input.name,
        handle: input.handle,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.create'));
    },

    async updateUserGroup(userGroupId, patch): Promise<SlackUserGroup> {
      const result = await call(client.usergroups.update, 'usergroups.update', {
        usergroup: userGroupId,
        ...patch,
      });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.update'));
    },

    async disableUserGroup(userGroupId): Promise<SlackUserGroup> {
      const result = await call(client.usergroups.disable, 'usergroups.disable', {
        usergroup: userGroupId,
      });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.disable'));
    },

    async enableUserGroup(userGroupId): Promise<SlackUserGroup> {
      const result = await call(client.usergroups.enable, 'usergroups.enable', {
        usergroup: userGroupId,
      });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.enable'));
    },

    async publishAppHome(input): Promise<SlackAppHomeReference> {
      const result = await call(client.views.publish, 'views.publish', {
        user_id: input.userId,
        view: input.view as View,
        ...(input.hash ? { hash: input.hash } : {}),
      });
      const view = record(result.view);
      return {
        ...(stringValue(view.id) ? { viewId: stringValue(view.id) } : {}),
        ...(stringValue(view.hash) ? { hash: stringValue(view.hash) } : {}),
      };
    },

    async postMessage(input): Promise<SlackMessageReference> {
      const result = await call(client.chat.postMessage, 'chat.postMessage', {
        channel: input.channelId,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        text: input.text,
        ...(input.blocks ? { blocks: input.blocks } : {}),
        ...(input.persona ? {
          username: input.persona.name,
          icon_url: input.persona.avatarUrl,
        } : {}),
        ...(input.idempotencyKey
          ? { client_msg_id: slackClientMessageId(input.idempotencyKey) }
          : {}),
      });
      const channelId = requiredString(result.channel, 'chat.postMessage');
      const ts = requiredString(result.ts, 'chat.postMessage');
      return { channelId, ts };
    },
  };
}

const MAX_CHANNELS = 2_000;
const CHANNEL_PAGE_LIMIT = 200;
const MAX_CHANNEL_PAGES = 64;

async function collectChannels(
  page: (cursor?: string) => Promise<SlackApiResult>,
): Promise<{ channels: SlackChannel[]; truncated: boolean }> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_CHANNEL_PAGES; pageIndex += 1) {
    const result = await page(cursor);
    if (Array.isArray(result.channels)) {
      channels.push(...result.channels.map((channel) =>
        mapPolicyChannel(requiredRecord(channel, 'conversations.list'))
      ));
    }
    cursor = stringValue(record(result.response_metadata).next_cursor).trim() || undefined;
    if (channels.length >= MAX_CHANNELS) {
      const truncated = channels.length > MAX_CHANNELS || Boolean(cursor);
      channels.length = MAX_CHANNELS;
      return { channels: sortChannels(channels), truncated };
    }
    if (!cursor) return { channels: sortChannels(channels), truncated: false };
  }
  return { channels: sortChannels(channels), truncated: Boolean(cursor) };
}

function sortChannels(channels: SlackChannel[]): SlackChannel[] {
  return channels.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

async function call(
  method: SlackApiMethod,
  operation: string,
  input: SlackApiInput,
): Promise<SlackApiResult> {
  let result: SlackApiResult;
  try {
    result = record(await method(input));
  } catch (error) {
    throw normalizeError(error, operation);
  }
  if (result.ok !== true) {
    throw new SlackTransportError(operation, stringValue(result.error) || 'invalid_response');
  }
  return result;
}

function normalizeError(error: unknown, operation: string): SlackTransportError {
  if (error instanceof SlackTransportError) return error;
  const value = record(error);
  const data = record(value.data);
  const code = stringValue(data.error) || stringValue(value.code) || 'slack_unreachable';
  return new SlackTransportError(operation, code);
}

function mapMember(user: SlackApiResult): SlackMember {
  const profile = record(user.profile);
  const handle = stringValue(user.name);
  const realName = stringValue(profile.real_name) || stringValue(user.real_name);
  const displayName = stringValue(profile.display_name) || realName || handle;
  const avatarUrl = ['image_192', 'image_72', 'image_48']
    .map((key) => stringValue(profile[key]))
    .find(Boolean);
  return {
    id: requiredString(user.id, 'users.info'),
    ...(stringValue(user.team_id) ? { teamId: stringValue(user.team_id) } : {}),
    ...(handle ? { name: handle, handle } : {}),
    ...(displayName ? { displayName } : {}),
    ...(realName ? { realName } : {}),
    ...(stringValue(profile.email) ? { email: stringValue(profile.email) } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    deleted: user.deleted === true,
    bot: user.is_bot === true,
    appUser: user.is_app_user === true,
    restricted: user.is_restricted === true,
    ultraRestricted: user.is_ultra_restricted === true,
    stranger: user.is_stranger === true,
  };
}

function mapPolicyChannel(channel: SlackApiResult): SlackChannel {
  return {
    id: requiredString(channel.id, 'conversations'),
    ...(stringValue(channel.name) ? { name: stringValue(channel.name) } : {}),
    private: requiredBoolean(channel.is_private, 'conversations'),
    member: requiredBoolean(channel.is_member, 'conversations'),
    archived: requiredBoolean(channel.is_archived, 'conversations'),
  };
}

function mapOpenedDirectConversation(channel: SlackApiResult): SlackChannel {
  return {
    id: requiredString(channel.id, 'conversations.open'),
    ...(stringValue(channel.name) ? { name: stringValue(channel.name) } : {}),
    private: true,
    member: true,
    archived: false,
  };
}

function mapJoinedPublicChannel(channel: SlackApiResult): SlackChannel {
  return {
    id: requiredString(channel.id, 'conversations.join'),
    ...(stringValue(channel.name) ? { name: stringValue(channel.name) } : {}),
    private: false,
    member: true,
    archived: false,
  };
}

function mapUserGroup(group: SlackApiResult): SlackUserGroup {
  const updatedAt = numberValue(group.date_update);
  return {
    id: requiredString(group.id, 'usergroups'),
    name: requiredString(group.name, 'usergroups'),
    handle: requiredString(group.handle, 'usergroups'),
    ...(stringValue(group.description) ? { description: stringValue(group.description) } : {}),
    disabled: group.is_disabled === true || (numberValue(group.date_delete) ?? 0) > 0,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function requiredRecord(value: unknown, operation: string): SlackApiResult {
  const result = record(value);
  if (Object.keys(result).length === 0) {
    throw new SlackTransportError(operation, 'invalid_response');
  }
  return result;
}

function requiredString(value: unknown, operation: string): string {
  const result = stringValue(value);
  if (!result) throw new SlackTransportError(operation, 'invalid_response');
  return result;
}

function requiredBoolean(value: unknown, operation: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SlackTransportError(operation, 'invalid_response');
  }
  return value;
}

function record(value: unknown): SlackApiResult {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SlackApiResult
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
