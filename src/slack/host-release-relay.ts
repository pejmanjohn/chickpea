import type { ConversationStreamChunk } from '@flue/runtime';

import { CODING_WORKSPACE_USE_DATA_NAME } from '../sandbox/workspace-use.ts';
import { SLACK_AGENT_CREATION_TERMINAL_DATA_NAME } from './agent-creation-terminal.ts';
import {
  answerReleasePoint,
  MAX_STEP_TEXT_CHARS,
  releaseCheckDue,
  toolBlock,
  type AnswerReleaseBlock,
  type ReleaseStep,
} from './answer-release.ts';
import {
  CODING_WORKER_RUN_DATA_NAME,
  CODING_WORKER_USAGE_DATA_NAME,
  WORKSPACE_MILESTONE_DATA_NAME,
} from './coding-worker-run.ts';
import { FILE_DELIVERY_DATA_NAME } from './file-delivery-completion.ts';
import { SLACK_FRONT_DESK_HANDOFF_DATA_NAME } from './front-desk.ts';
import { SLACK_MEMORY_UPDATE_DATA_NAME } from './memory-update-terminal.ts';
import { PRESENTATION_TOOL_NAMES } from './presentation-tool-policy.ts';
import {
  boundedIdentity,
  comparePosition,
  isEmptyFileDeliveryResult,
  ProgressiveEffects,
  validPosition,
  type ProgressiveRelayInvalidationReason,
  type ProgressiveRelaySummary,
  type ProgressiveTextSink,
  type SlackProgressiveReadRelay,
} from './progressive-relay.ts';
import {
  HOST_RELEASE_INTENT_ID,
  type SlackProgressiveIntent,
  type SlackProgressiveIntentDenialReason,
} from './run-presentations.ts';
import { SLACK_TABLE_PRESENTATION_DATA_NAME } from './table-presentation.ts';
import { SLACK_INTERACTIVE_QUESTION_DATA_NAME } from './ui/interactive-tools.ts';
import { SLACK_DISPLAY_COMPONENTS_DATA_NAME } from './ui/display-tools.ts';
import { KEY_SETUP_TOOL_DATA_NAME } from './ui/surface.ts';
import { SLACK_ARTIFACT_RECEIPTS_DATA_NAME } from './artifact-receipts.ts';

/**
 * What keeps a response terminal when it comes before a release: the shadow's
 * blocking conditions, plus the data parts the first release keeps terminal.
 * `structured_output` is a data part this list does not know.
 */
export type HostReleaseBlock =
  | AnswerReleaseBlock
  | 'display_component'
  | 'key_setup'
  | 'structured_output'
  | 'identity_conflict';

/** What followed released text, so it was not the final answer. */
export type HostReleaseLate = HostReleaseBlock | 'presentation_tool' | 'tool' | 'step';

/** One attempt's host release as its relay saw it; content-free. */
export type HostReleaseReport =
  | { outcome: 'released' }
  | { outcome: 'below_hold' }
  | { outcome: 'blocked'; block: HostReleaseBlock };

/**
 * The relay's report, or how a late release left Slack: `retired` (deleted,
 * or never shown) or `corrected` (kept for the final to correct, as a stream
 * that carries the native task card is). `retiredVisibleMs`: how long Slack
 * showed the released text before its deletion.
 */
export type HostReleaseRecord =
  | HostReleaseReport
  | { outcome: 'retired' | 'corrected'; late: HostReleaseLate; retiredVisibleMs?: number };

/**
 * Data parts after which the answer text is delivered as written. A table
 * renders in the closing call's blocks; the rest are records the reply
 * carries beside its text. Every other data part blocks or retires.
 */
const PASSING_DATA_PARTS: ReadonlySet<string> = new Set([
  SLACK_MEMORY_UPDATE_DATA_NAME,
  SLACK_TABLE_PRESENTATION_DATA_NAME,
  CODING_WORKSPACE_USE_DATA_NAME,
  CODING_WORKER_RUN_DATA_NAME,
  CODING_WORKER_USAGE_DATA_NAME,
  WORKSPACE_MILESTONE_DATA_NAME,
]);

function dataPartBlock(name: string, data: unknown): HostReleaseBlock | undefined {
  if (PASSING_DATA_PARTS.has(name) || isEmptyFileDeliveryResult(name, data)) return undefined;
  if (name === FILE_DELIVERY_DATA_NAME || name === SLACK_ARTIFACT_RECEIPTS_DATA_NAME) return 'file_delivery';
  if (name === SLACK_AGENT_CREATION_TERMINAL_DATA_NAME) return 'agent_creation';
  if (name === SLACK_FRONT_DESK_HANDOFF_DATA_NAME) return 'draft_replacing_tool';
  if (name === SLACK_INTERACTIVE_QUESTION_DATA_NAME) return 'interactive_component';
  if (name === SLACK_DISPLAY_COMPONENTS_DATA_NAME) return 'display_component';
  if (name === KEY_SETUP_TOOL_DATA_NAME) return 'key_setup';
  return 'structured_output';
}

