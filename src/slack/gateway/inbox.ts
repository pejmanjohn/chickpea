import { addColumnIfMissing } from '../../state/schema-links.ts';
import { schemaInstallRequired, type StateDb } from '../../state/state-db.ts';
import type { GatewayInboundDelivery } from './protocol.ts';
import {
  isRetryableDependencyFailure,
  MAX_DEPENDENCY_RETRY_AFTER_MS,
  retryableDependencyRetryAfterMs,
} from '../transport/types.ts';

const GATEWAY_INBOX_MAX_TOTAL_ROWS = 1_000_000;
const GATEWAY_INBOX_MAX_ACTIVE_ROWS = 512;
const GATEWAY_INBOX_MAX_ACTIVE_BYTES = 32 * 1_048_576;
const GATEWAY_INBOX_MAX_PAYLOAD_BYTES = 1_048_576;
const GATEWAY_INBOX_MAX_ACTIVE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
// Slack Delayed Events can retry for 24 hours. Keep the content-free identity
// for twice that window so boundary retries and local recovery still dedupe.
const GATEWAY_INBOX_DEDUP_RETENTION_MS = 48 * 60 * 60 * 1_000;
const GATEWAY_INBOX_MAX_ATTEMPTS = 5;
const GATEWAY_INBOX_MAX_IN_FLIGHT = 16;
const GATEWAY_INBOX_LEASE_MS = 2 * 60_000;
export const GATEWAY_INBOX_MAX_DRAIN_BATCH = 16;
// The shared gateway limits each binding with a fixed 60 s window. Backoff for
// a retryable dependency failure spans more than one window across the
// attempt budget (5 + 10 + 20 + 40 s) so a burst cannot spend every attempt
// inside the window that rejected it.
const GATEWAY_INBOX_RETRY_BASE_MS = 5_000;
const GATEWAY_INBOX_MAX_RETRY_DELAY_MS = MAX_DEPENDENCY_RETRY_AFTER_MS;

/**
 * Delay before a delivery that failed on a retryable dependency (rate limit,
 * unreachable gateway, store disconnect) is claimed again. `attempts` is the
 * attempt that just failed (1-based); a server `retryAfterMs` hint wins when
 * it is longer.
 */
export function gatewayInboxRetryDelayMs(attempts: number, retryAfterMs?: number): number {
  const exponent = Math.max(0, Math.min(10, Math.trunc(attempts) - 1));
  const backoff = Math.min(GATEWAY_INBOX_RETRY_BASE_MS * 2 ** exponent, GATEWAY_INBOX_MAX_RETRY_DELAY_MS);
  const hint = retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
    ? Math.min(Math.max(0, retryAfterMs), GATEWAY_INBOX_MAX_RETRY_DELAY_MS)
    : 0;
  return Math.max(backoff, hint);
}

/** Stored recovery reason for a delivery that failed on a retryable dependency. */
export const GATEWAY_DELIVERY_DEPENDENCY_REASON = 'delivery_dependency_retryable';

/**
 * The recovery reason to record for a delivery whose processing threw. A
 * retryable dependency failure (a rate-limited or unreachable Slack/gateway)
 * gets its own reason, so a row dead-lettered after the last attempt is
 * countable apart from ordinary processing failures.
 */
export function gatewayDeliveryFailureReason(error: unknown): string {
  return isRetryableDependencyFailure(error)
    ? GATEWAY_DELIVERY_DEPENDENCY_REASON
    : 'delivery_processing_failed';
}

/**
 * Record, without any event content, that a delivery was dead-lettered: its
 * attempts are spent and the mention it carried will not be admitted.
 */
export function recordGatewayDeliveryDeadLetter(
  delivery: Pick<GatewayInboundDelivery, 'kind'>,
  attempts: number,
  error: unknown,
): void {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error ? error.name : 'unknown';
  console.error('[chickpea] gateway_delivery_dead_lettered', JSON.stringify({
    kind: delivery.kind,
    attempts,
    reason: gatewayDeliveryFailureReason(error),
    retryable: isRetryableDependencyFailure(error),
    code: /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'other',
  }));
}

/**
 * Retry delay for a delivery whose processing threw. Only a retryable
 * dependency failure backs off; any other failure keeps the immediate retry
 * (its attempt budget still parks it for recovery).
 */
export function gatewayDeliveryRetryDelayMs(attempts: number, error: unknown): number {
  if (!isRetryableDependencyFailure(error)) return 0;
  return gatewayInboxRetryDelayMs(attempts, retryableDependencyRetryAfterMs(error));
}

