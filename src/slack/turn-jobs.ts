import type {
  SlackInteractionProgressPatch,
  TurnProgress,
  TurnPullRequestProgress,
} from '../config/state-rpc.ts';
import {
  deriveRuntimePlanInstanceId,
  parseRuntimePlanV2,
  type RuntimePlanV2,
} from '../agents/runtime-plan.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
  FlueObservationTarget,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
  FrozenRuntimePlanDecision,
  SlackAgentBinding,
  SlackAgentBindingExpectation,
  TurnJob,
} from './turn-job-types.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { StateDb } from '../state/state-db.ts';
import type { SlackRuntimeDrainCounts } from '../config/state-rpc.ts';
import type { SlackTurnRecoveryItem } from '../config/state-rpc.ts';
import type { RunExecutionAuthority } from '../work/types.ts';
import { CLAIM_TTL_MS } from './state-limits.ts';
import type { NormalizedSlackTurn } from './types.ts';
import type { UsagePersistenceEvent } from '../usage/runtime-recorder.ts';
import type { SlackInteractionIntent } from './interaction-intent.ts';

/**
 * Durable queue of Slack turns for the Cloudflare turn-relay (see state-rpc.ts
 * TurnJob for why the relay exists). The events handler enqueues a job and arms
 * the state DO's alarm; the alarm drains pending jobs and runs each turn with
 * the DO's 15-minute wall-time budget instead of the events invocation's ~30s
 * `waitUntil` horizon.
 *
 * This is target-neutral StateDb logic (like the claim/snapshot/settings logic):
 * Cloudflare drains it from the state Durable Object alarm, while Node drains
 * the same durable rows from its independent SQLite-backed relay.
 *
 * Delivery guarantees:
 *   - Idempotent enqueue (INSERT OR IGNORE on the message claim key), so the
 *     app_mention + message fan-out for one mention enqueues at most once.
 *   - A `delivered` tombstone excludes a completed job from any later alarm
 *     scan (`WHERE delivered = 0`), the guard against a redundant re-delivery.
 *   - Never-dispatched failures retain the bounded legacy retry policy.
 *     Dispatched rows reattach through their immutable Flue checkpoints.
 *   - Only terminal rows with no pending Slack cleanup age out. Stuck
 *     nonterminal rows become visible recovery work after 30 days.
 */

/** Attempts (inclusive) the alarm makes to deliver a turn before giving up. */
export const MAX_TURN_ATTEMPTS = 2;
/** Dispatched turns may reattach more often, but never hot-loop indefinitely. */
export const MAX_POST_DISPATCH_ATTEMPTS = 8;
export const MAX_TURN_DRAIN_BATCH = 16;

// Terminal rows need only outlive Slack's redelivery horizon. Nonterminal rows
// and their claims are retained until explicitly resolved and terminalized.
export const TURN_JOB_TTL_MS = CLAIM_TTL_MS;
export const SLACK_AGENT_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const TURN_JOB_RECOVERY_BACKSTOP_MS = SLACK_AGENT_BINDING_TTL_MS;

/** A pending job the alarm should run, decoded from its row. */
export interface PendingTurnJob {
  id: string;
  evtKey: string;
  msgKey: string;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  runId?: string;
  executionAuthority: RunExecutionAuthority;
  /** Deliveries already attempted (0 before the alarm has ever run it). */
  attempts: number;
  progress: TurnProgress;
  runtimePlan?: RuntimePlanV2;
  agentInstanceId?: string;
  dispatchEnvelope?: FlueDispatchEnvelopeV1;
  dispatchReceipt?: FlueDispatchReceiptV1;
  flueSettlement?: FlueSettlementCheckpointV1;
  dispatchStartedAt?: number;
  recoveryReason?: string;
}

interface TurnJobRow {
  id: string;
  evt_key: string;
  msg_key: string;
  turn_json: string;
  assignment_json: string;
  run_id?: string | null;
  execution_authority: RunExecutionAuthority;
  attempts: number;
  progress_json: string;
  runtime_plan_json?: string | null;
  agent_instance_id?: string | null;
  dispatch_envelope_json?: string | null;
  dispatch_receipt_json?: string | null;
  flue_settlement_json?: string | null;
  dispatch_started_at?: number | null;
  submission_id?: string | null;
  observation_json?: string | null;
  recovery_reason?: string | null;
}

const TURN_JOB_SELECT_COLUMNS = `id, evt_key, msg_key, turn_json, assignment_json, run_id,
  execution_authority, attempts, progress_json, runtime_plan_json,
  agent_instance_id, dispatch_envelope_json,
  dispatch_receipt_json, flue_settlement_json, dispatch_started_at,
  submission_id, observation_json, recovery_reason`;

