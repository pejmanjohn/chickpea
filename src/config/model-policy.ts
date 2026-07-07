import { ModelResolutionError } from './errors.ts';
import { isCloudflareTarget } from './runtime-target.ts';
import type { CustomAgentConfig } from './types.ts';

// Accepts `model: null` alongside the stored shape so admin PATCH previews
// (where null means "clear the pin") can be checked without re-shaping.
export type ModelResolvableAgent = Pick<CustomAgentConfig, 'id' | 'defaultModels'> & {
  model?: string | null;
};

export function resolveAgentModel(
  agent: ModelResolvableAgent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (agent.model) {
    return noteResolvedModel(agent.model);
  }
  if (env.ANTHROPIC_API_KEY) {
    return noteResolvedModel(withProviderPrefix('anthropic', agent.defaultModels.claude));
  }
  // The stored workers-ai default is target-neutral (a bare `@cf/...` model
  // id); the provider prefix is decided HERE, at resolution time. On the
  // Cloudflare target it resolves via Flue's binding-backed `cloudflare`
  // provider, which needs no credentials at all — this is what makes a
  // keyless button deploy able to run a turn. On node the same default needs
  // the REST provider (`cloudflare-workers-ai`, registered in src/app.ts) and
  // its API token/account pair.
  if (isCloudflareTarget()) {
    // SLACK_TAG_MODEL is an explicit operator override, so it wins over the
    // keyless binding default (an operator who pins a model means it). Placed
    // ONLY inside the CF branch so node's ordering is untouched — there
    // CLOUDFLARE creds still outrank the SLACK_TAG_MODEL fallback below.
    // Unset → the keyless glm-5.2 binding default, unchanged.
    if (env.SLACK_TAG_MODEL) {
      return noteResolvedModel(env.SLACK_TAG_MODEL);
    }
    return noteResolvedModel(withProviderPrefix('cloudflare', agent.defaultModels['workers-ai']));
  }
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    return noteResolvedModel(
      withProviderPrefix('cloudflare-workers-ai', agent.defaultModels['workers-ai']),
    );
  }
  const fallbackModel = env.SLACK_TAG_MODEL;
  if (fallbackModel) {
    return noteResolvedModel(fallbackModel);
  }
  throw new ModelResolutionError(
    `No model configured for agent ${agent.id}. Set agent.model, ANTHROPIC_API_KEY, ` +
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or SLACK_TAG_MODEL.',
  );
}

function withProviderPrefix(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
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
      `[tag-team] model ${model} resolves through the Workers AI binding with no declared ` +
        'context window (contextWindow 0): auto-compaction is disabled and long DM transcripts ' +
        'grow unbounded.',
    );
  }
  return model;
}
