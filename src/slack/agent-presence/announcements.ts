import type { CustomAgentConfig } from '../../config/types.ts';
import type { ManagementStore } from '../../management/store.ts';
import { agentSlackHandle } from '../agent-asks.ts';
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
  handleWentLive(agent: CustomAgentConfig): Promise<void>;
}

export function agentPresenceAnnouncements(deps: {
  transport: Pick<SlackTransport, 'postMessage'>;
  welcomeOnJoin(): Promise<boolean>;
  avatarUrl(agent: CustomAgentConfig): string | undefined;
  management: Pick<ManagementStore, 'queueOwedAgentWelcome'>;
  now?: () => number;
}): AgentPresenceAnnouncements {
  const now = deps.now ?? Date.now;
  return {
    async joinedChannel(input) {
      const live = agentSlackHandle(input.agent);
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
    async handleWentLive(agent) {
      const live = agentSlackHandle(agent);
      if (!live) return;
      await deps.management.queueOwedAgentWelcome({
        agentId: agent.id,
        agentName: agent.name,
        agentHandle: live.handle,
        at: now(),
      });
    },
  };
}
