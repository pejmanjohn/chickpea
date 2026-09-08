import {
  SlackTransportError,
  type SlackChannel,
  type SlackMember,
  type SlackUserGroup,
} from './types.ts';

export type SlackApiInput = Record<string, unknown>;
export type SlackApiResult = Record<string, unknown>;

/** One adapter-supplied Slack call. Each mode keeps its own error handling. */
export type SlackApiPage = (input: SlackApiInput) => Promise<SlackApiResult>;

const MAX_CHANNELS = 2_000;
export const CHANNEL_PAGE_LIMIT = 200;
const MAX_CHANNEL_PAGES = 64;

export async function collectChannels(
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

export async function collectMemberChannels(
  page: SlackApiPage,
  userId: string,
): Promise<ReadonlySet<string>> {
  const channels = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const result = await page({
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
}

export async function channelIncludesMember(
  page: SlackApiPage,
  channelId: string,
  userId: string,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const result = await page({
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
}

function sortChannels(channels: SlackChannel[]): SlackChannel[] {
  return channels.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

export function mapMember(user: SlackApiResult): SlackMember {
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

export function mapPolicyChannel(channel: SlackApiResult): SlackChannel {
  return {
    id: requiredString(channel.id, 'conversations'),
    ...(stringValue(channel.name) ? { name: stringValue(channel.name) } : {}),
    private: requiredBoolean(channel.is_private, 'conversations'),
    member: requiredBoolean(channel.is_member, 'conversations'),
    archived: requiredBoolean(channel.is_archived, 'conversations'),
  };
}

export function mapOpenedDirectConversation(channel: SlackApiResult): SlackChannel {
  return {
    id: requiredString(channel.id, 'conversations.open'),
    ...(stringValue(channel.name) ? { name: stringValue(channel.name) } : {}),
    private: true,
    member: true,
    archived: false,
  };
}

export function mapJoinedPublicChannel(channel: SlackApiResult): SlackChannel {
  return {
    id: requiredString(channel.id, 'conversations.join'),
    ...(stringValue(channel.name) ? { name: stringValue(channel.name) } : {}),
    private: false,
    member: true,
    archived: false,
  };
}

export function mapUserGroup(group: SlackApiResult): SlackUserGroup {
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

export function requiredRecord(value: unknown, operation: string): SlackApiResult {
  const result = record(value);
  if (Object.keys(result).length === 0) {
    throw new SlackTransportError(operation, 'invalid_response');
  }
  return result;
}

export function requiredString(value: unknown, operation: string): string {
  const result = stringValue(value);
  if (!result) throw new SlackTransportError(operation, 'invalid_response');
  return result;
}

export function requiredBoolean(value: unknown, operation: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SlackTransportError(operation, 'invalid_response');
  }
  return value;
}

export function record(value: unknown): SlackApiResult {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SlackApiResult
    : {};
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
