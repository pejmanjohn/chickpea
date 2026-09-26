import type { AssistantMessage, Context, Provider } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

// Flue's provider registry has no public getter. Every app-owned Pi provider
// registers through this seam so stateless callers (the Slack interaction
// classifier) can stream against the same provider object Flue dispatches
// with, instead of importing pi-ai's compat surface — which drags every
// built-in provider SDK into the Cloudflare bundle.
const registered = new Map<string, Provider>();

export function registerPiProvider(provider: Provider): void {
  const continuing = withInterruptedStreamContinuation(provider);
  registered.set(provider.id, continuing);
  setProvider(continuing);
}

export function registeredPiProvider(id: string): Provider | undefined {
  return registered.get(id);
}

/**
 * When a code update (or any other reset) interrupts a model stream, Flue's
 * recovery keeps the streamed text as an `aborted` assistant entry and asks
 * the model to "continue from the durable partial". Flue's context builder
 * passes an aborted step to the provider in exactly that case and leaves out
 * every other aborted or errored step. pi-ai, however, drops every aborted
 * assistant message when it builds a request, so the model never sees the
 * partial and writes the whole answer again: minutes of regeneration after a
 * redeploy, and a final that differs from the text already streamed to Slack.
 *
 * This hands the model its partial as the text it is, so it continues. Only a
 * text partial without tool calls, directly followed by Flue's two recovery
 * signals, qualifies (the only kind Flue continues). Its reasoning is left
 * out, because a provider rejects reasoning replayed without the item that
 * followed it, and so is the provider item id in its signature, which names
 * an item the provider never completed (its phase is kept). Flue's records are
 * never changed: this is a per-request copy.
 */
export function restoreInterruptedStreamPartials(context: Context): Context {
  return inspectInterruptedStreamPartials(context).context;
}

/** Why a request carrying Flue's recovery shape did not get its partial restored. */
export type PartialRestoreMissReason =
  | 'no_aborted_step'
  | 'signals_missing'
  | 'signals_out_of_order'
  | 'gate_mismatch'
  | 'contains_tool_call'
  | 'no_text';

/** Content-free account of one request's recovery shape. */
export interface PartialRestoreReport {
  restored: boolean;
  reason?: PartialRestoreMissReason;
  messages: number;
  assistantMessages: number;
  abortedMessages: number;
  userSignals: number;
}

/**
 * The per-request copy plus a report, or no report when the request carries
 * neither an aborted step nor a recovery signal (every ordinary request).
 */
export function inspectInterruptedStreamPartials(
  context: Context,
): { context: Context; report?: PartialRestoreReport } {
  const source = context.messages;
  let restoredAny = false;
  let reason: PartialRestoreMissReason | undefined;
  let assistantMessages = 0;
  let abortedMessages = 0;
  let userSignals = 0;
  const messages = source.map((message, index) => {
    if (recoverySignalType(message)) userSignals += 1;
    if (message.role !== 'assistant') return message;
    assistantMessages += 1;
    if (message.stopReason !== 'aborted') return message;
    abortedMessages += 1;
    // Flue's shape exactly: its two recovery signals directly follow the
    // partial. Any other aborted step is left for pi-ai to drop, as before.
    const next = recoverySignalType(source[index + 1]);
    const afterNext = recoverySignalType(source[index + 2]);
    if (next !== 'stream_interrupted' || afterNext !== 'stream_continued') {
      reason = next === 'stream_continued' || (next === 'stream_interrupted' && afterNext !== undefined)
        ? 'signals_out_of_order'
        : 'signals_missing';
      return message;
    }
    if (message.content.some((block) => block.type === 'toolCall')) {
      reason = 'contains_tool_call';
      return message;
    }
    const restored = continuablePartial(message);
    if (!restored) {
      reason = 'no_text';
      return message;
    }
    restoredAny = true;
    return restored;
  });
  if (abortedMessages === 0 && userSignals === 0) return { context };
  if (!restoredAny && reason === undefined) {
    // Signals, but no aborted step anywhere: gate_mismatch when an assistant
    // step directly precedes them (Flue continues it, but it is not marked
    // aborted), no_aborted_step when nothing does.
    reason = source.some((message, index) =>
      message.role === 'assistant' && recoverySignalType(source[index + 1]) === 'stream_interrupted')
      ? 'gate_mismatch'
      : 'no_aborted_step';
  }
  const report: PartialRestoreReport = {
    restored: restoredAny,
    ...(!restoredAny && reason ? { reason } : {}),
    messages: source.length,
    assistantMessages,
    abortedMessages,
    userSignals,
  };
  return {
    context: restoredAny ? { ...context, messages: withContinuationInstruction(messages) } : context,
    report,
  };
}

