import { createHash } from 'node:crypto';

import type { StateDb } from '../state/state-db.ts';

export const SLACK_PRESENTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SLACK_PRESENTATION_FINALIZED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_SLACK_PENDING_APPEND_BYTES = 128 * 1_024;

export const DEFAULT_SLACK_APPEND_BUDGET = {
  capacity: 1,
  refillWindowMs: 1_000,
} as const;

export type SlackProgressiveEligibilityReason =
  | 'safe_early_release'
  | 'memory'
  | 'sandbox'
  | 'recovery'
  | 'effect_capable'
  | 'concurrent_join'
  | 'other';

export type SlackProgressiveEligibility =
  | { status: 'pending' }
  | {
      status: 'frozen';
      allowed: boolean;
      reason: SlackProgressiveEligibilityReason;
    };

export type SlackPresentationStreamState =
  | 'absent'
  | 'starting'
  | 'streaming'
  | 'reconciling'
  | 'finalizing'
  | 'artifact_delivered'
  | 'finalized'
  | 'fallback'
  | 'unknown';

export type SlackPresentationOutcome =
  | 'progressive'
  | 'terminal_only'
  | 'fallback'
  | 'corrected'
  | 'withdrawn'
  | 'unknown';

export type SlackPresentationDegradationReason =
  | 'budget_exhausted'
  | 'workspace_cooldown'
  | 'rate_limited'
  | 'unsafe_incomplete_block'
  | 'continuity_unresolved'
  | 'runtime_gate_disabled'
  | 'policy_ineligible'
  | 'effect_capable'
  | 'legacy_no_run'
  | 'unsupported_contract'
  | 'unknown_effect';

export type SlackProgressiveIntentDenialReason =
  | 'late_declaration'
  | 'repeated_declaration'
  | 'declaration_failed'
  | 'mismatched_declaration'
  | 'non_presentation_tool'
  | 'structured_output'
  | 'reset'
  | 'identity_conflict'
  | 'persistence_failure'
  | 'runtime_denied';

export type SlackProgressiveIntent =
  | { status: 'unresolved' }
  | { status: 'pending'; toolCallId: string }
  | { status: 'requested'; requestedAt: number }
  | { status: 'not_requested'; decidedAt: number }
  | {
      status: 'denied';
      reason: SlackProgressiveIntentDenialReason;
      decidedAt: number;
    };

export interface SlackPresentationPersona {
  name: string;
  avatarUrl: string;
  avatarRevision: number;
}

export interface SlackPresentationRoot {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterUserId: string;
}

export interface SlackPresentationStream {
  state: SlackPresentationStreamState;
  messageTs?: string;
  flue?: {
    instanceId: string;
    submissionId: string;
    messageId?: string;
    lastAcceptedPosition?: { batch: number; index: number };
  };
  acknowledgedByteLength: number;
  slackAppendCursor: number;
  acknowledgedPrefixHash?: string;
  pendingAppend?: {
    cursor: number;
    from: number;
    to: number;
    hash: string;
  };
  presentationOutcome?: SlackPresentationOutcome;
  degradationReason?: SlackPresentationDegradationReason;
}

export interface SlackPresentationPlan {
  displayMode: 'timeline' | 'plan';
  tasks: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'complete' | 'error';
  }>;
}

