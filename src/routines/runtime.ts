import { isCredentialKeyringUnavailable } from '../slack/credential-keyring.ts';
import type { WebClient } from '@slack/web-api';

import {
  computeSnapshotHash,
  effectiveSlackConfigFromAssignment,
  type EffectiveSlackConfig,
  withPlainHandleIdentity,
} from '../config/effective-config.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import {
  isTransientSlackApiError,
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  slackAuthTest,
  slackConversationsInfo,
  slackConversationsMembers,
} from '../slack/credentials.ts';
import { isRetryableDependencyFailure } from '../slack/transport/types.ts';
import {
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
  SlackInstallationUnavailableError,
} from '../slack/installation-execution.ts';
import {
  classifySlackUserForAdmission,
  slackWebClientUserFacts,
} from '../slack/user-classification.ts';
import { createSlackWebClient } from '../slack/web-client.ts';
import { slackPendingExternalShare } from '../slack/transport/shared.ts';
import { resolvePrivateAgentAccess } from '../slack/agent-access.ts';
import { agentDmPlacementFacts, isAgentAppDm, withAgentAppExecution } from '../slack/agent-apps/index.ts';
import { agentSlackAppsHost } from '../slack/agent-apps/host.ts';
import { agentAppIsLive, appRecordOf } from '../config/types.ts';
import type { SlackSpeaker } from '../slack/speaker.ts';
import type { SlackContextSelf } from '../slack/thread-context.ts';
import { createDirectSlackTransportFromWebClient } from '../slack/transport/direct.ts';
import { agentAvatarInstallation } from '../slack/agent-presence/avatar-assets.ts';
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
const MEMBERSHIP_UNVERIFIED = 'Current channel membership could not be verified.';

export interface RoutineRuntimeAccess {
  config: EffectiveSlackConfig;
  accessHash: string;
  botToken?: string;
  botUserId: string;
  /** The exact authenticated client shared by context, memory, and delivery. */
  client?: WebClient;
  /**
   * The bot this run speaks as, decided at its start from its Agent and its
   * destination. Absent means Chickpea's bot under the Agent's name.
   */
  speaker?: SlackSpeaker;
  /** So an app Agent's earlier posts read alike whichever of its bots reads them, its app known by ID. */
  siblingBots?: Pick<SlackContextSelf, 'siblingBotUserIds' | 'siblingAppIds'>;
  publicUrl?: string | undefined;
  /** The installation the Agent's avatar URL names (agentAvatarInstallation). */
  avatarInstallationId?: string | undefined;
  actorMembershipId?: string;
  actorSlackUserId?: string;
  authorityReceiptId?: string;
  effectiveConnections?: EffectiveConnectionAccount[];
  /**
   * Whether the routine's Channel is shared beyond this workspace (Slack
   * Connect or across an organization), or about to be, as Slack said just
   * now. Absent for a direct-message routine.
   */
  channelShared?: boolean;
  /** One-release bridge for v0.1.19 runs whose stored fence used the catalog revision. */
  legacyAccessHashForCatalogRevision?: (catalogRevision: string | undefined) => string;
  /** Bridge for runs dispatched while the fence covered how Slack writes the Agent's handle. */
  legacyAccessHashWithHandleForm?: string;
}

