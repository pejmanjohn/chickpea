import type { CustomAgentConfig, ProviderId } from '../config/types.ts';
import type { SessionRecord } from '../runtime/session-store.ts';
import type { ToolRunResult } from '../tools/safe-tools.ts';

export interface ProviderRequest {
  agent: CustomAgentConfig;
  message: string;
  session: SessionRecord;
  toolResults: ToolRunResult[];
}

export interface ProviderResponse {
  providerId: ProviderId;
  model: string;
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
}

export interface ModelProvider {
  readonly providerId: ProviderId;
  readonly model: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}
