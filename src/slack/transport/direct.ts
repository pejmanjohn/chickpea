import type { View } from '@slack/types';

import { createSlackWebClient } from '../web-client.ts';
import { slackClientMessageId } from './message-id.ts';
import {
  channelIncludesMember,
  CHANNEL_PAGE_LIMIT,
  collectChannels,
  collectMemberChannels,
  mapJoinedPublicChannel,
  mapMember,
  mapOpenedDirectConversation,
  mapPolicyChannel,
  mapUserGroup,
  record,
  requiredRecord,
  requiredString,
  stringValue,
  type SlackApiInput,
  type SlackApiResult,
} from './shared.ts';
import {
  SlackTransportError,
  type SlackAppHomeReference,
  type SlackChannel,
  type SlackMember,
  type SlackMessageReference,
  type SlackTransport,
  type SlackUserGroup,
} from './types.ts';

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
      return collectMemberChannels(
        (input) => call(client.users.conversations, 'users.conversations', input),
        userId,
      );
    },

    async channelHasMember(channelId, userId): Promise<boolean> {
      return channelIncludesMember(
        (input) => call(client.conversations.members, 'conversations.members', input),
        channelId,
        userId,
      );
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
