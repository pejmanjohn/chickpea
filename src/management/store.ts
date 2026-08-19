import { AuditStoreLogic } from '../audit/store.ts';
import { promisify } from '../state/async-facade.ts';
import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import {
  ManagementError,
  type ClaimManagementProposalInput,
  type ManagementApplyResult,
  type ManagementProposalRecord,
  type ManagementRequestProgress,
  type ManagementRequestRecord,
  type ManagementRpcRequest,
  type ManagementRpcResponse,
  type ManagementUndoRecord,
  type PutManagementProposalInput,
  type ReserveManagementRequestInput,
} from './types.ts';

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
  status: ManagementProposalRecord['status'];
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

export interface ManagementStore {
  execute(request: ManagementRpcRequest): Promise<ManagementRpcResponse>;
  reserveRequest(
    input: ReserveManagementRequestInput,
  ): Promise<{ request: ManagementRequestRecord; created: boolean }>;
  getRequest(operationId: string): Promise<ManagementRequestRecord | undefined>;
  markRequestApplying(operationId: string, at: number): Promise<ManagementRequestRecord>;
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
  putUndo(record: ManagementUndoRecord): Promise<ManagementUndoRecord>;
  getUndo(operationId: string): Promise<ManagementUndoRecord | undefined>;
  consumeUndo(operationId: string, at: number): Promise<ManagementUndoRecord>;
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
      case 'put_undo':
        return { kind: 'undo', undo: this.putUndo(request.record) };
      case 'get_undo':
        return { kind: 'undo', undo: this.getUndo(request.operationId) ?? null };
      case 'consume_undo':
        return { kind: 'undo', undo: this.consumeUndo(request.operationId, request.at) };
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
          operationId,
          outcomeCount: String(result.outcomes.length),
          status: result.status,
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
        status, result_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      input.proposalId,
      input.organizationId,
      input.actorUserId,
      input.actorMembershipId,
      input.originKey,
      JSON.stringify(input.operation),
      input.summary,
      JSON.stringify(input.targetRevisions),
      input.expiresAt,
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
    if (proposal.status === 'completed' || proposal.status === 'applying') return proposal;
    if (proposal.status !== 'pending') {
      throw new ManagementError('proposal_stale', 'The confirmation is no longer available.');
    }
    if (proposal.expiresAt <= input.at) {
      this.db.run(
        `UPDATE management_proposals SET status = 'expired', updated_at = ?
         WHERE proposal_id = ? AND status = 'pending'`,
        input.at,
        input.proposalId,
      );
      throw new ManagementError('proposal_expired', 'The confirmation has expired.');
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
          operationKind: proposal.operation.kind,
          proposalId,
          status: result.status,
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'completed', 'stale', 'expired')),
        result_json TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS management_proposals_state_idx
       ON management_proposals (organization_id, actor_user_id, status, expires_at)`,
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
      `CREATE TABLE IF NOT EXISTS management_setup_operations (
        setup_operation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_json TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        token_digest TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
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

  private requireUndo(operationId: string): ManagementUndoRecord {
    const undo = this.getUndo(operationId);
    if (!undo) throw new ManagementError('undo_unavailable', 'No undo action is available.');
    return undo;
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
    status: row.status,
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as ManagementApplyResult }
      : {}),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
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
