import { registerPiProvider } from './config/pi-provider-registry.ts';
import { isRecord } from './security/content-validation.ts';
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from '@flue/runtime/cloudflare/workers-ai';

import { withWorkersAiPayloadPolicy } from './config/workers-ai-payload.ts';
import {
  isWorkersAiGlmModel,
  withCurrentWorkersAiModels,
} from './config/workers-ai-models.ts';
import { decorateAttachmentProvider } from './slack/attachment-model-context.ts';

const SEED_CLOUDFLARE_MAX_COMPLETION_TOKENS = 2_048;
const SEED_CLOUDFLARE_RESPONSE_TIMEOUT_MS = 90_000;
const GPT_OSS_MODEL_ID = '@cf/openai/gpt-oss-120b';
const GPT_OSS_DEFAULT_MAX_TOKENS = 8_192;

/**
 * Register the Workers AI binding without routing prompts through AI Gateway.
 *
 * Importing this module is side-effect free. The Cloudflare-only entry calls
 * this helper with its ambient `env.AI` binding; the shared Node app never
 * imports it or registers a keyless `cloudflare/*` provider.
 */
export function registerCloudflareBindingProvider(binding: CloudflareAIBinding): void {
  registerPiProvider(createCloudflareBindingProvider(binding));
}

/** Pure provider seam used to apply the same attachment policy as Pi APIs. */
export function createCloudflareBindingProvider(binding: CloudflareAIBinding) {
  const provider = cloudflareBindingProvider(cloudflareBindingProviderOptions(binding));
  const models = withCurrentWorkersAiModels(provider.getModels());
  return decorateAttachmentProvider({ ...provider, getModels: () => models });
}

/** Pure construction seam: keeps gateway privacy and payload policy testable. */
export function cloudflareBindingProviderOptions(
  binding: CloudflareAIBinding,
): { binding: CloudflareAIBinding; gateway: false } {
  return {
    binding: withCloudflareModelPolicies(binding),
      // Flue otherwise supplies `{ id: 'default' }`, which creates an AI
      // Gateway whose default logs retain request and response payloads.
    gateway: false,
  };
}

function withCloudflareModelPolicies(binding: CloudflareAIBinding): CloudflareAIBinding {
  return {
    run(modelId, inputs, options) {
      const wireInputs = withWorkersAiPayloadPolicy(modelId, inputs);
      if (modelId === GPT_OSS_MODEL_ID) {
        // Flue's binding streamSimple does not supply the model's output limit.
        // Workers AI otherwise defaults to 256 tokens, which GPT-OSS can spend
        // entirely on thinking. Use its documented max_tokens field, translating
        // Flue's explicit limit when present, without changing reasoning settings.
        const { max_completion_tokens, max_tokens, ...rest } = wireInputs;
        return binding.run(modelId, {
          ...rest,
          max_tokens: max_tokens ?? max_completion_tokens ?? GPT_OSS_DEFAULT_MAX_TOKENS,
        }, options);
      }
      if (!isWorkersAiGlmModel(modelId)) {
        return binding.run(modelId, wireInputs, options);
      }

      // Workers AI enables GLM thinking by default. The Pi provider represents
      // `thinkingLevel: 'off'` by omitting `reasoning_effort`, which therefore
      // leaves that server-side default enabled. Apply Cloudflare's explicit
      // chat-template switch at the binding boundary, remove any conflicting
      // effort value, cap each generation to the same 2,048-token ceiling as
      // the app's REST Workers AI path, and abort a provider stream that still
      // fails to settle. This policy is deliberately limited to the GLM
      // family Chickpea seeds and curates. glm-5.2 has otherwise held the
      // shared Slack relay alarm until its 15-minute platform deadline.
      const {
        reasoning_effort: _reasoningEffort,
        chat_template_kwargs,
        max_completion_tokens: requestedMaxTokens,
        ...rest
      } = wireInputs;
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
