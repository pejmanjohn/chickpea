import { createHash } from 'node:crypto';

import { ErrorCode, type WebClient } from '@slack/web-api';
import type { AnyChunk, KnownBlock } from '@slack/types';

import { hasCredentialLikeContent, hasDisallowedControlCharacter } from '../security/content-validation.ts';
import type { FlueDispatchReceiptV1, FlueObservationTarget } from './turn-job-types.ts';
import {
  appendSlackReplyFooter,
  canonicalSlackMarkdownText,
  renderSlackMessage,
  streamableSlackMarkdownPrefix,
  type SlackReplyFooter,
  type SlackReplyFormat,
} from './message-format.ts';
import {
  ReceiptScopedTextRelay,
  type ProgressiveRelayInvalidationReason,
  type ProgressiveTextChunk,
  type SlackProgressiveReadRelay,
} from './progressive-relay.ts';
import type { ProgressiveEligibilityDecision } from './progressive-eligibility.ts';
import type {
  SlackAppendReservation,
  SlackPresentationMutation,
  SlackPresentationTransitionInput,
  SlackPresentationTransitionResult,
  SlackRunPresentationV1,
} from './run-presentations.ts';

type MaybePromise<T> = T | Promise<T>;

export interface SlackPresentationStatePort {
  getRunPresentation(runId: string): MaybePromise<SlackRunPresentationV1 | undefined>;
  transitionRunPresentation(
    input: SlackPresentationTransitionInput,
  ): MaybePromise<SlackPresentationTransitionResult>;
  reserveSlackAppend(workspaceId: string): MaybePromise<SlackAppendReservation>;
  applySlackAppendCooldown(
    workspaceId: string,
    retryAfterMs: number,
  ): MaybePromise<{ cooldownUntil: number; budgetVersion: number }>;
  matchFlueObservation(
    instanceId: string,
    submissionId?: string,
  ): MaybePromise<FlueObservationTarget | undefined>;
}

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

export type AgentViewFinalResult =
  | { handled: true; messageTs?: string }
  | { handled: false; fallbackPresentation: boolean };

export interface AgentViewPresentationOptions {
  client: WebClient;
  state: SlackPresentationStatePort;
  runId: string;
  runFencingToken: number;
  footer: SlackReplyFooter;
  minAppendIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  onNativeStarted?: () => Promise<void>;
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
    const allowed = input.eligibility.allowed && presentation.features.progressiveStreaming;
    const decision = allowed
      ? input.eligibility
      : {
          allowed: false,
          reason: input.eligibility.allowed ? ('other' as const) : input.eligibility.reason,
        };
    if (!allowed) {
      this.degradedReason = input.eligibility.allowed
        ? 'runtime_gate_disabled'
        : input.eligibility.reason === 'effect_capable'
          ? 'effect_capable'
          : 'policy_ineligible';
    }
    if (presentation.progressiveEligibility.status === 'pending') {
      presentation = await this.transition(presentation, {
        kind: 'freeze_progressive_eligibility',
        eligibility: decision,
      });
    } else if (
      presentation.progressiveEligibility.allowed !== decision.allowed ||
      presentation.progressiveEligibility.reason !== decision.reason
    ) {
      return undefined;
    }

    if (presentation.plan && presentation.features.nativeTasks) {
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
    return new ReceiptScopedTextRelay({
      submissionId: input.receipt.submissionId,
      append: (chunk) => this.appendProgressiveText(
        input.instanceId,
        input.receipt.submissionId,
        chunk,
      ),
      invalidate: (reason) => this.invalidate(reason),
    });
  }

