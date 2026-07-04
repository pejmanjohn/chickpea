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
    return agent.model;
  }
  if (env.ANTHROPIC_API_KEY) {
    return withProviderPrefix('anthropic', agent.defaultModels.claude);
  }
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    return withProviderPrefix('cloudflare-workers-ai', agent.defaultModels['workers-ai']);
  }
  const fallbackModel = env.SLACK_FLUE_MODEL;
  if (fallbackModel) {
    return fallbackModel;
  }
  throw new Error(
    `No model configured for agent ${agent.id}. Set agent.model, ANTHROPIC_API_KEY, ` +
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or SLACK_FLUE_MODEL.',
  );
}

function withProviderPrefix(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
