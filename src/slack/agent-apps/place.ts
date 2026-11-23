import { getSlackStateStore, type PlatformEnv } from '../../config/state-backend.ts';
import {
  type ActiveAgentApp,
  agentAppIsLive,
  type AgentSlackPresence,
  type CustomAgentConfig,
} from '../../config/types.ts';
import { slackConversationsInfo } from '../credentials.ts';
import { ADMISSION_MEMBERSHIP_TTL_MS } from '../installation-execution.ts';
import { type SlackSpeaker, speakerFor } from '../speaker.ts';
import { slackConversationKind } from '../thread-key.ts';
import type { SlackTransport } from '../transport/types.ts';
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

/** One bot's membership of one conversation, read at most once per admission TTL in this isolate. A failed read is not kept. */
async function botMembership(botUserId: string, channelId: string, read: () => Promise<boolean>): Promise<MembershipFact> {
  const key = `${botUserId}\u0000${channelId}`;
  const now = Date.now();
  const cached = memberships.get(key);
  if (cached && now - cached.verifiedAt >= 0 && now - cached.verifiedAt < ADMISSION_MEMBERSHIP_TTL_MS) return cached;
  let member: boolean;
  try {
    member = await read();
  } catch {
    return { member: false, verifiedAt: now };
  }
  if (memberships.size >= MEMBERSHIP_CACHE_LIMIT) memberships.clear();
  const fact = { member, verifiedAt: now };
  memberships.set(key, fact);
  return fact;
}

export function clearAdmissionMembershipsForTests(): void {
  memberships.clear();
}

/** Whether an Agent app's bot is in a conversation, asked on its own token. A bot sees a DM only when it is one side of it. */
async function agentBotIsIn(env: PlatformEnv | undefined, agentId: string, appId: string, channelId: string): Promise<boolean> {
  const bot = await agentAppBotCredentials(env, agentId, appId);
  if (!bot) return false;
  const info = await slackConversationsInfo(bot.botToken, channelId);
  if (!info.ok && (info.error === 'channel_not_found' || info.error === 'not_in_channel')) return false;
  if (!info.ok) throw new Error('conversations.info failed');
  return info.facts?.id === channelId && (info.facts.im || info.facts.mpim || info.facts.member);
}

/**
 * Whether an Agent's own app can answer in a Channel or group DM: the host
 * serves it, it is live, its token can be read, and its bot is a member. This
 * is the same cached fact admission reads for the speaker, so the two never
 * disagree within its TTL.
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
    agentBotIsIn(env, agent.id, app.app.appId, channelId))).member;
}

/**
 * Where an admitted turn was heard, and so the bot that answers its run
 * (speakerFor). A DM an Agent's own app heard is marked with that app's bot;
 * a DM turn Chickpea built is the app's own when the app's bot can see it,
 * and a DM marked with another bot is no DM of this Agent's. In a Channel or
 * group DM the bot that heard the turn counts as a member unless Slack said
 * it is not, and the run's access check verifies it; the other bot is asked
 * once with a cached `conversations.info`. When the answering bot is not the
 * one that heard the turn, the turn carries its membership instead, so the
 * run's access check reuses it within the same TTL.
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
    agentBotIsIn(input.env, input.agentId, live.app.appId, turn.channelId));
  if (conversation === 'im') {
    if (hearing.agentApp) turn.dmBotUserId = hearing.botUserId;
    else if (hearing.byHost && app && !turn.dmBotUserId && (await appBotIn(app)).member) turn.dmBotUserId = app.botUserId;
    if (!turn.dmBotUserId) return speakerFor(presence, { kind: 'chickpea_dm' });
    if (presence?.kind !== 'agent_app' || (app && app.botUserId !== turn.dmBotUserId)) {
      return { kind: 'unavailable', reason: 'no_bot_can_post' };
    }
    return speakerFor(presence, { kind: 'agent_dm' });
  }
  const heardMember = !hearing.notInChannel;
  if (conversation === 'mpim') {
    const appBotIsMember = !app
      ? false
      : hearing.agentApp
        ? app.botUserId === hearing.botUserId
        : Boolean(hearing.byHost) && (await appBotIn(app)).member;
    return speakerFor(presence, { kind: 'group_dm', appBotIsMember, chickpeaBotIsMember: !hearing.agentApp && heardMember });
  }
  const appFact = app && app.botUserId !== hearing.botUserId ? await appBotIn(app) : undefined;
  const appBotIsMember = !app ? false : appFact ? appFact.member : heardMember;
  const chickpea = hearing.installationBot;
  // Chickpea's bot is asked only when the live app's bot is not in the Channel; otherwise the app's bot answers either way.
  const chickpeaFact = hearing.agentApp && chickpea && !appBotIsMember
    ? await botMembership(chickpea.botUserId, turn.channelId, async () =>
      (await chickpea.transport.lookupChannel(turn.channelId)).member === true)
    : undefined;
  const speaker = speakerFor(presence, {
    kind: 'channel',
    appBotIsMember,
    chickpeaBotIsMember: hearing.agentApp ? chickpeaFact?.member ?? false : heardMember,
  });
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
 * The speaker a run's admission stored, read from inside that run (its turn
 * job is pending while it runs). Undefined for a run stored before its
 * speaker was, or one no longer pending. A failed read throws: the caller
 * must not guess the bot.
 */
export async function storedRunSpeaker(env: PlatformEnv | undefined, turnJobId: string): Promise<SlackSpeaker | undefined> {
  const view = await getSlackStateStore(env).turnJobView?.(turnJobId);
  return view?.job?.turn.speaker;
}
