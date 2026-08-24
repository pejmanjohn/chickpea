import type { WebClient } from '@slack/web-api';

import {
  computeSnapshotHash,
  effectiveSlackConfigFromAssignment,
  type EffectiveSlackConfig,
} from '../config/effective-config.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import {
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  slackAuthTest,
  slackConversationsInfo,
  slackConversationsMembers,
} from '../slack/credentials.ts';
import {
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from '../slack/installation-execution.ts';
import { hashRoutineValue } from './ids.ts';
import {
  resolveRoutineAgentAuthority,
  RoutineAuthorityError,
  type ResolvedRoutineAuthority,
} from './agent-authority.ts';
import type { EffectiveConnectionAccount } from '../connections/types.ts';
import type {
  RoutineDefinition,
  RoutineFailureClass,
  RoutineRun,
} from './types.ts';

const MEMBERS_PAGE_LIMIT = 200;
const MEMBERS_MAX_PAGES = 5;

export interface RoutineRuntimeAccess {
  config: EffectiveSlackConfig;
  accessHash: string;
  botToken?: string;
  botUserId: string;
  /** The exact authenticated client shared by context, memory, and delivery. */
  client?: WebClient;
  publicUrl?: string | undefined;
  actorMembershipId?: string;
  actorSlackUserId?: string;
  authorityReceiptId?: string;
  effectiveConnections?: EffectiveConnectionAccount[];
}

export class RoutineRuntimeError extends Error {
  constructor(
    readonly failureClass: RoutineFailureClass,
    readonly publicError: string,
  ) {
    super(publicError);
    this.name = 'RoutineRuntimeError';
  }
}

interface RoutineAccessDependencies {
  credentials?: typeof resolveSlackCredentials;
  authTest?: typeof slackAuthTest;
  conversation?: typeof slackConversationsInfo;
  members?: typeof slackConversationsMembers;
  config?: (
    workspaceId: string,
    channelId: string,
    env: PlatformEnv | undefined,
  ) => Promise<EffectiveSlackConfig>;
  installationExecution?: SlackInstallationExecutionResolver;
  authority?: (
    routine: RoutineDefinition,
    env: PlatformEnv | undefined,
  ) => Promise<ResolvedRoutineAuthority>;
}

/** Live, fail-closed authorization preflight performed before Agent construction. */
export async function resolveRoutineRuntimeAccess(
  run: RoutineRun,
  routine: RoutineDefinition,
  env: PlatformEnv | undefined,
  dependencies: RoutineAccessDependencies = {},
): Promise<RoutineRuntimeAccess> {
  const revision = run.revision;
  if (!revision) {
    throw new RoutineRuntimeError('result_invalid', 'The saved routine revision is unavailable.');
  }
  let authority: ResolvedRoutineAuthority | undefined;
  let config: EffectiveSlackConfig;
  if (!dependencies.config || dependencies.authority) {
    try {
      authority = await (dependencies.authority ?? resolveRoutineAgentAuthority)(routine, env);
      config = effectiveSlackConfigFromAssignment(authority.assignment);
    } catch (error) {
      if (error instanceof RoutineAuthorityError) {
        throw new RoutineRuntimeError(
          error.reason === 'creator_ineligible'
            ? 'creator_ineligible'
            : error.reason === 'destination_unavailable'
              ? 'channel_ineligible'
              : error.reason === 'connection_unavailable'
                ? 'credential_unavailable'
                : 'assignment_missing',
          error.message,
        );
      }
      throw error;
    }
  } else {
    config = await dependencies.config(routine.workspaceId, routine.channelId, env);
  }
  const getConversation = dependencies.conversation ?? slackConversationsInfo;
  const getMembers = dependencies.members ?? slackConversationsMembers;
  let botToken: string | undefined;
  let botUserId: string | undefined;
  let client: WebClient | undefined;
  const useInstallationGate = Boolean(dependencies.installationExecution) ||
    (!dependencies.credentials && !dependencies.authTest);
  if (useInstallationGate) {
    try {
      const installation = await (dependencies.installationExecution ?? ((workspaceId) =>
        resolveSlackInstallationExecutionContext(workspaceId, env)))(routine.workspaceId);
      if (installation.workspaceId !== routine.workspaceId) throw new Error('workspace mismatch');
      botToken = installation.botToken;
      botUserId = installation.botUserId;
      client = installation.client;
    } catch {
      throw new RoutineRuntimeError(
        'credential_unavailable',
        'The Slack connection is unavailable for this routine.',
      );
    }
  } else {
    const credentials = await (dependencies.credentials ?? resolveSlackCredentials)(env);
    if (credentials.botToken) {
      const auth = await (dependencies.authTest ?? slackAuthTest)(credentials.botToken);
      if (auth.ok && auth.botUserId && (!auth.teamId || auth.teamId === routine.workspaceId)) {
        botToken = credentials.botToken;
        botUserId = auth.botUserId;
      }
    }
  }
  if ((!botToken && !client) || !botUserId) {
    throw new RoutineRuntimeError(
      'credential_unavailable',
      'The Slack connection is unavailable for this routine.',
    );
  }
  const conversation = botToken
    ? await getConversation(botToken, routine.channelId)
    : await conversationFromClient(client!, routine.channelId);
  const facts = conversation.facts;
  if (
    !conversation.ok ||
    !facts ||
    facts.id !== routine.channelId ||
    (facts.teamId && facts.teamId !== routine.workspaceId) ||
    facts.archived ||
    facts.frozen ||
    facts.im ||
    facts.mpim ||
    !facts.member
  ) {
    const channelIsKnownIneligible = !!facts && (
      facts.archived || facts.frozen || facts.im || facts.mpim || !facts.member
    );
    throw new RoutineRuntimeError(
      terminalChannelError(conversation.error) || channelIsKnownIneligible
        ? 'channel_ineligible'
        : 'access_denied',
      terminalChannelError(conversation.error) || channelIsKnownIneligible
        ? 'The routine channel is no longer eligible.'
        : 'Current Slack channel access could not be verified.',
    );
  }
  const actorSlackUserId = authority?.actorSlackUserId ?? routine.creatorUserId;
  if (actorSlackUserId === botUserId) {
    throw new RoutineRuntimeError('creator_ineligible', 'The routine Runs as member is no longer eligible.');
  }
  const creatorIsMember = botToken
    ? await hasChannelMember(botToken, routine.channelId, actorSlackUserId, getMembers)
    : await hasChannelMemberViaClient(client!, routine.channelId, actorSlackUserId);
  if (creatorIsMember === false) {
    throw new RoutineRuntimeError('creator_ineligible', 'The routine Runs as member left this channel.');
  }
  if (creatorIsMember === undefined) {
    throw new RoutineRuntimeError('access_denied', 'Current channel membership could not be verified.');
  }

  // Legacy injected access had no canonical Runs as actor, so preserve its
  // stricter editor check. Agent-owned schedules intentionally execute as the
  // explicit member in their authority receipt regardless of who last edited
  // the task body.
  const editorUserId = routine.updatedBy;
  if (!authority && editorUserId && editorUserId !== routine.creatorUserId) {
    if (editorUserId === botUserId) {
      throw new RoutineRuntimeError('creator_ineligible', 'The routine editor is no longer eligible.');
    }
    const editorIsMember = botToken
      ? await hasChannelMember(botToken, routine.channelId, editorUserId, getMembers)
      : await hasChannelMemberViaClient(client!, routine.channelId, editorUserId);
    if (editorIsMember === false) {
      throw new RoutineRuntimeError('creator_ineligible', 'The routine editor left this channel.');
    }
    if (editorIsMember === undefined) {
      throw new RoutineRuntimeError('access_denied', 'Current channel membership could not be verified.');
    }
  }

  const accessHash = hashRoutineValue(
    JSON.stringify({
      config: computeSnapshotHash(config),
      workspaceId: routine.workspaceId,
      actorSlackUserId,
      actorMembershipId: authority?.reference.runsAsMembershipId ?? null,
      authorityReceiptId: authority?.reference.authorityReceiptId ?? null,
      ...(!authority ? {
        creatorUserId: routine.creatorUserId,
        editorUserId: editorUserId ?? null,
      } : {}),
      botUserId,
      channelId: facts.id,
      channelPrivate: facts.private,
      channelShared: facts.shared || facts.externallyShared || facts.organizationShared,
    }),
  );
  return {
    config,
    accessHash,
    ...(botToken ? { botToken } : {}),
    botUserId,
    ...(client ? { client } : {}),
    publicUrl: await resolveSlackPublicUrl(env).catch(() => undefined),
    ...(authority
      ? {
          actorMembershipId: authority.reference.runsAsMembershipId,
          actorSlackUserId: authority.actorSlackUserId,
          authorityReceiptId: authority.reference.authorityReceiptId,
          effectiveConnections: authority.effectiveConnections,
        }
      : {}),
  };
}

async function conversationFromClient(client: WebClient, channelId: string) {
  try {
    const response = await client.conversations.info({ channel: channelId });
    const channel = response.channel as Record<string, unknown> | undefined;
    return {
      ok: response.ok === true,
      error: response.ok === true ? undefined : 'conversation_unavailable',
      retryAfterMs: undefined,
      channel: channel && typeof channel.id === 'string' ? {
        id: channel.id,
        ...(typeof channel.name === 'string' ? { name: channel.name } : {}),
        isPrivate: channel.is_private === true,
        isMember: channel.is_member === true,
      } : undefined,
      facts: channel && typeof channel.id === 'string' ? {
        id: channel.id,
        ...(typeof channel.name === 'string' ? { name: channel.name } : {}),
        private: channel.is_private === true,
        archived: channel.is_archived === true,
        frozen: channel.is_frozen === true,
        shared: channel.is_shared === true,
        externallyShared: channel.is_ext_shared === true,
        organizationShared: channel.is_org_shared === true,
        pendingShared: channel.is_pending_ext_shared === true,
        member: channel.is_member === true,
        ...(typeof channel.team_id === 'string' ? { teamId: channel.team_id } : {}),
        im: channel.is_im === true,
        mpim: channel.is_mpim === true,
      } : undefined,
    };
  } catch {
    return { ok: false as const, error: 'conversation_unavailable', retryAfterMs: undefined };
  }
}

async function hasChannelMemberViaClient(
  client: WebClient,
  channelId: string,
  userId: string,
): Promise<boolean | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < MEMBERS_MAX_PAGES; page += 1) {
    try {
      const response = await client.conversations.members({
        channel: channelId,
        limit: MEMBERS_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (!response.ok || !Array.isArray(response.members)) return undefined;
      if (response.members.includes(userId)) return true;
      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) return false;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function hasChannelMember(
  botToken: string,
  channelId: string,
  userId: string,
  members: typeof slackConversationsMembers,
): Promise<boolean | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < MEMBERS_MAX_PAGES; page += 1) {
    const result = await members(botToken, channelId, {
      limit: MEMBERS_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) return undefined;
    if (result.memberIds.includes(userId)) return true;
    cursor = result.nextCursor;
    if (!cursor) return false;
  }
  return undefined;
}

function terminalChannelError(error: string | undefined): boolean {
  return error === 'channel_not_found' || error === 'channel_deleted';
}
