import type { Model } from '@earendil-works/pi-ai';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';

/** The only Gemini models Chickpea offers, in picker order. */
export const GEMINI_MODELS = {
  'gemini-4-argon': GOOGLE_MODELS['gemini-4-argon'],
  'gemini-3.8-flash': GOOGLE_MODELS['gemini-3.8-flash'],
  'gemini-3.5-flash-lite': { ...GOOGLE_MODELS['gemini-3.5-flash-lite'], name: 'Gemini 3.5 Flash-Lite' },
} as const satisfies Record<string, Model<'google-generative-ai'>>;

export type GeminiModelId = keyof typeof GEMINI_MODELS;

export function isGeminiModelId(id: string): id is GeminiModelId {
  return Object.hasOwn(GEMINI_MODELS, id);
}
