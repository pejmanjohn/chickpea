import type { ProviderStreams, StreamOptions } from '@earendil-works/pi-ai';
import { isRecord } from '../security/content-validation.ts';

const GPT_OSS_MODEL_ID = '@cf/openai/gpt-oss-120b';

/** Normalize GPT-OSS message content to its consistent text-only wire schema. */
export function withWorkersAiPayloadPolicy(
  modelId: string,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (modelId !== GPT_OSS_MODEL_ID || !Array.isArray(inputs.messages)) return inputs;
  let changed = false;
  const messages = inputs.messages.map((message: unknown) => {
    if (!isRecord(message)) return message;
    if (Array.isArray(message.content) && message.content.every((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' &&
      Object.keys(part).every((key) => key === 'type' || key === 'text')
    )) {
      // Pi preserves user text blocks as arrays while serializing system,
      // assistant, and tool messages as strings. GPT-OSS rejects that mixed
      // request shape. Retain every text block in order without dropping any
      // non-text content or altering the shared model context.
      changed = true;
      return { ...message, content: message.content.map((part) => part.text).join('\n') };
    }
    if (message.role !== 'assistant' || message.content !== null) return message;
    // Pi replays tool-call-only assistant messages with null content. GPT-OSS's
    // Workers AI schema requires a string or text-parts array, so its next model
    // turn otherwise fails after the tool has already succeeded. Preserve every
    // other field and never mutate the shared conversation or caller payload.
    // https://github.com/cloudflare/cloudflare-os/issues/54
    changed = true;
    return { ...message, content: '' };
  });
  return changed ? { ...inputs, messages } : inputs;
}

/** Apply the same wire policy after Pi serialization on the REST path. */
export function decorateWorkersAiPayloadStreams(streams: ProviderStreams): ProviderStreams {
  return {
    stream: (model, context, options) =>
      streams.stream(model, context, payloadOptions(model.id, options)),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, payloadOptions(model.id, options)),
  };
}

function payloadOptions(modelId: string, options?: StreamOptions): StreamOptions | undefined {
  if (modelId !== GPT_OSS_MODEL_ID) return options;
  const existingHook = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const transformed = await existingHook?.(payload, model);
      const composed = transformed === undefined ? payload : transformed;
      return isRecord(composed) ? withWorkersAiPayloadPolicy(modelId, composed) : composed;
    },
  };
}
