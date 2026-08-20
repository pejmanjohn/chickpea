import type { WebClient } from '@slack/web-api';

import {
  computeSnapshotHash,
  effectiveSlackConfigFromAssignment,
  type EffectiveSlackConfig,
} from '../config/effective-config.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import {
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  slackAuthTest,
  slackConversationsInfo,
  slackConversationsMembers,
} from '../slack/credentials.ts';
import { resolveSlackIdentityCredentials } from '../slack/identity-credentials.ts';
import {
  resolveSlackIdentityExecutionContext,
  type SlackIdentityExecutionResolver,
} from '../slack/identity-execution.ts';
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
  /** Explicit in production; optional only for legacy injected test access. */
  slackIdentityId?: string;
  botToken: string;
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
  identityCredentials?: typeof resolveSlackIdentityCredentials;
  authTest?: typeof slackAuthTest;
  conversation?: typeof slackConversationsInfo;
  members?: typeof slackConversationsMembers;
  config?: (
    workspaceId: string,
    channelId: string,
    env: PlatformEnv | undefined,
  ) => Promise<EffectiveSlackConfig>;
  identityExecution?: SlackIdentityExecutionResolver;
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
      config = effectiveSlackConfigFromAssignment({
        workspaceId: routine.workspaceId,
        channelId: routine.channelId,
        agentId: authority.reference.agentId,
        participationMode: 'mention_only',
        agent: authority.agent,
      });
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
  const slackIdentityId = WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
  let botToken: string | undefined;
  let botUserId: string | undefined;
  let client: WebClient | undefined;
  const useSharedIdentityGate = Boolean(dependencies.identityExecution) ||
    (!dependencies.credentials && !dependencies.identityCredentials && !dependencies.authTest);
  if (useSharedIdentityGate) {
    try {
      const identity = await (dependencies.identityExecution ?? ((identityId) =>
        resolveSlackIdentityExecutionContext(identityId, env)))(slackIdentityId);
      if (identity.teamId !== routine.workspaceId) throw new Error('workspace mismatch');
      botToken = identity.botToken;
      botUserId = identity.botUserId;
      client = identity.client;
    } catch {
      throw new RoutineRuntimeError(
        'credential_unavailable',
        'The Slack connection is unavailable for this routine.',
      );
    }
  } else {
    const credentials = dependencies.identityCredentials
      ? await dependencies.identityCredentials(slackIdentityId, env)
      : await (dependencies.credentials ?? resolveSlackCredentials)(env);
    if (credentials.botToken) {
      const auth = await (dependencies.authTest ?? slackAuthTest)(credentials.botToken);
      if (auth.ok && auth.botUserId && (!auth.teamId || auth.teamId === routine.workspaceId)) {
        botToken = credentials.botToken;
        botUserId = auth.botUserId;
      }
    }
  }
  if (!botToken || !botUserId) {
    throw new RoutineRuntimeError(
      'credential_unavailable',
      'The Slack connection is unavailable for this routine.',
    );
  }
  const conversation = await getConversation(botToken, routine.channelId);
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
  const creatorIsMember = await hasChannelMember(
    botToken,
    routine.channelId,
    actorSlackUserId,
    getMembers,
  );
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
    const editorIsMember = await hasChannelMember(
      botToken,
      routine.channelId,
      editorUserId,
      getMembers,
    );
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
      slackIdentityId,
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
    slackIdentityId,
    botToken,
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
