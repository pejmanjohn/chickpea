import type { ConfigStore } from '../../config/store.ts';
import { recordDeliveredSlackAgentMessage } from '../public-context.ts';

export async function routeRepliesToAgent(
  config: Pick<ConfigStore, 'putAgentThreadRoute' | 'putSlackPublicContext' | 'getWorkspaceInstallation'>,
  input: {
    workspaceId: string;
    channelId: string;
    messageTs: string;
    text: string;
    agent: { id: string; revision: number; configurationGeneration?: number | undefined };
  },
): Promise<void> {
  const { workspaceId, channelId, messageTs, agent } = input;
  await config.putAgentThreadRoute({
    workspaceId,
    channelId,
    threadTs: messageTs,
    agentId: agent.id,
    agentGeneration: agent.configurationGeneration ?? agent.revision,
    ownerIncarnation: 1,
  }, 0);
  const installation = await config.getWorkspaceInstallation(workspaceId);
  if (!installation) return;
  await recordDeliveredSlackAgentMessage(
    config,
    { workspaceId, channelId, threadTs: messageTs },
    { runtimeContract: installation.runtimeContract, agentId: agent.id },
    { messageTs, text: input.text },
  );
}
