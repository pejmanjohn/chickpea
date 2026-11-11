import type { ConversationStreamChunk } from '@flue/runtime';

import type { ProgressiveStreamingMode } from '../memory/tool-policy.ts';
import { FILE_DELIVERY_DATA_NAME } from './file-delivery-completion.ts';
import type { HostReleaseLate } from './host-release-relay.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from './presentation-intent.ts';
import type {
  SlackProgressiveIntent,
  SlackProgressiveIntentDenialReason,
} from './run-presentations.ts';

export interface ProgressiveTextChunk {
  messageId: string;
  delta: string;
  position: { batch: number; index: number };
}

export type ProgressiveRelayInvalidationReason =
  | 'conversation_reset'
  | 'message_identity_conflict'
  | 'tool_activity'
  | 'structured_output'
  | 'read_interrupted'
  | 'settlement_persist_failed'
  | 'invalid_result'
  | 'run_failed'
  | 'intent_persistence_failed'
  | 'sink_failed';

export type ProgressiveIntentTransition =
  | { kind: 'candidate'; toolCallId: string }
  | { kind: 'requested'; toolCallId: string }
  | { kind: 'not_requested' }
  | { kind: 'denied'; reason: SlackProgressiveIntentDenialReason };

export interface ProgressiveRelaySummary {
  acceptedChunks: number;
  acceptedBytes: number;
  targetMessageCompleted: boolean;
  invalidated: boolean;
  invalidationReason?: ProgressiveRelayInvalidationReason;
}

/**
 * What an append may ask of the relay while it waits. `closing` turns true
 * once the relay stops reading: the terminal is about to deliver the whole
 * answer, so an append still waiting for the Slack budget can give way.
 */
export interface ProgressiveAppendControl {
  closing(): boolean;
  closed: Promise<void>;
}

export interface ProgressiveTextSink {
  /**
   * Waits until the next append may go to Slack. Chunks that arrive during
   * the wait join the append that follows it.
   */
  prepareAppend?(control: ProgressiveAppendControl): Promise<void>;
  append(chunk: ProgressiveTextChunk, control: ProgressiveAppendControl): Promise<void>;
  /** `error` is the failed append's error, for `sink_failed` only. */
  invalidate(reason: ProgressiveRelayInvalidationReason, error?: unknown): Promise<void>;
  /** See {@link SlackProgressiveReadRelay.streamedPrefixBound}. */
  streamedPrefixBound?(): string | undefined;
  /** See {@link SlackProgressiveReadRelay.canonicalStreamText}. */
  canonicalStreamText?(text: string): string;
  /** Omitted only for retained V1 presentations with the legacy immediate relay. */
  modelIntent?: {
    initial: SlackProgressiveIntent;
    transition(intent: ProgressiveIntentTransition): Promise<void>;
  };
}

export interface SlackProgressiveReadRelay {
  onEvent(chunk: ConversationStreamChunk): void;
  closeAndDrain(): Promise<ProgressiveRelaySummary>;
  invalidateAndDrain(
    reason: ProgressiveRelayInvalidationReason,
  ): Promise<ProgressiveRelaySummary>;
  /**
   * Stop reading without deciding anything: queued effects finish, no intent
   * or invalidation is recorded, and the durable stream stays open for the
   * next attempt to reattach to the same receipt.
   */
  suspendAndDrain(): Promise<ProgressiveRelaySummary>;
  /**
   * Whether this answer is streamed to Slack: a requested intent (durable or
   * replayed) or any queued or accepted text.
   */
  streamedAnswer?(): boolean;
  /**
   * Once the stream reached its cap: the longest text (canonical Slack
   * markdown) it can ever show, however much more of the answer arrives.
   * Undefined while the stream may still show all of it.
   */
  streamedPrefixBound?(): string | undefined;
  /**
   * How this stream renders an answer prefix to canonical Slack markdown,
   * so that text compared against `streamedPrefixBound` renders the same
   * way the bound did (a reply's live Agent handles, for one). Undefined:
   * the plain rendering.
   */
  canonicalStreamText?(text: string): string | undefined;
}

