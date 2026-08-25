import type { StateDb } from '../../state/state-db.ts';
import type { GatewayInboundDelivery } from './protocol.ts';

export const GATEWAY_INBOX_MAX_TOTAL_ROWS = 4_096;
export const GATEWAY_INBOX_MAX_ACTIVE_ROWS = 512;
export const GATEWAY_INBOX_MAX_ACTIVE_BYTES = 32 * 1_048_576;
export const GATEWAY_INBOX_MAX_PAYLOAD_BYTES = 1_048_576;
export const GATEWAY_INBOX_MAX_ACTIVE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
// Slack's Events API retry sequence completes within minutes. Keep the
// body-free identity for a full day so a delayed retry still deduplicates.
export const GATEWAY_INBOX_DEDUP_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const GATEWAY_INBOX_MAX_ATTEMPTS = 5;
export const GATEWAY_INBOX_MAX_IN_FLIGHT = 16;
export const GATEWAY_INBOX_LEASE_MS = 2 * 60_000;
export const GATEWAY_INBOX_MAX_DRAIN_BATCH = 16;

export type GatewayInboxAdmissionOutcome = 'accepted' | 'duplicate';
export type GatewayInboxStatus =
  | 'pending'
  | 'in_flight'
  | 'completed'
  | 'recovery_required';

export interface GatewayInboxLimits {
  maxTotalRows: number;
  maxActiveRows: number;
  maxActiveBytes: number;
  maxPayloadBytes: number;
  maxActiveAgeMs: number;
  dedupRetentionMs: number;
  maxAttempts: number;
  maxInFlight: number;
  leaseMs: number;
}

export interface PendingGatewayDelivery {
  id: string;
  delivery: GatewayInboundDelivery;
  attempts: number;
}

export interface GatewayInboxDrainCounts {
  pendingGatewayInboxDeliveries: number;
  inFlightGatewayInboxDeliveries: number;
  recoveryRequiredGatewayInboxDeliveries: number;
}

interface GatewayInboxRow {
  id: string;
  binding_id: string;
  workspace_id: string;
  kind: GatewayInboundDelivery['kind'];
  payload_json: string | null;
  attempts: number;
}

export class GatewayInboxCapacityError extends Error {
  override readonly name = 'GatewayInboxCapacityError';
}

export class GatewayInboxConflictError extends Error {
  override readonly name = 'GatewayInboxConflictError';
}

/**
 * Deployment-owned durable admission for shared-gateway deliveries.
 *
 * This is deliberately separate from TurnJob: gateway admission happens
 * before routing, and valid lifecycle or App Home events may never create a
 * TurnJob. Both stores live in the same singleton state DO and share its alarm,
 * so this adds no second queue service or gateway-side payload retention.
 */
