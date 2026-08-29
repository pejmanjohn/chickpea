import type { ConfigAgentPatch } from '../config/store.ts';
import type {
  AgentEditPolicy,
  AgentChannelGrantStatus,
  AgentCreateInput,
  ChannelConfig,
  ConnectionAccountOwnerKind,
} from '../config/types.ts';
import type {
  MembershipStatus,
  OrganizationRole,
} from '../identity/types.ts';
import type {
  RoutineDefinition,
  RoutineOutputPolicy,
  RoutineState,
} from '../routines/types.ts';
import type { AgentAuthoringReason } from './agent-authoring/index.ts';

export type ManagementOrigin =
  | {
      kind: 'slack';
      workspaceId: string;
      channelId: string;
      threadTs: string;
      /** Trusted requester message coordinate for durable Slack acknowledgements. */
      messageTs?: string;
      /** Trusted normalized Slack surface. Missing legacy origins receive no implicit Channel grant. */
      conversationKind?: 'channel' | 'im' | 'mpim';
      /** Trusted Agent selected by Slack routing, never by model text. */
      agentId?: string;
    }
  | {
      kind: 'mcp';
      clientId: string;
    }
  | {
      kind: 'admin';
      sessionId: string;
    };

/** Trusted adapter context. It is never part of a model-selected operation. */
export interface ManagementActorContext {
  userId: string;
  membershipId: string;
  organizationId: string;
  /** Trusted executing Agent. Adapters derive this from routing, never model text. */
  actingAgentId?: string;
  origin: ManagementOrigin;
}

export interface LiveManagementActor extends ManagementActorContext {
  role: OrganizationRole;
}

interface ManagementOperationBase {
  itemId: string;
  dependsOn?: string[];
}

/** Public Agent draft accepted by workspace management adapters. */
export type ManagementAgentCreateInput = Omit<
  AgentCreateInput,
  | 'revision'
  | 'creatorMembershipId'
  | 'configurationGeneration'
  | 'slackPresence'
  | 'archivedAt'
  | 'lifecycle'
> & {
  description?: string;
  requestedHandle?: string;
  editPolicy?: AgentEditPolicy;
};

/** Presentation-aware patch; requestedHandle is projected into Slack presence. */
export type ManagementAgentPatch = ConfigAgentPatch & {
  requestedHandle?: string;
};

export type ManagementOperation =
  | (ManagementOperationBase & {
      kind: 'create_agent';
      clientRef?: string;
      agent: ManagementAgentCreateInput;
    })
  | (ManagementOperationBase & {
      kind: 'update_agent';
      agentId: string;
      expectedRevision: number;
      /** Forces confirmation when a portable recipe replaces the Agent definition. */
      confirmationReason?: 'recipe_overwrite';
      patch: ManagementAgentPatch;
    })
  | (ManagementOperationBase & {
      kind: 'delete_agent';
      agentId: string;
      expectedRevision: number;
    })
  | (ManagementOperationBase & {
      kind: 'archive_agent';
      agentId: string;
      expectedRevision: number;
      replacementDefaultAgentId?: string;
    })
  | (ManagementOperationBase & {
      kind: 'restore_agent';
      agentId: string;
      expectedRevision: number;
    })
  | (ManagementOperationBase & {
      kind: 'put_channel';
      channel: ChannelConfig;
      expectedRevision: number;
    })
  | (ManagementOperationBase & {
      kind: 'grant_agent_channel';
      workspaceId: string;
      channelId: string;
      expectedRevision: number;
      agentId?: string;
      agentClientRef?: string;
    })
  | (ManagementOperationBase & {
      kind: 'revoke_agent_channel';
      workspaceId: string;
      channelId: string;
      agentId: string;
      expectedRevision: number;
    })
  | (ManagementOperationBase & {
      kind: 'update_member';
      membershipId: string;
      role?: OrganizationRole;
      status?: MembershipStatus;
    })
  | (ManagementOperationBase & {
      kind: 'remove_provider_credential';
      providerId: 'anthropic' | 'openai' | 'openrouter';
    })
  | (ManagementOperationBase & {
      kind: 'update_agent_memory';
      agentId: string;
      expectedRevision: number;
      body: string;
    })
  | (ManagementOperationBase & {
      kind: 'save_routine';
      agentId: string;
      workspaceId: string;
      /** Required for Channel work. Direct work resolves only from trusted Slack origin. */
      channelId?: string;
      destination?: { kind: 'current_dm_thread' };
      routineId?: string;
      expectedVersion?: number;
      name: string;
      description: string;
      taskText: string;
      schedule:
        | { kind: 'cron'; expression: string }
        | { kind: 'once'; localDateTime: string }
        /** Relative lead time; the service computes the future instant on its own clock. */
        | { kind: 'in'; minutes: number };
      timezone: string;
      outputPolicy: RoutineOutputPolicy;
    })
  | (ManagementOperationBase & {
      kind: 'control_routine';
      workspaceId: string;
      channelId?: string;
      routineId: string;
      expectedVersion: number;
      action: 'pause' | 'resume' | 'disable';
    })
  | (ManagementOperationBase & {
      kind: 'run_routine';
      workspaceId: string;
      channelId?: string;
      routineId: string;
    })
  | (ManagementOperationBase & {
      kind: 'delete_routine';
      workspaceId: string;
      channelId?: string;
      routineId: string;
      expectedVersion: number;
    })
  | (ManagementOperationBase & {
      kind: 'reassign_routine_agent';
      workspaceId: string;
      routineId: string;
      expectedVersion: number;
      agentId: string;
    })
  | (ManagementOperationBase & {
      kind: 'request_setup';
      target: ManagementSetupRequestTarget;
    });

