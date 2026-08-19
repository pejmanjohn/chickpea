/**
 * An Agent-attached skill: a named playbook the Agent can load on demand.
 * `name` must satisfy Flue's `defineSkill` rule (`^[a-z0-9]+(?:-[a-z0-9]+)*$`,
 * ≤64) and is unique per Agent; `instructions` is the SKILL.md body Flue
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
 * Truncated to keep the Agent row bounded (name ≤120, title ≤160, desc ≤400).
 * Policy only — never a secret.
 */
export interface McpConnectionToolInfo {
  name: string;
  title?: string;
  description?: string;
}

/** Non-secret account labels returned by a provider identity probe. */
export interface McpConnectionIdentity {
  workspaceName?: string;
  accountName?: string;
}

/**
 * An Agent-attached remote MCP server ("Connection"): tools added by URL that
 * join the Agent's toolset at the `slack-thread.ts` seam. This is POLICY ONLY —
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
  authMode: 'none' | 'bearer' | 'oauth';
  headerNames: string[];
  enabled: boolean;
  lifecycleStatus: 'pending' | 'ready' | 'failed';
  statusText: string;
  discoveredTools: McpConnectionToolInfo[];
  allowedTools: string[];
  /** OAuth scopes are connection policy, never credentials. */
  oauthScope?: string;
  lastCheckedAt?: number;
  identity?: McpConnectionIdentity;
  /**
   * Policy-only back-reference to the connector-preset catalog used to create
   * this connection; enables badge rendering and "reset to preset".
   */
  presetId?: string;
}

/**
 * An Agent-attached API credential-connection policy. This record contains
 * allowlisted request metadata only — the credential value lives in the
 * settings store by reference and never touches this row, snapshots, or API
 * responses.
 */
export interface ApiConnectionConfig {
  id: string;
  displayName: string;
  allowedHosts: string[];
  pathPrefixes: string[];
  headerName: string;
  headerValuePrefix?: string;
  allowedMethods: string[];
  enabled: boolean;
  /** Missing on legacy rows; credential means a static write-only secret. */
  authMode?: 'credential' | 'oauth';
  oauthProvider?: 'google';
  /** Exact provider scopes are policy and safe to expose; tokens are not. */
  oauthScopes?: string[];
  oauthAppType?: 'workspace-internal' | 'external';
  lifecycleStatus?: 'pending' | 'ready' | 'failed';
  statusText?: string;
  identity?: McpConnectionIdentity;
  presetId?: string;
}

export interface RepositoryGrant {
  id: string;
  installationId: number | null;
  accountLogin: string;
  fullName: string;
  allRepos?: boolean;
  enabled: boolean;
}

export type OpenAiAuthMethod = 'api_key' | 'subscription';

/** Stable identity inherited by every Agent without an explicit selection. */
export const WORKSPACE_DEFAULT_SLACK_IDENTITY_ID = 'slack_identity_default';

export type SlackIdentityKind = 'workspace_default' | 'dedicated';
export type SlackIdentityLifecycle =
  | 'setup_incomplete'
  | 'credentials_pending'
  | 'connected'
  | 'degraded'
  | 'retired';
export type SlackIdentityDmState = 'on' | 'off' | 'needs_setup';
export type SlackIdentityCredentialProvenance = 'workspace_default' | 'stored' | 'none';
export type SlackIdentityHealth =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'disconnected'
  | 'uninstalled'
  | 'unauthorized';

export interface SlackIdentitySetupIntent {
  appName?: string;
  displayName?: string;
  sourceAgentId?: string;
  /** Agent identity binding captured when Agent-origin setup began. */
  sourceAgentSlackIdentityId?: string | null;
  /** True after an established identity starts credential replacement. */
  reconnecting?: boolean;
}

/**
 * Non-secret Slack app policy and observed metadata. Bot tokens and signing
 * secrets never enter this record; they are addressed by `id` in SettingsStore.
 * `ingressKey` is sensitive routing material and must stay out of non-Admin
 * responses and logs even though request signatures remain the auth boundary.
 */