export class GatewayInboxStoreLogic {
  private readonly limits: GatewayInboxLimits;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
    limits: Partial<GatewayInboxLimits> = {},
  ) {
    const maxActiveRows = limits.maxActiveRows ?? GATEWAY_INBOX_MAX_ACTIVE_ROWS;
    this.limits = {
      maxTotalRows: GATEWAY_INBOX_MAX_TOTAL_ROWS,
      maxActiveRows,
      maxActiveBytes: GATEWAY_INBOX_MAX_ACTIVE_BYTES,
      maxPayloadBytes: GATEWAY_INBOX_MAX_PAYLOAD_BYTES,
      maxActiveAgeMs: GATEWAY_INBOX_MAX_ACTIVE_AGE_MS,
      dedupRetentionMs: GATEWAY_INBOX_DEDUP_RETENTION_MS,
      maxAttempts: GATEWAY_INBOX_MAX_ATTEMPTS,
      maxInFlight: Math.min(GATEWAY_INBOX_MAX_IN_FLIGHT, maxActiveRows),
      leaseMs: GATEWAY_INBOX_LEASE_MS,
      ...limits,
    };
    validateLimits(this.limits);
    db.exec(
      `CREATE TABLE IF NOT EXISTS gateway_inbox (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT,
        payload_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        accepted_at INTEGER NOT NULL,
        lease_until INTEGER,
        terminal_at INTEGER,
        recovery_reason TEXT
      )`,
    );
    db.exec('CREATE INDEX IF NOT EXISTS gateway_inbox_status_idx ON gateway_inbox(status, accepted_at)');
  }

  admit(delivery: GatewayInboundDelivery): GatewayInboxAdmissionOutcome {
    const payload = JSON.stringify(delivery);
    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    if (payloadBytes > this.limits.maxPayloadBytes) {
      throw new GatewayInboxCapacityError('Gateway inbox delivery exceeds the per-row byte limit.');
    }
    this.maintain();
    return this.db.transaction(() => {
      const existing = this.db.get(
        'SELECT binding_id, workspace_id, kind FROM gateway_inbox WHERE id = ?',
        delivery.deliveryId,
      );
      if (existing) {
        if (
          existing.binding_id !== delivery.bindingId ||
          existing.workspace_id !== delivery.workspaceId ||
          existing.kind !== delivery.kind
        ) {
          throw new GatewayInboxConflictError('Gateway delivery identity conflicts with its durable row.');
        }
        return 'duplicate';
      }
      const totals = this.db.get(
        `SELECT
           COUNT(*) AS total_rows,
           SUM(CASE WHEN status IN ('pending', 'in_flight') THEN 1 ELSE 0 END) AS active_rows,
           COALESCE(SUM(CASE WHEN status IN ('pending', 'in_flight') THEN payload_bytes ELSE 0 END), 0)
             AS active_bytes
         FROM gateway_inbox`,
      );
      if (
        Number(totals?.active_rows ?? 0) >= this.limits.maxActiveRows ||
        Number(totals?.active_bytes ?? 0) + payloadBytes > this.limits.maxActiveBytes
      ) {
        throw new GatewayInboxCapacityError('Gateway inbox capacity is exhausted.');
      }
      const rowsToFree = Number(totals?.total_rows ?? 0) - this.limits.maxTotalRows + 1;
      if (rowsToFree > 0) {
        const deleted = this.db.run(
          `DELETE FROM gateway_inbox
           WHERE id IN (
             SELECT id FROM gateway_inbox
             WHERE status IN ('completed', 'recovery_required')
             ORDER BY terminal_at, accepted_at, id
             LIMIT ?
          )`,
          rowsToFree,
        );
        if (deleted.changes < rowsToFree) {
          throw new GatewayInboxCapacityError('Gateway inbox capacity is exhausted.');
        }
      }
      const inserted = this.db.run(
        `INSERT INTO gateway_inbox (
          id, binding_id, workspace_id, kind, payload_json, payload_bytes,
          status, attempts, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
        delivery.deliveryId,
        delivery.bindingId,
        delivery.workspaceId,
        delivery.kind,
        payload,
        payloadBytes,
        this.now(),
      );
      if (inserted.changes !== 1) {
        throw new Error('Gateway inbox admission did not insert its durable row.');
      }
      return 'accepted';
    });
  }

  claimPending(limit = GATEWAY_INBOX_MAX_DRAIN_BATCH): PendingGatewayDelivery[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GATEWAY_INBOX_MAX_DRAIN_BATCH) {
      throw new Error(`Gateway inbox drain limit must be between 1 and ${GATEWAY_INBOX_MAX_DRAIN_BATCH}.`);
    }
    this.maintain();
    return this.db.transaction(() => {
      const inFlight = Number(this.db.get(
        "SELECT COUNT(*) AS count FROM gateway_inbox WHERE status = 'in_flight'",
      )?.count ?? 0);
      const available = Math.min(limit, Math.max(0, this.limits.maxInFlight - inFlight));
      if (available === 0) return [];
      const rows = this.db.all(
        `SELECT id, binding_id, workspace_id, kind, payload_json, attempts
         FROM gateway_inbox
         WHERE status = 'pending' AND attempts < ?
         ORDER BY accepted_at, id LIMIT ?`,
        this.limits.maxAttempts,
        available,
      ) as unknown as GatewayInboxRow[];
      const claimed: PendingGatewayDelivery[] = [];
      for (const row of rows) {
        if (!row.payload_json) {
          this.markRecoveryRequired(row.id, 'missing_payload');
          continue;
        }
        const attempts = Number(row.attempts) + 1;
        const updated = this.db.run(
          `UPDATE gateway_inbox
           SET status = 'in_flight', attempts = ?, lease_until = ?
           WHERE id = ? AND status = 'pending'`,
          attempts,
          this.now() + this.limits.leaseMs,
          row.id,
        );
        if (updated.changes !== 1) continue;
        claimed.push({
          id: row.id,
          delivery: parseStoredDelivery(row.payload_json),
          attempts,
        });
      }
      return claimed;
    });
  }

  complete(id: string): boolean {
    return this.db.run(
      `UPDATE gateway_inbox
       SET status = 'completed', payload_json = NULL, payload_bytes = 0,
           lease_until = NULL, terminal_at = ?, recovery_reason = NULL
       WHERE id = ? AND status = 'in_flight'`,
      this.now(),
      id,
    ).changes === 1;
  }

  retryOrRecover(id: string, reason: string): 'pending' | 'recovery_required' {
    const row = this.db.get(
      "SELECT attempts FROM gateway_inbox WHERE id = ? AND status = 'in_flight'",
      id,
    );
    if (!row) return 'recovery_required';
    if (Number(row.attempts) >= this.limits.maxAttempts) {
      this.markRecoveryRequired(id, reason);
      return 'recovery_required';
    }
    this.db.run(
      `UPDATE gateway_inbox
       SET status = 'pending', lease_until = NULL, recovery_reason = ?
       WHERE id = ? AND status = 'in_flight'`,
      boundedReason(reason),
      id,
    );
    return 'pending';
  }

  markRecoveryRequired(id: string, reason: string): boolean {
    return this.db.run(
      `UPDATE gateway_inbox
       SET status = 'recovery_required', payload_json = NULL, payload_bytes = 0,
           lease_until = NULL, terminal_at = ?, recovery_reason = ?
       WHERE id = ? AND status IN ('pending', 'in_flight')`,
      this.now(),
      boundedReason(reason),
      id,
    ).changes === 1;
  }

  maintain(): { agedToRecovery: number; expiredLeasesRecovered: number; tombstonesPurged: number } {
    const now = this.now();
    const expiredAtAttemptCap = this.db.run(
      `UPDATE gateway_inbox
       SET status = 'recovery_required', payload_json = NULL, payload_bytes = 0,
           lease_until = NULL, terminal_at = ?, recovery_reason = 'attempt_limit_exceeded'
       WHERE status = 'in_flight' AND lease_until <= ? AND attempts >= ?`,
      now,
      now,
      this.limits.maxAttempts,
    ).changes;
    const expiredLeasesRecovered = this.db.run(
      `UPDATE gateway_inbox
       SET status = 'pending', lease_until = NULL, recovery_reason = 'lease_expired'
       WHERE status = 'in_flight' AND lease_until <= ? AND attempts < ?`,
      now,
      this.limits.maxAttempts,
    ).changes;
    const agedToRecovery = this.db.run(
      `UPDATE gateway_inbox
       SET status = 'recovery_required', payload_json = NULL, payload_bytes = 0,
           lease_until = NULL, terminal_at = ?, recovery_reason = 'active_age_exceeded'
       WHERE status IN ('pending', 'in_flight') AND accepted_at < ?`,
      now,
      now - this.limits.maxActiveAgeMs,
    ).changes + expiredAtAttemptCap;
    const tombstonesPurged = this.db.run(
      `DELETE FROM gateway_inbox
       WHERE status IN ('completed', 'recovery_required') AND terminal_at < ?`,
      now - this.limits.dedupRetentionMs,
    ).changes;
    return { agedToRecovery, expiredLeasesRecovered, tombstonesPurged };
  }

  hasPending(): boolean {
    return this.db.get(
      "SELECT 1 AS present FROM gateway_inbox WHERE status IN ('pending', 'in_flight') LIMIT 1",
    ) !== undefined;
  }

  runtimeDrainCounts(): GatewayInboxDrainCounts {
    const counts = this.db.get(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END) AS in_flight,
         SUM(CASE WHEN status = 'recovery_required' THEN 1 ELSE 0 END) AS recovery_required
       FROM gateway_inbox`,
    );
    return {
      pendingGatewayInboxDeliveries: Number(counts?.pending ?? 0),
      inFlightGatewayInboxDeliveries: Number(counts?.in_flight ?? 0),
      recoveryRequiredGatewayInboxDeliveries: Number(counts?.recovery_required ?? 0),
    };
  }
}

function parseStoredDelivery(payload: string): GatewayInboundDelivery {
  const value = JSON.parse(payload) as GatewayInboundDelivery;
  if (
    !value || typeof value !== 'object' ||
    (value.kind !== 'event.deliver' && value.kind !== 'interaction.agent_selected')
  ) {
    throw new Error('Stored gateway delivery is invalid.');
  }
  return value;
}

function boundedReason(reason: string): string {
  return typeof reason === 'string' && /^[a-z0-9_:-]{1,160}$/i.test(reason)
    ? reason
    : 'gateway_delivery_failed';
}

function validateLimits(limits: GatewayInboxLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Gateway inbox ${name} must be a positive integer.`);
    }
  }
  if (limits.maxInFlight > limits.maxActiveRows) {
    throw new Error('Gateway inbox in-flight limit cannot exceed its active-row limit.');
  }
  if (limits.maxActiveRows > limits.maxTotalRows) {
    throw new Error('Gateway inbox active-row limit cannot exceed its total-row limit.');
  }
}