type RelayOperation =
  | { kind: 'intent'; transition: ProgressiveIntentTransition }
  | { kind: 'append'; chunk: ProgressiveTextChunk; count: number }
  | { kind: 'invalidate'; reason: ProgressiveRelayInvalidationReason }
  | { kind: 'retire'; late: HostReleaseLate };

/**
 * A relay's Slack effects, applied one at a time in the order queued: intent
 * writes, appends, invalidations and the host release's retirement. A failed
 * intent write or append drops what is still queued, invalidates the sink and
 * calls `stop`, so its relay reads nothing more.
 */
export class ProgressiveEffects {
  private readonly queue: RelayOperation[] = [];
  private closing = false;
  private readonly closed = Promise.withResolvers<void>();
  private readonly appendControl: ProgressiveAppendControl = {
    closing: () => this.closing,
    closed: this.closed.promise,
  };
  private pumpPromise: Promise<void> | undefined;
  private queuedTextChunks = 0;
  private acceptedChunks = 0;
  private acceptedBytes = 0;
  private invalidated = false;
  private invalidationReason: ProgressiveRelayInvalidationReason | undefined;

  constructor(
    private readonly sink: ProgressiveTextSink & { retire?(late: HostReleaseLate): Promise<void> },
    private readonly stop: () => void,
  ) {}

  text(chunk: ProgressiveTextChunk): void {
    this.queuedTextChunks += 1;
    this.queue.push({ kind: 'append', count: 1, chunk });
    this.startPump();
  }

  intent(transition: ProgressiveIntentTransition): void {
    this.queue.push({ kind: 'intent', transition });
    this.startPump();
  }

  invalidate(reason: ProgressiveRelayInvalidationReason): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.invalidationReason = reason;
    this.stop();
    this.close();
    this.queue.push({ kind: 'invalidate', reason });
    this.startPump();
  }

  /**
   * Text that has not reached Slack yet never will; then the sink retires
   * what did. An append already under way finishes first.
   */
  retire(late: HostReleaseLate): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const operation = this.queue[index]!;
      if (operation.kind !== 'append') continue;
      this.queuedTextChunks = Math.max(0, this.queuedTextChunks - operation.count);
      this.queue.splice(index, 1);
    }
    this.close();
    this.queue.push({ kind: 'retire', late });
    this.startPump();
  }

  /** The relay stops reading: an append waiting for the Slack budget gives way. */
  close(): void {
    this.closing = true;
    this.closed.resolve();
  }

  hasText(): boolean {
    return this.queuedTextChunks > 0 || this.acceptedChunks > 0;
  }

  async drain(): Promise<void> {
    while (this.pumpPromise || this.queue.length > 0) {
      this.startPump();
      await this.pumpPromise;
    }
  }

  summary(targetMessageCompleted: boolean): ProgressiveRelaySummary {
    return {
      acceptedChunks: this.acceptedChunks,
      acceptedBytes: this.acceptedBytes,
      targetMessageCompleted,
      invalidated: this.invalidated,
      ...(this.invalidationReason ? { invalidationReason: this.invalidationReason } : {}),
    };
  }

  private startPump(): void {
    if (this.pumpPromise) return;
    const wrapped = this.pump().finally(() => {
      if (this.pumpPromise === wrapped) {
        this.pumpPromise = undefined;
      }
      if (this.queue.length > 0) this.startPump();
    });
    this.pumpPromise = wrapped;
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0) {
      const operation = this.queue.shift()!;
      if (operation.kind === 'invalidate') {
        try {
          await this.sink.invalidate(operation.reason);
        } catch {
          // The sink already owns durable recovery. Relay invalidation is
          // best-effort after that boundary and must not expose its error.
        }
        continue;
      }
      if (operation.kind === 'retire') {
        try {
          await this.sink.retire?.(operation.late);
        } catch {
          // The sink leaves the stream for the terminal to reconcile.
        }
        continue;
      }
      if (operation.kind === 'intent') {
        try {
          await this.sink.modelIntent!.transition(operation.transition);
        } catch {
          this.invalidated = true;
          this.invalidationReason = 'intent_persistence_failed';
          this.stop();
          this.queue.length = 0;
          try {
            await this.sink.invalidate('intent_persistence_failed');
          } catch {
            // The missing durable transition is itself the recovery signal.
          }
        }
        continue;
      }
      if (this.invalidationReason === 'sink_failed' ||
          this.invalidationReason === 'intent_persistence_failed') continue;
      try {
        // Wait for the Slack pace first, then take every chunk that arrived
        // meanwhile: a slower cadence carries more text per append.
        if (this.sink.prepareAppend) await this.sink.prepareAppend(this.appendControl);
        while (this.queue[0]?.kind === 'append') {
          const next = this.queue.shift() as Extract<RelayOperation, { kind: 'append' }>;
          operation.chunk = {
            messageId: operation.chunk.messageId,
            delta: operation.chunk.delta + next.chunk.delta,
            position: next.chunk.position,
          };
          operation.count += next.count;
        }
        await this.sink.append(operation.chunk, this.appendControl);
        this.acceptedChunks += operation.count;
        this.acceptedBytes += new TextEncoder().encode(operation.chunk.delta).byteLength;
      } catch (error) {
        this.invalidated = true;
        this.invalidationReason = 'sink_failed';
        this.stop();
        this.queue.length = 0;
        try {
          await this.sink.invalidate('sink_failed', error);
        } catch {
          // Same fail-closed rule as an explicit invalidation above.
        }
      } finally {
        this.queuedTextChunks = Math.max(0, this.queuedTextChunks - operation.count);
      }
    }
  }
}

