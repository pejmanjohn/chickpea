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
  let changed = false;
  const messages = context.messages.map((message, index) => {
    if (message.role !== 'assistant' || message.stopReason !== 'aborted') return message;
    // Flue's shape exactly: its two recovery signals directly follow the
    // partial. Any other aborted step is left for pi-ai to drop, as before.
    if (!isRecoverySignal(context.messages[index + 1], 'stream_interrupted') ||
        !isRecoverySignal(context.messages[index + 2], 'stream_continued')) return message;
    const restored = continuablePartial(message);
    if (!restored) return message;
    changed = true;
    return restored;
  });
  return changed ? { ...context, messages } : context;
}

/** Flue renders a signal into model context as `<signal type="...">` user text. */
function isRecoverySignal(message: Context['messages'][number] | undefined, type: string): boolean {
  if (message?.role !== 'user') return false;
  const first = typeof message.content === 'string' ? message.content : message.content[0];
  const text = typeof first === 'string' ? first : first?.type === 'text' ? first.text : undefined;
  return text?.startsWith(`<signal type="${type}">`) ?? false;
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
    provider.stream(model, restoreInterruptedStreamPartials(context), options);
  const streamSimple: Provider['streamSimple'] = (model, context, options) =>
    provider.streamSimple(model, restoreInterruptedStreamPartials(context), options);
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'stream') return stream;
      if (property === 'streamSimple') return streamSimple;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