function blockDenial(block: HostReleaseBlock): SlackProgressiveIntentDenialReason {
  if (block === 'conversation_reset') return 'reset';
  if (block === 'identity_conflict') return 'identity_conflict';
  if (block === 'draft_replacing_tool' || block === 'interactive_component') return 'non_presentation_tool';
  return 'structured_output';
}

export interface HostReleaseSink extends ProgressiveTextSink {
  modelIntent: NonNullable<ProgressiveTextSink['modelIntent']>;
  /**
   * Released text was not the final answer: take it out of Slack (or leave
   * it for the final to correct). Runs after every append that reached Slack.
   */
  retire(late: HostReleaseLate): Promise<void>;
  report?(report: HostReleaseReport): void;
}

/**
 * The host's answer release for one Flue receipt: a model step's text
 * streams once it holds `holdChars` settled characters and no tool call has
 * appeared in it. It replaces the model's `stream_answer` declaration as the
 * trigger while CHICKPEA_SLACK_ANSWER_RELEASE is `host`.
 *
 * - Holding: each model step's text is held. A tool call drops it (narration
 *   before a tool), and a step that ends short of the hold shows nothing
 *   early: its final posts whole, as before.
 * - Released: the step's held text becomes the first append, after the
 *   intent `requested` under HOST_RELEASE_INTENT_ID is durable. Later text
 *   of the step appends, as does a step Flue's recovery continues after an
 *   interruption.
 * - Late: a tool call, any other new step, a reset or a blocking data part
 *   after the release. Queued text is dropped and the sink retires what
 *   Slack shows; the final posts fresh.
 *
 * A blocking condition before any release (a draft the host can replace, a
 * file, a question, a data part outside PASSING_DATA_PARTS) denies the intent
 * and keeps the response terminal. The rule counts characters, never time,
 * so a resumed read that replays the receipt from its start releases at the
 * same point, and the sink's durable position skips what Slack already has.
 */
export class HostReleaseRelay implements SlackProgressiveReadRelay {
  private readonly effects: ProgressiveEffects;
  private accepting = true;
  private lastSeenPosition: { batch: number; index: number } | undefined;
  private targetMessageId: string | undefined;
  private targetMessageCompleted = false;
  private released = false;
  /** `requested`: durable (this read's release, or an earlier attempt's). */
  private intent: 'unresolved' | 'requested' | 'decided';
  private step: ReleaseStep & { toolCalled: boolean } | undefined;
  /** Flue's recovery asked the model to continue the step that just completed. */
  private continuation = false;

  constructor(
    private readonly options: HostReleaseSink & {
      submissionId: string;
      holdChars: number;
      initial: SlackProgressiveIntent;
    },
  ) {
    if (!boundedIdentity(options.submissionId)) {
      throw new Error('Progressive relay submission identity is invalid.');
    }
    const { initial } = options;
    if (initial.status === 'unresolved') {
      this.intent = 'unresolved';
    } else if (initial.status === 'requested' && initial.toolCallId === HOST_RELEASE_INTENT_ID) {
      this.intent = 'requested';
    } else {
      throw new Error('Only an unresolved or host-requested intent opens a host release.');
    }
    this.effects = new ProgressiveEffects(options, () => { this.accepting = false; });
  }