export class TurnJobStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS turn_jobs (
        id TEXT PRIMARY KEY,
        evt_key TEXT NOT NULL,
        msg_key TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        assignment_json TEXT NOT NULL,
        run_id TEXT,
        execution_authority TEXT NOT NULL DEFAULT 'legacy',
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        progress_json TEXT NOT NULL DEFAULT '{}',
        runtime_plan_json TEXT,
        agent_instance_id TEXT,
        dispatch_envelope_json TEXT,
        dispatch_receipt_json TEXT,
        flue_settlement_json TEXT,
        dispatch_started_at INTEGER,
        submission_id TEXT,
        observation_json TEXT,
        recovery_reason TEXT,
        enqueued_at INTEGER NOT NULL
      )`,
    );
    const columns = db.all('PRAGMA table_info(turn_jobs)');
    if (!columns.some((column) => column.name === 'progress_json')) {
      db.exec("ALTER TABLE turn_jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!columns.some((column) => column.name === 'run_id')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN run_id TEXT');
    }
    if (!columns.some((column) => column.name === 'execution_authority')) {
      db.exec("ALTER TABLE turn_jobs ADD COLUMN execution_authority TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!columns.some((column) => column.name === 'runtime_plan_json')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN runtime_plan_json TEXT');
    }
    if (!columns.some((column) => column.name === 'agent_instance_id')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN agent_instance_id TEXT');
    }
    if (!columns.some((column) => column.name === 'dispatch_envelope_json')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN dispatch_envelope_json TEXT');
    }
    if (!columns.some((column) => column.name === 'dispatch_receipt_json')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN dispatch_receipt_json TEXT');
    }
    if (!columns.some((column) => column.name === 'flue_settlement_json')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN flue_settlement_json TEXT');
    }
    if (!columns.some((column) => column.name === 'dispatch_started_at')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN dispatch_started_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'submission_id')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN submission_id TEXT');
    }
    if (!columns.some((column) => column.name === 'observation_json')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN observation_json TEXT');
    }
    if (!columns.some((column) => column.name === 'recovery_reason')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN recovery_reason TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS turn_jobs_instance_id_idx ON turn_jobs(agent_instance_id)');
    db.exec('CREATE INDEX IF NOT EXISTS turn_jobs_submission_id_idx ON turn_jobs(submission_id)');
    db.exec(
      `CREATE TABLE IF NOT EXISTS slack_agent_bindings (
        continuity_key TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    // This ephemeral beta bridge mixed per-turn Slack coordinates with Flue
    // identity. RuntimePlanV2 now carries immutable coordinates and the binding
    // table is the sole long-lived incarnation pin.
    db.exec('DROP TABLE IF EXISTS slack_agent_execution_contexts');
  }

  /**
   * Persist a job write-once by id. Returns true when newly enqueued, false
   * when the id already existed (a duplicate enqueue — ignored). The caller
   * arms the alarm regardless: re-arming for an already-queued job is harmless.
   */
  enqueue(job: TurnJob): boolean {
    this.purgeExpired();
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO turn_jobs (
        id, evt_key, msg_key, turn_json, assignment_json, run_id, execution_authority,
        attempts, delivered, status, enqueued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', ?)`,
      job.id,
      job.evtKey,
      job.msgKey,
      JSON.stringify(job.turn),
      JSON.stringify(job.assignment),
      job.runId ?? null,
      job.executionAuthority ?? 'legacy',
      this.now(),
    );
    return inserted.changes === 1;
  }

  /**
   * Continue an OAuth-suspended Slack task as a fresh delivery into the same
   * Agent conversation. The original row may already be terminal (it posted
   * the authorization link); the continuation id makes callback replay
   * idempotent while the new plan resolves the newly-ready account live.
   */
  resumeAfterOAuth(originalTaskId: string, continuationId: string): boolean {
    const id = `oauthresume:${continuationId}`;
    const existing = this.db.get(
      'SELECT id FROM turn_jobs WHERE id = ? LIMIT 1',
      id,
    ) as { id: string } | undefined;
    if (existing) return true;
    const row = this.db.get(
      `SELECT ${TURN_JOB_SELECT_COLUMNS} FROM turn_jobs WHERE id = ? LIMIT 1`,
      originalTaskId,
    ) as unknown as TurnJobRow | undefined;
    if (!row) return false;
    const original = this.decodeRow(row);
    return this.enqueue({
      id,
      evtKey: `evt:${id}`,
      msgKey: id,
      turn: {
        ...original.turn,
        eventId: id,
        text: 'Personal connection authorization is complete. Continue the interrupted request now without repeating any action already completed.',
      },
      assignment: original.assignment,
      executionAuthority: 'legacy',
    });
  }

  /** Undelivered jobs in enqueue order — the alarm's work list. */
  listPending(
    limit = 100,
    executionAuthority: RunExecutionAuthority = 'legacy',
  ): PendingTurnJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Turn job limit must be between 1 and 100.');
    }
    const rows = this.db.all(
      `SELECT ${TURN_JOB_SELECT_COLUMNS}
       FROM turn_jobs
       WHERE delivered = 0 AND status != 'recovery_required' AND execution_authority = ?
       ORDER BY enqueued_at LIMIT ?`,
      executionAuthority,
      limit,
    ) as unknown as TurnJobRow[];
    return rows.map((row) => this.decodeRow(row));
  }

  countPendingDeliveriesForWorkspace(workspaceId: string): number {
    const row = this.db.get(
      `SELECT COUNT(*) AS count
       FROM turn_jobs
       WHERE (
           delivered = 0
           OR (delivered = 1 AND progress_json LIKE '%"cleanup":"pending"%')
         )
         AND json_extract(turn_json, '$.workspaceId') = ?`,
      workspaceId,
    ) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getPendingByRunId(runId: string): PendingTurnJob | undefined {
    const row = this.db.get(
      `SELECT ${TURN_JOB_SELECT_COLUMNS}
       FROM turn_jobs
       WHERE delivered = 0 AND status != 'recovery_required'
         AND execution_authority = 'ledger' AND run_id = ?
       LIMIT 1`,
      runId,
    ) as unknown as TurnJobRow | undefined;
    return row ? this.decodeRow(row) : undefined;
  }

  /** First successful write owns the plan and target for every later retry. */
  freezeRuntimePlan(id: string, candidate: RuntimePlanV2): FrozenRuntimePlanDecision {
    const plan = parseRuntimePlanV2(candidate);
    return this.db.transaction(() => {
      const current = this.getFrozenRuntimePlan(id);
      if (current) return current;
      const instanceId = deriveRuntimePlanInstanceId(plan);
      const updated = this.db.run(
        `UPDATE turn_jobs
         SET runtime_plan_json = ?, agent_instance_id = ?
         WHERE id = ? AND runtime_plan_json IS NULL`,
        JSON.stringify(plan),
        instanceId,
        id,
      );
      if (updated.changes !== 1) {
        const winner = this.getFrozenRuntimePlan(id);
        if (winner) return winner;
        throw new Error('TurnJob is unavailable for RuntimePlanV2 freeze.');
      }
      return { runtimePlan: plan, instanceId };
    });
  }

  getFrozenRuntimePlan(id: string): FrozenRuntimePlanDecision | undefined {
    const row = this.db.get(
      `SELECT runtime_plan_json, agent_instance_id
       FROM turn_jobs WHERE id = ?`,
      id,
    );
    if (!row?.runtime_plan_json) return undefined;
    const runtimePlan = parseRuntimePlanV2(JSON.parse(String(row.runtime_plan_json)));
    const instanceId = validateOpaqueAgentId(row.agent_instance_id, 'instance id');
    return {
      runtimePlan,
      instanceId,
    };
  }

  /**
   * Freeze the exact Flue admission before crossing the dispatch boundary.
   * A retry always receives the byte-equivalent envelope, including its
   * create/continue condition and idempotency key.
   */
  prepareFlueDispatch(
    id: string,
    message: string,
    observation: FlueTurnObservationV1,
  ): FlueDispatchEnvelopeV1 {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('Flue dispatch message must be non-empty.');
    }
    validateFlueObservation(observation);
    const existing = this.getDispatchEnvelope(id);
    if (existing) {
      if (existing.message.body !== message) {
        this.markRecoveryRequired(id, 'flue_dispatch_payload_conflict');
        throw new Error('Flue dispatch payload conflicts with the durable checkpoint.');
      }
      return existing;
    }
    return this.db.transaction(() => {
      const decision = this.getFrozenRuntimePlan(id);
      if (!decision) {
        throw new Error('RuntimePlanV2 must be frozen before Flue dispatch.');
      }
      const binding = this.readAgentBinding(decision.runtimePlan.conversation.continuityKey);
      const continuing = binding?.instanceId === decision.instanceId ? binding : undefined;
      const row = this.db.get('SELECT turn_json FROM turn_jobs WHERE id = ?', id);
      if (!row?.turn_json) throw new Error('TurnJob is unavailable for Flue dispatch.');
      const turn = JSON.parse(String(row.turn_json)) as NormalizedSlackTurn;
      const signalThreadTs = decision.runtimePlan.conversation.threadTs;
      const signalThreadMatchesTurn = signalThreadTs === turn.threadTs ||
        signalThreadTs === turn.sessionThreadTs;
      if (
        turn.workspaceId !== decision.runtimePlan.conversation.workspaceId ||
        turn.channelId !== decision.runtimePlan.conversation.channelId ||
        !signalThreadMatchesTurn
      ) {
        throw new Error('Slack signal coordinates do not match RuntimePlanV2.');
      }
      const envelope: FlueDispatchEnvelopeV1 = {
        schemaVersion: 2,
        agentName: 'chickpea-slack-v2',
        instanceId: decision.instanceId,
        uid: continuing?.uid ?? null,
        message: {
          kind: 'signal',
          type: 'slack.message',
          body: message,
          tagName: 'slack_message',
          attributes: {
            workspaceId: turn.workspaceId,
            channelId: turn.channelId,
            threadTs: signalThreadTs,
            slackUserId: turn.userId,
            eventId: turn.eventId,
            messageTs: turn.messageTs,
            turnJobId: id,
          },
        },
        ...(continuing ? {} : { initialData: decision.runtimePlan }),
        idempotencyKey: id,
        ...(!continuing && binding
          ? { previousBinding: { instanceId: binding.instanceId, uid: binding.uid } }
          : {}),
      };
      parseFlueDispatchEnvelope(envelope);
      const startedAt = this.now();
      const updated = this.db.run(
        `UPDATE turn_jobs
         SET dispatch_envelope_json = ?, dispatch_started_at = ?, observation_json = ?
         WHERE id = ? AND dispatch_envelope_json IS NULL`,
        JSON.stringify(envelope),
        startedAt,
        JSON.stringify(observation),
        id,
      );
      if (updated.changes !== 1) {
        const winner = this.getDispatchEnvelope(id);
        if (winner) return winner;
        throw new Error('TurnJob is unavailable for Flue dispatch.');
      }
      return envelope;
    });
  }

  getDispatchEnvelope(id: string): FlueDispatchEnvelopeV1 | undefined {
    const row = this.db.get(
      'SELECT dispatch_envelope_json FROM turn_jobs WHERE id = ?',
      id,
    );
    return row?.dispatch_envelope_json
      ? parseFlueDispatchEnvelope(JSON.parse(String(row.dispatch_envelope_json)))
      : undefined;
  }

  /**
   * A create-only send can prove that the deterministic instance already
   * exists and return its uid without admitting any work. Persist that
   * confirmed incarnation before retrying as a continue-only send.
   */
  reconcileFlueExistingInstance(id: string, uid: string): FlueDispatchEnvelopeV1 {
    validateBoundedString(uid, 'Flue instance uid', 200);
    const existing = this.getDispatchEnvelope(id);
    if (!existing) throw new Error('Flue dispatch envelope is unavailable.');
    if (existing.uid === uid && existing.initialData === undefined) return existing;
    if (existing.uid !== null || existing.initialData === undefined) {
      this.markRecoveryRequired(id, 'flue_existing_instance_reconciliation_conflict');
      throw new Error('Flue existing-instance reconciliation conflicts with the checkpoint.');
    }

    const { initialData: _creationData, ...rest } = existing;
    const reconciled = parseFlueDispatchEnvelope({ ...rest, uid });
    const updated = this.db.run(
      `UPDATE turn_jobs SET dispatch_envelope_json = ?
       WHERE id = ? AND dispatch_envelope_json = ?
         AND dispatch_receipt_json IS NULL AND flue_settlement_json IS NULL`,
      JSON.stringify(reconciled),
      id,
      JSON.stringify(existing),
    );
    if (updated.changes === 1) return reconciled;
    const winner = this.getDispatchEnvelope(id);
    if (winner && sameJson(winner, reconciled)) return winner;
    this.markRecoveryRequired(id, 'flue_existing_instance_reconciliation_conflict');
    throw new Error('Flue existing-instance reconciliation lost its compare-and-set race.');
  }

  /** Persist admission before any read begins and pin the contacted incarnation. */
  recordFlueReceipt(id: string, value: FlueDispatchReceiptV1): FlueDispatchReceiptV1 {
    const receipt = parseFlueDispatchReceipt(value);
    const envelope = this.getDispatchEnvelope(id);
    if (!envelope) throw new Error('Flue dispatch envelope is unavailable.');
    const current = this.getFlueReceipt(id);
    if (current) {
      if (!sameJson(current, receipt)) {
        this.markRecoveryRequired(id, 'flue_receipt_conflict');
        throw new Error('Flue dispatch receipt conflicts with the durable checkpoint.');
      }
      return current;
    }
    const updated = this.db.run(
      `UPDATE turn_jobs
       SET dispatch_receipt_json = ?, submission_id = ?
       WHERE id = ? AND dispatch_receipt_json IS NULL`,
      JSON.stringify(receipt),
      receipt.submissionId,
      id,
    );
    const persisted = updated.changes === 1 ? receipt : this.getFlueReceipt(id);
    if (!persisted || !sameJson(persisted, receipt)) {
      this.markRecoveryRequired(id, 'flue_receipt_conflict');
      throw new Error('Flue dispatch receipt could not be checkpointed.');
    }
    try {
      this.pinReceiptBinding(envelope, persisted);
    } catch (error) {
      this.markRecoveryRequired(id, 'flue_binding_reconciliation_required');
      throw error;
    }
    return persisted;
  }

  getFlueReceipt(id: string): FlueDispatchReceiptV1 | undefined {
    const row = this.db.get(
      'SELECT dispatch_receipt_json FROM turn_jobs WHERE id = ?',
      id,
    );
    return row?.dispatch_receipt_json
      ? parseFlueDispatchReceipt(JSON.parse(String(row.dispatch_receipt_json)))
      : undefined;
  }

  recordFlueSettlement(
    id: string,
    value: FlueSettlementCheckpointV1,
  ): FlueSettlementCheckpointV1 {
    const settlement = parseFlueSettlement(value);
    const current = this.getFlueSettlement(id);
    if (current) {
      if (!sameJson(current, settlement)) {
        this.markRecoveryRequired(id, 'flue_settlement_conflict');
        throw new Error('Flue settlement conflicts with the durable checkpoint.');
      }
      return current;
    }
    if (!this.getFlueReceipt(id)) {
      throw new Error('Flue receipt must be checkpointed before settlement.');
    }
    const updated = this.db.run(
      `UPDATE turn_jobs SET flue_settlement_json = ?
       WHERE id = ? AND flue_settlement_json IS NULL`,
      JSON.stringify(settlement),
      id,
    );
    const persisted = updated.changes === 1 ? settlement : this.getFlueSettlement(id);
    if (!persisted || !sameJson(persisted, settlement)) {
      this.markRecoveryRequired(id, 'flue_settlement_conflict');
      throw new Error('Flue settlement could not be checkpointed.');
    }
    return persisted;
  }

  getFlueSettlement(id: string): FlueSettlementCheckpointV1 | undefined {
    const row = this.db.get(
      'SELECT flue_settlement_json FROM turn_jobs WHERE id = ?',
      id,
    );
    return row?.flue_settlement_json
      ? parseFlueSettlement(JSON.parse(String(row.flue_settlement_json)))
      : undefined;
  }

  /**
   * Resolve framework observations without a model-visible carrier. Exact
   * receipt matches win; before receipt persistence only one dispatch-started
   * row for the instance may be adopted. Delivered and ambiguous rows vanish.
   */
  matchFlueObservation(
    instanceId: string,
    submissionId?: string,
  ): FlueObservationTarget | undefined {
    validateOpaqueAgentId(instanceId, 'instance id');
    if (submissionId !== undefined) validateBoundedString(submissionId, 'submission id', 200);
    const exact = submissionId
      ? this.db.all(
          `SELECT id, observation_json FROM turn_jobs
           WHERE delivered = 0 AND agent_instance_id = ? AND submission_id = ?
           LIMIT 2`,
          instanceId,
          submissionId,
        )
      : [];
    if (
      submissionId &&
      exact.length === 0 &&
      this.db.get('SELECT 1 AS known FROM turn_jobs WHERE submission_id = ? LIMIT 1', submissionId)
    ) {
      // A late event for a delivered/terminal row must never fall through and
      // attach to a newer receiptless turn on the same conversation.
      return undefined;
    }
    const candidates = exact.length > 0
      ? exact
      : this.db.all(
          `SELECT id, observation_json FROM turn_jobs
           WHERE delivered = 0 AND agent_instance_id = ?
             AND dispatch_started_at IS NOT NULL AND submission_id IS NULL
           ORDER BY dispatch_started_at LIMIT 2`,
          instanceId,
        );
    if (candidates.length !== 1) return undefined;
    const row = candidates[0]!;
    if (!row.observation_json) return undefined;
    const observation = parseFlueObservation(JSON.parse(String(row.observation_json)));
    return {
      ...observation,
      turnJobId: String(row.id),
      instanceId,
      ...(submissionId ? { submissionId } : {}),
    };
  }

  markRecoveryRequired(id: string, reason: string): void {
    validateBoundedString(reason, 'recovery reason', 120);
    this.db.run(
      `UPDATE turn_jobs SET status = 'recovery_required', recovery_reason = ?
       WHERE id = ? AND delivered = 0`,
      reason,
      id,
    );
  }

  /**
   * Pin a successful Flue incarnation. Revisions use explicit compare-and-set
   * so an older in-flight turn cannot overwrite a newer conversation binding.
   */
  pinAgentBinding(
    input: SlackAgentBinding,
    expected?: SlackAgentBindingExpectation,
  ): SlackAgentBinding {
    validateAgentBinding(input);
    if (expected) validateAgentBindingExpectation(expected);
    this.purgeExpired();
    return this.db.transaction(() => {
      const current = this.readAgentBinding(input.continuityKey);
      if (!current) {
        if (expected) {
          throw new Error('Slack agent binding compare-and-set target is missing.');
        }
        this.db.run(
          `INSERT INTO slack_agent_bindings (continuity_key, instance_id, uid, updated_at)
           VALUES (?, ?, ?, ?)`,
          input.continuityKey,
          input.instanceId,
          input.uid,
          input.updatedAt,
        );
        return input;
      }
      if (current.instanceId === input.instanceId) {
        if (current.uid !== input.uid) {
          throw new Error('Slack agent binding has a conflicting uid for this instance.');
        }
        this.db.run(
          'UPDATE slack_agent_bindings SET updated_at = ? WHERE continuity_key = ?',
          Math.max(current.updatedAt, input.updatedAt),
          input.continuityKey,
        );
        return this.readAgentBinding(input.continuityKey)!;
      }
      if (
        !expected ||
        current.instanceId !== expected.instanceId ||
        current.uid !== expected.uid
      ) {
        throw new Error('Slack agent binding rotation requires a matching compare-and-set value.');
      }
      this.db.run(
        `UPDATE slack_agent_bindings
         SET instance_id = ?, uid = ?, updated_at = ?
         WHERE continuity_key = ?`,
        input.instanceId,
        input.uid,
        input.updatedAt,
        input.continuityKey,
      );
      return input;
    });
  }

  getAgentBinding(continuityKey: string): SlackAgentBinding | undefined {
    validateOpaqueAgentId(continuityKey, 'continuity key');
    this.purgeExpired();
    return this.readAgentBinding(continuityKey);
  }

  private readAgentBinding(continuityKey: string): SlackAgentBinding | undefined {
    const row = this.db.get(
      `SELECT continuity_key, instance_id, uid, updated_at
       FROM slack_agent_bindings WHERE continuity_key = ?`,
      continuityKey,
    );
    return row
      ? {
          continuityKey: String(row.continuity_key),
          instanceId: String(row.instance_id),
          uid: String(row.uid),
          updatedAt: Number(row.updated_at),
        }
      : undefined;
  }

  private pinReceiptBinding(
    envelope: FlueDispatchEnvelopeV1,
    receipt: FlueDispatchReceiptV1,
  ): void {
    if (typeof envelope.uid === 'string' && receipt.uid !== envelope.uid) {
      throw new Error('Flue continued a different agent incarnation.');
    }
    const plan = envelope.initialData ?? this.getFrozenRuntimePlan(envelope.idempotencyKey)?.runtimePlan;
    if (!plan) throw new Error('RuntimePlanV2 is unavailable for Flue binding.');
    this.pinAgentBinding(
      {
        continuityKey: plan.conversation.continuityKey,
        instanceId: envelope.instanceId,
        uid: receipt.uid,
        updatedAt: this.now(),
      },
      envelope.previousBinding,
    );
  }

  hasPending(executionAuthority: RunExecutionAuthority = 'legacy'): boolean {
    return this.db.get(
      `SELECT 1 AS pending FROM turn_jobs
       WHERE delivered = 0 AND status != 'recovery_required' AND execution_authority = ? LIMIT 1`,
      executionAuthority,
    ) !== undefined;
  }

  runtimeDrainCounts(): SlackRuntimeDrainCounts {
    const pending = (executionAuthority: RunExecutionAuthority): number => Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM turn_jobs
         WHERE delivered = 0 AND execution_authority = ?`,
        executionAuthority,
      )?.count ?? 0,
    );
    return {
      pendingLegacyTurnJobs: pending('legacy'),
      pendingLedgerTurnJobs: pending('ledger'),
      pendingSlackInteractionCleanups: Number(
        this.db.get(
          `SELECT COUNT(*) AS count FROM turn_jobs
           WHERE delivered = 1 AND progress_json LIKE '%"cleanup":"pending"%'`,
        )?.count ?? 0,
      ),
      recoveryRequiredTurnJobs: Number(
        this.db.get(
          `SELECT COUNT(*) AS count FROM turn_jobs
           WHERE delivered = 0 AND status = 'recovery_required'`,
        )?.count ?? 0,
      ),
    };
  }

  listRecoveryRequired(limit = 50): SlackTurnRecoveryItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Turn recovery limit must be between 1 and 100.');
    }
    return this.db.all(
      `SELECT id, execution_authority, recovery_reason, enqueued_at
       FROM turn_jobs
       WHERE delivered = 0 AND status = 'recovery_required'
       ORDER BY enqueued_at ASC, id ASC LIMIT ?`,
      limit,
    ).map((row) => ({
      id: String(row.id),
      executionAuthority: row.execution_authority as 'legacy' | 'ledger',
      reason: String(row.recovery_reason ?? 'operator_reconciliation_required'),
      enqueuedAt: Number(row.enqueued_at),
    }));
  }

  /**
   * Re-open only compatibility turns whose operator-recovery condition was the
   * workspace Slack installation becoming unavailable. Reconnect proves fresh
   * credentials before calling this method; immutable dispatch/settlement
   * checkpoints and the attempt counter stay intact so the relay reattaches
   * instead of paying for a second model run. Ledger-owned turns keep their
   * Work recovery boundary until a coordinated Run + Turn recovery API exists.
   */
  retrySlackInstallationRecovery(workspaceId: string): number {
    validateBoundedString(workspaceId, 'Slack workspace id', 160);
    return this.db.run(
      `UPDATE turn_jobs
       SET status = 'pending', recovery_reason = NULL
       WHERE delivered = 0
         AND status = 'recovery_required'
         AND recovery_reason = 'slack_installation_unavailable'
         AND execution_authority = 'legacy'
         AND json_extract(turn_json, '$.workspaceId') = ?`,
      workspaceId,
    ).changes;
  }

  /** Explicit operator terminalization; retained claims continue to dedupe. */
  resolveRecoveryRequired(id: string): boolean {
    validateBoundedString(id, 'TurnJob id', 200);
    return this.db.transaction(() => {
      const current = this.db.get(
        `SELECT 1 AS present FROM turn_jobs
         WHERE id = ? AND delivered = 0 AND status = 'recovery_required'`,
        id,
      );
      if (!current) return false;
      this.recordTerminalStatus(id, 'error');
      return this.db.run(
        `UPDATE turn_jobs SET delivered = 1, status = 'error'
         WHERE id = ? AND delivered = 0 AND status = 'recovery_required'`,
        id,
      ).changes === 1;
    });
  }

  /** Record that an attempt is being made (before running the turn). */
  recordAttempt(id: string, attempts: number): void {
    this.db.run('UPDATE turn_jobs SET attempts = ? WHERE id = ?', attempts, id);
  }

  getProgress(id: string): TurnProgress | undefined {
    const row = this.db.get('SELECT progress_json FROM turn_jobs WHERE id = ?', id) as
      | { progress_json: string }
      | undefined;
    return row ? parseTurnProgress(row.progress_json) : undefined;
  }

  /**
   * Preserve the first successful PR marker. A retry or duplicate API response
   * may report the same operation again, but it must never replace the durable
   * result that the next alarm attempt will replay.
   */
  recordPullRequest(
    id: string,
    pullRequest: TurnPullRequestProgress,
  ): TurnProgress | undefined {
    return this.db.transaction(() => {
      const current = this.getProgress(id);
      if (!current || current.pullRequest) return current;
      const progress: TurnProgress = { ...current, pullRequest };
      this.db.run(
        'UPDATE turn_jobs SET progress_json = ? WHERE id = ?',
        JSON.stringify(progress),
        id,
      );
      return progress;
    });
  }

  /** Durable denominator state for fail-open usage persistence. */
  recordUsagePersistence(id: string, event: UsagePersistenceEvent): TurnProgress | undefined {
    return this.db.transaction(() => {
      const current = this.getProgress(id);
      if (!current) return undefined;
      const usageTelemetry = {
        ...(current.usageTelemetry?.executionId === event.executionId
          ? current.usageTelemetry
          : { executionId: event.executionId }),
        [event.phase]: event.outcome,
      };
      const progress: TurnProgress = { ...current, usageTelemetry };
      this.db.run(
        'UPDATE turn_jobs SET progress_json = ? WHERE id = ?',
        JSON.stringify(progress),
        id,
      );
      return progress;
    });
  }

  /** Persist the first validated interaction decision so relay retries never
   * reclassify a guaranteed turn or repeat classifier usage. */
  recordInteractionIntent(
    id: string,
    intent: SlackInteractionIntent,
  ): TurnProgress | undefined {
    return this.db.transaction(() => {
      const current = this.getProgress(id);
      if (!current || current.interactionIntent) return current;
      const progress: TurnProgress = { ...current, interactionIntent: intent };
      this.db.run(
        'UPDATE turn_jobs SET progress_json = ? WHERE id = ?',
        JSON.stringify(progress),
        id,
      );
      return progress;
    });
  }

  /** Merge adapter progress so a relay retry reuses the same Slack artifacts
   * and post-delivery cleanup remains recoverable after the job tombstone. */
  recordSlackInteractionProgress(
    id: string,
    patch: SlackInteractionProgressPatch,
  ): TurnProgress | undefined {
    return this.db.transaction(() => {
      const current = this.getProgress(id);
      if (!current) return undefined;
      const slackInteraction = {
        ...current.slackInteraction,
        ...(patch.acknowledgment
          ? {
              acknowledgment: {
                ...current.slackInteraction?.acknowledgment,
                ...patch.acknowledgment,
              },
            }
          : {}),
        ...(patch.checklist
          ? {
              checklist: {
                ...current.slackInteraction?.checklist,
                ...patch.checklist,
              },
            }
          : {}),
      };
      const progress: TurnProgress = { ...current, slackInteraction };
      this.db.run(
        'UPDATE turn_jobs SET progress_json = ? WHERE id = ?',
        JSON.stringify(progress),
        id,
      );
      return progress;
    });
  }

  /** Delivered rows can still own lightweight Slack cleanup. They are never
   * eligible for answer redelivery, only idempotent checklist/reaction repair. */
  listPendingSlackInteractionCleanups(limit = 100): PendingTurnJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Slack interaction cleanup limit must be between 1 and 100.');
    }
    const rows = this.db.all(
      `SELECT ${TURN_JOB_SELECT_COLUMNS}
       FROM turn_jobs
       WHERE delivered = 1 AND progress_json LIKE '%\"cleanup\":\"pending\"%'
       ORDER BY enqueued_at LIMIT ?`,
      limit,
    ) as unknown as TurnJobRow[];
    return rows.map((row) => this.decodeRow(row));
  }

  hasPendingSlackInteractionCleanup(): boolean {
    return this.db.get(
      `SELECT 1 AS pending FROM turn_jobs
       WHERE delivered = 1 AND progress_json LIKE '%\"cleanup\":\"pending\"%'
       LIMIT 1`,
    ) !== undefined;
  }

  /** Tombstone a delivered job so no later scan re-delivers it. */
  markDelivered(id: string): void {
    this.recordTerminalStatus(id, 'success');
    this.db.run("UPDATE turn_jobs SET delivered = 1, status = 'done' WHERE id = ?", id);
  }

  /** Tombstone a job that exhausted its attempts (terminal failure). */
  markError(id: string): void {
    this.recordTerminalStatus(id, 'error');
    this.db.run("UPDATE turn_jobs SET delivered = 1, status = 'error' WHERE id = ?", id);
  }

  /** Only a never-dispatched row may be physically discarded for redrive. */
  discard(id: string): boolean {
    const deleted = this.db.run(
      'DELETE FROM turn_jobs WHERE id = ? AND dispatch_started_at IS NULL',
      id,
    );
    if (deleted.changes === 1) return true;
    this.markRecoveryRequired(id, 'post_dispatch_redrive_required');
    return false;
  }

  private purgeExpired(): void {
    const now = this.now();
    const backedOff = this.db.run(
      `UPDATE turn_jobs
       SET status = 'recovery_required', recovery_reason = 'nonterminal_retention_backstop'
       WHERE delivered = 0 AND enqueued_at < ? AND status != 'recovery_required'`,
      now - TURN_JOB_RECOVERY_BACKSTOP_MS,
    );
    if (backedOff.changes > 0) {
      console.error(
        `[chickpea] ${backedOff.changes} stale TurnJob(s) require operator reconciliation`,
      );
    }
    this.db.run(
      `DELETE FROM turn_jobs
       WHERE delivered = 1 AND enqueued_at < ?
         AND progress_json NOT LIKE '%"cleanup":"pending"%'`,
      now - TURN_JOB_TTL_MS,
    );
    this.db.run(
      'DELETE FROM slack_agent_bindings WHERE updated_at < ?',
      now - SLACK_AGENT_BINDING_TTL_MS,
    );
  }

  private recordTerminalStatus(id: string, terminal: 'success' | 'error'): void {
    const current = this.getProgress(id);
    const checklist = current?.slackInteraction?.checklist;
    if (!current || !checklist) return;
    this.recordSlackInteractionProgress(id, {
      checklist: { ...checklist, terminal },
    });
  }

  private decodeRow(row: TurnJobRow): PendingTurnJob {
    const turn = JSON.parse(row.turn_json) as NormalizedSlackTurn;
    const assignment = JSON.parse(row.assignment_json) as ResolvedAssignment;
    return {
      id: row.id,
      evtKey: row.evt_key,
      msgKey: row.msg_key,
      turn,
      assignment,
      ...(row.run_id ? { runId: row.run_id } : {}),
      executionAuthority: row.execution_authority,
      attempts: Number(row.attempts),
      progress: parseTurnProgress(row.progress_json),
      ...(row.runtime_plan_json
        ? { runtimePlan: parseRuntimePlanV2(JSON.parse(row.runtime_plan_json)) }
        : {}),
      ...(row.agent_instance_id ? { agentInstanceId: row.agent_instance_id } : {}),
      ...(row.dispatch_envelope_json
        ? { dispatchEnvelope: parseFlueDispatchEnvelope(JSON.parse(row.dispatch_envelope_json)) }
        : {}),
      ...(row.dispatch_receipt_json
        ? { dispatchReceipt: parseFlueDispatchReceipt(JSON.parse(row.dispatch_receipt_json)) }
        : {}),
      ...(row.flue_settlement_json
        ? { flueSettlement: parseFlueSettlement(JSON.parse(row.flue_settlement_json)) }
        : {}),
      ...(row.dispatch_started_at === null || row.dispatch_started_at === undefined
        ? {}
        : { dispatchStartedAt: Number(row.dispatch_started_at) }),
      ...(row.recovery_reason ? { recoveryReason: row.recovery_reason } : {}),
    };
  }
}

function parseFlueDispatchEnvelope(value: unknown): FlueDispatchEnvelopeV1 {
  const record = exactObject(value, 'Flue dispatch envelope', [
    'schemaVersion',
    'agentName',
    'instanceId',
    'uid',
    'message',
    'initialData',
    'idempotencyKey',
    'previousBinding',
  ]);
  if ((record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
      record.agentName !== 'chickpea-slack-v2') {
    throw new Error('Flue dispatch envelope version or agent is invalid.');
  }
  const instanceId = validateOpaqueAgentId(record.instanceId, 'instance id');
  const uid = record.uid === null ? null : validateFlueInstanceUid(record.uid);
  const body = parseDispatchMessageBody(record.message, record.schemaVersion);
  const idempotencyKey = validateBoundedString(record.idempotencyKey, 'idempotency key', 256);
  const initialData = record.initialData === undefined
    ? undefined
    : parseRuntimePlanV2(record.initialData);
  if (uid === null && !initialData) {
    throw new Error('Create-only Flue dispatch requires initial data.');
  }
  if (uid !== null && initialData) {
    throw new Error('Continued Flue dispatch cannot reseed initial data.');
  }
  if (initialData && deriveRuntimePlanInstanceId(initialData) !== instanceId) {
    throw new Error('Flue dispatch target does not match its RuntimePlanV2.');
  }
  const previousBinding = record.previousBinding === undefined
    ? undefined
    : parseBindingExpectation(record.previousBinding);
  if (record.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      agentName: 'chickpea-slack-v2',
      instanceId,
      uid,
      message: { kind: 'user', body },
      ...(initialData ? { initialData } : {}),
      idempotencyKey,
      ...(previousBinding ? { previousBinding } : {}),
    };
  }
  const message = parseSlackSignalMessage(record.message, body, idempotencyKey, initialData);
  return {
    schemaVersion: 2,
    agentName: 'chickpea-slack-v2',
    instanceId,
    uid,
    message,
    ...(initialData ? { initialData } : {}),
    idempotencyKey,
    ...(previousBinding ? { previousBinding } : {}),
  };
}

function parseDispatchMessageBody(value: unknown, schemaVersion: 1 | 2): string {
  const keys = schemaVersion === 1
    ? ['kind', 'body']
    : ['kind', 'type', 'body', 'tagName', 'attributes'];
  const message = exactObject(value, 'Flue dispatch message', keys);
  if (schemaVersion === 1 && message.kind !== 'user') {
    throw new Error('Flue dispatch message kind is invalid.');
  }
  if (schemaVersion === 2 && message.kind !== 'signal') {
    throw new Error('Flue dispatch message kind is invalid.');
  }
  return validateBoundedString(message.body, 'dispatch message body', 1_000_000);
}

function parseSlackSignalMessage(
  value: unknown,
  body: string,
  idempotencyKey: string,
  initialData?: RuntimePlanV2,
): Extract<FlueDispatchEnvelopeV1, { schemaVersion: 2 }>['message'] {
  const message = exactObject(value, 'Flue dispatch message', [
    'kind', 'type', 'body', 'tagName', 'attributes',
  ]);
  if (message.kind !== 'signal' || message.type !== 'slack.message' ||
      message.tagName !== 'slack_message') {
    throw new Error('Flue Slack signal metadata is invalid.');
  }
  const attributes = exactObject(message.attributes, 'Flue Slack signal attributes', [
    'workspaceId', 'channelId', 'threadTs', 'slackUserId', 'eventId', 'messageTs', 'turnJobId',
  ]);
  const parsed = {
    workspaceId: validateBoundedString(attributes.workspaceId, 'Slack workspace id', 128),
    channelId: validateBoundedString(attributes.channelId, 'Slack channel id', 128),
    threadTs: validateBoundedString(attributes.threadTs, 'Slack thread timestamp', 80),
    slackUserId: validateBoundedString(attributes.slackUserId, 'Slack user id', 128),
    eventId: validateBoundedString(attributes.eventId, 'Slack event id', 256),
    messageTs: validateBoundedString(attributes.messageTs, 'Slack message timestamp', 80),
    turnJobId: validateBoundedString(attributes.turnJobId, 'TurnJob id', 256),
  };
  if (parsed.turnJobId !== idempotencyKey) {
    throw new Error('Flue Slack signal does not match its TurnJob.');
  }
  if (initialData && (
    parsed.workspaceId !== initialData.conversation.workspaceId ||
    parsed.channelId !== initialData.conversation.channelId ||
    parsed.threadTs !== initialData.conversation.threadTs
  )) {
    throw new Error('Flue Slack signal does not match its RuntimePlanV2.');
  }
  return {
    kind: 'signal',
    type: 'slack.message',
    body,
    tagName: 'slack_message',
    attributes: parsed,
  };
}

function parseFlueDispatchReceipt(value: unknown): FlueDispatchReceiptV1 {
  const record = exactObject(value, 'Flue dispatch receipt', [
    'submissionId',
    'acceptedAt',
    'uid',
    'deduplicated',
  ]);
  if (record.deduplicated !== undefined && record.deduplicated !== true) {
    throw new Error('Flue dispatch receipt deduplicated flag is invalid.');
  }
  const acceptedAt = validateBoundedString(record.acceptedAt, 'accepted at', 80);
  if (!Number.isFinite(Date.parse(acceptedAt))) {
    throw new Error('Flue dispatch receipt accepted time is invalid.');
  }
  return {
    submissionId: validateBoundedString(record.submissionId, 'submission id', 200),
    acceptedAt,
    uid: validateFlueInstanceUid(record.uid),
    ...(record.deduplicated === true ? { deduplicated: true } : {}),
  };
}

function parseFlueSettlement(value: unknown): FlueSettlementCheckpointV1 {
  const record = exactObject(value, 'Flue settlement', [
    'outcome',
    'settledAt',
    'result',
    'failureKind',
    // Read compatibility for the bounded diagnostic briefly written by the
    // disposable authoring investigation. New checkpoints never write it.
    'debugDiagnostic',
  ]);
  const settledAt = Number(record.settledAt);
  if (!Number.isSafeInteger(settledAt) || settledAt < 0) {
    throw new Error('Flue settlement time is invalid.');
  }
  if (record.outcome === 'failed' || record.outcome === 'aborted') {
    const failureKind = oneOf(record.failureKind, FLUE_FAILURE_KINDS, 'failure kind');
    if (record.result !== undefined) throw new Error('Failed Flue settlement cannot carry a result.');
    if (record.debugDiagnostic !== undefined) {
      validateBoundedString(record.debugDiagnostic, 'legacy failure diagnostic', 2_000);
    }
    return {
      outcome: record.outcome,
      settledAt,
      failureKind,
    };
  }
  if (record.outcome !== 'completed' || record.failureKind !== undefined ||
      record.debugDiagnostic !== undefined) {
    throw new Error('Flue settlement outcome is invalid.');
  }
  return {
    outcome: 'completed',
    settledAt,
    result: parseSettledResult(record.result),
  };
}

const FLUE_FAILURE_KINDS = [
  'agent',
  'provider',
  'openai-subscription-reconnect',
  'openai-subscription-quota',
  'openai-subscription-policy',
  'sandbox',
  'sandbox-session-cap',
] as const;

function parseSettledResult(value: unknown): Extract<FlueSettlementCheckpointV1, {
  outcome: 'completed';
}>['result'] {
  const record = exactObject(value, 'Flue settled result', [
    'text',
    'requestedModel',
    'returnedModel',
    'reportedUsage',
    'usageCompleteness',
    'flueSubmissionRef',
  ]);
  const text = validateBoundedString(record.text, 'settled result text', 1_000_000);
  const requestedModel = record.requestedModel === null
    ? null
    : validateBoundedString(record.requestedModel, 'requested model', 240);
  const returnedModel = record.returnedModel === null
    ? null
    : (() => {
        const model = exactObject(record.returnedModel, 'returned model', ['provider', 'id']);
        return {
          provider: validateBoundedString(model.provider, 'returned provider', 120),
          id: validateBoundedString(model.id, 'returned model id', 240),
        };
      })();
  const reportedUsage = record.reportedUsage === null
    ? null
    : (() => {
        const usage = exactObject(record.reportedUsage, 'reported usage', [
          'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens',
        ]);
        return {
          inputTokens: nullableTokenCount(usage.inputTokens),
          outputTokens: nullableTokenCount(usage.outputTokens),
          ...(usage.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: nullableTokenCount(usage.cacheReadTokens) }),
          ...(usage.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: nullableTokenCount(usage.cacheWriteTokens) }),
          totalTokens: nullableTokenCount(usage.totalTokens),
        };
      })();
  const usageCompleteness = oneOf(
    record.usageCompleteness,
    ['complete', 'partial', 'not_reported'] as const,
    'usage completeness',
  );
  const flueSubmissionRef = record.flueSubmissionRef === undefined || record.flueSubmissionRef === null
    ? record.flueSubmissionRef
    : validateBoundedString(record.flueSubmissionRef, 'Flue submission ref', 200);
  return {
    text,
    requestedModel,
    returnedModel,
    reportedUsage,
    usageCompleteness,
    ...(flueSubmissionRef === undefined ? {} : { flueSubmissionRef }),
  };
}

function parseFlueObservation(value: unknown): FlueTurnObservationV1 {
  const record = exactObject(value, 'Flue observation target', [
    'generation', 'workCorrelation', 'harnessRevision', 'configurationRevision',
  ]);
  const generation = validateBoundedString(record.generation, 'observation generation', 256);
  const workCorrelation = record.workCorrelation === undefined
    ? undefined
    : (() => {
        const correlation = exactObject(record.workCorrelation, 'work correlation', [
          'runId', 'runExecutionId', 'mode',
        ]);
        const runId = validateWorkCorrelationId(correlation.runId, 'run id');
        const runExecutionId = validateWorkCorrelationId(correlation.runExecutionId, 'execution id');
        if (correlation.mode !== 'observe' && correlation.mode !== 'enforce') {
          throw new Error('Work correlation mode is invalid.');
        }
        const mode: 'observe' | 'enforce' = correlation.mode;
        return { runId, runExecutionId, mode };
      })();
  const harnessRevision = record.harnessRevision === undefined
    ? undefined
    : validateSha256(record.harnessRevision, 'harness revision');
  const configurationRevision = record.configurationRevision === undefined
    ? undefined
    : (() => {
        const revision = exactObject(record.configurationRevision, 'configuration revision', [
          'agent', 'channel',
        ]);
        const agent = validatePositiveInteger(revision.agent, 'Agent revision');
        const channel = revision.channel === undefined
          ? undefined
          : validatePositiveInteger(revision.channel, 'Channel revision');
        return { agent, ...(channel ? { channel } : {}) };
      })();
  return {
    generation,
    ...(workCorrelation ? { workCorrelation } : {}),
    ...(harnessRevision ? { harnessRevision } : {}),
    ...(configurationRevision ? { configurationRevision } : {}),
  };
}

function validateSha256(value: unknown, label: string): string {
  const parsed = validateBoundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function validatePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function validateFlueObservation(value: FlueTurnObservationV1): void {
  parseFlueObservation(value);
}

function parseBindingExpectation(value: unknown): SlackAgentBindingExpectation {
  const record = exactObject(value, 'binding expectation', ['instanceId', 'uid']);
  return {
    instanceId: validateOpaqueAgentId(record.instanceId, 'expected instance id'),
    uid: validateFlueInstanceUid(record.uid),
  };
}

function exactObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (extra) throw new Error(`${label} has unknown field ${extra}.`);
  return record;
}

function validateBoundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`Flue ${label} is invalid.`);
  }
  return value;
}

function validateWorkCorrelationId(value: unknown, label: string): string {
  const parsed = validateBoundedString(value, label, 128);
  if (!/^[a-z][a-z0-9_-]{7,127}$/.test(parsed)) {
    throw new Error(`Flue ${label} is invalid.`);
  }
  return parsed;
}

function nullableTokenCount(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Flue reported usage is invalid.');
  }
  return Number(value);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Flue ${label} is invalid.`);
  }
  return value as T[number];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateAgentBinding(input: SlackAgentBinding): void {
  validateOpaqueAgentId(input.continuityKey, 'continuity key');
  validateOpaqueAgentId(input.instanceId, 'instance id');
  validateFlueInstanceUid(input.uid);
  if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
    throw new Error('Slack agent binding update time is invalid.');
  }
}