/**
 * `early`: the declaration must precede every other tool and all answer text.
 * `final_answer`: effect tools may run first; the declaration must come alone
 * in its model step after every earlier call has settled. Earlier-step
 * narration is not late, because Slack only receives the final step's text.
 */
export type ProgressiveRelayMode = ProgressiveStreamingMode;

/**
 * Active-turn content relay for one exact Flue receipt. The callback is
 * deliberately synchronous: it copies only bounded public protocol facts
 * into a serialized queue. V2 answer text enters that queue only after a
 * matching successful stream_answer result, and the durable requested-intent
 * operation is always ahead of the first append. V1 keeps its frozen legacy
 * behavior for the row's retention lifetime.
 */
export class ReceiptScopedTextRelay implements SlackProgressiveReadRelay {
  readonly onEvent = (chunk: ConversationStreamChunk): void => {
    if (!this.accepting) return;
    if (!validPosition(chunk.position)) {
      this.denyAndInvalidate('identity_conflict', 'message_identity_conflict', true);
      return;
    }
    if (this.lastSeenPosition && comparePosition(chunk.position, this.lastSeenPosition) <= 0) {
      return;
    }
    this.lastSeenPosition = { ...chunk.position };

    if (chunk.type === 'conversation-reset') {
      // The initial replay snapshot is a normal read boundary. A later reset
      // destroys the incremental identity proof even before a Slack effect.
      if (this.targetMessageId || this.sawTargetActivity()) {
        this.denyAndInvalidate('reset', 'conversation_reset', true);
      }
      return;
    }
    if (chunk.type === 'message-started' && chunk.submissionId === this.submissionId) {
      if (this.targetMessageId && this.targetMessageId !== chunk.messageId) {
        this.denyAndInvalidate('identity_conflict', 'message_identity_conflict', true);
        return;
      }
      this.targetMessageId = chunk.messageId;
      // Flue folds successive model steps into one response ID. A tool step
      // can complete before the answer reopens that same response; completion
      // does not settle the submission or change its incremental identity.
      this.targetMessageCompleted = false;
      this.stepToolCallIds.clear();
      this.declarationStepOpen = false;
      this.refusedToolStepOpen = false;
      // Only the final step's text reaches Slack, so undeclared narration
      // from an earlier step never makes a later final-answer declaration late.
      if (this.finalAnswerMode &&
          (this.intentStatus === 'unresolved' || this.awaitingReplayedDeclaration)) {
        this.preIntentTextSeen = false;
      }
      return;
    }
    if (chunk.type === 'message-completed' && chunk.messageId === this.targetMessageId) {
      this.targetMessageCompleted = true;
      return;
    }
    if (chunk.type === 'tool-input' && chunk.messageId === this.targetMessageId) {
      this.handleToolInput(chunk.toolName, chunk.toolCallId);
      return;
    }
    if (chunk.type === 'tool-output') {
      if (!this.targetToolCallIds.has(chunk.toolCallId)) return;
      this.handleToolOutcome(chunk.toolCallId, true);
      return;
    }
    if (chunk.type === 'tool-output-error') {
      if (!this.targetToolCallIds.has(chunk.toolCallId)) return;
      this.handleToolOutcome(chunk.toolCallId, false);
      return;
    }
    if (chunk.type === 'data-part' && chunk.messageId === this.targetMessageId) {
      // Every response ends by recording its file-delivery check. With no
      // files and nothing unresolved it leaves the answer text unchanged.
      if (isEmptyFileDeliveryResult(chunk.name, chunk.data)) return;
      if (this.usesModelIntent) {
        this.denyAndInvalidate(
          'structured_output',
          'structured_output',
          this.effects.hasText(),
        );
      } else {
        this.effects.invalidate('structured_output');
      }
      return;
    }
    if (
      chunk.type !== 'message-delta' ||
      chunk.kind !== 'text' ||
      !this.targetMessageId ||
      chunk.messageId !== this.targetMessageId ||
      chunk.delta.length === 0
    ) return;

    // 128 KiB is the durable presentation pending-buffer ceiling. One Flue
    // event above that cannot ever be a legal append and closes the relay.
    if (new TextEncoder().encode(chunk.delta).byteLength > 128 * 1_024) {
      this.denyAndInvalidate('identity_conflict', 'message_identity_conflict', true);
      return;
    }
    if (this.refusedToolStepOpen) {
      // Text sharing a step with a refused tool is not the final step's text.
      // Nothing was relayed yet, so terminal delivery needs no correction.
      this.denyAndInvalidate('non_presentation_tool', 'tool_activity', false);
      return;
    }
    if (this.usesModelIntent &&
        (this.intentStatus !== 'requested' || this.awaitingReplayedDeclaration)) {
      // A normal no-tool answer remains unresolved until close so it records
      // not_requested. If a declaration arrives later, it becomes explicitly
      // denied as late without exposing this already-seen text.
      this.preIntentTextSeen = true;
      return;
    }
    this.effects.text({
      messageId: chunk.messageId,
      delta: chunk.delta,
      position: { ...chunk.position },
    });
  };