export interface SlackIdentity {
  id: string;
  ingressKey: string;
  kind: SlackIdentityKind;
  lifecycle: SlackIdentityLifecycle;
  teamId?: string;
  appId?: string;
  botUserId?: string;
  dmState: SlackIdentityDmState;
  dmAgentId?: string;
  credentialProvenance: SlackIdentityCredentialProvenance;
  connectionRevision: number;
  observedDisplayName?: string;
  observedAvatarUrl?: string;
  observedAt?: number;
  health: SlackIdentityHealth;
  healthDetail?: string;
  createdAt: number;
  updatedAt: number;
  retiredAt?: number;
  setupIntent?: SlackIdentitySetupIntent;
}

export interface SlackIdentityReferenceSummary {
  identityId: string;
  agentIds: string[];
  dmAgentId?: string;
}

export interface AgentChannelReference {
  workspaceId: string;
  channelId: string;
}

export interface AgentReferenceSummary {
  agentId: string;
  channelAssignments: AgentChannelReference[];
  dmIdentityIds: string[];
  identityReferenceIds: string[];
}

export interface CustomAgentConfig {
  id: string;
  /** Durable optimistic-concurrency token. Persisted agents always expose it. */
  revision: number;
  name: string;
  instructions: string;
  enabled: boolean;
  model?: string;
  skills: SkillConfig[];
  mcpServers: McpConnectionConfig[];
  apiConnections: ApiConnectionConfig[];
  repositories: RepositoryGrant[];
  /** Missing means inherit WORKSPACE_DEFAULT_SLACK_IDENTITY_ID. */
  slackIdentityId?: string;
}

/** Create/seed input. Persistence assigns revision 1 regardless of caller input. */
export type AgentCreateInput = Omit<CustomAgentConfig, 'revision'> & { revision?: number };

export interface ChannelAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
}

export interface ChannelPlacementMutation {
  channel: ChannelConfig;
  agentId: string | null;
  expectedAgentId: string | null;
  /** Management callers provide this to fence both content and placement. */
  expectedRevision?: number;
}

export interface ChannelPlacementResult {
  channel: ChannelConfig;
  assignment: ChannelAssignment | null;
}

export type ChannelParticipationMode = 'ambient' | 'mention_only';
export type ChannelLifecycle = 'active' | 'archived';

/** Durable Channel-owned state. Agent placement lives only in ChannelAssignment. */
export interface ChannelConfig {
  workspaceId: string;
  channelId: string;
  /** Persisted Channels always expose a positive revision. */
  revision?: number;
  label?: string;
  additionalInstructions?: string;
  participationMode: ChannelParticipationMode;
  lifecycle: ChannelLifecycle;
}

export interface BotIdentityConfig {
  avatarPath: string;
}

export interface ModelCredentialAttribution {
  credentialRefId: string;
  version: number;
  providerId: string;
  sourceKind: 'stored' | 'environment' | 'cloudflare_binding' | 'custom';
  label: string;
  scopeLabel: string | null;
  unknownRotation: boolean;
}

export interface ResolvedAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  /** Effective Slack transport for this assignment. Missing only on legacy snapshots. */
  slackIdentityId?: string;
  channelLabel?: string;
  channelPromptAddendum?: string;
  participationMode?: 'ambient' | 'mention_only';
  /** Live Channel CAS revision; missing on DMs and legacy snapshots. */
  channelRevision?: number;
  agent: CustomAgentConfig;
  // Optional pre-resolved model label. Set only when the assignment is served
  // from a frozen thread snapshot; undefined means resolve from the agent via
  // model policy at turn time.
  model?: string;
  modelCredential?: ModelCredentialAttribution;
}

// A snapshot IS a resolved assignment frozen at a thread's first turn, plus the
// resolved model/provider/instructions. Declaring the relation lets a
// snapshot be used directly wherever a ResolvedAssignment is expected.
export interface AgentSnapshot extends ResolvedAssignment {
  schemaVersion: 2;
  model: string;
  providerId: string;
  instructions: string;
  repositories: RepositoryGrant[];
  snapshotHash: string;
  createdAt: number;
}

export interface AgentSnapshotRootReference {
  threadKey: string;
  agentId: string;
  lastActivityAt: number;
}
