import {
  slackConversationsInfo,
  slackConversationsMembers,
  slackUsersInfo,
  slackUsersList,
  type SlackConversationFacts,
  type SlackUserFacts,
} from '../slack/credentials.ts';
import { classifyMemorySlackUser } from '../slack/user-classification.ts';
import { privateStoreId, publicStoreId } from './store.ts';
import { MemoryStateError, type MemoryStateStore } from './types.ts';

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;
const USERS_DIRECTORY_CACHE_TTL_MS = 30_000;
const TERMINAL_CHANNEL_ERRORS = new Set(['channel_not_found', 'channel_deleted']);

export interface MemoryScopeSlackResult<T> {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  incomplete?: boolean;
  facts?: T;
}

export interface MemoryScopeSlack {
  conversation(channelId: string): Promise<MemoryScopeSlackResult<SlackConversationFacts>>;
  user(userId: string): Promise<MemoryScopeSlackResult<SlackUserFacts> & { user?: SlackUserFacts }>;
  members(
    channelId: string,
  ): Promise<MemoryScopeSlackResult<never> & { ids: string[] }>;
  users(): Promise<MemoryScopeSlackResult<never> & { users: SlackUserFacts[] }>;
}

type MemoryScopeUsersResult = MemoryScopeSlackResult<never> & { users: SlackUserFacts[] };

let usersDirectoryCache = new Map<
  string,
  { expiresAt: number; pending: Promise<MemoryScopeUsersResult> }
>();

/** Drop one workspace/token directory snapshot, or every snapshot in tests. */
export function invalidateMemoryScopeUsersCache(
  workspaceId?: string,
  botToken?: string,
): void {
  if (workspaceId !== undefined && botToken !== undefined) {
    usersDirectoryCache.delete(usersDirectoryCacheKey(workspaceId, botToken));
    return;
  }
  usersDirectoryCache = new Map();
}

export interface ResolveMemoryScopeInput {
  workspaceId: string;
  channelId: string;
  actorId: string;
  botUserId: string;
  observedAt: number;
}

export interface MemoryReadScope {
  storeId: string;
  /** null means every public source partition; private stores always use null. */
  sourceChannelId: string | null;
}

export type MemoryScopeDecision =
  | {
      enabled: false;
      reason:
        | 'slack_truth_unavailable'
        | 'unsupported_channel_scope'
        | 'ineligible_actor'
        | 'workspace_mismatch';
      workspaceRead: false;
      reads: [];
    }
  | {
      enabled: true;
      reason: 'eligible';
      privacy: 'public' | 'private';
      workspaceRead: boolean;
      reads: MemoryReadScope[];
      writeStoreId: string;
      sourceChannelId: string;
      displayName: string;
      /** Complete membership snapshot used for a lightweight delivery lease. */
      audienceMemberIds: string[] | null;
      visibilityBarrierAt: number | null;
      transitionVersion: number;
    };

export type EnabledMemoryScope = Extract<MemoryScopeDecision, { enabled: true }>;