export type ManagementSetupRequestTarget =
  | {
      kind: 'api_connection';
      agentId?: string;
      agentClientRef?: string;
      connectionId: string;
    }
  | {
      kind: 'mcp_connection';
      agentId?: string;
      agentClientRef?: string;
      connectionId: string;
    }
  | {
      kind: 'repository_access';
      agentId?: string;
      agentClientRef?: string;
      repositoryId: string;
    }
  | {
      kind: 'provider_credential';
      providerId: 'anthropic' | 'openai' | 'openrouter';
    }
  ;

export type ManagementDisposition =
  | 'applied'
  | 'confirmation_required'
  | 'setup_required'
  | 'chickpea_handoff'
  | 'failed'
  | 'skipped';

export interface ChickpeaManagementHandoff {
  kind: 'chickpea_handoff';
  chickpeaAgentId: 'agent_chickpea';
  actingAgentId: string;
  requestedAction: ManagementOperation['kind'] | 'prepare_connector_setup' |
    'discover_slack_channels' | 'test_mcp_connection' | 'inspect_routines' |
    'inspect_memory' | 'export_workspace_recipe' | 'preview_workspace_recipe' |
    'revoke_setup_link';
  target: {
    kind: 'agent' | 'workspace' | 'channel' | 'membership' | 'provider' | 'routine' | 'setup';
    id: string;
  };
  instruction: string;
}

export interface ManagementObjectRef {
  kind: 'agent' | 'channel' | 'channel_grant' | 'connection' | 'membership' | 'provider' | 'memory' | 'routine';
  id: string;
  revision?: number;
}

export interface ManagementItemOutcome {
  itemId: string;
  operationKind: ManagementOperation['kind'];
  disposition: ManagementDisposition;
  changed?: ManagementObjectRef[];
  proposalId?: string;
  setupOperationId?: string;
  setupUrl?: string;
  handoffUrl?: string;
  handoff?: ChickpeaManagementHandoff;
  undoAvailable?: boolean;
  code?: string;
  warning?: string;
}

export type ManagementSetupAction =
  | 'api_oauth'
  | 'api_credential'
  | 'mcp_oauth'
  | 'mcp_credentials'
  | 'managed_connection'
  | 'repository_access'
  | 'provider_credential';

export type ManagementSetupStatus =
  | 'pending'
  | 'claimed'
  | 'authorizing'
  | 'failed'
  | 'completed'
  | 'revoked'
  | 'expired';

/** Exact non-secret capability scope frozen when a setup link is issued. */
export interface ManagementSetupTarget {
  kind: ManagementSetupRequestTarget['kind'] | 'managed_connection';
  provider: string;
  targetId: string;
  targetLabel: string;
  expectedRevision: number;
  agentId?: string;
  agentName?: string;
  connectionId?: string;
  repositoryId?: string;
  replacement: boolean;
  formFields?: string[];
  ownerKind?: ConnectionAccountOwnerKind;
  accessLane?: 'read' | 'write';
  presetId?: string;
}

