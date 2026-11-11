import type { ConversationStreamChunk } from '@flue/runtime';

import { SLACK_AGENT_CREATION_TERMINAL_DATA_NAME } from './agent-creation-terminal.ts';
import { DEFAULT_ANSWER_RELEASE_CHARS } from './answer-release-setting.ts';
import { FILE_DELIVERY_DATA_NAME } from './file-delivery-completion.ts';
import { streamableSlackMarkdownPrefix } from './message-format.ts';
import {
  DRAFT_REPLACING_TOOL_NAMES,
  INTERACTIVE_TOOL_NAMES,
  isArtifactUploadTool,
  PRESENTATION_TOOL_NAMES,
} from './presentation-tool-policy.ts';
import { isEmptyFileDeliveryResult } from './progressive-relay.ts';
import { SLACK_DISPLAY_COMPONENTS_DATA_NAME } from './ui/display-tools.ts';
import { KEY_SETUP_TOOL_DATA_NAME } from './ui/surface.ts';

/**
 * Settled characters a model step must hold, with no tool call in it, before
 * the host releases its text to Slack, unless the deployment sets another
 * hold (answer-release-setting.ts). The shadow below measures the text models
 * write before tool calls, which is what sets it.
 */
export const RELEASE_AFTER_CHARS = DEFAULT_ANSWER_RELEASE_CHARS;

/**
 * The settled length at which a step's text is released, or undefined.
 * "Settled" is what `streamableSlackMarkdownPrefix` would show now, so the
 * redaction hold governs every released character.
 */
export function answerReleasePoint(stepText: string, holdChars = RELEASE_AFTER_CHARS): number | undefined {
  const settled = streamableSlackMarkdownPrefix(stepText).length;
  return settled >= holdChars ? settled : undefined;
}

/** What keeps a whole response terminal when it comes before any release. */
export type AnswerReleaseBlock =
  /** The host may replace the draft: workspace changes, a front-desk hand-off. */
  | 'draft_replacing_tool'
  /** A file upload, or a file-delivery result with files. */
  | 'file_delivery'
  /** ask_user, request_form, offer_actions. */
  | 'interactive_component'
  /** An Agent creation's welcome replaces the draft. */
  | 'agent_creation'
  /** A snapshot replaced the step boundaries after the response began. */
  | 'conversation_reset';

/**
 * What followed released text, so the release would be retired: a
 * presentation tool (table, display, interactive), any other tool, or a
 * blocking data part or reset.
 */
export type AnswerReleaseLate = 'presentation_tool' | 'tool' | AnswerReleaseBlock;

/**
 * `below_hold`: no step reached the hold. `released`: one did and nothing
 * followed it. `retired`: something followed the released text. `blocked`:
 * a blocking condition came first.
 */
export type AnswerReleaseOutcome = 'below_hold' | 'released' | 'retired' | 'blocked';

/** Settled lengths the text before a step's first tool call is counted at. */
const PRE_TOOL_TEXT_EDGES = [1, 100, 200, 300, 400, 600, 800] as const;
type PreToolTextCounts = {
  [Edge in typeof PRE_TOOL_TEXT_EDGES[number] as `preToolText${Edge}`]: number;
};

/** One response's shadow, content-free: lengths, counts, durations and tokens. */
export interface AnswerReleaseShadowRecord extends PreToolTextCounts {
  outcome: AnswerReleaseOutcome;
  block?: AnswerReleaseBlock;
  late?: AnswerReleaseLate;
  holdChars: number;
  /** When the rule released, on the observer's clock. Never logged as is. */
  releasedAt?: number;
  /** The settled length when the rule released. */
  releaseChars?: number;
  /** From the releasing step's first text to the release. */
  releaseHoldMs?: number;
  /** From the release to what followed it: how long retired text would show. */
  releaseToLateMs?: number;
  /** Model steps that called a tool. */
  toolSteps: number;
  /** Model steps that completed without one. */
  answerSteps: number;
  /** The settled length of the last step that completed without a tool call. */
  finalAnswerChars?: number;
  /**
   * Display component (cards, chart, details) and key-setup data parts the
   * response wrote. Neither blocks here; the release keeps both terminal at
   * first, so these say how many released replies that would hold back.
   */
  displayParts: number;
  keySetupParts: number;
}

interface Release {
  at: number;
  chars: number;
  holdMs: number;
}

