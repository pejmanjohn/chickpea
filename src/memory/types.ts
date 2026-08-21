export class MemoryStateError extends Error {
  override readonly name: string = 'MemoryStateError';

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** The complete durable memory for one Agent. It has no Channel or user scope. */
export interface AgentMemory {
  agentId: string;
  body: string;
  revision: number;
}

export interface PutAgentMemoryInput {
  agentId: string;
  body: string;
  expectedRevision: number;
}

export type MemoryRpcRequest =
  | { kind: 'get_agent_memory'; agentId: string }
  | { kind: 'put_agent_memory'; input: PutAgentMemoryInput };

export type MemoryRpcResponse = { kind: 'agent_memory'; memory: AgentMemory };

export interface MemoryStateStore {
  getAgentMemory(agentId: string): Promise<AgentMemory>;
  putAgentMemory(input: PutAgentMemoryInput): Promise<AgentMemory>;
  close?(): void;
}
