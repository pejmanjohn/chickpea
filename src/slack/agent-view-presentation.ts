import { createHash } from 'node:crypto';

import { ErrorCode, type WebClient } from '@slack/web-api';
import type { AnyChunk, KnownBlock } from '@slack/types';

import { hasCredentialLikeContent, hasDisallowedControlCharacter } from '../security/content-validation.ts';
import type { FlueDispatchReceiptV1, FlueObservationTarget } from './turn-job-types.ts';
import { activityStatus, type ActivityStatus } from '../activity/status.ts';
import {
  appendSlackReplyFooter,
  canonicalSlackReplyText,
  renderSlackMessage,
  SLACK_REPLY_SHORTENED_NOTE,
  slackEscapedTextLength,
  slackMarkdownBlockTextLimit,
  slackMarkdownPartBlockLimit,
  slackMarkdownRenderedShape,
  slackMarkdownShapePrefixLength,
  splitSlackMarkdownReply,
  streamableSlackMarkdownPrefix,
  type SlackReplyFooter,
  type SlackReplyFormat,
} from './message-format.ts';
import {
  appendSlackTableToRenderedMessage,
  type RenderedSlackTablePresentation,
  type SlackTablePresentation,
} from './table-presentation.ts';
import {
  renderSlackReplyPart,
  renderSlackReplyTable,
  slackReplyParts,
} from './reply-continuations.ts';
import type {
  CompletedSlackArtifactReceipt,
  SlackArtifactReceipt,
} from './artifact-receipts.ts';
import {
  ReceiptScopedTextRelay,
  type ProgressiveAppendControl,
  type ProgressiveIntentTransition,
  type ProgressiveRelayInvalidationReason,
  type ProgressiveTextChunk,
  type SlackProgressiveReadRelay,
} from './progressive-relay.ts';
import type { ProgressiveEligibilityDecision } from './progressive-eligibility.ts';
import { SlackTransportError } from './transport/types.ts';
import { slackClientMessageId } from './transport/message-id.ts';
import { setAgentSessionStatus } from './gateway/web-client.ts';
import {
  MAX_SLACK_CONTINUATION_PARTS,
  MAX_SLACK_CONTINUATION_RESPLITS,
  presentationHasTerminalOutcome,
  presentationAllowsProgressive,
  presentationUsesNativeTasks,
  progressiveStreamingModeForReason,
  slackPresentationFinalizationRecord,
  type SlackPresentationFinalizationRecord,
  type SlackAppendBooking,
  type SlackAppendReservation,
  type SlackPresentationMutation,
  type SlackPresentationActivity,
  type SlackPresentationActivityProjection,
  type SlackPresentationAgentSessionState,
  type SlackPresentationOwner,
  type SlackPresentationRoot,
  type SlackPresentationTaskOutcome,
  type SlackPresentationReceiptCertainty,
  type SlackPresentationTransitionInput,
  type SlackPresentationTransitionResult,
  type SlackReplySplit,
  type SlackRunPresentation,
} from './run-presentations.ts';

type MaybePromise<T> = T | Promise<T>;

export interface SlackPresentationStatePort {
  getRunPresentation(runId: string): MaybePromise<SlackRunPresentation | undefined>;
  getLatestThreadSessionGeneration(
    root: Pick<SlackPresentationRoot, 'workspaceId' | 'channelId' | 'threadTs'>,
  ): MaybePromise<number | undefined>;
  transitionRunPresentation(
    input: SlackPresentationTransitionInput,
  ): MaybePromise<SlackPresentationTransitionResult>;
  reserveSlackAppend(workspaceId: string): MaybePromise<SlackAppendBooking>;
  /** The shared append cooldown's end, if one is running. */
  slackAppendCooldownUntil?(workspaceId: string): MaybePromise<number | undefined>;
  applySlackAppendCooldown(
    workspaceId: string,
    retryAfterMs: number,
  ): MaybePromise<{ cooldownUntil: number; budgetVersion: number }>;
  reserveSlackActivityStatus?(workspaceId: string): MaybePromise<SlackAppendReservation>;
  applySlackActivityStatusCooldown?(
    workspaceId: string,
    retryAfterMs: number,
  ): MaybePromise<{ cooldownUntil: number; budgetVersion: number }>;
  matchFlueObservation(
    instanceId: string,
    submissionId?: string,
  ): MaybePromise<FlueObservationTarget | undefined>;
}

type SlackActivityCleanupPreparation =
  | {
      kind: 'prepared';
      operationId: string;
      projection: Exclude<SlackPresentationActivityProjection, { surface: 'unselected' }>;
    }
  | { kind: 'already_cleared'; surface: 'message' | 'assistant_status' }
  | { kind: 'fenced' }
  | { kind: 'not_required' };

export interface SlackPresentationDeliveryObserver {
  before(input: {
    method: string;
    approvedOutput: string;
    renderedPayload: string;
  }): Promise<string | undefined>;
  after(input: {
    attemptId: string | undefined;
    outcome: 'delivered' | 'failed' | 'unknown';
    deliveryRef?: string;
    safeFailureCode?: string;
  }): Promise<void>;
}

interface FrozenProgressiveEligibilityDecision extends ProgressiveEligibilityDecision {
  presentationSchemaVersion: 1 | 2 | 3;
}

type AgentViewFinalResult =
  /** `text` is the part of the answer the final message itself carries. */
  | { handled: true; messageTs?: string; text?: string }
  | { handled: false; fallbackPresentation: boolean; operationId?: string };

interface AgentViewPresentationOptions {
  client: WebClient;
  state: SlackPresentationStatePort;
  runId: string;
  runFencingToken: number;
  footer: SlackReplyFooter;
  minAppendIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  /** Spreads budget retries so concurrent streams do not wake together. */
  random?: () => number;
  onNativeStarted?: () => Promise<void>;
  /** Observability only: Slack acknowledged a progressive or native stream start. */
  onStreamStarted?: () => void;
  onFinalized?: (record: SlackPresentationFinalizationRecord) => MaybePromise<void>;
}

interface SlackMilestoneTransition {
  taskId: string;
  to: 'in_progress' | SlackPresentationTaskOutcome;
  detail?: string;
}

interface PreparedSlackActivityWrite {
  operationId: string;
  surface: 'message' | 'assistant_status';
  messageTs?: string;
}

const STALE_WRITER_MESSAGE = 'Slack Agent View presentation writer is stale.';

/**
 * Close an open Agent View stream once it is this old. Slack does not document
 * a stream lifetime; other Slack agents observe native streams sealed about
 * 5 min 20 s after `chat.startStream`, even while appending, after which the
 * message can no longer be stopped, updated, or found. Four minutes leaves
 * room for the check interval and for clock skew between Slack's timestamp
 * and the Worker. Short turns finish well inside it and keep their stream.
 */
export const AGENT_VIEW_STREAM_RETIRE_AFTER_MS = 4 * 60_000;

/** How often a turn that is waiting on its agent checks the stream's age. */
export const AGENT_VIEW_STREAM_AGE_CHECK_MS = 20_000;
const MAX_PROGRESSIVE_BUFFER_BYTES = 128 * 1_024;
const DEFAULT_APPEND_INTERVAL_MS = 750;
/**
 * How long one append may wait for the workspace append budget. Past this
 * the append gives way: its text stays buffered, the next model text carries
 * it in a larger append, and the terminal carries whatever is left. Many
 * concurrent streams then append less often instead of stopping.
 */
const MAX_APPEND_DEFERRAL_MS = 20_000;
/** Spread of a retry after the booking horizon, so waiters do not wake together. */
const APPEND_DEFERRAL_JITTER_MS = 250;
/** Shortest wait before asking the budget again. */
const MIN_APPEND_DEFERRAL_MS = 50;
/** A waiting append checks this often whether its reader has closed. */
const APPEND_DEFERRAL_SLICE_MS = 1_000;
const CORRECTED_MARKER = '_Corrected_';
/**
 * Progressive text stays inside the first message, with room to close a
 * fence. Counted as Slack counts it, with `&`, `<` and `>` escaped: a stream
 * under this bound in raw characters was refused with `msg_too_long`.
 */
const MAX_STREAMED_REPLY_CHARS = slackMarkdownBlockTextLimit - 16;
/**
 * The first message of a replacement sent with chat.update. Slack rejected a
 * ~12,000-character recovery update with `msg_too_long` while accepting the
 * same size from a stream or a post; its documented chat.update limit is
 * 4,000 characters of `text`. Stay at that bound; follow-ups carry the rest.
 */
const RECOVERY_UPDATE_MAX_CHARS = 4_000;
/** Room to close a code fence still open at the end of a kept streamed prefix. */
const RECOVERY_FENCE_ROOM_CHARS = 16;
/**
 * A smaller first message plus four 12,000-character follow-ups carries at
 * least the 48,000 characters a normal reply can.
 */
const RECOVERY_MAX_PARTS = 5;
/** Near the cap, progressive text advances only to line boundaries. */
const STREAM_EDGE_WINDOW_CHARS = 2_000;
/** A continuation intent this young may still belong to a live writer. */
const CONTINUATION_INTENT_GRACE_MS = 60_000;
/**
 * Posts one delivery pass may make: every follow-up, each re-split after a
 * refusal, and the readbacks between them.
 */
const CONTINUATION_DELIVERY_STEPS = 16;

/**
 * One recoverable Agent View artifact for a canonical Slack Run. Flue owns
 * generation; the app-owned presentation projection owns every Slack effect.
 */
export class SlackAgentViewPresentation {
  private rawText = '';
  /**
   * Once the stream reaches its cap: the most it can ever show (canonical
   * text). The rest of the answer reaches Slack only in the terminal.
   */
  private streamCapBound: string | undefined;
  private nextAppendAt = 0;
  /**
   * Why the last append attempt left text unsent without ending the stream:
   * the budget stayed spent past the deferral bound, or Slack rate limited
   * it. A later granted append clears it.
   */
  private budgetShortfall:
    | 'budget_exhausted'
    | 'workspace_cooldown'
    | 'rate_limited'
    | undefined;
  private readonly appendBudget = { deferrals: 0, deferredMs: 0, yielded: 0, rateLimited: 0 };
  /**
   * The outcome of the pacing wait the relay ran before the next append. A
   * `reserved` slot stays until an append uses it: text that does not yet
   * move the safe prefix (a table row, an open link) keeps it for the next
   * chunk instead of booking another.
   */
  private appendSlot: 'reserved' | 'yielded' | undefined;
  private degradedReason:
    | 'budget_exhausted'
    | 'workspace_cooldown'
    | 'rate_limited'
    | 'unsafe_incomplete_block'
    | 'runtime_gate_disabled'
    | 'policy_ineligible'
    | 'effect_capable'
    | 'relay_setup_failed'
    | undefined;

  constructor(private readonly options: AgentViewPresentationOptions) {}

  /** Replace the footer's model label, for a label only the finished reply can decide. */
  setFooterModelLabel(modelLabel: string | undefined): void {
    this.options.footer = { ...this.options.footer, modelLabel };
  }

  /** Set the footer's memory items, known only once the turn's memory is prepared. */
  setFooterMemoryItems(memoryItems: readonly string[] | undefined): void {
    this.options.footer = { ...this.options.footer, memoryItems };
  }

