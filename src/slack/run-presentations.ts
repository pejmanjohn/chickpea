import { createHash } from 'node:crypto';

import type { StateDb } from '../state/state-db.ts';
import type { ActivityKind } from '../activity/status.ts';
import { hasCredentialLikeContent } from '../security/content-validation.ts';

export const SLACK_PRESENTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SLACK_PRESENTATION_FINALIZED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_SLACK_PENDING_APPEND_BYTES = 128 * 1_024;

export const DEFAULT_SLACK_APPEND_BUDGET = {
  capacity: 1,
  refillWindowMs: 1_000,
} as const;

export const DEFAULT_SLACK_ACTIVITY_STATUS_BUDGET = {
  // Admission and the first observed phase may occur in the same second.
  // Later observed phases are already serialized by the one-second turn queue.
  capacity: 2,
  refillWindowMs: 1_000,
} as const;

export type SlackProgressiveEligibilityReason =
  | 'safe_early_release'
  | 'operations_disabled'
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
  | { status: 'requested'; toolCallId: string; requestedAt: number }
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

export type SlackPresentationOwner =
  | { kind: 'selected_agent'; persona: SlackPresentationPersona }
  | { kind: 'chickpea' };

export type SlackPresentationReceiptCertainty =
  | 'pending'
  | 'acknowledged'
  | 'failed'
  | 'unknown';

export interface SlackPresentationOperationReceipt {
  operationId: string;
  certainty: SlackPresentationReceiptCertainty;
}

export type SlackPresentationActivityKind = ActivityKind;

export interface SlackPresentationActivity {
  kind: SlackPresentationActivityKind;
  action: string;
  object: string;
  generation: number;
  sequence: number;
  operation: SlackPresentationOperationReceipt;
}

/** Durable coordinate for the one visible activity artifact owned by this Run. */
export type SlackPresentationActivityProjection =
  | { surface: 'unselected'; state: 'absent' }
  | {
      surface: 'message';
      state: 'selected' | 'visible' | 'cleared';
      messageTs?: string;
    }
  | {
      surface: 'assistant_status';
      state: 'selected' | 'visible' | 'cleared';
    };

export type SlackPresentationTaskOutcome =
  | 'completed'
  | 'changed'
  | 'skipped'
  | 'failed'
  | 'not_run';

export type SlackPresentationLifecyclePhase =
  | 'admitted'
  | 'active'
  | 'terminal_intended'
  | 'settled'
  | 'recovery_required';

/** Slack Agent Session state vocabulary; delivery outcome is intentionally separate. */
export type SlackPresentationAgentSessionState =
  | 'processing'
  | 'active'
  | 'suspended'
  | 'closed';

export interface SlackPresentationAgentSession {
  desired: SlackPresentationAgentSessionState;
  acknowledged: SlackPresentationAgentSessionState | 'none';
  operation?: SlackPresentationOperationReceipt;
  /** Terminal reason this shared effect no longer requires repair. */
  disposition?: 'superseded' | 'unavailable';
}

export type SlackPresentationTerminalDelivery =
  | { state: 'none' }
  | {
      state: 'intended';
      result: 'answer' | 'failure' | 'legacy';
      operation: SlackPresentationOperationReceipt;
    };

export type SlackPresentationCleanup =
  | { state: 'not_required'; disposition?: 'superseded' }
  | {
      state: 'required';
      target: 'activity' | 'agent_session';
      operation: SlackPresentationOperationReceipt;
    };

