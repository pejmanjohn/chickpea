import { getSlackStateStore, type PlatformEnv } from '../../config/state-backend.ts';
import {
  type ActiveAgentApp,
  agentAppIsLive,
  type AgentSlackPresence,
  type CustomAgentConfig,
} from '../../config/types.ts';
import { isTransientSlackApiError, slackConversationsInfo, slackConversationsOpen } from '../credentials.ts';
import { ADMISSION_MEMBERSHIP_TTL_MS } from '../installation-execution.ts';
import { type SlackSpeaker, speakerFor } from '../speaker.ts';
import { slackConversationKind } from '../thread-key.ts';
import { type SlackTransport, SlackTransportError } from '../transport/types.ts';
import type { NormalizedSlackTurn } from '../types.ts';
import { agentSlackAppsHost } from './host.ts';
import { agentAppBotCredentials } from './live.ts';

/** The bot that heard a turn at admission. */
export interface SlackTurnHearing {
  botUserId: string;
  /** An Agent's own app heard it; Chickpea's bot otherwise. */
  agentApp: boolean;
  /** Chickpea built the turn (an ask, a setup's wake, a hand-off), so no bot's hearing says which DM it is in. */
  byHost?: boolean;
  /** Slack said the bot that heard it is not in the Channel. */
  notInChannel?: boolean;
  /** Chickpea's bot beside an Agent app's delivery, to ask whether it is in the Channel. */
  installationBot?: { botUserId: string; transport: Pick<SlackTransport, 'lookupChannel'> };
}

interface MembershipFact { member: boolean; verifiedAt: number }

const MEMBERSHIP_CACHE_LIMIT = 512;
const memberships = new Map<string, MembershipFact>();

/** One bot's membership of one conversation, read at most once per admission TTL in this isolate. A failed read throws and is not kept. */
async function botMembership(botUserId: string, channelId: string, read: () => Promise<boolean>): Promise<MembershipFact> {
  const key = `${botUserId}\u0000${channelId}`;
  const now = Date.now();
  const cached = memberships.get(key);
  if (cached && now - cached.verifiedAt >= 0 && now - cached.verifiedAt < ADMISSION_MEMBERSHIP_TTL_MS) return cached;
  const member = await read();
  if (memberships.size >= MEMBERSHIP_CACHE_LIMIT) memberships.clear();
  const fact = { member, verifiedAt: now };
  memberships.set(key, fact);
  return fact;
}

export function clearAdmissionMembershipsForTests(): void {
  memberships.clear();
}

/** A membership read that failed, which a Channel or group DM place counts as "not a member". */
const notVerified = (): MembershipFact => ({ member: false, verifiedAt: Date.now() });

/** Whether an Agent app's bot is in a Channel or group DM, asked on its own token. */
async function agentBotIsIn(env: PlatformEnv | undefined, agentId: string, appId: string, channelId: string): Promise<boolean> {
  const bot = await agentAppBotCredentials(env, agentId, appId);
  if (!bot) return false;
  const info = await slackConversationsInfo(bot.botToken, channelId);
  if (!info.ok && (info.error === 'channel_not_found' || info.error === 'not_in_channel')) return false;
  if (!info.ok) throw new Error('conversations.info failed');
  return info.facts?.id === channelId && (info.facts.mpim || info.facts.member);
}

/**
 * Whether `channelId` is the DM between an Agent app's bot and the person
 * `userId`, asked on the app's own token. An Agent app holds `im:write` but
 * never `im:read`, so Slack refuses `conversations.info` on a DM for it
 * (`missing_scope`); `conversations.open` names the app's DM with that person
 * instead. False when the app has no live bot. When Slack does not say, this
 * throws a `SlackTransportError` (retryable for an outage or a rate limit):
 * the caller must not guess whose DM it is.
 */
export async function isAgentAppDm(
  env: PlatformEnv | undefined,
  input: { agentId: string; appId: string; userId: string; channelId: string },
): Promise<boolean> {
  const bot = await agentAppBotCredentials(env, input.agentId, input.appId);
  if (!bot) return false;
  const opened = await slackConversationsOpen(bot.botToken, input.userId);
  if (!opened.ok) {
    const code = opened.error ?? 'invalid_response';
    throw new SlackTransportError('conversations.open', code, {
      retryable: isTransientSlackApiError(code),
      effectOutcome: 'failed',
      ...(opened.retryAfterMs === undefined ? {} : { retryAfterMs: opened.retryAfterMs }),
    });
  }
  return opened.channelId === input.channelId;
}

/**
 * Whether an Agent's own app can answer in a Channel or group DM: the host
 * serves it, it is live, its token can be read, and its bot is a member. This
 * is the same cached fact admission reads for the speaker, so the two never
 * disagree within its TTL. A read that fails counts as "cannot answer here",
 * as admission counts it, so Chickpea routes the mention and the message's
 * claim keeps one answer if the app's own delivery routes it too.
 */
export async function agentAppAnswersIn(
  env: PlatformEnv | undefined,
  agent: Pick<CustomAgentConfig, 'id' | 'slackPresence'>,
  channelId: string,
): Promise<boolean> {
  const presence = agent.slackPresence;
  if (!agentSlackAppsHost() || !agentAppIsLive(presence)) return false;
  const { app } = presence;
  return (await botMembership(app.botUserId, channelId, () =>
    agentBotIsIn(env, agent.id, app.app.appId, channelId)).catch(notVerified)).member;
}