type ShadowState =
  | { phase: 'holding' }
  | { phase: 'blocked'; block: AnswerReleaseBlock }
  | { phase: 'released'; release: Release }
  | { phase: 'retired'; release: Release; late: AnswerReleaseLate; lateAt: number };

/** One model step's text as the release rule reads it. */
export interface ReleaseStep {
  text: string;
  /** Past `EXACT_CHECK_CHARS`, the length the next check waits for. */
  nextCheckAt: number;
}

interface Step extends ReleaseStep {
  firstTextAt?: number;
  toolCalled: boolean;
}

/** Text longer than this is not read further; Flue refuses such a step anyway. */
export const MAX_STEP_TEXT_CHARS = 128 * 1_024;
/**
 * The settled prefix ends at a space or a line start, so it can move only
 * when a delta brings one. Formatting lengthens text by a character here and
 * there (the `@here` joiner), never twice over, so a step shorter than half
 * the hold cannot reach it.
 */
const SETTLING_DELTA = /[ \n\r]/;
/**
 * Up to this length the rule is checked on every such delta. Text that grows
 * past it unsettled (one long line under open markup, an armored block) is
 * checked when it grows by an eighth or breaks a line, which keeps the
 * formatter's cost bounded.
 */
const EXACT_CHECK_CHARS = 4_096;

/**
 * Observes one Flue response and records what the host release rule would
 * have done with it, without touching Slack. It reads the chunks the turn's
 * observation already reads, keeps only the current step's text in memory,
 * and reports lengths and counts. A read that resumes mid-response reports
 * only what it saw.
 */
export class AnswerReleaseShadow {
  readonly #holdChars: number;
  #submissionId: string | undefined;
  #messageId: string | undefined;
  #position: { batch: number; index: number } | undefined;
  #step: Step | undefined;
  #state: ShadowState = { phase: 'holding' };
  #ended = false;
  #faulted = false;
  #toolSteps = 0;
  #answerSteps = 0;
  readonly #preToolText = PRE_TOOL_TEXT_EDGES.map(() => 0);
  #finalAnswerChars: number | undefined;
  #displayParts = 0;
  #keySetupParts = 0;

  /** `holdChars`: the hold the live release uses, so both read a reply alike. */
  constructor(private readonly now: () => number = Date.now, holdChars = RELEASE_AFTER_CHARS) {
    this.#holdChars = holdChars;
  }

  /**
   * Never throws: an observer fault ends the shadow, never the turn. A
   * shadow that faulted reports nothing, since its counts stopped mid-response.
   */
  onEvent(chunk: ConversationStreamChunk, submissionId: string): void {
    try {
      this.#observe(chunk, submissionId);
    } catch {
      this.#ended = true;
      this.#faulted = true;
    }
  }