interface SlackRunPresentationBase {
  runId: string;
  turnJobId: string;
  bindingId: string;
  workBindingGeneration: number;
  runFencingToken: number;
  projectionVersion: number;
  progressiveEligibility: SlackProgressiveEligibility;
  /** Immutable Agent authorship captured before any Slack effect. */
  persona?: SlackPresentationPersona;
  root: SlackPresentationRoot;
  stream: SlackPresentationStream;
  plan?: SlackPresentationPlan;
  title?: { valueHash: string; outcome: 'pending' | 'set' | 'failed' };
  repairRequired: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SlackRunPresentationV1 extends SlackRunPresentationBase {
  schemaVersion: 1;
  features: {
    progressiveStreaming: boolean;
    nativeTasks: boolean;
  };
}

export interface SlackRunPresentationV2 extends SlackRunPresentationBase {
  schemaVersion: 2;
  progressiveIntent: SlackProgressiveIntent;
}

export type SlackRunPresentation = SlackRunPresentationV1 | SlackRunPresentationV2;

export function presentationAllowsProgressive(
  presentation: SlackRunPresentation,
): boolean {
  return presentation.schemaVersion === 2 || presentation.features.progressiveStreaming;
}

export function presentationUsesNativeTasks(
  presentation: SlackRunPresentation,
): boolean {
  return presentation.schemaVersion === 2 || presentation.features.nativeTasks;
}

export interface SlackRunPresentationCreateInput {
  runId: string;
  turnJobId: string;
  bindingId: string;
  workBindingGeneration: number;
  runFencingToken: number;
  /** Test and migration seam only. New admissions default to V2. */
  schemaVersion?: 1 | 2;
  features?: Partial<SlackRunPresentationV1['features']>;
  persona?: SlackPresentationPersona;
  root: SlackPresentationRoot;
  taskLabels?: readonly string[];
}

export type SlackPresentationMutation =
  | {
      kind: 'freeze_progressive_eligibility';
      eligibility: {
        allowed: boolean;
        reason: SlackProgressiveEligibilityReason;
      };
    }
  | { kind: 'advance_run_fence'; runFencingToken: number }
  | { kind: 'stream_start_intent' }
  | {
      kind: 'stream_started';
      messageTs: string;
      flue: {
        instanceId: string;
        submissionId: string;
        messageId?: string;
      };
    }
  | {
      kind: 'append_intent';
      position: { batch: number; index: number };
      from: number;
      to: number;
      hash: string;
    }
  | { kind: 'append_acknowledged'; cursor: number; acknowledgedPrefixHash: string }
  | { kind: 'append_rejected'; cursor: number }
  | {
      kind: 'close_stream';
      outcome?: Extract<
        SlackPresentationOutcome,
        'progressive' | 'terminal_only' | 'corrected' | 'withdrawn'
      >;
      degradationReason?: SlackPresentationDegradationReason;
    }
  | { kind: 'mark_finalizing' }
  | { kind: 'mark_fallback'; outcome: 'fallback' }
  | {
      kind: 'mark_artifact_delivered';
      outcome: SlackPresentationOutcome;
      messageTs?: string;
    }
  | { kind: 'mark_finalized' }
  | { kind: 'mark_non_stream_finalized' }
  | { kind: 'mark_unknown'; degradationReason: SlackPresentationDegradationReason }
  | { kind: 'adopt_plan'; taskLabels: readonly string[] }
  | { kind: 'set_task_status'; status: 'in_progress' | 'complete' | 'error' }
  | { kind: 'record_title_intent'; valueHash: string }
  | { kind: 'record_title_outcome'; outcome: 'set' | 'failed' };

export interface SlackPresentationTransitionInput {
  runId: string;
  workBindingGeneration: number;
  runFencingToken: number;
  expectedProjectionVersion: number;
  expectedStreamState: SlackPresentationStreamState;
  mutation: SlackPresentationMutation;
}

export type SlackPresentationTransitionResult =
  | { outcome: 'applied'; presentation: SlackRunPresentation }
  | { outcome: 'missing' | 'stale' };

export type SlackAppendReservation =
  | { outcome: 'reserved'; budgetVersion: number }
  | { outcome: 'cooldown'; retryAt: number; budgetVersion: number }
  | { outcome: 'exhausted'; retryAt: number; budgetVersion: number };

export interface SlackAppendBudgetPolicy {
  capacity: number;
  refillWindowMs: number;
}

export interface SlackPresentationRetentionTombstone {
  streamState: SlackPresentationStreamState;
  repairRequired: boolean;
  expiredAt: number;
  tombstonedAt: number;
}

export interface SlackPresentationSummary {
  workspaceId: string;
  total: number;
  truncated: boolean;
  streamStates: Record<string, number>;
  eligibility: Record<string, number>;
  outcomes: Record<string, number>;
  degradations: Record<string, number>;
}

export type SlackPresentationStateErrorCode =
  | 'identity_conflict'
  | 'invalid_input'
  | 'invalid_transition'
  | 'eligibility_frozen'
  | 'cursor_gap'
  | 'coordinate_conflict'
  | 'terminal_rewrite'
  | 'budget_policy_conflict';

export class SlackPresentationStateError extends Error {
  constructor(readonly code: SlackPresentationStateErrorCode, message: string) {
    super(message);
    this.name = 'SlackPresentationStateError';
  }
}

interface PresentationRow extends Record<string, unknown> {
  run_id: string;
  binding_generation: number;
  run_fencing_token: number;
  projection_version: number;
  stream_state: SlackPresentationStreamState;
  workspace_id: string;
  channel_id: string;
  message_ts: string | null;
  repair_required: number;
  presentation_json: string;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
  hard_expires_at: number;
}

interface BudgetRow extends Record<string, unknown> {
  workspace_id: string;
  capacity: number;
  refill_window_ms: number;
  available: number;
  last_refill_at: number;
  cooldown_until: number | null;
  version: number;
  updated_at: number;
}

const PRESENTATION_COLUMNS = `run_id, binding_generation, run_fencing_token,
  projection_version, stream_state, workspace_id, channel_id, message_ts,
  repair_required, presentation_json, created_at, updated_at, finalized_at,
  hard_expires_at`;

export class SlackRunPresentationStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS slack_run_presentations (
        run_id TEXT PRIMARY KEY,
        binding_generation INTEGER NOT NULL,
        run_fencing_token INTEGER NOT NULL,
        projection_version INTEGER NOT NULL,
        stream_state TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT,
        repair_required INTEGER NOT NULL,
        presentation_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finalized_at INTEGER,
        hard_expires_at INTEGER NOT NULL
      )`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS slack_run_presentations_coordinate
       ON slack_run_presentations (workspace_id, channel_id, message_ts)
       WHERE message_ts IS NOT NULL`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS slack_run_presentations_repair
       ON slack_run_presentations (repair_required, updated_at, run_id)`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS slack_workspace_append_budgets (
        workspace_id TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL,
        refill_window_ms INTEGER NOT NULL,
        available INTEGER NOT NULL,
        last_refill_at INTEGER NOT NULL,
        cooldown_until INTEGER,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS slack_presentation_retention_tombstones (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_state TEXT NOT NULL,
        repair_required INTEGER NOT NULL,
        expired_at INTEGER NOT NULL,
        tombstoned_at INTEGER NOT NULL
      )`,
    );
  }

  create(input: SlackRunPresentationCreateInput): SlackRunPresentation {
    validateCreateInput(input);
    return this.db.transaction(() => this.createInTransaction(input));
  }

  /** Composite Slack admission already owns the StateDb transaction. */
  createInTransaction(input: SlackRunPresentationCreateInput): SlackRunPresentation {
    validateCreateInput(input);
    const existing = this.getRow(input.runId);
    if (existing) {
      const presentation = decodePresentation(existing);
      if (!sameCreateIdentity(presentation, input)) {
        throw stateError('identity_conflict', 'Presentation identity is already frozen.');
      }
      return presentation;
    }
    const at = this.now();
    const shared: SlackRunPresentationBase = {
        runId: input.runId,
        turnJobId: input.turnJobId,
        bindingId: input.bindingId,
        workBindingGeneration: input.workBindingGeneration,
        runFencingToken: input.runFencingToken,
        projectionVersion: 1,
        progressiveEligibility: { status: 'pending' },
        ...(input.persona ? { persona: { ...input.persona } } : {}),
        root: { ...input.root },
        stream: {
          state: 'absent',
          acknowledgedByteLength: 0,
          slackAppendCursor: 0,
        },
        ...(input.taskLabels && input.taskLabels.length > 0
          ? { plan: buildPlan(input.runId, input.taskLabels) }
          : {}),
        repairRequired: false,
        createdAt: at,
        updatedAt: at,
    };
    const presentation: SlackRunPresentation = input.schemaVersion === 1
      ? {
          ...shared,
          schemaVersion: 1,
          features: {
            progressiveStreaming: input.features?.progressiveStreaming ?? false,
            nativeTasks: input.features?.nativeTasks ?? false,
          },
        }
      : {
          ...shared,
          schemaVersion: 2,
          progressiveIntent: { status: 'unresolved' },
        };
    this.db.run(
        `INSERT INTO slack_run_presentations (
          run_id, binding_generation, run_fencing_token, projection_version,
          stream_state, workspace_id, channel_id, message_ts, repair_required,
          presentation_json, created_at, updated_at, finalized_at, hard_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, ?)`,
        presentation.runId,
        presentation.workBindingGeneration,
        presentation.runFencingToken,
        presentation.projectionVersion,
        presentation.stream.state,
        presentation.root.workspaceId,
        presentation.root.channelId,
        JSON.stringify(presentation),
        at,
        at,
        at + SLACK_PRESENTATION_RETENTION_MS,
    );
    return presentation;
  }

  get(runId: string): SlackRunPresentation | undefined {
    validateId(runId, 'Run id');
    const row = this.getRow(runId);
    return row ? decodePresentation(row) : undefined;
  }

  transition(input: SlackPresentationTransitionInput): SlackPresentationTransitionResult {
    validateTransitionInput(input);
    return this.db.transaction(() => {
      const row = this.getRow(input.runId);
      if (!row) return { outcome: 'missing' };
      if (
        row.binding_generation !== input.workBindingGeneration ||
        row.run_fencing_token !== input.runFencingToken ||
        row.projection_version !== input.expectedProjectionVersion ||
        row.stream_state !== input.expectedStreamState
      ) {
        return { outcome: 'stale' };
      }
      const current = decodePresentation(row);
      const at = this.now();
      const next = applyMutation(current, input.mutation, at);
      next.projectionVersion = current.projectionVersion + 1;
      next.updatedAt = at;

      if (next.stream.messageTs && next.stream.messageTs !== current.stream.messageTs) {
        const conflict = this.db.get(
          `SELECT run_id FROM slack_run_presentations
           WHERE workspace_id = ? AND channel_id = ? AND message_ts = ? AND run_id <> ?`,
          next.root.workspaceId,
          next.root.channelId,
          next.stream.messageTs,
          next.runId,
        );
        if (conflict) {
          throw stateError('coordinate_conflict', 'Slack coordinate belongs to another Run.');
        }
      }

      const finalizedAt = next.stream.state === 'finalized'
        ? (row.finalized_at ?? at)
        : row.finalized_at;
      const updated = this.db.run(
        `UPDATE slack_run_presentations
         SET run_fencing_token = ?, projection_version = ?, stream_state = ?,
             message_ts = ?, repair_required = ?, presentation_json = ?,
             updated_at = ?, finalized_at = ?
         WHERE run_id = ? AND binding_generation = ? AND run_fencing_token = ?
           AND projection_version = ? AND stream_state = ?`,
        next.runFencingToken,
        next.projectionVersion,
        next.stream.state,
        next.stream.messageTs ?? null,
        next.repairRequired ? 1 : 0,
        JSON.stringify(next),
        at,
        finalizedAt,
        input.runId,
        input.workBindingGeneration,
        input.runFencingToken,
        input.expectedProjectionVersion,
        input.expectedStreamState,
      );
      if (updated.changes !== 1) return { outcome: 'stale' };
      return { outcome: 'applied', presentation: next };
    });
  }

  listRepairRequired(limit = 50): SlackRunPresentation[] {
    const boundedLimit = boundedLimitValue(limit);
    return (this.db.all(
      `SELECT ${PRESENTATION_COLUMNS} FROM slack_run_presentations
       WHERE repair_required = 1 ORDER BY updated_at ASC, run_id ASC LIMIT ?`,
      boundedLimit,
    ) as PresentationRow[]).map(decodePresentation);
  }

  reserveAppend(
    workspaceId: string,
    policy: SlackAppendBudgetPolicy = DEFAULT_SLACK_APPEND_BUDGET,
  ): SlackAppendReservation {
    validateId(workspaceId, 'Workspace id');
    validateBudgetPolicy(policy);
    return this.db.transaction(() => {
      const at = this.now();
      let row = this.getBudget(workspaceId);
      if (!row) {
        this.db.run(
          `INSERT INTO slack_workspace_append_budgets (
            workspace_id, capacity, refill_window_ms, available, last_refill_at,
            cooldown_until, version, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
          workspaceId,
          policy.capacity,
          policy.refillWindowMs,
          policy.capacity,
          at,
          at,
        );
        row = this.getBudget(workspaceId)!;
      }
      assertBudgetPolicy(row, policy);
      if (row.cooldown_until !== null && row.cooldown_until > at) {
        return {
          outcome: 'cooldown',
          retryAt: row.cooldown_until,
          budgetVersion: row.version,
        };
      }
      const elapsedWindows = Math.floor((at - row.last_refill_at) / row.refill_window_ms);
      const available = elapsedWindows > 0
        ? Math.min(row.capacity, row.available + elapsedWindows)
        : row.available;
      const refillAt = elapsedWindows > 0
        ? row.last_refill_at + elapsedWindows * row.refill_window_ms
        : row.last_refill_at;
      if (available <= 0) {
        return {
          outcome: 'exhausted',
          retryAt: refillAt + row.refill_window_ms,
          budgetVersion: row.version,
        };
      }
      const nextVersion = row.version + 1;
      this.db.run(
        `UPDATE slack_workspace_append_budgets
         SET available = ?, last_refill_at = ?, cooldown_until = NULL,
             version = ?, updated_at = ?
         WHERE workspace_id = ? AND version = ?`,
        available - 1,
        refillAt,
        nextVersion,
        at,
        workspaceId,
        row.version,
      );
      return { outcome: 'reserved', budgetVersion: nextVersion };
    });
  }

  applyAppendCooldown(
    workspaceId: string,
    retryAfterMs: number,
    policy: SlackAppendBudgetPolicy = DEFAULT_SLACK_APPEND_BUDGET,
  ): { cooldownUntil: number; budgetVersion: number } {
    validateId(workspaceId, 'Workspace id');
    validateBudgetPolicy(policy);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 15 * 60_000) {
      throw stateError('invalid_input', 'Slack retry delay is invalid.');
    }
    return this.db.transaction(() => {
      const at = this.now();
      let row = this.getBudget(workspaceId);
      if (!row) {
        this.db.run(
          `INSERT INTO slack_workspace_append_budgets (
            workspace_id, capacity, refill_window_ms, available, last_refill_at,
            cooldown_until, version, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
          workspaceId,
          policy.capacity,
          policy.refillWindowMs,
          policy.capacity,
          at,
          at,
        );
        row = this.getBudget(workspaceId)!;
      }
      assertBudgetPolicy(row, policy);
      const cooldownUntil = Math.max(row.cooldown_until ?? 0, at + retryAfterMs);
      const budgetVersion = row.version + 1;
      this.db.run(
        `UPDATE slack_workspace_append_budgets
         SET cooldown_until = ?, version = ?, updated_at = ?
         WHERE workspace_id = ? AND version = ?`,
        cooldownUntil,
        budgetVersion,
        at,
        workspaceId,
        row.version,
      );
      return { cooldownUntil, budgetVersion };
    });
  }

  maintain(limit = 100): { finalizedPurged: number; expiredTombstoned: number } {
    const boundedLimit = boundedLimitValue(limit);
    return this.db.transaction(() => {
      const at = this.now();
      const finalized = this.db.all(
        `SELECT run_id FROM slack_run_presentations
         WHERE finalized_at IS NOT NULL AND finalized_at <= ?
         ORDER BY finalized_at ASC, run_id ASC LIMIT ?`,
        at - SLACK_PRESENTATION_FINALIZED_TTL_MS,
        boundedLimit,
      );
      for (const row of finalized) {
        this.db.run('DELETE FROM slack_run_presentations WHERE run_id = ?', String(row.run_id));
      }
      const remaining = boundedLimit - finalized.length;
      if (remaining <= 0) {
        return { finalizedPurged: finalized.length, expiredTombstoned: 0 };
      }
      const expired = this.db.all(
        `SELECT run_id, stream_state, repair_required, hard_expires_at
         FROM slack_run_presentations
         WHERE hard_expires_at <= ?
         ORDER BY hard_expires_at ASC, run_id ASC LIMIT ?`,
        at,
        remaining,
      );
      for (const row of expired) {
        this.db.run(
          `INSERT INTO slack_presentation_retention_tombstones (
            stream_state, repair_required, expired_at, tombstoned_at
          ) VALUES (?, ?, ?, ?)`,
          String(row.stream_state),
          Number(row.repair_required),
          Number(row.hard_expires_at),
          at,
        );
        this.db.run('DELETE FROM slack_run_presentations WHERE run_id = ?', String(row.run_id));
      }
      return {
        finalizedPurged: finalized.length,
        expiredTombstoned: expired.length,
      };
    });
  }

  listRetentionTombstones(limit = 50): SlackPresentationRetentionTombstone[] {
    return this.db.all(
      `SELECT stream_state, repair_required, expired_at, tombstoned_at
       FROM slack_presentation_retention_tombstones
       ORDER BY sequence ASC LIMIT ?`,
      boundedLimitValue(limit),
    ).map((row) => ({
      streamState: parseStreamState(row.stream_state),
      repairRequired: Number(row.repair_required) === 1,
      expiredAt: Number(row.expired_at),
      tombstonedAt: Number(row.tombstoned_at),
    }));
  }

  summarize(workspaceId: string, limit = 10_000): SlackPresentationSummary {
    validateId(workspaceId, 'Workspace id');
    const bounded = Math.min(10_000, Math.max(1, Math.floor(limit)));
    const total = Number(this.db.get(
      'SELECT COUNT(*) AS count FROM slack_run_presentations WHERE workspace_id = ?',
      workspaceId,
    )?.count ?? 0);
    const rows = this.db.all(
      `SELECT presentation_json FROM slack_run_presentations
       WHERE workspace_id = ? ORDER BY updated_at DESC, run_id DESC LIMIT ?`,
      workspaceId,
      bounded,
    );
    const summary: SlackPresentationSummary = {
      workspaceId,
      total,
      truncated: total > rows.length,
      streamStates: {},
      eligibility: {},
      outcomes: {},
      degradations: {},
    };
    for (const row of rows) {
      const presentation = JSON.parse(String(row.presentation_json)) as SlackRunPresentation;
      increment(summary.streamStates, presentation.stream.state);
      const eligibility = presentation.progressiveEligibility.status === 'pending'
        ? 'pending'
        : presentation.progressiveEligibility.allowed
          ? 'allowed'
          : `denied:${presentation.progressiveEligibility.reason}`;
      increment(summary.eligibility, eligibility);
      increment(summary.outcomes, presentation.stream.presentationOutcome ?? 'pending');
      increment(summary.degradations, presentation.stream.degradationReason ?? 'none');
    }
    return summary;
  }

  private getRow(runId: string): PresentationRow | undefined {
    return this.db.get(
      `SELECT ${PRESENTATION_COLUMNS} FROM slack_run_presentations WHERE run_id = ?`,
      runId,
    ) as PresentationRow | undefined;
  }

  private getBudget(workspaceId: string): BudgetRow | undefined {
    return this.db.get(
      `SELECT workspace_id, capacity, refill_window_ms, available,
              last_refill_at, cooldown_until, version, updated_at
       FROM slack_workspace_append_budgets WHERE workspace_id = ?`,
      workspaceId,
    ) as BudgetRow | undefined;
  }
}