/**
 * Where an admitted turn was heard, and so the bot that answers its run
 * (speakerFor). A DM an Agent's own app heard is marked with that app's bot;
 * a DM turn Chickpea built is the app's own when the app's DM with the
 * person is this one (isAgentAppDm, cached), and a DM marked with another
 * bot is no DM of this Agent's. When Slack does not answer that question the
 * admission throws, so no bot is chosen for a DM it may not be in; a turn
 * Chickpea built retries its admission, and one still not admitted is
 * reported as such (a setup's wake posts its notice instead). In a Channel or
 * group DM the bot that heard the turn counts as a member unless Slack said
 * it is not, and the run's access check verifies it; the other bot is asked
 * once with a cached `conversations.info`, and a failed read counts as not a
 * member, whichever bot heard the turn. In a Channel, when the answering bot
 * is not the one that heard the turn, the turn carries its membership
 * instead, so the run's access check reuses it within the same TTL.
 */
export async function admissionSpeaker(input: {
  turn: NormalizedSlackTurn;
  agentId: string;
  presence: AgentSlackPresence | undefined;
  hearing: SlackTurnHearing;
  env: PlatformEnv | undefined;
}): Promise<SlackSpeaker> {
  const { turn, presence, hearing } = input;
  const conversation = slackConversationKind(turn);
  const app = agentAppIsLive(presence) ? presence.app : undefined;
  const appBotIn = (live: ActiveAgentApp) => botMembership(live.botUserId, turn.channelId, () =>
    agentBotIsIn(input.env, input.agentId, live.app.appId, turn.channelId)).catch(notVerified);
  if (conversation === 'im') {
    const appDm = (live: ActiveAgentApp) => botMembership(live.botUserId, turn.channelId, () =>
      isAgentAppDm(input.env, { agentId: input.agentId, appId: live.app.appId, userId: turn.userId, channelId: turn.channelId }));
    if (hearing.agentApp) turn.dmBotUserId = hearing.botUserId;
    else if (hearing.byHost && app && !turn.dmBotUserId && (await appDm(app)).member) turn.dmBotUserId = app.botUserId;
    if (!turn.dmBotUserId) return speakerFor(presence, { kind: 'chickpea_dm' });
    if (presence?.kind !== 'agent_app' || (app && app.botUserId !== turn.dmBotUserId)) {
      return { kind: 'unavailable', reason: 'no_bot_can_post' };
    }
    return speakerFor(presence, { kind: 'agent_dm' });
  }
  const heardMember = !hearing.notInChannel;
  const appFact = app && app.botUserId !== hearing.botUserId ? await appBotIn(app) : undefined;
  const appBotIsMember = !app ? false : appFact ? appFact.member : heardMember;
  const chickpea = hearing.installationBot;
  // Chickpea's bot is asked only when the live app's bot is not in the Channel; otherwise the app's bot answers either way.
  const chickpeaFact = hearing.agentApp && chickpea && !appBotIsMember
    ? await botMembership(chickpea.botUserId, turn.channelId, async () =>
      (await chickpea.transport.lookupChannel(turn.channelId)).member === true).catch(notVerified)
    : undefined;
  const speaker = speakerFor(presence, {
    kind: conversation === 'mpim' ? 'group_dm' : 'channel',
    appBotIsMember,
    chickpeaBotIsMember: hearing.agentApp ? chickpeaFact?.member ?? false : heardMember,
  });
  // A group DM has no membership for the run's access check to reuse.
  if (conversation === 'mpim') return speaker;
  const answering = speaker.kind === 'own_bot'
    ? appFact && { botUserId: speaker.botUserId, fact: appFact }
    : speaker.kind === 'chickpea_as_agent' && chickpea && chickpeaFact
      ? { botUserId: chickpea.botUserId, fact: chickpeaFact }
      : undefined;
  if (answering?.fact.member) {
    turn.channelMembership = { botUserId: answering.botUserId, verifiedAt: answering.fact.verifiedAt };
  }
  return speaker;
}

/**
 * The speaker of a post Chickpea makes for an Agent outside its runs, such as
 * a notice in one of its threads. A DM is the Agent app's own only when Slack
 * names it as the app's DM with the person `userId` (isAgentAppDm); with no
 * person to ask about, it is placed as Chickpea's DM. In a Channel or group
 * DM the app's bot answers when it is a member, and Chickpea's bot is taken
 * to be one, as for a turn Chickpea builds there. The caller asks only with
 * the port on.
 */
export async function hostPostSpeaker(input: {
  env: PlatformEnv | undefined;
  agentId: string;
  presence: AgentSlackPresence | undefined;
  channelId: string;
  userId?: string;
}): Promise<SlackSpeaker> {
  const { presence } = input;
  const app = agentAppIsLive(presence) ? presence.app : undefined;
  if (input.channelId.startsWith('D')) {
    const own = app && input.userId
      ? await isAgentAppDm(input.env, { agentId: input.agentId, appId: app.app.appId, userId: input.userId, channelId: input.channelId })
      : false;
    return speakerFor(presence, { kind: own ? 'agent_dm' : 'chickpea_dm' });
  }
  const appBotIsMember = app
    ? (await botMembership(app.botUserId, input.channelId, () =>
      agentBotIsIn(input.env, input.agentId, app.app.appId, input.channelId)).catch(notVerified)).member
    : false;
  return speakerFor(presence, { kind: 'channel', appBotIsMember, chickpeaBotIsMember: true });
}

/**
 * The speaker a run's admission stored, read from inside that run (its turn
 * job is pending while it runs). Undefined for a run stored before its
 * speaker was, or one no longer pending. A failed read throws: the caller
 * must not guess the bot.
 */
export async function storedRunSpeaker(env: PlatformEnv | undefined, turnJobId: string): Promise<SlackSpeaker | undefined> {
  const view = await getSlackStateStore(env).turnJobView?.(turnJobId);
  return view?.job?.turn.speaker;
}