function validateAgentBindingExpectation(input: SlackAgentBindingExpectation): void {
  validateOpaqueAgentId(input.instanceId, 'expected instance id');
  validateFlueInstanceUid(input.uid);
}

function validateOpaqueAgentId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^agent_[a-f0-9]{40}$/.test(value)) {
    throw new Error(`Slack agent ${label} is invalid.`);
  }
  return value;
}

function validateFlueInstanceUid(value: unknown): string {
  if (typeof value !== 'string' || !/^inst_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw new Error('Slack agent binding uid is invalid.');
  }
  return value;
}

export function replayTextForTurnProgress(progress: TurnProgress): string | undefined {
  const pullRequest = progress.pullRequest;
  if (!pullRequest) return undefined;
  return `Pull request #${pullRequest.number} is already open: ${pullRequest.url}`;
}

function parseTurnProgress(raw: string): TurnProgress {
  try {
    const parsed = JSON.parse(raw) as TurnProgress;
    const progress: TurnProgress = {};
    if (
      parsed?.interactionIntent &&
      typeof parsed.interactionIntent === 'object' &&
      typeof parsed.interactionIntent.disposition === 'string'
    ) {
      progress.interactionIntent = structuredClone(parsed.interactionIntent);
    }
    const slackInteraction = parsed?.slackInteraction;
    if (slackInteraction && typeof slackInteraction === 'object') {
      const acknowledgment = slackInteraction.acknowledgment;
      const checklist = slackInteraction.checklist;
      progress.slackInteraction = {
        ...(isValidAcknowledgmentProgress(acknowledgment)
          ? { acknowledgment: { ...acknowledgment } }
          : {}),
        ...(isValidChecklistProgress(checklist)
          ? { checklist: { ...checklist } }
          : {}),
      };
    }
    const pullRequest = parsed?.pullRequest;
    if (
      pullRequest &&
      Number.isSafeInteger(pullRequest.number) &&
      pullRequest.number > 0 &&
      typeof pullRequest.url === 'string' &&
      typeof pullRequest.repository === 'string' &&
      (pullRequest.branch === undefined || typeof pullRequest.branch === 'string')
    ) {
      progress.pullRequest = { ...pullRequest };
    }
    const usage = parsed?.usageTelemetry;
    if (
      usage &&
      typeof usage.executionId === 'string' &&
      ['admission', 'terminal', 'repair'].every((phase) => {
        const outcome = usage[phase as keyof Omit<typeof usage, 'executionId'>];
        return outcome === undefined ||
          outcome === 'recorded' || outcome === 'timed_out' || outcome === 'failed';
      })
    ) {
      progress.usageTelemetry = { ...usage };
    }
    return progress;
  } catch {
    // Malformed progress is treated as absent so it can never suppress work.
  }
  return {};
}


function isValidAcknowledgmentProgress(
  value: unknown,
): value is NonNullable<NonNullable<TurnProgress['slackInteraction']>['acknowledgment']> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.channelId === 'string' &&
    typeof candidate.messageTs === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.created === 'boolean' &&
    (candidate.cleanup === 'pending' || candidate.cleanup === 'done');
}

function isValidChecklistProgress(
  value: unknown,
): value is NonNullable<NonNullable<TurnProgress['slackInteraction']>['checklist']> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.channelId === 'string' &&
    typeof candidate.threadTs === 'string' &&
    typeof candidate.messageTs === 'string' &&
    (candidate.cleanup === 'pending' || candidate.cleanup === 'done') &&
    (candidate.terminal === undefined ||
      candidate.terminal === 'success' || candidate.terminal === 'error');
}
