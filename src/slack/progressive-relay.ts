import type { ConversationStreamChunk } from '@flue/runtime';

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
  | 'sink_failed';

export interface ProgressiveRelaySummary {
  acceptedChunks: number;
  acceptedBytes: number;
  targetMessageCompleted: boolean;
  invalidated: boolean;
  invalidationReason?: ProgressiveRelayInvalidationReason;
}

export interface ProgressiveTextSink {
  append(chunk: ProgressiveTextChunk): Promise<void>;
  invalidate(reason: ProgressiveRelayInvalidationReason): Promise<void>;
}

export interface SlackProgressiveReadRelay {
  onEvent(chunk: ConversationStreamChunk): void;
  closeAndDrain(): Promise<ProgressiveRelaySummary>;
  invalidateAndDrain(
    reason: ProgressiveRelayInvalidationReason,
  ): Promise<ProgressiveRelaySummary>;
}

type RelayOperation =
  | { kind: 'append'; chunk: ProgressiveTextChunk; count: number }
  | { kind: 'invalidate'; reason: ProgressiveRelayInvalidationReason };

/**
 * Active-turn content relay for one exact Flue receipt. The callback is
 * deliberately synchronous: it copies only a bounded public text delta and
 * its opaque position into a serialized queue, while every durable mutation
 * and Slack effect happens in the awaited sink. Reasoning, tools, data, other
 * submissions, and late events never enter the queue.
 */
export class ReceiptScopedTextRelay implements SlackProgressiveReadRelay {
  readonly onEvent = (chunk: ConversationStreamChunk): void => {
    if (!this.accepting) return;
    if (!validPosition(chunk.position)) {
      this.queueInvalidation('message_identity_conflict');
      return;
    }
    if (this.lastSeenPosition && comparePosition(chunk.position, this.lastSeenPosition) <= 0) {
      return;
    }
    this.lastSeenPosition = { ...chunk.position };

    if (chunk.type === 'conversation-reset') {
      // A creation/reset snapshot before this receipt's response begins is a
      // normal read boundary. Once target identity or text exists, a reset
      // invalidates the incremental proof and closes live presentation.
      if (this.targetMessageId || this.queuedTextChunks > 0 || this.acceptedChunks > 0) {
        this.queueInvalidation('conversation_reset');
      }
      return;
    }
    if (chunk.type === 'message-started' && chunk.submissionId === this.submissionId) {
      if (this.targetMessageCompleted) {
        this.queueInvalidation('tool_activity');
        return;
      }
      if (this.targetMessageId && this.targetMessageId !== chunk.messageId) {
        this.queueInvalidation('message_identity_conflict');
        return;
      }
      this.targetMessageId = chunk.messageId;
      return;
    }
    if (chunk.type === 'message-completed' && chunk.messageId === this.targetMessageId) {
      this.targetMessageCompleted = true;
      return;
    }
    if (chunk.type === 'tool-input' && chunk.messageId === this.targetMessageId) {
      this.queueInvalidation('tool_activity');
      return;
    }
    if (chunk.type === 'data-part' && chunk.messageId === this.targetMessageId) {
      this.queueInvalidation('structured_output');
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
      this.queueInvalidation('message_identity_conflict');
      return;
    }
    this.queuedTextChunks += 1;
    this.queue.push({
      kind: 'append',
      count: 1,
      chunk: {
        messageId: chunk.messageId,
        delta: chunk.delta,
        position: { ...chunk.position },
      },
    });
    this.startPump();
  };

  private readonly queue: RelayOperation[] = [];
  private pumpPromise: Promise<void> | undefined;
  private accepting = true;
  private targetMessageId: string | undefined;
  private lastSeenPosition: { batch: number; index: number } | undefined;
  private queuedTextChunks = 0;
  private acceptedChunks = 0;
  private acceptedBytes = 0;
  private targetMessageCompleted = false;
  private invalidated = false;
  private invalidationReason: ProgressiveRelayInvalidationReason | undefined;

  constructor(
    private readonly options: ProgressiveTextSink & { submissionId: string },
  ) {
    if (!boundedIdentity(options.submissionId)) {
      throw new Error('Progressive relay submission identity is invalid.');
    }
  }

  private get submissionId(): string {
    return this.options.submissionId;
  }

  async closeAndDrain(): Promise<ProgressiveRelaySummary> {
    this.accepting = false;
    await this.drain();
    return this.summary();
  }

  async invalidateAndDrain(
    reason: ProgressiveRelayInvalidationReason,
  ): Promise<ProgressiveRelaySummary> {
    this.queueInvalidation(reason);
    await this.drain();
    return this.summary();
  }

  private queueInvalidation(reason: ProgressiveRelayInvalidationReason): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.invalidationReason = reason;
    this.accepting = false;
    this.queue.push({ kind: 'invalidate', reason });
    this.startPump();
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
          await this.options.invalidate(operation.reason);
        } catch {
          // The sink already owns durable recovery. Relay invalidation is
          // best-effort after that boundary and must not expose its error.
        }
        continue;
      }
      if (this.invalidationReason === 'sink_failed') continue;
      while (this.queue[0]?.kind === 'append') {
        const next = this.queue.shift() as Extract<RelayOperation, { kind: 'append' }>;
        operation.chunk = {
          messageId: operation.chunk.messageId,
          delta: operation.chunk.delta + next.chunk.delta,
          position: next.chunk.position,
        };
        operation.count += next.count;
      }
      try {
        await this.options.append(operation.chunk);
        this.acceptedChunks += operation.count;
        this.acceptedBytes += new TextEncoder().encode(operation.chunk.delta).byteLength;
      } catch {
        this.invalidated = true;
        this.invalidationReason = 'sink_failed';
        this.accepting = false;
        this.queue.length = 0;
        try {
          await this.options.invalidate('sink_failed');
        } catch {
          // Same fail-closed rule as an explicit invalidation above.
        }
      } finally {
        this.queuedTextChunks = Math.max(0, this.queuedTextChunks - operation.count);
      }
    }
  }

  private async drain(): Promise<void> {
    while (this.pumpPromise || this.queue.length > 0) {
      this.startPump();
      await this.pumpPromise;
    }
  }

  private summary(): ProgressiveRelaySummary {
    return {
      acceptedChunks: this.acceptedChunks,
      acceptedBytes: this.acceptedBytes,
      targetMessageCompleted: this.targetMessageCompleted,
      invalidated: this.invalidated,
      ...(this.invalidationReason ? { invalidationReason: this.invalidationReason } : {}),
    };
  }
}

function validPosition(value: { batch: number; index: number }): boolean {
  return Number.isSafeInteger(value.batch) && value.batch >= 0 &&
    Number.isSafeInteger(value.index) && value.index >= 0;
}

function comparePosition(
  left: { batch: number; index: number },
  right: { batch: number; index: number },
): number {
  return left.batch === right.batch ? left.index - right.index : left.batch - right.batch;
}

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}
