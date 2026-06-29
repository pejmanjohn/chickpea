import { seededChannelBriefs } from '../config/seed.ts';
import type { CustomAgentConfig } from '../config/types.ts';

export class ToolDeniedError extends Error {
  constructor(agentId: string, toolName: string) {
    super(`Tool ${toolName} is not allowed for agent ${agentId}`);
    this.name = 'ToolDeniedError';
  }
}

export interface ToolRunResult {
  toolName: string;
  content: string;
}

export async function runAllowedTool(
  agent: CustomAgentConfig,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolRunResult> {
  if (!agent.allowedTools.includes(toolName)) {
    throw new ToolDeniedError(agent.id, toolName);
  }

  if (toolName === 'lookup_channel_brief') {
    const channelId = String(input.channelId ?? '');
    return {
      toolName,
      content: seededChannelBriefs[channelId] ?? 'No configured channel brief is available.',
    };
  }

  throw new Error(`Unknown safe tool ${toolName}`);
}
