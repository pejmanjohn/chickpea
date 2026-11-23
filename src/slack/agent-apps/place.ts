import { getSlackStateStore, type PlatformEnv } from '../../config/state-backend.ts';
import { agentAppIsLive, type AgentSlackPresence } from '../../config/types.ts';
import { slackConversationsInfo } from '../credentials.ts';
import { ADMISSION_MEMBERSHIP_TTL_MS } from '../installation-execution.ts';
import { slackConversationKind } from '../thread-key.ts';
import type { SlackTransport } from '../transport/types.ts';
import type { NormalizedSlackTurn } from '../types.ts';
import { agentAppBotCredentials } from './live.ts';
import { type SlackSpeaker, speakerFor } from '../speaker.ts';

/** The bot that heard a turn at admission. */
export interface SlackTurnHearing {
  botUserId: string;
  /** An Agent's own app heard it; Chickpea's bot otherwise. */
  agentApp: boolean;
  /** Chickpea's bot beside an Agent app's delivery, to ask whether it is in the Channel. */
  installationBot?: { botUserId: string; transport: Pick<SlackTransport, 'lookupChannel'> };
}

interface MembershipFact { member: boolean; verifiedAt: number }

const MEMBERSHIP_CACHE_LIMIT = 512;
const memberships = new Map<string, MembershipFact>();

/** One bot's membership of one Channel, read at most once per admission TTL. A failed read is not kept. */
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

/** Test seam: forget every membership read. */
export function clearAdmissionMemberships(): void {
  memberships.clear();
}

async function agentBotInChannel(env: PlatformEnv | undefined, agentId: string, appId: string, channelId: string): Promise<boolean> {
  const bot = await agentAppBotCredentials(env, agentId, appId);
  if (!bot) return false;
  const info = await slackConversationsInfo(bot.botToken, channelId);
  if (!info.ok && (info.error === 'channel_not_found' || info.error === 'not_in_channel')) return false;
  if (!info.ok) throw new Error('conversations.info failed');
  return info.facts?.id === channelId && info.facts.member === true;
}

/**
 * Where an admitted turn was heard, and so the bot that answers its run
 * (speakerFor). A DM an Agent's own app heard is marked with that app's bot.
 * In a Channel, the bot that heard the turn is a member when admission
 * verified it; the other bot is asked once, with a cached
 * `conversations.info`. When the answering bot is not the one that heard the
 * turn, the turn carries its membership instead, so the run's access check
 * reuses it within the same TTL.
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
  if (conversation === 'im') {
    if (hearing.agentApp) turn.dmBotUserId = hearing.botUserId;
    return speakerFor(presence, turn.dmBotUserId ? { kind: 'agent_dm' } : { kind: 'chickpea_dm' });
  }
  if (conversation === 'mpim') return speakerFor(presence, { kind: 'group_dm', chickpeaBotIsMember: !hearing.agentApp });
  const heard: MembershipFact = turn.channelMembership?.botUserId === hearing.botUserId
    ? { member: true, verifiedAt: turn.channelMembership.verifiedAt }
    : { member: false, verifiedAt: Date.now() };
  const app = agentAppIsLive(presence) ? presence.app : undefined;
  const appFact = !app
    ? undefined
    : app.botUserId === hearing.botUserId
      ? heard
      : await botMembership(app.botUserId, turn.channelId, () =>
        agentBotInChannel(input.env, input.agentId, app.app.appId, turn.channelId));
  const chickpea = hearing.installationBot;
  // Chickpea's bot is asked only when the live app's bot is not in the Channel; otherwise the app's bot answers either way.
  const chickpeaFact = !hearing.agentApp
    ? heard
    : chickpea && !appFact?.member
      ? await botMembership(chickpea.botUserId, turn.channelId, async () =>
        (await chickpea.transport.lookupChannel(turn.channelId)).member === true)
      : undefined;
  const speaker = speakerFor(presence, {
    kind: 'channel',
    appBotIsMember: appFact?.member ?? false,
    chickpeaBotIsMember: chickpeaFact?.member ?? false,
  });
  const answering = speaker.kind === 'own_bot'
    ? { botUserId: speaker.botUserId, fact: appFact }
    : speaker.kind === 'chickpea_as_agent' && hearing.agentApp && chickpea
      ? { botUserId: chickpea.botUserId, fact: chickpeaFact }
      : undefined;
  if (answering?.fact?.member && answering.botUserId !== hearing.botUserId) {
    turn.channelMembership = { botUserId: answering.botUserId, verifiedAt: answering.fact.verifiedAt };
  }
  return speaker;
}

/**
 * The speaker a run's admission stored, read from inside that run (its turn
 * job is pending while it runs). Undefined for a run stored before its
 * speaker was, or when the state store cannot say.
 */
export async function storedRunSpeaker(env: PlatformEnv | undefined, turnJobId: string): Promise<SlackSpeaker | undefined> {
  const view = await getSlackStateStore(env).turnJobView?.(turnJobId).catch(() => undefined);
  return view?.job?.turn.speaker;
}