/** Whether the access hash a run stored when it was dispatched still names this access. */
export function routineAccessMatches(
  access: RoutineRuntimeAccess,
  storedAccessHash: string,
  catalogRevision: string | undefined,
): boolean {
  return storedAccessHash === access.accessHash ||
    storedAccessHash === access.legacyAccessHashWithHandleForm ||
    storedAccessHash === access.legacyAccessHashForCatalogRevision?.(catalogRevision);
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

/**
 * A schedule in its Agent's own DM while that app is not live or Slack does
 * not answer: the occurrence is skipped and the schedule stays on.
 */
export class RoutineAgentAppUnavailableError extends RoutineRuntimeError {
  constructor() {
    super('credential_unavailable', "This Agent's Slack app is not available, so this run was skipped.");
    this.name = 'RoutineAgentAppUnavailableError';
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
  agentAppDm?: typeof isAgentAppDm;
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
  const resolveInstallation = dependencies.installationExecution ??
    withAgentAppExecution((workspaceId) => resolveSlackInstallationExecutionContext(workspaceId, env), env);
  if (useInstallationGate) {
    try {
      const installation = await resolveInstallation(routine.workspaceId);
      if (installation.workspaceId !== routine.workspaceId) throw new Error('workspace mismatch');
      botToken = installation.botToken;
      botUserId = installation.botUserId;
      client = installation.client;
    } catch (error) {
      // The deployment keyring not loading is transient; the routine waits for it.
      if (isCredentialKeyringUnavailable(error)) throw error;
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
  const installationBotUserId = botUserId;
  // The Agent's own app speaks where its bot can be; Chickpea's bot speaks as the Agent everywhere else.
  const presence = authority && useInstallationGate ? authority.agent.slackPresence : undefined;
  const portInstalled = Boolean(agentSlackAppsHost());
  const ownBotUserId = portInstalled && agentAppIsLive(presence) ? presence.app.botUserId : undefined;
  const ownBot = (agentId: string, appBotUserId: string) => resolveInstallation(routine.workspaceId, {
    agentId,
    speaker: { kind: 'own_bot', botUserId: appBotUserId },
  });
  // A removed app's record still names its app, so its bot's earlier posts stay the Agent's own.
  const appLifecycle = appRecordOf(presence);
  const appRecord = appLifecycle && 'app' in appLifecycle ? appLifecycle.app : undefined;
  const siblings = (speaking: string): Pick<RoutineRuntimeAccess, 'siblingBots'> => appLifecycle
    ? {
        siblingBots: {
          siblingBotUserIds: [
            installationBotUserId,
            ...('botUserId' in appLifecycle && appLifecycle.botUserId ? [appLifecycle.botUserId] : []),
          ].filter((id) => id !== speaking),
          ...(appRecord ? { siblingAppIds: [appRecord.appId] } : {}),
        },
      }
    : {};
  let speaker: SlackSpeaker | undefined;
  if (routine.destination.kind === 'direct_thread') {
    if (!authority || routine.authorityMode !== 'live_direct_member_v1') {
      throw new RoutineRuntimeError(
        'assignment_missing',
        'The direct schedule authority is unavailable.',
      );
    }
    const installationClient = client ?? createSlackWebClient(botToken);
    let directClient = installationClient;
    const actorSlackUserId = authority.actorSlackUserId;
    let rawUser: unknown;
    let directConversation: Record<string, unknown> | undefined;
    const openDirect = async (opener: WebClient) => {
      const openResponse = await opener.conversations.open({ users: actorSlackUserId });
      return openResponse.ok === true && openResponse.channel && typeof openResponse.channel === 'object'
        ? openResponse.channel as Record<string, unknown>
        : undefined;
    };
    try {
      const userResponse = await directClient.users.info({ user: actorSlackUserId });
      if (userResponse.ok === true) rawUser = userResponse.user;
      directConversation = await openDirect(directClient);
    } catch (error) {
      throw unverifiedAccess(
        isRetryableDependencyFailure(error),
        'Current direct-message access could not be verified.',
      );
    }
    const user = slackWebClientUserFacts(rawUser);
    if (
      user?.id !== actorSlackUserId ||
      actorSlackUserId === botUserId ||
      classifySlackUserForAdmission(user, routine.workspaceId, botUserId) !== 'eligible_human'
    ) {
      throw new RoutineRuntimeError(
        'creator_ineligible',
        'The direct schedule owner is no longer eligible.',
      );
    }
    // Another DM may be the app's own (isAgentAppDm); without the port or a live app, skip.
    if (
      directConversation && directConversation.id !== routine.destination.conversationId &&
      presence?.kind === 'agent_app'
    ) {
      if (!portInstalled || !agentAppIsLive(presence)) throw new RoutineAgentAppUnavailableError();
      let app: SlackInstallationExecutionContext;
      let appDm: boolean;
      try {
        app = await ownBot(authority.agent.id, presence.app.botUserId);
        appDm = await (dependencies.agentAppDm ?? isAgentAppDm)(env, {
          agentId: authority.agent.id,
          appId: presence.app.app.appId,
          userId: actorSlackUserId,
          channelId: routine.destination.conversationId,
        });
      } catch (error) {
        if (isCredentialKeyringUnavailable(error)) throw error;
        throw new RoutineAgentAppUnavailableError();
      }
      if (appDm) {
        ({ botToken, botUserId } = app);
        directClient = app.client;
        speaker = { kind: 'own_bot', botUserId };
        // conversations.open for one person names a DM.
        directConversation = { id: routine.destination.conversationId, is_im: true };
      }
    }
    if (
      !directConversation ||
      directConversation.id !== routine.destination.conversationId ||
      directConversation.is_mpim === true ||
      directConversation.is_im === false
    ) {
      throw new RoutineRuntimeError(
        'channel_ineligible',
        'The direct-message destination is no longer eligible.',
      );
    }
    const privateUse = await resolvePrivateAgentAccess({
      agent: authority.agent,
      workspaceId: routine.workspaceId,
      grants: authority.agentGrants,
      actor: {
        fullMember: true,
        membershipId: authority.reference.runsAsMembershipId,
        slackUserId: actorSlackUserId,
      },
      transport: await agentDmPlacementFacts(
        env,
        authority.agent,
        createDirectSlackTransportFromWebClient(installationClient),
      ),
    });
    if (privateUse.status === 'denied') {
      throw new RoutineRuntimeError(
        'access_denied',
        'The direct schedule owner can no longer use this Agent.',
      );
    }
    // Slack could not answer. Like a rate limit, this counts toward the
    // three failures that pause the routine; one outage never disables it.
    if (privateUse.status === 'unavailable') {
      throw unverifiedAccess(true, 'Current direct-message access could not be verified.');
    }
    const directAccessHash = (configHash: string) => hashRoutineValue(JSON.stringify({
      config: configHash,
      workspaceId: routine.workspaceId,
      actorSlackUserId,
      actorMembershipId: authority.reference.runsAsMembershipId,
      authorityReceiptId: authority.reference.authorityReceiptId,
      botUserId,
      destinationKind: routine.destination.kind,
      destinationBindingDigest: authority.reference.destinationBindingDigest,
    }));
    const accessHash = directAccessHash(routineConfigHash(config));
    return {
      config,
      accessHash,
      legacyAccessHashWithHandleForm: directAccessHash(routineConfigHashWithHandleForm(config)),
      legacyAccessHashForCatalogRevision: (catalogRevision) => directAccessHash(
        computeSnapshotHash(configWithCatalogRevision(config, catalogRevision)),
      ),
      ...(botToken ? { botToken } : {}),
      botUserId,
      client: directClient,
      ...(speaker ? { speaker } : {}),
      ...siblings(botUserId),
      publicUrl: await resolveSlackPublicUrl(env).catch(() => undefined),
      avatarInstallationId: agentAvatarInstallation(env),
      actorMembershipId: authority.reference.runsAsMembershipId,
      actorSlackUserId,
      authorityReceiptId: authority.reference.authorityReceiptId,
      effectiveConnections: authority.effectiveConnections,
    };
  }
  const readConversation = (token: string | undefined, reader: WebClient | undefined) => token
    ? getConversation(token, routine.channelId)
    : conversationFromClient(reader!, routine.channelId);
  let conversation: Awaited<ReturnType<typeof readConversation>> | undefined;
  // Its bot may be in the Channel: the app's side gave no definite answer.
  let appUnanswered = false;
  if (ownBotUserId && authority) {
    // Its own bot speaks only in a Channel it is in; Chickpea's is not asked then.
    const app = await ownBot(authority.agent.id, ownBotUserId).catch((error: unknown) => {
      if (isCredentialKeyringUnavailable(error)) throw error;
      appUnanswered = !(error instanceof SlackInstallationUnavailableError && error.reasonCode === 'agent_app_unavailable');
      return undefined;
    });
    const read = app ? await readConversation(app.botToken, app.client) : undefined;
    if (app && read?.ok && read.facts?.id === routine.channelId && read.facts.member) {
      ({ botToken, botUserId, client } = app);
      speaker = { kind: 'own_bot', botUserId };
      conversation = read;
    } else if (read && !read.ok && !terminalChannelError(read.error) && read.error !== 'not_in_channel') {
      appUnanswered = true;
    }
  }
  conversation ??= await readConversation(botToken, client);
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
    const channelIsKnownGone = conversation.error === 'channel_deleted' ||
      !!facts && (facts.archived || facts.frozen || facts.im || facts.mpim);
    // One outage never disables a Channel only the Agent's bot may be in.
    if (appUnanswered && !channelIsKnownGone) {
      throw unverifiedAccess(true, 'Current Slack channel access could not be verified.');
    }
    const channelIsKnownIneligible = !!facts && (
      facts.archived || facts.frozen || facts.im || facts.mpim || !facts.member
    );
    if (terminalChannelError(conversation.error) || channelIsKnownIneligible) {
      throw new RoutineRuntimeError('channel_ineligible', 'The routine channel is no longer eligible.');
    }
    throw unverifiedAccess(
      'slackDidNotAnswer' in conversation
        ? conversation.slackDidNotAnswer
        : isTransientSlackApiError(conversation.error),
      'Current Slack channel access could not be verified.',
    );
  }
  const actorSlackUserId = authority?.actorSlackUserId ?? routine.creatorUserId;
  if (actorSlackUserId === botUserId) {
    throw new RoutineRuntimeError('creator_ineligible', 'The routine Runs as member is no longer eligible.');
  }
  const creatorIsMember = botToken
    ? await hasChannelMember(botToken, routine.channelId, actorSlackUserId, getMembers)
    : await hasChannelMemberViaClient(client!, routine.channelId, actorSlackUserId);
  if (!creatorIsMember) {
    throw new RoutineRuntimeError('creator_ineligible', 'The routine Runs as member left this channel.');
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
    if (!editorIsMember) {
      throw new RoutineRuntimeError('creator_ineligible', 'The routine editor left this channel.');
    }
  }

  const channelAccessHash = (configHash: string) => hashRoutineValue(
    JSON.stringify({
      config: configHash,
      workspaceId: routine.workspaceId,
      actorSlackUserId,
      actorMembershipId: authority?.reference.runsAsMembershipId ?? null,
      authorityReceiptId: authority?.reference.authorityReceiptId ?? null,
      ...(!authority ? {
        creatorUserId: routine.creatorUserId,
        editorUserId: editorUserId ?? null,
      } : {}),
      // Chickpea's bot, not the bot that speaks: a run whose Agent's own bot
      // joins or leaves this Channel, or whose app is removed, before it
      // reattaches keeps its access and posts as whichever bot speaks now.
      botUserId: installationBotUserId,
      channelId: facts.id,
      channelPrivate: facts.private,
      channelShared: facts.shared || facts.externallyShared || facts.organizationShared,
    }),
  );
  const accessHash = channelAccessHash(routineConfigHash(config));
  return {
    config,
    accessHash,
    legacyAccessHashWithHandleForm: channelAccessHash(routineConfigHashWithHandleForm(config)),
    legacyAccessHashForCatalogRevision: (catalogRevision) => channelAccessHash(
      computeSnapshotHash(configWithCatalogRevision(config, catalogRevision)),
    ),
    ...(botToken ? { botToken } : {}),
    botUserId,
    ...(client ? { client } : {}),
    ...(speaker ? { speaker } : {}),
    ...siblings(botUserId),
    publicUrl: await resolveSlackPublicUrl(env).catch(() => undefined),
    avatarInstallationId: agentAvatarInstallation(env),
    ...(authority
      ? {
          actorMembershipId: authority.reference.runsAsMembershipId,
          actorSlackUserId: authority.actorSlackUserId,
          authorityReceiptId: authority.reference.authorityReceiptId,
          effectiveConnections: authority.effectiveConnections,
        }
      : {}),
    // A pending Slack Connect share counts, as it does for a Slack turn.
    channelShared: facts.shared || facts.externallyShared || facts.organizationShared || facts.pendingShared,
  };
}

function configWithCatalogRevision(
  config: EffectiveSlackConfig,
  catalogRevision: string | undefined,
): EffectiveSlackConfig {
  const { catalogRevision: _currentCatalogRevision, ...currentAttribution } = config.modelAttribution;
  return {
    ...config,
    modelAttribution: {
      ...currentAttribution,
      ...(catalogRevision === undefined ? {} : { catalogRevision }),
    },
  };
}

/**
 * Catalog hydration provenance is frozen in the runtime route, not authority.
 * A run in flight keeps its access while its Agent's handle moves between its
 * user group and its own app's bot; any other config change still ends it.
 */
function routineConfigHash(config: EffectiveSlackConfig): string {
  return computeSnapshotHash(withPlainHandleIdentity(configWithCatalogRevision(config, undefined)));
}

function routineConfigHashWithHandleForm(config: EffectiveSlackConfig): string {
  return computeSnapshotHash(configWithCatalogRevision(config, undefined));
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
        pendingShared: slackPendingExternalShare(channel),
        member: channel.is_member === true,
        ...(typeof channel.team_id === 'string' ? { teamId: channel.team_id } : {}),
        im: channel.is_im === true,
        mpim: channel.is_mpim === true,
      } : undefined,
    };
  } catch (error) {
    return {
      ok: false as const,
      error: slackPlatformErrorName(error) ?? 'conversation_unavailable',
      retryAfterMs: undefined,
      slackDidNotAnswer: isRetryableDependencyFailure(error),
    };
  }
}

