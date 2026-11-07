import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type ProviderStreams,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { isRecord } from '../security/content-validation.ts';

/**
 * Asks Google not to keep the request in the project's request logs, which
 * new projects turn on by default. Google documents the top-level `store`
 * field, and generateContent accepted `store: false` live on 2026-11-07.
 */
export const GEMINI_STORE_OPT_OUT = true;

export function decorateGeminiPayloadStreams(streams: ProviderStreams): ProviderStreams {
  return {
    // A level set on `stream` already reaches Google as `thinkingLevel`.
    stream: (model, context, options) =>
      streams.stream(model, context, payloadOptions(options, undefined)),
    // Pi has turned the effort into a token budget by `onPayload`, so it is read here.
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, payloadOptions(options, options?.reasoning)),
  };
}

function payloadOptions(options: StreamOptions | undefined, effort: ModelThinkingLevel | undefined): StreamOptions {
  const existingHook = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const transformed = await existingHook?.(payload, model);
      const composed = transformed === undefined ? payload : transformed;
      return isRecord(composed)
        ? withGeminiPayloadPolicy(composed, model, effort, { storeOptOut: GEMINI_STORE_OPT_OUT })
        : composed;
    },
  };
}

/**
 * Pi 1.1 sends `thinkingLevel` only to the Gemini ids it knows. Every other
 * id, Gemini 4 Argon among them, gets a token budget: -1 at every effort and
 * 0 for off. Such a budget becomes the level Pi sends the ids it knows.
 */
export function withGeminiPayloadPolicy(
  payload: Record<string, unknown>,
  model: Model<Api>,
  effort: ModelThinkingLevel | undefined,
  policy: { storeOptOut: boolean },
): Record<string, unknown> {
  const config = isRecord(payload.config) ? payload.config : {};
  const thinking = config.thinkingConfig;
  let next = config;
  if (isRecord(thinking) && thinking.thinkingBudget !== undefined) {
    const level = googleThinkingLevel(model, effort);
    if (level) {
      const { thinkingBudget: _budget, ...kept } = thinking;
      next = { ...next, thinkingConfig: { ...kept, thinkingLevel: level } };
    }
  }
  if (policy.storeOptOut) {
    const httpOptions = isRecord(next.httpOptions) ? next.httpOptions : {};
    const extraBody = isRecord(httpOptions.extraBody) ? httpOptions.extraBody : {};
    next = { ...next, httpOptions: { ...httpOptions, extraBody: { ...extraBody, store: false } } };
  }
  return next === config ? payload : { ...payload, config: next };
}

/** Off moves up to the model's lowest level, as Pi does for the Gemini ids it knows. */
function googleThinkingLevel(model: Model<Api>, effort: ModelThinkingLevel | undefined): string | undefined {
  const level = clampThinkingLevel(model, effort ?? 'off');
  if (level === 'off') return undefined;
  const mapped = model.thinkingLevelMap?.[level];
  return (typeof mapped === 'string' ? mapped : level).toUpperCase();
}