export async function resolveMemoryScope(
  input: ResolveMemoryScopeInput,
  deps: { slack: MemoryScopeSlack; state: MemoryStateStore },
): Promise<MemoryScopeDecision> {
  const [conversation, actor] = await Promise.all([
    deps.slack.conversation(input.channelId),
    deps.slack.user(input.actorId),
  ]);
  const facts = conversation.facts;
  if (facts && (facts.id !== input.channelId || (facts.teamId && facts.teamId !== input.workspaceId))) {
    return disabled('workspace_mismatch');
  }
  if (facts?.archived) {
    await retainKnownChannelScope(input, deps.state, 'archived');
    return disabled('unsupported_channel_scope');
  }
  if (!conversation.ok || !facts) {
    if (conversation.error && TERMINAL_CHANNEL_ERRORS.has(conversation.error)) {
      await retainKnownChannelScope(input, deps.state, 'deleted');
      return disabled('unsupported_channel_scope');
    }
    return disabled('slack_truth_unavailable');
  }
  if (!actor.ok || !actor.user) return disabled('slack_truth_unavailable');
  if (
    facts.frozen ||
    facts.shared ||
    facts.externallyShared ||
    facts.organizationShared ||
    facts.pendingShared ||
    facts.im ||
    facts.mpim ||
    !facts.member
  ) {
    return disabled('unsupported_channel_scope');
  }
  if (
    classifyMemorySlackUser(actor.user, input.workspaceId, input.botUserId) !== 'eligible_human'
  ) {
    return disabled('ineligible_actor');
  }

  const audience = await resolveAudience(
    input.workspaceId,
    input.channelId,
    input.actorId,
    input.botUserId,
    deps.slack,
  );
  if (audience.actorIsMember === false) return disabled('ineligible_actor');
  const scopeState = await deps.state.observeChannelScope({
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    privacy: facts.private ? 'private' : 'public',
    displayName: facts.name,
    observedAt: input.observedAt,
  });
  const publicId = publicStoreId(input.workspaceId);

  if (!facts.private) {
    return {
      enabled: true,
      reason: 'eligible',
      privacy: 'public',
      workspaceRead: audience.workspaceRead,
      reads: [
        {
          storeId: publicId,
          sourceChannelId: audience.workspaceRead ? null : input.channelId,
        },
      ],
      writeStoreId: publicId,
      sourceChannelId: input.channelId,
      displayName: facts.name,
      audienceMemberIds: audience.memberIds,
      visibilityBarrierAt: scopeState.visibilityBarrierAt,
      transitionVersion: scopeState.transitionVersion,
    };
  }

  const privateId =
    scopeState.privateStoreId ??
    privateStoreId(input.workspaceId, input.channelId, scopeState.privateGeneration);
  return {
    enabled: true,
    reason: 'eligible',
    privacy: 'private',
    workspaceRead: audience.workspaceRead,
    reads: [
      { storeId: privateId, sourceChannelId: null },
      {
        storeId: publicId,
        sourceChannelId: audience.workspaceRead ? null : input.channelId,
      },
    ],
    writeStoreId: privateId,
    sourceChannelId: input.channelId,
    displayName: facts.name,
    audienceMemberIds: audience.memberIds,
    visibilityBarrierAt: scopeState.visibilityBarrierAt,
    transitionVersion: scopeState.transitionVersion,
  };
}

export async function validateMemoryScopeLease(
  input: ResolveMemoryScopeInput,
  expected: EnabledMemoryScope,
  slack: MemoryScopeSlack,
  requiresWorkspaceRead = false,
): Promise<boolean> {
  const [conversation, actor, members, directory] = await Promise.all([
    slack.conversation(input.channelId),
    slack.user(input.actorId),
    slack.members(input.channelId),
    requiresWorkspaceRead ? slack.users() : Promise.resolve(undefined),
  ]);
  if (
    !conversation.ok ||
    !conversation.facts ||
    !actor.ok ||
    !actor.user ||
    !members.ok
  ) {
    return false;
  }
  const facts = conversation.facts;
  if (
    facts.id !== input.channelId ||
    (facts.teamId && facts.teamId !== input.workspaceId) ||
    facts.archived ||
    facts.frozen ||
    facts.shared ||
    facts.externallyShared ||
    facts.organizationShared ||
    facts.pendingShared ||
    facts.im ||
    facts.mpim ||
    !facts.member ||
    (facts.private ? 'private' : 'public') !== expected.privacy ||
    classifyMemorySlackUser(actor.user, input.workspaceId, input.botUserId) !==
      'eligible_human' ||
    !members.ids.includes(input.actorId)
  ) {
    return false;
  }
  if (!requiresWorkspaceRead) return true;
  if (
    !expected.workspaceRead ||
    members.incomplete ||
    !directory ||
    !directory.ok ||
    directory.incomplete
  ) return false;
  return audienceQualifies(
    members.ids,
    directory.users,
    input.workspaceId,
    input.botUserId,
  );
}

export async function verifyMemoryMutationMembership(
  channelId: string,
  actorId: string,
  slack: MemoryScopeSlack,
): Promise<boolean> {
  const members = await slack.members(channelId);
  return members.ok && members.ids.includes(actorId);
}

