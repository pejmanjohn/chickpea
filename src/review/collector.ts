import type { ConversationStreamChunk } from '@flue/runtime';

import type { RunReviewStep } from './record.ts';

type ConversationSnapshot = Extract<ConversationStreamChunk, { type: 'conversation-reset' }>['snapshot'];
type ConversationMessage = ConversationSnapshot['messages'][number];
type ConversationPart = ConversationMessage['parts'][number];
type ToolStep = Extract<RunReviewStep, { kind: 'tool' }>;
type CollectedStep = RunReviewStep & { messageId?: string };

// Generous enough that the record's own caps, applied after the redactor has
// seen whole text, always bind first; small enough to bound a long run's memory.
const FIELD_CHARS = 32 * 1024;
const TOTAL_CHARS = 1024 * 1024;

/**
 * One submission's steps, from the conversation stream its reply observation
 * reads: model text and reasoning, and each tool call joined to its result.
 * Every observation replays the conversation from its start, so only this
 * submission's messages count, and the trace is cut as it arrives.
 */
export class RunReviewCollector {
  readonly #messageIds = new Set<string>();
  readonly #tools = new Map<string, ToolStep>();
  #steps: CollectedStep[] = [];
  #chars = 0;
  #truncated = false;
  #position: { batch: number; index: number } | undefined;

  constructor(readonly submissionId: string) {}

  /** The steps a settled conversation's history holds, when the stream was never observed. */
  static fromHistory(snapshot: ConversationSnapshot, submissionId: string): RunReviewCollector {
    const collector = new RunReviewCollector(submissionId);
    collector.#rebuild(snapshot.messages);
    return collector;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  steps(): RunReviewStep[] {
    return this.#steps.map(({ messageId: _messageId, ...step }) => step as RunReviewStep);
  }

  ingest(chunk: ConversationStreamChunk): void {
    const prior = this.#position;
    if (prior && (chunk.position.batch < prior.batch ||
        (chunk.position.batch === prior.batch && chunk.position.index <= prior.index))) return;
    this.#position = chunk.position;
    switch (chunk.type) {
      case 'message-started':
        if (chunk.submissionId === this.submissionId) this.#messageIds.add(chunk.messageId);
        return;
      case 'message-delta':
        if (this.#messageIds.has(chunk.messageId)) this.#appendText(chunk.messageId, chunk.kind, chunk.delta);
        return;
      case 'tool-input':
        if (this.#messageIds.has(chunk.messageId)) this.#addTool(chunk.toolCallId, chunk.toolName, chunk.input);
        return;
      case 'tool-output': {
        const tool = this.#tools.get(chunk.toolCallId);
        if (tool) this.#settleTool(tool, { output: chunk.output }, chunk.durationMs);
        return;
      }
      case 'tool-output-error': {
        const tool = this.#tools.get(chunk.toolCallId);
        if (tool) this.#settleTool(tool, { error: chunk.errorText }, chunk.durationMs);
        return;
      }
      case 'message-appended':
        if (this.#owns(chunk.message) && !this.#messageIds.has(chunk.message.id)) this.#addMessage(chunk.message);
        return;
      case 'conversation-reset':
        // A folded snapshot replaces what the stream showed so far.
        this.#rebuild(chunk.snapshot.messages);
        return;
      default:
    }
  }

  #owns(message: ConversationMessage): boolean {
    return message.role === 'assistant' && message.submissionId === this.submissionId;
  }

  #rebuild(messages: readonly ConversationMessage[]): void {
    this.#messageIds.clear();
    this.#tools.clear();
    this.#steps = [];
    this.#chars = 0;
    for (const message of messages) if (this.#owns(message)) this.#addMessage(message);
  }

  #addMessage(message: ConversationMessage): void {
    this.#messageIds.add(message.id);
    for (const part of message.parts) this.#addPart(message.id, part);
  }

  #addPart(messageId: string, part: ConversationPart): void {
    if (part.type === 'text' || part.type === 'reasoning') {
      this.#push({ kind: part.type, text: this.#cap(part.text), messageId });
    } else if (part.type === 'dynamic-tool') {
      const tool = this.#addTool(part.toolCallId, part.toolName, part.input);
      if (!tool) return;
      if (part.state === 'output-available') this.#settleTool(tool, { output: part.output }, part.durationMs);
      else if (part.state === 'output-error') this.#settleTool(tool, { error: part.errorText }, part.durationMs);
    }
    // File parts carry URLs and data parts are host plumbing: neither is kept.
  }

  #appendText(messageId: string, kind: 'text' | 'reasoning', delta: string): void {
    const last = this.#steps.at(-1);
    if (last && last.kind === kind && last.messageId === messageId) {
      const text = this.#cap(last.text + delta);
      this.#count(text.length - last.text.length);
      last.text = text;
    } else {
      this.#push({ kind, text: this.#cap(delta), messageId });
    }
  }

  #addTool(toolCallId: string, name: string, input: unknown): ToolStep | undefined {
    if (this.#tools.has(toolCallId)) return undefined;
    const tool: ToolStep = { kind: 'tool', name, input: this.#cap(serialized(input)) };
    this.#tools.set(toolCallId, tool);
    this.#push(tool);
    return tool;
  }

  #settleTool(tool: ToolStep, result: { output: unknown } | { error: string }, durationMs: number | undefined): void {
    const text = this.#cap('output' in result ? serialized(result.output) : result.error);
    if ('output' in result) tool.output = text;
    else tool.error = text;
    if (durationMs !== undefined) tool.durationMs = durationMs;
    this.#count(text.length);
  }

  #push(step: CollectedStep): void {
    this.#steps.push(step);
    this.#count(stepChars(step));
  }

  /** Over the budget, the oldest steps go, as they would from the record. */
  #count(chars: number): void {
    this.#chars += chars;
    while (this.#chars > TOTAL_CHARS && this.#steps.length > 1) {
      const dropped = this.#steps.shift()!;
      this.#chars -= stepChars(dropped);
      if (dropped.kind === 'tool') {
        for (const [id, tool] of this.#tools) if (tool === dropped) this.#tools.delete(id);
      }
      this.#truncated = true;
    }
  }

  #cap(text: string): string {
    if (text.length <= FIELD_CHARS) return text;
    this.#truncated = true;
    return text.slice(0, FIELD_CHARS);
  }
}

function stepChars(step: RunReviewStep): number {
  return step.kind === 'tool'
    ? step.name.length + step.input.length + (step.output?.length ?? 0) + (step.error?.length ?? 0)
    : step.text.length;
}

function serialized(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