  private readonly effects: ProgressiveEffects;
  private accepting = true;
  private targetMessageId: string | undefined;
  private lastSeenPosition: { batch: number; index: number } | undefined;
  private targetMessageCompleted = false;
  private intentStatus: SlackProgressiveIntent['status'];
  private intentToolCallId: string | undefined;
  private preIntentTextSeen = false;
  private readonly targetToolCallIds = new Set<string>();
  /** Calls in the current model step. */
  private readonly stepToolCallIds = new Set<string>();
  /** Final-answer mode: non-declaration calls without an outcome yet. */
  private readonly unsettledToolCallIds = new Set<string>();
  private declarationStepOpen = false;
  /** Final-answer mode: the answer-only lock refused a tool in this step. */
  private refusedToolStepOpen = false;
  /**
   * Final-answer mode, resumed read: a durable declaration exists, but this
   * read replays the whole response from its start. Until the replay reaches
   * that declaration, events belong to the pre-declaration tool work.
   */
  private awaitingReplayedDeclaration = false;

  constructor(
    private readonly options: ProgressiveTextSink & {
      submissionId: string;
      mode?: ProgressiveRelayMode;
    },
  ) {
    if (!boundedIdentity(options.submissionId)) {
      throw new Error('Progressive relay submission identity is invalid.');
    }
    this.effects = new ProgressiveEffects(options, () => { this.accepting = false; });
    const initial = options.modelIntent?.initial;
    this.intentStatus = initial?.status ?? 'requested';
    this.intentToolCallId = initial?.status === 'pending' || initial?.status === 'requested'
      ? initial.toolCallId
      : undefined;
    if (initial?.status === 'not_requested' || initial?.status === 'denied') {
      throw new Error('A terminal model intent cannot open a progressive relay.');
    }
    this.awaitingReplayedDeclaration = this.finalAnswerMode && this.intentToolCallId !== undefined;
  }

