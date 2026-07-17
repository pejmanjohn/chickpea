import { ModelResolutionError } from './errors.ts';
import type { CustomAgentConfig } from './types.ts';

// Accepts `model: null` alongside the stored shape so admin PATCH previews
// (where null means "clear the pin") can be checked without re-shaping.
export type ModelResolvableAgent = Pick<CustomAgentConfig, 'id'> & {
  model?: string | null;
};

export function resolveAgentModel(
  agent: ModelResolvableAgent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (agent.model) {
    return noteResolvedModel(agent.model);
  }
  const fallbackModel = env.SLACK_TAG_MODEL;
  if (fallbackModel) {
    return noteResolvedModel(fallbackModel);
  }
  throw new ModelResolutionError(
    `No model pinned for agent ${agent.id}. Pin a model in /admin (Profiles -> Model), ` +
      'or set SLACK_TAG_MODEL for offline/dev unpinned-profile fallback.',
  );
}

// A `cloudflare/<model>` id resolves through Flue's binding-backed provider,
// which declares no context window — Flue then treats contextWindow as 0 and
// NEVER threshold-compacts (measured: DM transcripts grow linearly without
// bound; probe-dm-transcript.mjs). Warn ONCE per model id so an operator who
// runs (or pins) a non-catalog `cloudflare/*` model knows auto-compaction is
// off. The REST `cloudflare-workers-ai/*` provider declares a floor in
// src/app.ts and is unaffected, so it is deliberately not matched here.
const warnedUnboundedCloudflareModels = new Set<string>();
function noteResolvedModel(model: string): string {
  if (model.startsWith('cloudflare/') && !warnedUnboundedCloudflareModels.has(model)) {
    warnedUnboundedCloudflareModels.add(model);
    console.warn(
      `[chickpea] model ${model} resolves through the Workers AI binding with no declared ` +
        'context window (contextWindow 0): auto-compaction is disabled and long DM transcripts ' +
        'grow unbounded.',
    );
  }
  return model;
}