/**
 * Flue's own instruction ("Continue from the durable partial assistant
 * response.") lets a model start the answer over, or re-open the section it
 * was in. When the partial is restored, the request's copy of that signal
 * says what continuing means. Appended to the last message (not the system
 * prompt) so the cached prefix is unchanged.
 */
export const CONTINUATION_INSTRUCTION =
  'Your previous message above was cut off and is already shown to the user. ' +
  'Continue it from exactly where it stops, even mid-word or mid-sentence. ' +
  'Do not repeat, restate, or re-open any of it, including its last heading.';

function withContinuationInstruction(messages: Context['messages']): Context['messages'] {
  const index = messages.findLastIndex((message) => recoverySignalType(message) === 'stream_continued');
  if (index < 0 || index !== messages.length - 1) return messages;
  const signal = messages[index]!;
  if (signal.role !== 'user') return messages;
  const content = typeof signal.content === 'string'
    ? [{ type: 'text' as const, text: signal.content }]
    : signal.content;
  const copy = [...messages];
  copy[index] = { ...signal, content: [...content, { type: 'text', text: CONTINUATION_INSTRUCTION }] };
  return copy;
}

/** Flue renders a signal into model context as `<signal type="...">` user text. */
function recoverySignalType(
  message: Context['messages'][number] | undefined,
): 'stream_interrupted' | 'stream_continued' | undefined {
  if (message?.role !== 'user') return undefined;
  const first = typeof message.content === 'string' ? message.content : message.content[0];
  const text = typeof first === 'string' ? first : first?.type === 'text' ? first.text : undefined;
  if (text?.startsWith('<signal type="stream_interrupted">')) return 'stream_interrupted';
  if (text?.startsWith('<signal type="stream_continued">')) return 'stream_continued';
  return undefined;
}

function continuablePartial(message: AssistantMessage): AssistantMessage | undefined {
  if (message.content.some((block) => block.type === 'toolCall')) return undefined;
  const text = message.content.flatMap((block) =>
    block.type === 'text' && block.text.length > 0
      ? [{ type: 'text' as const, text: block.text, ...phaseOnlySignature(block.textSignature) }]
      : []);
  if (text.length === 0) return undefined;
  const { errorMessage: _errorMessage, ...rest } = message;
  return { ...rest, content: text, stopReason: 'stop' };
}

/**
 * The OpenAI Responses text signature names the provider's output item (never
 * completed here) and its phase (commentary or final answer). Keep the phase
 * only: pi-ai then gives the item its own local id.
 */
function phaseOnlySignature(signature: string | undefined): { textSignature?: string } {
  if (!signature?.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown };
    if (parsed.v !== 1 || (parsed.phase !== 'commentary' && parsed.phase !== 'final_answer')) return {};
    return { textSignature: JSON.stringify({ v: 1, id: '', phase: parsed.phase }) };
  } catch {
    return {};
  }
}

function withInterruptedStreamContinuation(provider: Provider): Provider {
  // A proxy, not a copy: a provider may be a class instance whose other
  // members rely on their own `this`.
  const stream: Provider['stream'] = (model, context, options) =>
    provider.stream(model, restoreForRequest(model, context), options);
  const streamSimple: Provider['streamSimple'] = (model, context, options) =>
    provider.streamSimple(model, restoreForRequest(model, context), options);
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'stream') return stream;
      if (property === 'streamSimple') return streamSimple;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function restoreForRequest(model: { provider: string; api: string }, context: Context): Context {
  const { context: sent, report } = inspectInterruptedStreamPartials(context);
  if (report) logPartialRestore(model, report);
  return sent;
}

/** Content-free: whether the interrupted partial reached this provider request, and why not. */
function logPartialRestore(model: { provider: string; api: string }, report: PartialRestoreReport): void {
  try {
    console.info('[chickpea] partial restore', { provider: model.provider, api: model.api, ...report });
  } catch {
    // Diagnostics never change the request.
  }
}
