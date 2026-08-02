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
  FrozenRuntimePlanDecision,
  SlackAgentBinding,
  SlackAgentBindingExpectation,
  TurnJob,
} from './turn-job-types.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { StateDb } from '../state/state-db.ts';
import type { SlackRuntimeDrainCounts } from '../config/state-rpc.ts';
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
 * This is target-neutral StateDb logic (like the claim/snapshot/settings logic)
 * so it is unit-testable on the node lane, even though only the Cloudflare
 * Durable Object ever enqueues or drains (node runs turns inline — no relay).
 *
 * Delivery guarantees:
 *   - Idempotent enqueue (INSERT OR IGNORE on the message claim key), so the
 *     app_mention + message fan-out for one mention enqueues at most once.
 *   - A `delivered` tombstone excludes a completed job from any later alarm
 *     scan (`WHERE delivered = 0`), the guard against a redundant re-delivery.
 *   - A bounded attempt counter caps retries; the alarm posts a sanitized
 *     generic failure final and releases the claims on the terminal attempt.
 *   - Rows purge on the claim TTL horizon (past it a Slack redelivery can no
 *     longer arrive, so the tombstone is dead weight — the same horizon the
 *     claims table uses).
 */

/** Attempts (inclusive) the alarm makes to deliver a turn before giving up. */
export const MAX_TURN_ATTEMPTS = 2;
export const MAX_TURN_DRAIN_BATCH = 16;

// Job rows live no longer than the claim TTL: past it Slack no longer
// redelivers the originating event, so neither the idempotency key nor the
// delivered tombstone can still matter.
export const TURN_JOB_TTL_MS = CLAIM_TTL_MS;
export const SLACK_AGENT_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

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
  continuityNoticeRequired?: boolean;
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
  continuity_notice_required?: number | null;
}

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
        continuity_notice_required INTEGER,
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
    if (!columns.some((column) => column.name === 'continuity_notice_required')) {
      db.exec('ALTER TABLE turn_jobs ADD COLUMN continuity_notice_required INTEGER');
    }
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

  /** Undelivered jobs in enqueue order — the alarm's work list. */
  listPending(
    limit = 100,
    executionAuthority: RunExecutionAuthority = 'legacy',
  ): PendingTurnJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Turn job limit must be between 1 and 100.');
    }
    const rows = this.db.all(
      `SELECT id, evt_key, msg_key, turn_json, assignment_json, run_id,
              execution_authority, attempts, progress_json, runtime_plan_json,
              agent_instance_id, continuity_notice_required
       FROM turn_jobs
       WHERE delivered = 0 AND execution_authority = ?
       ORDER BY enqueued_at LIMIT ?`,
      executionAuthority,
      limit,
    ) as unknown as TurnJobRow[];
    return rows.map((row) => ({
      id: row.id,
      evtKey: row.evt_key,
      msgKey: row.msg_key,
      turn: JSON.parse(row.turn_json) as NormalizedSlackTurn,
      assignment: JSON.parse(row.assignment_json) as ResolvedAssignment,
      ...(row.run_id ? { runId: row.run_id } : {}),
      executionAuthority: row.execution_authority,
      attempts: Number(row.attempts),
      progress: parseTurnProgress(row.progress_json),
    }));
  }

  getPendingByRunId(runId: string): PendingTurnJob | undefined {
    const row = this.db.get(
      `SELECT id, evt_key, msg_key, turn_json, assignment_json, run_id,
              execution_authority, attempts, progress_json, runtime_plan_json,
              agent_instance_id, continuity_notice_required
       FROM turn_jobs
       WHERE delivered = 0 AND execution_authority = 'ledger' AND run_id = ?
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
      const binding = this.getAgentBinding(plan.conversation.continuityKey);
      const continuityNoticeRequired = Boolean(
        binding &&
        binding.instanceId !== instanceId &&
        plan.conversation.surface !== 'channel_thread',
      );
      const updated = this.db.run(
        `UPDATE turn_jobs
         SET runtime_plan_json = ?, agent_instance_id = ?, continuity_notice_required = ?
         WHERE id = ? AND runtime_plan_json IS NULL`,
        JSON.stringify(plan),
        instanceId,
        continuityNoticeRequired ? 1 : 0,
        id,
      );
      if (updated.changes !== 1) {
        const winner = this.getFrozenRuntimePlan(id);
        if (winner) return winner;
        throw new Error('TurnJob is unavailable for RuntimePlanV2 freeze.');
      }
      return { runtimePlan: plan, instanceId, continuityNoticeRequired };
    });
  }

  getFrozenRuntimePlan(id: string): FrozenRuntimePlanDecision | undefined {
    const row = this.db.get(
      `SELECT runtime_plan_json, agent_instance_id, continuity_notice_required
       FROM turn_jobs WHERE id = ?`,
      id,
    );
    if (!row?.runtime_plan_json) return undefined;
    const runtimePlan = parseRuntimePlanV2(JSON.parse(String(row.runtime_plan_json)));
    const instanceId = validateOpaqueAgentId(row.agent_instance_id, 'instance id');
    return {
      runtimePlan,
      instanceId,
      continuityNoticeRequired: Number(row.continuity_notice_required) === 1,
    };
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

  hasPending(executionAuthority: RunExecutionAuthority = 'legacy'): boolean {
    return this.db.get(
      'SELECT 1 AS pending FROM turn_jobs WHERE delivered = 0 AND execution_authority = ? LIMIT 1',
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
    };
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
      `SELECT id, evt_key, msg_key, turn_json, assignment_json, run_id,
              execution_authority, attempts, progress_json, runtime_plan_json,
              agent_instance_id, continuity_notice_required
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

  /** Node legacy failures release Slack claims, so remove the row for redrive. */
  discard(id: string): void {
    this.db.run('DELETE FROM turn_jobs WHERE id = ?', id);
  }

  private purgeExpired(): void {
    this.db.run('DELETE FROM turn_jobs WHERE enqueued_at < ?', this.now() - TURN_JOB_TTL_MS);
    this.db.run(
      'DELETE FROM slack_agent_bindings WHERE updated_at < ?',
      this.now() - SLACK_AGENT_BINDING_TTL_MS,
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
    return {
      id: row.id,
      evtKey: row.evt_key,
      msgKey: row.msg_key,
      turn: JSON.parse(row.turn_json) as NormalizedSlackTurn,
      assignment: JSON.parse(row.assignment_json) as ResolvedAssignment,
      ...(row.run_id ? { runId: row.run_id } : {}),
      executionAuthority: row.execution_authority,
      attempts: Number(row.attempts),
      progress: parseTurnProgress(row.progress_json),
      ...(row.runtime_plan_json
        ? { runtimePlan: parseRuntimePlanV2(JSON.parse(row.runtime_plan_json)) }
        : {}),
      ...(row.agent_instance_id ? { agentInstanceId: row.agent_instance_id } : {}),
      ...(row.continuity_notice_required === null || row.continuity_notice_required === undefined
        ? {}
        : { continuityNoticeRequired: Number(row.continuity_notice_required) === 1 }),
    };
  }
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
