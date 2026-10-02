import { parseSlackMemoryUpdate } from './memory-update-terminal.ts';
import type {
  SlackInteractionProgressPatch,
  TurnProgress,
  TurnPullRequestProgress,
} from '../config/state-rpc.ts';
import {
  deriveRuntimePlanInstanceId,
  isRuntimePlanInstanceId,
  parseRuntimePlanV2,
  runtimePlanInstanceIdMatches,
  type AdmittedRuntimePlanData,
  type RuntimePlanV2,
} from '../agents/runtime-plan.ts';
import { parseSlackTurnInput } from '../agents/turn-input.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
  FlueObservationTarget,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
  FrozenRuntimePlanDecision,
  SlackAgentBinding,
  SlackAgentBindingExpectation,
  SlackThreadContinuation,
  TurnJob,
  TurnPreviousStop,
  TurnRunRoute,
  TurnSteeringDecision,
  TurnSteeringRequest,
  TurnStopFinish,
  TurnStopHeadRecordV1,
  TurnStopMemberRecordV1,
  TurnStopNotice,
  TurnStopRecordV1,
  TurnStopResult,
} from './turn-job-types.ts';
import { parseSlackTablePresentations } from './table-presentation.ts';
import { parseCodingWorkerUsage } from './coding-worker-run.ts';
import { parseSlackArtifactReceipts } from './artifact-receipts.ts';
import { parseSlackAgentCreationTerminalIntents } from './agent-creation-terminal.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { schemaInstallRequired, type StateDb } from '../state/state-db.ts';
import type { InstallationObjectRecorder } from '../state/object-inventory.ts';
import type { SlackThreadAgentTarget } from './flue-dispatch.ts';
import type { SlackRuntimeDrainCounts } from '../config/state-rpc.ts';
import type { SlackTurnRecoveryItem } from '../config/state-rpc.ts';
import type { RunExecutionAuthority } from '../work/types.ts';
import { CLAIM_TTL_MS } from './state-limits.ts';
import { validSlackTs, type NormalizedSlackTurn } from './types.ts';
import type { UsagePersistenceEvent } from '../usage/runtime-recorder.ts';
import type { SlackInteractionIntent } from './interaction-intent.ts';
import { conversationThreadTs, slackAgentThreadKey, slackConversationKind } from './thread-key.ts';
import { runtimePlanGuestSandboxKey } from '../sandbox/thread-key.ts';
import {
  MAX_THREAD_IMAGES_ATTRIBUTE_CHARS,
  parseThreadImageRecords,
  serializeThreadImageRecords,
  type ThreadImageRecord,
} from './thread-images.ts';
import { parseAdmittedSlackListIds, serializeAdmittedSlackListIds } from './lists/admission.ts';
import { renderSlackMarkdownActionLink, slackActionLink } from './message-format.ts';
import { parseTurnEnvelope, type TurnEnvelopeV1 } from '../agents/turn-envelope.ts';

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

/**
 * A row a stop holds, or a stopped row that never dispatched, is looked at
 * again this often: the stopped ending drops or releases it within seconds.
 */
export const TURN_STOP_HOLD_RETRY_MS = 5_000;
/** Stop notices are retried after 1 s, doubling to every 30 s, until acknowledged. */
const STOP_NOTICE_RETRY_MS = 1_000;
const STOP_NOTICE_RETRY_MAX_MS = 30_000;
const STOP_NOTICE_BATCH = 16;

const TURN_JOB_STOP_REFUSAL_MESSAGE = 'TurnJob dispatch refused: its run was stopped.';

/**
 * Dispatch preparation refused a stopped row or a row a stop holds. Over the
 * state store's RPC it arrives as a plain Error with this fixed, content-free
 * message (see isTurnJobStopRefusal).
 */
export class TurnJobStopRefusal extends Error {
  constructor() {
    super(TURN_JOB_STOP_REFUSAL_MESSAGE);
    this.name = 'TurnJobStopRefusal';
  }
}

export function isTurnJobStopRefusal(error: unknown): boolean {
  return error instanceof TurnJobStopRefusal ||
    (error instanceof Error && error.message === TURN_JOB_STOP_REFUSAL_MESSAGE);
}

/**
 * The Slack conversation a stop or check-in addresses (`turn_jobs.thread_key`):
 * the runner's thread key without its owner incarnation, so a handoff mid-run
 * does not hide the running turn, and a legacy installation's DM session key.
 */
export function turnStopThreadKey(
  turn: Pick<NormalizedSlackTurn, 'workspaceId' | 'channelId' | 'threadTs' | 'sessionThreadTs'>,
  assignment: Pick<ResolvedAssignment, 'runtimeContract'>,
): string {
  return `${turn.workspaceId}:${turn.channelId}:${conversationThreadTs(turn, assignment.runtimeContract)}`;
}

/**
 * What a row's stop record allows now. `hold`: it waits for the stopped
 * ending and never runs. `stopped_before_dispatch`: a stopped row with no
 * Flue receipt, which must never dispatch. `stopped`: a dispatched stopped
 * row, which reattaches to read its aborted settlement. `run`: an ordinary turn.
 */
export function turnJobStopGate(
  job: Pick<PendingTurnJob, 'stop' | 'dispatchReceipt'>,
): 'run' | 'hold' | 'stopped_before_dispatch' | 'stopped' {
  if (job.stop?.role === 'held') return 'hold';
  if (job.stop?.role !== 'stopped') return 'run';
  return job.dispatchReceipt ? 'stopped' : 'stopped_before_dispatch';
}

/** The turn row an OAuth continuation resumes as (idempotent per continuation). */
export function oauthResumeTurnJobId(continuationId: string): string {
  return `oauthresume:${continuationId}`;
}

// Terminal rows need only outlive Slack's redelivery horizon. Nonterminal rows
// and their claims are retained until explicitly resolved and terminalized.
export const TURN_JOB_TTL_MS = CLAIM_TTL_MS;
const SLACK_AGENT_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const TURN_JOB_RECOVERY_BACKSTOP_MS = SLACK_AGENT_BINDING_TTL_MS;

// Recovery reasons are operator telemetry, so keep this roster closed. Callers
// may supply a bounded string through an RPC, but logs must never echo an
// unreviewed value that could contain request or tenant data.
const LOGGABLE_TURN_RECOVERY_REASONS = new Set([
  'flue_binding_reconciliation_required',
  'flue_dispatch_payload_conflict',
  'flue_dispatch_reconciliation_required',
  'flue_existing_instance_reconciliation_conflict',
  'flue_expected_instance_missing',
  'flue_receipt_conflict',
  'flue_settlement_conflict',
  'flue_unexpected_existing_instance',
  'operator_cancelled',
  'post_dispatch_attempts_exhausted',
  'post_dispatch_redrive_required',
  'slack_file_fallback_unavailable',
  'slack_installation_unavailable',
  'slack_presentation_effect_unresolved',
  'stored_turn_unreadable',
]);

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
  /** Durable admission time; the turn latency log measures from here. */
  enqueuedAt?: number;
  /**
   * When the event reached this deployment: the gateway inbox acceptance time
   * for a gateway delivery, otherwise the admission time. Null on older rows.
   */
  receivedAt?: number;
  /** Present only when a per-thread runner owns the row (see TurnJobExecutor). */
  executor?: 'runner';
  /** The runner has not yet confirmed admitting this row. */
  handoff?: true;
  /**
   * The row's stop record (see turnJobStopGate). A hold whose stop no longer
   * holds anything (its head settled, an older release delivered it) reads
   * as released.
   */
  stop?: TurnStopRecordV1;
  /**
   * The thread's previous run was stopped (see previousThreadStop). Read only
   * for a row whose dispatch has not started, the one prompt it can reach.
   */
  previousStop?: TurnPreviousStop;
}

/**
 * Which Cloudflare component executes a pending row: the shared state
 * store's alarm, or the thread's SlackThreadRunner once dispatched there.
 * Rows are admitted as `alarm`; only the alarm's dispatch changes it. In the
 * `executor` column a runner row is `handoff` until its runner confirms the
 * admission, then `runner`.
 */
export type TurnJobExecutor = 'alarm' | 'runner';

/** A turn row as its runner reads it before (re)attaching. */
export interface RunnerTurnJobView {
  status: 'pending' | 'done' | 'error' | 'recovery_required' | 'missing';
  executor?: TurnJobExecutor;
  /** The decoded row with its durable checkpoints, while it is pending. */
  job?: PendingTurnJob;
  /** Delivered, with Slack interaction cleanup still to do (`job` is then set). */
  cleanupPending?: boolean;
}

export interface SlackProposalApprovalQuery {
  proposalId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterUserId: string;
  requesterMembershipId: string;
  actingAgentId: string;
}

/** Content-free retained approval coordinates, including completed turns. */
export interface SlackProposalApprovalTurn extends SlackProposalApprovalQuery {
  turnJobId: string;
  runId: string | null;
  messageTs: string;
  status: string;
  delivered: boolean;
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
  enqueued_at?: number | null;
  received_at?: number | null;
  executor?: string | null;
  stop_json?: string | null;
}

const TURN_JOB_SELECT_COLUMNS = `id, evt_key, msg_key, turn_json, assignment_json, run_id,
  execution_authority, attempts, progress_json, runtime_plan_json,
  agent_instance_id, dispatch_envelope_json,
  dispatch_receipt_json, flue_settlement_json, dispatch_started_at,
  submission_id, observation_json, recovery_reason, enqueued_at, received_at, executor,
  stop_json`;

const PENDING_ROW = "delivered = 0 AND status != 'recovery_required'";

/** One undelivered row of a thread, as a stop or check-in weighs it. */
interface StopThreadRow {
  id: string;
  messageTs?: string;
  stop?: TurnStopRecordV1;
  dispatched: boolean;
  enqueuedAt: number;
  order: number;
}

