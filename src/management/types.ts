import type { ConfigAgentPatch } from '../config/store.ts';
import type {
  AgentChannelGrantStatus,
  AgentCreateInput,
  ChannelConfig,
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

export type ManagementOrigin =
  | {
      kind: 'slack';
      workspaceId: string;
      channelId: string;
      threadTs: string;
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
  origin: ManagementOrigin;
}

export interface LiveManagementActor extends ManagementActorContext {
  role: OrganizationRole;
}

interface ManagementOperationBase {
  itemId: string;
  dependsOn?: string[];
}

export type ManagementOperation =
  | (ManagementOperationBase & {
      kind: 'create_agent';
      clientRef?: string;
      agent: AgentCreateInput;
    })
  | (ManagementOperationBase & {
      kind: 'update_agent';
      agentId: string;
      expectedRevision: number;
      /** Forces confirmation when a portable recipe replaces the Agent definition. */
      confirmationReason?: 'recipe_overwrite';
      patch: ConfigAgentPatch;
    })
  | (ManagementOperationBase & {
      kind: 'delete_agent';
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
      channelId: string;
      routineId?: string;
      expectedVersion?: number;
      name: string;
      description: string;
      taskText: string;
      schedule:
        | { kind: 'cron'; expression: string }
        | { kind: 'once'; localDateTime: string };
      timezone: string;
      outputPolicy: RoutineOutputPolicy;
    })
  | (ManagementOperationBase & {
      kind: 'control_routine';
      workspaceId: string;
      channelId: string;
      routineId: string;
      expectedVersion: number;
      action: 'pause' | 'resume' | 'disable';
    })
  | (ManagementOperationBase & {
      kind: 'delete_routine';
      workspaceId: string;
      channelId: string;
      routineId: string;
      expectedVersion: number;
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
  | 'failed'
  | 'skipped';

export interface ManagementObjectRef {
  kind: 'agent' | 'channel' | 'channel_grant' | 'membership' | 'provider' | 'memory' | 'routine';
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
  undoAvailable?: boolean;
  code?: string;
  warning?: string;
}

export type ManagementSetupAction =
  | 'api_oauth'
  | 'api_credential'
  | 'mcp_oauth'
  | 'mcp_credentials'
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
  kind: ManagementSetupRequestTarget['kind'];
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
  tokenDigest?: string;
  browserSessionDigest?: string;
  status: ManagementSetupStatus;
  failureCode?: string;
  receipt?: ManagementSetupReceipt;
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
  receipt?: ManagementSetupReceipt;
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
  receipt: ManagementSetupReceipt;
  status: ManagementReceiptOutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  deliveryRef?: string;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
}

export type ManagementOperationResult = ManagementApplyResult | ManagementSetupPublicStatus;

export interface ManagementApplyResult {
  operationId: string;
  idempotencyKey: string;
  status: 'completed' | 'partial' | 'confirmation_required';
  outcomes: ManagementItemOutcome[];
  effectiveRevision: string;
  activation: 'next_turn';
}

export interface ManagementWorkspaceSnapshot {
  organizationId: string;
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
    repositories: AgentCreateInput['repositories'];
  }>;
  channels: Array<{
    workspaceId: string;
    channelId: string;
    revision: number;
    label?: string;
    lifecycle: ChannelConfig['lifecycle'];
    grants: Array<{ agentId: string; status: AgentChannelGrantStatus }>;
  }>;
  providers: Array<{
    id: 'anthropic' | 'openai' | 'openrouter';
    source: 'env' | 'stored' | 'missing';
    mutable: boolean;
    affectedAgents: Array<{ id: string; name: string }>;
  }>;
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
  effectiveRevision: string;
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
  }>;
}

export interface ApplyWorkspaceChangesInput {
  context: ManagementActorContext;
  idempotencyKey: string;
  operations: ManagementOperation[];
}

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
  status: 'pending' | 'applying' | 'completed' | 'stale' | 'expired';
  result?: ManagementApplyResult;
  expiresAt: number;
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
      | 'proposal_expired'
      | 'proposal_stale'
      | 'undo_unavailable'
      | 'operation_in_progress'
      | 'revision_conflict'
      | 'setup_not_found'
      | 'setup_unavailable'
      | 'setup_expired'
      | 'setup_session_mismatch',
    message: string,
  ) {
    super(message);
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
  expiresAt: number;
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
  receipt: ManagementSetupReceipt;
  outbox: ManagementReceiptOutboxRecord;
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
  at: number;
}

export type ManagementRpcRequest =
  | { kind: 'reserve_request'; input: ReserveManagementRequestInput }
  | { kind: 'get_request'; operationId: string }
  | { kind: 'mark_request_applying'; operationId: string; at: number }
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
  | { kind: 'undo'; undo: ManagementUndoRecord | null }
  | { kind: 'setup'; setup: ManagementSetupRecord | null }
  | { kind: 'outbox'; outbox: ManagementReceiptOutboxRecord | null }
  | { kind: 'outbox_batch'; outbox: ManagementReceiptOutboxRecord[] }
  | { kind: 'retention'; deleted: number };
