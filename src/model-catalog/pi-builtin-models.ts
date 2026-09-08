import type { Model } from '@earendil-works/pi-ai';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { OPENAI_CODEX_MODELS } from '@earendil-works/pi-ai/providers/openai-codex.models';
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';

// Only the generated model tables for providers Chickpea can register. The
// `providers/all` catalog would also import every provider factory and its
// SDK, which alone costs the Cloudflare bundle hundreds of compressed KiB.
// The generated tables are typed per API; callers already treat the result as
// an untyped `Model<string>` (matching pi-ai's own `getBuiltinModel`).
const BUILTIN_MODELS: Record<string, Record<string, unknown>> = {
  anthropic: ANTHROPIC_MODELS,
  'cloudflare-workers-ai': CLOUDFLARE_WORKERS_AI_MODELS,
  openai: OPENAI_MODELS,
  'openai-codex': OPENAI_CODEX_MODELS,
  openrouter: OPENROUTER_MODELS,
};

export function getBuiltinModel(provider: string, modelId: string): Model<string> | undefined {
  return BUILTIN_MODELS[provider]?.[modelId] as Model<string> | undefined;
}