function applyMutation(
  current: SlackRunPresentation,
  mutation: SlackPresentationMutation,
  _at: number,
): SlackRunPresentation {
  const next = structuredClone(current);
  switch (mutation.kind) {
    case 'freeze_progressive_eligibility':
      if (current.progressiveEligibility.status !== 'pending') {
        throw stateError('eligibility_frozen', 'Progressive eligibility is already frozen.');
      }
      if (mutation.eligibility.allowed && mutation.eligibility.reason !== 'safe_early_release') {
        throw stateError('invalid_input', 'Allowed progressive eligibility requires safe release.');
      }
      if (!mutation.eligibility.allowed && mutation.eligibility.reason === 'safe_early_release') {
        throw stateError('invalid_input', 'Denied progressive eligibility requires a closed reason.');
      }
      next.progressiveEligibility = {
        status: 'frozen',
        ...mutation.eligibility,
      };
      return next;
    case 'advance_run_fence':
      if (!Number.isSafeInteger(mutation.runFencingToken) ||
          mutation.runFencingToken <= current.runFencingToken) {
        throw stateError('invalid_input', 'Run fence must advance monotonically.');
      }
      if (!['absent', 'reconciling', 'unknown'].includes(current.stream.state)) {
        throw stateError('invalid_transition', 'An active Slack effect blocks fence advancement.');
      }
      next.runFencingToken = mutation.runFencingToken;
      return next;
    case 'stream_start_intent':
      requireState(current, 'absent');
      next.stream.state = 'starting';
      next.repairRequired = true;
      return next;
    case 'stream_started':
      requireState(current, 'starting');
      validateSlackTimestamp(mutation.messageTs, 'Slack stream coordinate');
      validateId(mutation.flue.instanceId, 'Flue instance id');
      validateId(mutation.flue.submissionId, 'Flue submission id');
      if (mutation.flue.messageId !== undefined) validateId(mutation.flue.messageId, 'Flue message id');
      next.stream.state = 'streaming';
      next.stream.messageTs = mutation.messageTs;
      next.stream.flue = { ...mutation.flue };
      next.repairRequired = false;
      return next;
    case 'append_intent': {
      requireState(current, 'streaming');
      if (current.progressiveEligibility.status !== 'frozen' ||
          !current.progressiveEligibility.allowed) {
        throw stateError('invalid_transition', 'Progressive append is not authorized.');
      }
      if (!current.stream.flue || current.stream.pendingAppend) {
        throw stateError('invalid_transition', 'Another append is pending or Flue is unbound.');
      }
      validatePosition(mutation.position);
      const prior = current.stream.flue.lastAcceptedPosition;
      if (prior && comparePosition(mutation.position, prior) <= 0) {
        throw stateError('cursor_gap', 'Flue position is duplicate or out of order.');
      }
      if (mutation.from !== current.stream.acknowledgedByteLength ||
          !Number.isSafeInteger(mutation.to) || mutation.to <= mutation.from ||
          mutation.to - mutation.from > MAX_SLACK_PENDING_APPEND_BYTES) {
        throw stateError('cursor_gap', 'Append byte cursor is not contiguous or bounded.');
      }
      validateHash(mutation.hash, 'Pending append hash');
      const cursor = current.stream.slackAppendCursor + 1;
      next.stream.flue!.lastAcceptedPosition = { ...mutation.position };
      next.stream.pendingAppend = {
        cursor,
        from: mutation.from,
        to: mutation.to,
        hash: mutation.hash,
      };
      next.repairRequired = true;
      return next;
    }
    case 'append_acknowledged': {
      requireState(current, 'streaming');
      const pending = current.stream.pendingAppend;
      if (!pending || mutation.cursor !== pending.cursor ||
          mutation.cursor !== current.stream.slackAppendCursor + 1) {
        throw stateError('cursor_gap', 'Slack append acknowledgement is not contiguous.');
      }
      validateHash(mutation.acknowledgedPrefixHash, 'Acknowledged prefix hash');
      if (mutation.acknowledgedPrefixHash !== pending.hash) {
        throw stateError('cursor_gap', 'Slack append acknowledgement hash does not match intent.');
      }
      next.stream.acknowledgedByteLength = pending.to;
      next.stream.slackAppendCursor = pending.cursor;
      next.stream.acknowledgedPrefixHash = mutation.acknowledgedPrefixHash;
      delete next.stream.pendingAppend;
      next.repairRequired = false;
      return next;
    }
    case 'append_rejected': {
      requireState(current, 'streaming');
      const pending = current.stream.pendingAppend;
      if (!pending || mutation.cursor !== pending.cursor) {
        throw stateError('cursor_gap', 'Slack append rejection does not match its intent.');
      }
      delete next.stream.pendingAppend;
      next.repairRequired = false;
      return next;
    }
    case 'close_stream':
      requireState(current, 'streaming');
      if (current.stream.pendingAppend) {
        throw stateError('invalid_transition', 'A pending append must be reconciled before close.');
      }
      next.stream.state = 'reconciling';
      if (mutation.outcome) next.stream.presentationOutcome = mutation.outcome;
      if (mutation.degradationReason) next.stream.degradationReason = mutation.degradationReason;
      return next;
    case 'mark_finalizing':
      requireState(current, 'reconciling');
      next.stream.state = 'finalizing';
      next.repairRequired = true;
      return next;
    case 'mark_fallback':
      requireState(current, 'starting');
      next.stream.state = 'fallback';
      next.stream.presentationOutcome = mutation.outcome;
      // A confirmed stream rejection still requires the fallback artifact.
      // Keep it visible to repair until that post has an exact receipt.
      next.repairRequired = true;
      return next;
    case 'mark_artifact_delivered':
      if (current.stream.state !== 'finalizing' && current.stream.state !== 'fallback') {
        throw stateError('invalid_transition', 'Only a finalizing or fallback artifact can deliver.');
      }
      if (mutation.messageTs !== undefined) {
        if (current.stream.state !== 'fallback' || current.stream.messageTs) {
          throw stateError('coordinate_conflict', 'Fallback coordinate is not assignable.');
        }
        validateSlackTimestamp(mutation.messageTs, 'Slack fallback coordinate');
        next.stream.messageTs = mutation.messageTs;
      }
      next.stream.state = 'artifact_delivered';
      next.stream.presentationOutcome = mutation.outcome;
      next.repairRequired = false;
      return next;
    case 'mark_finalized':
      requireState(current, 'artifact_delivered');
      next.stream.state = 'finalized';
      next.repairRequired = false;
      return next;
    case 'mark_non_stream_finalized':
      requireState(current, 'absent');
      next.stream.state = 'finalized';
      next.stream.presentationOutcome = 'terminal_only';
      next.repairRequired = false;
      return next;
    case 'mark_unknown':
      if (current.stream.state === 'finalized') {
        throw stateError('terminal_rewrite', 'A finalized presentation is immutable.');
      }
      next.stream.state = 'unknown';
      next.stream.presentationOutcome = 'unknown';
      next.stream.degradationReason = mutation.degradationReason;
      next.repairRequired = true;
      return next;
    case 'adopt_plan': {
      // A substantive @-mention is classified AFTER Work admission froze this
      // presentation, so — unlike ambient/obvious-work turns — its work
      // checklist never reached buildPlan at create time. Attach the plan now,
      // but only before any Slack effect, only when native tasks are on, and
      // only when no plan is already frozen: ambient/obvious-work turns carry
      // their plan from admission and must never be re-attached or reordered.
      if (current.plan) {
        throw stateError('terminal_rewrite', 'A native plan is already frozen.');
      }
      if (!presentationUsesNativeTasks(current)) {
        throw stateError('invalid_transition', 'Native tasks are disabled for this presentation.');
      }
      requireState(current, 'absent');
      next.plan = buildPlan(current.runId, mutation.taskLabels);
      return next;
    }
    case 'set_task_status': {
      if (!current.plan) {
        throw stateError('invalid_transition', 'Ordinary replies have no native tasks.');
      }
      const statuses = new Set(current.plan.tasks.map((task) => task.status));
      if (statuses.size !== 1) {
        throw stateError('invalid_transition', 'Native task state is not Run-coherent.');
      }
      const existing = current.plan.tasks[0]!.status;
      if (existing === 'complete' || existing === 'error') {
        throw stateError('terminal_rewrite', 'Terminal native tasks are immutable.');
      }
      if (mutation.status === 'in_progress' && existing !== 'pending') {
        throw stateError('invalid_transition', 'Native tasks can begin only once.');
      }
      next.plan!.tasks = current.plan.tasks.map((task) => ({
        ...task,
        status: mutation.status,
      }));
      return next;
    }
    case 'record_title_intent':
      if (current.title) {
        throw stateError('terminal_rewrite', 'Title ownership is already frozen.');
      }
      validateHash(mutation.valueHash, 'Title value hash');
      next.title = { valueHash: mutation.valueHash, outcome: 'pending' };
      return next;
    case 'record_title_outcome':
      if (!current.title || current.title.outcome !== 'pending') {
        throw stateError('terminal_rewrite', 'Title outcome is already terminal or missing.');
      }
      next.title = { ...current.title, outcome: mutation.outcome };
      return next;
  }
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function isProgressiveIntent(value: unknown): value is SlackProgressiveIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Record<string, unknown>;
  if (intent.status === 'unresolved') return Object.keys(intent).length === 1;
  if (intent.status === 'pending') {
    return typeof intent.toolCallId === 'string' && intent.toolCallId.length > 0;
  }
  if (intent.status === 'requested' || intent.status === 'not_requested') {
    const decidedAt = intent.status === 'requested' ? intent.requestedAt : intent.decidedAt;
    return typeof decidedAt === 'number' && Number.isSafeInteger(decidedAt) && decidedAt >= 0;
  }
  if (intent.status === 'denied') {
    return typeof intent.reason === 'string' &&
      typeof intent.decidedAt === 'number' &&
      Number.isSafeInteger(intent.decidedAt) &&
      intent.decidedAt >= 0;
  }
  return false;
}