export function createMemoryScopeSlack(
  botToken: string,
  workspaceId?: string,
): MemoryScopeSlack {
  const loadUsers = async (): Promise<MemoryScopeUsersResult> => {
    const users: SlackUserFacts[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await slackUsersList(botToken, {
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) {
        return {
          ok: false,
          users: [],
          ...(result.error ? { error: result.error } : {}),
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        };
      }
      users.push(...result.users);
      cursor = result.nextCursor;
      if (!cursor) return { ok: true, users };
    }
    return { ok: true, users, incomplete: Boolean(cursor) };
  };

  return {
    async conversation(channelId) {
      const result = await slackConversationsInfo(botToken, channelId);
      return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.facts ? { facts: result.facts } : {}),
      };
    },
    async user(userId) {
      const result = await slackUsersInfo(botToken, userId);
      return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.user ? { user: result.user } : {}),
      };
    },
    async members(channelId) {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await slackConversationsMembers(botToken, channelId, {
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        if (!result.ok) {
          return {
            ok: false,
            ids: [],
            ...(result.error ? { error: result.error } : {}),
            ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          };
        }
        ids.push(...result.memberIds);
        cursor = result.nextCursor;
        if (!cursor) return { ok: true, ids };
      }
      return { ok: true, ids, incomplete: Boolean(cursor) };
    },
    async users() {
      if (!workspaceId) return loadUsers();
      return cachedWorkspaceUsers(workspaceId, botToken, loadUsers);
    },
  };
}

async function resolveAudience(
  workspaceId: string,
  channelId: string,
  actorId: string,
  botUserId: string,
  slack: MemoryScopeSlack,
): Promise<{
  workspaceRead: boolean;
  memberIds: string[] | null;
  actorIsMember: boolean | null;
}> {
  const [members, directory] = await Promise.all([slack.members(channelId), slack.users()]);
  if (!members.ok) {
    return { workspaceRead: false, memberIds: null, actorIsMember: null };
  }
  if (members.incomplete) {
    return {
      workspaceRead: false,
      memberIds: null,
      actorIsMember: members.ids.includes(actorId) ? true : null,
    };
  }
  const memberIds = [...new Set(members.ids)].sort();
  if (!memberIds.includes(actorId)) {
    return { workspaceRead: false, memberIds, actorIsMember: false };
  }
  if (!directory.ok || directory.incomplete) {
    return { workspaceRead: false, memberIds, actorIsMember: true };
  }
  const workspaceRead = audienceQualifies(memberIds, directory.users, workspaceId, botUserId);
  return { workspaceRead, memberIds, actorIsMember: true };
}

function audienceQualifies(
  memberIds: readonly string[],
  users: readonly SlackUserFacts[],
  workspaceId: string,
  botUserId: string,
): boolean {
  const byId = new Map(users.map((user) => [user.id, user]));
  return memberIds.every((id) => {
    const classification = classifyMemorySlackUser(byId.get(id), workspaceId, botUserId);
    return classification === 'eligible_human' || classification === 'chickpea_bot';
  });
}

async function cachedWorkspaceUsers(
  workspaceId: string,
  botToken: string,
  load: () => Promise<MemoryScopeUsersResult>,
): Promise<MemoryScopeUsersResult> {
  const key = usersDirectoryCacheKey(workspaceId, botToken);
  const now = Date.now();
  const cached = usersDirectoryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.pending;

  const pending = load();
  usersDirectoryCache.set(key, {
    expiresAt: now + USERS_DIRECTORY_CACHE_TTL_MS,
    pending,
  });
  const result = await pending;
  if (!result.ok || result.incomplete) {
    const current = usersDirectoryCache.get(key);
    if (current?.pending === pending) usersDirectoryCache.delete(key);
  }
  return result;
}

function usersDirectoryCacheKey(workspaceId: string, botToken: string): string {
  return `${workspaceId}\0${botToken}`;
}

async function retainKnownChannelScope(
  input: ResolveMemoryScopeInput,
  state: MemoryStateStore,
  reason: 'archived' | 'deleted',
): Promise<void> {
  try {
    await state.retainChannelScope({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      reason,
      observedAt: input.observedAt,
    });
  } catch (error) {
    if (error instanceof MemoryStateError && error.code === 'memory_scope_not_found') return;
    throw error;
  }
}

function disabled(reason: Extract<MemoryScopeDecision, { enabled: false }>['reason']): MemoryScopeDecision {
  return { enabled: false, reason, workspaceRead: false, reads: [] };
}