export class TurnJobStoreLogic {
  /** Receipt times of gateway deliveries being turned into jobs, by event ID. */
  private readonly receiptTimes = new Map<string, number>();

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
    /**
     * Where a store serving one installation of many records the objects its
     * turns address (state/object-inventory.ts): a thread's runner when the
     * turn is enqueued, its Flue instance when the plan is frozen.
     */
    private readonly objects?: InstallationObjectRecorder,
  ) {
    if (!schemaInstallRequired(db)) return;
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
        turn_envelope_json TEXT,
        dispatch_receipt_json TEXT,
        flue_settlement_json TEXT,
        dispatch_started_at INTEGER,
        submission_id TEXT,
        observation_json TEXT,
        recovery_reason TEXT,
        enqueued_at INTEGER NOT NULL,
        received_at INTEGER,
        executor TEXT NOT NULL DEFAULT 'alarm',
        thread_key TEXT,
        message_ts TEXT,
        stop_json TEXT,
        stop_notice_at INTEGER,
        stop_notice_attempts INTEGER NOT NULL DEFAULT 0
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
    if (!columns.some((column) => column.name === 'turn_envelope_json')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN turn_envelope_json TEXT');
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
    if (!columns.some((column) => column.name === 'received_at')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN received_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'executor')) {
      db.exec("ALTER TABLE turn_jobs ADD COLUMN executor TEXT NOT NULL DEFAULT 'alarm'");
    }
    // Stop records (KTD2). A thread's rows could only be found by decoding
    // every pending row's JSON; the conversation key and message timestamp
    // are now written at enqueue, and undelivered rows are backfilled here.
    // A row an older release writes later has none: stop lookups decode and
    // key those few (see threadRows).
    let threadColumnsAdded = false;
    if (!columns.some((column) => column.name === 'thread_key')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN thread_key TEXT');
      threadColumnsAdded = true;
    }
    if (!columns.some((column) => column.name === 'message_ts')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN message_ts TEXT');
      threadColumnsAdded = true;
    }
    if (!columns.some((column) => column.name === 'stop_json')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN stop_json TEXT');
    }
    if (!columns.some((column) => column.name === 'stop_notice_at')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN stop_notice_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'stop_notice_attempts')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN stop_notice_attempts INTEGER NOT NULL DEFAULT 0');
    }
    if (threadColumnsAdded) {
      for (const row of db.all(
        `SELECT id, turn_json, assignment_json FROM turn_jobs WHERE thread_key IS NULL AND delivered = 0`,
      )) keyStopThreadRow(db, row);
    }
    db.exec('CREATE INDEX IF NOT EXISTS turn_jobs_thread_key_idx ON turn_jobs(thread_key)');
    db.exec(
      `CREATE INDEX IF NOT EXISTS turn_jobs_stop_notice_idx
       ON turn_jobs (stop_notice_at) WHERE stop_notice_at IS NOT NULL`,
    );
    db.exec('CREATE INDEX IF NOT EXISTS turn_jobs_instance_id_idx ON turn_jobs(agent_instance_id)');
    db.exec('CREATE INDEX IF NOT EXISTS turn_jobs_submission_id_idx ON turn_jobs(submission_id)');
    db.exec(`CREATE INDEX IF NOT EXISTS turn_jobs_actor_context_idx ON turn_jobs(
      json_extract(runtime_plan_json, '$.conversation.continuityKey'),
      json_extract(runtime_plan_json, '$.actorMembershipId'),
      json_extract(runtime_plan_json, '$.agentId'),
      CAST(json_extract(turn_json, '$.messageTs') AS REAL) DESC
    ) WHERE runtime_plan_json IS NOT NULL AND dispatch_receipt_json IS NOT NULL`);
    // Keep this predicate aligned with hasPending and listPending. Recovery
    // rows remain durable but must not participate in automatic dispatch.
    db.exec(
      `CREATE INDEX IF NOT EXISTS turn_jobs_pending_idx
       ON turn_jobs (execution_authority, enqueued_at)
       WHERE delivered = 0 AND status != 'recovery_required'`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS slack_agent_bindings (
        continuity_key TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    // Node only in practice: the host stages each turn's input here too, so
    // an agent render after a process restart can still read it (see
    // src/agents/turn-input.ts). Cloudflare stages in the agent object.
    db.exec(
      `CREATE TABLE IF NOT EXISTS slack_turn_inputs (
        turn_job_id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        staged_at INTEGER NOT NULL
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
    return this.insert(job);
  }

  /** Composite Slack admission already owns the StateDb transaction. */
  enqueueInTransaction(job: TurnJob): boolean {
    this.purgeExpired('borrowed');
    return this.insert(job);
  }

  /**
   * Agent-to-Agent asks this thread admitted from one person's message
   * (`agentAsk.originMessageTs`), terminal rows included until they age out.
   */
  countAgentAskTurns(job: Pick<TurnJob, 'turn' | 'assignment'>, originMessageTs: string): number {
    const threadKey = stopThreadKeyOf(job.turn, job.assignment);
    if (!threadKey) return 0;
    const row = this.db.get(
      `SELECT COUNT(*) AS used FROM turn_jobs
       WHERE thread_key = ? AND json_extract(turn_json, '$.agentAsk.originMessageTs') = ?`,
      threadKey,
      originMessageTs,
    );
    return Number(row?.used ?? 0);
  }

  /**
   * Whether `job`'s Agent already has an ask in this thread from the same
   * exchange that has not started (no attempt recorded yet, so it has not
   * read the thread). That turn reads the thread when it runs, a later
   * message included, so asking the Agent again would only repeat it. A row
   * an unfinished stop holds does not count: its ending may drop it, and a
   * message posted after the stop runs as an ordinary turn.
   */
  hasQueuedAgentAsk(job: Pick<TurnJob, 'turn' | 'assignment'>, originMessageTs: string): boolean {
    const threadKey = stopThreadKeyOf(job.turn, job.assignment);
    if (!threadKey) return false;
    return this.db.all(
      `SELECT stop_json FROM turn_jobs
       WHERE thread_key = ? AND delivered = 0 AND status = 'pending' AND attempts = 0
         AND dispatch_envelope_json IS NULL
         AND json_extract(assignment_json, '$.agentId') = ?
         AND json_extract(turn_json, '$.agentAsk.originMessageTs') = ?`,
      threadKey,
      job.assignment.agentId,
      originMessageTs,
    ).some((row) => this.effectiveStop(parseTurnStopRecord(row.stop_json))?.role !== 'held');
  }

  /**
   * While a queued delivery is processed, jobs admitted for its Slack event
   * record when the delivery was received rather than when it was admitted.
   * Returns the release function; call it once processing ends.
   */
  noteReceipt(eventId: string, receivedAt: number): () => void {
    this.receiptTimes.set(eventId, receivedAt);
    return () => {
      if (this.receiptTimes.get(eventId) === receivedAt) this.receiptTimes.delete(eventId);
    };
  }

  private insert(job: TurnJob): boolean {
    const enqueuedAt = this.now();
    const threadKey = stopThreadKeyOf(job.turn, job.assignment);
    const messageTs = validSlackTs(job.turn.messageTs) ? job.turn.messageTs : null;
    const executionAuthority = job.executionAuthority ?? 'legacy';
    const receipt = executionAuthority === 'legacy' ? midRunReceiptOf(job) : undefined;
    // Before the row: once a turn exists, its runner may be addressed.
    this.objects?.recordThreadRunner(runnerKeyOf(job));
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO turn_jobs (
        id, evt_key, msg_key, turn_json, assignment_json, run_id, execution_authority,
        attempts, delivered, status, enqueued_at, received_at, thread_key, message_ts, progress_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', ?, ?, ?, ?, ?)`,
      job.id,
      job.evtKey,
      job.msgKey,
      JSON.stringify(job.turn),
      JSON.stringify(job.assignment),
      job.runId ?? null,
      executionAuthority,
      enqueuedAt,
      Math.min(this.receiptTimes.get(job.turn.eventId) ?? enqueuedAt, enqueuedAt),
      threadKey ?? null,
      messageTs,
      // The mid-run 👀 is the turn's receipt from the start (KTD9): Chickpea's
      // own, owed removal, and written before Slack is asked to add it, so no
      // path can see the turn without it.
      JSON.stringify(receipt ? { slackInteraction: { acknowledgment: receipt } } : {}),
    );
    if (inserted.changes !== 1) return false;
    // A message posted before an unfinished stop that Slack delivers late is
    // held too; one posted after the stop runs as an ordinary turn (KTD2).
    if (threadKey && messageTs && executionAuthority === 'legacy') {
      const head = this.unfinishedStopHead(threadKey);
      if (head && compareSlackTs(messageTs, head.record.cutoffTs) < 0) {
        this.writeStopRecord(job.id, { schemaVersion: 1, role: 'held', headId: head.id, at: enqueuedAt });
      }
    }
    return true;
  }

  // ── stops (KTD1, KTD2) ──────────────────────────────────────────────────

  /**
   * Decide a matched stop or check-in (or report a plain message) against the
   * thread's undelivered rows, in one transaction. A stop is recorded, a
   * check-in gets its run's route, and a thread with nothing to steer answers
   * `enqueue`: the message is an ordinary turn, and `enqueue` (when given) is
   * inserted in the same transaction, so a stop right after the thread's
   * first message can never be queued behind it as an ordinary turn.
   */
  steer(request: TurnSteeringRequest, enqueue?: TurnJob): TurnSteeringDecision {
    validateSteeringRequest(request, enqueue);
    if (enqueue) this.purgeExpired();
    return this.db.transaction(() => this.decideSteering(request, enqueue));
  }

  /**
   * `steer` inside a caller's transaction (a composite Slack admission). It
   * runs no transaction of its own: Node's store has no savepoints.
   */
  steerInTransaction(request: TurnSteeringRequest, enqueue?: TurnJob): TurnSteeringDecision {
    validateSteeringRequest(request, enqueue);
    if (enqueue) this.purgeExpired('borrowed');
    return this.decideSteering(request, enqueue);
  }

  /**
   * The conversations of one DM channel with an undelivered run that
   * `requesterUserId` started (their stop thread keys, at most `limit`), so a
   * top-level stop or check-in in a DM can find the one running thread it
   * means (KTD1). Rows an older release left unkeyed are keyed on the way.
   */
  runningDirectThreadKeys(
    input: { workspaceId: string; channelId: string; requesterUserId: string },
    limit = 2,
  ): string[] {
    for (const part of [input.workspaceId, input.channelId]) {
      validateBoundedString(part, 'DM coordinate', 128);
      if (part.includes(':')) throw new Error('Flue DM coordinate is invalid.');
    }
    validateBoundedString(input.requesterUserId, 'requester user id', 128);
    const prefix = `${input.workspaceId}:${input.channelId}:`;
    const keys = new Set<string>();
    for (const row of this.db.all(
      `SELECT DISTINCT thread_key FROM turn_jobs
       WHERE thread_key >= ? AND thread_key < ? AND ${PENDING_ROW}
         AND execution_authority = 'legacy' AND json_extract(turn_json, '$.userId') = ?
       ORDER BY thread_key LIMIT ?`,
      prefix,
      `${input.workspaceId}:${input.channelId};`,
      input.requesterUserId,
      limit,
    )) keys.add(String(row.thread_key));
    for (const row of this.db.all(
      `SELECT id, turn_json, assignment_json FROM turn_jobs
       WHERE thread_key IS NULL AND ${PENDING_ROW} AND execution_authority = 'legacy'
         AND json_extract(turn_json, '$.userId') = ?`,
      input.requesterUserId,
    )) {
      const keyed = keyStopThreadRow(this.db, row);
      if (keyed?.threadKey.startsWith(prefix)) keys.add(keyed.threadKey);
    }
    return [...keys].slice(0, limit);
  }

  private decideSteering(request: TurnSteeringRequest, enqueue?: TurnJob): TurnSteeringDecision {
    const rows = this.threadRows(request.threadKey);
    if (request.kind === 'stop') {
      // Idempotent: while the thread's stopped row is undelivered, a later
      // stop (the Stop button after a typed stop) returns that first stop and
      // holds nothing more.
      const stopped = rows.find((row) => row.stop?.role === 'stopped');
      const before = rows.filter((row) =>
        row.messageTs !== undefined && compareSlackTs(row.messageTs, request.cutoffTs) < 0);
      const head = stopped ?? before.find((row) => row.dispatched) ?? before[0];
      if (head) {
        return this.otherAgent(request, head.id) ?? {
          outcome: 'stopped',
          stop: stopped ? this.stopResult(stopped.id, false) : this.recordStop(request, before, head),
        };
      }
    } else if (request.kind === 'check_in' && rows.length > 0) {
      const head = rows.find((row) => row.dispatched) ?? rows[0]!;
      return this.otherAgent(request, head.id) ??
        { outcome: 'check_in', run: this.runRoute(head.id, rows.length) };
    }
    return {
      outcome: 'enqueue',
      undelivered: rows.length > 0,
      ...(enqueue ? { enqueued: this.insert(enqueue) } : {}),
    };
  }

  /**
   * R3: a stop or check-in bound to one Agent never acts on another Agent's
   * run (a handoff leaves the previous owner's run going). The decision names
   * the run's Agent, so admission can check the sender against it and decide
   * again bound to it. An unreadable row's Agent is '' and never matches.
   */
  private otherAgent(
    request: Extract<TurnSteeringRequest, { kind: 'stop' | 'check_in' }>,
    rowId: string,
  ): Extract<TurnSteeringDecision, { outcome: 'other_agent' }> | undefined {
    if (request.agentId === undefined) return undefined;
    const row = this.db.get(
      `SELECT json_extract(assignment_json, '$.agentId') AS agent_id FROM turn_jobs WHERE id = ?`,
      rowId,
    );
    const agentId = typeof row?.agent_id === 'string' ? row.agent_id : '';
    return agentId === request.agentId ? undefined : { outcome: 'other_agent', agentId };
  }

  /**
   * The stop transaction. The run's head row (the one whose dispatch started,
   * else the oldest posted before the stop's own Slack timestamp) is stamped
   * with the stop; every other undelivered row posted before that timestamp
   * that has not dispatched is held, so it can never dispatch.
   */
  private recordStop(
    request: Extract<TurnSteeringRequest, { kind: 'stop' }>,
    before: StopThreadRow[],
    head: StopThreadRow,
  ): TurnStopResult {
    const at = this.now();
    const record: TurnStopHeadRecordV1 = {
      schemaVersion: 1,
      role: 'stopped',
      source: request.source,
      stopperUserId: request.stopperUserId,
      cutoffTs: request.cutoffTs,
      stoppedAt: at,
    };
    this.db.run(
      `UPDATE turn_jobs SET stop_json = ?, stop_notice_at = ?, stop_notice_attempts = 0
       WHERE id = ?`,
      JSON.stringify(record),
      at,
      head.id,
    );
    for (const row of before) {
      // A dispatched row cannot be held back; only the head's Flue work is
      // aborted. A released row is an ordinary queued turn again.
      if (row === head || row.dispatched || (row.stop && row.stop.role !== 'released')) continue;
      this.writeStopRecord(row.id, { schemaVersion: 1, role: 'held', headId: head.id, at });
    }
    return this.stopResult(head.id, true);
  }

  private stopResult(headId: string, created: boolean): TurnStopResult {
    const row = this.db.get(
      `SELECT ${TURN_JOB_SELECT_COLUMNS}, thread_key FROM turn_jobs WHERE id = ?`,
      headId,
    ) as unknown as TurnJobRow & { thread_key: string | null };
    const job = this.decodeRow(row);
    const record = job.stop as TurnStopHeadRecordV1;
    return {
      created,
      headId,
      runnerKey: runnerKeyOf(job),
      executor: rowExecutor(row),
      agentId: job.assignment.agentId,
      record,
      held: this.stopMembers(row.thread_key ?? undefined, headId, 'held').length,
      ...(job.dispatchEnvelope ? { dispatchEnvelope: job.dispatchEnvelope } : {}),
      ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {}),
    };
  }

  private runRoute(id: string, undelivered: number): TurnRunRoute {
    const row = this.db.get(
      `SELECT ${TURN_JOB_SELECT_COLUMNS} FROM turn_jobs WHERE id = ?`,
      id,
    ) as unknown as TurnJobRow;
    const job = this.decodeRow(row);
    return {
      turnJobId: id,
      runnerKey: runnerKeyOf(job),
      executor: rowExecutor(row),
      agentId: job.assignment.agentId,
      requesterUserId: job.turn.userId,
      dispatched: job.dispatchStartedAt !== undefined,
      undelivered,
    };
  }

  /**
   * The thread's undelivered compatibility rows, oldest first, through the
   * `thread_key` index. Rows an older release wrote carry no key: those few
   * are decoded, keyed on the way, and kept when they belong to the thread.
   */
  private threadRows(threadKey: string): StopThreadRow[] {
    const rows: StopThreadRow[] = [];
    const read = (row: Record<string, unknown>, messageTs: unknown) => {
      const stop = row.stop_json ? this.effectiveStop(parseTurnStopRecord(row.stop_json)) : undefined;
      rows.push({
        id: String(row.id),
        ...(typeof messageTs === 'string' ? { messageTs } : {}),
        ...(stop ? { stop } : {}),
        dispatched: row.dispatch_started_at !== null && row.dispatch_started_at !== undefined,
        enqueuedAt: Number(row.enqueued_at),
        order: Number(row.row_order),
      });
    };
    for (const row of this.db.all(
      `SELECT rowid AS row_order, id, message_ts, stop_json, dispatch_started_at, enqueued_at
       FROM turn_jobs
       WHERE thread_key = ? AND ${PENDING_ROW} AND execution_authority = 'legacy'`,
      threadKey,
    )) read(row, row.message_ts);
    for (const row of this.db.all(
      `SELECT rowid AS row_order, id, turn_json, assignment_json, stop_json,
         dispatch_started_at, enqueued_at
       FROM turn_jobs
       WHERE thread_key IS NULL AND ${PENDING_ROW} AND execution_authority = 'legacy'`,
    )) {
      const keyed = keyStopThreadRow(this.db, row);
      if (keyed?.threadKey === threadKey) read(row, keyed.messageTs);
    }
    return rows.sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.order - right.order);
  }

  /** The thread's stopped head whose ending has not finished, if any. */
  private unfinishedStopHead(
    threadKey: string,
  ): { id: string; record: TurnStopHeadRecordV1 } | undefined {
    for (const row of this.db.all(
      `SELECT id, stop_json FROM turn_jobs
       WHERE thread_key = ? AND stop_json IS NOT NULL AND ${PENDING_ROW}`,
      threadKey,
    )) {
      const record = parseTurnStopRecord(row.stop_json);
      if (record?.role === 'stopped' && !record.ending) return { id: String(row.id), record };
    }
    return undefined;
  }

  /**
   * Rows whose stop record names `headId` in `role`, oldest first, each with
   * the 👀 Chickpea added to its message and still owes removing (KTD9).
   */
  private stopMembers(
    threadKey: string | undefined,
    headId: string,
    role: TurnStopMemberRecordV1['role'],
  ): TurnStopFinish['rows'] {
    if (!threadKey) return [];
    return this.db.all(
      `SELECT id, run_id, message_ts, stop_json, progress_json FROM turn_jobs
       WHERE thread_key = ? AND stop_json IS NOT NULL
       ORDER BY enqueued_at, rowid`,
      threadKey,
    ).filter((row) => {
      const record = parseTurnStopRecord(row.stop_json);
      return record?.role === role && record.headId === headId;
    }).map((row) => {
      const acknowledgment = parseTurnProgress(String(row.progress_json ?? '{}'))
        .slackInteraction?.acknowledgment;
      const owed = acknowledgment?.created === true && acknowledgment.cleanup === 'pending';
      return {
        id: String(row.id),
        ...(row.run_id ? { runId: String(row.run_id) } : {}),
        ...(row.message_ts ? { messageTs: String(row.message_ts) } : {}),
        ...(owed
          ? {
              receipt: {
                channelId: acknowledgment.channelId,
                messageTs: acknowledgment.messageTs,
                name: acknowledgment.name,
              },
            }
          : {}),
      };
    });
  }

  private writeStopRecord(id: string, record: TurnStopRecordV1): void {
    this.db.run('UPDATE turn_jobs SET stop_json = ? WHERE id = ?', JSON.stringify(record), id);
  }

  /**
   * A hold only holds while its stop is unfinished: once the head settled
   * without an ending (an older release delivered it, say), or the head is
   * gone, the row is an ordinary turn again.
   */
  private effectiveStop(record: TurnStopRecordV1 | undefined): TurnStopRecordV1 | undefined {
    if (record?.role !== 'held') return record;
    const head = this.db.get(
      'SELECT delivered, status, stop_json FROM turn_jobs WHERE id = ?',
      record.headId,
    );
    const headRecord = head ? parseTurnStopRecord(head.stop_json) : undefined;
    const holding = head !== undefined && Number(head.delivered) === 0 &&
      head.status !== 'recovery_required' &&
      headRecord?.role === 'stopped' && !headRecord.ending;
    return holding ? record : { ...record, role: 'released' };
  }

  /**
   * The stopped ending (KTD3) drops the rows the stop holds, or releases them
   * on a completion race (R22), and records that ending on the head, all in
   * one transaction. A dropped row keeps the existing `done` status
   * (delivered), so an older release never dispatches it again or maps it to
   * `error`. The first ending stands: a repeat returns it whatever outcome it
   * asks for. Undefined when the row carries no stop.
   */
  finishStop(headId: string, outcome: 'dropped' | 'released'): TurnStopFinish | undefined {
    validateBoundedString(headId, 'TurnJob id', 256);
    if (outcome !== 'dropped' && outcome !== 'released') throw new Error('Stop ending is invalid.');
    return this.db.transaction(() => this.finishStopRows(headId, outcome));
  }

  /**
   * The ending's statements alone, with no transaction of its own, so a
   * terminal write can release a stop it settles (see releaseStop). The head
   * is written last: an interrupted ending is finished by the next call.
   */
  private finishStopRows(headId: string, outcome: 'dropped' | 'released'): TurnStopFinish | undefined {
    const head = this.db.get('SELECT stop_json, thread_key FROM turn_jobs WHERE id = ?', headId);
    const record = head ? parseTurnStopRecord(head.stop_json) : undefined;
    if (record?.role !== 'stopped') return undefined;
    const threadKey = head?.thread_key ? String(head.thread_key) : undefined;
    if (record.ending) {
      return {
        outcome: record.ending.outcome,
        count: record.ending.count,
        rows: this.stopMembers(threadKey, headId, record.ending.outcome),
        record,
      };
    }
    const at = this.now();
    const rows = this.stopMembers(threadKey, headId, 'held');
    const member = JSON.stringify({ schemaVersion: 1, role: outcome, headId, at });
    for (const row of rows) {
      if (outcome === 'dropped') {
        this.db.run(
          `UPDATE turn_jobs SET delivered = 1, status = 'done', stop_json = ?
           WHERE id = ? AND delivered = 0`,
          member,
          row.id,
        );
      } else {
        this.db.run('UPDATE turn_jobs SET stop_json = ? WHERE id = ?', member, row.id);
      }
    }
    const ended: TurnStopHeadRecordV1 = { ...record, ending: { outcome, count: rows.length, at } };
    this.db.run('UPDATE turn_jobs SET stop_json = ? WHERE id = ?', JSON.stringify(ended), headId);
    return { outcome, count: rows.length, rows, record: ended };
  }

  /**
   * A stopped head settled without the stopped ending (a failure final, a
   * recovery, a path that never read the stop): its held rows run as ordinary
   * turns, so no teammate's message is stranded. A delivered head owes its
   * runner nothing more; one held for recovery may still run in Flue, so its
   * notice stays owed. Plain statements only: callers may hold a transaction.
   */
  private releaseStop(id: string): void {
    const row = this.db.get(
      'SELECT delivered, stop_json, stop_notice_at FROM turn_jobs WHERE id = ?',
      id,
    );
    if (!row?.stop_json) return;
    if (Number(row.delivered) === 1 && row.stop_notice_at !== null && row.stop_notice_at !== undefined) {
      this.db.run('UPDATE turn_jobs SET stop_notice_at = NULL WHERE id = ?', id);
    }
    const record = parseTurnStopRecord(row.stop_json);
    if (record?.role === 'stopped' && !record.ending) this.finishStopRows(id, 'released');
  }

  // ── the stop outbox ─────────────────────────────────────────────────────

  /**
   * Stop notices due for delivery to the head row's executor, oldest first.
   * Like a runner hand-off, a notice stays owed until the runner acknowledges
   * it; a settled head owes none.
   */
  listDueStopNotices(now = this.now(), limit = STOP_NOTICE_BATCH): TurnStopNotice[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Stop notice limit must be between 1 and 100.');
    }
    const rows = this.db.all(
      `SELECT ${TURN_JOB_SELECT_COLUMNS}, stop_notice_attempts FROM turn_jobs
       WHERE stop_notice_at IS NOT NULL AND stop_notice_at <= ? AND delivered = 0
       ORDER BY stop_notice_at LIMIT ?`,
      now,
      limit,
    ) as unknown as Array<TurnJobRow & { stop_notice_attempts: number }>;
    const notices: TurnStopNotice[] = [];
    const unreadable: string[] = [];
    for (const row of rows) {
      const job = this.decodeReadable(row, unreadable);
      if (!job) continue;
      if (job.stop?.role !== 'stopped') {
        this.acknowledgeStopNotice(job.id);
        continue;
      }
      const uid = job.dispatchReceipt?.uid ?? job.dispatchEnvelope?.uid ?? undefined;
      const guestSandboxKey = job.runtimePlan ? runtimePlanGuestSandboxKey(job.runtimePlan) : undefined;
      notices.push({
        turnJobId: job.id,
        runnerKey: runnerKeyOf(job),
        executor: rowExecutor(row),
        record: job.stop,
        attempts: Number(row.stop_notice_attempts),
        ...(job.dispatchEnvelope ? { instanceId: job.dispatchEnvelope.instanceId } : {}),
        ...(uid ? { uid } : {}),
        ...(job.dispatchReceipt ? { submissionId: job.dispatchReceipt.submissionId } : {}),
        ...(job.flueSettlement ? { settled: job.flueSettlement.outcome } : {}),
        ...(guestSandboxKey ? { guestSandboxKey } : {}),
      });
    }
    this.quarantineUnreadable(unreadable);
    return notices;
  }

  /** When the next stop notice falls due; undefined when none is owed. */
  nextStopNoticeDueAt(): number | undefined {
    const row = this.db.get(
      `SELECT MIN(stop_notice_at) AS due FROM turn_jobs
       WHERE stop_notice_at IS NOT NULL AND delivered = 0`,
    );
    return row?.due === null || row?.due === undefined ? undefined : Number(row.due);
  }

  /** The head's runner took the stop. */
  acknowledgeStopNotice(id: string): void {
    this.db.run('UPDATE turn_jobs SET stop_notice_at = NULL WHERE id = ?', id);
  }

  /** A delivery failed: try again after 1 s, doubling to 30 s. Returns when. */
  deferStopNotice(id: string, now = this.now()): number | undefined {
    const row = this.db.get(
      'SELECT stop_notice_attempts FROM turn_jobs WHERE id = ? AND stop_notice_at IS NOT NULL',
      id,
    );
    if (!row) return undefined;
    const attempts = Number(row.stop_notice_attempts ?? 0) + 1;
    const dueAt = now + Math.min(
      STOP_NOTICE_RETRY_MS * 2 ** Math.min(attempts - 1, 16),
      STOP_NOTICE_RETRY_MAX_MS,
    );
    this.db.run(
      'UPDATE turn_jobs SET stop_notice_at = ?, stop_notice_attempts = ? WHERE id = ?',
      dueAt,
      attempts,
      id,
    );
    return dueAt;
  }

  /**
   * Continue an OAuth-suspended Slack task as a fresh delivery into the same
   * Agent conversation. The original row may already be terminal (it posted
   * the authorization link); the continuation id makes callback replay
   * idempotent while the new plan resolves the newly-ready account live.
   */
  resumeAfterOAuth(originalTaskId: string, continuationId: string): boolean {
    const id = oauthResumeTurnJobId(continuationId);
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
    const original = this.decodeWithoutRunRecords(row);
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
    return this.decodeSweep(rows);
  }

  /**
   * The alarm's work list: undelivered jobs in enqueue order, at most
   * `perThread` per conversation and `maxThreads` conversations. A long queue
   * of follow-ups in one thread cannot hide a new conversation behind it, and
   * each thread keeps its own order. Reads the pending index a page at a
   * time and stops once enough conversations are found.
   *
   * Only rows `executor` owns (default `alarm`) are listed, and a thread stops
   * at its first row the other executor owns, so the two never run one
   * conversation out of order. `dispatchedOnly` also stops a thread at its
   * first row whose Flue dispatch has not started: while thread runners
   * execute new turns, the alarm only finishes the turns it already dispatched.
   */
  listPendingByThread(input: {
    maxThreads: number;
    perThread: number;
    threadKey(job: PendingTurnJob): string;
    executionAuthority?: RunExecutionAuthority;
    executor?: TurnJobExecutor;
    dispatchedOnly?: boolean;
    /** Rows read at most, bounding the cost of one very long backlog. */
    scanLimit?: number;
  }): PendingTurnJob[] {
    const executor = input.executor ?? 'alarm';
    const perThread = new Map<string, number>();
    const closed = new Set<string>();
    const jobs: PendingTurnJob[] = [];
    this.scanPending(input.executionAuthority ?? 'legacy', input.scanLimit, (job) => {
      const key = input.threadKey(job);
      if (closed.has(key)) return;
      if ((job.executor ?? 'alarm') !== executor ||
          (input.dispatchedOnly && job.dispatchStartedAt === undefined)) {
        closed.add(key);
        return;
      }
      const listed = perThread.get(key) ?? 0;
      if (listed === 0 && perThread.size >= input.maxThreads) return;
      if (listed >= input.perThread) return;
      perThread.set(key, listed + 1);
      jobs.push(job);
    }, () => perThread.size >= input.maxThreads);
    return jobs;
  }

  /**
   * The next alarm-owned row of each conversation that may move to its thread
   * runner, oldest first, past rows its runner already owns. A thread stops at
   * a hand-off its runner has not confirmed (so a lost admission can never be
   * overtaken) and at an alarm row whose Flue dispatch started (the alarm
   * finishes that turn first), so no conversation runs two turns at once or
   * out of order. At most `limit` threads; hand a page over and list again.
   */
  listDispatchable(input: {
    limit: number;
    threadKey(job: PendingTurnJob): string;
    scanLimit?: number;
  }): PendingTurnJob[] {
    const seen = new Set<string>();
    const jobs: PendingTurnJob[] = [];
    this.scanPending('legacy', input.scanLimit, (job) => {
      if (jobs.length >= input.limit) return;
      const key = input.threadKey(job);
      if (seen.has(key)) return;
      if (job.executor === 'runner' && !job.handoff) return;
      seen.add(key);
      if (!job.handoff && job.dispatchStartedAt === undefined) jobs.push(job);
    }, () => jobs.length >= input.limit);
    return jobs;
  }

  /** Visit pending rows in enqueue order, a page at a time, until `done()`. */
  private scanPending(
    executionAuthority: RunExecutionAuthority,
    scanLimit = 1_000,
    visit: (job: PendingTurnJob) => void,
    done: () => boolean,
  ): void {
    const pageSize = 100;
    const unreadable: string[] = [];
    for (let offset = 0; offset < scanLimit; offset += pageSize) {
      const rows = this.db.all(
        `SELECT ${TURN_JOB_SELECT_COLUMNS}
         FROM turn_jobs
         WHERE ${PENDING_ROW} AND execution_authority = ?
         ORDER BY enqueued_at LIMIT ? OFFSET ?`,
        executionAuthority,
        pageSize,
        offset,
      ) as unknown as TurnJobRow[];
      for (const row of rows) {
        const job = this.decodeReadable(row, unreadable);
        if (job) visit(job);
      }
      if (rows.length < pageSize || done()) break;
    }
    // Parked only after the scan: a row leaving the pending set mid-scan
    // would move the next page's offset past an unread row, and a later turn
    // of that row's thread could be listed ahead of it.
    this.quarantineUnreadable(unreadable);
  }

  /**
   * Start handing a pending alarm row to its thread runner. The row is the
   * runner's from here on (the alarm never runs it again); it stays a
   * hand-off until the runner confirms its admission. False when it is no
   * longer a pending alarm row.
   */
  assignRunner(id: string): boolean {
    return this.db.run(
      `UPDATE turn_jobs SET executor = 'handoff'
       WHERE id = ? AND executor = 'alarm' AND ${PENDING_ROW}`,
      id,
    ).changes === 1;
  }

  /** The runner admitted the row durably. */
  confirmRunner(id: string): void {
    this.db.run(
      "UPDATE turn_jobs SET executor = 'runner' WHERE id = ? AND executor = 'handoff'",
      id,
    );
  }

  /** The thread runner key of a runner-owned row, whatever its status. */
  runnerThreadKey(
    id: string,
    threadKey: (turn: NormalizedSlackTurn, assignment: ResolvedAssignment) => string,
  ): string | undefined {
    const row = this.db.get(
      `SELECT turn_json, assignment_json FROM turn_jobs
       WHERE id = ? AND executor IN ('runner', 'handoff')`,
      id,
    );
    if (!row) return undefined;
    return threadKey(
      JSON.parse(String(row.turn_json)) as NormalizedSlackTurn,
      JSON.parse(String(row.assignment_json)) as ResolvedAssignment,
    );
  }

  /**
   * A pending alarm row whose Flue dispatch had started. On a fresh state
   * store instance nothing observes it any more (its alarm ended with the
   * previous instance), so it is due for reattachment now.
   */
  hasInterruptedAlarmDispatch(): boolean {
    return this.db.get(
      `SELECT 1 AS pending FROM turn_jobs
       WHERE ${PENDING_ROW} AND executor = 'alarm' AND dispatch_started_at IS NOT NULL
       LIMIT 1`,
    ) !== undefined;
  }

  hasHandoffs(): boolean {
    return this.db.get(
      `SELECT 1 AS pending FROM turn_jobs WHERE ${PENDING_ROW} AND executor = 'handoff' LIMIT 1`,
    ) !== undefined;
  }

  /** Hand-offs whose runner admission is unconfirmed; re-admission is idempotent. */
  listHandoffs(limit: number): PendingTurnJob[] {
    return this.decodeSweep(this.db.all(
      `SELECT ${TURN_JOB_SELECT_COLUMNS} FROM turn_jobs
       WHERE ${PENDING_ROW} AND executor = 'handoff'
       ORDER BY enqueued_at LIMIT ?`,
      limit,
    ) as unknown as TurnJobRow[]);
  }

  /** The authoritative row a thread runner reads before it runs or reattaches. */
  runnerView(id: string): RunnerTurnJobView {
    const row = this.db.get(
      `SELECT ${TURN_JOB_SELECT_COLUMNS}, delivered, status FROM turn_jobs WHERE id = ?`,
      id,
    ) as unknown as (TurnJobRow & { delivered: number; status: string }) | undefined;
    if (!row) return { status: 'missing' };
    const executor = rowExecutor(row);
    if (row.status === 'recovery_required') return { status: 'recovery_required', executor };
    if (Number(row.delivered) === 1) {
      return {
        status: row.status === 'error' ? 'error' : 'done',
        executor,
        // The runner retries a delivered turn's cleanup from the decoded row.
        ...(row.progress_json.includes('"cleanup":"pending"')
          ? { cleanupPending: true, job: this.decodeWithoutRunRecords(row) }
          : {}),
      };
    }
    const unreadable: string[] = [];
    const job = this.decodeReadable(row, unreadable);
    if (!job) {
      // Parked here too: the state alarm may not sweep a runner's rows soon.
      this.quarantineUnreadable(unreadable);
      return { status: 'recovery_required', executor };
    }
    return { status: 'pending', executor, job };
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

  listProposalApprovalTurns(input: SlackProposalApprovalQuery): SlackProposalApprovalTurn[] {
    for (const key of ['proposalId', 'workspaceId', 'channelId', 'threadTs', 'requesterUserId',
      'requesterMembershipId', 'actingAgentId'] as const) validateBoundedString(input[key], key, 256);
    const rows = this.db.all(
      `SELECT id, run_id, status, delivered,
         json_extract(turn_json, '$.managementApprovalProposalId') AS proposalId,
         json_extract(turn_json, '$.workspaceId') AS workspaceId,
         json_extract(turn_json, '$.channelId') AS channelId,
         json_extract(turn_json, '$.threadTs') AS threadTs,
         json_extract(turn_json, '$.userId') AS requesterUserId,
         json_extract(turn_json, '$.actorMembershipId') AS requesterMembershipId,
         json_extract(assignment_json, '$.agent.id') AS actingAgentId,
         json_extract(turn_json, '$.messageTs') AS messageTs
       FROM turn_jobs
       WHERE json_extract(turn_json, '$.managementApprovalProposalId') = ?
         AND json_extract(turn_json, '$.workspaceId') = ?
         AND json_extract(turn_json, '$.channelId') = ?
         AND json_extract(turn_json, '$.threadTs') = ?
         AND json_extract(turn_json, '$.userId') = ?
         AND json_extract(turn_json, '$.actorMembershipId') = ?
         AND json_extract(assignment_json, '$.agent.id') = ?
       ORDER BY enqueued_at DESC, rowid DESC LIMIT 2`,
      input.proposalId, input.workspaceId, input.channelId, input.threadTs,
      input.requesterUserId, input.requesterMembershipId, input.actingAgentId,
    );
    return rows.map((row) => ({
      proposalId: validateBoundedString(row.proposalId, 'Proposal id', 256),
      workspaceId: validateBoundedString(row.workspaceId, 'Workspace id', 256),
      channelId: validateBoundedString(row.channelId, 'Channel id', 256),
      threadTs: validateBoundedString(row.threadTs, 'Thread timestamp', 256),
      requesterUserId: validateBoundedString(row.requesterUserId, 'Requester id', 256),
      requesterMembershipId: validateBoundedString(row.requesterMembershipId, 'Membership id', 256),
      actingAgentId: validateBoundedString(row.actingAgentId, 'Acting Agent id', 256),
      turnJobId: validateBoundedString(row.id, 'Turn id', 256),
      runId: row.run_id == null ? null : validateBoundedString(row.run_id, 'Run id', 256),
      messageTs: validateBoundedString(row.messageTs, 'Message timestamp', 256),
      status: validateBoundedString(row.status, 'Turn status', 256),
      delivered: row.delivered === 1,
    }));
  }

  /** First successful write owns the plan and target for every later retry. */
  freezeRuntimePlan(id: string, candidate: RuntimePlanV2): FrozenRuntimePlanDecision {
    const plan = parseRuntimePlanV2(candidate);
    return this.db.transaction(() => {
      const current = this.getFrozenRuntimePlan(id);
      if (current) return current;
      const instanceId = deriveRuntimePlanInstanceId(plan);
      this.objects?.recordAgentInstance('slack_agent', instanceId);
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

  /** Read this actor's admitted context while the conversation binding is live. */
  getBoundRuntimePlan(continuityKey: string, beforeMessageTs: string, actorMembershipId: string, agentId: string): RuntimePlanV2 | undefined {
    const binding = this.getAgentBinding(continuityKey);
    if (!binding) return undefined;
    if (!/^\d+\.\d+$/.test(beforeMessageTs)) throw new Error('Invalid Slack message timestamp');
    const row = this.db.get(
      `SELECT runtime_plan_json FROM turn_jobs
       WHERE runtime_plan_json IS NOT NULL AND dispatch_receipt_json IS NOT NULL
         AND json_extract(runtime_plan_json, '$.conversation.continuityKey') = ?
         AND json_extract(runtime_plan_json, '$.actorMembershipId') = ?
         AND json_extract(runtime_plan_json, '$.agentId') = ?
         AND CAST(json_extract(turn_json, '$.messageTs') AS REAL) < CAST(? AS REAL)
       ORDER BY CAST(json_extract(turn_json, '$.messageTs') AS REAL) DESC LIMIT 1`,
      continuityKey, actorMembershipId, agentId, beforeMessageTs,
    );
    if (!row?.runtime_plan_json) return undefined;
    let plan: RuntimePlanV2;
    try {
      plan = parseRuntimePlanV2(JSON.parse(String(row.runtime_plan_json)));
    } catch {
      // A plan this release cannot read (a newer release's, after a
      // rollback) only loses the thread's carried context: the turn picks
      // its connections afresh instead of failing.
      console.warn('[chickpea] a thread\'s previous runtime plan is unreadable; continuing without it');
      return undefined;
    }
    return plan.conversation.continuityKey === continuityKey ? plan : undefined;
  }

  /**
   * The thread instance's previous turn, when this turn continues it: the
   * conversation is pinned to `instanceId` and that instance already admitted
   * an earlier turn. Its trigger is the watermark below which the transcript
   * already holds the Slack context. Undefined means the dispatch starts a
   * transcript (a new thread, an ownership transfer, or a rotation).
   */
  getThreadContinuation(
    continuityKey: string,
    instanceId: string,
    beforeMessageTs: string,
  ): SlackThreadContinuation | undefined {
    validateOpaqueAgentId(instanceId, 'instance id');
    if (!/^\d+\.\d+$/.test(beforeMessageTs)) throw new Error('Invalid Slack message timestamp');
    const binding = this.getAgentBinding(continuityKey);
    if (!binding || binding.instanceId !== instanceId) return undefined;
    const row = this.db.get(
      `SELECT runtime_plan_json, json_extract(turn_json, '$.messageTs') AS message_ts,
         json_extract(turn_json, '$.userId') AS user_id
       FROM turn_jobs
       WHERE agent_instance_id = ? AND runtime_plan_json IS NOT NULL
         AND dispatch_receipt_json IS NOT NULL
         AND CAST(json_extract(turn_json, '$.messageTs') AS REAL) < CAST(? AS REAL)
       ORDER BY CAST(json_extract(turn_json, '$.messageTs') AS REAL) DESC LIMIT 1`,
      instanceId,
      beforeMessageTs,
    );
    if (!row?.runtime_plan_json || typeof row.message_ts !== 'string') return undefined;
    const previous: SlackThreadContinuation = {
      messageTs: row.message_ts,
      ...(typeof row.user_id === 'string' ? { slackUserId: row.user_id } : {}),
    };
    try {
      return { ...previous, runtimePlan: parseRuntimePlanV2(JSON.parse(String(row.runtime_plan_json))) };
    } catch {
      // Unreadable after a rollback: the transcript is still there, only the
      // narration of what changed is lost.
      return previous;
    }
  }

  /** Node's durable copy of a staged turn input; the first write wins. */
  stageTurnInput(json: string): void {
    const input = parseSlackTurnInput(json);
    this.db.run(
      `INSERT INTO slack_turn_inputs (turn_job_id, input_json, staged_at) VALUES (?, ?, ?)
       ON CONFLICT(turn_job_id) DO NOTHING`,
      input.turnJobId,
      json,
      this.now(),
    );
  }

  readTurnInputJson(turnJobId: string): string | undefined {
    const row = this.db.get(
      'SELECT input_json FROM slack_turn_inputs WHERE turn_job_id = ?',
      turnJobId,
    );
    return typeof row?.input_json === 'string' ? row.input_json : undefined;
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
    threadImages?: readonly ThreadImageRecord[],
    admittedListIds?: readonly string[],
    turnEnvelope?: TurnEnvelopeV1,
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
      // A stopped row, or one a stop holds, never dispatches: Flue's abort()
      // does not cover a dispatch that arrives after it (KTD2).
      const stop = this.effectiveStop(parseTurnStopRecord(
        this.db.get('SELECT stop_json FROM turn_jobs WHERE id = ?', id)?.stop_json,
      ));
      if (stop?.role === 'stopped' || stop?.role === 'held') throw new TurnJobStopRefusal();
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
      // Host-collected images reach the Agent object only through this
      // bounded attribute: on Cloudflare the turn and the Agent run in
      // different Durable Objects.
      const serializedThreadImages = serializeThreadImageRecords(threadImages);
      const serializedAdmittedListIds = serializeAdmittedSlackListIds(admittedListIds);
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
            conversationKind: slackConversationKind(turn),
            slackUserId: turn.userId,
            eventId: turn.eventId,
            messageTs: turn.messageTs,
            turnJobId: id,
            requesterText: turn.text.slice(0, 40_000),
            ...(turn.requesterTimezone ? { requesterTimezone: turn.requesterTimezone } : {}),
            ...(turn.attachments?.length
              ? { attachmentFileIds: turn.attachments.map(({ fileId }) => fileId).join(',') }
              : {}),
            ...(serializedThreadImages ? { threadImages: serializedThreadImages } : {}),
            ...(serializedAdmittedListIds ? { admittedListIds: serializedAdmittedListIds } : {}),
            ...((turn.attachmentIntake || turn.attachments?.length)
              ? {
                  attachmentIntakeStatus: turn.attachmentIntake?.status ?? 'ok',
                  attachmentCount: String(turn.attachmentIntake?.count ?? turn.attachments?.length ?? 0),
                }
              : {}),
          },
        },
        ...(continuing ? {} : { initialData: decision.runtimePlan }),
        idempotencyKey: id,
        ...(!continuing && binding
          ? { previousBinding: { instanceId: binding.instanceId, uid: binding.uid } }
          : {}),
      };
      parseFlueDispatchEnvelope(envelope);
      // Frozen with the first dispatch, like the envelope itself: a retry
      // reuses both, so the Agent sees the same settings on every attempt.
      const frozenTurnEnvelope = turnEnvelope ? parseTurnEnvelope(turnEnvelope) : undefined;
      const startedAt = this.now();
      const updated = this.db.run(
        `UPDATE turn_jobs
         SET dispatch_envelope_json = ?, dispatch_started_at = ?, observation_json = ?,
           turn_envelope_json = ?
         WHERE id = ? AND dispatch_envelope_json IS NULL`,
        JSON.stringify(envelope),
        startedAt,
        JSON.stringify(observation),
        frozenTurnEnvelope ? JSON.stringify(frozenTurnEnvelope) : null,
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

  /** The settings envelope frozen with this turn's dispatch, if one was. */
  getTurnEnvelope(id: string): TurnEnvelopeV1 | undefined {
    const row = this.db.get('SELECT turn_envelope_json FROM turn_jobs WHERE id = ?', id);
    return row?.turn_envelope_json
      ? parseTurnEnvelope(JSON.parse(String(row.turn_envelope_json)))
      : undefined;
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
    const row = this.db.get(
      'SELECT dispatch_envelope_json FROM turn_jobs WHERE id = ?',
      id,
    );
    const existingJson = row?.dispatch_envelope_json
      ? String(row.dispatch_envelope_json)
      : undefined;
    if (!existingJson) throw new Error('Flue dispatch envelope is unavailable.');
    const existing = parseFlueDispatchEnvelope(JSON.parse(existingJson));
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
      existingJson,
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
    const updated = this.db.run(
      `UPDATE turn_jobs SET status = 'recovery_required', recovery_reason = ?
       WHERE id = ? AND delivered = 0`,
      reason,
      id,
    );
    if (updated.changes === 1) {
      console.error('[chickpea] TurnJob requires operator reconciliation', JSON.stringify({
        reason: LOGGABLE_TURN_RECOVERY_REASONS.has(reason) ? reason : 'unclassified',
      }));
      this.releaseStop(id);
    }
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

  /** Pending rows the state store's alarm owns; runner rows wake their runner. */
  hasPending(executionAuthority: RunExecutionAuthority = 'legacy'): boolean {
    return this.db.get(
      `SELECT 1 AS pending FROM turn_jobs
       WHERE ${PENDING_ROW} AND execution_authority = ? AND executor = 'alarm' LIMIT 1`,
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
       SET status = 'pending', recovery_reason = NULL, executor = 'alarm'
       WHERE delivered = 0
         AND status = 'recovery_required'
         AND recovery_reason = 'slack_installation_unavailable'
         AND execution_authority = 'legacy'
         AND json_extract(turn_json, '$.workspaceId') = ?`,
      workspaceId,
    ).changes;
  }

  /**
   * An operator stops every turn not yet delivered, as after restoring an
   * installation's objects, so no message is answered twice: each is parked
   * as `recovery_required` (`operator_cancelled`), which no executor runs or
   * delivers again, and its owed stop notice is dropped. Returns how many
   * were parked, and the Flue instances of every cancelled turn whose
   * dispatch is admitted and unsettled, for the caller to abort (at most
   * `limit`; a repeat returns the same ones until they settle). Safe to repeat.
   */
  cancelPendingWork(limit = 100): { turns: number; dispatched: SlackThreadAgentTarget[] } {
    const turns = this.db.run(
      `UPDATE turn_jobs
       SET status = 'recovery_required', recovery_reason = 'operator_cancelled', stop_notice_at = NULL
       WHERE ${PENDING_ROW}`,
    ).changes;
    const dispatched = this.db.all(
      `SELECT id FROM turn_jobs
       WHERE delivered = 0 AND status = 'recovery_required' AND recovery_reason = 'operator_cancelled'
         AND dispatch_receipt_json IS NOT NULL AND flue_settlement_json IS NULL
       ORDER BY enqueued_at, id LIMIT ?`,
      limit,
    ).flatMap((row): SlackThreadAgentTarget[] => {
      const id = String(row.id);
      try {
        const envelope = this.getDispatchEnvelope(id);
        const uid = this.getFlueReceipt(id)?.uid ?? envelope?.uid;
        return envelope ? [{ instanceId: envelope.instanceId, ...(uid ? { uid } : {}) }] : [];
      } catch {
        return [];
      }
    });
    return { turns, dispatched };
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
   * eligible for answer redelivery, only idempotent checklist/reaction repair.
   * A thread runner repairs its own rows; this sweep never takes them over. */
  listPendingSlackInteractionCleanups(limit = 100): PendingTurnJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Slack interaction cleanup limit must be between 1 and 100.');
    }
    const rows = this.db.all(
      `SELECT ${TURN_JOB_SELECT_COLUMNS}
       FROM turn_jobs
       WHERE delivered = 1 AND progress_json LIKE '%\"cleanup\":\"pending\"%'
         AND executor = 'alarm'
       ORDER BY enqueued_at LIMIT ?`,
      limit,
    ) as unknown as TurnJobRow[];
    // A row a newer release wrote is still cleaned up instead of failing
    // every sweep and holding the alarm armed for it.
    return rows.map((row) => this.decodeWithoutRunRecords(row));
  }

  hasPendingSlackInteractionCleanup(): boolean {
    return this.db.get(
      `SELECT 1 AS pending FROM turn_jobs
       WHERE delivered = 1 AND progress_json LIKE '%\"cleanup\":\"pending\"%'
         AND executor = 'alarm'
       LIMIT 1`,
    ) !== undefined;
  }

  /** Tombstone a delivered job so no later scan re-delivers it. */
  markDelivered(id: string): void {
    this.recordTerminalStatus(id, 'success');
    this.db.run("UPDATE turn_jobs SET delivered = 1, status = 'done' WHERE id = ?", id);
    this.releaseStop(id);
  }

  /** Tombstone a job that exhausted its attempts (terminal failure). */
  markError(id: string): void {
    this.recordTerminalStatus(id, 'error');
    this.db.run("UPDATE turn_jobs SET delivered = 1, status = 'error' WHERE id = ?", id);
    this.releaseStop(id);
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

  private purgeExpired(transaction: 'owned' | 'borrowed' = 'owned'): void {
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
      'DELETE FROM slack_agent_bindings WHERE updated_at < ?',
      now - SLACK_AGENT_BINDING_TTL_MS,
    );
    this.db.run('DELETE FROM slack_turn_inputs WHERE staged_at < ?', now - TURN_JOB_TTL_MS);
    // Keep each actor/Agent's latest dispatched context per live binding. Other completed
    // turns retain the ordinary redelivery TTL; expired bindings retain none.
    // Build the retained-ID list once, independently of the terminal-row scan.
    const expiredTerminalPredicate = `WHERE delivered = 1 AND enqueued_at < ?
         AND progress_json NOT LIKE '%"cleanup":"pending"%'
         AND id NOT IN (
           SELECT retained_id FROM (
             SELECT prior.id AS retained_id, ROW_NUMBER() OVER (
               PARTITION BY json_extract(prior.runtime_plan_json, '$.conversation.continuityKey'),
                 json_extract(prior.runtime_plan_json, '$.actorMembershipId'),
                 json_extract(prior.runtime_plan_json, '$.agentId')
               ORDER BY CAST(json_extract(prior.turn_json, '$.messageTs') AS REAL) DESC
             ) AS position
             FROM slack_agent_bindings b JOIN turn_jobs prior
               ON json_extract(prior.runtime_plan_json, '$.conversation.continuityKey') = b.continuity_key
             WHERE prior.runtime_plan_json IS NOT NULL AND prior.dispatch_receipt_json IS NOT NULL
           ) WHERE position = 1
         )`;
    // Content-free Lists write receipts live exactly as long as their turn.
    // Isolated TurnJob stores may not have installed SettingsStore yet.
    const purgeTerminalRows = () => {
      if (this.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")) {
        this.db.run(
          `DELETE FROM app_settings WHERE key IN (SELECT 'slack_lists.writes.v1:' || id FROM turn_jobs ${expiredTerminalPredicate})`,
          now - TURN_JOB_TTL_MS,
        );
      }
      this.db.run(`DELETE FROM turn_jobs ${expiredTerminalPredicate}`, now - TURN_JOB_TTL_MS);
    };
    if (transaction === 'borrowed') purgeTerminalRows();
    else this.db.transaction(purgeTerminalRows);
  }

  private recordTerminalStatus(id: string, terminal: 'success' | 'error'): void {
    const current = this.getProgress(id);
    const checklist = current?.slackInteraction?.checklist;
    if (!current || !checklist) return;
    this.recordSlackInteractionProgress(id, {
      checklist: { ...checklist, terminal },
    });
  }

  /**
   * Decode a row a sweep read, or collect its id in `unreadable` when this
   * release cannot read it (see quarantineUnreadable). One such row must not
   * fail the sweep: that would stall every conversation on every pass.
   */
  private decodeReadable(row: TurnJobRow, unreadable: string[]): PendingTurnJob | undefined {
    let records: TurnJobRecords;
    try {
      records = parseTurnJobRecords(row);
    } catch {
      unreadable.push(row.id);
      return undefined;
    }
    return this.decodeRow(row, records);
  }

  /** Decode a one-page sweep, parking the rows this release cannot read. */
  private decodeSweep(rows: readonly TurnJobRow[]): PendingTurnJob[] {
    const unreadable: string[] = [];
    const jobs = rows.flatMap((row) => this.decodeReadable(row, unreadable) ?? []);
    this.quarantineUnreadable(unreadable);
    return jobs;
  }

  /**
   * Park undelivered rows this release cannot read, such as a newer
   * release's rows after a rollback, for operator recovery. They leave every
   * sweep, a stop notice they owe is dropped (it names a runner only the row
   * can tell), and a stop they head releases the rows it holds. Plain
   * statements only: callers may hold a transaction.
   */
  private quarantineUnreadable(ids: readonly string[]): void {
    for (const id of ids) {
      this.db.run('UPDATE turn_jobs SET stop_notice_at = NULL WHERE id = ? AND delivered = 0', id);
      // A row already held for recovery keeps its original reason.
      if (this.db.get("SELECT 1 AS held FROM turn_jobs WHERE id = ? AND status = 'recovery_required'", id)) {
        continue;
      }
      this.markRecoveryRequired(id, 'stored_turn_unreadable');
    }
  }

  /**
   * Decode only the turn, its assignment and its progress, for work that
   * needs nothing more (Slack cleanup, an OAuth continuation). The run
   * records stay unread, so a row a newer release wrote (read after a
   * rollback) still decodes.
   */
  private decodeWithoutRunRecords(row: TurnJobRow): PendingTurnJob {
    return this.decodeRow(row, {
      turn: JSON.parse(row.turn_json) as NormalizedSlackTurn,
      assignment: JSON.parse(row.assignment_json) as ResolvedAssignment,
    });
  }

  private decodeRow(row: TurnJobRow, records = parseTurnJobRecords(row)): PendingTurnJob {
    const { turn, assignment, runtimePlan, dispatchEnvelope, dispatchReceipt, flueSettlement } = records;
    const stop = row.stop_json ? this.effectiveStop(parseTurnStopRecord(row.stop_json)) : undefined;
    const previousStop = this.previousThreadStop(row, turn, assignment);
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
      ...(runtimePlan ? { runtimePlan } : {}),
      ...(row.agent_instance_id ? { agentInstanceId: row.agent_instance_id } : {}),
      ...(dispatchEnvelope ? { dispatchEnvelope } : {}),
      ...(dispatchReceipt ? { dispatchReceipt } : {}),
      ...(flueSettlement ? { flueSettlement } : {}),
      ...(row.dispatch_started_at === null || row.dispatch_started_at === undefined
        ? {}
        : { dispatchStartedAt: Number(row.dispatch_started_at) }),
      ...(row.recovery_reason ? { recoveryReason: row.recovery_reason } : {}),
      ...(row.enqueued_at === null || row.enqueued_at === undefined
        ? {}
        : { enqueuedAt: Number(row.enqueued_at) }),
      ...(row.received_at === null || row.received_at === undefined
        ? {}
        : { receivedAt: Number(row.received_at) }),
      ...(rowExecutor(row) === 'runner' ? { executor: 'runner' as const } : {}),
      ...(row.executor === 'handoff' ? { handoff: true as const } : {}),
      ...(stop ? { stop } : {}),
      ...(previousStop ? { previousStop } : {}),
    };
  }

  /**
   * The thread's previous run, when a stop stopped it (KTD3): the latest
   * delivered row enqueued before this one, dropped rows aside (they never
   * ran), is a stopped head whose ending dropped rather than released. Only
   * a row whose dispatch has not started asks: its prompt is not yet built.
   */
  private previousThreadStop(
    row: TurnJobRow,
    turn: NormalizedSlackTurn,
    assignment: ResolvedAssignment,
  ): TurnPreviousStop | undefined {
    if ((row.dispatch_started_at !== null && row.dispatch_started_at !== undefined) ||
        row.enqueued_at === null || row.enqueued_at === undefined) return undefined;
    const threadKey = stopThreadKeyOf(turn, assignment);
    if (!threadKey) return undefined;
    const previous = this.db.get(
      `SELECT stop_json FROM turn_jobs
       WHERE thread_key = ? AND delivered = 1 AND id != ? AND enqueued_at <= ?
         AND (stop_json IS NULL OR json_extract(stop_json, '$.role') IS NOT 'dropped')
       ORDER BY enqueued_at DESC, rowid DESC LIMIT 1`,
      threadKey,
      row.id,
      Number(row.enqueued_at),
    );
    const record = previous?.stop_json ? parseTurnStopRecord(previous.stop_json) : undefined;
    return record?.role === 'stopped' && record.ending?.outcome === 'dropped'
      ? { stopperUserId: record.stopperUserId, stoppedAt: record.stoppedAt }
      : undefined;
  }
}

/**
 * Deliver the stop notices due now (see TurnJobStoreLogic.listDueStopNotices),
 * side by side: a receiver answer of true acknowledges one; false or a
 * rejection leaves it owed with a backoff, the way an unconfirmed runner
 * hand-off is admitted again. Never throws for a single notice.
 */
export async function deliverDueStopNotices(input: {
  turnJobs: Pick<TurnJobStoreLogic, 'listDueStopNotices' | 'acknowledgeStopNotice' | 'deferStopNotice'>;
  receiver(notice: TurnStopNotice): Promise<boolean>;
  now?: () => number;
  limit?: number;
}): Promise<{ acknowledged: number; deferred: number }> {
  const now = input.now ?? Date.now;
  const notices = input.turnJobs.listDueStopNotices(now(), input.limit ?? STOP_NOTICE_BATCH);
  const outcomes = await Promise.all(notices.map(async (notice) => {
    let acknowledged = false;
    try {
      acknowledged = await input.receiver(notice);
    } catch {
      // The runner is unreachable or refused; the outbox retries.
    }
    if (acknowledged) input.turnJobs.acknowledgeStopNotice(notice.turnJobId);
    else input.turnJobs.deferStopNotice(notice.turnJobId, now());
    return acknowledged;
  }));
  const acknowledged = outcomes.filter(Boolean).length;
  if (acknowledged < outcomes.length) {
    console.warn('[chickpea] stop notice delivery will retry', {
      deferred: outcomes.length - acknowledged,
    });
  }
  return { acknowledged, deferred: outcomes.length - acknowledged };
}

const SLACK_REACTION_NAME = /^[a-z0-9_+-]{1,80}$/;

/**
 * A job's mid-run receipt, as its row records it (KTD9), or undefined unless
 * it names the job's own message: the only 👀 a turn may ever remove.
 */
function midRunReceiptOf(job: TurnJob): NonNullable<TurnProgress['slackInteraction']>['acknowledgment'] {
  const receipt = job.midRunReceipt;
  if (!receipt || typeof receipt !== 'object' || !job.turn || typeof job.turn !== 'object') return undefined;
  if (receipt.channelId !== job.turn.channelId || receipt.messageTs !== job.turn.messageTs ||
      typeof receipt.channelId !== 'string' || receipt.channelId.length === 0 ||
      !validSlackTs(receipt.messageTs) ||
      typeof receipt.name !== 'string' || !SLACK_REACTION_NAME.test(receipt.name)) {
    return undefined;
  }
  return {
    channelId: receipt.channelId,
    messageTs: receipt.messageTs,
    name: receipt.name,
    created: true,
    cleanup: 'pending',
    reaction: 'seen_mid_run',
  };
}

/** The stop thread key of a turn, or undefined when its coordinates are unusable. */
function stopThreadKeyOf(turn: NormalizedSlackTurn, assignment: ResolvedAssignment): string | undefined {
  if (!turn || typeof turn !== 'object' || !assignment || typeof assignment !== 'object') return undefined;
  const threadTs = conversationThreadTs(turn, assignment.runtimeContract);
  for (const part of [turn.workspaceId, turn.channelId, threadTs]) {
    if (typeof part !== 'string' || part.length === 0 || part.includes(':')) return undefined;
  }
  return turnStopThreadKey(turn, assignment);
}

/**
 * Key one row an older release wrote without `thread_key` from its stored
 * JSON. Returns the key it wrote, or undefined for an unreadable row.
 */
function keyStopThreadRow(
  db: StateDb,
  row: Record<string, unknown>,
): { threadKey: string; messageTs?: string } | undefined {
  try {
    const turn = JSON.parse(String(row.turn_json)) as NormalizedSlackTurn;
    const assignment = JSON.parse(String(row.assignment_json)) as ResolvedAssignment;
    const threadKey = stopThreadKeyOf(turn, assignment);
    if (!threadKey) return undefined;
    const messageTs = validSlackTs(turn.messageTs) ? turn.messageTs : undefined;
    db.run(
      'UPDATE turn_jobs SET thread_key = ?, message_ts = ? WHERE id = ? AND thread_key IS NULL',
      threadKey,
      messageTs ?? null,
      String(row.id),
    );
    return { threadKey, ...(messageTs ? { messageTs } : {}) };
  } catch {
    // An unreadable row stays unkeyed; it can never run either.
    return undefined;
  }
}

/** The thread runner a row's turn runs on (owner incarnation included). */
export function runnerKeyOf(job: Pick<PendingTurnJob, 'turn' | 'assignment'>): string {
  try {
    return slackAgentThreadKey(job.turn, job.assignment);
  } catch {
    return turnStopThreadKey(job.turn, job.assignment);
  }
}

/** Order two Slack timestamps exactly (seconds, then the fraction), never as floats. */
function compareSlackTs(left: string, right: string): number {
  const [leftSeconds = '', leftFraction = ''] = left.split('.');
  const [rightSeconds = '', rightFraction = ''] = right.split('.');
  const seconds = BigInt(leftSeconds) - BigInt(rightSeconds);
  if (seconds !== 0n) return seconds < 0n ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const fraction = BigInt(leftFraction.padEnd(width, '0')) - BigInt(rightFraction.padEnd(width, '0'));
  return fraction === 0n ? 0 : fraction < 0n ? -1 : 1;
}

function validateSteeringRequest(request: TurnSteeringRequest, enqueue?: TurnJob): void {
  if (!request || (request.kind !== 'stop' && request.kind !== 'check_in' && request.kind !== 'message')) {
    throw new Error('Steering request kind is invalid.');
  }
  validateBoundedString(request.threadKey, 'steering thread key', 512);
  const parts = request.threadKey.split(':');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('Steering thread key is invalid.');
  }
  if (request.kind === 'stop') {
    if (request.source !== 'typed' && request.source !== 'button') {
      throw new Error('Stop source is invalid.');
    }
    validateBoundedString(request.stopperUserId, 'stopper user id', 128);
    if (!validSlackTs(request.cutoffTs)) throw new Error('Stop cutoff timestamp is invalid.');
  }
  if (request.kind !== 'message' && request.agentId !== undefined) {
    validateBoundedString(request.agentId, 'steering agent id', 128);
  }
  if (enqueue && stopThreadKeyOf(enqueue.turn, enqueue.assignment) !== request.threadKey) {
    throw new Error('The enqueued turn does not belong to the steered thread.');
  }
}

type TurnJobRecords = Pick<
  PendingTurnJob,
  'turn' | 'assignment' | 'runtimePlan' | 'dispatchEnvelope' | 'dispatchReceipt' | 'flueSettlement'
>;

/**
 * The row's records that this release reads strictly. Pure, so a throw means
 * only that this release cannot read the row: it is corrupt, or a newer
 * release wrote a shape this one does not know (read after a rollback).
 */
function parseTurnJobRecords(row: TurnJobRow): TurnJobRecords {
  return {
    turn: JSON.parse(row.turn_json) as NormalizedSlackTurn,
    assignment: JSON.parse(row.assignment_json) as ResolvedAssignment,
    ...(row.runtime_plan_json
      ? { runtimePlan: parseRuntimePlanV2(JSON.parse(row.runtime_plan_json)) }
      : {}),
    ...(row.dispatch_envelope_json
      ? { dispatchEnvelope: parseFlueDispatchEnvelope(JSON.parse(row.dispatch_envelope_json)) }
      : {}),
    ...(row.dispatch_receipt_json
      ? { dispatchReceipt: parseFlueDispatchReceipt(JSON.parse(row.dispatch_receipt_json)) }
      : {}),
    ...(row.flue_settlement_json
      ? { flueSettlement: parseFlueSettlement(JSON.parse(row.flue_settlement_json)) }
      : {}),
  };
}

/** Tolerant: a malformed record reads as none, so it can never suppress work. */
function parseTurnStopRecord(raw: unknown): TurnStopRecordV1 | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return undefined;
    const at = (key: string) => Number.isSafeInteger(value[key]) ? Number(value[key]) : undefined;
    if (value.role === 'stopped') {
      const stoppedAt = at('stoppedAt');
      if ((value.source !== 'typed' && value.source !== 'button') ||
          typeof value.stopperUserId !== 'string' || !validSlackTs(value.cutoffTs) ||
          stoppedAt === undefined) return undefined;
      const ending = value.ending as Record<string, unknown> | undefined;
      const validEnding = ending && typeof ending === 'object' &&
        (ending.outcome === 'dropped' || ending.outcome === 'released') &&
        Number.isSafeInteger(ending.count) && Number.isSafeInteger(ending.at);
      return {
        schemaVersion: 1,
        role: 'stopped',
        source: value.source,
        stopperUserId: value.stopperUserId,
        cutoffTs: value.cutoffTs,
        stoppedAt,
        ...(validEnding
          ? {
              ending: {
                outcome: ending.outcome as 'dropped' | 'released',
                count: Number(ending.count),
                at: Number(ending.at),
              },
            }
          : {}),
      };
    }
    const memberAt = at('at');
    if ((value.role === 'held' || value.role === 'dropped' || value.role === 'released') &&
        typeof value.headId === 'string' && memberAt !== undefined) {
      return { schemaVersion: 1, role: value.role, headId: value.headId, at: memberAt };
    }
  } catch {
    // Malformed: treated as absent.
  }
  return undefined;
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
  // Either derivation: a row frozen before thread continuity still targets
  // its plan-addressed instance.
  if (initialData && !runtimePlanInstanceIdMatches(initialData, instanceId)) {
    throw new Error('Flue dispatch target does not match its RuntimePlanV2.');
  }
  // Validated above, but kept as admitted: a retried dispatch must resend the
  // same creation data, and a legacy plan reads differently than it was sent.
  const admittedData = initialData
    ? structuredClone(record.initialData) as AdmittedRuntimePlanData
    : undefined;
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
      ...(admittedData ? { initialData: admittedData } : {}),
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
    ...(admittedData ? { initialData: admittedData } : {}),
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
    'conversationKind',
    'requesterText',
    'requesterTimezone',
    'attachmentFileIds',
    'attachmentIntakeStatus', 'attachmentCount',
    'threadImages',
    'admittedListIds',
  ]);
  const parsed = {
    workspaceId: validateBoundedString(attributes.workspaceId, 'Slack workspace id', 128),
    channelId: validateBoundedString(attributes.channelId, 'Slack channel id', 128),
    threadTs: validateBoundedString(attributes.threadTs, 'Slack thread timestamp', 80),
    ...(attributes.conversationKind === undefined
      ? {}
      : { conversationKind: validateConversationKind(attributes.conversationKind) }),
    slackUserId: validateBoundedString(attributes.slackUserId, 'Slack user id', 128),
    eventId: validateBoundedString(attributes.eventId, 'Slack event id', 256),
    messageTs: validateBoundedString(attributes.messageTs, 'Slack message timestamp', 80),
    turnJobId: validateBoundedString(attributes.turnJobId, 'TurnJob id', 256),
    ...(attributes.requesterTimezone === undefined ? {} : {
      requesterTimezone: validateBoundedString(attributes.requesterTimezone, 'Slack requester timezone', 64),
    }),
    ...(attributes.requesterText === undefined
      ? {}
      : { requesterText: validateBoundedString(attributes.requesterText, 'Slack requester text', 40_000) }),
    ...(attributes.attachmentFileIds === undefined
      ? {}
      : {
          attachmentFileIds: validateAttachmentFileIds(attributes.attachmentFileIds),
        }),
    ...(attributes.attachmentIntakeStatus === undefined
      ? {}
      : { attachmentIntakeStatus: validateAttachmentIntakeStatus(attributes.attachmentIntakeStatus) }),
    ...(attributes.attachmentCount === undefined
      ? {}
      : { attachmentCount: validateAttachmentCount(attributes.attachmentCount) }),
    ...(attributes.threadImages === undefined
      ? {}
      : { threadImages: validateThreadImages(attributes.threadImages) }),
    ...(attributes.admittedListIds === undefined
      ? {}
      : { admittedListIds: validateAdmittedListIds(attributes.admittedListIds) }),
  };
  if ((parsed.attachmentIntakeStatus === undefined) !== (parsed.attachmentCount === undefined)) {
    throw new Error('Flue Slack attachment intake metadata is incomplete.');
  }
  if (parsed.attachmentIntakeStatus === 'ok') {
    const ids = parsed.attachmentFileIds?.split(',') ?? [];
    if (ids.length === 0 || parsed.attachmentCount !== String(ids.length)) {
      throw new Error('Flue Slack attachment intake metadata does not match its files.');
    }
  } else if (parsed.attachmentIntakeStatus !== undefined && parsed.attachmentFileIds !== undefined) {
    throw new Error('Rejected Slack attachments cannot enter the Flue signal.');
  }
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

function validateAdmittedListIds(value: unknown): string {
  const parsed = parseAdmittedSlackListIds(value);
  if (!parsed) throw new Error('Flue Slack List admission metadata is invalid.');
  return serializeAdmittedSlackListIds(parsed)!;
}

function validateConversationKind(value: unknown): 'channel' | 'im' | 'mpim' {
  if (value === 'channel' || value === 'im' || value === 'mpim') return value;
  throw new Error('Slack conversation kind is invalid.');
}

function validateAttachmentFileIds(value: unknown): string {
  const encoded = validateBoundedString(value, 'Slack attachment file ids', 1_027);
  const ids = encoded.split(',');
  if (ids.length < 1 || ids.length > 4 ||
      ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id))) {
    throw new Error('Slack attachment file ids are invalid.');
  }
  return ids.join(',');
}

/**
 * Any non-empty key re-validates the wire shape: the attribute carries no
 * conversation of its own, and the Agent stamps its plan's key on arrival.
 */
const THREAD_IMAGE_VALIDATION_KEY = 'validation';

/** The attribute must re-parse into the list the host serialized. */
function validateThreadImages(value: unknown): string {
  const encoded = validateBoundedString(
    value,
    'Slack thread images',
    MAX_THREAD_IMAGES_ATTRIBUTE_CHARS,
  );
  if (parseThreadImageRecords(encoded, THREAD_IMAGE_VALIDATION_KEY).length === 0) {
    throw new Error('Slack thread images are invalid.');
  }
  return encoded;
}

function validateAttachmentIntakeStatus(
  value: unknown,
): 'ok' | 'too_many' | 'invalid_metadata' {
  if (value !== 'ok' && value !== 'too_many' && value !== 'invalid_metadata') {
    throw new Error('Slack attachment intake status is invalid.');
  }
  return value;
}

function validateAttachmentCount(value: unknown): string {
  const encoded = validateBoundedString(value, 'Slack attachment count', 8);
  if (!/^[1-9][0-9]{0,6}$/.test(encoded)) {
    throw new Error('Slack attachment count is invalid.');
  }
  return encoded;
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
  'invalid-output',
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
    'tablePresentations',
    'artifacts',
    'agentCreationTerminal',
    'memoryUpdate',
    'codingModel',
    'codingWorkerUsage',
    'requestedModel',
    'returnedModel',
    'reportedUsage',
    'usageCompleteness',
    'flueSubmissionRef',
  ]);
  const text = validateBoundedString(record.text, 'settled result text', 1_000_000);
  const tablePresentations = parseSlackTablePresentations(record.tablePresentations);
  const artifacts = parseSlackArtifactReceipts(
    record.artifacts === undefined ? undefined : [record.artifacts],
  );
  const memoryUpdate = parseSlackMemoryUpdate(record.memoryUpdate === undefined ? undefined : [record.memoryUpdate]);
  const agentCreationTerminal = parseSlackAgentCreationTerminalIntents(
    record.agentCreationTerminal === undefined ? undefined : [record.agentCreationTerminal],
  )[0];
  const codingModel = record.codingModel === undefined
    ? undefined
    : validateBoundedString(record.codingModel, 'coding model', 240);
  const codingWorkerUsage = parseCodingWorkerUsage(record.codingWorkerUsage);
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
    ...(tablePresentations.length > 0 ? { tablePresentations } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(agentCreationTerminal ? { agentCreationTerminal } : {}),
    ...(memoryUpdate ? { memoryUpdate } : {}),
    ...(codingModel ? { codingModel } : {}),
    ...(codingWorkerUsage.length > 0 ? { codingWorkerUsage } : {}),
    requestedModel,
    returnedModel,
    reportedUsage,
    usageCompleteness,
    ...(flueSubmissionRef === undefined ? {} : { flueSubmissionRef }),
  };
}

/** `handoff` rows already belong to their runner. */
function rowExecutor(row: Pick<TurnJobRow, 'executor'>): TurnJobExecutor {
  return row.executor === 'runner' || row.executor === 'handoff' ? 'runner' : 'alarm';
}

function parseFlueObservation(value: unknown): FlueTurnObservationV1 {
  const record = exactObject(value, 'Flue observation target', [
    'generation', 'workCorrelation', 'harnessRevision', 'configurationRevision',
    'executor', 'runnerKey',
  ]);
  if (record.executor !== undefined && record.executor !== 'runner') {
    throw new Error('Observation executor is invalid.');
  }
  const runnerKey = record.runnerKey === undefined
    ? undefined
    : validateBoundedString(record.runnerKey, 'observation runner key', 512);
  if ((record.executor === undefined) !== (runnerKey === undefined)) {
    throw new Error('Observation runner route is incomplete.');
  }
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
    ...(runnerKey ? { executor: 'runner' as const, runnerKey } : {}),
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
  if (!isRuntimePlanInstanceId(value)) {
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
  return `Pull request #${pullRequest.number} is already open: ${renderSlackMarkdownActionLink(
    slackActionLink(pullRequest.url, 'View pull request'),
  )}`;
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