function buildPlan(runId: string, labels: readonly string[]): SlackPresentationPlan {
  if (labels.length < 1 || labels.length > 4) {
    throw stateError('invalid_input', 'Native task count must be between one and four.');
  }
  const tasks = labels.map((label, index) => {
    validateLabel(label);
    const digest = createHash('sha256')
      .update(`${runId}\0${index + 1}`)
      .digest('hex')
      .slice(0, 24);
    return {
      id: `task_${digest}_${index + 1}`,
      title: label,
      status: 'pending' as const,
    };
  });
  return { displayMode: tasks.length === 1 ? 'timeline' : 'plan', tasks };
}

function validateCreateInput(input: SlackRunPresentationCreateInput): void {
  validateId(input.runId, 'Run id');
  validateId(input.turnJobId, 'TurnJob id');
  validateId(input.bindingId, 'Binding id');
  validatePositiveInteger(input.workBindingGeneration, 'Work binding generation');
  validateNonNegativeInteger(input.runFencingToken, 'Run fencing token');
  validateId(input.root.workspaceId, 'Workspace id');
  validateId(input.root.channelId, 'Channel id');
  validateSlackTimestamp(input.root.threadTs, 'Slack root timestamp');
  validateId(input.root.requesterUserId, 'Requester user id');
  if (input.persona) {
    validateLabel(input.persona.name);
    validatePositiveInteger(input.persona.avatarRevision, 'Avatar revision');
    if (!/^https:\/\//.test(input.persona.avatarUrl) || input.persona.avatarUrl.length > 2_048) {
      throw stateError('invalid_input', 'Avatar URL must be a bounded HTTPS URL.');
    }
  }
  if (input.taskLabels !== undefined) buildPlan(input.runId, input.taskLabels);
}

