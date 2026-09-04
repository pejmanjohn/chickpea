import type { ProviderStreams, StreamOptions } from '@earendil-works/pi-ai';
import { isRecord } from '../security/content-validation.ts';

const GPT_OSS_MODEL_ID = '@cf/openai/gpt-oss-120b';

/** Normalize only the model whose Workers AI schema rejects null content. */
export function withWorkersAiPayloadPolicy(
  modelId: string,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (modelId !== GPT_OSS_MODEL_ID || !Array.isArray(inputs.messages)) return inputs;
  let changed = false;
  const messages = inputs.messages.map((message: unknown) => {
    if (!isRecord(message) || message.role !== 'assistant' || message.content !== null) {
      return message;
    }
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
