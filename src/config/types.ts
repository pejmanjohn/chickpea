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
  /** Stable provenance for a copied built-in suggestion; absent for custom/imported skills. */
  suggestedSkillId?: string;
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
  /** Reusable-account credential projection for one custom MCP header. */
  credentialHeaderName?: string;
  /** Safe, non-secret prefix prepended to the reusable account credential. */
  credentialValuePrefix?: string;
  /** The connector remains usable when no credential is stored. */
  credentialOptional?: boolean;
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

/** Internal credential-store coordinate for the single customer-owned Slack app. */
export const WORKSPACE_SLACK_INSTALLATION_ID = 'workspace_slack_installation';

export interface AgentChannelReference {
  workspaceId: string;
  channelId: string;
}

export interface AgentReferenceSummary {
  agentId: string;
  channelGrants: AgentChannelReference[];
}

export type AgentLifecycle = 'draft' | 'active' | 'needs_attention' | 'archived';
export type AgentEditPolicy = 'creator_and_admins' | 'all_workspace_members';
export type AgentPresenceDesiredState = 'unpublished' | 'active' | 'disabled';
export type AgentPresenceHealth =
  | 'unpublished'
  | 'pending'
  | 'healthy'
  | 'needs_attention';

export interface AgentAvatarRevision {
  kind: 'generated' | 'uploaded';
  revision: number;
  /** Stable seed for generated art; absent after a user replaces the image. */
  seed?: string;
  /** Immutable public asset used for future Slack messages. */
  url?: string;
}

/** Desired and observed Slack address state owned directly by an Agent. */
export interface AgentSlackPresence {
  requestedHandle: string;
  normalizedHandle: string;
  desiredState: AgentPresenceDesiredState;
  health: AgentPresenceHealth;
  avatar: AgentAvatarRevision;
  userGroupId?: string;
  /**
   * Durable evidence recorded immediately before a non-idempotent
   * `usergroups.create` call. Slack has no idempotency key for that API, so a
   * retry may adopt a matching group only when its immutable preflight facts
   * prove that it was created by the ambiguous attempt.
   */
  pendingCreate?: {
    name: string;
    handle: string;
    description: string;
    startedAt: number;
  };
  errorCode?: string;
  errorDetail?: string;
  observedAt?: number;
}

export interface CustomAgentConfig {
  id: string;
  /** Durable optimistic-concurrency token. Persisted agents always expose it. */
  revision: number;
  name: string;
  description?: string;
  instructions: string;
  enabled: boolean;
  /** New Agent-platform lifecycle. Optional only while legacy call sites move. */
  lifecycle?: AgentLifecycle;
  creatorMembershipId?: string;
  editPolicy?: AgentEditPolicy;
  configurationGeneration?: number;
  slackPresence?: AgentSlackPresence;
  archivedAt?: number;
  model?: string;
  skills: SkillConfig[];
  mcpServers: McpConnectionConfig[];
  apiConnections: ApiConnectionConfig[];
  repositories: RepositoryGrant[];
}

export type SlackTransportMode = 'direct' | 'gateway';
export type InstallationHealth = 'pending' | 'healthy' | 'needs_attention' | 'revoked';