export interface ManagementSetupReceipt {
  setupOperationId: string;
  connector: string;
  target: string;
  scopes: string[];
  initiator: string;
  accountLabel?: string;
  completedAt: number;
}

/** Bounded user-facing acknowledgement for a completed managed connector handoff. */
export interface ManagementConnectorConnectedReceipt {
  kind: 'connector_connected';
  setupOperationId: string;
  connector: string;
  toolkit: string;
  agentId: string;
  agentName: string;
  ownerKind: ConnectionAccountOwnerKind;
  accessLane: 'read' | 'write';
  avatarUrl?: string;
  completedAt: number;
}

export type ManagementSetupCompletionReceipt =
  | ManagementSetupReceipt
  | ManagementConnectorConnectedReceipt;

/** Content-free acknowledgement for a successfully saved private DM schedule. */
export interface ManagementRoutineSavedAcknowledgement {
  kind: 'routine_saved_reaction';
  emojiName: 'white_check_mark';
}

/** Content-bounded acknowledgement derived only from durable schedule-action state. */
export type ManagementScheduleActionAcknowledgement =
  | {
      kind: 'schedule_action';
      transition: 'pending';
    }
  | {
      kind: 'schedule_action';
      transition: 'applied';
      /** Present only when the immediate private-DM acknowledgement is a reaction. */
      emojiName?: 'white_check_mark';
      /** Proven post-apply state saved with the durable action result. */
      safeState?: 'active' | 'paused' | 'disabled' | 'pending_authority';
    }
  | {
      kind: 'schedule_action';
      transition: 'failed';
      code?: string;
      /** Proven fail-safe state saved with the durable action result. */
      safeState?: 'paused' | 'disabled' | 'pending_authority';
    };

export type ManagementReceipt =
  | ManagementSetupReceipt
  | ManagementConnectorConnectedReceipt
  | ManagementRoutineSavedAcknowledgement
  | ManagementScheduleActionAcknowledgement
  | ManagementAgentCreatedWelcome
  | ManagementChickpeaIntroduction;

/** Durable, Agent-authored first message after one approved creation. */
export interface ManagementAgentCreatedWelcome {
  kind: 'agent_created_welcome';
  proposalId: string;
  /** Internal correlation for settling the Slack Run after this deferred post is acknowledged. */
  presentationRunId?: string;
  agentId: string;
  agentName: string;
  agentDescription?: string;
  requesterMembershipId: string;
  surface: 'channel' | 'direct';
  persona: {
    name: string;
    avatarUrl?: string;
  };
  setupUrl?: string;
  suggestedConnector?: string;
}

/** One-time Chickpea introduction for an eligible Slack workspace member. */
export interface ManagementChickpeaIntroduction {
  kind: 'chickpea_introduction';
  trigger: 'first_owner' | 'first_interaction';
}

