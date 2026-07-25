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
import type { MemoryStateStore } from './types.ts';

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;

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
      visibilityBarrierAt: number | null;
      transitionVersion: number;
    };

export async function resolveMemoryScope(
  input: ResolveMemoryScopeInput,
  deps: { slack: MemoryScopeSlack; state: MemoryStateStore },
): Promise<MemoryScopeDecision> {
  const [conversation, actor] = await Promise.all([
    deps.slack.conversation(input.channelId),
    deps.slack.user(input.actorId),
  ]);
  if (!conversation.ok || !conversation.facts || !actor.ok || !actor.user) {
    return disabled('slack_truth_unavailable');
  }
  const facts = conversation.facts;
  if (facts.id !== input.channelId || (facts.teamId && facts.teamId !== input.workspaceId)) {
    return disabled('workspace_mismatch');
  }
  if (
    facts.archived ||
    facts.frozen ||
    facts.shared ||
    facts.externallyShared ||
    facts.organizationShared ||
    facts.pendingShared ||
    !facts.member
  ) {
    return disabled('unsupported_channel_scope');
  }
  if (
    classifyMemorySlackUser(actor.user, input.workspaceId, input.botUserId) !== 'eligible_human'
  ) {
    return disabled('ineligible_actor');
  }

  const scopeState = await deps.state.observeChannelScope({
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    privacy: facts.private ? 'private' : 'public',
    displayName: facts.name,
    observedAt: input.observedAt,
  });
  const publicId = publicStoreId(input.workspaceId);
  const audience = await resolveAudience(
    input.workspaceId,
    input.channelId,
    input.botUserId,
    deps.slack,
  );

  if (!facts.private) {
    return {
      enabled: true,
      reason: 'eligible',
      privacy: 'public',
      workspaceRead: audience,
      reads: [
        {
          storeId: publicId,
          sourceChannelId: audience ? null : input.channelId,
        },
      ],
      writeStoreId: publicId,
      sourceChannelId: input.channelId,
      displayName: facts.name,
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
    workspaceRead: audience,
    reads: [
      { storeId: privateId, sourceChannelId: null },
      {
        storeId: publicId,
        sourceChannelId: audience ? null : input.channelId,
      },
    ],
    writeStoreId: privateId,
    sourceChannelId: input.channelId,
    displayName: facts.name,
    visibilityBarrierAt: scopeState.visibilityBarrierAt,
    transitionVersion: scopeState.transitionVersion,
  };
}

export async function verifyMemoryMutationMembership(
  channelId: string,
  actorId: string,
  slack: MemoryScopeSlack,
): Promise<boolean> {
  const members = await slack.members(channelId);
  return members.ok && !members.incomplete && members.ids.includes(actorId);
}

export function createMemoryScopeSlack(botToken: string): MemoryScopeSlack {
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
    },
  };
}

async function resolveAudience(
  workspaceId: string,
  channelId: string,
  botUserId: string,
  slack: MemoryScopeSlack,
): Promise<boolean> {
  const [members, directory] = await Promise.all([slack.members(channelId), slack.users()]);
  if (!members.ok || members.incomplete || !directory.ok || directory.incomplete) return false;
  const byId = new Map(directory.users.map((user) => [user.id, user]));
  return members.ids.every((id) => {
    const classification = classifyMemorySlackUser(byId.get(id), workspaceId, botUserId);
    return classification === 'eligible_human' || classification === 'chickpea_bot';
  });
}

function disabled(reason: Extract<MemoryScopeDecision, { enabled: false }>['reason']): MemoryScopeDecision {
  return { enabled: false, reason, workspaceRead: false, reads: [] };
}
