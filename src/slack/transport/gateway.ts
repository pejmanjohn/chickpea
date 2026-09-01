import type { View } from '@slack/types';

import type { GatewayOperationClient } from '../gateway/client.ts';
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
} from './shared.ts';
import type {
  SlackAppHomeReference,
  SlackChannel,
  SlackMember,
  SlackMessageReference,
  SlackTransport,
  SlackUserGroup,
  SlackWorkspaceInfo,
} from './types.ts';

/** Shared-app adapter. The deployment never receives a Slack token. */
export function createGatewaySlackTransport(client: GatewayOperationClient): SlackTransport {
  return {
    mode: 'gateway',

    async getWorkspaceInfo(): Promise<SlackWorkspaceInfo> {
      const result = await client.call('auth.test', {});
      const teamId = requiredString(result.team_id, 'auth.test');
      const teamName = stringValue(result.team).trim();
      return { teamId, ...(teamName ? { teamName } : {}) };
    },

    async lookupMember(userId): Promise<SlackMember> {
      const result = await client.call('users.info', { user: userId });
      return mapMember(requiredRecord(result.user, 'users.info'));
    },

    async lookupChannel(channelId): Promise<SlackChannel> {
      const result = await client.call('conversations.info', { channel: channelId });
      return mapPolicyChannel(requiredRecord(result.channel, 'conversations.info'));
    },

    async listChannels() {
      return collectChannels((cursor) => client.call('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: CHANNEL_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }));
    },

    async listMemberChannels(userId): Promise<ReadonlySet<string>> {
      return collectMemberChannels(
        (input) => client.call('users.conversations', input),
        userId,
      );
    },

    async channelHasMember(channelId, userId): Promise<boolean> {
      return channelIncludesMember(
        (input) => client.call('conversations.members', input),
        channelId,
        userId,
      );
    },

    async openDirectConversation(userId): Promise<SlackChannel> {
      const result = await client.call('conversations.open', { users: userId });
      return mapOpenedDirectConversation(requiredRecord(result.channel, 'conversations.open'));
    },

    async joinPublicChannel(channelId): Promise<SlackChannel> {
      const result = await client.call('conversations.join', { channel: channelId });
      return mapJoinedPublicChannel(requiredRecord(result.channel, 'conversations.join'));
    },

    async lookupUserGroup(userGroupId): Promise<SlackUserGroup | undefined> {
      const result = await client.call('usergroups.list', { include_disabled: true });
      if (!Array.isArray(result.usergroups)) return undefined;
      for (const candidate of result.usergroups) {
        const group = mapUserGroup(requiredRecord(candidate, 'usergroups.list'));
        if (group.id === userGroupId) return group;
      }
      return undefined;
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
        ...(input.persona ? {
          username: input.persona.name,
          icon_url: input.persona.avatarUrl,
        } : {}),
        ...(input.idempotencyKey
          ? { client_msg_id: slackClientMessageId(input.idempotencyKey) }
          : {}),
      });
      return {
        channelId: requiredString(result.channel, 'chat.postMessage'),
        ts: requiredString(result.ts, 'chat.postMessage'),
      };
    },
  };
}