function validateTransitionInput(input: SlackPresentationTransitionInput): void {
  validateId(input.runId, 'Run id');
  validatePositiveInteger(input.workBindingGeneration, 'Work binding generation');
  validateNonNegativeInteger(input.runFencingToken, 'Run fencing token');
  validatePositiveInteger(input.expectedProjectionVersion, 'Projection version');
  parseStreamState(input.expectedStreamState);
}

function sameCreateIdentity(
  presentation: SlackRunPresentation,
  input: SlackRunPresentationCreateInput,
): boolean {
  const expectedPlan = input.taskLabels && input.taskLabels.length > 0
    ? buildPlan(input.runId, input.taskLabels)
    : undefined;
  return presentation.runId === input.runId &&
    presentation.turnJobId === input.turnJobId &&
    presentation.bindingId === input.bindingId &&
    presentation.workBindingGeneration === input.workBindingGeneration &&
    presentation.runFencingToken === input.runFencingToken &&
    JSON.stringify(presentation.root) === JSON.stringify(input.root) &&
    JSON.stringify(presentation.persona) === JSON.stringify(input.persona) &&
    JSON.stringify(presentation.plan) === JSON.stringify(expectedPlan);
}

function decodePresentation(row: PresentationRow): SlackRunPresentation {
  let value: unknown;
  try {
    value = JSON.parse(row.presentation_json);
  } catch {
    throw stateError('invalid_input', 'Stored presentation JSON is invalid.');
  }
  if (!value || typeof value !== 'object') {
    throw stateError('invalid_input', 'Stored presentation shape is invalid.');
  }
  const presentation = value as SlackRunPresentation;
  if (
    (presentation.schemaVersion !== 1 && presentation.schemaVersion !== 2) ||
    presentation.runId !== row.run_id ||
    presentation.workBindingGeneration !== row.binding_generation ||
    presentation.runFencingToken !== row.run_fencing_token ||
    presentation.projectionVersion !== row.projection_version ||
    presentation.stream?.state !== row.stream_state ||
    presentation.root?.workspaceId !== row.workspace_id ||
    presentation.root?.channelId !== row.channel_id ||
    (presentation.stream.messageTs ?? null) !== row.message_ts ||
    presentation.repairRequired !== (row.repair_required === 1)
  ) {
    throw stateError('invalid_input', 'Stored presentation columns do not match payload.');
  }
  if (
    (presentation.schemaVersion === 1 &&
      (typeof presentation.features?.progressiveStreaming !== 'boolean' ||
        typeof presentation.features?.nativeTasks !== 'boolean')) ||
    (presentation.schemaVersion === 2 && !isProgressiveIntent(presentation.progressiveIntent))
  ) {
    throw stateError('invalid_input', 'Stored presentation version payload is invalid.');
  }
  return structuredClone(presentation);
}

