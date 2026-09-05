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
  /** Origin of the imported snapshot; retained when its local copy is edited. */
  importSource?: {
    repository: string;
    commit: string;
    path: string;
    contentSha256: string;
  };
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
  /** Agent-owned connection credential projection for one custom MCP header. */
  credentialHeaderName?: string;
  /** Safe, non-secret prefix prepended to the connection credential. */
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
export type AgentKind = 'user' | 'system';
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
  /** Prior generated selections, in revision order, for immutable asset URLs. */
  generatedSeedHistory?: Array<{ throughRevision: number; seed: string }>;
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
  /** System Agents are product-owned and never appear in user-Agent administration. */
  kind: AgentKind;
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
export type WorkspaceRuntimeContract = 'legacy' | 'chickpea-v1';

export type WorkspaceModelDefaultProvenance =
  | 'installation_bootstrap'
  | 'migrated_agent'
  | 'migrated_environment'
  | 'migration_pending'
  | 'admin_selected';

/** Live Workspace model policy. Provider readiness is derived, not persisted here. */
export interface WorkspaceModelDefault {
  workspaceId: string;
  /** Missing while migration or installation requires an administrator to choose a model. */
  modelId?: string;
  revision: number;
  provenance: WorkspaceModelDefaultProvenance;
  lastChangedByMembershipId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceModelDefaultInput {
  workspaceId: string;
  modelId?: string;
  provenance: WorkspaceModelDefaultProvenance;
  lastChangedByMembershipId?: string;
}

export type ChickpeaCutoverModelClassification =
  | 'untouched_cloudflare_starter'
  | 'explicit_agent_pin'
  | 'environment_default'
  | 'model_missing';

export type ChickpeaCutoverState = 'prepared' | 'activated' | 'rolled_back';

/** Non-secret Stage 1 evidence. Provider health is joined at the operator boundary. */
export interface ChickpeaCutoverPreflight {
  workspaceId: string;
  state: ChickpeaCutoverState;
  runtimeContract: WorkspaceRuntimeContract;
  installationRevision: number;
  defaultModelId?: string;
  defaultRevision: number;
  defaultProvenance: WorkspaceModelDefaultProvenance;
  modelClassification: ChickpeaCutoverModelClassification;
  systemPrincipalCount: number;
  validChickpeaPrincipalCount: number;
  routeCount: number;
  routeBackfillCount: number;
  pinnedAgentCount: number;
  inheritingAgentCount: number;
  starterPinClearCount: number;
  uncertainStarterPinCount: number;
  collisions: Array<{
    agentId: string;
    field: 'id' | 'name' | 'handle' | 'system_principal';
  }>;
  blockers: Array<
    | 'workspace_default_missing'
    | 'reserved_identity_collision'
    | 'system_principal_invalid'
  >;
}

export interface PrepareChickpeaCutoverInput {
  workspaceId: string;
  /** Captured once during Stage 1; never consulted by activated runtime policy. */
  legacyEnvironmentModel?: string;
}

export interface ActivateChickpeaCutoverInput {
  workspaceId: string;
  expectedInstallationRevision: number;
  expectedDefaultRevision: number;
  /** Static catalog and credential preflight result from the trusted operator boundary. */
  defaultReady: boolean;
}

export interface ChickpeaCutoverActivation {
  workspaceId: string;
  runtimeContract: WorkspaceRuntimeContract;
  installationRevision: number;
  defaultRevision: number;
  systemAgentId: string;
  routeCount: number;
  routeBackfillCount: number;
  starterPinCleared: boolean;
  starterPinPreserved: boolean;
  activatedAt: number;
}

export interface RollbackChickpeaCutoverInput {
  workspaceId: string;
  expectedInstallationRevision: number;
}

/** One Slack installation per deployed workspace; never a user-facing identity. */
export interface WorkspaceInstallation {
  workspaceId: string;
  revision: number;
  transportMode: SlackTransportMode;
  runtimeContract: WorkspaceRuntimeContract;
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
  /** Defaults to chickpea-v1. 'legacy' exists only for compatibility installs. */
  runtimeContract?: WorkspaceRuntimeContract;
}

export interface WorkspaceInstallationPatch {
  transportMode?: SlackTransportMode;
  /** Internal rollout gate; Admin never writes this directly. */
  runtimeContract?: WorkspaceRuntimeContract;
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
  /** Positive tenure counter for this owner within the Slack root. */
  ownerIncarnation: number;
  /** Frozen retry receipt for the message that most recently changed owners. */
  handoff?: AgentThreadHandoff;
  revision: number;
  updatedAt: number;
}

export interface AgentThreadHandoff {
  transferMessageTs: string;
  previousAgentId: string;
  /** Undefined until the bounded legacy fallback has been attempted. */
  context?: Array<{
    messageTs: string;
    role: 'human' | 'agent';
    text: string;
    agentId?: string;
  }>;
}

export type AgentThreadRouteInput = Omit<
  AgentThreadRoute,
  'revision' | 'updatedAt' | 'ownerIncarnation'
> & {
  /** Optional only during the Stage 1 compatibility window; defaults to 1. */
  ownerIncarnation?: number;
};

export type SlackPublicContextRole = 'human' | 'agent';

/** Internal Slack-visible context used only when a thread transfers owners. */
export interface SlackPublicContextEntry {
  workspaceId: string;
  channelId: string;
  rootTs: string;
  messageTs: string;
  role: SlackPublicContextRole;
  text: string;
  agentId?: string;
  updatedAt: number;
}

export type SlackPublicContextEntryInput = Omit<SlackPublicContextEntry, 'updatedAt'>;

export type ConnectionAccountOwnerKind = 'team' | 'member';
export type ConnectionAccountLifecycle = 'pending' | 'ready' | 'needs_attention' | 'revoked';

/** Non-secret API policy owned by one Agent-scoped connection account. */
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

/** Non-secret MCP policy owned by one Agent-scoped connection account. */
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

/**
 * Non-secret policy for an account whose OAuth tokens and API execution are
 * delegated to a managed connector provider. Chickpea still owns account
 * selection, Agent capability ceilings, and invocation authorization.
 */
export interface ManagedResourceSelection {
  /** Opaque Chickpea identifier safe to expose in a runtime plan. */
  handle: string;
  /** Provider identifier kept in execution-only policy. */
  providerRef: string;
  /** Display-safe Admin label. */
  label: string;
  /** Structured Google Ads billing currency; never inferred from the display label. */
  currencyCode?: string;
}

export type ManagedAccountResourceConstraints = Record<
  string,
  ManagedResourceSelection[]
>;

export type ManagedBindingResourceConstraints = Record<string, string[]>;

/** Durable upper bound shared by account ceilings, Agent bindings, and Admin discovery. */
export const MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY = 256;

export interface ManagedProviderGrantSummary {
  /** Display-only provider-grant evidence; never used as a local authorization list. */
  items: Array<{ type: 'page' | 'database'; label: string }>;
  truncated: boolean;
}

export interface ConnectionAccountManagedPolicy {
  kind: 'managed';
  /** Connector infrastructure adapter, for example `composio`. */
  adapterId: string;
  /** Provider-local toolkit identifier, for example `gmail`. */
  toolkit: string;
  /** Opaque remote principal used to isolate this account at the adapter. */
  principalRef: string;
  /** Exact opaque remote account to pin on every invocation. */
  accountRef: string;
  /** Stable Chickpea capability names, never raw provider tool slugs. */
  allowedCapabilities: string[];
  /** Account-level resource maximum. Provider references stay execution-only. */
  resourceConstraints?: ManagedAccountResourceConstraints;
  /** Safe summary of the provider-enforced grant, such as Notion's page picker. */
  grantSummary?: ManagedProviderGrantSummary;
  /** Common generation-token shape used by generic connection policy handling. */
  oauthAttemptId?: string;
  /** Installation provider revision that last validated this exact account. */
  providerGeneration?: number;
  /** One-way project fingerprint. It is safe metadata, never a credential. */
  providerLineage?: string;
}

export type ConnectionAccountPolicy =
  | ConnectionAccountApiPolicy
  | ConnectionAccountMcpPolicy
  | ConnectionAccountManagedPolicy;

/**
 * Agent-scoped connection record. Its durable binding is the ownership record.
 * Native secret material stays behind secretRefId; managed policies keep that
 * local slot empty.
 */
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
  /** Chickpea-local resource handles that may only narrow the account maximum. */
  resourceConstraints?: ManagedBindingResourceConstraints;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentConnectionBindingInput = Omit<
  AgentConnectionBinding,
  'createdAt' | 'updatedAt'
>;

export interface AgentOwnedConnectionInput {
  account: ConnectionAccountInput;
  binding: AgentConnectionBindingInput;
}

export interface AgentOwnedConnection {
  account: ConnectionAccount;
  binding: AgentConnectionBinding;
}

export type AgentScheduleState = 'active' | 'paused' | 'needs_attention' | 'archived';

/** Cross-domain authority reference; the routine engine owns execution details. */
export interface AgentScheduleReference {
  scheduleId: string;
  agentId: string;
  workspaceId: string;
  channelId: string;
  destinationKind: 'channel' | 'direct_thread';
  /** Internal consistency checksum. Never expose it as an authority credential. */
  destinationBindingDigest: string | null;
  createdByMembershipId: string;
  /** The current trusted actor whose personal accounts and authority are used. */
  runsAsMembershipId: string;
  /** Changes only through an explicit authority assignment receipt. */
  authorityReceiptId: string;
  requiredConnectionAccountIds: string[];
  /** Connections whose provider outage changed this schedule from active to needs-attention. */
  connectionPauseAccountIds?: string[];
  /** The schedule was already non-active before the first recorded connection outage. */
  connectionPausePreservesState?: boolean;
  state: AgentScheduleState;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type AgentScheduleReferenceInput = Omit<
  AgentScheduleReference,
  | 'destinationKind'
  | 'destinationBindingDigest'
  | 'revision'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** Omitted legacy callers remain Channel references. */
  destinationKind?: AgentScheduleReference['destinationKind'];
  destinationBindingDigest?: string | null;
};

/** Create/seed input. Persistence assigns revision 1 regardless of caller input. */
export type AgentCreateInput = Omit<CustomAgentConfig, 'revision' | 'kind'> & {
  revision?: number;
  /** User is the only accepted public default; system creation uses a dedicated gate. */
  kind?: AgentKind;
};

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

export type AgentModelSource = 'workspace_default' | 'pinned' | 'legacy_environment';

/** Non-secret policy facts frozen when a message is admitted. */
export interface AgentModelAttribution {
  source: AgentModelSource;
  providerId: string;
  /** Present only when source is Workspace default. */
  workspaceDefaultRevision?: number;
  /** Active model-catalog revision when one governed this route. */
  catalogRevision?: string;
}

export interface ResolvedAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  /** Routing contract frozen when Slack admits the message. */
  runtimeContract?: WorkspaceRuntimeContract;
  /** Explicit base-app channel mentions are a memoryless workspace-management entry point. */
  interactionMode?: 'workspace_management';
  channelLabel?: string;
  /** Live Channel inventory revision; missing on direct conversations. */
  channelRevision?: number;
  /** Persisted ownership epoch; later handoffs increment it. */
  ownerIncarnation?: number;
  /** Bounded Slack-visible history frozen only for an ownership handoff. */
  handoffContext?: Array<Pick<
    SlackPublicContextEntry,
    'messageTs' | 'role' | 'text' | 'agentId'
  >>;
  agent: CustomAgentConfig;
  // Optional pre-resolved model label. Set only when the assignment is served
  // from a frozen thread snapshot; undefined means resolve from the agent via
  // model policy at turn time.
  model?: string;
  modelAttribution?: AgentModelAttribution;
  modelCredential?: ModelCredentialAttribution;
}

// A snapshot IS a resolved assignment frozen at a thread's first turn, plus the
// resolved model/provider/instructions. Declaring the relation lets a
// snapshot be used directly wherever a ResolvedAssignment is expected.
interface AgentSnapshotBase extends ResolvedAssignment {
  model: string;
  providerId: string;
  instructions: string;
  repositories: RepositoryGrant[];
  snapshotHash: string;
  createdAt: number;
}

/** Read compatibility for work admitted before Workspace-default attribution existed. */
export interface AgentSnapshotV2 extends AgentSnapshotBase {
  schemaVersion: 2;
}

export interface AgentSnapshotV3 extends AgentSnapshotBase {
  schemaVersion: 3;
  modelAttribution: AgentModelAttribution;
}

export type AgentSnapshot = AgentSnapshotV2 | AgentSnapshotV3;

export interface AgentSnapshotRootReference {
  threadKey: string;
  agentId: string;
  lastActivityAt: number;
}
