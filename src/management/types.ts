import type { ConfigAgentPatch } from '../config/store.ts';
import type {
  AgentCreateInput,
  ChannelConfig,
} from '../config/types.ts';
import type {
  MembershipStatus,
  OrganizationRole,
} from '../identity/types.ts';

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
      kind: 'place_agent';
      workspaceId: string;
      channelId: string;
      expectedRevision: number;
      expectedAgentId: string | null;
      agentId?: string | null;
      agentClientRef?: string;
    })
  | (ManagementOperationBase & {
      kind: 'update_member';
      membershipId: string;
      role?: OrganizationRole;
      status?: MembershipStatus;
    });

export type ManagementDisposition =
  | 'applied'
  | 'confirmation_required'
  | 'setup_required'
  | 'failed'
  | 'skipped';

export interface ManagementObjectRef {
  kind: 'agent' | 'channel' | 'membership';
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
  undoAvailable?: boolean;
  code?: string;
  warning?: string;
}

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
    enabled: boolean;
    model?: string;
  }>;
  channels: Array<{
    workspaceId: string;
    channelId: string;
    revision: number;
    label?: string;
    lifecycle: ChannelConfig['lifecycle'];
    agentId?: string;
  }>;
  effectiveRevision: string;
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
      | 'revision_conflict',
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
  expiresAt: number;
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
  | { kind: 'consume_undo'; operationId: string; at: number };

export type ManagementRpcResponse =
  | { kind: 'request_reservation'; request: ManagementRequestRecord; created: boolean }
  | { kind: 'request'; request: ManagementRequestRecord | null }
  | { kind: 'proposal'; proposal: ManagementProposalRecord | null }
  | { kind: 'undo'; undo: ManagementUndoRecord | null };
