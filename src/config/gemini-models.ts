import type { Model } from '@earendil-works/pi-ai';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';

/**
 * Pi 1.1 has no Gemini 4 Argon. This row copies Pi 1.4.0's. Delete it, and
 * the thinking-level rewrite in gemini-payload.ts, once Chickpea runs a Pi
 * that ships Argon.
 */
const GEMINI_4_ARGON: Model<'google-generative-ai'> = {
  id: 'gemini-4-argon',
  name: 'Gemini 4 Argon',
  api: 'google-generative-ai',
  provider: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
  input: ['text', 'image'],
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 32_768,
  inputLimits: {
    maxRequestBytes: 20_971_520,
    images: { maxPerRequest: 3_600, resize: { maxWidth: 2_000, maxHeight: 2_000, maxBytes: 4_718_592, jpegQuality: 80 } },
  },
  type: 'chat',
};

/** The only Gemini models Chickpea offers, in picker order. */
export const GEMINI_MODELS = {
  'gemini-4-argon': GEMINI_4_ARGON,
  'gemini-3.8-flash': GOOGLE_MODELS['gemini-3.8-flash'],
  'gemini-3.5-flash-lite': { ...GOOGLE_MODELS['gemini-3.5-flash-lite'], name: 'Gemini 3.5 Flash-Lite' },
} as const satisfies Record<string, Model<'google-generative-ai'>>;

export type GeminiModelId = keyof typeof GEMINI_MODELS;

export function isGeminiModelId(id: string): id is GeminiModelId {
  return Object.hasOwn(GEMINI_MODELS, id);
}
