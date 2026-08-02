import { setProvider } from '@flue/runtime';
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from '@flue/runtime/cloudflare/workers-ai';

import { SEED_CLOUDFLARE_MODEL_ID } from './config/seed.ts';

const SEED_CLOUDFLARE_MAX_COMPLETION_TOKENS = 2_048;
const SEED_CLOUDFLARE_RESPONSE_TIMEOUT_MS = 90_000;

/**
 * Register the Workers AI binding without routing prompts through AI Gateway.
 *
 * Importing this module is side-effect free. The Cloudflare-only entry calls
 * this helper with its ambient `env.AI` binding; the shared Node app never
 * imports it or registers a keyless `cloudflare/*` provider.
 */
export function registerCloudflareBindingProvider(binding: CloudflareAIBinding): void {
  setProvider(
    cloudflareBindingProvider({
      binding: withCloudflareModelPolicies(binding),
      // Flue otherwise supplies `{ id: 'default' }`, which creates an AI
      // Gateway whose default logs retain request and response payloads.
      gateway: false,
    }),
  );
}

function withCloudflareModelPolicies(binding: CloudflareAIBinding): CloudflareAIBinding {
  return {
    run(modelId, inputs, options) {
      if (modelId !== SEED_CLOUDFLARE_MODEL_ID) {
        return binding.run(modelId, inputs, options);
      }

      // Workers AI enables GLM thinking by default. Flue beta.8 represents
      // `thinkingLevel: 'off'` by omitting `reasoning_effort`, which therefore
      // leaves that server-side default enabled. Apply Cloudflare's explicit
      // chat-template switch at the binding boundary, remove any conflicting
      // effort value, cap each generation to the same 2,048-token ceiling as
      // the app's REST Workers AI path, and abort a provider stream that still
      // fails to settle. This policy is deliberately limited to the seeded
      // keyless model whose generations have otherwise held the shared Slack
      // relay alarm until its 15-minute platform deadline.
      const {
        reasoning_effort: _reasoningEffort,
        chat_template_kwargs,
        max_completion_tokens: requestedMaxTokens,
        ...rest
      } = inputs;
      const existingTemplateOptions = isRecord(chat_template_kwargs)
        ? chat_template_kwargs
        : {};
      const maxCompletionTokens =
        typeof requestedMaxTokens === 'number' &&
        Number.isFinite(requestedMaxTokens) &&
        requestedMaxTokens > 0
          ? Math.min(requestedMaxTokens, SEED_CLOUDFLARE_MAX_COMPLETION_TOKENS)
          : SEED_CLOUDFLARE_MAX_COMPLETION_TOKENS;
      const timeoutSignal = AbortSignal.timeout(SEED_CLOUDFLARE_RESPONSE_TIMEOUT_MS);
      const callerSignal = options?.signal;
      const signal =
        callerSignal instanceof AbortSignal
          ? AbortSignal.any([callerSignal, timeoutSignal])
          : timeoutSignal;
      return binding.run(
        modelId,
        {
          ...rest,
          max_completion_tokens: maxCompletionTokens,
          chat_template_kwargs: {
            ...existingTemplateOptions,
            enable_thinking: false,
          },
        },
        { ...options, signal },
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