/** The error name in Slack's own refusal, as the SDK throws it; undefined for any other failure. */
function slackPlatformErrorName(error: unknown): string | undefined {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: { error?: unknown } };
  return code === 'slack_webapi_platform_error' && typeof data?.error === 'string' ? data.error : undefined;
}

async function hasChannelMemberViaClient(
  client: WebClient,
  channelId: string,
  userId: string,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < MEMBERS_MAX_PAGES; page += 1) {
    let response: Awaited<ReturnType<WebClient['conversations']['members']>>;
    try {
      response = await client.conversations.members({
        channel: channelId,
        limit: MEMBERS_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      throw unverifiedAccess(isRetryableDependencyFailure(error), MEMBERSHIP_UNVERIFIED);
    }
    if (!response.ok || !Array.isArray(response.members)) {
      throw unverifiedAccess(false, MEMBERSHIP_UNVERIFIED);
    }
    if (response.members.includes(userId)) return true;
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) return false;
  }
  throw unverifiedAccess(false, MEMBERSHIP_UNVERIFIED);
}

async function hasChannelMember(
  botToken: string,
  channelId: string,
  userId: string,
  members: typeof slackConversationsMembers,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < MEMBERS_MAX_PAGES; page += 1) {
    const result = await members(botToken, channelId, {
      limit: MEMBERS_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) throw unverifiedAccess(isTransientSlackApiError(result.error), MEMBERSHIP_UNVERIFIED);
    if (result.memberIds.includes(userId)) return true;
    cursor = result.nextCursor;
    if (!cursor) return false;
  }
  throw unverifiedAccess(false, MEMBERSHIP_UNVERIFIED);
}

function unverifiedAccess(slackDidNotAnswer: boolean, publicError: string): RoutineRuntimeError {
  return new RoutineRuntimeError(slackDidNotAnswer ? 'slack_rate_limited' : 'access_denied', publicError);
}

function terminalChannelError(error: string | undefined): boolean {
  return error === 'channel_not_found' || error === 'channel_deleted';
}