  private get submissionId(): string {
    return this.options.submissionId;
  }

  private get usesModelIntent(): boolean {
    return this.options.modelIntent !== undefined;
  }

  private get finalAnswerMode(): boolean {
    return this.usesModelIntent && this.options.mode === 'final_answer';
  }

  async closeAndDrain(): Promise<ProgressiveRelaySummary> {
    if (this.accepting && this.usesModelIntent) {
      if (this.intentStatus === 'unresolved') {
        this.intentStatus = 'not_requested';
        this.effects.intent({ kind: 'not_requested' });
      } else if (this.intentStatus === 'pending') {
        this.intentStatus = 'denied';
        this.effects.intent({ kind: 'denied', reason: 'declaration_failed' });
      }
    }
    this.accepting = false;
    this.effects.close();
    await this.effects.drain();
    return this.effects.summary(this.targetMessageCompleted);
  }

  async invalidateAndDrain(
    reason: ProgressiveRelayInvalidationReason,
  ): Promise<ProgressiveRelaySummary> {
    this.effects.invalidate(reason);
    this.effects.close();
    await this.effects.drain();
    return this.effects.summary(this.targetMessageCompleted);
  }

  async suspendAndDrain(): Promise<ProgressiveRelaySummary> {
    // A yielded read ends the same way an isolate kill would, minus the lost
    // queue: the next read replays the receipt from its start, and the sink's
    // durable position skips everything this relay already accepted.
    this.accepting = false;
    this.effects.close();
    await this.effects.drain();
    return this.effects.summary(this.targetMessageCompleted);
  }

  private handleToolInput(toolName: string, toolCallId: string): void {
    if (!this.usesModelIntent) {
      this.effects.invalidate('tool_activity');
      return;
    }
    if (!boundedIdentity(toolCallId)) {
      this.denyAndInvalidate('identity_conflict', 'message_identity_conflict', true);
      return;
    }
    this.targetToolCallIds.add(toolCallId);
    const sibling = this.stepToolCallIds.size > 0;
    this.stepToolCallIds.add(toolCallId);
    if (toolName !== SLACK_STREAM_ANSWER_TOOL_NAME) {
      if (this.finalAnswerMode) {
        this.handleFinalAnswerEffectTool(toolCallId);
        return;
      }
      this.denyAndInvalidate(
        'non_presentation_tool',
        'tool_activity',
        this.effects.hasText(),
      );
      return;
    }
    if (this.preIntentTextSeen) {
      this.denyAndInvalidate('late_declaration', 'tool_activity', false);
      return;
    }
    if (this.intentStatus === 'unresolved') {
      if (this.finalAnswerMode && (sibling || this.unsettledToolCallIds.size > 0)) {
        // A final answer is declared alone in its step, after every earlier
        // call has settled.
        this.denyAndInvalidate('concurrent_tool', 'tool_activity', false);
        return;
      }
      this.intentStatus = 'pending';
      this.intentToolCallId = toolCallId;
      this.declarationStepOpen = true;
      this.effects.intent({ kind: 'candidate', toolCallId });
      return;
    }
    if ((this.intentStatus === 'pending' || this.intentStatus === 'requested') &&
        this.intentToolCallId === toolCallId) {
      // Full receipt replay repeats the same positioned declaration. The
      // durable state is already authoritative, so this is a no-op.
      if (this.awaitingReplayedDeclaration) {
        this.awaitingReplayedDeclaration = false;
        this.declarationStepOpen = true;
      }
      return;
    }
    this.denyAndInvalidate('repeated_declaration', 'tool_activity', this.effects.hasText());
  }

