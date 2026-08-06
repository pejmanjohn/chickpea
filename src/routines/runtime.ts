import type { WebClient } from '@slack/web-api';

import {
  computeSnapshotHash,
  resolveEffectiveSlackConfig,
  type EffectiveSlackConfig,
} from '../config/effective-config.ts';
import { NoAssignmentError } from '../config/errors.ts';
import { getConfigStore, type PlatformEnv } from '../config/state-backend.ts';
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
  const routineStore = dependencies.config ?? (async (workspaceId, channelId, platformEnv) => {
    const config = getConfigStore(platformEnv);
    return resolveEffectiveSlackConfig(workspaceId, channelId, {
      agents: config,
      assignments: config,
    });
  });
  const getConversation = dependencies.conversation ?? slackConversationsInfo;
  const getMembers = dependencies.members ?? slackConversationsMembers;

  let config: EffectiveSlackConfig;
  try {
    config = await routineStore(routine.workspaceId, routine.channelId, env);
  } catch (error) {
    if (error instanceof NoAssignmentError) {
      throw new RoutineRuntimeError(
        'assignment_missing',
        'This channel no longer has an active Chickpea profile.',
      );
    }
    throw new RoutineRuntimeError('access_denied', 'Current channel access could not be resolved.');
  }
  const slackIdentityId = config.slackIdentityId ?? WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
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
  if (routine.creatorUserId === botUserId) {
    throw new RoutineRuntimeError('creator_ineligible', 'The routine creator is no longer eligible.');
  }
  const creatorIsMember = await hasChannelMember(
    botToken,
    routine.channelId,
    routine.creatorUserId,
    getMembers,
  );
  if (creatorIsMember === false) {
    throw new RoutineRuntimeError('creator_ineligible', 'The routine creator left this channel.');
  }
  if (creatorIsMember === undefined) {
    throw new RoutineRuntimeError('access_denied', 'Current channel membership could not be verified.');
  }

  const accessHash = hashRoutineValue(
    JSON.stringify({
      config: computeSnapshotHash(config),
      slackIdentityId,
      creatorUserId: routine.creatorUserId,
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
