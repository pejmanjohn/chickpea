import { agentAppIsLive, type AgentSlackPresence } from '../config/types.ts';

/** Where a turn was heard, and which bots can post there. */
export type SlackPlace =
  /** The Agent's own app heard it, in that app's DM. */
  | { kind: 'agent_dm' }
  /** Chickpea heard it in Chickpea's DM; also what a turn with no DM marker means. */
  | { kind: 'chickpea_dm' }
  | { kind: 'group_dm'; chickpeaBotIsMember: boolean }
  | { kind: 'channel'; appBotIsMember: boolean; chickpeaBotIsMember: boolean };

/** Which bot answers a run, decided once at its admission. */
export type SlackSpeaker =
  /** The Agent app's own token, never with a persona. */
  | { kind: 'own_bot'; botUserId: string }
  /** Chickpea's token, always under the Agent's name and picture. */
  | { kind: 'chickpea_as_agent' }
  | { kind: 'unavailable'; reason: 'no_bot_can_post' | 'app_removed' };

/**
 * An Agent answers as its own Slack app wherever that app is live and its
 * bot can be; anywhere else Chickpea's bot posts as the Agent. An app token
 * is never used outside the app's own DM and its bot's Channels, and never
 * in a group DM.
 */
export function speakerFor(presence: AgentSlackPresence | undefined, place: SlackPlace): SlackSpeaker {
  const ownBot = agentAppIsLive(presence) ? presence.app.botUserId : undefined;
  switch (place.kind) {
    case 'agent_dm':
      return ownBot ? { kind: 'own_bot', botUserId: ownBot } : { kind: 'unavailable', reason: 'app_removed' };
    case 'chickpea_dm':
      return { kind: 'chickpea_as_agent' };
    case 'group_dm':
      return place.chickpeaBotIsMember ? { kind: 'chickpea_as_agent' } : { kind: 'unavailable', reason: 'no_bot_can_post' };
    case 'channel':
      if (ownBot && place.appBotIsMember) return { kind: 'own_bot', botUserId: ownBot };
      return place.chickpeaBotIsMember ? { kind: 'chickpea_as_agent' } : { kind: 'unavailable', reason: 'no_bot_can_post' };
  }
}
