import type { Model } from '@earendil-works/pi-ai';

import { OPENAI_SUBSCRIPTION_API_BASE } from '../openai-subscription/protocol.ts';
import type { CompiledModelProfileId } from './types.ts';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com';

function openAiApiModel(
  cost: Model<string>['cost'],
): Model<'openai-responses'> {
  return {
    id: 'catalog-candidate',
    name: 'Catalog candidate',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: OPENAI_API_BASE,
    reasoning: true,
    input: ['text', 'image'],
    cost,
    contextWindow: 272_000,
    maxTokens: 128_000,
    // Pi 0.80.2 has no `max` ThinkingLevel. The remaining values preserve
    // every effort level its compiled OpenAI Responses adapter can express.
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    },
  };
}

function anthropicApiModel(
  cost: Model<string>['cost'],
  supportsTemperature: boolean,
): Model<'anthropic-messages'> {
  return {
    id: 'catalog-candidate',
    name: 'Catalog candidate',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: ANTHROPIC_API_BASE,
    reasoning: true,
    input: ['text', 'image'],
    cost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
    compat: {
      forceAdaptiveThinking: true,
      ...(supportsTemperature ? {} : { supportsTemperature: false }),
    },
  };
}

function subscriptionModel(
  contextWindow = 272_000,
  input: Array<'text' | 'image'> = ['text', 'image'],
): Model<'openai-codex-responses'> {
  return {
    id: 'catalog-candidate',
    name: 'Catalog candidate',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: OPENAI_SUBSCRIPTION_API_BASE,
    reasoning: true,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 128_000,
    thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh' },
  };
}

const COMPILED_MODEL_PROFILES: Record<CompiledModelProfileId, Model<string>> = {
  'openai-platform-responses-sol-tier@1': openAiApiModel(
    { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  ),
  'openai-platform-responses-terra-tier@1': openAiApiModel(
    { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  ),
  'openai-platform-responses-luna-tier@1': openAiApiModel(
    { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  ),
  'anthropic-messages-opus-tier@1': anthropicApiModel(
    { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    false,
  ),
  'anthropic-messages-sonnet-tier@1': anthropicApiModel(
    { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    true,
  ),
  'openai-codex-responses-standard@1': subscriptionModel(),
  'openai-codex-responses-text-only@1': subscriptionModel(128_000, ['text']),
};

export function isCompiledModelProfileId(value: unknown): value is CompiledModelProfileId {
  return typeof value === 'string' && Object.hasOwn(COMPILED_MODEL_PROFILES, value);
}

export function compiledModelProfile(
  id: CompiledModelProfileId,
  candidate: { id: string; name: string },
): Model<string> {
  const model = COMPILED_MODEL_PROFILES[id];
  return { ...cloneModel(model), id: candidate.id, name: candidate.name };
}

function cloneModel(model: Model<string>): Model<string> {
  return structuredClone(model);
}