export type GatewayInboxAdmissionOutcome = 'accepted' | 'duplicate';
export type GatewayInboxValidatedAdmissionOutcome = GatewayInboxAdmissionOutcome | 'rejected';

interface GatewayInboxLimits {
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

interface PendingGatewayDelivery {
  id: string;
  delivery: GatewayInboundDelivery;
  attempts: number;
  /** When this DO durably accepted the delivery (the turn's receipt time). */
  acceptedAt: number;
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
  accepted_at?: number;
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
/**
 * A lease taken by a replaced drainer is reclaimed once its claim is this
 * old. A replaced Durable Object instance loses its storage at once, but a
 * network call it was already awaiting may still complete; this covers one
 * such call before the delivery is processed again.
 */
export const GATEWAY_INBOX_ORPHAN_GRACE_MS = 10_000;

export interface GatewayInboxOwnership {
  /**
   * Identifies the drainer that claims deliveries: one value per process or
   * Durable Object instance. A claim records it with its lease. Only one
   * instance owns the storage at a time, so an in-flight claim under any
   * other owner (or none, from before owners were recorded) was taken by a
   * drainer that has been replaced: it is reclaimed once it is
   * GATEWAY_INBOX_ORPHAN_GRACE_MS old instead of at its lease time. Without
   * an owner, leases only expire by time.
   */
  leaseOwner?: string;
}

export class GatewayInboxStoreLogic {
  private readonly limits: GatewayInboxLimits;
  private readonly leaseOwner: string | undefined;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
    limits: Partial<GatewayInboxLimits> = {},
    ownership: GatewayInboxOwnership = {},
  ) {
    this.leaseOwner = ownership.leaseOwner;
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
    if (!schemaInstallRequired(db)) return;
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
    // The drainer that holds an in-flight lease (see GatewayInboxOwnership).
    addColumnIfMissing(db, 'gateway_inbox', 'lease_owner', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS gateway_inbox_status_idx ON gateway_inbox(status, accepted_at)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS gateway_inbox_terminal_idx ON gateway_inbox(status, terminal_at)',
    );
  }

  admit(delivery: GatewayInboundDelivery): GatewayInboxAdmissionOutcome {
    const outcome = this.admitValidated(delivery, () => delivery);
    if (outcome === 'rejected') throw new Error('Unconditional gateway admission was rejected.');
    return outcome;
  }