function requireState(
  presentation: SlackRunPresentation,
  expected: SlackPresentationStreamState,
): void {
  if (presentation.stream.state === 'finalized') {
    throw stateError('terminal_rewrite', 'A finalized presentation is immutable.');
  }
  if (presentation.stream.state !== expected) {
    throw stateError('invalid_transition', `Presentation is not ${expected}.`);
  }
}

function validateId(value: string, label: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw stateError('invalid_input', `${label} is invalid.`);
  }
}

function validateLabel(value: string): void {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 ||
      new TextEncoder().encode(value).byteLength > 240 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw stateError('invalid_input', 'Native task title is invalid.');
  }
}

function validateSlackTimestamp(value: string, label: string): void {
  if (typeof value !== 'string' || !/^\d{1,16}\.\d{1,16}$/.test(value)) {
    throw stateError('invalid_input', `${label} is invalid.`);
  }
}

function validatePosition(position: { batch: number; index: number }): void {
  validateNonNegativeInteger(position.batch, 'Flue batch position');
  validateNonNegativeInteger(position.index, 'Flue index position');
}

function comparePosition(
  left: { batch: number; index: number },
  right: { batch: number; index: number },
): number {
  return left.batch === right.batch ? left.index - right.index : left.batch - right.batch;
}

function validateHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw stateError('invalid_input', `${label} is invalid.`);
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw stateError('invalid_input', `${label} is invalid.`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw stateError('invalid_input', `${label} is invalid.`);
  }
}