/** Internal durable record. Digest members must never cross a public adapter. */
export interface ManagementSetupRecord {
  setupOperationId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  origin: ManagementOrigin;
  action: ManagementSetupAction;
  target: ManagementSetupTarget;
  scopes: string[];
  completedByUserId?: string;
  completedByMembershipId?: string;
  connectionAccountId?: string;
  tokenDigest?: string;
  browserSessionDigest?: string;
  status: ManagementSetupStatus;
  failureCode?: string;
  receipt?: ManagementSetupCompletionReceipt;
  supersedesSetupOperationId?: string;
  expiresAt: number;
  claimedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ManagementSetupPublicStatus {
  setupOperationId: string;
  action: ManagementSetupAction;
  target: ManagementSetupTarget;
  scopes: string[];
  status: ManagementSetupStatus;
  expiresAt: number;
  receipt?: ManagementSetupCompletionReceipt;
  delivery?: {
    status: ManagementReceiptOutboxStatus;
    attempts: number;
  };
}

export type ManagementReceiptDestination =
  | {
      kind: 'thread';
      workspaceId: string;
      channelId: string;
      threadTs: string;
    }
  | {
      kind: 'initiator_dm';
      organizationId: string;
      userId: string;
    }
  | {
      kind: 'slack_dm';
      workspaceId: string;
      slackUserId: string;
    }
  | {
      kind: 'reaction';
      workspaceId: string;
      channelId: string;
      messageTs: string;
    };

export type ManagementReceiptOutboxStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'failed';

export interface ManagementReceiptOutboxRecord {
  outboxId: string;
  operationId: string;
  destination: ManagementReceiptDestination;
  receipt: ManagementReceipt;
  status: ManagementReceiptOutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  deliveryRef?: string;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ManagementIntroductionClaim {
  organizationId: string;
  userId: string;
  workspaceId: string;
  slackUserId: string;
  trigger: 'first_owner' | 'first_interaction';
  outboxId: string;
  createdAt: number;
}

export interface ClaimManagementIntroductionInput {
  organizationId: string;
  userId: string;
  workspaceId: string;
  slackUserId: string;
  trigger: ManagementIntroductionClaim['trigger'];
  at: number;
}

export interface ClaimManagementIntroductionResult {
  claim: ManagementIntroductionClaim;
  created: boolean;
  outbox?: ManagementReceiptOutboxRecord;
}

export type ManagementOperationResult = ManagementApplyResult | ManagementSetupPublicStatus;

export interface ManagementApplyResult {
  operationId: string;
  idempotencyKey: string;
  status: 'completed' | 'partial' | 'confirmation_required';
  outcomes: ManagementItemOutcome[];
  /** Workspace mutation receipt token; it is not comparable to an actor-scoped inspection token. */
  effectiveRevision: string;
  activation: 'next_turn';
}

export interface ManagementWorkspaceSnapshot {
  organizationId: string;
  /** Present only when inspection is scoped by a trusted Slack Agent route. */
  currentAgentId?: string;
  /** Secret-free catalog of connector handoffs available to management agents. */
  connectors: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  agents: Array<{
    id: string;
    revision: number;
    name: string;
    description?: string;
    instructions: string;
    enabled: boolean;
    lifecycle?: AgentCreateInput['lifecycle'];
    creatorMembershipId?: string;
    editPolicy?: AgentCreateInput['editPolicy'];
    configurationGeneration?: number;
    slackPresence?: {
      requestedHandle: string;
      normalizedHandle: string;
      desiredState: NonNullable<AgentCreateInput['slackPresence']>['desiredState'];
      health: NonNullable<AgentCreateInput['slackPresence']>['health'];
      errorCode?: string;
      avatar: NonNullable<AgentCreateInput['slackPresence']>['avatar'];
    };
    model?: string;
    skills: AgentCreateInput['skills'];
    mcpServers: AgentCreateInput['mcpServers'];
    apiConnections: AgentCreateInput['apiConnections'];
    /** Secret-free reusable accounts available through this Agent's bindings and visible to the requester. */
    connections?: Array<{
      id: string;
      providerId: string;
      label: string;
      purpose?: string;
      ownerKind: ConnectionAccountOwnerKind;
      lifecycle: 'pending' | 'ready' | 'needs_attention';
      enabled: boolean;
      allowedCapabilities: string[];
    }>;
    repositories: AgentCreateInput['repositories'];
  }>;
  channels: Array<{
    workspaceId: string;
    channelId: string;
    revision: number;
    label?: string;
    lifecycle: ChannelConfig['lifecycle'];
    grants: Array<{
      agentId: string;
      status: AgentChannelGrantStatus;
      /** Revision of this Agent-to-Channel grant, distinct from the parent Channel revision. */
      revision: number;
    }>;
  }>;
  providers: Array<{
    id: 'anthropic' | 'openai' | 'openrouter';
    source: 'env' | 'stored' | 'missing';
    mutable: boolean;
    workspaceDefaultAffected: boolean;
    inheritingAgentCount: number;
    affectedAgents: Array<{ id: string; name: string }>;
  }>;
  /** Additional secret-free context exposed only to a trusted routed user Agent. */
  selfManagement?: {
    availableModels: Array<{ id: string; name?: string }>;
    routineSchedulingAvailable: boolean;
    capabilityHealth: {
      mcpConnections: { ready: number; pending: number; failed: number };
      apiConnections: { ready: number; pending: number; failed: number };
      reusableConnections: { ready: number; pending: number; needsAttention: number; disabled: number };
      repositories: { enabled: number; setupRequired: number };
      channelGrants: { active: number; pending: number; needsAttention: number };
    };
  };
  team?: {
    members: Array<{
      id: string;
      userId: string;
      displayName: string | null;
      slackTeamId: string | null;
      slackUserId: string | null;
      role: OrganizationRole;
      status: MembershipStatus;
      revision: number;
    }>;
  };
  /** Revision of this actor-visible snapshot, including its visible reusable connections. */
  effectiveRevision: string;
}

export interface PrepareConnectorSetupInput {
  agentId: string;
  connector: string;
  ownerKind: ConnectionAccountOwnerKind;
}

export interface PrepareConnectorSetupResult {
  agent: { id: string; name: string };
  connector: { id: string; name: string };
  ownerKind: ConnectionAccountOwnerKind;
  handoffUrl: string;
  setupOperationId?: string;
}

export interface ManagementMemorySnapshot {
  agentId: string;
  body: string;
  revision: number;
}

export interface ManagementRoutineInspectionInput {
  workspaceId: string;
  channelId?: string | undefined;
  routineId?: string | undefined;
}

export interface ManagementRoutineSnapshot {
  routines: Array<{
    id: string;
    workspaceId: string;
    channelId: string;
    creatorUserId: string;
    state: RoutineState | 'deleted';
    version: number;
    name: string | null;
    description: string | null;
    taskText: string | null;
    triggerKind: RoutineDefinition['triggerKind'];
    scheduleInput: string;
    scheduleJson: string;
    timezone: string;
    outputPolicy: RoutineOutputPolicy;
    nextRunAt: number | null;
    contentAccess: 'public' | 'private' | 'authorization_unknown';
    owningAgentId: string;
  }>;
}

export interface ApplyWorkspaceChangesInput {
  context: ManagementActorContext;
  idempotencyKey: string;
  operations: ManagementOperation[];
  /** The caller owns Slack acknowledgement delivery for this invocation. */
  acknowledgementOwner?: 'service' | 'caller';
}

export interface ProposeWorkspaceChangesInput {
  context: ManagementActorContext;
  idempotencyKey: string;
  guideVersion: string;
  authoringReason: AgentAuthoringReason;
  operations: ManagementOperation[];
}

export interface ProposeWorkspaceChangesResult {
  proposalId: string;
  status: 'pending';
  digest: string;
  guide: {
    version: string;
    uri: string;
    digest: string;
  };
  preview: ManagementChangeSetPreview;
  presentation: {
    /** Human-readable Slack copy; the opaque proposal id remains control data. */
    slack: string;
  };
  confirmationTool: 'confirm_workspace_change';
}

export interface ProposeSkillImportInput {
  context: ManagementActorContext;
  idempotencyKey: string;
  guideVersion: string;
  /** Optional only for a trusted Slack route, which supplies the acting Agent. */
  agentId?: string;
  source: string;
  /** Narrows a repository or parent-directory source after candidate discovery. */
  skillName?: string;
}

export type ProposeSkillImportResult =
  | (Omit<ProposeWorkspaceChangesResult, 'preview'> & {
      import: {
        sourceUrl: string;
        path: string;
        name: string;
        description: string;
        replacedExisting: boolean;
      };
    })
  | {
      status: 'selection_required';
      source: { owner: string; repo: string; ref: string };
      candidates: Array<{
        name: string;
        description: string;
        path: string;
        sourceUrl: string;
        hasScripts: boolean;
      }>;
      instruction: string;
    };

export interface ConfirmWorkspaceChangeInput {
  context: ManagementActorContext;
  proposalId: string;
}

export interface UndoWorkspaceChangeInput {
  context: ManagementActorContext;
  operationId: string;
  idempotencyKey: string;
}

export interface ManagementRequestRecord {
  operationId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  originKey: string;
  idempotencyKey: string;
  digest: string;
  operations: ManagementOperation[];
  status: 'reserved' | 'applying' | 'completed' | 'failed';
  progress: ManagementRequestProgress;
  result?: ManagementApplyResult;
  createdAt: number;
  updatedAt: number;
}

export interface ManagementPreparedItem {
  itemId: string;
  operation: ManagementOperation;
  before?: unknown;
  intendedAfter?: unknown;
  inverse?: ManagementOperation;
}

export interface ManagementRequestProgress {
  nextIndex: number;
  outcomes: ManagementItemOutcome[];
  prepared?: ManagementPreparedItem;
}

export interface ManagementProposalRecord {
  proposalId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  originKey: string;
  operation: ManagementOperation;
  summary: string;
  targetRevisions: Record<string, number>;
  requestOperationId?: string;
  status: 'pending' | 'applying' | 'completed' | 'stale';
  result?: ManagementApplyResult;
  createdAt: number;
  updatedAt: number;
}

export interface ManagementChangeSetPreview {
  summary: string;
  changes: Array<{
    itemId: string;
    operationKind: ManagementOperation['kind'];
    target: string;
    before?: unknown;
    after?: unknown;
  }>;
  missingSetup: Array<{
    itemId: string;
    kind: ManagementSetupRequestTarget['kind'];
    target: string;
  }>;
}

/** Durable exact multi-operation proposal. Kept separate from the legacy single-op row. */
export interface ManagementChangeSetProposalRecord {
  proposalId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  originKey: string;
  approvalScopeKey: string;
  idempotencyKey: string;
  guideVersion: string;
  authoringReason: AgentAuthoringReason;
  operations: ManagementOperation[];
  digest: string;
  preview: ManagementChangeSetPreview;
  targetRevisions: Record<string, number>;
  status: 'pending' | 'applying' | 'completed' | 'stale';
  result?: ManagementApplyResult;
  createdAt: number;
  updatedAt: number;
}

export interface ManagementUndoRecord {
  operationId: string;
  organizationId: string;
  actorUserId: string;
  inverse: ManagementOperation;
  resultingRevisions: Record<string, number>;
  status: 'available' | 'consumed';
  createdAt: number;
  updatedAt: number;
}

export class ManagementError extends Error {
  readonly name = 'ManagementError';

