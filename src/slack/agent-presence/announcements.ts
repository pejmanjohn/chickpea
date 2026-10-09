import type { CustomAgentConfig } from '../../config/types.ts';
import type { ManagementStore } from '../../management/store.ts';
import { renderAgentChannelWelcome } from '../message-format.ts';
import type { SlackTransport } from '../transport/types.ts';

export interface AgentPresenceAnnouncements {
  joinedChannel(input: {
    workspaceId: string;
    channelId: string;
    channelIsPrivate: boolean;
    agent: CustomAgentConfig;
    grantRevision: number;
  }): Promise<void>;
  published(agent: CustomAgentConfig): Promise<void>;
}

export function agentPresenceAnnouncements(deps: {
  transport: Pick<SlackTransport, 'postMessage'>;
  welcomeOnJoin(): Promise<boolean>;
  avatarUrl(agent: CustomAgentConfig): string | undefined;
  management: Pick<ManagementStore, 'releaseAgentWelcome'>;
  now?: () => number;
}): AgentPresenceAnnouncements {
  const now = deps.now ?? Date.now;
  return {
    async joinedChannel(input) {
      const live = liveHandle(input.agent);
      if (input.channelIsPrivate || !live || !(await deps.welcomeOnJoin())) return;
      const avatarUrl = deps.avatarUrl(input.agent);
      await deps.transport.postMessage({
        channelId: input.channelId,
        text: renderAgentChannelWelcome({
          name: input.agent.name,
          description: input.agent.description,
          handle: live.handle,
          userGroupId: live.userGroupId,
        }),
        persona: { name: input.agent.name, ...(avatarUrl ? { avatarUrl } : {}) },
        idempotencyKey: `agent-channel-welcome:${input.workspaceId}:${input.channelId}:` +
          `${input.agent.id}:${input.grantRevision}`,
      });
    },
    async published(agent) {
      const live = liveHandle(agent);
      if (!live) return;
      await deps.management.releaseAgentWelcome({
        agentId: agent.id,
        agentName: agent.name,
        agentHandle: live.handle,
        at: now(),
      });
    },
  };
}

function liveHandle(
  agent: CustomAgentConfig,
): { userGroupId: string; handle: string } | undefined {
  const presence = agent.slackPresence;
  if (!presence?.userGroupId || !presence.normalizedHandle) return undefined;
  return { userGroupId: presence.userGroupId, handle: presence.normalizedHandle };
}
