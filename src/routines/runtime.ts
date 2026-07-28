import { computeSnapshotHash, resolveEffectiveSlackConfig, type EffectiveSlackConfig } from '../config/effective-config.ts';
import { NoAssignmentError } from '../config/errors.ts';
import { getConfigStore, type PlatformEnv } from '../config/state-backend.ts';
import {
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  slackAuthTest,
  slackConversationsInfo,
  slackConversationsMembers,
} from '../slack/credentials.ts';
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
  botToken: string;
  botUserId: string;
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
  authTest?: typeof slackAuthTest;
  conversation?: typeof slackConversationsInfo;
  members?: typeof slackConversationsMembers;
  config?: (
    workspaceId: string,
    channelId: string,
    env: PlatformEnv | undefined,
  ) => Promise<EffectiveSlackConfig>;
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
  const getCredentials = dependencies.credentials ?? resolveSlackCredentials;
  const checkAuth = dependencies.authTest ?? slackAuthTest;
  const getConversation = dependencies.conversation ?? slackConversationsInfo;
  const getMembers = dependencies.members ?? slackConversationsMembers;

  const credentials = await getCredentials(env);
  if (!credentials.botToken) {
    throw new RoutineRuntimeError(
      'credential_unavailable',
      'The Slack connection is unavailable for this routine.',
    );
  }
  const auth = await checkAuth(credentials.botToken);
  if (!auth.ok || !auth.botUserId || (auth.teamId && auth.teamId !== routine.workspaceId)) {
    throw new RoutineRuntimeError(
      'credential_unavailable',
      'The Slack connection is unavailable for this routine.',
    );
  }
  const conversation = await getConversation(credentials.botToken, routine.channelId);
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
  if (routine.creatorUserId === auth.botUserId) {
    throw new RoutineRuntimeError('creator_ineligible', 'The routine creator is no longer eligible.');
  }
  const creatorIsMember = await hasChannelMember(
    credentials.botToken,
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
  const accessHash = hashRoutineValue(
    JSON.stringify({
      config: computeSnapshotHash(config),
      creatorUserId: routine.creatorUserId,
      botUserId: auth.botUserId,
      channelId: facts.id,
      channelPrivate: facts.private,
      channelShared: facts.shared || facts.externallyShared || facts.organizationShared,
    }),
  );
  return {
    config,
    accessHash,
    botToken: credentials.botToken,
    botUserId: auth.botUserId,
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
