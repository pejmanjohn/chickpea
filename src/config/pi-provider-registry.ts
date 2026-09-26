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
 * text partial without tool calls qualifies (the only kind Flue continues).
 * Its reasoning is left out, because a provider rejects reasoning replayed
 * without the item that followed it, and so is the text's provider
 * signature, which names an item the provider never completed. Flue's records
 * are never changed: this is a per-request copy.
 */
export function restoreInterruptedStreamPartials(context: Context): Context {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== 'assistant' || message.stopReason !== 'aborted') return message;
    const restored = continuablePartial(message);
    if (!restored) return message;
    changed = true;
    return restored;
  });
  return changed ? { ...context, messages } : context;
}

function continuablePartial(message: AssistantMessage): AssistantMessage | undefined {
  if (message.content.some((block) => block.type === 'toolCall')) return undefined;
  const text = message.content.flatMap((block) =>
    block.type === 'text' && block.text.length > 0 ? [{ type: 'text' as const, text: block.text }] : []);
  if (text.length === 0) return undefined;
  const { errorMessage: _errorMessage, ...rest } = message;
  return { ...rest, content: text, stopReason: 'stop' };
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
