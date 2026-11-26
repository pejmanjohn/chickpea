import type { ProviderStreams, StreamOptions } from '@earendil-works/pi-ai';
import { isRecord } from '../security/content-validation.ts';

/**
 * Asks Google not to keep the request in the project's request logs, which
 * new projects turn on by default. Google documents the top-level `store`
 * field, and generateContent accepted `store: false` live on 2026-11-07.
 */
export const GEMINI_STORE_OPT_OUT = true;

export function decorateGeminiPayloadStreams(streams: ProviderStreams): ProviderStreams {
  return {
    stream: (model, context, options) => streams.stream(model, context, payloadOptions(options)),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, payloadOptions(options)),
  };
}

function payloadOptions(options: StreamOptions | undefined): StreamOptions {
  const existingHook = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const transformed = await existingHook?.(payload, model);
      const composed = transformed === undefined ? payload : transformed;
      return isRecord(composed)
        ? withGeminiPayloadPolicy(composed, { storeOptOut: GEMINI_STORE_OPT_OUT })
        : composed;
    },
  };
}

export function withGeminiPayloadPolicy(
  payload: Record<string, unknown>,
  policy: { storeOptOut: boolean },
): Record<string, unknown> {
  if (!policy.storeOptOut) return payload;
  const config = isRecord(payload.config) ? payload.config : {};
  const httpOptions = isRecord(config.httpOptions) ? config.httpOptions : {};
  const extraBody = isRecord(httpOptions.extraBody) ? httpOptions.extraBody : {};
  return { ...payload, config: { ...config, httpOptions: { ...httpOptions, extraBody: { ...extraBody, store: false } } } };
}
