import { AuditStoreLogic } from '../audit/store.ts';
import { constantTimeEquals } from '../admin/constant-time.ts';
import { promisify } from '../state/async-facade.ts';
import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import {
  ManagementError,
  type ClaimManagementProposalInput,
  type ClaimManagementIntroductionInput,
  type ClaimManagementIntroductionResult,
  type ClaimAgentCreationWelcomeInput,
  type ClaimAgentCreationWelcomeResult,
  type AuthorizeManagementSetupInput,
  type CompleteManagementSetupInput,
  type ExchangeManagementSetupInput,
  type ManagementApplyResult,
  type ManagementChangeSetProposalRecord,
  type ManagementOperation,
  type ManagementProposalRecord,
  type ManagementReceiptOutboxRecord,
  type ManagementIntroductionClaim,
  type GetActiveManagementChangeSetProposalInput,
  type ManagementRequestProgress,
  type ManagementRequestRecord,
  type ManagementRpcRequest,
  type ManagementRpcResponse,
  type ManagementSetupRecord,
  type ManagementUndoRecord,
  type PutManagementSetupInput,
  type PutManagementProposalInput,
  type PutManagementChangeSetProposalInput,
  type ReclaimManagementChangeSetProposalInput,
  type RevokeManagementSetupInput,
  type ReserveManagementRequestInput,
} from './types.ts';

function actingAgentIdFromOriginKey(originKey: string): string | undefined {
  const marker = ':agent:';
  const offset = originKey.lastIndexOf(marker);
  return offset >= 0 ? originKey.slice(offset + marker.length) : undefined;
}

function managementAuditTarget(operation: ManagementOperation): string {
  if (operation.kind === 'create_agent') return `agent:${operation.agent.id}`;
  if (operation.kind === 'update_agent' || operation.kind === 'delete_agent' ||
      operation.kind === 'archive_agent' || operation.kind === 'restore_agent' ||
      operation.kind === 'update_agent_memory') return `agent:${operation.agentId}`;
  if (operation.kind === 'put_channel') {
    return `channel:${operation.channel.workspaceId}:${operation.channel.channelId}`;
  }
  if (operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel') {
    return `channel:${operation.workspaceId}:${operation.channelId}`;
  }
  if (operation.kind === 'update_member') return `membership:${operation.membershipId}`;
  if (operation.kind === 'remove_provider_credential') return `provider:${operation.providerId}`;
  if (operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
      operation.kind === 'run_routine' ||
      operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent') {
    return `routine:${operation.routineId ?? `${operation.workspaceId}:${'channelId' in operation ? operation.channelId : 'current_dm_thread'}`}`;
  }
  return operation.target.kind === 'provider_credential'
    ? `provider:${operation.target.providerId}`
    : `agent:${operation.target.agentId ?? operation.target.agentClientRef ?? 'unresolved'}`;
}

