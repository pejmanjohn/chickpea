/**
 * A profile-attached skill: a named playbook the agent can load on demand.
 * `name` must satisfy Flue's `defineSkill` rule (`^[a-z0-9]+(?:-[a-z0-9]+)*$`,
 * ≤64) and is unique per profile; `instructions` is the SKILL.md body Flue
 * surfaces only after the model activates the skill (progressive disclosure).
 * Only `enabled` skills are materialized at turn time.
 */
export interface SkillConfig {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

/**
 * Metadata for a single tool discovered on an MCP server's last successful test.
 * Truncated to keep the profile row bounded (name ≤120, title ≤160, desc ≤400).
 * Policy only — never a secret.
 */
export interface McpConnectionToolInfo {
  name: string;
  title?: string;
  description?: string;
}

/**
 * A profile-attached remote MCP server ("Connection"): tools added by URL that
 * join the agent's toolset at the `slack-thread.ts` seam. This is POLICY ONLY —
 * bearer tokens and header values live in the settings store by reference
 * (`headerNames` carries the names, never the values) and never touch this row,
 * snapshots, or API responses. The security invariant is `approved ∩ discovered`:
 * only tools in `allowedTools` that are still in `discoveredTools` are exposed.
 */
export interface McpConnectionConfig {
  id: string;
  displayName: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  authMode: 'none' | 'bearer';
  headerNames: string[];
  enabled: boolean;
  lifecycleStatus: 'pending' | 'ready' | 'failed';
  statusText: string;
  discoveredTools: McpConnectionToolInfo[];
  allowedTools: string[];
  lastCheckedAt?: number;
  /**
   * Policy-only back-reference to the connector-preset catalog used to create
   * this connection; enables badge rendering and "reset to preset".
   */
  presetId?: string;
}

export interface CustomAgentConfig {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  model?: string;
  skills: SkillConfig[];
  mcpServers: McpConnectionConfig[];
}

export interface ChannelAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  enabled: boolean;
  channelLabel?: string;
  channelPromptAddendum?: string;
}

export interface BotIdentityConfig {
  avatarPath: string;
}

export interface ResolvedAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  channelLabel?: string;
  channelPromptAddendum?: string;
  agent: CustomAgentConfig;
  // Optional pre-resolved model label. Set only when the assignment is served
  // from a frozen thread snapshot; undefined means resolve from the agent via
  // model policy at turn time.
  model?: string;
}

// A snapshot IS a resolved assignment frozen at a thread's first turn, plus the
// resolved model/provider/instructions. Declaring the relation lets a
// snapshot be used directly wherever a ResolvedAssignment is expected.
export interface AgentSnapshot extends ResolvedAssignment {
  model: string;
  providerId: string;
  instructions: string;
  snapshotHash: string;
  createdAt: number;
}
