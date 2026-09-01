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
  streamableSlackMarkdownPrefix,
  type SlackReplyFooter,
  type SlackReplyFormat,
} from './message-format.ts';
import {
  appendSlackTableToRenderedMessage,
  renderSlackTablePresentation,
  type RenderedSlackTablePresentation,
  type SlackTablePresentation,
} from './table-presentation.ts';
import {
  ReceiptScopedTextRelay,
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
  presentationHasTerminalOutcome,
  presentationAllowsProgressive,
  presentationUsesNativeTasks,
  slackPresentationFinalizationRecord,
  type SlackPresentationFinalizationRecord,
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
  reserveSlackAppend(workspaceId: string): MaybePromise<SlackAppendReservation>;
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
  | { handled: true; messageTs?: string }
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
  onNativeStarted?: () => Promise<void>;
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

const MAX_PROGRESSIVE_BUFFER_BYTES = 128 * 1_024;
const DEFAULT_APPEND_INTERVAL_MS = 750;
const CORRECTED_MARKER = '_Corrected_';

/**
 * One recoverable Agent View artifact for a canonical Slack Run. Flue owns
 * generation; the app-owned presentation projection owns every Slack effect.
 */
export class SlackAgentViewPresentation {
  private rawText = '';
  private nextAppendAt = 0;
  private degradedReason:
    | 'budget_exhausted'
    | 'workspace_cooldown'
    | 'rate_limited'
    | 'unsafe_incomplete_block'
    | 'runtime_gate_disabled'
    | 'policy_ineligible'
    | 'effect_capable'
    | undefined;

  constructor(private readonly options: AgentViewPresentationOptions) {}

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
    await this.projectMilestonesBestEffort(presentation);
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
      if (presentation.schemaVersion !== 3 || !presentation.plan) return;
    }
    await this.projectMilestonesBestEffort(presentation);
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
   * The caller must acknowledge that delivery later before lifecycle cleanup.
   */
  async prepareDeferredTerminalDelivery(result: 'answer' | 'failure'): Promise<boolean> {
    const presentation = await this.requirePresentation();
    if (presentation.schemaVersion !== 3) return false;
    const terminal = await this.prepareTerminalDelivery(result);
    return terminal.operationId !== undefined;
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
        eligibility: candidate,
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
      append: (chunk) => this.appendProgressiveText(
        input.instanceId,
        input.receipt.submissionId,
        chunk,
      ),
      invalidate: (reason) => this.invalidate(reason),
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
  ): Promise<AgentViewFinalResult> {
    let presentation = await this.requirePresentation();
    if (presentation.stream.state === 'finalized' ||
        presentation.stream.state === 'artifact_delivered') {
      if (presentation.schemaVersion === 3 && presentation.stream.messageTs &&
          presentation.terminalDelivery.state === 'intended' &&
          (presentation.terminalDelivery.operation.certainty === 'pending' ||
            presentation.terminalDelivery.operation.certainty === 'unknown')) {
        await this.recordTerminalDeliveryReceipt('acknowledged');
        presentation = await this.requirePresentation();
      }
      return { handled: true, ...(presentation.stream.messageTs
        ? { messageTs: presentation.stream.messageTs }
        : {}) };
    }
    if (presentation.stream.state === 'starting' || presentation.stream.state === 'unknown') {
      throw new Error('Slack Agent View presentation requires reconciliation.');
    }
    const terminal = await this.prepareTerminalDelivery(
      terminalTaskStatus === 'error' ? 'failure' : 'answer',
    );
    if (!terminal.mayWrite) {
      if (terminal.acknowledged) {
        return { handled: true, ...(presentation.stream.messageTs
          ? { messageTs: presentation.stream.messageTs }
          : {}) };
      }
      throw new Error('Slack terminal delivery requires reconciliation.');
    }
    presentation = await this.requirePresentation();
    if (presentation.stream.state === 'fallback') {
      return {
        handled: false,
        fallbackPresentation: true,
        ...(terminal.operationId ? { operationId: terminal.operationId } : {}),
      };
    }

    const approved = canonicalSlackReplyText(text, format);
    const renderedTable = tablePresentation
      ? renderSlackTablePresentation(tablePresentation, Math.max(0, 12_000 - approved.length - 2))
      : undefined;
    const footerBlocks = [
      ...(renderedTable ? [renderedTable.block as unknown as KnownBlock] : []),
      this.footerBlock(),
    ];
    const taskChunks = presentationUsesNativeTasks(presentation)
      ? terminalTaskChunks(presentation, terminalTaskStatus)
      : [];

    if (presentation.stream.state === 'absent') {
      presentation = await this.transition(presentation, { kind: 'stream_start_intent' });
      const startPayload = streamStartPayload(presentation, {
        markdownText: approved,
        taskChunks,
      });
      const stop = { blocks: footerBlocks };
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
          const pendingTerminal = await this.requirePresentation();
          return {
            handled: false,
            fallbackPresentation: true,
            ...(pendingTerminal.schemaVersion === 3 &&
                pendingTerminal.terminalDelivery.state === 'intended'
              ? { operationId: pendingTerminal.terminalDelivery.operation.operationId }
              : {}),
          };
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
      presentation = await this.transition(presentation, {
        kind: 'stream_started',
        messageTs,
        flue: terminalFlueIdentity(presentation),
      });
      return this.stopKnownStream(
        presentation,
        text,
        attemptId,
        observer,
        [],
        footerBlocks,
        terminalTaskStatus,
      );
    }

    if (presentation.stream.state !== 'streaming' || !presentation.stream.messageTs) {
      throw new Error('Slack Agent View presentation is not terminalizable.');
    }
    const acknowledged = prefixAtUtf8Length(approved, presentation.stream.acknowledgedByteLength);
    const prefixMatches = acknowledged !== undefined &&
      hash(acknowledged) === (presentation.stream.acknowledgedPrefixHash ?? hash(''));
    if (!prefixMatches) {
      return this.correctDivergentStream(
        presentation,
        approved,
        terminalTaskStatus,
        observer,
        renderedTable,
      );
    }
    const suffix = approved.slice(acknowledged.length);
    const stopChunks: AnyChunk[] = [
      ...(suffix ? [{ type: 'markdown_text' as const, text: suffix }] : []),
      ...taskChunks,
    ];
    const stop = stopChunks.length > 0
      ? { chunks: stopChunks, blocks: footerBlocks }
      : { blocks: footerBlocks };
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
      text,
      attemptId,
      observer,
      stopChunks,
      footerBlocks,
      terminalTaskStatus,
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
  ): Promise<void> {
    this.rawText += chunk.delta;
    if (utf8Length(this.rawText) > MAX_PROGRESSIVE_BUFFER_BYTES) {
      this.degradedReason = 'unsafe_incomplete_block';
      return;
    }
    const safePrefix = streamableSlackMarkdownPrefix(this.rawText);
    let presentation = await this.requirePresentation();
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
      presentation = await this.transition(presentation, {
        kind: 'stream_started',
        messageTs: requireSlackTs(started.ts),
        flue: { instanceId, submissionId, messageId: chunk.messageId },
      });
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
    const delay = Math.max(0, this.nextAppendAt - this.now());
    if (delay > 0) await this.wait(delay);
    const reservation = await this.options.state.reserveSlackAppend(presentation.root.workspaceId);
    if (reservation.outcome !== 'reserved') {
      this.degradedReason = reservation.outcome === 'cooldown'
        ? 'workspace_cooldown'
        : 'budget_exhausted';
      return;
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
        markdown_text: delta,
      });
    } catch (error) {
      const outcome = slackEffectOutcome(error);
      if (outcome === 'failed') {
        presentation = await this.transition(presentation, {
          kind: 'append_rejected',
          cursor: pending.cursor,
        });
        if (isRateLimited(error)) {
          await this.options.state.applySlackAppendCooldown(
            presentation.root.workspaceId,
            retryAfterMs(error),
          );
          this.degradedReason = 'rate_limited';
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
    try {
      const started = await this.options.client.chat.startStream(
        streamStartPayload(presentation, { taskChunks: taskChunks(presentation) }),
      );
      presentation = await this.transition(presentation, {
        kind: 'stream_started',
        messageTs: requireSlackTs(started.ts),
        flue: { instanceId, submissionId },
      });
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
    approvedOutput: string,
    attemptId: string | undefined,
    observer: SlackPresentationDeliveryObserver,
    chunks: AnyChunk[],
    blocks: KnownBlock[],
    terminalTaskStatus: 'complete' | 'error',
  ): Promise<AgentViewFinalResult> {
    presentation = await this.transition(presentation, {
      kind: 'close_stream',
      outcome: presentation.stream.acknowledgedByteLength > 0 ? 'progressive' : 'terminal_only',
      ...(this.degradedReason ? { degradationReason: this.degradedReason } : {}),
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
        blocks,
      });
    } catch (error) {
      console.warn(
        `[chickpea] Slack Agent View stream finalization ${slackEffectOutcome(error)}: ` +
        safeSlackErrorCode(error),
      );
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
    void approvedOutput;
    return { handled: true, messageTs: presentation.stream.messageTs! };
  }

  private async correctDivergentStream(
    presentation: SlackRunPresentation,
    approved: string,
    terminalTaskStatus: 'complete' | 'error',
    observer: SlackPresentationDeliveryObserver,
    table?: RenderedSlackTablePresentation,
  ): Promise<AgentViewFinalResult> {
    const corrected = `${approved}\n\n${CORRECTED_MARKER}`;
    const content = table
      ? appendSlackTableToRenderedMessage(
          renderSlackMessage(corrected, 'markdown'),
          corrected,
          table,
        )
      : renderSlackMessage(corrected, 'markdown');
    const rendered = appendSlackReplyFooter(
      content,
      this.options.footer,
    );
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
      await this.options.client.chat.update(update);
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
    return { handled: true, messageTs };
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
      throw new Error('Slack Agent View presentation writer is stale.');
    }
    return result.presentation;
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

  private emitFinalizationRecord(presentation: SlackRunPresentation): void {
    const record = slackPresentationFinalizationRecord(presentation);
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

  private async readThreadReplies(presentation: Extract<SlackRunPresentation, { schemaVersion: 3 }>):
    Promise<{ messages: Array<{ ts?: string; clientMsgId?: string }>; complete: boolean } | undefined> {
    try {
      const response = await this.options.client.conversations.replies({
        channel: presentation.root.channelId,
        ts: presentation.root.threadTs,
        limit: 100,
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

  private async projectMilestonesBestEffort(presentation: SlackRunPresentation): Promise<void> {
    if (presentation.schemaVersion !== 3 || presentation.stream.state !== 'streaming' ||
        !presentation.stream.messageTs || !presentation.plan) return;
    try {
      await this.options.client.chat.appendStream({
        channel: presentation.root.channelId,
        ts: presentation.stream.messageTs,
        chunks: taskChunks(presentation),
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
    ...(chunks.length === 1 && chunks[0]?.type === 'markdown_text' && taskChunks.length === 0
      ? { markdown_text: input.markdownText! }
      : { chunks }),
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

function taskChunks(presentation: SlackRunPresentation): AnyChunk[] {
  return presentation.plan?.tasks.map((task) => ({
    type: 'task_update',
    id: task.id,
    title: task.title,
    status: task.status,
    ...('detail' in task && task.detail ? { details: task.detail } : {}),
  })) ?? [];
}

function terminalTaskChunks(
  presentation: SlackRunPresentation,
  status: 'complete' | 'error',
): AnyChunk[] {
  if (presentation.schemaVersion === 3) {
    return presentation.plan?.tasks.some((task) => task.status !== 'pending')
      ? taskChunks(presentation)
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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function comparePosition(
  left: { batch: number; index: number },
  right: { batch: number; index: number },
): number {
  return left.batch === right.batch ? left.index - right.index : left.batch - right.batch;
}

function slackEffectOutcome(error: unknown): 'failed' | 'unknown' {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === ErrorCode.PlatformError || code === ErrorCode.RateLimitedError ||
      (error instanceof SlackTransportError && error.effectOutcome === 'failed')
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