  readonly onEvent = (chunk: ConversationStreamChunk): void => {
    if (!this.accepting) return;
    if (!validPosition(chunk.position)) {
      this.conflict();
      return;
    }
    if (this.lastSeenPosition && comparePosition(chunk.position, this.lastSeenPosition) <= 0) return;
    this.lastSeenPosition = { ...chunk.position };

    switch (chunk.type) {
      case 'conversation-reset':
        // The read's opening snapshot is a boundary. A later one leaves no
        // step boundaries to release by.
        if (this.targetMessageId) this.stop('conversation_reset');
        return;
      case 'message-appended': {
        const message = chunk.message;
        if (message.role === 'system' && message.display === 'hidden') {
          this.continuation ||= this.targetMessageCompleted && message.purpose === 'advisory' &&
            (message.submissionId === undefined || message.submissionId === this.options.submissionId);
        } else {
          this.continuation = false;
        }
        return;
      }
      case 'message-started': {
        if (chunk.submissionId !== this.options.submissionId) return;
        if (this.targetMessageId && this.targetMessageId !== chunk.messageId) {
          this.conflict();
          return;
        }
        this.targetMessageId = chunk.messageId;
        this.targetMessageCompleted = false;
        const continuation = this.continuation;
        this.continuation = false;
        if (this.released) {
          if (!continuation) this.late('step');
          return;
        }
        this.step = { text: '', toolCalled: false, nextCheckAt: 0 };
        return;
      }
      case 'message-completed':
        if (chunk.messageId === this.targetMessageId) this.targetMessageCompleted = true;
        return;
      case 'tool-input': {
        if (chunk.messageId !== this.targetMessageId) return;
        if (this.released) {
          this.late(PRESENTATION_TOOL_NAMES.has(chunk.toolName)
            ? 'presentation_tool'
            : toolBlock(chunk.toolName) ?? 'tool');
          return;
        }
        // Text before a tool call is narration: never released.
        if (this.step) this.step = { text: '', toolCalled: true, nextCheckAt: 0 };
        const block = toolBlock(chunk.toolName);
        if (block) this.stop(block);
        return;
      }
      case 'data-part': {
        if (chunk.messageId !== this.targetMessageId) return;
        const block = dataPartBlock(chunk.name, chunk.data);
        if (block) this.stop(block);
        return;
      }
      case 'message-delta':
        if (chunk.kind !== 'text' || chunk.messageId !== this.targetMessageId || chunk.delta.length === 0) return;
        // 128 KiB is the durable presentation pending-buffer ceiling. One Flue
        // event above that can never be a legal append and closes the relay.
        if (new TextEncoder().encode(chunk.delta).byteLength > 128 * 1_024) {
          this.conflict();
          return;
        }
        if (this.released) {
          this.effects.text({ messageId: chunk.messageId, delta: chunk.delta, position: { ...chunk.position } });
          return;
        }
        this.hold(chunk.messageId, chunk.delta, chunk.position);
        return;
      default:
        return;
    }
  };

  async closeAndDrain(): Promise<ProgressiveRelaySummary> {
    if (this.accepting && this.intent === 'unresolved') {
      this.intent = 'decided';
      this.effects.intent({ kind: 'not_requested' });
      this.report({ outcome: 'below_hold' });
    }
    this.accepting = false;
    this.effects.close();
    await this.effects.drain();
    return this.effects.summary(this.targetMessageCompleted);
  }

  async invalidateAndDrain(reason: ProgressiveRelayInvalidationReason): Promise<ProgressiveRelaySummary> {
    this.effects.invalidate(reason);
    this.effects.close();
    await this.effects.drain();
    return this.effects.summary(this.targetMessageCompleted);
  }

  async suspendAndDrain(): Promise<ProgressiveRelaySummary> {
    this.accepting = false;
    this.effects.close();
    await this.effects.drain();
    return this.effects.summary(this.targetMessageCompleted);
  }

  streamedAnswer(): boolean {
    return this.effects.hasText();
  }

  streamedPrefixBound(): string | undefined {
    return this.options.streamedPrefixBound?.();
  }

  canonicalStreamText(text: string): string | undefined {
    return this.options.canonicalStreamText?.(text);
  }

  private hold(messageId: string, delta: string, position: { batch: number; index: number }): void {
    const step = this.step;
    if (!step || step.toolCalled || step.text.length >= MAX_STEP_TEXT_CHARS) return;
    step.text += delta;
    if (!releaseCheckDue(step, delta, this.options.holdChars)) return;
    if (answerReleasePoint(step.text, this.options.holdChars) === undefined) return;
    this.released = true;
    if (this.intent === 'unresolved') {
      this.intent = 'requested';
      this.effects.intent({ kind: 'candidate', toolCallId: HOST_RELEASE_INTENT_ID });
      this.effects.intent({ kind: 'requested', toolCallId: HOST_RELEASE_INTENT_ID });
    }
    this.effects.text({ messageId, delta: step.text, position: { ...position } });
    this.report({ outcome: 'released' });
  }

  /**
   * A blocking condition. Before any release it keeps the response
   * terminal. After one (in this read, or in an earlier attempt whose
   * release this replay has not reached yet) it retires the released text.
   */
  private stop(block: HostReleaseBlock): void {
    if (this.released || this.intent === 'requested') {
      this.late(block);
      return;
    }
    this.accepting = false;
    if (this.intent === 'unresolved') {
      this.intent = 'decided';
      this.effects.intent({ kind: 'denied', reason: blockDenial(block) });
    }
    this.report({ outcome: 'blocked', block });
  }

  private late(late: HostReleaseLate): void {
    this.accepting = false;
    this.released = false;
    this.effects.retire(late);
  }

  /** The receipt's identity cannot be trusted: the stream stays as it is and the final corrects it. */
  private conflict(): void {
    if (this.intent === 'unresolved') {
      this.intent = 'decided';
      this.effects.intent({ kind: 'denied', reason: 'identity_conflict' });
      this.report({ outcome: 'blocked', block: 'identity_conflict' });
    }
    this.effects.invalidate('message_identity_conflict');
  }

  private report(report: HostReleaseReport): void {
    try {
      this.options.report?.(report);
    } catch {
      // Observation never changes what the relay does.
    }
  }
}