  /**
   * Persist the activity intent before its Slack write. The admission activity
   * already owns a pending receipt, so the first call reuses it; later facts
   * advance one monotonic sequence at a time.
   */
  async beginActivity(
    update: ActivityStatus,
    preferredSurface: 'message' | 'assistant_status',
  ): Promise<PreparedSlackActivityWrite | undefined> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3) return undefined;
    if (!(await this.ownsLatestThreadGeneration(presentation))) return undefined;
    if (presentation.activityProjection.surface === 'assistant_status' &&
        presentation.activityProjection.state === 'unavailable') return undefined;
    // A V3 presentation admitted without an initial activity has the custom
    // semantic-status capability frozen off. It remains lifecycle-only.
    if (!presentation.currentActivity &&
        presentation.activityProjection.surface === 'unselected') return undefined;
    let current = presentation.currentActivity;
    let created = false;
    if (current?.operation.certainty === 'pending') {
      // Admission persists the first activity before the Worker can write it.
      // A selected surface without a coordinate means a prior attempt may
      // already have created the message, so reconciliation must resolve it.
    } else if (current?.operation.certainty === 'unknown') {
      await this.reconcileActivityReceipts();
      presentation = await this.requirePresentation();
      if (presentation.schemaVersion !== 3) return undefined;
      current = presentation.currentActivity;
      if (current?.operation.certainty === 'unknown') return undefined;
      // Reconciliation may conclusively establish absence, which is eligible
      // for the existing failed-effect retry path below.
      if (current?.operation.certainty === 'pending') return undefined;
    }
    if (!current || current.operation.certainty !== 'pending') {
      const kind = update.kind ?? 'preparing';
      const action = update.action ?? 'Preparing';
      const object = update.object ?? 'your request';
      if (current && current.action === action && current.object === object) {
        if (current.operation.certainty !== 'failed') return undefined;
        const operationId = `activity_${hash(`${presentation.runId}:${current.sequence}:retry:${presentation.projectionVersion}`).slice(0, 24)}`;
        presentation = await this.transition(presentation, {
          kind: 'retry_activity', operationId,
        });
        created = true;
      } else {
        const sequence = (current?.sequence ?? 0) + 1;
        const activity: SlackPresentationActivity = {
          kind,
          action,
          object,
          ...(update.family ? { family: update.family } : {}),
          ...(update.phase ? { phase: update.phase } : {}),
          generation: presentation.sessionGeneration,
          sequence,
          operation: {
            operationId: `activity_${hash(`${presentation.runId}:${sequence}`).slice(0, 24)}`,
            certainty: 'pending',
          },
        };
        presentation = await this.transition(presentation, {
          kind: 'set_current_activity',
          activity,
        });
        created = true;
      }
    }
    if (presentation.schemaVersion !== 3 || !presentation.currentActivity) return undefined;
    let projection = presentation.activityProjection;
    let selectedNow = false;
    if (projection.surface === 'unselected') {
      presentation = await this.transition(presentation, {
        kind: 'select_activity_projection',
        surface: preferredSurface,
      });
      if (presentation.schemaVersion !== 3) return undefined;
      projection = presentation.activityProjection;
      selectedNow = true;
    }
    if (projection.surface === 'unselected' || projection.state === 'cleared' ||
        projection.state === 'unavailable') return undefined;
    const messageTs = projection.surface === 'message' ? projection.messageTs : undefined;
    if (!selectedNow && !created && projection.state !== 'visible') return undefined;
    const activity = presentation.currentActivity;
    if (!activity) return undefined;
    return {
      operationId: activity.operation.operationId,
      surface: projection.surface,
      ...(messageTs ? { messageTs } : {}),
    };
  }

  /**
   * Reassert one still-current native phrase without inventing a new durable
   * activity operation. Native status expires after two minutes; legacy
   * message coordinates deliberately fail this check and are never refreshed.
   */
  async prepareActivityRefresh(
    update: ActivityStatus,
  ): Promise<PreparedSlackActivityWrite | undefined> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 ||
        presentation.activityProjection.surface !== 'assistant_status' ||
        presentation.activityProjection.state !== 'visible' ||
        presentation.currentActivity?.operation.certainty !== 'acknowledged' ||
        !(await this.ownsLatestThreadGeneration(presentation))) return undefined;
    const current = activityStatus(
      presentation.currentActivity.kind,
      presentation.currentActivity.action,
      presentation.currentActivity.object,
      presentation.currentActivity.family,
      presentation.currentActivity.phase,
    );
    if (current.kind !== update.kind || current.action !== update.action ||
        current.object !== update.object || current.family !== update.family ||
        current.phase !== update.phase || current.text !== update.text) return undefined;
    return {
      operationId: presentation.currentActivity.operation.operationId,
      surface: 'assistant_status',
    };
  }

  async recordActivityReceipt(
    operationId: string | undefined,
    certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>,
    messageTs?: string,
    unavailable = false,
  ): Promise<void> {
    if (!operationId) return;
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 ||
        presentation.currentActivity?.operation.operationId !== operationId ||
        (presentation.currentActivity.operation.certainty !== 'pending' &&
          presentation.currentActivity.operation.certainty !== 'unknown')) return;
    presentation = await this.transition(presentation, {
      kind: 'record_activity_receipt',
      operationId,
      certainty,
      ...(messageTs ? { messageTs } : {}),
    });
    if (unavailable && presentation.schemaVersion === 3 &&
        presentation.activityProjection.surface === 'assistant_status' &&
        presentation.activityProjection.state !== 'cleared') {
      await this.transition(presentation, { kind: 'mark_activity_unavailable' });
    }
  }

  async transitionMilestone(input: SlackMilestoneTransition): Promise<void> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || !presentation.plan ||
        presentation.plan.tasks.length < 2) return;
    presentation = await this.transition(presentation, {
      kind: 'transition_task',
      taskId: input.taskId,
      to: input.to,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
    await this.projectMilestonesBestEffort(presentation, [input.taskId]);
  }

  /**
   * Agent execution failure is authoritative even when no per-tool milestone
   * event exists. Fail only the already-active row and mark untouched later
   * rows not run; never infer successful outcomes from a generic agent reply.
   */
  async recordExecutionFailure(reason: string): Promise<void> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || !presentation.plan) return;
    const activeIndex = presentation.plan.tasks.findIndex((task) => task.status === 'in_progress');
    if (activeIndex < 0) return;
    const active = presentation.plan.tasks[activeIndex]!;
    const changed = [active.id];
    presentation = await this.transition(presentation, {
      kind: 'transition_task',
      taskId: active.id,
      to: 'failed',
      detail: `Failed: ${safeMilestoneReason(reason)}`,
    });
    if (presentation.schemaVersion !== 3 || !presentation.plan) return;
    for (const task of presentation.plan.tasks.slice(activeIndex + 1)) {
      if (task.status !== 'pending') continue;
      presentation = await this.transition(presentation, {
        kind: 'transition_task',
        taskId: task.id,
        to: 'not_run',
        detail: 'Not run: work stopped after the prior milestone failed.',
      });
      changed.push(task.id);
      if (presentation.schemaVersion !== 3 || !presentation.plan) return;
    }
    await this.projectMilestonesBestEffort(presentation, changed);
  }

  async recordTerminalDeliveryReceipt(
    certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>,
  ): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || presentation.terminalDelivery.state !== 'intended' ||
        (presentation.terminalDelivery.operation.certainty !== 'pending' &&
          presentation.terminalDelivery.operation.certainty !== 'unknown')) return;
    await this.transition(presentation, {
      kind: 'record_terminal_delivery_receipt',
      operationId: presentation.terminalDelivery.operation.operationId,
      certainty,
    });
  }

  /**
   * Freeze terminal intent for content that another durable delivery path owns.
   * Resume any saved interim-stream cleanup before authorizing that write.
   * Returns whether a new write is safe. The caller must acknowledge that
   * delivery later before lifecycle cleanup.
   */
  async prepareDeferredTerminalDelivery(result: 'answer' | 'failure'): Promise<boolean> {
    let presentation = await this.requirePresentation();
    if (presentation.stream.priorStreamMessageTs) {
      presentation = await this.retireInterimStreamForFileShare(presentation);
    }
    if (presentation.schemaVersion !== 3) return false;
    const terminal = await this.prepareTerminalDelivery(result);
    return terminal.mayWrite;
  }

  /**
   * Start Slack's native Agent Session processing indicator independently of
   * the richer, owner-authored activity message. The intent is persisted
   * before the API call so admission replay cannot blindly duplicate an
   * outcome whose receipt is unknown.
   */
  async beginAgentSessionProcessing(): Promise<boolean> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || presentation.agentSession.disposition ||
        presentation.agentSession.desired !== 'processing') return false;
    if (presentation.agentSession.acknowledged === 'processing') return true;
    let operationId: string;
    if (!presentation.agentSession.operation) {
      operationId = `session_${hash(`${presentation.runId}:processing:1`).slice(0, 24)}`;
      presentation = await this.transition(presentation, {
        kind: 'set_agent_session_desired', desired: 'processing', operationId,
      });
    } else if (presentation.agentSession.operation.certainty === 'failed') {
      operationId = `session_${hash(`${presentation.runId}:processing:retry:${presentation.projectionVersion}`).slice(0, 24)}`;
      presentation = await this.transition(presentation, {
        kind: 'retry_agent_session', operationId,
      });
    } else {
      return false;
    }
    if (presentation.schemaVersion !== 3) return false;
    try {
      await setAgentSessionStatus(this.options.client, {
        channel_id: presentation.root.channelId,
        thread_ts: presentation.root.threadTs,
        status: 'processing',
        initiator_user_id: presentation.root.requesterUserId,
        ...ownerPersonaFields(presentation.owner),
      });
      await this.recordAgentSessionReceipt(operationId, 'acknowledged', 'processing');
      return true;
    } catch (error) {
      const certainty = slackEffectOutcome(error);
      await this.recordAgentSessionReceipt(operationId, certainty);
      if (certainty === 'failed' && isPermanentAgentSessionRejection(error)) {
        await this.markAgentSessionUnavailable(operationId);
      }
      return false;
    }
  }

  /**
   * Move the thread's session out of Slack's native `processing` so the custom
   * assistant status written next renders. Slack acknowledges a custom status
   * written while the session is in native processing but does not show it
   * (seen live on Violet, #198). A non-empty custom status then moves the
   * session back to processing, carried by the custom text.
   *
   * Transport only: the durable session stays `processing` (acknowledged),
   * which is what the thread shows once the custom status lands. A turn that
   * stops in between converges when its retry writes the status again or
   * when it settles. Fenced like any activity write: never for a thread whose
   * newer message another turn now presents.
   */
  async releaseNativeProcessing(): Promise<boolean> {
    return this.setAcknowledgedProcessingTransport('active');
  }

  /**
   * Show Slack's native indicator again after `releaseNativeProcessing` when
   * the custom status could not be shown. Transport only, like the release.
   */
  async reassertNativeProcessing(): Promise<boolean> {
    return this.setAcknowledgedProcessingTransport('processing');
  }

  private async setAcknowledgedProcessingTransport(
    status: 'active' | 'processing',
  ): Promise<boolean> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || presentation.agentSession.disposition ||
        presentation.agentSession.desired !== 'processing' ||
        presentation.agentSession.acknowledged !== 'processing') return false;
    if (!(await this.ownsLatestThreadGeneration(presentation))) return false;
    try {
      await setAgentSessionStatus(this.options.client, {
        channel_id: presentation.root.channelId,
        thread_ts: presentation.root.threadTs,
        status,
        initiator_user_id: presentation.root.requesterUserId,
        ...ownerPersonaFields(presentation.owner),
      });
      return true;
    } catch {
      return false;
    }
  }

  async settleAgentSession(result: 'answer' | 'failure'): Promise<void> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || !presentationHasTerminalOutcome(presentation)) return;
    const desired: SlackPresentationAgentSessionState = result === 'answer'
      ? 'active'
      : 'suspended';
    if (presentation.agentSession.disposition) return;
    if (presentation.agentSession.acknowledged === desired) return;
    let operationId: string;
    let mayWrite = false;
    // Agent Session status is a convergent setter on one fenced thread. A
    // terminal state may therefore replace an unresolved processing receipt;
    // the old operation id cannot acknowledge or mutate the replacement.
    if (!presentation.agentSession.operation ||
        presentation.agentSession.desired === 'processing') {
      operationId = `session_${hash(`${presentation.runId}:${desired}:1`).slice(0, 24)}`;
      presentation = await this.transition(presentation, {
        kind: 'set_agent_session_desired', desired, operationId,
      });
      mayWrite = true;
    } else if (presentation.agentSession.desired === desired &&
        presentation.agentSession.operation.certainty === 'failed') {
      operationId = `session_${hash(`${presentation.runId}:${desired}:retry:${presentation.projectionVersion}`).slice(0, 24)}`;
      presentation = await this.transition(presentation, {
        kind: 'retry_agent_session', operationId,
      });
      mayWrite = true;
    } else {
      return;
    }
    if (!mayWrite || presentation.schemaVersion !== 3) return;
    try {
      await setAgentSessionStatus(this.options.client, {
        channel_id: presentation.root.channelId,
        thread_ts: presentation.root.threadTs,
        status: desired,
        initiator_user_id: presentation.root.requesterUserId,
        ...ownerPersonaFields(presentation.owner),
      });
      await this.recordAgentSessionReceipt(operationId, 'acknowledged', desired);
    } catch (error) {
      const certainty = slackEffectOutcome(error);
      await this.recordAgentSessionReceipt(operationId, certainty);
      if (certainty === 'failed' && isPermanentAgentSessionRejection(error)) {
        await this.markAgentSessionUnavailable(operationId);
      }
    }
  }

  async supersedeSharedRepairEffects(): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3) return;
    const sessionSupersedable = !presentation.agentSession.disposition &&
      (!presentation.agentSession.operation ||
        presentation.agentSession.operation.certainty === 'failed');
    const cleanupSupersedable = presentation.activityProjection.surface ===
        'assistant_status' &&
      (presentation.activityProjection.state === 'visible' ||
        presentation.activityProjection.state === 'unavailable' &&
        presentation.currentActivity?.operation.certainty === 'unknown') &&
      (presentation.cleanup.state === 'not_required' ||
        presentation.cleanup.operation.certainty === 'failed');
    if (!sessionSupersedable && !cleanupSupersedable) return;
    await this.transition(presentation, { kind: 'supersede_shared_repair_effects' });
  }

  async prepareActivityCleanup(): Promise<SlackActivityCleanupPreparation> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion === 3 &&
        presentation.activityProjection.surface === 'assistant_status' &&
        !(await this.ownsLatestThreadGeneration(presentation))) return { kind: 'fenced' };
    if (presentation.schemaVersion === 3 && presentation.cleanup.state === 'required' &&
        presentation.cleanup.operation.certainty === 'unknown') {
      await this.reconcileActivityReceipts();
      presentation = await this.requirePresentation();
    }
    if (presentation.schemaVersion !== 3) return { kind: 'not_required' };
    if (presentation.cleanup.state === 'required' &&
        presentation.cleanup.operation.certainty === 'acknowledged' &&
        presentation.activityProjection.surface !== 'unselected' &&
        presentation.activityProjection.state === 'cleared') {
      return {
        kind: 'already_cleared',
        surface: presentation.activityProjection.surface,
      };
    }
    const ambiguousNativeActivity = presentation.activityProjection.surface ===
        'assistant_status' && presentation.activityProjection.state === 'unavailable' &&
      presentation.currentActivity?.operation.certainty === 'unknown';
    if (!presentationHasTerminalOutcome(presentation) ||
        presentation.activityProjection.surface === 'unselected' ||
        presentation.activityProjection.state !== 'visible' && !ambiguousNativeActivity ||
        (presentation.cleanup.state === 'not_required' &&
          presentation.cleanup.disposition !== undefined)) return { kind: 'not_required' };
    let operationId: string;
    if (presentation.cleanup.state === 'not_required') {
      operationId = `cleanup_${hash(`${presentation.runId}:activity:1`).slice(0, 24)}`;
      presentation = await this.transition(presentation, {
        kind: 'record_cleanup_intent', operationId, target: 'activity',
      });
    } else if (presentation.cleanup.operation.certainty === 'failed') {
      operationId = `cleanup_${hash(`${presentation.runId}:activity:retry:${presentation.projectionVersion}`).slice(0, 24)}`;
      presentation = await this.transition(presentation, {
        kind: 'retry_cleanup', operationId,
      });
    } else {
      return { kind: 'not_required' };
    }
    if (presentation.schemaVersion !== 3 ||
        presentation.activityProjection.surface === 'unselected') return { kind: 'not_required' };
    return {
      kind: 'prepared',
      operationId,
      projection: presentation.activityProjection,
    };
  }

  async recordActivityCleanupReceipt(
    operationId: string,
    certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>,
  ): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || presentation.cleanup.state !== 'required' ||
        presentation.cleanup.operation.operationId !== operationId ||
        (presentation.cleanup.operation.certainty !== 'pending' &&
          presentation.cleanup.operation.certainty !== 'unknown')) return;
    await this.transition(presentation, {
      kind: 'record_cleanup_receipt', operationId, certainty,
    });
  }

  /**
   * Resolve only receipts whose Slack coordinate can be inspected without
   * another effect. An incomplete or failed read deliberately leaves the
   * receipt unknown, so recovery never replays an unproven write.
   */
  async reconcileActivityReceipts(): Promise<void> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 ||
        presentation.activityProjection.surface !== 'message') return;
    const activityNeedsReconciliation =
      presentation.currentActivity?.operation.certainty === 'unknown';
    const cleanupNeedsReconciliation = presentation.cleanup.state === 'required' &&
      presentation.cleanup.operation.certainty === 'unknown' &&
      presentation.activityProjection.state === 'visible' &&
      Boolean(presentation.activityProjection.messageTs);
    if (!activityNeedsReconciliation && !cleanupNeedsReconciliation) return;

    const thread = await this.readThreadReplies(presentation);
    if (!thread) return;
    if (activityNeedsReconciliation && presentation.currentActivity) {
      const operationId = presentation.currentActivity.operation.operationId;
      const found = thread.messages.find((message) =>
        message.clientMsgId === slackClientMessageId(operationId)
      );
      if (found?.ts) {
        await this.recordActivityReceipt(operationId, 'acknowledged', found.ts);
        presentation = await this.requirePresentation();
      } else if (thread.complete) {
        await this.recordActivityReceipt(operationId, 'failed');
        presentation = await this.requirePresentation();
      }
    }
    if (presentation.schemaVersion !== 3 || presentation.cleanup.state !== 'required' ||
        presentation.cleanup.operation.certainty !== 'unknown' ||
        presentation.activityProjection.surface !== 'message' ||
        presentation.activityProjection.state !== 'visible' ||
        !presentation.activityProjection.messageTs) return;
    const targetTs = presentation.activityProjection.messageTs;
    const remainsVisible = thread.messages.some((message) => message.ts === targetTs);
    if (remainsVisible) {
      await this.recordActivityCleanupReceipt(
        presentation.cleanup.operation.operationId,
        'failed',
      );
    } else if (thread.complete) {
      await this.recordActivityCleanupReceipt(
        presentation.cleanup.operation.operationId,
        'acknowledged',
      );
    }
  }

  async settleLifecycle(): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || presentation.lifecyclePhase === 'settled' ||
        !presentationHasTerminalOutcome(presentation)) return;
    await this.transition(presentation, { kind: 'set_lifecycle_phase', phase: 'settled' });
  }

  private async recordAgentSessionReceipt(
    operationId: string,
    certainty: Exclude<SlackPresentationReceiptCertainty, 'pending'>,
    acknowledged?: SlackPresentationAgentSessionState,
  ): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || !presentation.agentSession.operation ||
        presentation.agentSession.operation.operationId !== operationId ||
        presentation.agentSession.operation.certainty !== 'pending') return;
    await this.transition(presentation, {
      kind: 'record_agent_session_receipt',
      operationId,
      certainty,
      ...(certainty === 'acknowledged' && acknowledged ? { acknowledged } : {}),
    });
  }

  private async markAgentSessionUnavailable(operationId: string): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || presentation.agentSession.disposition ||
        presentation.agentSession.operation?.operationId !== operationId ||
        presentation.agentSession.operation.certainty !== 'failed') return;
    await this.transition(presentation, { kind: 'mark_agent_session_unavailable' });
  }

  /** Freeze once before prompt persistence; retries reuse the stored decision. */
  async freezeProgressiveEligibility(
    candidate: ProgressiveEligibilityDecision,
  ): Promise<FrozenProgressiveEligibilityDecision> {
    let presentation = await this.requirePresentation();
    presentation = await this.advanceFenceIfRequired(presentation);
    if (presentation.progressiveEligibility.status === 'pending') {
      presentation = await this.transition(presentation, {
        kind: 'freeze_progressive_eligibility',
        // A V1 row has no model intent, so it cannot hold text until a
        // final-answer declaration. It keeps the effect-capable denial.
        eligibility: presentation.schemaVersion === 1 &&
            candidate.reason === 'final_answer_release'
          ? { allowed: false, reason: 'effect_capable' }
          : candidate,
      });
    }
    if (presentation.progressiveEligibility.status !== 'frozen') {
      throw new Error('Slack progressive eligibility did not freeze.');
    }
    return {
      allowed: presentation.progressiveEligibility.allowed,
      reason: presentation.progressiveEligibility.reason,
      presentationSchemaVersion: presentation.schemaVersion,
    };
  }

  async setTitle(candidate: string): Promise<void> {
    let presentation = await this.requirePresentation();
    const title = deriveSlackThreadTitle(candidate, presentation.plan?.tasks[0]?.title);
    const valueHash = hash(title);
    if (!presentation.title) {
      presentation = await this.transition(presentation, {
        kind: 'record_title_intent',
        valueHash,
      });
    }
    const titleState = presentation.title;
    if (!titleState || titleState.valueHash !== valueHash || titleState.outcome !== 'pending') {
      return;
    }
    let outcome: 'set' | 'failed' = 'set';
    try {
      await this.options.client.assistant.threads.setTitle({
        channel_id: presentation.root.channelId,
        thread_ts: presentation.root.threadTs,
        title,
      });
    } catch {
      outcome = 'failed';
    }
    await this.transition(presentation, { kind: 'record_title_outcome', outcome });
  }

  async prepareReceipt(input: {
    instanceId: string;
    receipt: FlueDispatchReceiptV1;
    eligibility: ProgressiveEligibilityDecision;
  }): Promise<SlackProgressiveReadRelay | undefined> {
    try {
      return await this.openReceiptRelay(input);
    } catch (error) {
      // The dispatch goes on without a relay; the final's record says why
      // this answer was not streamed.
      this.degradedReason ??= 'relay_setup_failed';
      throw error;
    }
  }

  private async openReceiptRelay(input: {
    instanceId: string;
    receipt: FlueDispatchReceiptV1;
    eligibility: ProgressiveEligibilityDecision;
  }): Promise<SlackProgressiveReadRelay | undefined> {
    const target = await this.options.state.matchFlueObservation(
      input.instanceId,
      input.receipt.submissionId,
    );
    let presentation = await this.requirePresentation();
    if (
      !target ||
      target.turnJobId !== presentation.turnJobId ||
      target.submissionId !== input.receipt.submissionId ||
      (target.workCorrelation && target.workCorrelation.runId !== presentation.runId)
    ) {
      return undefined;
    }
    presentation = await this.advanceFenceIfRequired(presentation);
    const frozenEligibility = presentation.progressiveEligibility;
    if (frozenEligibility.status !== 'frozen' ||
        frozenEligibility.allowed !== input.eligibility.allowed ||
        frozenEligibility.reason !== input.eligibility.reason) {
      return undefined;
    }
    const allowed = frozenEligibility.allowed && presentationAllowsProgressive(presentation);
    if (!allowed) {
      this.degradedReason = input.eligibility.allowed ||
        input.eligibility.reason === 'operations_disabled'
        ? 'runtime_gate_disabled'
        : input.eligibility.reason === 'effect_capable'
          ? 'effect_capable'
          : 'policy_ineligible';
    }
    if (presentation.plan && presentationUsesNativeTasks(presentation)) {
      presentation = await this.startNativePlan(
        presentation,
        input.instanceId,
        input.receipt.submissionId,
      );
    }
    if (!allowed || presentation.stream.state === 'fallback' ||
        presentation.stream.state === 'unknown' ||
        presentation.stream.state === 'finalized') {
      return undefined;
    }
    if (presentation.schemaVersion !== 1 &&
        (presentation.progressiveIntent.status === 'not_requested' ||
          presentation.progressiveIntent.status === 'denied')) {
      return undefined;
    }
    return new ReceiptScopedTextRelay({
      submissionId: input.receipt.submissionId,
      mode: progressiveStreamingModeForReason(frozenEligibility.reason),
      prepareAppend: (control) => this.prepareProgressiveAppend(control),
      append: (chunk, control) => this.appendProgressiveText(
        input.instanceId,
        input.receipt.submissionId,
        chunk,
        control,
      ),
      invalidate: (reason) => this.invalidate(reason),
      streamedPrefixBound: () => this.streamCapBound,
      ...(presentation.schemaVersion !== 1
        ? {
            modelIntent: {
              initial: presentation.progressiveIntent,
              transition: (intent: ProgressiveIntentTransition) =>
                this.recordProgressiveIntent(intent),
            },
          }
        : {}),
    });
  }

  async finalize(
    text: string,
    format: SlackReplyFormat,
    terminalTaskStatus: 'complete' | 'error',
    observer: SlackPresentationDeliveryObserver,
    tablePresentation?: SlackTablePresentation,
    artifacts: readonly SlackArtifactReceipt[] = [],
  ): Promise<AgentViewFinalResult> {
    const approved = canonicalSlackReplyText(text, format);
    let presentation = await this.requirePresentation();
    // A stream old enough for Slack to have sealed it is closed first; the
    // terminal then takes the fresh-post route instead of a stop that fails.
    if (this.streamIsAged(presentation) && await this.retireAgedStream()) {
      presentation = await this.requirePresentation();
    }
    if (presentation.stream.state === 'finalized' ||
        presentation.stream.state === 'artifact_delivered') {
      if (presentation.schemaVersion === 3 && presentation.stream.messageTs &&
          presentation.terminalDelivery.state === 'intended' &&
          (presentation.terminalDelivery.operation.certainty === 'pending' ||
            presentation.terminalDelivery.operation.certainty === 'unknown')) {
        await this.recordTerminalDeliveryReceipt('acknowledged');
        presentation = await this.requirePresentation();
      }
      return this.handledResult(presentation, approved, format);
    }
    if (presentation.stream.priorStreamMessageTs ||
        artifacts.length > 0 && presentation.stream.state === 'streaming') {
      presentation = await this.retireInterimStreamForFileShare(presentation);
    }
    if (artifacts.length > 0 &&
        presentation.stream.state !== 'absent' && presentation.stream.state !== 'fallback') {
      // A previous terminal may already be visible. Never turn its ambiguous
      // stop/update into a second file message, or silently drop the files.
      throw new Error('Slack file delivery requires reconciliation of the existing presentation.');
    }
    if (presentation.schemaVersion === 3 && presentation.stream.state === 'finalizing' &&
        presentation.stream.messageTs && presentation.terminalDelivery.state === 'intended' &&
        presentation.terminalDelivery.result === (terminalTaskStatus === 'error' ? 'failure' : 'answer') &&
        (presentation.terminalDelivery.operation.certainty === 'pending' ||
          presentation.terminalDelivery.operation.certainty === 'unknown')) {
      return this.recoverFinalizingStream(presentation, text, format, observer, tablePresentation);
    }
    if (presentation.schemaVersion === 3 && presentation.stream.messageTs &&
        (presentation.stream.state === 'unknown' || presentation.stream.state === 'reconciling') &&
        this.terminalIntentAcceptsRecovery(presentation, terminalTaskStatus)) {
      // A prior attempt lost certainty after Slack already gave this run its
      // message coordinate. Replaying the terminal without reconciling can
      // never succeed, so recover on the known message instead of throwing
      // until the relay abandons the run silently.
      const terminal = await this.prepareTerminalDelivery(
        terminalTaskStatus === 'error' ? 'failure' : 'answer',
      );
      if (terminal.acknowledged) {
        return this.handledResult(presentation, approved, format);
      }
      // Another actor may have frozen, acknowledged, or abandoned a terminal
      // between the first read and this one. Re-validate on the state the
      // compare-and-swap below will fence, and never overwrite a different
      // frozen terminal.
      presentation = await this.requirePresentation();
      if (presentation.schemaVersion !== 3 || !presentation.stream.messageTs ||
          (presentation.stream.state !== 'unknown' && presentation.stream.state !== 'reconciling') ||
          !this.terminalIntentAcceptsRecovery(presentation, terminalTaskStatus)) {
        throw new Error('Slack Agent View presentation requires reconciliation.');
      }
      presentation = await this.transition(presentation, presentation.stream.state === 'unknown'
        ? { kind: 'reconcile_unknown_stream' }
        : { kind: 'mark_finalizing' });
      return this.recoverFinalizingStream(presentation, text, format, observer, tablePresentation);
    }
    if (presentation.schemaVersion === 3 && !presentation.stream.messageTs &&
        (presentation.stream.state === 'starting' || presentation.stream.state === 'unknown') &&
        presentation.terminalDelivery.state === 'none') {
      // Only a checklist card or a streamed prefix can have been started
      // here, never the answer. Without its coordinate the run could only
      // retry until it exhausted, so the terminal takes the fresh-post route.
      console.warn('[chickpea] Slack Agent View stream coordinate missing; posting the final fresh');
      presentation = await this.transition(presentation, { kind: 'stream_coordinate_lost' });
    }
    if (presentation.stream.state === 'starting' || presentation.stream.state === 'unknown') {
      throw new Error('Slack Agent View presentation requires reconciliation.');
    }
    const terminal = await this.prepareTerminalDelivery(
      terminalTaskStatus === 'error' ? 'failure' : 'answer',
    );
    if (!terminal.mayWrite) {
      if (terminal.acknowledged) {
        return this.handledResult(presentation, approved, format);
      }
      throw new Error('Slack terminal delivery requires reconciliation.');
    }
    presentation = await this.requirePresentation();
    if (presentation.stream.state === 'fallback') {
      return freshFinalResult(presentation, terminal.operationId);
    }
    if (artifacts.length > 0 && presentation.stream.state === 'absent') {
      // Staged files publish with the text in one completion call, which
      // Slack cannot stream. Route the terminal through the fallback state so
      // the presenter's file share owns the coordinate and repair semantics.
      await this.transition(presentation, { kind: 'mark_file_share_intent' });
      return freshFinalResult(presentation, terminal.operationId);
    }

    const recoverStream = (finalizing: SlackRunPresentation) =>
      this.recoverFinalizingStream(finalizing, text, format, observer, tablePresentation);
    // The stream carries the first message. Its table and footer move to the
    // last follow-up when the answer continues. A stream whose acknowledged
    // prefix no longer matches the answer is corrected with chat.update,
    // which refuses a message Slack accepts from a stream (`msg_too_long`),
    // so its first message keeps the recovery bound.
    const correctionSplit = presentation.schemaVersion === 3 &&
        presentation.stream.state === 'streaming' && presentation.stream.messageTs &&
        !this.streamedPrefixMatches(presentation, approved)
      ? this.recoverySplit(presentation, approved)
      : undefined;
    const parts = correctionSplit
      ? slackReplyParts(approved, format, correctionSplit)
      : this.replyParts(presentation, approved, format);
    const first = parts[0]!;
    const renderedTable = renderSlackReplyTable(tablePresentation, parts.at(-1)!);
    const closes = !await this.planContinuations(
      parts, renderedTable, [], correctionSplit ?? this.replySplit(presentation, approved),
      correctionSplit !== undefined,
    );
    presentation = await this.requirePresentation();
    const footerBlocks = closes
      ? [
          ...(renderedTable ? [renderedTable.block as unknown as KnownBlock] : []),
          this.footerBlock(),
        ]
      : [];
    const taskChunks = presentationUsesNativeTasks(presentation)
      ? terminalTaskChunks(presentation, terminalTaskStatus)
      : [];

    if (presentation.stream.state === 'absent') {
      presentation = await this.transition(presentation, { kind: 'stream_start_intent' });
      const startPayload = streamStartPayload(presentation, {
        markdownText: first,
        taskChunks,
      });
      const stop = footerBlocks.length > 0 ? { blocks: footerBlocks } : {};
      const attemptId = await observer.before({
        method: 'slack_chat_stream',
        approvedOutput: approved,
        renderedPayload: JSON.stringify({
          method: 'slack_chat_stream',
          start: startPayload,
          stop,
          terminalTaskStatus,
        }),
      });
      let started: Awaited<ReturnType<WebClient['chat']['startStream']>>;
      try {
        started = await this.options.client.chat.startStream(startPayload);
      } catch (error) {
        const outcome = slackEffectOutcome(error);
        if (outcome === 'failed') {
          await observer.after({
            attemptId,
            outcome,
            safeFailureCode: 'slack_stream_not_started',
          });
          await this.transition(presentation, { kind: 'mark_fallback', outcome: 'fallback' });
          return freshFinalResult(await this.requirePresentation());
        }
        await this.markUnknown(presentation, 'unknown_effect');
        await this.recordTerminalDeliveryReceipt('unknown');
        await observer.after({
          attemptId,
          outcome,
          safeFailureCode: 'slack_stream_start_unknown',
        });
        throw error;
      }
      const messageTs = requireSlackTs(started.ts);
      presentation = await this.recordStreamStarted(
        presentation,
        messageTs,
        terminalFlueIdentity(presentation),
      );
      return this.stopKnownStream(
        presentation,
        attemptId,
        observer,
        [],
        footerBlocks,
        terminalTaskStatus,
        first,
        utf8Length(first),
        recoverStream,
      );
    }

    if (presentation.stream.state !== 'streaming' || !presentation.stream.messageTs) {
      throw new Error('Slack Agent View presentation is not terminalizable.');
    }
    const acknowledged = prefixAtUtf8Length(approved, presentation.stream.acknowledgedByteLength);
    if (acknowledged === undefined || !this.streamedPrefixMatches(presentation, approved)) {
      return this.correctDivergentStream(
        presentation,
        first,
        approved,
        terminalTaskStatus,
        observer,
        closes ? renderedTable : undefined,
        closes,
      );
    }
    const suffix = first.slice(acknowledged.length);
    const stopChunks: AnyChunk[] = [
      ...(suffix ? [{ type: 'markdown_text' as const, text: suffix }] : []),
      ...taskChunks,
    ];
    const stop = {
      ...(stopChunks.length > 0 ? { chunks: stopChunks } : {}),
      ...(footerBlocks.length > 0 ? { blocks: footerBlocks } : {}),
    };
    const attemptId = await observer.before({
      method: 'slack_chat_stream_resume',
      approvedOutput: approved,
      renderedPayload: JSON.stringify({
        method: 'slack_chat_stream_resume',
        channel: presentation.root.channelId,
        ts: presentation.stream.messageTs,
        stop,
        terminalTaskStatus,
      }),
    });
    return this.stopKnownStream(
      presentation,
      attemptId,
      observer,
      stopChunks,
      footerBlocks,
      terminalTaskStatus,
      first,
      utf8Length(suffix),
      recoverStream,
    );
  }

  async markFallbackDelivered(messageTs: unknown, outcome: 'fallback' = 'fallback'): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.stream.state !== 'fallback') return;
    await this.transition(presentation, {
      kind: 'mark_artifact_delivered',
      outcome,
      messageTs: requireSlackTs(messageTs),
    });
    await this.recordTerminalDeliveryReceipt('acknowledged');
  }

  async markFallbackDeliveryFailed(
    certainty: Exclude<SlackPresentationReceiptCertainty, 'pending' | 'acknowledged'>,
  ): Promise<void> {
    await this.recordTerminalDeliveryReceipt(certainty);
  }

  /**
   * Freeze a long answer's follow-up messages before the final's first effect,
   * because the plan decides whether the final itself carries the footer.
   * Returns whether a durable plan owns the follow-ups; only V3 has one. A
   * replay keeps the stored plan. `split` records how the first message was
   * cut, so a final posted fresh instead cuts it the same way.
   */
  async planContinuations(
    parts: readonly string[],
    table?: RenderedSlackTablePresentation,
    files: readonly CompletedSlackArtifactReceipt[] = [],
    split?: SlackReplySplit,
    replace = false,
  ): Promise<boolean> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3) return false;
    const existing = presentation.continuations;
    const replaceable = replace && existing?.state === 'active' &&
      existing.parts.every((part) => !part.operation) &&
      JSON.stringify(existing.split ?? {}) !== JSON.stringify(split ?? {});
    if (parts.length < 2) {
      if (replaceable) {
        await this.transition(presentation, {
          kind: 'record_continuation_plan', replace: true, parts: [], closing: existing!.closing,
        });
      }
      return false;
    }
    if (!existing || replaceable) {
      await this.transition(presentation, {
        kind: 'record_continuation_plan',
        ...(existing ? { replace: true as const } : {}),
        shaped: true,
        headerOverhead: true,
        ...(split ? { split } : {}),
        parts: parts.slice(1),
        closing: {
          footer: this.options.footer,
          ...(table ? { table: { block: table.block, fallbackText: table.fallbackText } } : {}),
          ...(files.length > 0 ? { files } : {}),
        },
      });
    }
    return true;
  }

  /**
   * The messages of an answer whose plan froze while a stream was to carry
   * it. A final posted fresh instead splits the same way, so the planned
   * follow-ups continue exactly where it ends.
   */
  async frozenReplyParts(approved: string, format: SlackReplyFormat): Promise<string[] | undefined> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3 || !presentation.continuations) return undefined;
    const { split } = presentation.continuations;
    // A plan frozen by an earlier build splits the way that build did, split
    // or not, so its first message ends where its stored follow-ups begin.
    if (!presentation.continuations.shaped || !presentation.continuations.headerOverhead) {
      return slackReplyParts(
        approved,
        format,
        frozenPlanSplit(presentation.continuations, split ?? {}),
      );
    }
    return split ? slackReplyParts(approved, format, split) : undefined;
  }

  /**
   * Post the owed follow-up messages in order once the canonical final is
   * acknowledged. Each post persists its intent first and sends a
   * client_msg_id derived from its operation, so an ambiguous attempt is
   * settled by thread readback rather than a second post. A Slack failure
   * stops here without throwing; durable repair resumes the set later.
   */
  async deliverContinuations(options: {
    onDelivered?: (messageTs: string, text: string) => Promise<void>;
    /** Repair gave up: stop owing whatever is still unsent. */
    abandonUnresolved?: boolean;
  } = {}): Promise<void> {
    for (let step = 0; step < CONTINUATION_DELIVERY_STEPS; step += 1) {
      const presentation = await this.requirePresentation();
      if (presentation.schemaVersion !== 3 ||
          presentation.continuations?.state !== 'active') return;
      if (presentation.terminalDelivery.state === 'abandoned') {
        await this.transition(presentation, { kind: 'abandon_continuations' });
        return;
      }
      if (!presentationHasTerminalOutcome(presentation)) return;
      const index = presentation.continuations.parts.findIndex((part) =>
        part.operation?.certainty !== 'acknowledged'
      );
      const part = presentation.continuations.parts[index];
      if (!part) return;
      let settled: boolean;
      if (part.operation && part.operation.certainty !== 'failed') {
        settled = await this.reconcileContinuation(presentation, index, options.onDelivered);
      } else {
        settled = await this.postContinuation(presentation, index, options.onDelivered);
      }
      if (!settled) {
        if (options.abandonUnresolved) {
          await this.transition(await this.requirePresentation(), { kind: 'abandon_continuations' });
        }
        return;
      }
    }
  }

  private async postContinuation(
    presentation: Extract<SlackRunPresentation, { schemaVersion: 3 }>,
    index: number,
    onDelivered: ((messageTs: string, text: string) => Promise<void>) | undefined,
  ): Promise<boolean> {
    const plan = presentation.continuations!;
    const part = plan.parts[index]!;
    // Only markdown answers continue. The last part closes the reply.
    const rendered = renderSlackReplyPart(
      part.text,
      'markdown',
      index === plan.parts.length - 1 ? plan.closing : undefined,
    );
    // A re-split part is new content, so it gets its own client_msg_id.
    const operationId = part.operation?.operationId ??
      `continuation_${hash(`${presentation.runId}:${index + 1}${
        plan.resplits ? `:resplit${plan.resplits}` : ''}`).slice(0, 24)}`;
    const intended = await this.transition(presentation, {
      kind: 'record_continuation_intent', index, operationId,
    });
    let messageTs: string;
    try {
      const posted = await this.options.client.chat.postMessage({
        ...rendered,
        channel: presentation.root.channelId,
        thread_ts: presentation.root.threadTs,
        client_msg_id: slackClientMessageId(operationId),
        ...ownerPersonaFields(presentation.owner),
      } as unknown as Parameters<WebClient['chat']['postMessage']>[0]);
      messageTs = requireSlackTs(posted.ts);
    } catch (error) {
      const refused = await this.transition(intended, {
        kind: 'record_continuation_receipt',
        index,
        operationId,
        certainty: slackEffectOutcome(error),
      });
      console.warn(
        `[chickpea] Slack reply continuation ${slackEffectOutcome(error)}: ` +
        safeSlackErrorCode(error),
      );
      // The same content would be refused on every retry. Re-split it now.
      if (definiteContentRejection(error)) return this.resplitRefusedContinuation(refused, index);
      return false;
    }
    await this.transition(intended, {
      kind: 'record_continuation_receipt', index, operationId, certainty: 'acknowledged', messageTs,
    });
    await notifyContinuation(onDelivered, messageTs, part.text);
    return true;
  }

  /**
   * Slack refused a follow-up's content outright (too many or too long
   * rendered blocks, or malformed ones), so nothing of it posted. Split the
   * text it and the later parts carry into smaller messages; after two
   * smaller splits, end the reply with the shortened note and the footer
   * alone. A refusal of that last message abandons the follow-ups, so a
   * reply is never retried with content Slack cannot accept.
   */
  private async resplitRefusedContinuation(
    presentation: SlackRunPresentation,
    index: number,
  ): Promise<boolean> {
    if (presentation.schemaVersion !== 3 || presentation.continuations?.state !== 'active') {
      return false;
    }
    const plan = presentation.continuations;
    const resplits = (plan.resplits ?? 0) + 1;
    if (resplits > MAX_SLACK_CONTINUATION_RESPLITS) {
      await this.transition(presentation, { kind: 'abandon_continuations' });
      return false;
    }
    let parts: string[];
    if (resplits === MAX_SLACK_CONTINUATION_RESPLITS) {
      parts = [SLACK_REPLY_SHORTENED_NOTE];
    } else {
      const note = `\n\n${SLACK_REPLY_SHORTENED_NOTE}`;
      const texts = plan.parts.slice(index).map((part) => part.text);
      const shortened = texts.at(-1)!.endsWith(note);
      if (shortened) texts[texts.length - 1] = texts.at(-1)!.slice(0, -note.length);
      const scale = 2 ** resplits;
      parts = splitSlackMarkdownReply(texts.join('\n\n'), {
        maxParts: MAX_SLACK_CONTINUATION_PARTS - index,
        partLimit: Math.floor(slackMarkdownBlockTextLimit / scale),
        maxBlocks: Math.floor(slackMarkdownPartBlockLimit / scale),
      });
      if (shortened && !parts.at(-1)!.endsWith(note)) parts[parts.length - 1] += note;
    }
    await this.transition(presentation, { kind: 'resplit_continuations', index, parts });
    console.warn(`[chickpea] Slack reply continuation re-split: ${parts.length} part(s)`);
    return true;
  }

  /**
   * An intent without a receipt may or may not be visible. Read the thread
   * after the final for its client_msg_id; only a complete read without it
   * proves the post never landed. A young intent may still be in flight.
   */
  private async reconcileContinuation(
    presentation: Extract<SlackRunPresentation, { schemaVersion: 3 }>,
    index: number,
    onDelivered: ((messageTs: string, text: string) => Promise<void>) | undefined,
  ): Promise<boolean> {
    const part = presentation.continuations!.parts[index]!;
    const operation = part.operation!;
    if (operation.certainty === 'pending' &&
        this.now() - presentation.updatedAt < CONTINUATION_INTENT_GRACE_MS) return false;
    const thread = await this.readThreadReplies(presentation, presentation.stream.messageTs);
    if (!thread) return false;
    const found = thread.messages.find((message) =>
      message.clientMsgId === slackClientMessageId(operation.operationId)
    );
    if (!found?.ts && !thread.complete) return false;
    await this.transition(presentation, {
      kind: 'record_continuation_receipt',
      index,
      operationId: operation.operationId,
      ...(found?.ts
        ? { certainty: 'acknowledged' as const, messageTs: found.ts }
        : { certainty: 'failed' as const }),
    });
    if (found?.ts) await notifyContinuation(onDelivered, found.ts, part.text);
    return true;
  }

  private handledResult(
    presentation: SlackRunPresentation,
    approved: string,
    format: SlackReplyFormat,
  ): AgentViewFinalResult {
    if (!presentation.stream.messageTs) return { handled: true };
    return {
      handled: true,
      messageTs: presentation.stream.messageTs,
      text: this.replyParts(presentation, approved, format)[0]!,
    };
  }

  /**
   * The messages this answer occupies. An acknowledged stream prefix stays in
   * the first; a stream that must be corrected leaves room for its marker.
   * Presentations older than V3 have no durable plan and use one message.
   */
  private replyParts(
    presentation: SlackRunPresentation,
    approved: string,
    format: SlackReplyFormat,
  ): string[] {
    if (presentation.schemaVersion !== 3) {
      return slackReplyParts(approved, format, {
        ...this.replySplit(presentation, approved),
        maxParts: 1,
      });
    }
    const plan = presentation.continuations;
    const split = plan?.split ?? this.replySplit(presentation, approved);
    return slackReplyParts(approved, format, plan ? frozenPlanSplit(plan, split) : split);
  }

  /** Whether the acknowledged stream prefix is exactly the start of this answer. */
  private streamedPrefixMatches(presentation: SlackRunPresentation, approved: string): boolean {
    const acknowledged = prefixAtUtf8Length(approved, presentation.stream.acknowledgedByteLength);
    return acknowledged !== undefined &&
      hash(acknowledged) === (presentation.stream.acknowledgedPrefixHash ?? hash(''));
  }

  /** How the first message is cut: after the streamed prefix, or with room for a marker. */
  private replySplit(presentation: SlackRunPresentation, approved: string): SlackReplySplit {
    const streamed = presentation.stream.presentationOutcome !== 'corrected' &&
      this.streamedPrefixMatches(presentation, approved);
    return streamed
      ? { minFirstPartLength: prefixAtUtf8Length(approved, presentation.stream.acknowledgedByteLength)!.length }
      : { firstPartLimit: slackMarkdownBlockTextLimit - CORRECTED_MARKER.length - 2 };
  }

  /**
   * The split of a first message replaced through chat.update: a divergent
   * stream's correction, or recovery of a stream whose stop was lost. Both
   * compute the same split, so a recovery after an interrupted correction
   * keeps the frozen plan. A split without a kept streamed prefix leaves
   * room for the correction marker inside the update bound.
   */
  private recoverySplit(presentation: SlackRunPresentation, approved: string): SlackReplySplit {
    const split = this.replySplit(presentation, approved);
    return recoveryReplySplit(
      split,
      approved,
      split.minFirstPartLength === undefined ? CORRECTED_MARKER.length + 2 : 0,
    );
  }

  /** Retire only the exact saved interim stream, before any terminal write. */
  private async retireInterimStreamForFileShare(
    presentation: SlackRunPresentation,
  ): Promise<SlackRunPresentation> {
    presentation = await this.transition(presentation, { kind: 'retire_stream_for_file_share' });
    const messageTs = presentation.stream.priorStreamMessageTs!;
    const coordinate = { channel: presentation.root.channelId, ts: messageTs };
    try {
      await this.options.client.chat.stopStream(coordinate);
    } catch (error) {
      if (slackEffectOutcome(error) !== 'failed' ||
          !['message_not_in_streaming_state', 'message_not_found'].includes(safeSlackErrorCode(error))) {
        throw error;
      }
    }
    try {
      await this.options.client.chat.delete(coordinate);
    } catch (error) {
      if (slackEffectOutcome(error) !== 'failed' || safeSlackErrorCode(error) !== 'message_not_found') {
        throw error;
      }
    }
    // A crash before this receipt repeats only stop/delete at this coordinate.
    // It cannot repeat completion because terminal intent has not begun.
    return this.transition(presentation, { kind: 'file_share_stream_retired', messageTs });
  }

  /** Whether this Run still has its durable presentation to drive. */
  async hasPresentation(): Promise<boolean> {
    return await this.options.state.getRunPresentation(this.options.runId) !== undefined;
  }

  async markCanonicalFinalized(): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.stream.state === 'absent') {
      const finalized = await this.transition(presentation, { kind: 'mark_non_stream_finalized' });
      this.emitFinalizationRecord(finalized);
      return;
    }
    if (presentation.stream.state !== 'artifact_delivered') return;
    const finalized = await this.transition(presentation, { kind: 'mark_finalized' });
    this.emitFinalizationRecord(finalized);
  }

  /**
   * Attach a native plan to a presentation that Work admission froze WITHOUT
   * one. A substantive @-mention is classified late (after admission), so —
   * unlike ambient/obvious-work turns — its work checklist never reached
   * buildPlan at create time and no task card would ever open. Attaching it
   * here lets the already-wired presenter open the card during the same turn
   * and supersede the interim legacy checklist through onNativeStarted,
   * mirroring the ambient outcome exactly.
   *
   * A no-op (and never throws for these expected cases) when native tasks are
   * off (legacy checklist path is preserved), a plan already exists
   * (ambient/obvious-work — never double-attach or reorder), the checklist is
   * outside the 1..4 native range, or any Slack effect has already begun
   * (delivery-only replay, a streaming or finalized presentation).
   */
  async adoptLatePlan(taskLabels: readonly string[]): Promise<void> {
    if (taskLabels.length < 1 || taskLabels.length > 4) return;
    const presentation = await this.requirePresentation();
    if (!presentationUsesNativeTasks(presentation)) return;
    if (presentation.schemaVersion === 3 && taskLabels.length < 2) return;
    if (presentation.plan) return;
    if (presentation.stream.state !== 'absent') return;
    await this.transition(presentation, { kind: 'adopt_plan', taskLabels });
  }

  private async appendProgressiveText(
    instanceId: string,
    submissionId: string,
    chunk: ProgressiveTextChunk,
    control?: ProgressiveAppendControl,
  ): Promise<void> {
    const slot = this.appendSlot;
    if (slot === 'yielded') this.appendSlot = undefined;
    this.rawText += chunk.delta;
    if (utf8Length(this.rawText) > MAX_PROGRESSIVE_BUFFER_BYTES) {
      this.degradedReason = 'unsafe_incomplete_block';
      return;
    }
    let presentation = await this.requirePresentation();
    const streamable = streamedReplyPrefix(this.rawText, presentation.stream.acknowledgedByteLength);
    const safePrefix = streamable.text;
    if (streamable.capBound !== undefined) this.streamCapBound = streamable.capBound;
    const priorPosition = presentation.stream.flue?.lastAcceptedPosition;
    if (priorPosition && comparePosition(chunk.position, priorPosition) <= 0) return;
    if (!safePrefix || this.degradedReason) return;

    if (presentation.stream.state === 'absent') {
      presentation = await this.transition(presentation, { kind: 'stream_start_intent' });
      const startPayload = streamStartPayload(presentation, { markdownText: safePrefix });
      let started: Awaited<ReturnType<WebClient['chat']['startStream']>>;
      try {
        started = await this.options.client.chat.startStream(startPayload);
      } catch (error) {
        if (slackEffectOutcome(error) === 'failed') {
          await this.transition(presentation, { kind: 'mark_fallback', outcome: 'fallback' });
          this.degradedReason = 'unsafe_incomplete_block';
          return;
        }
        await this.markUnknown(presentation, 'unknown_effect');
        throw error;
      }
      presentation = await this.recordStreamStarted(
        presentation,
        requireSlackTs(started.ts),
        { instanceId, submissionId, messageId: chunk.messageId },
      );
      this.observeStreamStarted();
      await this.recordAcknowledgedPrefix(presentation, chunk.position, safePrefix);
      this.nextAppendAt = this.now() + this.appendIntervalMs();
      return;
    }
    if (presentation.stream.state !== 'streaming' || !presentation.stream.messageTs ||
        presentation.stream.flue?.instanceId !== instanceId ||
        presentation.stream.flue?.submissionId !== submissionId) {
      return;
    }
    const acknowledged = prefixAtUtf8Length(
      safePrefix,
      presentation.stream.acknowledgedByteLength,
    );
    if (acknowledged === undefined ||
        hash(acknowledged) !== (presentation.stream.acknowledgedPrefixHash ?? hash(''))) {
      await this.markUnknown(presentation, 'unknown_effect');
      throw new Error('Progressive Slack prefix cannot be reconstructed.');
    }
    const delta = safePrefix.slice(acknowledged.length);
    if (!delta) return;
    if (slot === 'yielded') return;
    if (slot === 'reserved') {
      this.appendSlot = undefined;
    } else {
      const delay = Math.max(0, this.nextAppendAt - this.now());
      if (delay > 0) await this.wait(delay);
      if (!(await this.reserveAppendSlot(presentation.root.workspaceId, control))) return;
      // The wait may have outlived this writer's view of the row.
      presentation = await this.requirePresentation();
      if (presentation.stream.state !== 'streaming' ||
          presentation.stream.acknowledgedByteLength !== utf8Length(acknowledged)) {
        return;
      }
    }
    presentation = await this.transition(presentation, {
      kind: 'append_intent',
      position: chunk.position,
      from: presentation.stream.acknowledgedByteLength,
      to: utf8Length(safePrefix),
      hash: hash(safePrefix),
    });
    const pending = presentation.stream.pendingAppend!;
    try {
      await this.options.client.chat.appendStream({
        channel: presentation.root.channelId,
        ts: presentation.stream.messageTs!,
        chunks: [{ type: 'markdown_text', text: delta }],
      });
    } catch (error) {
      const outcome = slackEffectOutcome(error);
      if (outcome === 'failed') {
        presentation = await this.transition(presentation, {
          kind: 'append_rejected',
          cursor: pending.cursor,
        });
        if (isRateLimited(error)) {
          // Everyone in the workspace waits out Slack's retry delay; this
          // stream keeps its text and appends again after it.
          await this.options.state.applySlackAppendCooldown(
            presentation.root.workspaceId,
            retryAfterMs(error),
          );
          this.budgetShortfall = 'rate_limited';
          this.appendBudget.rateLimited += 1;
        } else {
          this.degradedReason = 'unsafe_incomplete_block';
        }
        return;
      }
      await this.markUnknown(presentation, 'unknown_effect');
      throw error;
    }
    await this.transition(presentation, {
      kind: 'append_acknowledged',
      cursor: pending.cursor,
      acknowledgedPrefixHash: pending.hash,
    });
    this.nextAppendAt = this.now() + this.appendIntervalMs();
  }

  /**
   * Before the relay gathers its next append: wait out this stream's append
   * interval and take a budget token, so text arriving during the wait joins
   * this append instead of queueing behind it. Only an open stream waits;
   * the first text opens the stream through startStream instead.
   */
  private async prepareProgressiveAppend(control: ProgressiveAppendControl): Promise<void> {
    // An unused slot from a chunk that did not move the safe prefix.
    if (this.appendSlot === 'reserved') return;
    this.appendSlot = undefined;
    if (this.degradedReason || control.closing()) return;
    const presentation = await this.requirePresentation();
    if (presentation.stream.state !== 'streaming' || !presentation.stream.messageTs) return;
    const delay = Math.max(0, this.nextAppendAt - this.now());
    if (delay > 0) await this.wait(delay);
    this.appendSlot = await this.reserveAppendSlot(presentation.root.workspaceId, control)
      ? 'reserved'
      : 'yielded';
  }

  /**
   * Take the workspace's next append slot, waiting for it when it is not
   * free yet. A booked slot, a spent budget or a shared cooldown only delays
   * this append; it never ends the stream. The wait gives way when the
   * reader closes (the terminal delivers everything) or past
   * `MAX_APPEND_DEFERRAL_MS`, leaving the text for the next append.
   */
  private async reserveAppendSlot(
    workspaceId: string,
    control: ProgressiveAppendControl | undefined,
  ): Promise<boolean> {
    const deadline = this.now() + MAX_APPEND_DEFERRAL_MS;
    for (;;) {
      if (control?.closing()) {
        // The terminal delivers the text now; a slot booked here would be wasted.
        this.appendBudget.yielded += 1;
        return false;
      }
      const reservation = await this.options.state.reserveSlackAppend(workspaceId);
      if (reservation.outcome === 'reserved') {
        this.budgetShortfall = undefined;
        return true;
      }
      if (reservation.outcome === 'scheduled') {
        // The slot is ours; wait for its time.
        this.appendBudget.deferrals += 1;
        if (!(await this.waitForAppendSlot(reservation.at - this.now(), control))) return false;
        // A Slack rate limit that arrived while this stream waited covers
        // slots booked before it too: wait it out and book again.
        const cooldownUntil = await this.options.state.slackAppendCooldownUntil?.(workspaceId);
        if (cooldownUntil !== undefined && cooldownUntil > this.now()) continue;
        this.budgetShortfall = undefined;
        return true;
      }
      const at = this.now();
      const jitter = Math.floor(
        Math.min(0.999, Math.max(0, (this.options.random ?? Math.random)())) *
          APPEND_DEFERRAL_JITTER_MS,
      );
      const delay = Math.max(MIN_APPEND_DEFERRAL_MS, reservation.retryAt - at) + jitter;
      if (at + delay > deadline) {
        // The budget will not free a slot within the bound: this text waits
        // for the next append or the terminal.
        this.budgetShortfall = reservation.outcome === 'cooldown'
          ? 'workspace_cooldown'
          : 'budget_exhausted';
        this.appendBudget.yielded += 1;
        return false;
      }
      if (control?.closing()) {
        // The terminal delivers this text now; nothing was starved.
        this.appendBudget.yielded += 1;
        return false;
      }
      this.appendBudget.deferrals += 1;
      if (!(await this.waitForAppendSlot(delay, control))) return false;
    }
  }

  /**
   * Wait in short slices so a closing reader never holds the terminal behind
   * a long wait. False when the reader closed meanwhile.
   */
  private async waitForAppendSlot(
    delay: number,
    control: ProgressiveAppendControl | undefined,
  ): Promise<boolean> {
    for (let remaining = Math.max(0, delay); remaining > 0;) {
      if (control?.closing()) break;
      const slice = Math.min(remaining, APPEND_DEFERRAL_SLICE_MS);
      await this.wait(slice);
      this.appendBudget.deferredMs += slice;
      remaining -= slice;
    }
    if (control?.closing()) {
      this.appendBudget.yielded += 1;
      return false;
    }
    return true;
  }

  private async recordAcknowledgedPrefix(
    presentation: SlackRunPresentation,
    position: { batch: number; index: number },
    prefix: string,
  ): Promise<void> {
    presentation = await this.transition(presentation, {
      kind: 'append_intent',
      position,
      from: 0,
      to: utf8Length(prefix),
      hash: hash(prefix),
    });
    const pending = presentation.stream.pendingAppend!;
    await this.transition(presentation, {
      kind: 'append_acknowledged',
      cursor: pending.cursor,
      acknowledgedPrefixHash: pending.hash,
    });
  }

  private async ownsLatestThreadGeneration(
    presentation: Extract<SlackRunPresentation, { schemaVersion: 3 }>,
  ): Promise<boolean> {
    const latest = await this.options.state.getLatestThreadSessionGeneration(
      presentation.root,
    );
    return latest === undefined || latest <= presentation.sessionGeneration;
  }

  private async startNativePlan(
    presentation: SlackRunPresentation,
    instanceId: string,
    submissionId: string,
  ): Promise<SlackRunPresentation> {
    if (presentation.progressiveEligibility.status === 'frozen' &&
        presentation.progressiveEligibility.reason === 'artifact') return presentation;
    if (presentation.stream.state === 'streaming') return presentation;
    if (presentation.stream.state !== 'absent' || !presentation.plan) return presentation;
    if (presentation.schemaVersion === 3 &&
        presentation.plan.tasks.every((task) => task.status === 'pending')) {
      return presentation;
    }
    if (presentation.schemaVersion !== 3 &&
        presentation.plan.tasks.every((task) => task.status === 'pending')) {
      presentation = await this.transition(presentation, {
        kind: 'set_task_status',
        status: 'in_progress',
      });
    }
    presentation = await this.transition(presentation, { kind: 'stream_start_intent' });
    let started: Awaited<ReturnType<WebClient['chat']['startStream']>>;
    try {
      started = await this.options.client.chat.startStream(
        streamStartPayload(presentation, { taskChunks: taskChunks(presentation) }),
      );
    } catch (error) {
      const outcome = slackEffectOutcome(error);
      console.warn(
        `[chickpea] Slack Agent View native stream start ${outcome}: ` +
        safeSlackErrorCode(error),
      );
      if (outcome === 'failed') {
        return this.transition(presentation, { kind: 'mark_fallback', outcome: 'fallback' });
      }
      await this.markUnknown(presentation, 'unknown_effect');
      throw error;
    }
    // Slack opened the card; its coordinate is proven even if a concurrent
    // writer moved the row meanwhile, so a local write race is never
    // mistaken for an ambiguous Slack effect.
    presentation = await this.recordStreamStarted(
      presentation,
      requireSlackTs(started.ts),
      { instanceId, submissionId },
    );
    this.observeStreamStarted();
    try {
      await this.options.onNativeStarted?.();
    } catch {
      // Native stream ownership is already proven. Legacy checklist cleanup is
      // independently recoverable and cannot make the known stream ambiguous.
    }
    return presentation;
  }

  private async stopKnownStream(
    presentation: SlackRunPresentation,
    attemptId: string | undefined,
    observer: SlackPresentationDeliveryObserver,
    chunks: AnyChunk[],
    blocks: KnownBlock[],
    terminalTaskStatus: 'complete' | 'error',
    text: string,
    terminalSuffixBytes: number,
    recover: (finalizing: SlackRunPresentation) => Promise<AgentViewFinalResult>,
  ): Promise<AgentViewFinalResult> {
    const degradationReason = this.degradedReason ?? this.budgetShortfall;
    presentation = await this.transition(presentation, {
      kind: 'close_stream',
      outcome: presentation.stream.acknowledgedByteLength > 0 ? 'progressive' : 'terminal_only',
      ...(degradationReason ? { degradationReason } : {}),
      terminalSuffixBytes,
    });
    if (presentation.schemaVersion !== 3 && presentation.plan &&
        presentationUsesNativeTasks(presentation)) {
      presentation = await this.transition(presentation, {
        kind: 'set_task_status',
        status: terminalTaskStatus,
      });
    }
    presentation = await this.transition(presentation, { kind: 'mark_finalizing' });
    try {
      await this.options.client.chat.stopStream({
        channel: presentation.root.channelId,
        ts: presentation.stream.messageTs!,
        ...(chunks.length > 0 ? { chunks } : {}),
        ...(blocks.length > 0 ? { blocks } : {}),
      });
    } catch (error) {
      console.warn(
        `[chickpea] Slack Agent View stream finalization ${slackEffectOutcome(error)}: ` +
        safeSlackErrorCode(error),
      );
      if (streamNoLongerOpen(error)) {
        // Slack rejected the stop outright: the stream was already sealed
        // (a long-idle stream expires) or its message is gone. Nothing was
        // written, so recover in this attempt on the same coordinate instead
        // of spending a retry that would reach the same answer later.
        await observer.after({
          attemptId,
          outcome: 'failed',
          safeFailureCode: 'slack_stream_not_open',
        });
        return recover(presentation);
      }
      await this.markUnknown(presentation, 'unknown_effect');
      await this.recordTerminalDeliveryReceipt('unknown');
      await observer.after({
        attemptId,
        outcome: 'unknown',
        safeFailureCode: 'slack_stream_finalize_unknown',
      });
      throw error;
    }
    presentation = await this.transition(presentation, {
      kind: 'mark_artifact_delivered',
      outcome: presentation.stream.presentationOutcome ?? 'terminal_only',
    });
    await this.recordTerminalDeliveryReceipt('acknowledged');
    await observer.after({
      attemptId,
      outcome: 'delivered',
      deliveryRef: deliveryRef(presentation),
    });
    return { handled: true, messageTs: presentation.stream.messageTs!, text };
  }

  /** Reconcile a crash after stop intent using only the saved message coordinate.
   * Stopping with no chunks cannot append the suffix twice. Updating the same
   * message then replaces its contents with the already-approved final answer.
   */
  private async recoverFinalizingStream(
    presentation: SlackRunPresentation,
    text: string,
    format: SlackReplyFormat,
    observer: SlackPresentationDeliveryObserver,
    tablePresentation?: SlackTablePresentation,
  ): Promise<AgentViewFinalResult> {
    const approved = canonicalSlackReplyText(text, format);
    // The replacement goes through chat.update, which refuses a message
    // Slack accepts from a stream or a post (`msg_too_long`). Keep the first
    // message within RECOVERY_UPDATE_MAX_CHARS and re-plan the rest as
    // follow-ups; no follow-up has started before the final is acknowledged.
    const split = presentation.schemaVersion === 3
      ? this.recoverySplit(presentation, approved)
      : undefined;
    const parts = split
      ? slackReplyParts(approved, format, split)
      : this.replyParts(presentation, approved, format);
    const first = parts[0]!;
    const table = renderSlackReplyTable(tablePresentation, parts.at(-1)!);
    const closes = !await this.planContinuations(parts, table, [], split, true);
    presentation = await this.requirePresentation();
    const content = table && closes
      ? appendSlackTableToRenderedMessage(renderSlackMessage(first, 'markdown'), first, table)
      : renderSlackMessage(first, 'markdown');
    const rendered = closes ? appendSlackReplyFooter(content, this.options.footer) : content;
    const messageTs = presentation.stream.messageTs!;
    const update = { channel: presentation.root.channelId, ts: messageTs,
      text: rendered.text, blocks: rendered.blocks! };
    const attemptId = await observer.before({
      method: 'slack_chat_stream_recover', approvedOutput: approved,
      renderedPayload: JSON.stringify({ method: 'slack_chat_stream_recover', update }),
    });
    try {
      try {
        await this.options.client.chat.stopStream({ channel: update.channel, ts: messageTs });
      } catch (error) {
        // Slack explicitly reports an already-stopped stream (or no stream
        // message at all; the update below then proves which). Other failures
        // do not establish that it is safe to update the terminal artifact.
        if (!streamNoLongerOpen(error)) throw error;
      }
      try {
        await this.options.client.chat.update(update);
      } catch (error) {
        const rejectedContent = definiteContentRejection(error);
        if (!streamNoLongerOpen(error) && !rejectedContent) throw error;
        // Slack refuses the saved coordinate outright (no message, a sealed
        // or conflicting stream, an uneditable message) or refuses this
        // content there for good (`msg_too_long`): a retry would fail the
        // same way until the run is abandoned with no visible answer. Post
        // the terminal once, fresh.
        console.warn(
          '[chickpea] Slack Agent View stream is unrecoverable; posting the final fresh: ' +
          safeSlackErrorCode(error),
        );
        if (safeSlackErrorCode(error) === 'message_not_found' || rejectedContent) {
          try {
            // A sealed stream can still render as an empty shell. Remove it
            // when Slack lets us; a refusal never holds back the fresh final.
            await this.options.client.chat.delete({ channel: update.channel, ts: messageTs });
          } catch (deleteError) {
            console.warn(
              `[chickpea] Slack Agent View lost stream cleanup ${slackEffectOutcome(deleteError)}: ` +
              safeSlackErrorCode(deleteError),
            );
          }
        }
        await observer.after({
          attemptId,
          outcome: 'failed',
          safeFailureCode: rejectedContent
            ? 'slack_stream_update_rejected'
            : 'slack_stream_message_missing',
        });
        await this.transition(presentation, { kind: 'stream_message_lost', messageTs });
        if (rejectedContent) await this.replanFreshFinal(approved, format, tablePresentation);
        return freshFinalResult(await this.requirePresentation());
      }
      presentation = await this.transition(presentation, {
        kind: 'mark_artifact_delivered', outcome: presentation.stream.presentationOutcome ?? 'terminal_only',
      });
      await this.recordTerminalDeliveryReceipt('acknowledged');
    } catch (error) {
      console.warn(
        `[chickpea] Slack Agent View stream recovery ${slackEffectOutcome(error)}: ` +
        safeSlackErrorCode(error),
      );
      // Keep finalizing and its exact coordinate: another recovery can safely
      // repeat stop-without-chunks and replacement, never a new message post.
      await observer.after({ attemptId, outcome: 'unknown', safeFailureCode: 'slack_stream_recovery_unknown' });
      throw error;
    }
    await observer.after({ attemptId, outcome: 'delivered', deliveryRef: deliveryRef(presentation) });
    return { handled: true, messageTs, text: first };
  }

  /**
   * Slack refused the replacement's content, so the final posts fresh and
   * the stream message is gone. Nothing shows the streamed prefix any more,
   * and keeping it whole could repeat the refusal (a prefix dense with
   * headings can render past Slack's block limit), so re-plan without it.
   */
  private async replanFreshFinal(
    approved: string,
    format: SlackReplyFormat,
    tablePresentation: SlackTablePresentation | undefined,
  ): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3) return;
    const stored = presentation.continuations?.split;
    if (stored?.minFirstPartLength === undefined) return;
    const split: SlackReplySplit = stored.maxParts === undefined ? {} : { maxParts: stored.maxParts };
    const parts = slackReplyParts(approved, format, split);
    await this.planContinuations(
      parts, renderSlackReplyTable(tablePresentation, parts.at(-1)!), [], split, true,
    );
  }

  private async correctDivergentStream(
    presentation: SlackRunPresentation,
    first: string,
    approved: string,
    terminalTaskStatus: 'complete' | 'error',
    observer: SlackPresentationDeliveryObserver,
    table: RenderedSlackTablePresentation | undefined,
    closes: boolean,
  ): Promise<AgentViewFinalResult> {
    const corrected = `${first}\n\n${CORRECTED_MARKER}`;
    const content = table
      ? appendSlackTableToRenderedMessage(
          renderSlackMessage(corrected, 'markdown'),
          corrected,
          table,
        )
      : renderSlackMessage(corrected, 'markdown');
    const rendered = closes ? appendSlackReplyFooter(content, this.options.footer) : content;
    const messageTs = presentation.stream.messageTs!;
    const update = {
      channel: presentation.root.channelId,
      ts: messageTs,
      text: rendered.text,
      blocks: rendered.blocks!,
    } satisfies Parameters<WebClient['chat']['update']>[0];
    const payload = {
      method: 'slack_chat_stream_correct',
      channel: presentation.root.channelId,
      ts: messageTs,
      stop: {},
      update,
      terminalTaskStatus,
    };
    const attemptId = await observer.before({
      method: payload.method,
      approvedOutput: approved,
      renderedPayload: JSON.stringify(payload),
    });
    presentation = await this.transition(presentation, {
      kind: 'close_stream',
      outcome: 'corrected',
      degradationReason: 'unknown_effect',
    });
    if (presentation.schemaVersion !== 3 && presentation.plan &&
        presentationUsesNativeTasks(presentation)) {
      presentation = await this.transition(presentation, {
        kind: 'set_task_status',
        status: terminalTaskStatus,
      });
    }
    presentation = await this.transition(presentation, { kind: 'mark_finalizing' });
    try {
      await this.options.client.chat.stopStream({
        channel: presentation.root.channelId,
        ts: presentation.stream.messageTs!,
      });
      try {
        await this.options.client.chat.update(update);
      } catch (error) {
        if (!definiteContentRejection(error)) throw error;
        // Slack refused this content at the coordinate for good
        // (`msg_too_long`, malformed blocks): the stopped stream still shows
        // the divergent prefix and a retry would fail the same way. Remove
        // it when Slack lets us and post the terminal once, fresh.
        console.warn(
          '[chickpea] Slack Agent View stream correction was rejected; posting the final fresh: ' +
          safeSlackErrorCode(error),
        );
        try {
          await this.options.client.chat.delete({ channel: update.channel, ts: messageTs });
        } catch (deleteError) {
          console.warn(
            `[chickpea] Slack Agent View divergent stream cleanup ${slackEffectOutcome(deleteError)}: ` +
            safeSlackErrorCode(deleteError),
          );
        }
        await observer.after({
          attemptId,
          outcome: 'failed',
          safeFailureCode: 'slack_stream_update_rejected',
        });
        await this.transition(presentation, { kind: 'stream_message_lost', messageTs });
        return freshFinalResult(await this.requirePresentation());
      }
    } catch (error) {
      await this.markUnknown(presentation, 'unknown_effect');
      await this.recordTerminalDeliveryReceipt('unknown');
      await observer.after({
        attemptId,
        outcome: 'unknown',
        safeFailureCode: 'slack_stream_correction_unknown',
      });
      throw error;
    }
    presentation = await this.transition(presentation, {
      kind: 'mark_artifact_delivered',
      outcome: 'corrected',
    });
    await this.recordTerminalDeliveryReceipt('acknowledged');
    await observer.after({
      attemptId,
      outcome: 'delivered',
      deliveryRef: deliveryRef(presentation),
    });
    return { handled: true, messageTs, text: first };
  }

  private async invalidate(reason: ProgressiveRelayInvalidationReason): Promise<void> {
    if (reason === 'intent_persistence_failed') {
      try {
        let presentation = await this.requirePresentation();
        if (presentation.schemaVersion !== 1 &&
            presentation.progressiveIntent.status !== 'not_requested' &&
            presentation.progressiveIntent.status !== 'denied') {
          presentation = await this.transition(presentation, {
            kind: 'progressive_intent_denied',
            reason: 'persistence_failure',
          });
        }
        await this.markUnknown(presentation, 'unknown_effect');
      } catch {
        // The failed durable intent write remains recoverable through the Run
        // receipt even when its best-effort repair marker also cannot persist.
      }
      return;
    }
    if (reason === 'sink_failed') return;
    this.degradedReason = 'unsafe_incomplete_block';
  }

  private async recordProgressiveIntent(
    intent: ProgressiveIntentTransition,
  ): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion === 1) {
      throw new Error('Legacy presentations cannot record model intent.');
    }
    const current = presentation.progressiveIntent;
    if (intent.kind === 'candidate') {
      if ((current.status === 'pending' || current.status === 'requested') &&
          current.toolCallId === intent.toolCallId) return;
      await this.transition(presentation, {
        kind: 'progressive_intent_candidate',
        toolCallId: intent.toolCallId,
      });
      return;
    }
    if (intent.kind === 'requested') {
      if (current.status === 'requested' && current.toolCallId === intent.toolCallId) return;
      await this.transition(presentation, {
        kind: 'progressive_intent_requested',
        toolCallId: intent.toolCallId,
      });
      return;
    }
    if (intent.kind === 'not_requested') {
      if (current.status === 'not_requested') return;
      await this.transition(presentation, { kind: 'progressive_intent_not_requested' });
      return;
    }
    if (current.status === 'denied') return;
    await this.transition(presentation, {
      kind: 'progressive_intent_denied',
      reason: intent.reason,
    });
  }

  private async advanceFenceIfRequired(
    presentation: SlackRunPresentation,
  ): Promise<SlackRunPresentation> {
    if (presentation.runFencingToken === this.options.runFencingToken) return presentation;
    if (presentation.runFencingToken > this.options.runFencingToken) {
      throw new Error('Slack Agent View presentation fence is stale.');
    }
    return this.transition(presentation, {
      kind: 'advance_run_fence',
      runFencingToken: this.options.runFencingToken,
    }, presentation.runFencingToken);
  }

  private async requirePresentation(): Promise<SlackRunPresentation> {
    const presentation = await this.options.state.getRunPresentation(this.options.runId);
    if (!presentation) throw new Error('Slack Agent View presentation is missing.');
    return presentation;
  }

  private async transition(
    presentation: SlackRunPresentation,
    mutation: SlackPresentationMutation,
    fence = presentation.runFencingToken,
  ): Promise<SlackRunPresentation> {
    const result = await this.options.state.transitionRunPresentation({
      runId: presentation.runId,
      workBindingGeneration: presentation.workBindingGeneration,
      runFencingToken: fence,
      expectedProjectionVersion: presentation.projectionVersion,
      expectedStreamState: presentation.stream.state,
      mutation,
    });
    if (result.outcome !== 'applied') {
      throw new Error(STALE_WRITER_MESSAGE);
    }
    return result.presentation;
  }

  /**
   * Close this Run's open stream before Slack seals it, when the stream is
   * older than AGENT_VIEW_STREAM_RETIRE_AFTER_MS. The message keeps what it
   * already shows and gains nothing: the working indicator, not a note in the
   * thread, says the work goes on. The terminal then posts once as a fresh
   * thread message. Returns whether the stream is now retired. Never throws:
   * a failed check repeats later, and a stop Slack refuses leaves nothing a
   * fresh final would duplicate.
   */
  async retireAgedStream(): Promise<boolean> {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const presentation = await this.requirePresentation();
        const messageTs = presentation.stream.messageTs;
        if (presentation.stream.state !== 'streaming' || !messageTs ||
            presentation.stream.pendingAppend) return false;
        if (presentation.schemaVersion === 3 && presentation.terminalDelivery.state !== 'none') {
          return false;
        }
        if (!this.streamIsAged(presentation)) return false;
        try {
          await this.transition(presentation, { kind: 'retire_aged_stream', messageTs });
        } catch (error) {
          // A milestone or status write moved the row; look again.
          if (error instanceof Error && error.message === STALE_WRITER_MESSAGE) continue;
          throw error;
        }
        try {
          await this.options.client.chat.stopStream({
            channel: presentation.root.channelId,
            ts: messageTs,
          });
        } catch (error) {
          console.warn(
            `[chickpea] Slack Agent View stream retirement ${slackEffectOutcome(error)}: ` +
            safeSlackErrorCode(error),
          );
        }
        console.info('[chickpea] Slack Agent View stream retired before Slack could seal it');
        return true;
      }
    } catch (error) {
      console.warn('[chickpea] Slack Agent View stream age check failed:', safeSlackErrorCode(error));
    }
    return false;
  }

  /** Slack's stream timestamp is its start time; compare it to the bound. */
  private streamIsAged(presentation: SlackRunPresentation): boolean {
    const messageTs = presentation.stream.messageTs;
    if (presentation.stream.state !== 'streaming' || !messageTs) return false;
    const startedAt = Number(messageTs) * 1_000;
    return Number.isFinite(startedAt) &&
      this.now() - startedAt >= AGENT_VIEW_STREAM_RETIRE_AFTER_MS;
  }

  /**
   * Record the coordinate Slack returned for a stream this writer opened.
   * Activity status, milestones, and the progressive relay write the same
   * row, and any of them may advance it while `chat.startStream` is in
   * flight. The stream is still this writer's (the row stays `starting` and
   * the fence is unchanged), so re-read and record it on the current version.
   */
  private async recordStreamStarted(
    presentation: SlackRunPresentation,
    messageTs: string,
    flue: { instanceId: string; submissionId: string; messageId?: string },
  ): Promise<SlackRunPresentation> {
    const fence = presentation.runFencingToken;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.transition(presentation, { kind: 'stream_started', messageTs, flue }, fence);
      } catch (error) {
        if (attempt >= 3 || !(error instanceof Error) || error.message !== STALE_WRITER_MESSAGE) {
          throw error;
        }
        presentation = await this.requirePresentation();
        if (presentation.stream.state !== 'starting' || presentation.runFencingToken !== fence) {
          throw error;
        }
      }
    }
  }

  private async markUnknown(
    presentation: SlackRunPresentation,
    degradationReason: 'unknown_effect',
  ): Promise<void> {
    try {
      await this.transition(presentation, { kind: 'mark_unknown', degradationReason });
    } catch {
      // The original uncertain Slack effect is the primary recovery signal.
    }
  }

  private observeStreamStarted(): void {
    try {
      this.options.onStreamStarted?.();
    } catch {
      // Latency observation cannot affect a stream Slack already accepted.
    }
  }

  private emitFinalizationRecord(presentation: SlackRunPresentation): void {
    const record = slackPresentationFinalizationRecord(presentation);
    if (this.appendBudget.deferrals > 0 || this.appendBudget.yielded > 0 ||
        this.appendBudget.rateLimited > 0) {
      record.appendBudget = { ...this.appendBudget };
    }
    try {
      const emitted = this.options.onFinalized
        ? this.options.onFinalized(record)
        : console.info('[chickpea] Slack presentation finalized', JSON.stringify(record));
      if (emitted && typeof (emitted as Promise<void>).catch === 'function') {
        void (emitted as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Delivery is already canonical. Observability cannot reopen it.
    }
  }

  private footerBlock(): KnownBlock {
    return appendSlackReplyFooter(
      renderSlackMessage('', 'markdown'),
      this.options.footer,
    ).blocks!.at(-1)! as KnownBlock;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private appendIntervalMs(): number {
    return Math.max(0, Math.floor(this.options.minAppendIntervalMs ?? DEFAULT_APPEND_INTERVAL_MS));
  }

  private wait(milliseconds: number): Promise<void> {
    return (this.options.wait ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(
      milliseconds,
    );
  }

  private async readThreadReplies(
    presentation: Extract<SlackRunPresentation, { schemaVersion: 3 }>,
    oldest?: string,
  ): Promise<{ messages: Array<{ ts?: string; clientMsgId?: string }>; complete: boolean } | undefined> {
    try {
      const response = await this.options.client.conversations.replies({
        channel: presentation.root.channelId,
        ts: presentation.root.threadTs,
        limit: 100,
        ...(oldest ? { oldest } : {}),
      });
      const raw = response as unknown as {
        messages?: unknown;
        has_more?: unknown;
        response_metadata?: { next_cursor?: unknown };
      };
      if (!Array.isArray(raw.messages)) return undefined;
      const nextCursor = raw.response_metadata?.next_cursor;
      return {
        messages: raw.messages.map((message) => {
          const row = message && typeof message === 'object'
            ? message as Record<string, unknown>
            : {};
          return {
            ...(typeof row.ts === 'string' ? { ts: row.ts } : {}),
            ...(typeof row.client_msg_id === 'string'
              ? { clientMsgId: row.client_msg_id }
              : {}),
          };
        }),
        complete: raw.has_more !== true &&
          !(typeof nextCursor === 'string' && nextCursor.trim().length > 0),
      };
    } catch {
      return undefined;
    }
  }

  /** Appends the rows named by `changed`, the tasks this call just moved. */
  private async projectMilestonesBestEffort(
    presentation: SlackRunPresentation,
    changed: readonly string[],
  ): Promise<void> {
    if (presentation.schemaVersion !== 3 || presentation.stream.state !== 'streaming' ||
        !presentation.stream.messageTs || !presentation.plan || changed.length === 0) return;
    try {
      await this.options.client.chat.appendStream({
        channel: presentation.root.channelId,
        ts: presentation.stream.messageTs,
        chunks: taskChunks(presentation, { only: new Set(changed) }),
      } as unknown as Parameters<WebClient['chat']['appendStream']>[0]);
    } catch (error) {
      // Execution truth is already durable. A Slack projection failure cannot
      // rewrite a completed/failed milestone into a different work outcome.
      console.warn(
        `[chickpea] Slack milestone projection ${slackEffectOutcome(error)}: ` +
        safeSlackErrorCode(error),
      );
    }
  }

  /**
   * Recovery on a known coordinate may proceed when this run has not frozen a
   * terminal yet, or froze the same terminal result without acknowledgement.
   * A different frozen result is never overwritten blindly: Slack may already
   * show it, so that case stays with durable reconciliation.
   */
  private terminalIntentAcceptsRecovery(
    presentation: Extract<SlackRunPresentation, { schemaVersion: 3 }>,
    terminalTaskStatus: 'complete' | 'error',
  ): boolean {
    const terminal = presentation.terminalDelivery;
    if (terminal.state === 'none') return true;
    return terminal.state === 'intended' &&
      terminal.result === (terminalTaskStatus === 'error' ? 'failure' : 'answer') &&
      terminal.operation.certainty !== 'acknowledged';
  }

  private async prepareTerminalDelivery(result: 'answer' | 'failure'): Promise<{
    mayWrite: boolean;
    acknowledged: boolean;
    operationId?: string;
  }> {
    let presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3) return { mayWrite: true, acknowledged: false };
    if (presentation.terminalDelivery.state === 'abandoned') {
      return {
        mayWrite: false,
        acknowledged: true,
        operationId: presentation.terminalDelivery.operation.operationId,
      };
    }
    if (presentation.terminalDelivery.state === 'none') {
      const operationId = `terminal_${hash(`${presentation.runId}:${result}:1`).slice(0, 24)}`;
      await this.transition(presentation, {
        kind: 'record_terminal_delivery_intent', operationId, result,
      });
      return { mayWrite: true, acknowledged: false, operationId };
    }
    if (presentation.terminalDelivery.result !== result) {
      if (result === 'failure' && presentation.terminalDelivery.result === 'answer' &&
          presentation.terminalDelivery.operation.certainty === 'failed') {
        const operationId = `terminal_${hash(`${presentation.runId}:failure:supersede:${presentation.projectionVersion}`).slice(0, 24)}`;
        await this.transition(presentation, {
          kind: 'supersede_failed_answer_delivery', operationId,
        });
        return { mayWrite: true, acknowledged: false, operationId };
      }
      if (result === 'answer' && presentation.terminalDelivery.result === 'failure' &&
          presentation.terminalDelivery.operation.certainty === 'failed') {
        const operationId = `terminal_${hash(`${presentation.runId}:answer:supersede:${presentation.projectionVersion}`).slice(0, 24)}`;
        await this.transition(presentation, {
          kind: 'supersede_failed_failure_delivery', operationId,
        });
        return { mayWrite: true, acknowledged: false, operationId };
      }
      return { mayWrite: false, acknowledged: false };
    }
    const receipt = presentation.terminalDelivery.operation;
    if (receipt.certainty === 'acknowledged') {
      return { mayWrite: false, acknowledged: true, operationId: receipt.operationId };
    }
    if (receipt.certainty !== 'failed') {
      return { mayWrite: false, acknowledged: false, operationId: receipt.operationId };
    }
    const operationId = `terminal_${hash(`${presentation.runId}:${result}:retry:${presentation.projectionVersion}`).slice(0, 24)}`;
    await this.transition(presentation, { kind: 'retry_terminal_delivery', operationId });
    return { mayWrite: true, acknowledged: false, operationId };
  }
}

export function deriveSlackThreadTitle(message: string, workLabel?: string): string {
  const source = workLabel?.trim() || message.trim();
  if (!source || hasDisallowedControlCharacter(source) || hasCredentialLikeContent(source)) {
    return 'New request';
  }
  const sanitized = source
    .replace(/<@[^>]+>/g, '')
    .replace(/<!subteam\^[^>|]+(?:\|[^>]+)?>/g, '')
    .replace(/[`*_~#[\]()>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return 'New request';
  return sanitized.length <= 80 ? sanitized : `${sanitized.slice(0, 77).trimEnd()}…`;
}

function streamStartPayload(
  presentation: SlackRunPresentation,
  input: { markdownText?: string; taskChunks?: AnyChunk[] },
): Parameters<WebClient['chat']['startStream']>[0] {
  const taskChunks = input.taskChunks ?? [];
  const chunks: AnyChunk[] = [
    ...(input.markdownText ? [{ type: 'markdown_text' as const, text: input.markdownText }] : []),
    ...taskChunks,
  ];
  return {
    channel: presentation.root.channelId,
    thread_ts: presentation.root.threadTs,
    recipient_user_id: presentation.root.requesterUserId,
    recipient_team_id: presentation.root.workspaceId,
    // Slack fixes a stream's mode at start: a stream opened with
    // `markdown_text` rejects any later `chunks` (streaming_mode_mismatch),
    // including the terminal suffix and task updates. Always use chunks.
    chunks,
    ...(taskChunks.length > 0 && presentation.plan
      ? { task_display_mode: presentation.plan.displayMode }
      : {}),
    ...(presentation.schemaVersion === 3
      ? presentation.owner.kind === 'selected_agent'
        ? {
            username: presentation.owner.persona.name,
            icon_url: presentation.owner.persona.avatarUrl,
          }
        : {}
      : presentation.persona
        ? { username: presentation.persona.name, icon_url: presentation.persona.avatarUrl }
        : {}),
  } as unknown as Parameters<WebClient['chat']['startStream']>[0];
}

/**
 * Slack appends a task's `details` on every update that carries them, so a
 * settled row's detail is sent once: with the update that settles it, or with
 * the chunks that open the stream. Later updates name only its status.
 */
function taskChunks(
  presentation: SlackRunPresentation,
  options: { only?: ReadonlySet<string>; details?: boolean } = {},
): AnyChunk[] {
  const details = options.details ?? true;
  return presentation.plan?.tasks
    .filter((task) => !options.only || options.only.has(task.id))
    .map((task): AnyChunk => {
      const detail = details ? (task as { detail?: string }).detail : undefined;
      return {
        type: 'task_update',
        id: task.id,
        title: task.title,
        status: task.status,
        ...(detail ? { details: detail } : {}),
      };
    }) ?? [];
}

function terminalTaskChunks(
  presentation: SlackRunPresentation,
  status: 'complete' | 'error',
): AnyChunk[] {
  if (presentation.schemaVersion === 3) {
    // A streamed card already received each settled row's detail.
    return presentation.plan?.tasks.some((task) => task.status !== 'pending')
      ? taskChunks(presentation, { details: presentation.stream.state === 'absent' })
      : [];
  }
  return presentation.plan?.tasks.map((task) => ({
    type: 'task_update',
    id: task.id,
    title: task.title,
    status,
  })) ?? [];
}

function safeMilestoneReason(value: string): string {
  if (hasDisallowedControlCharacter(value) || hasCredentialLikeContent(value)) {
    return 'the active milestone could not finish.';
  }
  const safe = value
    .replace(/[<>&*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safe) return 'the active milestone could not finish.';
  return safe.length <= 320 ? safe : `${safe.slice(0, 319).trimEnd()}…`;
}

function terminalFlueIdentity(
  presentation: SlackRunPresentation,
): NonNullable<SlackRunPresentation['stream']['flue']> {
  return presentation.stream.flue ?? {
    instanceId: `terminal_${hash(presentation.runId).slice(0, 24)}`,
    submissionId: `terminal_${hash(presentation.turnJobId).slice(0, 24)}`,
  };
}

/**
 * How a frozen plan's first message is recomputed: by raw length for a plan
 * from before rendered shapes, without header overhead for a plan from
 * before that bound, else as this build splits.
 */
function frozenPlanSplit(
  plan: { shaped?: true; headerOverhead?: true },
  split: SlackReplySplit,
): Parameters<typeof slackReplyParts>[2] {
  if (!plan.shaped) return { ...split, rawLengthOnly: true };
  if (!plan.headerOverhead) return { ...split, headerBlockOverhead: 0 };
  return split;
}

/** The first message a stream may fill: the shape every reply part keeps. */
const STREAM_SHAPE_BUDGET = {
  maxBlocks: slackMarkdownPartBlockLimit,
  maxCountedLength: MAX_STREAMED_REPLY_CHARS,
} as const;

/**
 * The safe prefix to stream, capped inside the first message. A longer answer
 * continues in follow-up messages after the stream stops. The canonical form
 * of a raw prefix is a prefix of the final canonical answer, and so is any
 * shorter prefix of it, so the cap keeps the stream's monotone guarantee.
 *
 * The cap is the rendered shape of a reply part: at most
 * `slackMarkdownPartBlockLimit` blocks, and Slack's count (escaped `&`, `<`,
 * `>` plus each header block's overhead) under the markdown limit. Slack
 * refused an append past that count (61 headers and 7,134 characters), and a
 * first message over 50 blocks could never be corrected with chat.update.
 *
 * Within the last `STREAM_EDGE_WINDOW_CHARS` before the cap the stream only
 * advances to a line boundary, so the first message never ends mid-line (for
 * example inside a code line) and the next message starts with a whole line.
 * At the cap it prefers a paragraph or heading boundary outside a code
 * block, then a line outside one, then a sentence end, then a line inside a
 * code block. It never falls below the acknowledged prefix; with no boundary
 * it keeps the plain cap.
 *
 * `capBound`, once the answer outgrows the cap: every prefix this stream can
 * still take is a prefix of it.
 */
function streamedReplyPrefix(
  rawText: string,
  acknowledgedBytes: number,
): { text: string; capBound?: string } {
  const safePrefix = streamableSlackMarkdownPrefix(rawText);
  const acknowledged = prefixAtUtf8Length(safePrefix, acknowledgedBytes);
  const fit = slackMarkdownShapePrefixLength(safePrefix, STREAM_SHAPE_BUDGET);
  const full = fit < safePrefix.length;
  let capped = safePrefix;
  if (full) {
    const end = /[\uD800-\uDBFF]/.test(safePrefix[fit - 1] ?? '') ? fit - 1 : fit;
    capped = streamableSlackMarkdownPrefix(safePrefix.slice(0, end));
    // Only ever a prefix of what the final will show.
    if (!safePrefix.startsWith(capped)) capped = safePrefix.slice(0, end).trimEnd();
  }
  const acknowledgedLength = acknowledged?.length ?? 0;
  const bound = full
    ? { capBound: acknowledged !== undefined && acknowledgedLength > capped.length ? acknowledged : capped }
    : {};
  // Never behind what Slack already shows, e.g. a stream a build with a
  // looser cap began.
  if (acknowledged !== undefined && capped.length <= acknowledgedLength) {
    return { text: acknowledged, ...bound };
  }
  if (!full && slackMarkdownRenderedShape(capped).countedLength <=
      MAX_STREAMED_REPLY_CHARS - STREAM_EDGE_WINDOW_CHARS) {
    return { text: capped };
  }
  const floor = Math.max(acknowledgedLength, capped.length - STREAM_EDGE_WINDOW_CHARS);
  const at = full ? streamCapBoundary(capped, floor) : lastLineBoundary(capped, floor);
  if (at === undefined) return { text: capped, ...bound };
  const cut = capped.slice(0, at).trimEnd();
  return {
    text: acknowledged !== undefined && cut.length < acknowledgedLength ? acknowledged : cut,
    ...bound,
  };
}

function lastLineBoundary(text: string, floor: number): number | undefined {
  const at = text.lastIndexOf('\n');
  return at >= floor ? at : undefined;
}

/**
 * Where a full stream ends, at or after `floor`: the best boundary for the
 * first message to stop at while its follow-up carries the rest.
 */
function streamCapBoundary(text: string, floor: number): number | undefined {
  const paragraph: number[] = [];
  const line: number[] = [];
  const fenced: number[] = [];
  let fence: string | undefined;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    if (newline < 0) break;
    const current = text.slice(lineStart, newline);
    const marker = /^ {0,3}(`{3,})/.exec(current)?.[1];
    if (fence) {
      if (marker && marker.length >= fence.length && !current.trim().slice(marker.length)) {
        fence = undefined;
      }
    } else if (marker) {
      fence = marker;
    }
    if (newline >= floor) {
      if (fence) {
        fenced.push(newline);
      } else {
        const next = text.slice(newline + 1, newline + 8);
        (!current.trim() || /^#{1,6}\s/.test(next) ? paragraph : line).push(newline);
      }
    }
    lineStart = newline + 1;
  }
  const sentence = fence
    ? undefined
    : [...text.slice(floor).matchAll(/[.!?]["')\]]?(?=\s)/g)]
      .map((match) => floor + match.index + match[0].length)
      .filter((at) => at > lastBoundaryAt(text, floor))
      .at(-1);
  return paragraph.at(-1) ?? line.at(-1) ?? sentence ?? fenced.at(-1);
}

/** The last newline at or after `floor`, or `floor` itself. */
function lastBoundaryAt(text: string, floor: number): number {
  return Math.max(floor, text.lastIndexOf('\n'));
}

async function notifyContinuation(
  onDelivered: ((messageTs: string, text: string) => Promise<void>) | undefined,
  messageTs: string,
  text: string,
): Promise<void> {
  try {
    await onDelivered?.(messageTs, text);
  } catch {
    // The Slack post is the commit point; thread context is best effort.
    console.warn('[chickpea] Slack reply continuation context was not recorded');
  }
}

function ownerPersonaFields(owner: SlackPresentationOwner): {
  username?: string;
  icon_url?: string;
} {
  return owner.kind === 'selected_agent'
    ? { username: owner.persona.name, icon_url: owner.persona.avatarUrl }
    : {};
}

function requireSlackTs(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    throw new Error('Slack stream receipt is incomplete.');
  }
  return value;
}

function prefixAtUtf8Length(value: string, byteLength: number): string | undefined {
  if (byteLength === 0) return '';
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    bytes += utf8Length(String.fromCodePoint(codePoint));
    index += width;
    if (bytes === byteLength) return value.slice(0, index);
    if (bytes > byteLength) return undefined;
  }
  return undefined;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The result that sends the terminal down the presenter's fallback route as a
 * fresh post. The post always carries an idempotency key: the frozen
 * terminal's when the row intends one, else the run's own, so a retry after
 * an unknown post repeats the same key.
 */
function freshFinalResult(
  presentation: SlackRunPresentation,
  terminalOperationId?: string,
): AgentViewFinalResult {
  const intended = presentation.schemaVersion === 3 &&
      presentation.terminalDelivery.state === 'intended'
    ? presentation.terminalDelivery.operation.operationId
    : undefined;
  return {
    handled: false,
    fallbackPresentation: true,
    operationId: terminalOperationId ?? intended ??
      `terminal_${hash(`${presentation.runId}:fresh_final`).slice(0, 24)}`,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function comparePosition(
  left: { batch: number; index: number },
  right: { batch: number; index: number },
): number {
  return left.batch === right.batch ? left.index - right.index : left.batch - right.batch;
}

/** Slack's definitive answers that a stream coordinate is no longer open. */
/** Slack's final answer that this content can never be written as sent. */
const DEFINITE_CONTENT_REJECTION_ERRORS = new Set([
  'msg_too_long',
  'msg_blocks_too_long',
  'invalid_blocks',
  'invalid_blocks_format',
  'too_many_blocks',
]);

/** Slack refused the content itself; the same request can never succeed. */
function definiteContentRejection(error: unknown): boolean {
  return slackEffectOutcome(error) === 'failed' &&
    DEFINITE_CONTENT_REJECTION_ERRORS.has(safeSlackErrorCode(error));
}

/**
 * The first message a recovery update may carry. The streamed prefix stays
 * whole in it while it fits the bound, less room for a fence closer when a
 * code block is still open where the prefix ends. A longer prefix is not
 * kept as a minimum: the update replaces the message anyway, so the first
 * message ends at the best boundary within the bound instead of being forced
 * to the exact bound, mid-word or inside a link. The replacement allows one
 * extra follow-up, so recovery carries as much as a normal reply.
 */
export function recoveryReplySplit(
  split: SlackReplySplit,
  approved: string,
  reservedChars = 0,
): SlackReplySplit {
  const bound = RECOVERY_UPDATE_MAX_CHARS - reservedChars;
  const limit = Math.min(split.firstPartLimit ?? bound, bound);
  const prefix = split.minFirstPartLength;
  const fenceOpen = prefix !== undefined &&
    (approved.slice(0, prefix).match(/^ {0,3}`{3,}/gm) ?? []).length % 2 === 1;
  // Slack counts `&`, `<` and `>` escaped, so the kept prefix is measured so.
  const keepsPrefix = prefix !== undefined &&
    slackEscapedTextLength(approved.slice(0, prefix)) <=
      limit - (fenceOpen ? RECOVERY_FENCE_ROOM_CHARS : 0);
  return {
    ...(keepsPrefix ? { minFirstPartLength: split.minFirstPartLength } : {}),
    firstPartLimit: limit,
    maxParts: RECOVERY_MAX_PARTS,
  };
}

const STREAM_NO_LONGER_OPEN_ERRORS = new Set([
  'message_not_in_streaming_state',
  'message_not_found',
  'streaming_state_conflict',
  'cant_update_message',
  'edit_window_closed',
]);

/** Slack definitively refused the saved stream coordinate: nothing was written there. */
function streamNoLongerOpen(error: unknown): boolean {
  return slackEffectOutcome(error) === 'failed' &&
    STREAM_NO_LONGER_OPEN_ERRORS.has(safeSlackErrorCode(error));
}

function slackEffectOutcome(error: unknown): 'failed' | 'unknown' {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === ErrorCode.PlatformError || code === ErrorCode.RateLimitedError ||
      (error instanceof SlackTransportError && error.effectOutcome === 'failed') ||
      // Slack's own answer that the stream's message is not open (or not
      // there), or that the content is too long or malformed, proves the
      // call wrote nothing, even when it arrives through the gateway, whose
      // relayed error codes default to an unknown effect.
      (error instanceof SlackTransportError &&
        (STREAM_NO_LONGER_OPEN_ERRORS.has(safeSlackErrorCode(error)) ||
          DEFINITE_CONTENT_REJECTION_ERRORS.has(safeSlackErrorCode(error))))
    ? 'failed'
    : 'unknown';
}

const PERMANENT_AGENT_SESSION_SLACK_ERRORS = new Set([
  'missing_scope',
  'method_not_supported_for_channel_type',
  'no_permission',
  'not_allowed_token_type',
  'unknown_method',
]);

function isPermanentAgentSessionRejection(error: unknown): boolean {
  if (error instanceof SlackTransportError) {
    return error.effectOutcome === 'failed' && !error.retryable;
  }
  if (error instanceof Error &&
      error.message.includes('Slack operation is unavailable through the Chickpea gateway')) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const data = (error as { data?: unknown }).data;
  const slackCode = data && typeof data === 'object'
    ? (data as { error?: unknown }).error
    : undefined;
  return typeof slackCode === 'string' &&
    PERMANENT_AGENT_SESSION_SLACK_ERRORS.has(slackCode);
}

function safeSlackErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const data = (error as { data?: unknown }).data;
  const platformCode = data && typeof data === 'object'
    ? (data as { error?: unknown }).error
    : undefined;
  const transportCode = (error as { code?: unknown }).code;
  const code = typeof platformCode === 'string' ? platformCode : transportCode;
  return typeof code === 'string' && /^[a-z0-9_]{1,128}$/.test(code) ? code : 'unknown';
}

function isRateLimited(error: unknown): error is { code: ErrorCode; retryAfter: number } {
  return !!error && typeof error === 'object' &&
    (error as { code?: unknown }).code === ErrorCode.RateLimitedError;
}

function retryAfterMs(error: { retryAfter: number }): number {
  const seconds = Number.isFinite(error.retryAfter) ? error.retryAfter : 1;
  return Math.min(15 * 60_000, Math.max(1_000, Math.floor(seconds * 1_000)));
}

function deliveryRef(presentation: SlackRunPresentation): string {
  return `slack:${presentation.root.channelId}:${presentation.stream.messageTs ?? 'acknowledged'}`;
}