  /** Keep the current authority check and durable insert in one transaction. */
  admitValidated(
    delivery: GatewayInboundDelivery,
    prepare: () => GatewayInboundDelivery | undefined,
  ): GatewayInboxValidatedAdmissionOutcome {
    this.maintain();
    return this.db.transaction(() => {
      const durableDelivery = prepare();
      if (!durableDelivery) return 'rejected';
      const payload = JSON.stringify(durableDelivery);
      const payloadBytes = new TextEncoder().encode(payload).byteLength;
      if (payloadBytes > this.limits.maxPayloadBytes) {
        throw new GatewayInboxCapacityError('Gateway inbox delivery exceeds the per-row byte limit.');
      }
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
      if (Number(totals?.total_rows ?? 0) >= this.limits.maxTotalRows) {
        // Never trade dedup correctness for admission. maintain() already
        // purged every expired tombstone before this transaction.
        throw new GatewayInboxCapacityError('Gateway inbox capacity is exhausted.');
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
        `SELECT id, binding_id, workspace_id, kind, payload_json, attempts, accepted_at
         FROM gateway_inbox
         WHERE status = 'pending' AND attempts < ?
           AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY accepted_at, id LIMIT ?`,
        this.limits.maxAttempts,
        this.now(),
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
           SET status = 'in_flight', attempts = ?, lease_until = ?, lease_owner = ?
           WHERE id = ? AND status = 'pending'`,
          attempts,
          this.now() + this.limits.leaseMs,
          this.leaseOwner ?? null,
          row.id,
        );
        if (updated.changes !== 1) continue;
        claimed.push({
          id: row.id,
          delivery: parseStoredDelivery(row.payload_json),
          attempts,
          acceptedAt: Number(row.accepted_at),
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

  /**
   * Return an in-flight delivery to pending, or park it for recovery once its
   * attempts are spent. A positive `retryDelayMs` keeps the pending row
   * unclaimable until then (stored in `lease_until`, which a pending row does
   * not otherwise use), so a rate-limited dependency is not retried into the
   * same exhausted window. Other pending rows stay claimable meanwhile.
   */
  retryOrRecover(
    id: string,
    reason: string,
    retryDelayMs = 0,
  ): 'pending' | 'recovery_required' {
    const row = this.db.get(
      "SELECT attempts FROM gateway_inbox WHERE id = ? AND status = 'in_flight'",
      id,
    );
    if (!row) return 'recovery_required';
    if (Number(row.attempts) >= this.limits.maxAttempts) {
      this.markRecoveryRequired(id, reason);
      return 'recovery_required';
    }
    const delay = Number.isFinite(retryDelayMs)
      ? Math.min(Math.max(0, Math.trunc(retryDelayMs)), GATEWAY_INBOX_MAX_RETRY_DELAY_MS)
      : 0;
    this.db.run(
      `UPDATE gateway_inbox
       SET status = 'pending', lease_until = ?, recovery_reason = ?
       WHERE id = ? AND status = 'in_flight'`,
      delay > 0 ? this.now() + delay : null,
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

  maintain(): {
    agedToRecovery: number;
    expiredLeasesRecovered: number;
    orphanedLeasesRecovered: number;
    tombstonesPurged: number;
  } {
    const now = this.now();
    // A lease held by a replaced drainer (another state store instance)
    // expires once its claim is GATEWAY_INBOX_ORPHAN_GRACE_MS old instead of
    // at its lease time. At the attempt cap it is parked, like the
    // time-expired ones below. The claim time is lease_until - leaseMs.
    const orphanClaimedBy = now - GATEWAY_INBOX_ORPHAN_GRACE_MS + this.limits.leaseMs;
    const orphanedAtAttemptCap = this.leaseOwner === undefined ? 0 : this.db.run(
      `UPDATE gateway_inbox
       SET status = 'recovery_required', payload_json = NULL, payload_bytes = 0,
           lease_until = NULL, terminal_at = ?, recovery_reason = 'attempt_limit_exceeded'
       WHERE status = 'in_flight' AND (lease_owner IS NULL OR lease_owner != ?)
         AND lease_until <= ? AND attempts >= ?`,
      now,
      this.leaseOwner,
      orphanClaimedBy,
      this.limits.maxAttempts,
    ).changes;
    const orphanedLeasesRecovered = this.leaseOwner === undefined ? 0 : this.db.run(
      `UPDATE gateway_inbox
       SET status = 'pending', lease_until = NULL, recovery_reason = 'lease_orphaned'
       WHERE status = 'in_flight' AND (lease_owner IS NULL OR lease_owner != ?)
         AND lease_until <= ? AND attempts < ?`,
      this.leaseOwner,
      orphanClaimedBy,
      this.limits.maxAttempts,
    ).changes;
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
    ).changes + expiredAtAttemptCap + orphanedAtAttemptCap;
    const tombstonesPurged = this.db.run(
      `DELETE FROM gateway_inbox
       WHERE status IN ('completed', 'recovery_required') AND terminal_at < ?`,
      now - this.limits.dedupRetentionMs,
    ).changes;
    return { agedToRecovery, expiredLeasesRecovered, orphanedLeasesRecovered, tombstonesPurged };
  }

  /** An in-flight delivery claimed by a drainer other than this one. */
  hasOrphanedLease(): boolean {
    if (this.leaseOwner === undefined) return false;
    return this.db.get(
      `SELECT 1 AS present FROM gateway_inbox
       WHERE status = 'in_flight' AND (lease_owner IS NULL OR lease_owner != ?) LIMIT 1`,
      this.leaseOwner,
    ) !== undefined;
  }

  /**
   * Work to do now: an in-flight row, or a pending row whose retry backoff
   * (if any) has elapsed. A row still backing off is not "pending now"; its
   * due time is {@link nextPendingDueAt}, so a drain arms its wake for then
   * instead of polling every few seconds and claiming nothing.
   */
  hasPending(): boolean {
    return this.db.get(
      `SELECT 1 AS present FROM gateway_inbox
       WHERE status = 'in_flight'
          OR (status = 'pending' AND (lease_until IS NULL OR lease_until <= ?))
       LIMIT 1`,
      this.now(),
    ) !== undefined;
  }

  /** The earliest time a pending row that is backing off becomes claimable. */
  nextPendingDueAt(): number | undefined {
    const row = this.db.get(
      `SELECT MIN(lease_until) AS due FROM gateway_inbox
       WHERE status = 'pending' AND lease_until > ?`,
      this.now(),
    );
    const due = row?.due;
    return due === null || due === undefined ? undefined : Number(due);
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
    (value.kind !== 'event.deliver' && value.kind !== 'interaction.agent_selected' &&
      value.kind !== 'interaction.channel_agent_add')
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
