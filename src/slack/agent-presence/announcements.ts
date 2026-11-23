import type { SettingsStore } from '../../config/settings-store.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { CustomAgentConfig } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import type { ManagementStore } from '../../management/store.ts';
import { agentSlackHandle } from '../agent-asks.ts';
import { resolveSlackBehaviorSettings } from '../behavior-settings.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { renderAgentChannelWelcome } from '../message-format.ts';
import { SlackTransportError, type SlackTransport } from '../transport/types.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from './avatar-assets.ts';

/** A Channel welcome Slack accepted. */
export interface PostedAgentWelcome {
  ts: string;
  text: string;
}

export interface AgentPresenceAnnouncements {
  joinedChannel(input: {
    workspaceId: string;
    channelId: string;
    channelIsPrivate: boolean;
    agent: CustomAgentConfig;
    grantRevision: number;
    /** An Agent's own app bot, once it is in the Channel. */
    appBot?: Pick<SlackTransport, 'postMessage'>;
  }): Promise<PostedAgentWelcome | undefined>;
  handleWentLive(agent: CustomAgentConfig): Promise<void>;
}

export function agentPresenceAnnouncements(deps: {
  /** Posts a user-group Agent's welcome under its name and avatar. */
  transport: Pick<SlackTransport, 'postMessage'>;
  /** Chickpea's own bot, when it can be read. */
  installationBot: Pick<SlackTransport, 'lookupChannel'> | undefined;
  /**
   * Chickpea's own bot, to join a public Channel a person added an Agent's
   * own bot to with Slack's Add, so that Agent hears its threads' replies.
   */
  joiningInstallationBot?: Pick<SlackTransport, 'joinPublicChannel'>;
  welcomeOnJoin(): Promise<boolean>;
  avatarUrl(agent: CustomAgentConfig): string | undefined;
  management: Pick<ManagementStore, 'queueOwedAgentWelcome'>;
  now?: () => number;
}): AgentPresenceAnnouncements {
  const now = deps.now ?? Date.now;
  return {
    async joinedChannel(input) {
      const live = agentSlackHandle(input.agent);
      if (input.channelIsPrivate || !live) return;
      // An Agent with its own app greets as that app's bot, under the app's name, and only once that bot is in the Channel.
      const ownBot = 'botUserId' in live;
      // An app has no Channel message events: its thread's unmentioned replies reach it only through Chickpea's
      // bot, which joins on a person's Slack Add whether or not a welcome follows.
      const joining = ownBot && deps.joiningInstallationBot
        ? await joinUnlessIn(deps.installationBot, deps.joiningInstallationBot, input.channelId)
        : undefined;
      const sender = ownBot ? input.appBot : deps.transport;
      if (!sender || !(await deps.welcomeOnJoin())) return;
      const threadReplies = !ownBot
        ? 'heard'
        : joining ?? (await botIsIn(deps.installationBot, input.channelId) ? 'heard' : 'need_mention');
      const avatarUrl = ownBot ? undefined : deps.avatarUrl(input.agent);
      const text = renderAgentChannelWelcome({
        name: input.agent.name, description: input.agent.description, threadReplies, ...live,
      });
      const posted = await sender.postMessage({
        channelId: input.channelId,
        text,
        ...(ownBot ? {} : { persona: { name: input.agent.name, ...(avatarUrl ? { avatarUrl } : {}) } }),
        idempotencyKey: `agent-channel-welcome:${input.workspaceId}:${input.channelId}:` +
          `${input.agent.id}:${input.grantRevision}`,
      });
      return { ts: posted.ts, text };
    },
    async handleWentLive(agent) {
      const live = agentSlackHandle(agent);
      if (!live || !('userGroupId' in live)) return;
      await deps.management.queueOwedAgentWelcome({
        agentId: agent.id,
        agentName: agent.name,
        agentHandle: live.handle,
        at: now(),
      });
    },
  };
}

/** The announcements of an installation's live stores, with avatars on its public URL. */
export async function livePresenceAnnouncements(input: {
  env: PlatformEnv | undefined;
  settings: SettingsStore;
  identity: Pick<IdentityStore, 'getAuthControl'>;
  management: Pick<ManagementStore, 'queueOwedAgentWelcome'>;
  transport: Pick<SlackTransport, 'postMessage'>;
  installationBot: Pick<SlackTransport, 'lookupChannel'> | undefined;
  joiningInstallationBot?: Pick<SlackTransport, 'joinPublicChannel'>;
}): Promise<AgentPresenceAnnouncements> {
  const publicOrigin = await resolveSlackPublicUrl(input.env, input.settings, input.identity);
  const installationId = agentAvatarInstallation(input.env);
  return agentPresenceAnnouncements({
    transport: input.transport,
    installationBot: input.installationBot,
    ...(input.joiningInstallationBot ? { joiningInstallationBot: input.joiningInstallationBot } : {}),
    welcomeOnJoin: async () =>
      (await resolveSlackBehaviorSettings(input.env, input.settings)).welcomeOnJoin.value,
    avatarUrl: (agent) => agentAvatarUrlForPresentation(agent, publicOrigin, installationId),
    management: input.management,
  });
}

/** A membership Slack cannot confirm counts as absent, so a welcome never promises more than is delivered. */
async function botIsIn(bot: Pick<SlackTransport, 'lookupChannel'> | undefined, channelId: string): Promise<boolean> {
  const channel = await bot?.lookupChannel(channelId).catch(() => undefined);
  return channel?.member === true;
}

/** Chickpea's bot in a public Channel, joining it if it is not; a join Slack refuses leaves it out. */
async function joinUnlessIn(
  installationBot: Pick<SlackTransport, 'lookupChannel'> | undefined,
  joining: Pick<SlackTransport, 'joinPublicChannel'>,
  channelId: string,
): Promise<'heard' | 'heard_since_chickpea_joined' | 'need_mention'> {
  if (await botIsIn(installationBot, channelId)) return 'heard';
  try {
    return (await joining.joinPublicChannel(channelId)).member ? 'heard_since_chickpea_joined' : 'need_mention';
  } catch (error) {
    console.warn('[chickpea] Chickpea could not join a Channel beside an Agent app:',
      error instanceof SlackTransportError ? error.code : 'failed');
    return 'need_mention';
  }
}
