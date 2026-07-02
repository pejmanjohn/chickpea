export type ProviderId = 'claude' | 'workers-ai';

export interface CustomAgentConfig {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  defaultModels: Record<ProviderId, string>;
  allowedTools: string[];
}

export interface ChannelAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  enabled: boolean;
}

export interface BotIdentityConfig {
  avatarPath: string;
}

export interface ResolvedAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  agent: CustomAgentConfig;
}

export interface AgentSnapshot {
  agent: CustomAgentConfig;
  model: string;
  providerId: ProviderId;
  allowedTools: string[];
  snapshotHash: string;
  createdAt: number;
}