interface ManagementRequestRow {
  operation_id: string;
  organization_id: string;
  actor_user_id: string;
  actor_membership_id: string;
  origin_key: string;
  idempotency_key: string;
  digest: string;
  operations_json: string;
  status: ManagementRequestRecord['status'];
  progress_json: string;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ManagementProposalRow {
  proposal_id: string;
  organization_id: string;
  actor_user_id: string;
  actor_membership_id: string;
  origin_key: string;
  operation_json: string;
  summary: string;
  target_revisions_json: string;
  request_operation_id: string | null;
  status: ManagementProposalRecord['status'];
  result_json: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface ManagementChangeSetProposalRow {
  proposal_id: string;
  organization_id: string;
  actor_user_id: string;
  actor_membership_id: string;
  origin_key: string;
  approval_scope_key: string;
  idempotency_key: string | null;
  guide_version: string | null;
  authoring_reason: ManagementChangeSetProposalRecord['authoringReason'] | null;
  operations_json: string;
  digest: string;
  preview_json: string;
  target_revisions_json: string;
  status: ManagementChangeSetProposalRecord['status'];
  result_json: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface ManagementUndoRow {
  operation_id: string;
  organization_id: string;
  actor_user_id: string;
  inverse_json: string;
  resulting_revisions_json: string;
  status: ManagementUndoRecord['status'];
  created_at: number;
  updated_at: number;
}

interface ManagementSetupRow {
  setup_operation_id: string;
  organization_id: string;
  actor_user_id: string;
  actor_membership_id: string;
  origin_json: string;
  action: ManagementSetupRecord['action'];
  target_json: string;
  scopes_json: string;
  completed_by_user_id: string | null;
  completed_by_membership_id: string | null;
  connection_account_id: string | null;
  token_digest: string | null;
  browser_session_digest: string | null;
  status: ManagementSetupRecord['status'];
  failure_code: string | null;
  receipt_json: string | null;
  supersedes_setup_operation_id: string | null;
  expires_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ManagementOutboxRow {
  outbox_id: string;
  operation_id: string;
  destination_json: string;
  receipt_json: string;
  status: ManagementReceiptOutboxRecord['status'];
  attempts: number;
  next_attempt_at: number;
  delivery_ref: string | null;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
}

interface ManagementIntroductionClaimRow {
  organization_id: string;
  user_id: string;
  workspace_id: string;
  slack_user_id: string;
  trigger: ManagementIntroductionClaim['trigger'];
  outbox_id: string;
  created_at: number;
}

export interface ManagementStore {
  execute(request: ManagementRpcRequest): Promise<ManagementRpcResponse>;
  reserveRequest(
    input: ReserveManagementRequestInput,
  ): Promise<{ request: ManagementRequestRecord; created: boolean }>;
  getRequest(operationId: string): Promise<ManagementRequestRecord | undefined>;
  markRequestApplying(operationId: string, at: number): Promise<ManagementRequestRecord>;
  failRequest(operationId: string, at: number): Promise<ManagementRequestRecord>;
  saveRequestProgress(
    operationId: string,
    progress: ManagementRequestProgress,
    at: number,
  ): Promise<ManagementRequestRecord>;
  completeRequest(
    operationId: string,
    result: ManagementApplyResult,
    at: number,
  ): Promise<ManagementRequestRecord>;
  putProposal(input: PutManagementProposalInput): Promise<ManagementProposalRecord>;
  getProposal(proposalId: string): Promise<ManagementProposalRecord | undefined>;
  claimProposal(input: ClaimManagementProposalInput): Promise<ManagementProposalRecord>;
  completeProposal(
    proposalId: string,
    result: ManagementApplyResult,
    at: number,
  ): Promise<ManagementProposalRecord>;
  markProposalStale(proposalId: string, at: number): Promise<ManagementProposalRecord>;
  putChangeSetProposal(
    input: PutManagementChangeSetProposalInput,
  ): Promise<ManagementChangeSetProposalRecord>;
  getChangeSetProposal(proposalId: string): Promise<ManagementChangeSetProposalRecord | undefined>;
  getActiveChangeSetProposal(
    input: GetActiveManagementChangeSetProposalInput,
  ): Promise<ManagementChangeSetProposalRecord | undefined>;
  claimChangeSetProposal(
    input: ClaimManagementProposalInput,
  ): Promise<ManagementChangeSetProposalRecord>;
  reclaimChangeSetProposal(
    input: ReclaimManagementChangeSetProposalInput,
  ): Promise<ManagementChangeSetProposalRecord>;
  saveChangeSetProposalProgress(
    proposalId: string,
    result: ManagementApplyResult,
    expectedUpdatedAt: number,
    at: number,
  ): Promise<ManagementChangeSetProposalRecord>;
  completeChangeSetProposal(
    proposalId: string,
    result: ManagementApplyResult,
    at: number,
    expectedUpdatedAt?: number,
  ): Promise<ManagementChangeSetProposalRecord>;
  markChangeSetProposalStale(
    proposalId: string,
    at: number,
  ): Promise<ManagementChangeSetProposalRecord>;
  putUndo(record: ManagementUndoRecord): Promise<ManagementUndoRecord>;
  getUndo(operationId: string): Promise<ManagementUndoRecord | undefined>;
  consumeUndo(operationId: string, at: number): Promise<ManagementUndoRecord>;
  putSetup(input: PutManagementSetupInput): Promise<ManagementSetupRecord>;
  claimAgentCreationWelcome(
    input: ClaimAgentCreationWelcomeInput,
  ): Promise<ClaimAgentCreationWelcomeResult>;
  getSetup(setupOperationId: string, at?: number): Promise<ManagementSetupRecord | undefined>;
  exchangeSetup(input: ExchangeManagementSetupInput): Promise<ManagementSetupRecord>;
  authorizeSetup(input: AuthorizeManagementSetupInput): Promise<ManagementSetupRecord>;
  failSetup(
    setupOperationId: string,
    browserSessionDigest: string,
    failureCode: string,
    at: number,
  ): Promise<ManagementSetupRecord>;
  completeSetup(input: CompleteManagementSetupInput): Promise<ManagementSetupRecord>;
  revokeSetup(input: RevokeManagementSetupInput): Promise<ManagementSetupRecord>;
  putOutbox(record: ManagementReceiptOutboxRecord): Promise<ManagementReceiptOutboxRecord>;
  claimIntroduction(
    input: ClaimManagementIntroductionInput,
  ): Promise<ClaimManagementIntroductionResult>;
  getOutboxForOperation(operationId: string): Promise<ManagementReceiptOutboxRecord | undefined>;
  claimDueOutbox(
    at: number,
    limit: number,
    leaseUntil: number,
  ): Promise<ManagementReceiptOutboxRecord[]>;
  settleOutbox(input: {
    outboxId: string;
    outcome: 'delivered' | 'retry' | 'failed';
    at: number;
    nextAttemptAt?: number;
    deliveryRef?: string;
    failureCode?: string;
  }): Promise<ManagementReceiptOutboxRecord>;
  cleanupRetention(at: number, limit?: number): Promise<number>;
  close?(): void;
}

export class ManagementStoreLogic {
  private readonly audit: AuditStoreLogic;

  constructor(private readonly db: StateDb) {
    this.audit = new AuditStoreLogic(db);
    this.installSchema();
  }

  execute(request: ManagementRpcRequest): ManagementRpcResponse {
    switch (request.kind) {
      case 'reserve_request': {
        const reservation = this.reserveRequest(request.input);
        return { kind: 'request_reservation', ...reservation };
      }
      case 'get_request':
        return { kind: 'request', request: this.getRequest(request.operationId) ?? null };
      case 'mark_request_applying':
        return {
          kind: 'request',
          request: this.markRequestApplying(request.operationId, request.at),
        };
      case 'fail_request':
        return {
          kind: 'request',
          request: this.failRequest(request.operationId, request.at),
        };
      case 'save_request_progress':
        return {
          kind: 'request',
          request: this.saveRequestProgress(request.operationId, request.progress, request.at),
        };
      case 'complete_request':
        return {
          kind: 'request',
          request: this.completeRequest(request.operationId, request.result, request.at),
        };
      case 'put_proposal':
        return { kind: 'proposal', proposal: this.putProposal(request.input) };
      case 'get_proposal':
        return { kind: 'proposal', proposal: this.getProposal(request.proposalId) ?? null };
      case 'claim_proposal':
        return { kind: 'proposal', proposal: this.claimProposal(request.input) };
      case 'complete_proposal':
        return {
          kind: 'proposal',
          proposal: this.completeProposal(request.proposalId, request.result, request.at),
        };
      case 'mark_proposal_stale':
        return {
          kind: 'proposal',
          proposal: this.markProposalStale(request.proposalId, request.at),
        };
      case 'put_change_set_proposal':
        return {
          kind: 'change_set_proposal',
          proposal: this.putChangeSetProposal(request.input),
        };
      case 'get_change_set_proposal':
        return {
          kind: 'change_set_proposal',
          proposal: this.getChangeSetProposal(request.proposalId) ?? null,
        };
      case 'get_active_change_set_proposal':
        return {
          kind: 'change_set_proposal',
          proposal: this.getActiveChangeSetProposal(request.input) ?? null,
        };
      case 'claim_change_set_proposal':
        return {
          kind: 'change_set_proposal',
          proposal: this.claimChangeSetProposal(request.input),
        };
      case 'reclaim_change_set_proposal':
        return {
          kind: 'change_set_proposal',
          proposal: this.reclaimChangeSetProposal(request.input),
        };
      case 'save_change_set_proposal_progress':
        return {
          kind: 'change_set_proposal',
          proposal: this.saveChangeSetProposalProgress(
            request.proposalId,
            request.result,
            request.expectedUpdatedAt,
            request.at,
          ),
        };
      case 'complete_change_set_proposal':
        return {
          kind: 'change_set_proposal',
          proposal: this.completeChangeSetProposal(
            request.proposalId,
            request.result,
            request.at,
            request.expectedUpdatedAt,
          ),
        };
      case 'mark_change_set_proposal_stale':
        return {
          kind: 'change_set_proposal',
          proposal: this.markChangeSetProposalStale(request.proposalId, request.at),
        };
      case 'put_undo':
        return { kind: 'undo', undo: this.putUndo(request.record) };
      case 'get_undo':
        return { kind: 'undo', undo: this.getUndo(request.operationId) ?? null };
      case 'consume_undo':
        return { kind: 'undo', undo: this.consumeUndo(request.operationId, request.at) };
      case 'put_setup':
        return { kind: 'setup', setup: this.putSetup(request.input) };
      case 'claim_agent_creation_welcome':
        return {
          kind: 'agent_creation_welcome_claim',
          result: this.claimAgentCreationWelcome(request.input),
        };
      case 'get_setup':
        return {
          kind: 'setup',
          setup: this.getSetup(request.setupOperationId, request.at) ?? null,
        };
      case 'exchange_setup':
        return { kind: 'setup', setup: this.exchangeSetup(request.input) };
      case 'authorize_setup':
        return { kind: 'setup', setup: this.authorizeSetup(request.input) };
      case 'fail_setup':
        return {
          kind: 'setup',
          setup: this.failSetup(
            request.setupOperationId,
            request.browserSessionDigest,
            request.failureCode,
            request.at,
          ),
        };
      case 'complete_setup':
        return { kind: 'setup', setup: this.completeSetup(request.input) };
      case 'revoke_setup':
        return { kind: 'setup', setup: this.revokeSetup(request.input) };
      case 'put_outbox':
        return { kind: 'outbox', outbox: this.putOutbox(request.record) };
      case 'claim_introduction':
        return { kind: 'introduction_claim', result: this.claimIntroduction(request.input) };
      case 'get_outbox_for_operation':
        return {
          kind: 'outbox',
          outbox: this.getOutboxForOperation(request.operationId) ?? null,
        };
      case 'claim_due_outbox':
        return {
          kind: 'outbox_batch',
          outbox: this.claimDueOutbox(request.at, request.limit, request.leaseUntil),
        };
      case 'settle_outbox':
        return {
          kind: 'outbox',
          outbox: this.settleOutbox(request),
        };
      case 'cleanup_retention':
        return { kind: 'retention', deleted: this.cleanupRetention(request.at, request.limit) };
    }
  }

  reserveRequest(
    input: ReserveManagementRequestInput,
  ): { request: ManagementRequestRecord; created: boolean } {
    const existing = this.db.get(
      `SELECT * FROM management_requests
       WHERE organization_id = ? AND actor_user_id = ? AND idempotency_key = ?`,
      input.organizationId,
      input.actorUserId,
      input.idempotencyKey,
    ) as unknown as ManagementRequestRow | undefined;
    if (existing) {
      const request = requestFromRow(existing);
      if (request.digest !== input.digest) {
        throw new ManagementError(
          'idempotency_conflict',
          'The idempotency key belongs to a different management request.',
        );
      }
      return { request, created: false };
    }
    this.db.run(
      `INSERT INTO management_requests (
        operation_id, organization_id, actor_user_id, actor_membership_id,
        origin_key, idempotency_key, digest, operations_json, status,
        progress_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, ?, ?)`,
      input.operationId,
      input.organizationId,
      input.actorUserId,
      input.actorMembershipId,
      input.originKey,
      input.idempotencyKey,
      input.digest,
      JSON.stringify(input.operations),
      JSON.stringify(emptyProgress()),
      input.at,
      input.at,
    );
    return { request: this.requireRequest(input.operationId), created: true };
  }

  getRequest(operationId: string): ManagementRequestRecord | undefined {
    const row = this.db.get(
      'SELECT * FROM management_requests WHERE operation_id = ?',
      operationId,
    ) as unknown as ManagementRequestRow | undefined;
    return row ? requestFromRow(row) : undefined;
  }

  markRequestApplying(operationId: string, at: number): ManagementRequestRecord {
    const request = this.requireRequest(operationId);
    if (request.status === 'completed' || request.status === 'failed') return request;
    this.db.run(
      `UPDATE management_requests SET status = 'applying', updated_at = ?
       WHERE operation_id = ? AND status IN ('reserved', 'applying')`,
      at,
      operationId,
    );
    return this.requireRequest(operationId);
  }

  failRequest(operationId: string, at: number): ManagementRequestRecord {
    const request = this.requireRequest(operationId);
    if (request.status === 'completed' || request.status === 'failed') return request;
    this.db.run(
      `UPDATE management_requests SET status = 'failed', updated_at = ?
       WHERE operation_id = ? AND status IN ('reserved', 'applying')`,
      at,
      operationId,
    );
    return this.requireRequest(operationId);
  }

  saveRequestProgress(
    operationId: string,
    progress: ManagementRequestProgress,
    at: number,
  ): ManagementRequestRecord {
    const updated = this.db.run(
      `UPDATE management_requests SET progress_json = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'applying'`,
      JSON.stringify(progress),
      at,
      operationId,
    );
    if (updated.changes !== 1) throw this.missingOperation(operationId);
    return this.requireRequest(operationId);
  }

  completeRequest(
    operationId: string,
    result: ManagementApplyResult,
    at: number,
  ): ManagementRequestRecord {
    return this.db.transaction(() => {
      const request = this.requireRequest(operationId);
      if (request.status === 'completed') return request;
      const updated = this.db.run(
        `UPDATE management_requests
         SET status = 'completed', result_json = ?, progress_json = ?, updated_at = ?
         WHERE operation_id = ? AND status IN ('reserved', 'applying')`,
        JSON.stringify(result),
        JSON.stringify({
          nextIndex: request.operations.length,
          outcomes: result.outcomes,
        }),
        at,
        operationId,
      );
      if (updated.changes !== 1) throw this.missingOperation(operationId);
      this.audit.appendIdempotent({
        eventId: `management:${operationId}`,
        domain: 'management',
        eventType: 'management.request.completed',
        outcome: result.status === 'completed' ? 'success' : 'requested',
        actorClass: 'chickpea_user',
        actorId: request.actorUserId,
        workspaceId: request.organizationId,
        subjectId: operationId,
        createdAt: at,
        metadataJson: JSON.stringify({
          actingAgentId: actingAgentIdFromOriginKey(request.originKey) ?? 'human',
          authorization: 'live_membership_and_acting_agent',
          operationCount: String(request.operations.length),
          operationId,
          operationKind: request.operations[0]?.kind ?? 'unknown',
          outcomeCount: String(result.outcomes.length),
          status: result.status,
          target: request.operations[0] ? managementAuditTarget(request.operations[0]) : 'unknown',
          targetCount: String(request.operations.length),
        }),
        idempotencyKey: `management:${request.organizationId}:${request.actorUserId}:${request.idempotencyKey}`,
      });
      return this.requireRequest(operationId);
    });
  }

  putProposal(input: PutManagementProposalInput): ManagementProposalRecord {
    const existing = this.getProposal(input.proposalId);
    if (existing) return existing;
    this.db.run(
      `INSERT INTO management_proposals (
        proposal_id, organization_id, actor_user_id, actor_membership_id,
        origin_key, operation_json, summary, target_revisions_json,
        request_operation_id, status, result_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, ?)`,
      input.proposalId,
      input.organizationId,
      input.actorUserId,
      input.actorMembershipId,
      input.originKey,
      JSON.stringify(input.operation),
      input.summary,
      JSON.stringify(input.targetRevisions),
      input.requestOperationId ?? null,
      input.at,
      input.at,
    );
    return this.requireProposal(input.proposalId);
  }

  getProposal(proposalId: string): ManagementProposalRecord | undefined {
    const row = this.db.get(
      'SELECT * FROM management_proposals WHERE proposal_id = ?',
      proposalId,
    ) as unknown as ManagementProposalRow | undefined;
    return row ? proposalFromRow(row) : undefined;
  }

  claimProposal(input: ClaimManagementProposalInput): ManagementProposalRecord {
    const proposal = this.requireProposal(input.proposalId);
    if (proposal.organizationId !== input.organizationId ||
        proposal.actorUserId !== input.actorUserId ||
        proposal.actorMembershipId !== input.actorMembershipId ||
        proposal.originKey !== input.originKey) {
      throw new ManagementError(
        'proposal_binding_mismatch',
        'The confirmation does not match its initiating user and origin.',
      );
    }
    if (proposal.status === 'completed') return proposal;
    if (proposal.status === 'applying') {
      throw new ManagementError('operation_in_progress', 'The confirmation is already applying.');
    }
    if (proposal.status !== 'pending') {
      throw new ManagementError('proposal_stale', 'The confirmation is no longer available.');
    }
    this.db.run(
      `UPDATE management_proposals SET status = 'applying', updated_at = ?
       WHERE proposal_id = ? AND status = 'pending'`,
      input.at,
      input.proposalId,
    );
    return this.requireProposal(input.proposalId);
  }

  completeProposal(
    proposalId: string,
    result: ManagementApplyResult,
    at: number,
  ): ManagementProposalRecord {
    return this.db.transaction(() => {
      const proposal = this.requireProposal(proposalId);
      if (proposal.status === 'completed') return proposal;
      const updated = this.db.run(
        `UPDATE management_proposals SET status = 'completed', result_json = ?, updated_at = ?
         WHERE proposal_id = ? AND status = 'applying'`,
        JSON.stringify(result),
        at,
        proposalId,
      );
      if (updated.changes !== 1) {
        throw new ManagementError('proposal_stale', 'The confirmation is no longer applicable.');
      }
      this.audit.appendIdempotent({
        eventId: `management-confirmation:${proposalId}`,
        domain: 'management',
        eventType: 'management.proposal.completed',
        outcome: 'success',
        actorClass: 'chickpea_user',
        actorId: proposal.actorUserId,
        workspaceId: proposal.organizationId,
        subjectId: proposalId,
        createdAt: at,
        metadataJson: JSON.stringify({
          actingAgentId: actingAgentIdFromOriginKey(proposal.originKey) ?? 'human',
          authorization: 'live_membership_and_acting_agent',
          operationKind: proposal.operation.kind,
          proposalId,
          status: result.status,
          target: managementAuditTarget(proposal.operation),
        }),
        idempotencyKey: `management-confirmation:${proposalId}`,
      });
      return this.requireProposal(proposalId);
    });
  }

  markProposalStale(proposalId: string, at: number): ManagementProposalRecord {
    this.requireProposal(proposalId);
    this.db.run(
      `UPDATE management_proposals SET status = 'stale', updated_at = ?
       WHERE proposal_id = ? AND status IN ('pending', 'applying')`,
      at,
      proposalId,
    );
    return this.requireProposal(proposalId);
  }

  putChangeSetProposal(
    input: PutManagementChangeSetProposalInput,
  ): ManagementChangeSetProposalRecord {
    const approvalScopeKey = input.approvalScopeKey ?? input.originKey;
    const existing = this.getChangeSetProposal(input.proposalId);
    if (existing) return existing;
    const replayRow = this.db.get(
      `SELECT * FROM management_change_set_proposals
       WHERE organization_id = ? AND actor_user_id = ? AND actor_membership_id = ?
         AND origin_key = ? AND idempotency_key = ?`,
      input.organizationId,
      input.actorUserId,
      input.actorMembershipId,
      input.originKey,
      input.idempotencyKey,
    ) as unknown as ManagementChangeSetProposalRow | undefined;
    if (replayRow) {
      const replay = changeSetProposalFromRow(replayRow);
      if (replay.digest !== input.digest || replay.guideVersion !== input.guideVersion ||
          replay.authoringReason !== input.authoringReason) {
        throw new ManagementError(
          'idempotency_conflict',
          'The proposal idempotency key was reused for different content.',
        );
      }
      if (replay.status === 'applying') {
        throw new ManagementError(
          'operation_in_progress',
          'The prior proposal confirmation is still applying.',
        );
      }
      if (replay.status !== 'pending') {
        throw new ManagementError(
          'proposal_stale',
          'The prior proposal is no longer pending. Use a new idempotency key after reviewing fresh state.',
        );
      }
      return replay;
    }
    this.db.run(
      `UPDATE management_change_set_proposals SET status = 'stale', updated_at = ?
       WHERE organization_id = ? AND actor_user_id = ? AND actor_membership_id = ?
         AND approval_scope_key = ? AND status = 'pending'`,
      input.at,
      input.organizationId,
      input.actorUserId,
      input.actorMembershipId,
      approvalScopeKey,
    );
    this.db.run(
      `INSERT INTO management_change_set_proposals (
        proposal_id, organization_id, actor_user_id, actor_membership_id,
        origin_key, approval_scope_key, idempotency_key, guide_version, authoring_reason,
        operations_json, digest, preview_json, target_revisions_json,
        status, result_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, ?)`,
      input.proposalId,
      input.organizationId,
      input.actorUserId,
      input.actorMembershipId,
      input.originKey,
      approvalScopeKey,
      input.idempotencyKey,
      input.guideVersion,
      input.authoringReason,
      JSON.stringify(input.operations),
      input.digest,
      JSON.stringify(input.preview),
      JSON.stringify(input.targetRevisions),
      input.at,
      input.at,
    );
    return this.requireChangeSetProposal(input.proposalId);
  }

  getChangeSetProposal(proposalId: string): ManagementChangeSetProposalRecord | undefined {
    const row = this.db.get(
      'SELECT * FROM management_change_set_proposals WHERE proposal_id = ?',
      proposalId,
    ) as unknown as ManagementChangeSetProposalRow | undefined;
    return row ? changeSetProposalFromRow(row) : undefined;
  }

  getActiveChangeSetProposal(
    input: GetActiveManagementChangeSetProposalInput,
  ): ManagementChangeSetProposalRecord | undefined {
    const row = this.db.get(
      `SELECT * FROM management_change_set_proposals
       WHERE organization_id = ? AND actor_user_id = ? AND actor_membership_id = ?
         AND approval_scope_key = ? AND status IN ('pending', 'applying')
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      input.organizationId,
      input.actorUserId,
      input.actorMembershipId,
      input.approvalScopeKey,
    ) as unknown as ManagementChangeSetProposalRow | undefined;
    return row ? changeSetProposalFromRow(row) : undefined;
  }

  claimChangeSetProposal(input: ClaimManagementProposalInput): ManagementChangeSetProposalRecord {
    const proposal = this.requireChangeSetProposal(input.proposalId);
    assertProposalClaimBinding(proposal, input);
    if (proposal.status === 'completed') return proposal;
    if (proposal.status === 'applying') {
      throw new ManagementError('operation_in_progress', 'The confirmation is already applying.');
    }
    if (proposal.status !== 'pending') {
      throw new ManagementError('proposal_stale', 'The confirmation is no longer available.');
    }
    this.db.run(
      `UPDATE management_change_set_proposals SET status = 'applying', updated_at = ?
       WHERE proposal_id = ? AND status = 'pending'`,
      input.at,
      input.proposalId,
    );
    return this.requireChangeSetProposal(input.proposalId);
  }

  reclaimChangeSetProposal(
    input: ReclaimManagementChangeSetProposalInput,
  ): ManagementChangeSetProposalRecord {
    const proposal = this.requireChangeSetProposal(input.proposalId);
    assertProposalClaimBinding(proposal, input);
    if (proposal.status === 'completed') return proposal;
    if (proposal.status !== 'applying' || proposal.updatedAt !== input.expectedUpdatedAt) {
      throw new ManagementError('operation_in_progress', 'The confirmation recovery lease changed.');
    }
    const renewedAt = Math.max(input.at, proposal.updatedAt + 1);
    const updated = this.db.run(
      `UPDATE management_change_set_proposals SET updated_at = ?
       WHERE proposal_id = ? AND status = 'applying' AND updated_at = ?`,
      renewedAt,
      input.proposalId,
      input.expectedUpdatedAt,
    );
    if (updated.changes !== 1) {
      throw new ManagementError('operation_in_progress', 'The confirmation recovery lease changed.');
    }
    return this.requireChangeSetProposal(input.proposalId);
  }

  saveChangeSetProposalProgress(
    proposalId: string,
    result: ManagementApplyResult,
    expectedUpdatedAt: number,
    at: number,
  ): ManagementChangeSetProposalRecord {
    const renewedAt = Math.max(at, expectedUpdatedAt + 1);
    const updated = this.db.run(
      `UPDATE management_change_set_proposals
       SET result_json = ?, updated_at = ?
       WHERE proposal_id = ? AND status = 'applying' AND updated_at = ?`,
      JSON.stringify(result),
      renewedAt,
      proposalId,
      expectedUpdatedAt,
    );
    if (updated.changes !== 1) {
      throw new ManagementError('operation_in_progress', 'The confirmation recovery lease changed.');
    }
    return this.requireChangeSetProposal(proposalId);
  }

  completeChangeSetProposal(
    proposalId: string,
    result: ManagementApplyResult,
    at: number,
    expectedUpdatedAt?: number,
  ): ManagementChangeSetProposalRecord {
    return this.db.transaction(() => {
      const proposal = this.requireChangeSetProposal(proposalId);
      if (proposal.status === 'completed') return proposal;
      const updated = this.db.run(
        `UPDATE management_change_set_proposals
         SET status = 'completed', result_json = ?, updated_at = ?
         WHERE proposal_id = ? AND status = 'applying'
           ${expectedUpdatedAt === undefined ? '' : 'AND updated_at = ?'}`,
        JSON.stringify(result),
        Math.max(at, proposal.updatedAt + 1),
        proposalId,
        ...(expectedUpdatedAt === undefined ? [] : [expectedUpdatedAt]),
      );
      if (updated.changes !== 1) {
        throw new ManagementError('operation_in_progress', 'The confirmation recovery lease changed.');
      }
      this.audit.appendIdempotent({
        eventId: `management-change-set:${proposalId}`,
        domain: 'management',
        eventType: 'management.change_set.completed',
        outcome: 'success',
        actorClass: 'chickpea_user',
        actorId: proposal.actorUserId,
        workspaceId: proposal.organizationId,
        subjectId: proposalId,
        createdAt: at,
        metadataJson: JSON.stringify({
          actingAgentId: actingAgentIdFromOriginKey(proposal.originKey) ?? 'human',
          authorization: 'live_membership_and_acting_agent',
          operationCount: String(proposal.operations.length),
          operationKinds: [...new Set(proposal.operations.map(({ kind }) => kind))].sort().join('/'),
          guideVersion: proposal.guideVersion,
          authoringReason: proposal.authoringReason,
          proposalId,
          status: result.status,
          targetCount: String(proposal.preview.changes.length),
        }),
        idempotencyKey: `management-change-set:${proposalId}`,
      });
      return this.requireChangeSetProposal(proposalId);
    });
  }

  markChangeSetProposalStale(
    proposalId: string,
    at: number,
  ): ManagementChangeSetProposalRecord {
    this.requireChangeSetProposal(proposalId);
    this.db.run(
      `UPDATE management_change_set_proposals SET status = 'stale', updated_at = ?
       WHERE proposal_id = ? AND status IN ('pending', 'applying')`,
      at,
      proposalId,
    );
    return this.requireChangeSetProposal(proposalId);
  }

  putUndo(record: ManagementUndoRecord): ManagementUndoRecord {
    const existing = this.getUndo(record.operationId);
    if (existing) return existing;
    this.db.run(
      `INSERT INTO management_undo (
        operation_id, organization_id, actor_user_id, inverse_json,
        resulting_revisions_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.operationId,
      record.organizationId,
      record.actorUserId,
      JSON.stringify(record.inverse),
      JSON.stringify(record.resultingRevisions),
      record.status,
      record.createdAt,
      record.updatedAt,
    );
    return this.requireUndo(record.operationId);
  }

  getUndo(operationId: string): ManagementUndoRecord | undefined {
    const row = this.db.get(
      'SELECT * FROM management_undo WHERE operation_id = ?',
      operationId,
    ) as unknown as ManagementUndoRow | undefined;
    return row ? undoFromRow(row) : undefined;
  }

  consumeUndo(operationId: string, at: number): ManagementUndoRecord {
    const undo = this.requireUndo(operationId);
    if (undo.status !== 'available') {
      throw new ManagementError('undo_unavailable', 'The undo action is no longer available.');
    }
    this.db.run(
      `UPDATE management_undo SET status = 'consumed', updated_at = ?
       WHERE operation_id = ? AND status = 'available'`,
      at,
      operationId,
    );
    return this.requireUndo(operationId);
  }

  putSetup(input: PutManagementSetupInput): ManagementSetupRecord {
    const { record } = input;
    const existing = this.getSetup(record.setupOperationId);
    if (existing) return existing;
    this.db.run(
      `INSERT INTO management_setup_operations (
        setup_operation_id, organization_id, actor_user_id, actor_membership_id,
        origin_json, action, target_json, scopes_json,
        completed_by_user_id, completed_by_membership_id,
        connection_account_id, token_digest, browser_session_digest, status, failure_code, receipt_json,
        supersedes_setup_operation_id, expires_at, claimed_at, completed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.setupOperationId,
      record.organizationId,
      record.actorUserId,
      record.actorMembershipId,
      JSON.stringify(record.origin),
      record.action,
      JSON.stringify(record.target),
      JSON.stringify(record.scopes),
      record.completedByUserId ?? null,
      record.completedByMembershipId ?? null,
      record.connectionAccountId ?? null,
      record.tokenDigest ?? null,
      record.browserSessionDigest ?? null,
      record.status,
      record.failureCode ?? null,
      record.receipt ? JSON.stringify(record.receipt) : null,
      record.supersedesSetupOperationId ?? null,
      record.expiresAt,
      record.claimedAt ?? null,
      record.completedAt ?? null,
      record.createdAt,
      record.updatedAt,
    );
    return this.requireSetup(record.setupOperationId);
  }

  claimAgentCreationWelcome(
    input: ClaimAgentCreationWelcomeInput,
  ): ClaimAgentCreationWelcomeResult {
    return this.db.transaction(() => {
      const existing = this.getOutboxForOperation(input.operationId);
      if (existing) return { outbox: existing, created: false };
      if (input.outbox.operationId !== input.operationId ||
          !('kind' in input.outbox.receipt) ||
          input.outbox.receipt.kind !== 'agent_created_welcome') {
        throw new ManagementError('invalid_request', 'Agent welcome claim is invalid.');
      }
      for (const setup of input.setups) this.putSetup(setup);
      return { outbox: this.putOutbox(input.outbox), created: true };
    });
  }

  getSetup(setupOperationId: string, at?: number): ManagementSetupRecord | undefined {
    let row = this.db.get(
      'SELECT * FROM management_setup_operations WHERE setup_operation_id = ?',
      setupOperationId,
    ) as unknown as ManagementSetupRow | undefined;
    if (!row) return undefined;
    if (at !== undefined && row.expires_at <= at &&
        ['pending', 'claimed', 'authorizing', 'failed'].includes(row.status)) {
      this.db.run(
        `UPDATE management_setup_operations
         SET status = 'expired', token_digest = NULL, browser_session_digest = NULL,
             updated_at = ?
         WHERE setup_operation_id = ?
           AND status IN ('pending', 'claimed', 'authorizing', 'failed')`,
        at,
        setupOperationId,
      );
      row = this.db.get(
        'SELECT * FROM management_setup_operations WHERE setup_operation_id = ?',
        setupOperationId,
      ) as unknown as ManagementSetupRow;
    }
    return setupFromRow(row);
  }

  exchangeSetup(input: ExchangeManagementSetupInput): ManagementSetupRecord {
    return this.db.transaction(() => {
      const setup = this.requireSetup(input.setupOperationId, input.at);
      if (setup.status === 'expired') throw setupError('setup_expired');
      if (setup.status !== 'pending' || !setup.tokenDigest ||
          !constantDigestEquals(setup.tokenDigest, input.tokenDigest)) {
        throw setupError('setup_unavailable');
      }
      const updated = this.db.run(
        `UPDATE management_setup_operations
         SET status = 'claimed', token_digest = NULL, browser_session_digest = ?,
             claimed_at = ?, updated_at = ?
         WHERE setup_operation_id = ? AND status = 'pending' AND token_digest = ?`,
        input.browserSessionDigest,
        input.at,
        input.at,
        input.setupOperationId,
        setup.tokenDigest,
      );
      if (updated.changes !== 1) throw setupError('setup_unavailable');
      return this.requireSetup(input.setupOperationId);
    });
  }

  authorizeSetup(input: AuthorizeManagementSetupInput): ManagementSetupRecord {
    return this.db.transaction(() => {
      const setup = this.requireBrowserSetup(
        input.setupOperationId,
        input.browserSessionDigest,
        input.at,
      );
      if (!['claimed', 'failed', 'authorizing'].includes(setup.status)) {
        throw setupError('setup_unavailable');
      }
      if (setup.status !== 'authorizing') {
        this.db.run(
          `UPDATE management_setup_operations
           SET status = 'authorizing', failure_code = NULL, updated_at = ?
           WHERE setup_operation_id = ? AND status IN ('claimed', 'failed')`,
          input.at,
          input.setupOperationId,
        );
      }
      return this.requireSetup(input.setupOperationId);
    });
  }

  failSetup(
    setupOperationId: string,
    browserSessionDigest: string,
    failureCode: string,
    at: number,
  ): ManagementSetupRecord {
    return this.db.transaction(() => {
      const setup = this.requireBrowserSetup(setupOperationId, browserSessionDigest, at);
      if (setup.status === 'completed') return setup;
      if (setup.status !== 'authorizing') throw setupError('setup_unavailable');
      this.db.run(
        `UPDATE management_setup_operations
         SET status = 'failed', failure_code = ?, updated_at = ?
         WHERE setup_operation_id = ? AND status = 'authorizing'`,
        boundedFailureCode(failureCode),
        at,
        setupOperationId,
      );
      return this.requireSetup(setupOperationId);
    });
  }

  completeSetup(input: CompleteManagementSetupInput): ManagementSetupRecord {
    return this.db.transaction(() => {
      const existing = this.requireSetup(input.setupOperationId, input.at);
      const managed = existing.action === 'managed_connection';
      if (existing.status === 'completed') {
        if (managed) throw setupError('setup_unavailable');
        return existing;
      }

      let setup: ManagementSetupRecord;
      let completionActorUserId: string;
      let completionActorMembershipId: string;
      let authorization: string;
      let updated: { changes: number };
      if (managed) {
        if (existing.status !== 'pending' || !existing.tokenDigest ||
            !constantDigestEquals(existing.tokenDigest, input.browserSessionDigest) ||
            !input.completedByUserId || !input.completedByMembershipId) {
          throw setupError('setup_unavailable');
        }
        setup = existing;
        completionActorUserId = input.completedByUserId;
        completionActorMembershipId = input.completedByMembershipId;
        authorization = 'reusable_managed_setup_link';
        updated = this.db.run(
          `UPDATE management_setup_operations
           SET status = 'completed', receipt_json = ?, failure_code = NULL,
               token_digest = NULL, browser_session_digest = NULL,
               completed_by_user_id = ?, completed_by_membership_id = ?,
               connection_account_id = ?, completed_at = ?, updated_at = ?
           WHERE setup_operation_id = ? AND status = 'pending' AND token_digest = ?`,
          JSON.stringify(input.receipt),
          completionActorUserId,
          completionActorMembershipId,
          input.connectionAccountId ?? null,
          input.at,
          input.at,
          input.setupOperationId,
          existing.tokenDigest,
        );
      } else {
        setup = this.requireBrowserSetup(
          input.setupOperationId,
          input.browserSessionDigest,
          input.at,
        );
        if (setup.status !== 'authorizing') throw setupError('setup_unavailable');
        completionActorUserId = setup.actorUserId;
        completionActorMembershipId = setup.actorMembershipId;
        authorization = 'initiating_membership_browser_session';
        updated = this.db.run(
          `UPDATE management_setup_operations
           SET status = 'completed', receipt_json = ?, failure_code = NULL,
               token_digest = NULL, browser_session_digest = NULL,
               connection_account_id = ?, completed_at = ?, updated_at = ?
           WHERE setup_operation_id = ? AND status = 'authorizing'`,
          JSON.stringify(input.receipt),
          input.connectionAccountId ?? null,
          input.at,
          input.at,
          input.setupOperationId,
        );
      }
      if (updated.changes !== 1) throw setupError('setup_unavailable');
      this.putOutbox(input.outbox);
      this.audit.appendIdempotent({
        eventId: `management-setup:${input.setupOperationId}`,
        domain: 'management',
        eventType: 'management.setup.completed',
        outcome: 'success',
        actorClass: 'chickpea_user',
        actorId: completionActorUserId,
        workspaceId: setup.organizationId,
        subjectId: input.setupOperationId,
        createdAt: input.at,
        metadataJson: JSON.stringify({
          action: setup.action,
          actingAgentId: setup.origin.kind === 'slack'
            ? setup.origin.agentId ?? 'legacy_slack_agent'
            : 'human',
          authorization,
          actorMembershipId: completionActorMembershipId,
          issuerUserId: setup.actorUserId,
          setupOperationId: input.setupOperationId,
          scopeCount: String(setup.scopes.length),
          target: `${setup.target.kind}:${setup.target.targetId}`,
        }),
        idempotencyKey: `management-setup:${input.setupOperationId}`,
      });
      return this.requireSetup(input.setupOperationId);
    });
  }

  putOutbox(record: ManagementReceiptOutboxRecord): ManagementReceiptOutboxRecord {
    this.db.run(
      `INSERT OR IGNORE INTO management_receipt_outbox (
        outbox_id, operation_id, destination_json, receipt_json, status,
        attempts, next_attempt_at, delivery_ref, failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.outboxId,
      record.operationId,
      JSON.stringify(record.destination),
      JSON.stringify(record.receipt),
      record.status,
      record.attempts,
      record.nextAttemptAt,
      record.deliveryRef ?? null,
      record.failureCode ?? null,
      record.createdAt,
      record.updatedAt,
    );
    return this.requireOutbox(record.outboxId);
  }

  claimIntroduction(input: ClaimManagementIntroductionInput): ClaimManagementIntroductionResult {
    return this.db.transaction(() => {
      const outboxId = `chickpea_intro_${input.organizationId}_${input.userId}`;
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO management_introduction_claims (
           organization_id, user_id, workspace_id, slack_user_id, trigger, outbox_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.organizationId,
        input.userId,
        input.workspaceId,
        input.slackUserId,
        input.trigger,
        outboxId,
        input.at,
      ).changes === 1;
      const row = this.db.get(
        `SELECT * FROM management_introduction_claims
         WHERE organization_id = ? AND user_id = ?`,
        input.organizationId,
        input.userId,
      ) as unknown as ManagementIntroductionClaimRow;
      const claim = introductionClaimFromRow(row);
      if (!inserted) return { claim, created: false };
      const outbox = this.putOutbox({
        outboxId,
        operationId: outboxId,
        destination: {
          kind: 'slack_dm',
          workspaceId: input.workspaceId,
          slackUserId: input.slackUserId,
        },
        receipt: { kind: 'chickpea_introduction', trigger: input.trigger },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      });
      return { claim, created: true, outbox };
    });
  }

  revokeSetup(input: RevokeManagementSetupInput): ManagementSetupRecord {
    return this.db.transaction(() => {
      const setup = this.requireSetup(input.setupOperationId, input.at);
      if (setup.organizationId !== input.organizationId || setup.actorUserId !== input.actorUserId) {
        throw setupError('setup_not_found');
      }
      // Once authorization begins, external credential work may already be in
      // flight. Refuse revocation instead of recording a revoked setup whose
      // side effect can still complete after this transaction.
      if (!['pending', 'claimed', 'failed'].includes(setup.status)) {
        throw setupError(setup.status === 'expired' ? 'setup_expired' : 'setup_unavailable');
      }
      this.db.run(
        `UPDATE management_setup_operations
         SET status = 'revoked', token_digest = NULL, browser_session_digest = NULL,
             updated_at = ?
         WHERE setup_operation_id = ?
           AND status IN ('pending', 'claimed', 'failed')`,
        input.at,
        input.setupOperationId,
      );
      return this.requireSetup(input.setupOperationId);
    });
  }

  getOutboxForOperation(operationId: string): ManagementReceiptOutboxRecord | undefined {
    const row = this.db.get(
      `SELECT * FROM management_receipt_outbox
       WHERE operation_id = ? ORDER BY created_at DESC LIMIT 1`,
      operationId,
    ) as unknown as ManagementOutboxRow | undefined;
    return row ? outboxFromRow(row) : undefined;
  }

  claimDueOutbox(at: number, limit: number, leaseUntil: number): ManagementReceiptOutboxRecord[] {
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    return this.db.transaction(() => {
      const rows = this.db.all(
        `SELECT * FROM management_receipt_outbox
         WHERE status IN ('pending', 'delivering') AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?`,
        at,
        boundedLimit,
      ) as unknown as ManagementOutboxRow[];
      const claimed: ManagementReceiptOutboxRecord[] = [];
      for (const row of rows) {
        const updated = this.db.run(
          `UPDATE management_receipt_outbox
           SET status = 'delivering', attempts = attempts + 1,
               next_attempt_at = ?, updated_at = ?
           WHERE outbox_id = ? AND status IN ('pending', 'delivering') AND next_attempt_at <= ?`,
          leaseUntil,
          at,
          row.outbox_id,
          at,
        );
        if (updated.changes === 1) claimed.push(this.requireOutbox(row.outbox_id));
      }
      return claimed;
    });
  }

  settleOutbox(input: {
    outboxId: string;
    outcome: 'delivered' | 'retry' | 'failed';
    at: number;
    nextAttemptAt?: number;
    deliveryRef?: string;
    failureCode?: string;
  }): ManagementReceiptOutboxRecord {
    const current = this.requireOutbox(input.outboxId);
    if (current.status === 'delivered' || current.status === 'failed') return current;
    if (current.status !== 'delivering') throw setupError('setup_unavailable');
    const status = input.outcome === 'retry' ? 'pending' : input.outcome;
    const nextAttemptAt = input.outcome === 'retry'
      ? input.nextAttemptAt ?? input.at
      : current.nextAttemptAt;
    this.db.run(
      `UPDATE management_receipt_outbox
       SET status = ?, next_attempt_at = ?, delivery_ref = ?, failure_code = ?, updated_at = ?
       WHERE outbox_id = ? AND status = 'delivering'`,
      status,
      nextAttemptAt,
      input.deliveryRef ?? null,
      input.failureCode ? boundedFailureCode(input.failureCode) : null,
      input.at,
      input.outboxId,
    );
    return this.requireOutbox(input.outboxId);
  }

  nextOutboxDueAt(): number | undefined {
    const row = this.db.get(
      `SELECT MIN(next_attempt_at) AS due_at FROM management_receipt_outbox
       WHERE status IN ('pending', 'delivering')`,
    ) as unknown as { due_at: number | null } | undefined;
    return row?.due_at === null || row?.due_at === undefined ? undefined : Number(row.due_at);
  }

  cleanupRetention(at: number, limit = 250): number {
    const cutoff = at - 30 * 24 * 60 * 60_000;
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return this.db.transaction(() => {
      let deleted = 0;
      const remove = (sql: string, ...params: number[]) => {
        deleted += this.db.run(sql, ...params).changes;
      };
      remove(
        `DELETE FROM management_receipt_outbox WHERE outbox_id IN (
           SELECT outbox_id FROM management_receipt_outbox
           WHERE status IN ('delivered', 'failed') AND updated_at < ?
           ORDER BY updated_at LIMIT ?
         )`,
        cutoff,
        boundedLimit,
      );
      remove(
        `DELETE FROM management_change_set_proposals WHERE proposal_id IN (
           SELECT proposal_id FROM management_change_set_proposals
           WHERE status IN ('completed', 'stale') AND updated_at < ?
           ORDER BY updated_at LIMIT ?
         )`,
        cutoff,
        boundedLimit,
      );
      remove(
        `DELETE FROM management_proposals WHERE proposal_id IN (
           SELECT proposal_id FROM management_proposals
           WHERE status IN ('completed', 'stale') AND updated_at < ?
           ORDER BY updated_at LIMIT ?
         )`,
        cutoff,
        boundedLimit,
      );
      remove(
        `DELETE FROM management_undo WHERE operation_id IN (
           SELECT operation_id FROM management_undo
           WHERE status = 'consumed' AND updated_at < ?
           ORDER BY updated_at LIMIT ?
         )`,
        cutoff,
        boundedLimit,
      );
      remove(
        `DELETE FROM management_setup_operations WHERE setup_operation_id IN (
           SELECT setup_operation_id FROM management_setup_operations
           WHERE status IN ('completed', 'revoked', 'expired', 'failed') AND updated_at < ?
           ORDER BY updated_at LIMIT ?
         )`,
        cutoff,
        boundedLimit,
      );
      remove(
        `DELETE FROM management_requests WHERE operation_id IN (
           SELECT operation_id FROM management_requests
           WHERE status IN ('completed', 'failed') AND updated_at < ?
           ORDER BY updated_at LIMIT ?
         )`,
        cutoff,
        boundedLimit,
      );
      return deleted;
    });
  }

  private installSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS management_requests (
        operation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_membership_id TEXT NOT NULL,
        origin_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        digest TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved', 'applying', 'completed', 'failed')),
        progress_json TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (organization_id, actor_user_id, idempotency_key)
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_requests_status_idx
       ON management_requests (status, updated_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS management_proposals (
        proposal_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_membership_id TEXT NOT NULL,
        origin_key TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        target_revisions_json TEXT NOT NULL,
        request_operation_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'completed', 'stale')),
        result_json TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.ensureProposalColumns();
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_proposals_state_idx
       ON management_proposals (organization_id, actor_user_id, status, expires_at)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_proposals_retention_idx
       ON management_proposals (status, updated_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS management_change_set_proposals (
        proposal_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_membership_id TEXT NOT NULL,
        origin_key TEXT NOT NULL,
        approval_scope_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        guide_version TEXT NOT NULL,
        authoring_reason TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        target_revisions_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'completed', 'stale')),
        result_json TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.ensureChangeSetProposalColumns();
    this.reactivateExpiredProposals();
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_change_set_proposals_state_idx
       ON management_change_set_proposals (organization_id, actor_user_id, status, expires_at)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_change_set_proposals_approval_idx
       ON management_change_set_proposals (
         organization_id, actor_user_id, actor_membership_id, approval_scope_key, status, created_at
       )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_change_set_proposals_retention_idx
       ON management_change_set_proposals (status, updated_at)`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS management_change_set_proposals_idempotency_idx
       ON management_change_set_proposals (
         organization_id, actor_user_id, actor_membership_id, origin_key, idempotency_key
       ) WHERE idempotency_key IS NOT NULL`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS management_undo (
        operation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        inverse_json TEXT NOT NULL,
        resulting_revisions_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('available', 'consumed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_undo_retention_idx
       ON management_undo (status, updated_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS management_setup_operations (
        setup_operation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_membership_id TEXT NOT NULL,
        origin_json TEXT NOT NULL,
        action TEXT NOT NULL,
        target_json TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        completed_by_user_id TEXT,
        completed_by_membership_id TEXT,
        connection_account_id TEXT,
        token_digest TEXT,
        browser_session_digest TEXT,
        status TEXT NOT NULL,
        failure_code TEXT,
        receipt_json TEXT,
        supersedes_setup_operation_id TEXT,
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.ensureSetupColumns();
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_setup_state_idx
       ON management_setup_operations (status, expires_at)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_setup_retention_idx
       ON management_setup_operations (status, updated_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS management_receipt_outbox (
        outbox_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        delivery_ref TEXT,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.ensureOutboxColumns();
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_receipt_outbox_due_idx
       ON management_receipt_outbox (status, next_attempt_at)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_receipt_outbox_retention_idx
       ON management_receipt_outbox (status, updated_at)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_receipt_outbox_operation_idx
       ON management_receipt_outbox (operation_id, created_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS management_introduction_claims (
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        slack_user_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        outbox_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      )`,
    );
  }

  private ensureSetupColumns(): void {
    const columns = new Set((this.db.all('PRAGMA table_info(management_setup_operations)') as Array<{ name: string }>).map(
      ({ name }) => name,
    ));
    const additions: Array<[string, string]> = [
      ['actor_membership_id', "TEXT NOT NULL DEFAULT ''"],
      ['origin_json', "TEXT NOT NULL DEFAULT '{\"kind\":\"mcp\",\"clientId\":\"legacy\"}'"],
      ['browser_session_digest', 'TEXT'],
      ['completed_by_user_id', 'TEXT'],
      ['completed_by_membership_id', 'TEXT'],
      ['connection_account_id', 'TEXT'],
      ['failure_code', 'TEXT'],
      ['receipt_json', 'TEXT'],
      ['supersedes_setup_operation_id', 'TEXT'],
      ['claimed_at', 'INTEGER'],
      ['completed_at', 'INTEGER'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE management_setup_operations ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private ensureProposalColumns(): void {
    const columns = new Set((this.db.all('PRAGMA table_info(management_proposals)') as Array<{ name: string }>).map(
      ({ name }) => name,
    ));
    if (!columns.has('request_operation_id')) {
      this.db.exec('ALTER TABLE management_proposals ADD COLUMN request_operation_id TEXT');
    }
  }

  private ensureChangeSetProposalColumns(): void {
    const columns = new Set((this.db.all(
      'PRAGMA table_info(management_change_set_proposals)',
    ) as Array<{ name: string }>).map(({ name }) => name));
    const additions: Array<[string, string]> = [
      ['idempotency_key', 'TEXT'],
      ['guide_version', 'TEXT'],
      ['authoring_reason', 'TEXT'],
      ['approval_scope_key', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(
          `ALTER TABLE management_change_set_proposals ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    const legacyRows = this.db.all(
      `SELECT proposal_id, origin_key FROM management_change_set_proposals
       WHERE approval_scope_key = ''`,
    ) as Array<{ proposal_id: string; origin_key: string }>;
    for (const row of legacyRows) {
      this.db.run(
        'UPDATE management_change_set_proposals SET approval_scope_key = ? WHERE proposal_id = ?',
        approvalScopeKeyFromOriginKey(row.origin_key),
        row.proposal_id,
      );
    }
  }

  private ensureOutboxColumns(): void {
    const columns = new Set((this.db.all('PRAGMA table_info(management_receipt_outbox)') as Array<{ name: string }>).map(
      ({ name }) => name,
    ));
    if (!columns.has('delivery_ref')) {
      this.db.exec('ALTER TABLE management_receipt_outbox ADD COLUMN delivery_ref TEXT');
    }
    if (!columns.has('failure_code')) {
      this.db.exec('ALTER TABLE management_receipt_outbox ADD COLUMN failure_code TEXT');
    }
  }

  private reactivateExpiredProposals(): void {
    // Keep the legacy storage column and status readable for in-place upgrades,
    // but proposal lifetime is now governed only by binding, revision, policy,
    // and single-use state checks.
    this.db.run("UPDATE management_proposals SET status = 'pending' WHERE status = 'expired'");
    this.db.run(
      "UPDATE management_change_set_proposals SET status = 'pending' WHERE status = 'expired'",
    );
  }

  private requireRequest(operationId: string): ManagementRequestRecord {
    const request = this.getRequest(operationId);
    if (!request) throw this.missingOperation(operationId);
    return request;
  }

  private requireProposal(proposalId: string): ManagementProposalRecord {
    const proposal = this.getProposal(proposalId);
    if (!proposal) {
      throw new ManagementError('proposal_not_found', 'The confirmation was not found.');
    }
    return proposal;
  }

  private requireChangeSetProposal(proposalId: string): ManagementChangeSetProposalRecord {
    const proposal = this.getChangeSetProposal(proposalId);
    if (!proposal) {
      throw new ManagementError('proposal_not_found', 'The confirmation was not found.');
    }
    return proposal;
  }

  private requireUndo(operationId: string): ManagementUndoRecord {
    const undo = this.getUndo(operationId);
    if (!undo) throw new ManagementError('undo_unavailable', 'No undo action is available.');
    return undo;
  }

  private requireSetup(setupOperationId: string, at?: number): ManagementSetupRecord {
    const setup = this.getSetup(setupOperationId, at);
    if (!setup) throw setupError('setup_not_found');
    return setup;
  }

  private requireBrowserSetup(
    setupOperationId: string,
    browserSessionDigest: string,
    at: number,
  ): ManagementSetupRecord {
    const setup = this.requireSetup(setupOperationId, at);
    if (setup.status === 'expired') throw setupError('setup_expired');
    if (!setup.browserSessionDigest ||
        !constantDigestEquals(setup.browserSessionDigest, browserSessionDigest)) {
      throw setupError('setup_session_mismatch');
    }
    return setup;
  }

  private requireOutbox(outboxId: string): ManagementReceiptOutboxRecord {
    const row = this.db.get(
      'SELECT * FROM management_receipt_outbox WHERE outbox_id = ?',
      outboxId,
    ) as unknown as ManagementOutboxRow | undefined;
    if (!row) throw this.missingOperation(outboxId);
    return outboxFromRow(row);
  }

  private missingOperation(_operationId: string): ManagementError {
    return new ManagementError('operation_not_found', 'The management operation was not found.');
  }
}

export interface SqliteManagementStore extends ManagementStore {
  close(): void;
}

export class SqliteManagementStore {
  constructor(path: string = resolveStateDbPath()) {
    const db = openStateDb(path);
    const _conforms: ManagementStore = promisify(new ManagementStoreLogic(db), {
      close: () => db.close(),
    });
    return _conforms as unknown as SqliteManagementStore;
  }
}

function emptyProgress(): ManagementRequestProgress {
  return { nextIndex: 0, outcomes: [] };
}

function requestFromRow(row: ManagementRequestRow): ManagementRequestRecord {
  return {
    operationId: row.operation_id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    actorMembershipId: row.actor_membership_id,
    originKey: row.origin_key,
    idempotencyKey: row.idempotency_key,
    digest: row.digest,
    operations: JSON.parse(row.operations_json) as ManagementRequestRecord['operations'],
    status: row.status,
    progress: JSON.parse(row.progress_json) as ManagementRequestProgress,
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as ManagementApplyResult }
      : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function proposalFromRow(row: ManagementProposalRow): ManagementProposalRecord {
  return {
    proposalId: row.proposal_id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    actorMembershipId: row.actor_membership_id,
    originKey: row.origin_key,
    operation: JSON.parse(row.operation_json) as ManagementProposalRecord['operation'],
    summary: row.summary,
    targetRevisions: JSON.parse(row.target_revisions_json) as Record<string, number>,
    ...(row.request_operation_id ? { requestOperationId: row.request_operation_id } : {}),
    status: row.status,
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as ManagementApplyResult }
      : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function changeSetProposalFromRow(
  row: ManagementChangeSetProposalRow,
): ManagementChangeSetProposalRecord {
  return {
    proposalId: row.proposal_id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    actorMembershipId: row.actor_membership_id,
    originKey: row.origin_key,
    approvalScopeKey: row.approval_scope_key || approvalScopeKeyFromOriginKey(row.origin_key),
    idempotencyKey: row.idempotency_key ?? `legacy:${row.proposal_id}`,
    guideVersion: row.guide_version ?? 'unknown',
    authoringReason: row.authoring_reason ?? 'agent_edit',
    operations: JSON.parse(row.operations_json) as ManagementChangeSetProposalRecord['operations'],
    digest: row.digest,
    preview: JSON.parse(row.preview_json) as ManagementChangeSetProposalRecord['preview'],
    targetRevisions: JSON.parse(row.target_revisions_json) as Record<string, number>,
    status: row.status,
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as ManagementApplyResult }
      : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function assertProposalClaimBinding(
  proposal: Pick<
    ManagementChangeSetProposalRecord,
    'organizationId' | 'actorUserId' | 'actorMembershipId' | 'approvalScopeKey'
  >,
  input: ClaimManagementProposalInput,
): void {
  if (proposal.organizationId !== input.organizationId ||
      proposal.actorUserId !== input.actorUserId ||
      proposal.actorMembershipId !== input.actorMembershipId ||
      proposal.approvalScopeKey !== (input.approvalScopeKey ?? input.originKey)) {
    throw new ManagementError(
      'proposal_binding_mismatch',
      'The confirmation does not match its initiating user and origin.',
    );
  }
}

function approvalScopeKeyFromOriginKey(originKey: string): string {
  const agentOffset = originKey.lastIndexOf(':agent:');
  const origin = agentOffset >= 0 ? originKey.slice(0, agentOffset) : originKey;
  const agent = agentOffset >= 0 ? originKey.slice(agentOffset) : '';
  if (!origin.startsWith('slack:')) return originKey;
  const parts = origin.split(':');
  const conversationKind = parts.at(-1);
  if ((conversationKind === 'im' || conversationKind === 'mpim') && parts.length >= 5) {
    const scope = conversationKind === 'im' ? 'dm' : 'mpim';
    return `slack:${parts[1]}:${parts[2]}:${scope}${agent}`;
  }
  return `${origin}${agent}`;
}

function undoFromRow(row: ManagementUndoRow): ManagementUndoRecord {
  return {
    operationId: row.operation_id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    inverse: JSON.parse(row.inverse_json) as ManagementUndoRecord['inverse'],
    resultingRevisions: JSON.parse(row.resulting_revisions_json) as Record<string, number>,
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function setupFromRow(row: ManagementSetupRow): ManagementSetupRecord {
  return {
    setupOperationId: row.setup_operation_id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    actorMembershipId: row.actor_membership_id,
    origin: JSON.parse(row.origin_json) as ManagementSetupRecord['origin'],
    action: row.action,
    target: JSON.parse(row.target_json) as ManagementSetupRecord['target'],
    scopes: JSON.parse(row.scopes_json) as string[],
    ...(row.completed_by_user_id ? { completedByUserId: row.completed_by_user_id } : {}),
    ...(row.completed_by_membership_id
      ? { completedByMembershipId: row.completed_by_membership_id }
      : {}),
    ...(row.connection_account_id ? { connectionAccountId: row.connection_account_id } : {}),
    ...(row.token_digest ? { tokenDigest: row.token_digest } : {}),
    ...(row.browser_session_digest ? { browserSessionDigest: row.browser_session_digest } : {}),
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.receipt_json
      ? { receipt: JSON.parse(row.receipt_json) as NonNullable<ManagementSetupRecord['receipt']> }
      : {}),
    ...(row.supersedes_setup_operation_id
      ? { supersedesSetupOperationId: row.supersedes_setup_operation_id }
      : {}),
    expiresAt: Number(row.expires_at),
    ...(row.claimed_at === null ? {} : { claimedAt: Number(row.claimed_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function outboxFromRow(row: ManagementOutboxRow): ManagementReceiptOutboxRecord {
  return {
    outboxId: row.outbox_id,
    operationId: row.operation_id,
    destination: JSON.parse(row.destination_json) as ManagementReceiptOutboxRecord['destination'],
    receipt: JSON.parse(row.receipt_json) as ManagementReceiptOutboxRecord['receipt'],
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    ...(row.delivery_ref ? { deliveryRef: row.delivery_ref } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function introductionClaimFromRow(row: ManagementIntroductionClaimRow): ManagementIntroductionClaim {
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    slackUserId: row.slack_user_id,
    trigger: row.trigger,
    outboxId: row.outbox_id,
    createdAt: Number(row.created_at),
  };
}

function constantDigestEquals(left: string, right: string): boolean {
  return constantTimeEquals(left, right);
}

function boundedFailureCode(value: string): string {
  return /^[a-z0-9_:-]{1,80}$/.test(value) ? value : 'validation_failed';
}

function setupError(
  code: 'setup_not_found' | 'setup_unavailable' | 'setup_expired' | 'setup_session_mismatch',
): ManagementError {
  const message = code === 'setup_expired'
    ? 'This setup link has expired.'
    : code === 'setup_session_mismatch'
      ? 'This browser cannot continue the setup.'
      : code === 'setup_not_found'
        ? 'The setup operation was not found.'
        : 'This setup link is no longer available.';
  return new ManagementError(code, message);
}
