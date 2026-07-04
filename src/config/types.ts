export type ProviderId = 'claude' | 'workers-ai';

export interface CustomAgentConfig {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  model?: string;
  defaultModels: Record<ProviderId, string>;
  allowedTools: string[];
}

export interface ChannelAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  enabled: boolean;
  channelPromptAddendum?: string;
}

export interface BotIdentityConfig {
  avatarPath: string;
}

export interface ResolvedAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  channelPromptAddendum?: string;
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