function boundedLimitValue(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw stateError('invalid_input', 'Presentation query limit is invalid.');
  }
  return limit;
}

function validateBudgetPolicy(policy: SlackAppendBudgetPolicy): void {
  if (!Number.isSafeInteger(policy.capacity) || policy.capacity < 1 || policy.capacity > 100 ||
      !Number.isSafeInteger(policy.refillWindowMs) ||
      policy.refillWindowMs < 250 || policy.refillWindowMs > 60_000) {
    throw stateError('invalid_input', 'Slack append budget policy is invalid.');
  }
}

function assertBudgetPolicy(row: BudgetRow, policy: SlackAppendBudgetPolicy): void {
  if (row.capacity !== policy.capacity || row.refill_window_ms !== policy.refillWindowMs) {
    throw stateError('budget_policy_conflict', 'Slack append budget policy is already frozen.');
  }
}

function parseStreamState(value: unknown): SlackPresentationStreamState {
  if (
    value === 'absent' || value === 'starting' || value === 'streaming' ||
    value === 'reconciling' || value === 'finalizing' ||
    value === 'artifact_delivered' || value === 'finalized' ||
    value === 'fallback' || value === 'unknown'
  ) return value;
  throw stateError('invalid_input', 'Presentation stream state is invalid.');
}

function stateError(
  code: SlackPresentationStateErrorCode,
  message: string,
): SlackPresentationStateError {
  return new SlackPresentationStateError(code, message);
}