export interface SlackPresentationRepairSchedule {
  attempts: number;
  nextRetryAt: number;
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

export interface SlackPresentationTaskV3 {
  id: string;
  title: string;
  /** Slack-compatible projection status; semantic outcome remains authoritative. */
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  outcome?: SlackPresentationTaskOutcome;
  detail?: string;
}

export interface SlackPresentationPlanV3 {
  displayMode: 'timeline' | 'plan';
  tasks: SlackPresentationTaskV3[];
}

export interface SlackPresentationTelemetry {
  eligibilityDecidedAt?: number;
  firstProgressiveEffectAt?: number;
}

interface SlackRunPresentationBase {
  runId: string;
  turnJobId: string;
  bindingId: string;
  workBindingGeneration: number;
  runFencingToken: number;
  projectionVersion: number;
  progressiveEligibility: SlackProgressiveEligibility;
  root: SlackPresentationRoot;
  stream: SlackPresentationStream;
  title?: { valueHash: string; outcome: 'pending' | 'set' | 'failed' };
  /** Content-free event times used only for aggregate delivery evidence. */
  telemetry?: SlackPresentationTelemetry;
  repairRequired: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SlackRunPresentationV1 extends SlackRunPresentationBase {
  schemaVersion: 1;
  /** Immutable legacy Agent authorship captured before any Slack effect. */
  persona?: SlackPresentationPersona;
  plan?: SlackPresentationPlan;
  features: {
    progressiveStreaming: boolean;
    nativeTasks: boolean;
  };
}

export interface SlackRunPresentationV2 extends SlackRunPresentationBase {
  schemaVersion: 2;
  /** Immutable legacy Agent authorship captured before any Slack effect. */
  persona?: SlackPresentationPersona;
  plan?: SlackPresentationPlan;
  progressiveIntent: SlackProgressiveIntent;
}

export interface SlackRunPresentationV3 extends SlackRunPresentationBase {
  schemaVersion: 3;
  /** Preserves the established progressive-intent state machine across the V3 boundary. */
  progressiveIntent: SlackProgressiveIntent;
  /** Frozen before the first visible effect. Chickpea intentionally has no synthetic persona. */
  owner: SlackPresentationOwner;
  /** V3 callers use owner; this property remains absent on durable V3 state. */
  persona?: never;
  sessionGeneration: number;
  currentActivity?: SlackPresentationActivity;
  activityProjection: SlackPresentationActivityProjection;
  lifecyclePhase: SlackPresentationLifecyclePhase;
  agentSession: SlackPresentationAgentSession;
  terminalDelivery: SlackPresentationTerminalDelivery;
  cleanup: SlackPresentationCleanup;
  /** Durable pacing for background repair, absent until the first drain attempt. */
  repair?: SlackPresentationRepairSchedule;
  plan?: SlackPresentationPlanV3;
  compatibility: {
    sourceSchemaVersion: 1 | 2 | 3;
    legacyPersona?: SlackPresentationPersona;
    legacyFeatures?: SlackRunPresentationV1['features'];
    legacyProgressiveIntent?: SlackProgressiveIntent;
  };
}

export type SlackRunPresentation =
  | SlackRunPresentationV1
  | SlackRunPresentationV2
  | SlackRunPresentationV3;

/**
 * Upgrade legacy product truth in memory without claiming that a legacy persona
 * was a reliable selected-Agent capability. Coordinates remain byte-for-byte
 * identical; callers may persist the result with `upgrade_to_v3` later.
 */
export function upgradeSlackRunPresentation(
  presentation: SlackRunPresentation,
): SlackRunPresentationV3 {
  if (presentation.schemaVersion === 3) return structuredClone(presentation);
  const lifecyclePhase = legacyLifecyclePhase(presentation.stream.state);
  const terminalDelivery = legacyTerminalDelivery(presentation);
  return {
    schemaVersion: 3,
    runId: presentation.runId,
    turnJobId: presentation.turnJobId,
    bindingId: presentation.bindingId,
    workBindingGeneration: presentation.workBindingGeneration,
    runFencingToken: presentation.runFencingToken,
    projectionVersion: presentation.projectionVersion,
    progressiveEligibility: structuredClone(presentation.progressiveEligibility),
    progressiveIntent: presentation.schemaVersion === 2
      ? structuredClone(presentation.progressiveIntent)
      : { status: 'not_requested', decidedAt: presentation.createdAt },
    owner: { kind: 'chickpea' },
    sessionGeneration: presentation.workBindingGeneration,
    activityProjection: { surface: 'unselected', state: 'absent' },
    root: structuredClone(presentation.root),
    stream: structuredClone(presentation.stream),
    ...(presentation.plan ? { plan: upgradeLegacyPlan(presentation.plan) } : {}),
    ...(presentation.title ? { title: structuredClone(presentation.title) } : {}),
    ...(presentation.telemetry
      ? { telemetry: structuredClone(presentation.telemetry) }
      : {}),
    lifecyclePhase,
    agentSession: {
      desired: lifecyclePhase === 'settled' ? 'active' : 'processing',
      acknowledged: 'none',
    },
    terminalDelivery,
    cleanup: { state: 'not_required' },
    compatibility: {
      sourceSchemaVersion: presentation.schemaVersion,
      ...(presentation.persona
        ? { legacyPersona: structuredClone(presentation.persona) }
        : {}),
      ...(presentation.schemaVersion === 1
        ? { legacyFeatures: structuredClone(presentation.features) }
        : { legacyProgressiveIntent: structuredClone(presentation.progressiveIntent) }),
    },
    repairRequired: presentation.repairRequired,
    createdAt: presentation.createdAt,
    updatedAt: presentation.updatedAt,
  };
}

export function presentationAllowsProgressive(
  presentation: SlackRunPresentation,
): boolean {
  return presentation.schemaVersion !== 1 || presentation.features.progressiveStreaming;
}

export function presentationUsesNativeTasks(
  presentation: SlackRunPresentation,
): boolean {
  return presentation.schemaVersion !== 1 || presentation.features.nativeTasks;
}

interface SlackRunPresentationCreateInputBase {
  runId: string;
  turnJobId: string;
  bindingId: string;
  workBindingGeneration: number;
  runFencingToken: number;
  root: SlackPresentationRoot;
  taskLabels?: readonly string[];
}

export type SlackRunPresentationCreateInput =
  | (SlackRunPresentationCreateInputBase & {
      /** Test and migration seam only. New admissions continue to default to V2. */
      schemaVersion?: 1 | 2;
      features?: Partial<SlackRunPresentationV1['features']>;
      persona?: SlackPresentationPersona;
    })
  | (SlackRunPresentationCreateInputBase & {
      schemaVersion: 3;
      owner: SlackPresentationOwner;
      sessionGeneration: number;
      /** Absent freezes this run to native Agent Session lifecycle only. */
      currentActivity?: SlackPresentationActivity;
      features?: never;
      persona?: never;
    });

export type SlackPresentationMutation =
  | { kind: 'upgrade_to_v3' }
  | {
      kind: 'freeze_progressive_eligibility';
      eligibility: {
        allowed: boolean;
        reason: SlackProgressiveEligibilityReason;
      };
    }
  | { kind: 'advance_run_fence'; runFencingToken: number }
  | { kind: 'progressive_intent_candidate'; toolCallId: string }
  | { kind: 'progressive_intent_requested'; toolCallId: string }
  | { kind: 'progressive_intent_not_requested' }
  | {
      kind: 'progressive_intent_denied';
      reason: SlackProgressiveIntentDenialReason;
    }
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
  | {
      kind: 'transition_task';
      taskId: string;
      to: 'in_progress' | SlackPresentationTaskOutcome;
      detail?: string;
    }
  | { kind: 'set_lifecycle_phase'; phase: SlackPresentationLifecyclePhase }
  | { kind: 'record_repair_attempt'; nextRetryAt: number }
  | { kind: 'set_current_activity'; activity: SlackPresentationActivity }
  | { kind: 'retry_activity'; operationId: string }
  | {
      kind: 'select_activity_projection';
      surface: Exclude<SlackPresentationActivityProjection['surface'], 'unselected'>;
    }
  | {
      kind: 'record_activity_receipt';
      operationId: string;
      certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>;
      messageTs?: string;
    }
  | {
      kind: 'set_agent_session_desired';
      desired: SlackPresentationAgentSessionState;
      operationId: string;
    }
  | {
      kind: 'record_agent_session_receipt';
      operationId: string;
      certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>;
      acknowledged?: SlackPresentationAgentSessionState;
    }
  | { kind: 'retry_agent_session'; operationId: string }
  | { kind: 'mark_agent_session_unavailable' }
  | { kind: 'supersede_shared_repair_effects' }
  | {
      kind: 'record_terminal_delivery_intent';
      operationId: string;
      result: 'answer' | 'failure';
    }
  | {
      kind: 'record_terminal_delivery_receipt';
      operationId: string;
      certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>;
    }
  | { kind: 'supersede_failed_answer_delivery'; operationId: string }
  | { kind: 'retry_terminal_delivery'; operationId: string }
  | {
      kind: 'record_cleanup_intent';
      operationId: string;
      target: 'activity' | 'agent_session';
    }
  | {
      kind: 'record_cleanup_receipt';
      operationId: string;
      certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>;
    }
  | { kind: 'retry_cleanup'; operationId: string }
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
  offers: Record<string, number>;
  intents: Record<string, number>;
  policyOutcomes: Record<string, number>;
  acceptedBytes: { total: number; max: number };
  latencyMs: {
    offerToRequest: SlackPresentationLatencySummary;
    requestToFirstEffect: SlackPresentationLatencySummary;
    total: SlackPresentationLatencySummary;
  };
}

export interface SlackPresentationLatencySummary {
  count: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

export interface SlackPresentationFinalizationRecord {
  schemaVersion: 1;
  runRef: string;
  presentationSchemaVersion: 1 | 2 | 3;
  offer: string;
  intent: string;
  policyOutcome: string;
  deliveryOutcome: SlackPresentationOutcome | 'pending';
  degradation: SlackPresentationDegradationReason | 'none';
  acceptedBytes: number;
  timingMs: {
    offerToRequest?: number;
    requestToFirstEffect?: number;
    total: number;
  };
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
      `CREATE TABLE IF NOT EXISTS slack_workspace_activity_status_budgets (
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
        root: { ...input.root },
        stream: {
          state: 'absent',
          acknowledgedByteLength: 0,
          slackAppendCursor: 0,
        },
        repairRequired: false,
        createdAt: at,
        updatedAt: at,
    };
    let presentation: SlackRunPresentation;
    if (input.schemaVersion === 3) {
      presentation = {
        ...shared,
        schemaVersion: 3,
        progressiveIntent: { status: 'unresolved' },
        owner: structuredClone(input.owner),
        sessionGeneration: input.sessionGeneration,
        ...(input.currentActivity
          ? { currentActivity: structuredClone(input.currentActivity) }
          : {}),
        activityProjection: { surface: 'unselected', state: 'absent' },
        lifecyclePhase: 'admitted',
        agentSession: { desired: 'processing', acknowledged: 'none' },
        terminalDelivery: { state: 'none' },
        cleanup: { state: 'not_required' },
        ...(input.taskLabels && input.taskLabels.length > 1
          ? { plan: buildPlanV3(input.runId, input.taskLabels) }
          : {}),
        compatibility: { sourceSchemaVersion: 3 },
        repairRequired: true,
      };
    } else {
      const legacyShared = {
        ...shared,
        ...(input.persona ? { persona: { ...input.persona } } : {}),
        ...(input.taskLabels && input.taskLabels.length > 0
          ? { plan: buildPlan(input.runId, input.taskLabels) }
          : {}),
      };
      presentation = input.schemaVersion === 1
        ? {
            ...legacyShared,
            schemaVersion: 1,
            features: {
              progressiveStreaming: input.features?.progressiveStreaming ?? false,
              nativeTasks: input.features?.nativeTasks ?? false,
            },
          }
        : {
            ...legacyShared,
            schemaVersion: 2,
            progressiveIntent: { status: 'unresolved' },
          };
    }
    this.db.run(
        `INSERT INTO slack_run_presentations (
          run_id, binding_generation, run_fencing_token, projection_version,
          stream_state, workspace_id, channel_id, message_ts, repair_required,
          presentation_json, created_at, updated_at, finalized_at, hard_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
        presentation.runId,
        presentation.workBindingGeneration,
        presentation.runFencingToken,
        presentation.projectionVersion,
        presentation.stream.state,
        presentation.root.workspaceId,
        presentation.root.channelId,
        presentation.repairRequired ? 1 : 0,
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

  /** Deterministic compatibility read. It never rewrites the stored row. */
  getV3(runId: string): SlackRunPresentationV3 | undefined {
    const presentation = this.get(runId);
    return presentation ? upgradeSlackRunPresentation(presentation) : undefined;
  }

  /** Exact durable generation fence for shared lifecycle effects in one Slack thread. */
  getLatestThreadSessionGeneration(
    root: Pick<SlackPresentationRoot, 'workspaceId' | 'channelId' | 'threadTs'>,
  ): number | undefined {
    validateId(root.workspaceId, 'Workspace id');
    validateId(root.channelId, 'Channel id');
    validateSlackTimestamp(root.threadTs, 'Slack root timestamp');
    const row = this.db.get(
      `SELECT MAX(CAST(json_extract(presentation_json, '$.sessionGeneration') AS INTEGER))
         AS session_generation
       FROM slack_run_presentations
       WHERE workspace_id = ? AND channel_id = ?
         AND json_extract(presentation_json, '$.schemaVersion') = 3
         AND json_extract(presentation_json, '$.root.threadTs') = ?`,
      root.workspaceId,
      root.channelId,
      root.threadTs,
    );
    if (row?.session_generation === null || row?.session_generation === undefined) {
      return undefined;
    }
    const generation = Number(row.session_generation);
    validatePositiveInteger(generation, 'Session generation');
    return generation;
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
      if (next.schemaVersion === 3) next.repairRequired = v3RepairRequired(next);
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

  /** Rows whose acknowledged V3 terminal can be repaired without replaying it. */
  listAutoRepairableV3(limit = 50): SlackRunPresentationV3[] {
    const boundedLimit = boundedLimitValue(limit);
    return (this.db.all(
      `SELECT ${PRESENTATION_COLUMNS} FROM slack_run_presentations
       WHERE repair_required = 1
         AND json_extract(presentation_json, '$.schemaVersion') = 3
         AND json_extract(presentation_json, '$.terminalDelivery.state') = 'intended'
         AND json_extract(presentation_json, '$.terminalDelivery.operation.certainty') = 'acknowledged'
         AND (
           json_extract(presentation_json, '$.lifecyclePhase') <> 'settled'
           OR
           (
             json_type(presentation_json, '$.agentSession.disposition') IS NULL
             AND (
               json_type(presentation_json, '$.agentSession.operation') IS NULL
               OR json_extract(presentation_json, '$.agentSession.operation.certainty') = 'failed'
             )
           )
           OR (
             json_extract(presentation_json, '$.activityProjection.state') = 'visible'
             AND json_type(presentation_json, '$.cleanup.disposition') IS NULL
             AND (
               json_extract(presentation_json, '$.cleanup.state') = 'not_required'
               OR json_extract(presentation_json, '$.cleanup.operation.certainty') = 'failed'
             )
           )
         )
       ORDER BY updated_at ASC, run_id ASC LIMIT ?`,
      boundedLimit,
    ) as PresentationRow[]).map(decodePresentation).filter(
      (presentation): presentation is SlackRunPresentationV3 => presentation.schemaVersion === 3,
    );
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

  reserveActivityStatus(
    workspaceId: string,
    policy: SlackAppendBudgetPolicy = DEFAULT_SLACK_ACTIVITY_STATUS_BUDGET,
  ): SlackAppendReservation {
    return this.reserveBudget(
      'slack_workspace_activity_status_budgets',
      workspaceId,
      policy,
    );
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

  applyActivityStatusCooldown(
    workspaceId: string,
    retryAfterMs: number,
    policy: SlackAppendBudgetPolicy = DEFAULT_SLACK_ACTIVITY_STATUS_BUDGET,
  ): { cooldownUntil: number; budgetVersion: number } {
    return this.applyBudgetCooldown(
      'slack_workspace_activity_status_budgets',
      workspaceId,
      retryAfterMs,
      policy,
    );
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
      offers: {},
      intents: {},
      policyOutcomes: {},
      acceptedBytes: { total: 0, max: 0 },
      latencyMs: {
        offerToRequest: emptyLatencySummary(),
        requestToFirstEffect: emptyLatencySummary(),
        total: emptyLatencySummary(),
      },
    };
    const offerToRequest: number[] = [];
    const requestToFirstEffect: number[] = [];
    const totalLatency: number[] = [];
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
      increment(summary.offers, presentationOffer(presentation));
      increment(summary.intents, presentationIntent(presentation));
      increment(summary.policyOutcomes, presentationPolicyOutcome(presentation));
      summary.acceptedBytes.total += presentation.stream.acknowledgedByteLength;
      summary.acceptedBytes.max = Math.max(
        summary.acceptedBytes.max,
        presentation.stream.acknowledgedByteLength,
      );
      collectPresentationLatencies(
        presentation,
        offerToRequest,
        requestToFirstEffect,
        totalLatency,
      );
    }
    summary.latencyMs.offerToRequest = summarizeLatency(offerToRequest);
    summary.latencyMs.requestToFirstEffect = summarizeLatency(requestToFirstEffect);
    summary.latencyMs.total = summarizeLatency(totalLatency);
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

  private reserveBudget(
    table: 'slack_workspace_activity_status_budgets',
    workspaceId: string,
    policy: SlackAppendBudgetPolicy,
  ): SlackAppendReservation {
    validateId(workspaceId, 'Workspace id');
    validateBudgetPolicy(policy);
    return this.db.transaction(() => {
      const at = this.now();
      let row = this.getNamedBudget(table, workspaceId);
      if (!row) {
        this.db.run(
          `INSERT INTO ${table} (
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
        row = this.getNamedBudget(table, workspaceId)!;
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
        `UPDATE ${table}
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

  private applyBudgetCooldown(
    table: 'slack_workspace_activity_status_budgets',
    workspaceId: string,
    retryAfterMs: number,
    policy: SlackAppendBudgetPolicy,
  ): { cooldownUntil: number; budgetVersion: number } {
    validateId(workspaceId, 'Workspace id');
    validateBudgetPolicy(policy);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 15 * 60_000) {
      throw stateError('invalid_input', 'Slack retry delay is invalid.');
    }
    return this.db.transaction(() => {
      const at = this.now();
      let row = this.getNamedBudget(table, workspaceId);
      if (!row) {
        this.db.run(
          `INSERT INTO ${table} (
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
        row = this.getNamedBudget(table, workspaceId)!;
      }
      assertBudgetPolicy(row, policy);
      const cooldownUntil = Math.max(row.cooldown_until ?? 0, at + retryAfterMs);
      const budgetVersion = row.version + 1;
      this.db.run(
        `UPDATE ${table}
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

  private getNamedBudget(
    table: 'slack_workspace_activity_status_budgets',
    workspaceId: string,
  ): BudgetRow | undefined {
    return this.db.get(
      `SELECT workspace_id, capacity, refill_window_ms, available,
              last_refill_at, cooldown_until, version, updated_at
       FROM ${table} WHERE workspace_id = ?`,
      workspaceId,
    ) as BudgetRow | undefined;
  }
}

function applyMutation(
  current: SlackRunPresentation,
  mutation: SlackPresentationMutation,
  at: number,
): SlackRunPresentation {
  const next = structuredClone(current);
  switch (mutation.kind) {
    case 'upgrade_to_v3':
      if (current.schemaVersion === 3) {
        throw stateError('terminal_rewrite', 'Presentation is already V3.');
      }
      return upgradeSlackRunPresentation(current);
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
      next.telemetry = { ...current.telemetry, eligibilityDecidedAt: at };
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
    case 'progressive_intent_candidate':
      requireProgressiveIntent(current);
      requireProgressiveIntentState(current, 'unresolved');
      validateId(mutation.toolCallId, 'Progressive intent tool call id');
      (next as SlackRunPresentationV2 | SlackRunPresentationV3).progressiveIntent = {
        status: 'pending',
        toolCallId: mutation.toolCallId,
      };
      return next;
    case 'progressive_intent_requested':
      requireProgressiveIntent(current);
      requireProgressiveIntentState(current, 'pending');
      validateId(mutation.toolCallId, 'Progressive intent tool call id');
      if (current.progressiveIntent.toolCallId !== mutation.toolCallId) {
        throw stateError('identity_conflict', 'Progressive intent result does not match its call.');
      }
      (next as SlackRunPresentationV2 | SlackRunPresentationV3).progressiveIntent = {
        status: 'requested',
        toolCallId: mutation.toolCallId,
        requestedAt: at,
      };
      return next;
    case 'progressive_intent_not_requested':
      requireProgressiveIntent(current);
      requireProgressiveIntentState(current, 'unresolved');
      (next as SlackRunPresentationV2 | SlackRunPresentationV3).progressiveIntent = {
        status: 'not_requested',
        decidedAt: at,
      };
      return next;
    case 'progressive_intent_denied':
      requireProgressiveIntent(current);
      if (current.progressiveIntent.status === 'not_requested' ||
          current.progressiveIntent.status === 'denied') {
        throw stateError('terminal_rewrite', 'Progressive intent is already terminal.');
      }
      if (!isProgressiveIntentDenialReason(mutation.reason)) {
        throw stateError('invalid_input', 'Progressive intent denial reason is invalid.');
      }
      (next as SlackRunPresentationV2 | SlackRunPresentationV3).progressiveIntent = {
        status: 'denied',
        reason: mutation.reason,
        decidedAt: at,
      };
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
      // This transition happens only after Slack accepted the answer bytes, so
      // it is visibility evidence rather than merely a stream-start attempt.
      // It also covers prose appended to an already-open native task stream.
      if (current.schemaVersion !== 1 && current.progressiveIntent.status === 'requested' &&
          current.telemetry?.firstProgressiveEffectAt === undefined) {
        next.telemetry = { ...current.telemetry, firstProgressiveEffectAt: at };
      }
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
      if (current.schemaVersion === 3 && mutation.taskLabels.length < 2) {
        throw stateError('invalid_input', 'V3 task plans require multiple committed milestones.');
      }
      requireState(current, 'absent');
      next.plan = current.schemaVersion === 3
        ? buildPlanV3(current.runId, mutation.taskLabels)
        : buildPlan(current.runId, mutation.taskLabels);
      return next;
    }
    case 'set_task_status': {
      if (current.schemaVersion === 3) {
        throw stateError(
          'invalid_transition',
          'V3 tasks must transition independently by stable task id.',
        );
      }
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
    case 'transition_task': {
      requireV3(current);
      requireV3(next);
      if (!current.plan || !next.plan) {
        throw stateError('invalid_transition', 'Ordinary replies have no committed tasks.');
      }
      validateId(mutation.taskId, 'Task id');
      const index = current.plan.tasks.findIndex((task) => task.id === mutation.taskId);
      if (index < 0) throw stateError('invalid_input', 'Task id is not part of this Run.');
      const existing = current.plan.tasks[index]!;
      if (existing.status === 'complete' || existing.status === 'error') {
        throw stateError('terminal_rewrite', 'Terminal task outcomes are immutable.');
      }
      if (mutation.to === 'in_progress') {
        if (existing.status !== 'pending') {
          throw stateError('invalid_transition', 'A task can begin only once.');
        }
        if (mutation.detail !== undefined) {
          throw stateError('invalid_input', 'Only terminal task outcomes carry details.');
        }
        if (current.plan.tasks.some((task) => task.status === 'in_progress')) {
          throw stateError('invalid_transition', 'Only one milestone can be active at a time.');
        }
        if (current.plan.tasks.slice(0, index).some((task) =>
          task.status !== 'complete' && task.status !== 'error'
        )) {
          throw stateError('invalid_transition', 'Earlier milestones must settle first.');
        }
        next.plan.tasks[index] = { ...existing, status: 'in_progress' };
        return next;
      }
      if (!isTaskOutcome(mutation.to)) {
        throw stateError('invalid_input', 'Task outcome is invalid.');
      }
      if (mutation.detail === undefined) {
        throw stateError('invalid_input', 'Terminal task outcomes require a readable detail.');
      }
      validateDetail(mutation.detail);
      if (!mutation.detail.startsWith(taskOutcomePrefix(mutation.to))) {
        throw stateError('invalid_input', 'Task detail must name its semantic outcome.');
      }
      const mayFinishWithoutStarting = mutation.to === 'skipped' || mutation.to === 'not_run';
      if (existing.status === 'pending' && !mayFinishWithoutStarting) {
        throw stateError(
          'invalid_transition',
          'Only skipped or not-run tasks may finish before starting.',
        );
      }
      if (existing.status === 'in_progress' && mutation.to === 'not_run') {
        throw stateError('invalid_transition', 'A started task cannot become not run.');
      }
      next.plan.tasks[index] = {
        id: existing.id,
        title: existing.title,
        status: taskProjectionStatus(mutation.to),
        outcome: mutation.to,
        detail: mutation.detail,
      };
      return next;
    }
    case 'set_lifecycle_phase': {
      requireV3(current);
      requireV3(next);
      if (!isLifecyclePhase(mutation.phase)) {
        throw stateError('invalid_input', 'Lifecycle phase is invalid.');
      }
      assertLifecycleTransition(current.lifecyclePhase, mutation.phase);
      next.lifecyclePhase = mutation.phase;
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'record_repair_attempt': {
      requireV3(current);
      requireV3(next);
      if (!current.repairRequired || current.terminalDelivery.state !== 'intended' ||
          current.terminalDelivery.operation.certainty !== 'acknowledged') {
        throw stateError('invalid_transition', 'Only an acknowledged terminal repair may be paced.');
      }
      validatePositiveInteger(mutation.nextRetryAt, 'Presentation repair retry time');
      next.repair = {
        attempts: (current.repair?.attempts ?? 0) + 1,
        nextRetryAt: mutation.nextRetryAt,
      };
      return next;
    }
    case 'set_current_activity': {
      requireV3(current);
      requireV3(next);
      validateActivity(mutation.activity, current.sessionGeneration);
      if (mutation.activity.operation.certainty !== 'pending') {
        throw stateError('invalid_input', 'A new activity operation must begin pending.');
      }
      if (current.currentActivity &&
          mutation.activity.sequence <= current.currentActivity.sequence) {
        throw stateError('invalid_transition', 'Activity sequence must advance monotonically.');
      }
      if (current.currentActivity &&
          (current.currentActivity.operation.certainty === 'pending' ||
            current.currentActivity.operation.certainty === 'unknown')) {
        throw stateError('invalid_transition', 'Current activity effect requires reconciliation.');
      }
      if (current.currentActivity &&
          mutation.activity.operation.operationId ===
            current.currentActivity.operation.operationId) {
        throw stateError('identity_conflict', 'A new activity requires a new operation id.');
      }
      next.currentActivity = structuredClone(mutation.activity);
      if (next.lifecyclePhase === 'admitted') next.lifecyclePhase = 'active';
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'select_activity_projection': {
      requireV3(current);
      requireV3(next);
      if (!current.currentActivity || current.currentActivity.operation.certainty !== 'pending') {
        throw stateError('invalid_transition', 'Activity projection requires a pending activity.');
      }
      if (current.activityProjection.surface !== 'unselected') {
        throw stateError('terminal_rewrite', 'Activity projection surface is already frozen.');
      }
      if (mutation.surface !== 'message' && mutation.surface !== 'assistant_status') {
        throw stateError('invalid_input', 'Activity projection surface is invalid.');
      }
      next.activityProjection = { surface: mutation.surface, state: 'selected' };
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'retry_activity': {
      requireV3(current);
      requireV3(next);
      if (!current.currentActivity ||
          current.currentActivity.operation.certainty !== 'failed') {
        throw stateError('invalid_transition', 'Only a confirmed failed activity may retry.');
      }
      validateId(mutation.operationId, 'Activity operation id');
      if (mutation.operationId === current.currentActivity.operation.operationId) {
        throw stateError('identity_conflict', 'Activity retry requires a new operation id.');
      }
      next.currentActivity!.operation = {
        operationId: mutation.operationId,
        certainty: 'pending',
      };
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'record_activity_receipt': {
      requireV3(current);
      requireV3(next);
      if (!current.currentActivity || !next.currentActivity) {
        throw stateError('invalid_transition', 'There is no current activity operation.');
      }
      if (current.activityProjection.surface === 'unselected') {
        throw stateError('invalid_transition', 'Activity projection surface is missing.');
      }
      if (mutation.certainty === 'acknowledged') {
        if (current.activityProjection.surface === 'message') {
          if (mutation.messageTs === undefined) {
            throw stateError('invalid_input', 'Message activity acknowledgement requires a coordinate.');
          }
          validateSlackTimestamp(mutation.messageTs, 'Activity message timestamp');
          if (current.activityProjection.messageTs &&
              current.activityProjection.messageTs !== mutation.messageTs) {
            throw stateError('coordinate_conflict', 'Activity coordinate is immutable.');
          }
          next.activityProjection = {
            surface: 'message',
            state: 'visible',
            messageTs: mutation.messageTs,
          };
        } else {
          if (mutation.messageTs !== undefined) {
            throw stateError('invalid_input', 'Assistant status has no message coordinate.');
          }
          const cleanupAlreadyAcknowledged = current.cleanup.state === 'required' &&
            current.cleanup.operation.certainty === 'acknowledged';
          if (!cleanupAlreadyAcknowledged) {
            next.activityProjection = { surface: 'assistant_status', state: 'visible' };
          }
        }
      } else if (mutation.messageTs !== undefined) {
        throw stateError('invalid_input', 'Only acknowledged activity carries a coordinate.');
      }
      next.currentActivity.operation = transitionReceipt(
        current.currentActivity.operation,
        mutation.operationId,
        mutation.certainty,
      );
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'set_agent_session_desired': {
      requireV3(current);
      requireV3(next);
      if (current.agentSession.disposition) {
        throw stateError('terminal_rewrite', 'Agent Session repair is already terminal.');
      }
      if (!isAgentSessionState(mutation.desired)) {
        throw stateError('invalid_input', 'Agent Session state is invalid.');
      }
      validateId(mutation.operationId, 'Agent Session operation id');
      if (current.agentSession.operation &&
          current.agentSession.operation.certainty !== 'acknowledged' &&
          current.agentSession.operation.certainty !== 'failed') {
        throw stateError('invalid_transition', 'Agent Session operation is unresolved.');
      }
      if (current.agentSession.desired !== 'processing') {
        throw stateError('terminal_rewrite', 'Agent Session desired state is terminal.');
      }
      next.agentSession = {
        ...current.agentSession,
        desired: mutation.desired,
        operation: { operationId: mutation.operationId, certainty: 'pending' },
      };
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'record_agent_session_receipt': {
      requireV3(current);
      requireV3(next);
      if (!current.agentSession.operation) {
        throw stateError('invalid_transition', 'There is no Agent Session operation.');
      }
      if (mutation.certainty === 'acknowledged') {
        if (mutation.acknowledged !== current.agentSession.desired) {
          throw stateError('identity_conflict', 'Acknowledged Agent Session state is mismatched.');
        }
        next.agentSession.acknowledged = mutation.acknowledged;
      } else if (mutation.acknowledged !== undefined) {
        throw stateError('invalid_input', 'Only acknowledged receipts carry session state.');
      }
      next.agentSession.operation = transitionReceipt(
        current.agentSession.operation,
        mutation.operationId,
        mutation.certainty,
      );
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'retry_agent_session': {
      requireV3(current);
      requireV3(next);
      if (current.agentSession.disposition || !current.agentSession.operation ||
          current.agentSession.operation.certainty !== 'failed') {
        throw stateError('invalid_transition', 'Only a confirmed failed Agent Session effect may retry.');
      }
      validateId(mutation.operationId, 'Agent Session operation id');
      if (mutation.operationId === current.agentSession.operation.operationId) {
        throw stateError('identity_conflict', 'Agent Session retry requires a new operation id.');
      }
      next.agentSession.operation = { operationId: mutation.operationId, certainty: 'pending' };
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'mark_agent_session_unavailable': {
      requireV3(current);
      requireV3(next);
      if (current.agentSession.disposition || !current.agentSession.operation ||
          current.agentSession.operation.certainty !== 'failed') {
        throw stateError(
          'invalid_transition',
          'Only a confirmed failed Agent Session effect may become unavailable.',
        );
      }
      next.agentSession.disposition = 'unavailable';
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'supersede_shared_repair_effects': {
      requireV3(current);
      requireV3(next);
      let superseded = false;
      if (!current.agentSession.disposition &&
          (!current.agentSession.operation ||
            current.agentSession.operation.certainty === 'failed')) {
        next.agentSession.disposition = 'superseded';
        superseded = true;
      }
      if (current.activityProjection.surface === 'assistant_status' &&
          current.activityProjection.state === 'visible' &&
          (current.cleanup.state === 'not_required' ||
            current.cleanup.operation.certainty === 'failed')) {
        next.cleanup = { state: 'not_required', disposition: 'superseded' };
        superseded = true;
      }
      if (!superseded) {
        throw stateError(
          'invalid_transition',
          'No absent or confirmed failed shared repair effect may be superseded.',
        );
      }
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'record_terminal_delivery_intent': {
      requireV3(current);
      requireV3(next);
      if (current.terminalDelivery.state !== 'none') {
        throw stateError('terminal_rewrite', 'Terminal delivery intent is already frozen.');
      }
      validateId(mutation.operationId, 'Terminal delivery operation id');
      next.terminalDelivery = {
        state: 'intended',
        result: mutation.result,
        operation: { operationId: mutation.operationId, certainty: 'pending' },
      };
      next.lifecyclePhase = 'terminal_intended';
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'record_terminal_delivery_receipt': {
      requireV3(current);
      requireV3(next);
      if (current.terminalDelivery.state !== 'intended' ||
          next.terminalDelivery.state !== 'intended') {
        throw stateError('invalid_transition', 'Terminal delivery intent is missing.');
      }
      next.terminalDelivery.operation = transitionReceipt(
        current.terminalDelivery.operation,
        mutation.operationId,
        mutation.certainty,
      );
      if (mutation.certainty === 'unknown') next.lifecyclePhase = 'recovery_required';
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'supersede_failed_answer_delivery': {
      requireV3(current);
      requireV3(next);
      if (current.terminalDelivery.state !== 'intended' ||
          current.terminalDelivery.result !== 'answer' ||
          current.terminalDelivery.operation.certainty !== 'failed') {
        throw stateError(
          'invalid_transition',
          'Only a confirmed failed answer delivery may be superseded by failure.',
        );
      }
      validateId(mutation.operationId, 'Terminal delivery operation id');
      if (mutation.operationId === current.terminalDelivery.operation.operationId) {
        throw stateError('identity_conflict', 'Terminal delivery supersession requires a new operation id.');
      }
      next.terminalDelivery = {
        state: 'intended',
        result: 'failure',
        operation: { operationId: mutation.operationId, certainty: 'pending' },
      };
      next.lifecyclePhase = 'terminal_intended';
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'retry_terminal_delivery': {
      requireV3(current);
      requireV3(next);
      if (current.terminalDelivery.state !== 'intended' ||
          next.terminalDelivery.state !== 'intended' ||
          current.terminalDelivery.operation.certainty !== 'failed') {
        throw stateError('invalid_transition', 'Only a confirmed failed terminal effect may retry.');
      }
      validateId(mutation.operationId, 'Terminal delivery operation id');
      if (mutation.operationId === current.terminalDelivery.operation.operationId) {
        throw stateError('identity_conflict', 'Terminal delivery retry requires a new operation id.');
      }
      next.terminalDelivery.operation = {
        operationId: mutation.operationId,
        certainty: 'pending',
      };
      next.lifecyclePhase = 'terminal_intended';
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'record_cleanup_intent': {
      requireV3(current);
      requireV3(next);
      if (current.cleanup.state !== 'not_required') {
        throw stateError('terminal_rewrite', 'Cleanup intent is already frozen.');
      }
      if (current.cleanup.disposition) {
        throw stateError('terminal_rewrite', 'Shared cleanup repair is already terminal.');
      }
      if (current.terminalDelivery.state !== 'intended' ||
          current.terminalDelivery.operation.certainty !== 'acknowledged') {
        throw stateError('invalid_transition', 'Terminal delivery must be acknowledged before cleanup.');
      }
      validateId(mutation.operationId, 'Cleanup operation id');
      if (mutation.target === 'activity' &&
          (current.activityProjection.surface === 'unselected' ||
            current.activityProjection.state !== 'visible')) {
        throw stateError('invalid_transition', 'There is no visible activity to clean up.');
      }
      next.cleanup = {
        state: 'required',
        target: mutation.target,
        operation: { operationId: mutation.operationId, certainty: 'pending' },
      };
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'record_cleanup_receipt': {
      requireV3(current);
      requireV3(next);
      if (current.cleanup.state !== 'required' || next.cleanup.state !== 'required') {
        throw stateError('invalid_transition', 'Cleanup intent is missing.');
      }
      next.cleanup.operation = transitionReceipt(
        current.cleanup.operation,
        mutation.operationId,
        mutation.certainty,
      );
      if (mutation.certainty === 'acknowledged' && current.cleanup.target === 'activity') {
        if (current.activityProjection.surface === 'message') {
          next.activityProjection = { ...current.activityProjection, state: 'cleared' };
        } else if (current.activityProjection.surface === 'assistant_status') {
          next.activityProjection = { surface: 'assistant_status', state: 'cleared' };
        }
      }
      next.repairRequired = v3RepairRequired(next);
      return next;
    }
    case 'retry_cleanup': {
      requireV3(current);
      requireV3(next);
      if (current.cleanup.state !== 'required' || next.cleanup.state !== 'required' ||
          current.cleanup.operation.certainty !== 'failed') {
        throw stateError('invalid_transition', 'Only a confirmed failed cleanup may retry.');
      }
      validateId(mutation.operationId, 'Cleanup operation id');
      if (mutation.operationId === current.cleanup.operation.operationId) {
        throw stateError('identity_conflict', 'Cleanup retry requires a new operation id.');
      }
      next.cleanup.operation = { operationId: mutation.operationId, certainty: 'pending' };
      next.repairRequired = v3RepairRequired(next);
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

/** One bounded, content-free record emitted after canonical finalization. */
export function slackPresentationFinalizationRecord(
  presentation: SlackRunPresentation,
): SlackPresentationFinalizationRecord {
  if (presentation.stream.state !== 'finalized') {
    throw stateError('invalid_transition', 'Only a finalized presentation can emit evidence.');
  }
  const timing = presentationTiming(presentation);
  return {
    schemaVersion: 1,
    runRef: `run_${createHash('sha256').update(presentation.runId).digest('hex').slice(0, 24)}`,
    presentationSchemaVersion: presentation.schemaVersion,
    offer: presentationOffer(presentation),
    intent: presentationIntent(presentation),
    policyOutcome: presentationPolicyOutcome(presentation),
    deliveryOutcome: presentation.stream.presentationOutcome ?? 'pending',
    degradation: presentation.stream.degradationReason ?? 'none',
    acceptedBytes: presentation.stream.acknowledgedByteLength,
    timingMs: {
      ...(timing.offerToRequest === undefined
        ? {}
        : { offerToRequest: timing.offerToRequest }),
      ...(timing.requestToFirstEffect === undefined
        ? {}
        : { requestToFirstEffect: timing.requestToFirstEffect }),
      total: Math.max(0, presentation.updatedAt - presentation.createdAt),
    },
  };
}

function presentationOffer(presentation: SlackRunPresentation): string {
  const eligibility = presentation.progressiveEligibility;
  if (eligibility.status === 'pending') return 'pending';
  return eligibility.allowed ? 'offered' : `denied:${eligibility.reason}`;
}

function presentationIntent(presentation: SlackRunPresentation): string {
  if (presentation.schemaVersion === 1) return 'legacy';
  const intent = presentation.progressiveIntent;
  return intent.status === 'denied' ? `denied:${intent.reason}` : intent.status;
}

function presentationPolicyOutcome(presentation: SlackRunPresentation): string {
  const eligibility = presentation.progressiveEligibility;
  if (eligibility.status === 'pending') return 'pending';
  if (!eligibility.allowed) {
    return eligibility.reason === 'operations_disabled'
      ? 'operationally_disabled'
      : `runtime_denied:${eligibility.reason}`;
  }
  if (presentation.schemaVersion === 1) return 'legacy';
  const intent = presentation.progressiveIntent;
  if (intent.status === 'not_requested') return 'offered_not_requested';
  if (intent.status === 'denied') return `requested_denied:${intent.reason}`;
  if (intent.status !== 'requested') return `offered_${intent.status}`;
  const outcome = presentation.stream.presentationOutcome;
  if (outcome === 'progressive') return 'requested_progressive';
  if (outcome === 'corrected') return 'requested_corrected';
  if (outcome === 'fallback') return 'requested_fallback';
  return 'requested_terminal';
}

function presentationTiming(presentation: SlackRunPresentation): {
  offerToRequest?: number;
  requestToFirstEffect?: number;
} {
  if (presentation.schemaVersion === 1 ||
      presentation.progressiveIntent.status !== 'requested') return {};
  const offeredAt = presentation.telemetry?.eligibilityDecidedAt;
  const requestedAt = presentation.progressiveIntent.requestedAt;
  const firstEffectAt = presentation.telemetry?.firstProgressiveEffectAt;
  return {
    ...(offeredAt === undefined
      ? {}
      : { offerToRequest: Math.max(0, requestedAt - offeredAt) }),
    ...(firstEffectAt === undefined
      ? {}
      : { requestToFirstEffect: Math.max(0, firstEffectAt - requestedAt) }),
  };
}

function collectPresentationLatencies(
  presentation: SlackRunPresentation,
  offerToRequest: number[],
  requestToFirstEffect: number[],
  total: number[],
): void {
  const timing = presentationTiming(presentation);
  if (timing.offerToRequest !== undefined) offerToRequest.push(timing.offerToRequest);
  if (timing.requestToFirstEffect !== undefined) {
    requestToFirstEffect.push(timing.requestToFirstEffect);
  }
  if (presentation.stream.state === 'finalized') {
    total.push(Math.max(0, presentation.updatedAt - presentation.createdAt));
  }
}

function emptyLatencySummary(): SlackPresentationLatencySummary {
  return { count: 0, min: null, p50: null, p90: null, max: null };
}

function summarizeLatency(values: readonly number[]): SlackPresentationLatencySummary {
  if (values.length === 0) return emptyLatencySummary();
  const ordered = [...values].sort((left, right) => left - right);
  return {
    count: ordered.length,
    min: ordered[0]!,
    p50: percentile(ordered, 0.5),
    p90: percentile(ordered, 0.9),
    max: ordered.at(-1)!,
  };
}

function percentile(ordered: readonly number[], quantile: number): number {
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
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
  if (intent.status === 'requested') {
    return typeof intent.toolCallId === 'string' && intent.toolCallId.length > 0 &&
      typeof intent.requestedAt === 'number' && Number.isSafeInteger(intent.requestedAt) &&
      intent.requestedAt >= 0;
  }
  if (intent.status === 'not_requested') {
    return typeof intent.decidedAt === 'number' && Number.isSafeInteger(intent.decidedAt) &&
      intent.decidedAt >= 0;
  }
  if (intent.status === 'denied') {
    return isProgressiveIntentDenialReason(intent.reason) &&
      typeof intent.decidedAt === 'number' &&
      Number.isSafeInteger(intent.decidedAt) &&
      intent.decidedAt >= 0;
  }
  return false;
}

function requireProgressiveIntent(
  presentation: SlackRunPresentation,
): asserts presentation is SlackRunPresentationV2 | SlackRunPresentationV3 {
  if (presentation.schemaVersion === 1) {
    throw stateError('invalid_transition', 'Legacy presentations do not store model intent.');
  }
  if (presentation.progressiveEligibility.status !== 'frozen' ||
      !presentation.progressiveEligibility.allowed) {
    throw stateError('invalid_transition', 'Progressive intent was not offered by runtime policy.');
  }
  if (presentation.stream.state === 'finalized' || presentation.stream.state === 'fallback' ||
      presentation.stream.state === 'artifact_delivered' ||
      presentation.stream.state === 'finalizing' || presentation.stream.state === 'reconciling') {
    throw stateError('terminal_rewrite', 'A terminal presentation cannot change model intent.');
  }
}

function requireProgressiveIntentState<S extends SlackProgressiveIntent['status']>(
  presentation: SlackRunPresentationV2 | SlackRunPresentationV3,
  expected: S,
): asserts presentation is (SlackRunPresentationV2 | SlackRunPresentationV3) & {
  progressiveIntent: Extract<SlackProgressiveIntent, { status: S }>;
} {
  if (presentation.progressiveIntent.status !== expected) {
    throw stateError(
      'invalid_transition',
      `Progressive intent is not ${expected}.`,
    );
  }
}

function isProgressiveIntentDenialReason(
  value: unknown,
): value is SlackProgressiveIntentDenialReason {
  return value === 'late_declaration' || value === 'repeated_declaration' ||
    value === 'declaration_failed' || value === 'mismatched_declaration' ||
    value === 'non_presentation_tool' || value === 'structured_output' ||
    value === 'reset' || value === 'identity_conflict' ||
    value === 'persistence_failure' || value === 'runtime_denied';
}

function legacyLifecyclePhase(
  streamState: SlackPresentationStreamState,
): SlackPresentationLifecyclePhase {
  if (streamState === 'finalized') return 'settled';
  if (streamState === 'unknown') return 'recovery_required';
  if (streamState === 'absent') return 'admitted';
  if (streamState === 'finalizing' || streamState === 'fallback' ||
      streamState === 'artifact_delivered') return 'terminal_intended';
  return 'active';
}

function legacyTerminalDelivery(
  presentation: SlackRunPresentationV1 | SlackRunPresentationV2,
): SlackPresentationTerminalDelivery {
  if (presentation.stream.state !== 'finalizing' &&
      presentation.stream.state !== 'fallback' &&
      presentation.stream.state !== 'artifact_delivered' &&
      presentation.stream.state !== 'finalized') {
    return { state: 'none' };
  }
  const certainty = presentation.stream.state === 'artifact_delivered' ||
      presentation.stream.state === 'finalized'
    ? 'acknowledged'
    : 'pending';
  return {
    state: 'intended',
    result: 'legacy',
    operation: {
      operationId: `legacy_terminal_${createHash('sha256')
        .update(`${presentation.runId}\0terminal`)
        .digest('hex')
        .slice(0, 24)}`,
      certainty,
    },
  };
}

function upgradeLegacyPlan(plan: SlackPresentationPlan): SlackPresentationPlanV3 {
  return {
    displayMode: plan.displayMode,
    tasks: plan.tasks.map((task) => {
      if (task.status === 'complete') {
        return {
          id: task.id,
          title: task.title,
          status: 'complete',
          outcome: 'completed',
          detail: 'Completed: legacy task completed.',
        };
      }
      if (task.status === 'error') {
        return {
          id: task.id,
          title: task.title,
          status: 'error',
          outcome: 'failed',
          detail: 'Failed: legacy task failed.',
        };
      }
      return { id: task.id, title: task.title, status: task.status };
    }),
  };
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

function buildPlanV3(runId: string, labels: readonly string[]): SlackPresentationPlanV3 {
  if (labels.length < 2) {
    throw stateError('invalid_input', 'V3 task plans require multiple committed milestones.');
  }
  const legacy = buildPlan(runId, labels);
  return {
    displayMode: legacy.displayMode,
    tasks: legacy.tasks.map(({ id, title }) => ({ id, title, status: 'pending' })),
  };
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
  if (input.schemaVersion === 3) {
    validateOwner(input.owner);
    validatePositiveInteger(input.sessionGeneration, 'Session generation');
    if (input.currentActivity) {
      validateActivity(input.currentActivity, input.sessionGeneration);
      if (input.currentActivity.operation.certainty !== 'pending') {
        throw stateError('invalid_input', 'Initial activity receipt must be pending.');
      }
    }
    if ('persona' in input && input.persona !== undefined) {
      throw stateError('invalid_input', 'V3 identity must be stored only in the frozen owner.');
    }
  } else if (input.persona) {
    validatePersona(input.persona);
  }
  if (input.taskLabels !== undefined) {
    if (input.schemaVersion === 3) {
      if (input.taskLabels.length > 1) buildPlanV3(input.runId, input.taskLabels);
      else buildPlan(input.runId, input.taskLabels);
    }
    else buildPlan(input.runId, input.taskLabels);
  }
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
  const sharedIdentityMatches = presentation.runId === input.runId &&
    presentation.turnJobId === input.turnJobId &&
    presentation.bindingId === input.bindingId &&
    presentation.workBindingGeneration === input.workBindingGeneration &&
    presentation.runFencingToken === input.runFencingToken &&
    JSON.stringify(presentation.root) === JSON.stringify(input.root);
  if (!sharedIdentityMatches) return false;
  if (input.schemaVersion === 3 || presentation.schemaVersion === 3) {
    if (input.schemaVersion !== 3 || presentation.schemaVersion !== 3) return false;
    const expectedPlan = input.taskLabels && input.taskLabels.length > 1
      ? buildPlanV3(input.runId, input.taskLabels)
      : undefined;
    return presentation.sessionGeneration === input.sessionGeneration &&
      JSON.stringify(presentation.owner) === JSON.stringify(input.owner) &&
      JSON.stringify(presentation.currentActivity) === JSON.stringify(input.currentActivity) &&
      JSON.stringify(presentation.plan) === JSON.stringify(expectedPlan);
  }
  const expectedPlan = input.taskLabels && input.taskLabels.length > 0
    ? buildPlan(input.runId, input.taskLabels)
    : undefined;
  return JSON.stringify(presentation.persona) === JSON.stringify(input.persona) &&
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
    (presentation.schemaVersion !== 1 && presentation.schemaVersion !== 2 &&
      presentation.schemaVersion !== 3) ||
    presentation.runId !== row.run_id ||
    presentation.workBindingGeneration !== row.binding_generation ||
    presentation.runFencingToken !== row.run_fencing_token ||
    presentation.projectionVersion !== row.projection_version ||
    presentation.stream?.state !== row.stream_state ||
    presentation.root?.workspaceId !== row.workspace_id ||
    presentation.root?.channelId !== row.channel_id ||
    (presentation.stream.messageTs ?? null) !== row.message_ts ||
    presentation.repairRequired !== (row.repair_required === 1) ||
    !isPresentationTelemetry(presentation.telemetry)
  ) {
    throw stateError('invalid_input', 'Stored presentation columns do not match payload.');
  }
  if (
    (presentation.schemaVersion === 1 &&
      (typeof presentation.features?.progressiveStreaming !== 'boolean' ||
        typeof presentation.features?.nativeTasks !== 'boolean')) ||
    (presentation.schemaVersion === 2 && !isProgressiveIntent(presentation.progressiveIntent)) ||
    (presentation.schemaVersion === 3 && !isStoredV3Presentation(presentation))
  ) {
    throw stateError('invalid_input', 'Stored presentation version payload is invalid.');
  }
  return structuredClone(presentation);
}

function isPresentationTelemetry(value: unknown): value is SlackPresentationTelemetry | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const telemetry = value as Record<string, unknown>;
  return Object.keys(telemetry).every((key) =>
    key === 'eligibilityDecidedAt' || key === 'firstProgressiveEffectAt'
  ) && [telemetry.eligibilityDecidedAt, telemetry.firstProgressiveEffectAt].every((entry) =>
    entry === undefined ||
    (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0)
  );
}

function isStoredV3Presentation(
  presentation: SlackRunPresentationV3,
): boolean {
  try {
    validateOwner(presentation.owner);
    validatePositiveInteger(presentation.sessionGeneration, 'Session generation');
    if (!isProgressiveIntent(presentation.progressiveIntent)) return false;
    if (presentation.currentActivity) {
      validateActivity(presentation.currentActivity, presentation.sessionGeneration);
    }
    if (!isActivityProjection(presentation.activityProjection)) return false;
    if (!isLifecyclePhase(presentation.lifecyclePhase) ||
        !isAgentSessionState(presentation.agentSession?.desired) ||
        (presentation.agentSession?.acknowledged !== 'none' &&
          !isAgentSessionState(presentation.agentSession?.acknowledged)) ||
        (presentation.agentSession.disposition !== undefined &&
          presentation.agentSession.disposition !== 'superseded' &&
          presentation.agentSession.disposition !== 'unavailable') ||
        (presentation.agentSession.operation !== undefined &&
          !isOperationReceipt(presentation.agentSession.operation))) return false;
    if (presentation.terminalDelivery?.state === 'intended') {
      if ((presentation.terminalDelivery.result !== 'answer' &&
          presentation.terminalDelivery.result !== 'failure' &&
          presentation.terminalDelivery.result !== 'legacy') ||
          !isOperationReceipt(presentation.terminalDelivery.operation)) return false;
    } else if (presentation.terminalDelivery?.state !== 'none') return false;
    if (presentation.cleanup?.state === 'required') {
      if ((presentation.cleanup.target !== 'activity' &&
          presentation.cleanup.target !== 'agent_session') ||
          !isOperationReceipt(presentation.cleanup.operation)) return false;
    } else if (presentation.cleanup?.state === 'not_required') {
      if (presentation.cleanup.disposition !== undefined &&
          presentation.cleanup.disposition !== 'superseded') return false;
    } else return false;
    if (presentation.repair !== undefined && (
      !Number.isSafeInteger(presentation.repair.attempts) ||
      presentation.repair.attempts < 1 ||
      !Number.isSafeInteger(presentation.repair.nextRetryAt) ||
      presentation.repair.nextRetryAt < 1
    )) return false;
    if (!presentation.compatibility ||
        ![1, 2, 3].includes(presentation.compatibility.sourceSchemaVersion)) return false;
    if (presentation.plan) {
      if (presentation.plan.displayMode !== 'timeline' &&
          presentation.plan.displayMode !== 'plan') return false;
      if (presentation.plan.tasks.length < 1 || presentation.plan.tasks.length > 4) return false;
      if (presentation.compatibility.sourceSchemaVersion === 3 &&
          presentation.plan.tasks.length < 2) return false;
      for (const task of presentation.plan.tasks) {
        validateId(task.id, 'Task id');
        validateLabel(task.title);
        if (task.status !== 'pending' && task.status !== 'in_progress' &&
            task.status !== 'complete' && task.status !== 'error') return false;
        if (task.status === 'complete' || task.status === 'error') {
          if (!isTaskOutcome(task.outcome) || task.detail === undefined) return false;
          if (task.status !== taskProjectionStatus(task.outcome)) return false;
          validateDetail(task.detail);
        } else if (task.outcome !== undefined || task.detail !== undefined) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function requireV3(
  presentation: SlackRunPresentation,
): asserts presentation is SlackRunPresentationV3 {
  if (presentation.schemaVersion !== 3) {
    throw stateError('invalid_transition', 'This mutation requires presentation V3.');
  }
}

function validatePersona(persona: SlackPresentationPersona): void {
  validateLabel(persona.name);
  validatePositiveInteger(persona.avatarRevision, 'Avatar revision');
  if (!/^https:\/\//.test(persona.avatarUrl) || persona.avatarUrl.length > 2_048) {
    throw stateError('invalid_input', 'Avatar URL must be a bounded HTTPS URL.');
  }
}

function validateOwner(owner: SlackPresentationOwner): void {
  if (!owner || (owner.kind !== 'selected_agent' && owner.kind !== 'chickpea')) {
    throw stateError('invalid_input', 'Visible owner is invalid.');
  }
  if (owner.kind === 'selected_agent') {
    if (!owner.persona) {
      throw stateError('invalid_input', 'Selected-Agent owner requires a complete persona.');
    }
    validatePersona(owner.persona);
  } else if ('persona' in owner && owner.persona !== undefined) {
    throw stateError('invalid_input', 'Chickpea owner must use the base-app identity.');
  }
}

function validateActivity(
  activity: SlackPresentationActivity,
  sessionGeneration: number,
): void {
  if (!isActivityKind(activity?.kind)) {
    throw stateError('invalid_input', 'Activity kind is invalid.');
  }
  validateUserFacingFact(activity.action, 'Activity action', 80);
  validateUserFacingFact(activity.object, 'Activity object', 160);
  if (activity.generation !== sessionGeneration) {
    throw stateError('identity_conflict', 'Activity generation does not match its session.');
  }
  validatePositiveInteger(activity.sequence, 'Activity sequence');
  if (!isOperationReceipt(activity.operation)) {
    throw stateError('invalid_input', 'Activity operation receipt is invalid.');
  }
}

function validateDetail(value: string): void {
  validateUserFacingFact(value, 'Task detail', 480);
  if (hasCredentialLikeContent(value)) {
    throw stateError('invalid_input', 'Task detail cannot contain credential-like content.');
  }
}

function validateUserFacingFact(value: string, label: string, maxBytes: number): void {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 ||
      new TextEncoder().encode(value).byteLength > maxBytes ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw stateError('invalid_input', `${label} is not bounded user-readable text.`);
  }
}

function isActivityKind(value: unknown): value is SlackPresentationActivityKind {
  return value === 'preparing' || value === 'checking' || value === 'reading' ||
    value === 'writing' || value === 'updating' || value === 'running' ||
    value === 'waiting' || value === 'finishing';
}

function isReceiptCertainty(value: unknown): value is SlackPresentationReceiptCertainty {
  return value === 'pending' || value === 'acknowledged' || value === 'failed' ||
    value === 'unknown';
}

function isOperationReceipt(value: unknown): value is SlackPresentationOperationReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  try {
    validateId(String(receipt.operationId ?? ''), 'Operation id');
  } catch {
    return false;
  }
  return isReceiptCertainty(receipt.certainty);
}

function transitionReceipt(
  current: SlackPresentationOperationReceipt,
  operationId: string,
  certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>,
): SlackPresentationOperationReceipt {
  validateId(operationId, 'Operation id');
  if (!isReceiptCertainty(certainty)) {
    throw stateError('invalid_input', 'Receipt certainty is invalid.');
  }
  if (current.operationId !== operationId) {
    throw stateError('identity_conflict', 'Receipt operation identity is mismatched.');
  }
  if (current.certainty === 'acknowledged' || current.certainty === 'failed') {
    throw stateError('terminal_rewrite', 'Known operation receipt is immutable.');
  }
  if (current.certainty === 'unknown' && certainty === 'unknown') {
    throw stateError('invalid_transition', 'Unknown receipt still requires reconciliation.');
  }
  return { operationId, certainty };
}

function isTaskOutcome(value: unknown): value is SlackPresentationTaskOutcome {
  return value === 'completed' || value === 'changed' || value === 'skipped' ||
    value === 'failed' || value === 'not_run';
}

function taskProjectionStatus(
  outcome: SlackPresentationTaskOutcome,
): 'complete' | 'error' {
  return outcome === 'failed' || outcome === 'not_run' ? 'error' : 'complete';
}

function taskOutcomePrefix(outcome: SlackPresentationTaskOutcome): string {
  switch (outcome) {
    case 'completed': return 'Completed:';
    case 'changed': return 'Changed:';
    case 'skipped': return 'Skipped:';
    case 'failed': return 'Failed:';
    case 'not_run': return 'Not run:';
  }
}

function isLifecyclePhase(value: unknown): value is SlackPresentationLifecyclePhase {
  return value === 'admitted' || value === 'active' || value === 'terminal_intended' ||
    value === 'settled' || value === 'recovery_required';
}

function isAgentSessionState(value: unknown): value is SlackPresentationAgentSessionState {
  return value === 'processing' || value === 'active' || value === 'suspended' ||
    value === 'closed';
}

function isActivityProjection(value: unknown): value is SlackPresentationActivityProjection {
  if (!value || typeof value !== 'object') return false;
  const projection = value as Record<string, unknown>;
  if (projection.surface === 'unselected') {
    return projection.state === 'absent' && projection.messageTs === undefined;
  }
  if (projection.surface === 'assistant_status') {
    return (projection.state === 'selected' || projection.state === 'visible' ||
      projection.state === 'cleared') && projection.messageTs === undefined;
  }
  if (projection.surface !== 'message' ||
      (projection.state !== 'selected' && projection.state !== 'visible' &&
        projection.state !== 'cleared')) return false;
  if (projection.state === 'selected') return projection.messageTs === undefined;
  if (typeof projection.messageTs !== 'string') return false;
  try {
    validateSlackTimestamp(projection.messageTs, 'Activity message timestamp');
    return true;
  } catch {
    return false;
  }
}

function assertLifecycleTransition(
  from: SlackPresentationLifecyclePhase,
  to: SlackPresentationLifecyclePhase,
): void {
  const allowed: Record<SlackPresentationLifecyclePhase, readonly SlackPresentationLifecyclePhase[]> = {
    admitted: ['active', 'terminal_intended', 'recovery_required'],
    active: ['terminal_intended', 'recovery_required'],
    terminal_intended: ['settled', 'recovery_required'],
    recovery_required: ['active', 'terminal_intended', 'settled'],
    settled: [],
  };
  if (!allowed[from].includes(to)) {
    const code = from === 'settled' ? 'terminal_rewrite' : 'invalid_transition';
    throw stateError(code, `Lifecycle cannot move from ${from} to ${to}.`);
  }
}

function v3RepairRequired(presentation: SlackRunPresentationV3): boolean {
  if (presentation.lifecyclePhase === 'recovery_required' ||
      presentation.stream.pendingAppend ||
      presentation.stream.state === 'starting' ||
      presentation.stream.state === 'finalizing' ||
      presentation.stream.state === 'fallback' ||
      presentation.stream.state === 'unknown') return true;
  const activityReceipt = presentation.currentActivity?.operation;
  const terminalAcknowledged = presentation.terminalDelivery.state === 'intended' &&
    presentation.terminalDelivery.operation.certainty === 'acknowledged';
  const sharedCleanupSuperseded = presentation.activityProjection.surface ===
      'assistant_status' && presentation.cleanup.state === 'not_required' &&
    presentation.cleanup.disposition === 'superseded';
  if (terminalAcknowledged && (
    presentation.lifecyclePhase !== 'settled' ||
    (presentation.activityProjection.state === 'visible' && !sharedCleanupSuperseded)
  )) return true;
  const receipts = [
    activityReceipt?.certainty === 'failed' && terminalAcknowledged
      ? undefined
      : activityReceipt,
    presentation.agentSession.disposition ? undefined : presentation.agentSession.operation,
    presentation.terminalDelivery.state === 'intended'
      ? presentation.terminalDelivery.operation
      : undefined,
    presentation.cleanup.state === 'required' ? presentation.cleanup.operation : undefined,
  ];
  return receipts.some((receipt) =>
    receipt !== undefined && receipt.certainty !== 'acknowledged'
  );
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