  constructor(
    readonly code:
      | 'forbidden'
      | 'invalid_request'
      | 'idempotency_conflict'
      | 'operation_not_found'
      | 'proposal_not_found'
      | 'proposal_binding_mismatch'
      | 'proposal_stale'
      | 'base_agent_capabilities_require_setup'
      | 'undo_unavailable'
      | 'operation_in_progress'
      | 'revision_conflict'
      | 'setup_not_found'
      | 'setup_unavailable'
      | 'setup_expired'
      | 'setup_session_mismatch'
      | 'routines_unavailable_on_target'
      | 'schedule_authority_missing',
    message: string,
    readonly changed?: ManagementObjectRef[],
  ) {
    super(message);
  }
}

/** A successful, non-mutating transfer instruction for a user Agent. */
export class ChickpeaHandoffRequired extends Error {
  readonly name = 'ChickpeaHandoffRequired';

  constructor(readonly handoff: ChickpeaManagementHandoff) {
    super('Address Chickpea to continue this workspace-management request.');
  }
}

export interface ReserveManagementRequestInput {
  operationId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  originKey: string;
  idempotencyKey: string;
  digest: string;
  operations: ManagementOperation[];
  at: number;
}

export interface PutManagementProposalInput {
  proposalId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  originKey: string;
  operation: ManagementOperation;
  summary: string;
  targetRevisions: Record<string, number>;
  requestOperationId?: string;
  at: number;
}

export interface PutManagementChangeSetProposalInput {
  proposalId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  originKey: string;
  /** Stable human approval scope; legacy callers fall back to originKey. */
  approvalScopeKey?: string;
  idempotencyKey: string;
  guideVersion: string;
  authoringReason: AgentAuthoringReason;
  operations: ManagementOperation[];
  digest: string;
  preview: ManagementChangeSetPreview;
  targetRevisions: Record<string, number>;
  at: number;
}

export interface PutManagementSetupInput {
  record: ManagementSetupRecord;
}

export interface ExchangeManagementSetupInput {
  setupOperationId: string;
  tokenDigest: string;
  browserSessionDigest: string;
  at: number;
}

export interface AuthorizeManagementSetupInput {
  setupOperationId: string;
  browserSessionDigest: string;
  at: number;
}

export interface CompleteManagementSetupInput {
  setupOperationId: string;
  browserSessionDigest: string;
  receipt: ManagementSetupCompletionReceipt;
  outbox: ManagementReceiptOutboxRecord;
  completedByUserId?: string;
  completedByMembershipId?: string;
  connectionAccountId?: string;
  at: number;
}

export interface RevokeManagementSetupInput {
  setupOperationId: string;
  organizationId: string;
  actorUserId: string;
  at: number;
}

export interface ClaimManagementProposalInput {
  proposalId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  originKey: string;
  /** Current change-set callers bind against this stable conversation scope. */
  approvalScopeKey?: string;
  at: number;
}

export interface GetActiveManagementChangeSetProposalInput {
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  approvalScopeKey: string;
}

export interface ReclaimManagementChangeSetProposalInput extends ClaimManagementProposalInput {
  expectedUpdatedAt: number;
}

export type ManagementRpcRequest =
  | { kind: 'reserve_request'; input: ReserveManagementRequestInput }
  | { kind: 'get_request'; operationId: string }
  | { kind: 'mark_request_applying'; operationId: string; at: number }
  | { kind: 'fail_request'; operationId: string; at: number }
  | {
      kind: 'save_request_progress';
      operationId: string;
      progress: ManagementRequestProgress;
      at: number;
    }
  | {
      kind: 'complete_request';
      operationId: string;
      result: ManagementApplyResult;
      at: number;
    }
  | { kind: 'put_proposal'; input: PutManagementProposalInput }
  | { kind: 'get_proposal'; proposalId: string }
  | { kind: 'claim_proposal'; input: ClaimManagementProposalInput }
  | {
      kind: 'complete_proposal';
      proposalId: string;
      result: ManagementApplyResult;
      at: number;
    }
  | { kind: 'mark_proposal_stale'; proposalId: string; at: number }
  | { kind: 'put_change_set_proposal'; input: PutManagementChangeSetProposalInput }
  | { kind: 'get_change_set_proposal'; proposalId: string }
  | { kind: 'get_active_change_set_proposal'; input: GetActiveManagementChangeSetProposalInput }
  | { kind: 'claim_change_set_proposal'; input: ClaimManagementProposalInput }
  | { kind: 'reclaim_change_set_proposal'; input: ReclaimManagementChangeSetProposalInput }
  | {
      kind: 'save_change_set_proposal_progress';
      proposalId: string;
      result: ManagementApplyResult;
      expectedUpdatedAt: number;
      at: number;
    }
  | {
      kind: 'complete_change_set_proposal';
      proposalId: string;
      result: ManagementApplyResult;
      expectedUpdatedAt?: number;
      at: number;
    }
  | { kind: 'mark_change_set_proposal_stale'; proposalId: string; at: number }
  | { kind: 'put_undo'; record: ManagementUndoRecord }
  | { kind: 'get_undo'; operationId: string }
  | { kind: 'consume_undo'; operationId: string; at: number }
  | { kind: 'put_setup'; input: PutManagementSetupInput }
  | { kind: 'get_setup'; setupOperationId: string; at?: number }
  | { kind: 'exchange_setup'; input: ExchangeManagementSetupInput }
  | { kind: 'authorize_setup'; input: AuthorizeManagementSetupInput }
  | {
      kind: 'fail_setup';
      setupOperationId: string;
      browserSessionDigest: string;
      failureCode: string;
      at: number;
    }
  | { kind: 'complete_setup'; input: CompleteManagementSetupInput }
  | { kind: 'revoke_setup'; input: RevokeManagementSetupInput }
  | { kind: 'put_outbox'; record: ManagementReceiptOutboxRecord }
  | { kind: 'claim_introduction'; input: ClaimManagementIntroductionInput }
  | { kind: 'get_outbox_for_operation'; operationId: string }
  | { kind: 'claim_due_outbox'; at: number; limit: number; leaseUntil: number }
  | {
      kind: 'settle_outbox';
      outboxId: string;
      outcome: 'delivered' | 'retry' | 'failed';
      at: number;
      nextAttemptAt?: number;
      deliveryRef?: string;
      failureCode?: string;
    }
  | { kind: 'cleanup_retention'; at: number; limit: number };

export type ManagementRpcResponse =
  | { kind: 'request_reservation'; request: ManagementRequestRecord; created: boolean }
  | { kind: 'request'; request: ManagementRequestRecord | null }
  | { kind: 'proposal'; proposal: ManagementProposalRecord | null }
  | { kind: 'change_set_proposal'; proposal: ManagementChangeSetProposalRecord | null }
  | { kind: 'undo'; undo: ManagementUndoRecord | null }
  | { kind: 'setup'; setup: ManagementSetupRecord | null }
  | { kind: 'outbox'; outbox: ManagementReceiptOutboxRecord | null }
  | { kind: 'outbox_batch'; outbox: ManagementReceiptOutboxRecord[] }
  | { kind: 'introduction_claim'; result: ClaimManagementIntroductionResult }
  | { kind: 'retention'; deleted: number };
