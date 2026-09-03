import { setProvider } from '@flue/runtime';
import { isRecord } from './security/content-validation.ts';
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from '@flue/runtime/cloudflare/workers-ai';

import { SEED_CLOUDFLARE_MODEL_ID } from './config/seed.ts';
import {
  CURRENT_WORKERS_AI_MODEL_ID,
  withCurrentWorkersAiModels,
} from './config/workers-ai-models.ts';
import { decorateAttachmentProvider } from './slack/attachment-model-context.ts';

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
  setProvider(createCloudflareBindingProvider(binding));
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
      if (modelId === '@cf/openai/gpt-oss-120b') {
        return binding.run(modelId, withNonNullAssistantContent(inputs), options);
      }
      if (
        modelId !== SEED_CLOUDFLARE_MODEL_ID &&
        modelId !== CURRENT_WORKERS_AI_MODEL_ID
      ) {
        return binding.run(modelId, inputs, options);
      }

      // Workers AI enables GLM thinking by default. The Pi provider represents
      // `thinkingLevel: 'off'` by omitting `reasoning_effort`, which therefore
      // leaves that server-side default enabled. Apply Cloudflare's explicit
      // chat-template switch at the binding boundary, remove any conflicting
      // effort value, cap each generation to the same 2,048-token ceiling as
      // the app's REST Workers AI path, and abort a provider stream that still
      // fails to settle. This policy is deliberately limited to the seeded
      // GLM model and its reviewed successor. The former has otherwise held
      // the shared Slack relay alarm until its 15-minute platform deadline.
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

function withNonNullAssistantContent(inputs: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(inputs.messages)) return inputs;
  let changed = false;
  const messages = inputs.messages.map((message: unknown) => {
    if (!isRecord(message) || message.role !== 'assistant' || message.content !== null) {
      return message;
    }
    // Pi replays tool-call-only assistant messages with null content. GPT-OSS's
    // Workers AI schema requires a string or text-parts array, so its next model
    // turn otherwise fails after the tool has already succeeded. Preserve every
    // other field and never mutate the shared conversation.
    // https://github.com/cloudflare/cloudflare-os/issues/54
    changed = true;
    return { ...message, content: '' };
  });
  return changed ? { ...inputs, messages } : inputs;
}