  /** Final-answer mode: a non-declaration tool call in the target response. */
  private handleFinalAnswerEffectTool(toolCallId: string): void {
    if (this.intentStatus === 'unresolved' || this.awaitingReplayedDeclaration) {
      // Effect work before the declaration is the point of this mode.
      this.unsettledToolCallIds.add(toolCallId);
      return;
    }
    if (this.intentStatus === 'pending' || this.declarationStepOpen) {
      this.denyAndInvalidate('concurrent_tool', 'tool_activity', this.effects.hasText());
      return;
    }
    // The answer-only lock refuses this call before it runs, so no effect
    // can follow released text. Released text cannot be reconciled with a
    // later step, though, so any text already relayed ends the stream.
    if (this.effects.hasText()) {
      this.denyAndInvalidate('non_presentation_tool', 'tool_activity', true);
      return;
    }
    this.refusedToolStepOpen = true;
  }

  private handleToolOutcome(toolCallId: string, succeeded: boolean): void {
    if (!this.usesModelIntent) return;
    // A settled pre-declaration effect call says nothing about the declaration.
    if (this.unsettledToolCallIds.delete(toolCallId)) return;
    if (this.intentStatus === 'requested' && this.intentToolCallId === toolCallId) {
      return;
    }
    if (this.intentStatus !== 'pending') return;
    if (this.intentToolCallId !== toolCallId) {
      this.denyAndInvalidate(
        'mismatched_declaration',
        'tool_activity',
        this.effects.hasText(),
      );
      return;
    }
    if (!succeeded) {
      this.denyAndInvalidate('declaration_failed', 'tool_activity', this.effects.hasText());
      return;
    }
    if (this.preIntentTextSeen) {
      this.denyAndInvalidate('late_declaration', 'tool_activity', false);
      return;
    }
    this.intentStatus = 'requested';
    this.effects.intent({ kind: 'requested', toolCallId });
  }

  private denyAndInvalidate(
    denial: SlackProgressiveIntentDenialReason,
    invalidation: ProgressiveRelayInvalidationReason,
    hardInvalidate: boolean,
  ): void {
    if (!this.usesModelIntent) {
      this.effects.invalidate(invalidation);
      return;
    }
    if (this.intentStatus === 'denied' || this.intentStatus === 'not_requested') return;
    this.intentStatus = 'denied';
    this.effects.intent({ kind: 'denied', reason: denial });
    this.accepting = false;
    if (hardInvalidate) this.effects.invalidate(invalidation);
  }

  streamedAnswer(): boolean {
    return this.intentStatus === 'requested' || this.effects.hasText();
  }

  streamedPrefixBound(): string | undefined {
    return this.options.streamedPrefixBound?.();
  }

  canonicalStreamText(text: string): string | undefined {
    return this.options.canonicalStreamText?.(text);
  }

  private sawTargetActivity(): boolean {
    return this.preIntentTextSeen || this.effects.hasText();
  }
}

export function isEmptyFileDeliveryResult(name: string, data: unknown): boolean {
  if (name !== FILE_DELIVERY_DATA_NAME || !data || typeof data !== 'object') return false;
  // The same condition under which resolveFileDeliveryText keeps the text.
  const result = data as { unresolved?: unknown; files?: unknown };
  return result.unresolved === false && Array.isArray(result.files) && result.files.length === 0;
}

export function validPosition(value: { batch: number; index: number }): boolean {
  return Number.isSafeInteger(value.batch) && value.batch >= 0 &&
    Number.isSafeInteger(value.index) && value.index >= 0;
}

export function comparePosition(
  left: { batch: number; index: number },
  right: { batch: number; index: number },
): number {
  return left.batch === right.batch ? left.index - right.index : left.batch - right.batch;
}

export function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}
