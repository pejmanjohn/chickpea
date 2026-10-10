import type { SettingsStore } from '../../config/settings-store.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { CustomAgentConfig } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import type { ManagementStore } from '../../management/store.ts';
import { agentSlackHandle } from '../agent-asks.ts';
import { resolveSlackBehaviorSettings } from '../behavior-settings.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { renderAgentChannelWelcome } from '../message-format.ts';
import type { SlackTransport } from '../transport/types.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from './avatar-assets.ts';

export interface AgentPresenceAnnouncements {
  joinedChannel(input: {
    workspaceId: string;
    channelId: string;
    channelIsPrivate: boolean;
    agent: CustomAgentConfig;
    grantRevision: number;
    /** An Agent's own app bot, once it is in the Channel. */
    appBot?: Pick<SlackTransport, 'postMessage'>;
  }): Promise<void>;
  handleWentLive(agent: CustomAgentConfig): Promise<void>;
}

export function agentPresenceAnnouncements(deps: {
  /** Posts a user-group Agent's welcome under its name and avatar. */
  transport: Pick<SlackTransport, 'postMessage'>;
  /** Chickpea's own bot, when it can be read. */
  installationBot: Pick<SlackTransport, 'lookupChannel'> | undefined;
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
      const sender = ownBot ? input.appBot : deps.transport;
      if (!sender || !(await deps.welcomeOnJoin())) return;
      // An app has no Channel message events: its thread's unmentioned replies reach it only through Chickpea's bot.
      const hearsThreadReplies = !ownBot || await botIsIn(deps.installationBot, input.channelId);
      const avatarUrl = ownBot ? undefined : deps.avatarUrl(input.agent);
      await sender.postMessage({
        channelId: input.channelId,
        text: renderAgentChannelWelcome({
          name: input.agent.name, description: input.agent.description, hearsThreadReplies, ...live,
        }),
        ...(ownBot ? {} : { persona: { name: input.agent.name, ...(avatarUrl ? { avatarUrl } : {}) } }),
        idempotencyKey: `agent-channel-welcome:${input.workspaceId}:${input.channelId}:` +
          `${input.agent.id}:${input.grantRevision}`,
      });
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
}): Promise<AgentPresenceAnnouncements> {
  const publicOrigin = await resolveSlackPublicUrl(input.env, input.settings, input.identity);
  const installationId = agentAvatarInstallation(input.env);
  return agentPresenceAnnouncements({
    transport: input.transport,
    installationBot: input.installationBot,
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