  /** Undefined until the response's first step started, and after a fault. */
  record(): AnswerReleaseShadowRecord | undefined {
    if (this.#messageId === undefined || this.#faulted) return undefined;
    const state = this.#state;
    const release = state.phase === 'released' || state.phase === 'retired' ? state.release : undefined;
    return {
      outcome: state.phase === 'holding' ? 'below_hold' : state.phase,
      ...(state.phase === 'blocked' ? { block: state.block } : {}),
      ...(state.phase === 'retired'
        ? { late: state.late, releaseToLateMs: state.lateAt - state.release.at }
        : {}),
      holdChars: this.#holdChars,
      ...(release
        ? { releasedAt: release.at, releaseChars: release.chars, releaseHoldMs: release.holdMs }
        : {}),
      toolSteps: this.#toolSteps,
      answerSteps: this.#answerSteps,
      ...Object.fromEntries(PRE_TOOL_TEXT_EDGES.map((edge, index) =>
        [`preToolText${edge}`, this.#preToolText[index]!])) as PreToolTextCounts,
      ...(this.#finalAnswerChars === undefined ? {} : { finalAnswerChars: this.#finalAnswerChars }),
      displayParts: this.#displayParts,
      keySetupParts: this.#keySetupParts,
    };
  }

  #observe(chunk: ConversationStreamChunk, submissionId: string): void {
    if (this.#ended) return;
    this.#submissionId ??= submissionId;
    if (submissionId !== this.#submissionId) return;
    const prior = this.#position;
    if (prior && (chunk.position.batch < prior.batch ||
        (chunk.position.batch === prior.batch && chunk.position.index <= prior.index))) return;
    this.#position = chunk.position;

    if (chunk.type === 'conversation-reset') {
      // A read's opening snapshot is a boundary; one after the response
      // began leaves no step boundaries, and the live relay stops there too.
      if (this.#messageId === undefined) return;
      this.#follow('conversation_reset');
      this.#ended = true;
      return;
    }
    if (chunk.type === 'message-started') {
      if (chunk.submissionId !== submissionId) return;
      this.#messageId = chunk.messageId;
      this.#step = { text: '', toolCalled: false, nextCheckAt: 0 };
      return;
    }
    if (!('messageId' in chunk) || chunk.messageId !== this.#messageId) return;
    const step = this.#step;
    if (!step) return;
    if (chunk.type === 'message-delta') {
      if (chunk.kind !== 'text' || chunk.delta.length === 0) return;
      step.firstTextAt ??= this.now();
      if (step.text.length >= MAX_STEP_TEXT_CHARS) return;
      step.text += chunk.delta;
      if (releaseCheckDue(step, chunk.delta, this.#holdChars)) this.#tryRelease(step);
      return;
    }
    if (chunk.type === 'tool-input') {
      if (!step.toolCalled) {
        // Catch up on a check the cadence above skipped: the deltas came first.
        this.#tryRelease(step);
        step.toolCalled = true;
        this.#toolSteps += 1;
        const settled = streamableSlackMarkdownPrefix(step.text).length;
        PRE_TOOL_TEXT_EDGES.forEach((edge, index) => {
          if (settled >= edge) this.#preToolText[index]! += 1;
        });
      }
      const late = PRESENTATION_TOOL_NAMES.has(chunk.toolName) ? 'presentation_tool' : 'tool';
      this.#follow(toolBlock(chunk.toolName), late);
      return;
    }
    if (chunk.type === 'data-part') {
      if (chunk.name === SLACK_DISPLAY_COMPONENTS_DATA_NAME) this.#displayParts += 1;
      if (chunk.name === KEY_SETUP_TOOL_DATA_NAME) this.#keySetupParts += 1;
      const block = dataPartBlock(chunk.name, chunk.data);
      if (block) this.#follow(block);
      return;
    }
    if (chunk.type === 'message-completed' && !step.toolCalled) {
      this.#tryRelease(step);
      this.#answerSteps += 1;
      this.#finalAnswerChars = streamableSlackMarkdownPrefix(step.text).length;
    }
  }

  #tryRelease(step: Step): void {
    if (this.#state.phase !== 'holding' || step.toolCalled) return;
    const chars = answerReleasePoint(step.text, this.#holdChars);
    if (chars === undefined) return;
    const at = this.now();
    this.#state = { phase: 'released', release: { at, chars, holdMs: at - (step.firstTextAt ?? at) } };
  }

  /**
   * Something happened that a release cannot stand beside: it retires a
   * release, and a blocking condition before any release keeps the response
   * terminal. `late` names a tool that is not itself a blocking condition.
   */
  #follow(block: AnswerReleaseBlock | undefined, late?: AnswerReleaseLate): void {
    const state = this.#state;
    if (state.phase === 'released') {
      const reason = late ?? block;
      if (reason) this.#state = { phase: 'retired', release: state.release, late: reason, lateAt: this.now() };
    } else if (state.phase === 'holding' && block) {
      this.#state = { phase: 'blocked', block };
    }
  }
}

/** Whether `delta`, just added to the step's text, can have moved its settled length to the hold. */
export function releaseCheckDue(step: ReleaseStep, delta: string, holdChars: number): boolean {
  const length = step.text.length;
  if (length < holdChars / 2 || !SETTLING_DELTA.test(delta)) return false;
  if (length > EXACT_CHECK_CHARS && length < step.nextCheckAt && !delta.includes('\n')) return false;
  step.nextCheckAt = length + Math.ceil(length / 8);
  return true;
}

/** The blocking condition a tool call is, if it is one. */
export function toolBlock(toolName: string): AnswerReleaseBlock | undefined {
  if (DRAFT_REPLACING_TOOL_NAMES.has(toolName)) return 'draft_replacing_tool';
  if (isArtifactUploadTool(toolName)) return 'file_delivery';
  if (INTERACTIVE_TOOL_NAMES.has(toolName)) return 'interactive_component';
  return undefined;
}

function dataPartBlock(name: string, data: unknown): AnswerReleaseBlock | undefined {
  if (name === SLACK_AGENT_CREATION_TERMINAL_DATA_NAME) return 'agent_creation';
  if (name === FILE_DELIVERY_DATA_NAME && !isEmptyFileDeliveryResult(name, data)) return 'file_delivery';
  return undefined;
}
