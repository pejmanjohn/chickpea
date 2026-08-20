import type { View } from '@slack/types';

import type { GatewayOperationClient } from '../gateway/client.ts';
import {
  SlackTransportError,
  type SlackAppHomeReference,
  type SlackChannel,
  type SlackMember,
  type SlackMessageReference,
  type SlackTransport,
  type SlackUserGroup,
} from './types.ts';

/** Shared-app adapter. The deployment never receives a Slack token. */
export function createGatewaySlackTransport(client: GatewayOperationClient): SlackTransport {
  return {
    mode: 'gateway',

    async lookupMember(userId): Promise<SlackMember> {
      const result = await client.call('users.info', { user: userId });
      return mapMember(requiredRecord(result.user, 'users.info'));
    },

    async lookupChannel(channelId): Promise<SlackChannel> {
      const result = await client.call('conversations.info', { channel: channelId });
      return mapChannel(requiredRecord(result.channel, 'conversations.info'));
    },

    async channelHasMember(channelId, userId): Promise<boolean> {
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const result = await client.call('conversations.members', {
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
      const result = await client.call('conversations.open', { users: userId });
      return mapChannel(requiredRecord(result.channel, 'conversations.open'));
    },

    async joinPublicChannel(channelId): Promise<SlackChannel> {
      const result = await client.call('conversations.join', { channel: channelId });
      return mapChannel(requiredRecord(result.channel, 'conversations.join'));
    },

    async listUserGroups(options = {}): Promise<SlackUserGroup[]> {
      const result = await client.call('usergroups.list', {
        include_disabled: options.includeDisabled ?? false,
      });
      return Array.isArray(result.usergroups)
        ? result.usergroups.map((group) => mapUserGroup(requiredRecord(group, 'usergroups.list')))
        : [];
    },

    async createUserGroup(input): Promise<SlackUserGroup> {
      const result = await client.call('usergroups.create', {
        name: input.name,
        handle: input.handle,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.create'));
    },

    async updateUserGroup(userGroupId, patch): Promise<SlackUserGroup> {
      const result = await client.call('usergroups.update', {
        usergroup: userGroupId,
        ...patch,
      });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.update'));
    },

    async disableUserGroup(userGroupId): Promise<SlackUserGroup> {
      const result = await client.call('usergroups.disable', { usergroup: userGroupId });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.disable'));
    },

    async enableUserGroup(userGroupId): Promise<SlackUserGroup> {
      const result = await client.call('usergroups.enable', { usergroup: userGroupId });
      return mapUserGroup(requiredRecord(result.usergroup, 'usergroups.enable'));
    },

    async publishAppHome(input): Promise<SlackAppHomeReference> {
      const result = await client.call('views.publish', {
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
      const result = await client.call('chat.postMessage', {
        channel: input.channelId,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        text: input.text,
        ...(input.blocks ? { blocks: input.blocks } : {}),
        username: input.persona.name,
        icon_url: input.persona.avatarUrl,
      });
      return {
        channelId: requiredString(result.channel, 'chat.postMessage'),
        ts: requiredString(result.ts, 'chat.postMessage'),
      };
    },
  };
}

function mapMember(user: Record<string, unknown>): SlackMember {
  const profile = record(user.profile);
  return {
    id: requiredString(user.id, 'users.info'),
    ...(stringValue(user.team_id) ? { teamId: stringValue(user.team_id) } : {}),
    ...(stringValue(user.name) ? { name: stringValue(user.name) } : {}),
    ...(stringValue(profile.display_name) ? { displayName: stringValue(profile.display_name) } : {}),
    ...(stringValue(profile.email) ? { email: stringValue(profile.email) } : {}),
    deleted: user.deleted === true,
    bot: user.is_bot === true,
    appUser: user.is_app_user === true,
    restricted: user.is_restricted === true,
    ultraRestricted: user.is_ultra_restricted === true,
    stranger: user.is_stranger === true,
  };
}

function mapChannel(channel: Record<string, unknown>): SlackChannel {
  return {
    id: requiredString(channel.id, 'conversations'),
    ...(stringValue(channel.name) ? { name: stringValue(channel.name) } : {}),
    private: channel.is_private === true,
    member: channel.is_member === true,
    archived: channel.is_archived === true,
  };
}

function mapUserGroup(group: Record<string, unknown>): SlackUserGroup {
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

function requiredRecord(value: unknown, operation: string): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).length === 0) throw new SlackTransportError(operation, 'invalid_response');
  return result;
}

function requiredString(value: unknown, operation: string): string {
  const result = stringValue(value);
  if (!result) throw new SlackTransportError(operation, 'invalid_response');
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