/** One Slack installation per deployed workspace; never a user-facing identity. */
export interface WorkspaceInstallation {
  workspaceId: string;
  revision: number;
  transportMode: SlackTransportMode;
  defaultAgentId: string;
  teamId?: string;
  appId?: string;
  botUserId?: string;
  gatewayBindingId?: string;
  health: InstallationHealth;
  healthDetail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EnsureWorkspaceInstallationInput {
  workspaceId: string;
  transportMode: SlackTransportMode;
  defaultAgentId?: string;
  teamId?: string;
  appId?: string;
  botUserId?: string;
  gatewayBindingId?: string;
}

export interface WorkspaceInstallationPatch {
  transportMode?: SlackTransportMode;
  teamId?: string | null;
  appId?: string | null;
  botUserId?: string | null;
  gatewayBindingId?: string | null;
  health?: InstallationHealth;
  healthDetail?: string | null;
}

export type AgentChannelGrantStatus = 'pending' | 'active' | 'needs_attention';

/** A Channel grants reach to many Agents and carries no behavior of its own. */
export interface AgentChannelGrant {
  workspaceId: string;
  channelId: string;
  agentId: string;
  revision: number;
  status: AgentChannelGrantStatus;
  createdByMembershipId: string;
  channelLabel?: string;
  channelIsPrivate?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentChannelGrantInput = Omit<
  AgentChannelGrant,
  'revision' | 'createdAt' | 'updatedAt'
>;

export interface AgentThreadRoute {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  agentId: string;
  agentGeneration: number;
  revision: number;
  updatedAt: number;
}

export type AgentThreadRouteInput = Omit<AgentThreadRoute, 'revision' | 'updatedAt'>;

export type ConnectionAccountOwnerKind = 'team' | 'member';
export type ConnectionAccountLifecycle = 'pending' | 'ready' | 'needs_attention' | 'revoked';

/** Non-secret API policy owned by a reusable connection account. */
export interface ConnectionAccountApiPolicy {
  kind: 'api';
  allowedHosts: string[];
  pathPrefixes: string[];
  headerName: string;
  headerValuePrefix?: string;
  allowedMethods: string[];
  authMode: 'credential' | 'oauth';
  oauthProvider?: 'google';
  oauthScopes?: string[];
  oauthAppType?: 'workspace-internal' | 'external';
  /** Internal generation token for the currently authorized OAuth attempt. */
  oauthAttemptId?: string;
  presetId?: string;
}

/** Non-secret MCP policy owned by a reusable connection account. */
export interface ConnectionAccountMcpPolicy {
  kind: 'mcp';
  url: string;
  transport: 'streamable-http' | 'sse';
  authMode: 'none' | 'bearer' | 'oauth';
  headerNames: string[];
  /** Header that receives this account's single write-only credential. */
  credentialHeaderName?: string;
  credentialValuePrefix?: string;
  /** The connector remains usable when no credential is stored. */
  credentialOptional?: boolean;
  discoveredTools: McpConnectionToolInfo[];
  allowedTools: string[];
  oauthScope?: string;
  /** Internal generation token for the currently authorized OAuth attempt. */
  oauthAttemptId?: string;
  presetId?: string;
}

export type ConnectionAccountPolicy =
  | ConnectionAccountApiPolicy
  | ConnectionAccountMcpPolicy;

/** Reusable credential ownership record; secret material stays behind secretRefId. */
export interface ConnectionAccount {
  id: string;
  workspaceId: string;
  revision: number;
  ownerKind: ConnectionAccountOwnerKind;
  /** Required for personal accounts and absent for team accounts. */
  ownerMembershipId?: string;
  /** The member who may manage a team account alongside Chickpea Admins. */
  createdByMembershipId: string;
  providerId: string;
  label: string;
  purpose?: string;
  identity?: McpConnectionIdentity;
  policy: ConnectionAccountPolicy;
  secretRefId: string;
  lifecycle: ConnectionAccountLifecycle;
  createdAt: number;
  updatedAt: number;
}

export type ConnectionAccountInput = Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>;

export interface AgentConnectionBinding {
  agentId: string;
  connectionAccountId: string;
  providerId: string;
  /** Empty means every capability allowed by the account policy. */
  allowedCapabilities: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentConnectionBindingInput = Omit<
  AgentConnectionBinding,
  'createdAt' | 'updatedAt'
>;

export type AgentScheduleState = 'active' | 'paused' | 'needs_attention' | 'archived';

/** Cross-domain authority reference; the routine engine owns execution details. */
export interface AgentScheduleReference {
  scheduleId: string;
  agentId: string;
  workspaceId: string;
  channelId: string;
  createdByMembershipId: string;
  /** The current trusted actor whose personal accounts and authority are used. */
  runsAsMembershipId: string;
  /** Changes only through an explicit authority assignment receipt. */
  authorityReceiptId: string;
  requiredConnectionAccountIds: string[];
  state: AgentScheduleState;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type AgentScheduleReferenceInput = Omit<
  AgentScheduleReference,
  'revision' | 'createdAt' | 'updatedAt'
>;

/** Create/seed input. Persistence assigns revision 1 regardless of caller input. */
export type AgentCreateInput = Omit<CustomAgentConfig, 'revision'> & { revision?: number };

export type ChannelLifecycle = 'active' | 'archived';

/** Reach-only Slack Channel inventory. Agent behavior lives on the Agent. */
export interface ChannelConfig {
  workspaceId: string;
  channelId: string;
  /** Persisted Channels always expose a positive revision. */
  revision?: number;
  label?: string;
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
  channelLabel?: string;
  /** Live Channel inventory revision; missing on direct conversations. */
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
