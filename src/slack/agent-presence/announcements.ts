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
  }): Promise<void>;
  handleWentLive(agent: CustomAgentConfig): Promise<void>;
}

export function agentPresenceAnnouncements(deps: {
  transport: Pick<SlackTransport, 'postMessage'>;
  /** The bot user `transport` posts as, when the caller knows it: an Agent with its own app greets only as its bot. */
  botUserId?: string;
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
      // An Agent with its own app greets as that app's bot, which cannot post under another name.
      const ownBot = 'botUserId' in live;
      if ((ownBot && live.botUserId !== deps.botUserId) || !(await deps.welcomeOnJoin())) return;
      const avatarUrl = ownBot ? undefined : deps.avatarUrl(input.agent);
      await deps.transport.postMessage({
        channelId: input.channelId,
        text: renderAgentChannelWelcome({ name: input.agent.name, description: input.agent.description, ...live }),
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
  botUserId?: string;
}): Promise<AgentPresenceAnnouncements> {
  const publicOrigin = await resolveSlackPublicUrl(input.env, input.settings, input.identity);
  const installationId = agentAvatarInstallation(input.env);
  return agentPresenceAnnouncements({
    transport: input.transport,
    ...(input.botUserId ? { botUserId: input.botUserId } : {}),
    welcomeOnJoin: async () =>
      (await resolveSlackBehaviorSettings(input.env, input.settings)).welcomeOnJoin.value,
    avatarUrl: (agent) => agentAvatarUrlForPresentation(agent, publicOrigin, installationId),
    management: input.management,
  });
}