  async finalize(
    text: string,
    format: SlackReplyFormat,
    terminalTaskStatus: 'complete' | 'error',
    observer: SlackPresentationDeliveryObserver,
  ): Promise<AgentViewFinalResult> {
    let presentation = await this.requirePresentation();
    if (presentation.stream.state === 'finalized' ||
        presentation.stream.state === 'artifact_delivered') {
      return { handled: true, ...(presentation.stream.messageTs
        ? { messageTs: presentation.stream.messageTs }
        : {}) };
    }
    if (presentation.stream.state === 'fallback') {
      return { handled: false, fallbackPresentation: true };
    }
    if (presentation.stream.state === 'starting' || presentation.stream.state === 'unknown') {
      throw new Error('Slack Agent View presentation requires reconciliation.');
    }

    const approved = format === 'markdown'
      ? canonicalSlackMarkdownText(text)
      : text.replace(/\r\n?/g, '\n').trim();
    const footerBlocks = [this.footerBlock()];
    const taskChunks = presentation.features.nativeTasks
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
        approvedOutput: text,
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
          return { handled: false, fallbackPresentation: true };
        }
        await this.markUnknown(presentation, 'unknown_effect');
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
        text,
        approved,
        terminalTaskStatus,
        observer,
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
      approvedOutput: text,
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
  }

  async markCanonicalFinalized(): Promise<void> {
    const presentation = await this.requirePresentation();
    if (presentation.stream.state === 'absent') {
      await this.transition(presentation, { kind: 'mark_non_stream_finalized' });
      return;
    }
    if (presentation.stream.state !== 'artifact_delivered') return;
    await this.transition(presentation, { kind: 'mark_finalized' });
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
    if (!presentation.features.nativeTasks) return;
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
    presentation: SlackRunPresentationV1,
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

  private async startNativePlan(
    presentation: SlackRunPresentationV1,
    instanceId: string,
    submissionId: string,
  ): Promise<SlackRunPresentationV1> {
    if (presentation.stream.state === 'streaming') return presentation;
    if (presentation.stream.state !== 'absent' || !presentation.plan) return presentation;
    if (presentation.plan.tasks.every((task) => task.status === 'pending')) {
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
      if (slackEffectOutcome(error) === 'failed') {
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
    presentation: SlackRunPresentationV1,
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
    if (presentation.plan && presentation.features.nativeTasks) {
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
      await this.markUnknown(presentation, 'unknown_effect');
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
    await observer.after({
      attemptId,
      outcome: 'delivered',
      deliveryRef: deliveryRef(presentation),
    });
    void approvedOutput;
    return { handled: true, messageTs: presentation.stream.messageTs! };
  }

  private async correctDivergentStream(
    presentation: SlackRunPresentationV1,
    approvedOutput: string,
    approved: string,
    terminalTaskStatus: 'complete' | 'error',
    observer: SlackPresentationDeliveryObserver,
  ): Promise<AgentViewFinalResult> {
    const corrected = `${approved}\n\n${CORRECTED_MARKER}`;
    const rendered = appendSlackReplyFooter(
      renderSlackMessage(corrected, 'markdown'),
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
      approvedOutput,
      renderedPayload: JSON.stringify(payload),
    });
    presentation = await this.transition(presentation, {
      kind: 'close_stream',
      outcome: 'corrected',
      degradationReason: 'unknown_effect',
    });
    if (presentation.plan && presentation.features.nativeTasks) {
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
    await observer.after({
      attemptId,
      outcome: 'delivered',
      deliveryRef: deliveryRef(presentation),
    });
    return { handled: true, messageTs };
  }

  private async invalidate(reason: ProgressiveRelayInvalidationReason): Promise<void> {
    if (reason === 'sink_failed') return;
    this.degradedReason = 'unsafe_incomplete_block';
  }

  private async advanceFenceIfRequired(
    presentation: SlackRunPresentationV1,
  ): Promise<SlackRunPresentationV1> {
    if (presentation.runFencingToken === this.options.runFencingToken) return presentation;
    if (presentation.runFencingToken > this.options.runFencingToken) {
      throw new Error('Slack Agent View presentation fence is stale.');
    }
    return this.transition(presentation, {
      kind: 'advance_run_fence',
      runFencingToken: this.options.runFencingToken,
    }, presentation.runFencingToken);
  }

  private async requirePresentation(): Promise<SlackRunPresentationV1> {
    const presentation = await this.options.state.getRunPresentation(this.options.runId);
    if (!presentation) throw new Error('Slack Agent View presentation is missing.');
    return presentation;
  }

  private async transition(
    presentation: SlackRunPresentationV1,
    mutation: SlackPresentationMutation,
    fence = presentation.runFencingToken,
  ): Promise<SlackRunPresentationV1> {
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
    presentation: SlackRunPresentationV1,
    degradationReason: 'unknown_effect',
  ): Promise<void> {
    try {
      await this.transition(presentation, { kind: 'mark_unknown', degradationReason });
    } catch {
      // The original uncertain Slack effect is the primary recovery signal.
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
  presentation: SlackRunPresentationV1,
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
    ...(presentation.plan ? { task_display_mode: presentation.plan.displayMode } : {}),
    ...(presentation.persona
      ? { username: presentation.persona.name, icon_url: presentation.persona.avatarUrl }
      : {}),
  } as unknown as Parameters<WebClient['chat']['startStream']>[0];
}

function taskChunks(presentation: SlackRunPresentationV1): AnyChunk[] {
  return presentation.plan?.tasks.map((task) => ({
    type: 'task_update',
    id: task.id,
    title: task.title,
    status: task.status,
  })) ?? [];
}

function terminalTaskChunks(
  presentation: SlackRunPresentationV1,
  status: 'complete' | 'error',
): AnyChunk[] {
  return presentation.plan?.tasks.map((task) => ({
    type: 'task_update',
    id: task.id,
    title: task.title,
    status,
  })) ?? [];
}

function terminalFlueIdentity(
  presentation: SlackRunPresentationV1,
): NonNullable<SlackRunPresentationV1['stream']['flue']> {
  return presentation.stream.flue ?? {
    instanceId: `terminal_${hash(presentation.runId).slice(0, 24)}`,
    submissionId: `terminal_${hash(presentation.turnJobId).slice(0, 24)}`,
  };
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
  return code === ErrorCode.PlatformError || code === ErrorCode.RateLimitedError
    ? 'failed'
    : 'unknown';
}

function isRateLimited(error: unknown): error is { code: ErrorCode; retryAfter: number } {
  return !!error && typeof error === 'object' &&
    (error as { code?: unknown }).code === ErrorCode.RateLimitedError;
}

function retryAfterMs(error: { retryAfter: number }): number {
  const seconds = Number.isFinite(error.retryAfter) ? error.retryAfter : 1;
  return Math.min(15 * 60_000, Math.max(1_000, Math.floor(seconds * 1_000)));
}

function deliveryRef(presentation: SlackRunPresentationV1): string {
  return `slack:${presentation.root.channelId}:${presentation.stream.messageTs ?? 'acknowledged'}`;
}
