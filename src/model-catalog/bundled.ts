import type { Model } from '@earendil-works/pi-ai';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';

import { compiledModelProfile } from './profiles.ts';
import type {
  CatalogProviderId,
  ModelAuthLane,
  ModelCatalogEntry,
} from './types.ts';

export const BUNDLED_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  openAiEntry('gpt-5.6-sol', 'GPT-5.6 Sol', 'openai-platform-responses-sol-tier@1'),
  openAiEntry('gpt-5.6-terra', 'GPT-5.6 Terra', 'openai-platform-responses-terra-tier@1'),
  openAiEntry('gpt-5.6-luna', 'GPT-5.6 Luna', 'openai-platform-responses-luna-tier@1'),
  subscriptionOnlyEntry('gpt-5.5', 'GPT-5.5'),
  subscriptionOnlyEntry('gpt-5.4', 'GPT-5.4'),
  subscriptionOnlyEntry('gpt-5.4-mini', 'GPT-5.4 mini'),
  subscriptionOnlyEntry(
    'gpt-5.3-codex-spark',
    'GPT-5.3 Codex Spark',
    true,
  ),
  {
    id: 'anthropic/claude-opus-5',
    displayName: 'Claude Opus 5',
    lanes: { anthropic_api_key: 'anthropic-messages-opus-tier@1' },
  },
  {
    id: 'anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    lanes: { anthropic_api_key: 'anthropic-messages-sonnet-tier@1' },
  },
];

const CATALOG_BY_ID = new Map(BUNDLED_MODEL_CATALOG.map((entry) => [entry.id, entry]));

export function listBundledCatalogModels(lane: ModelAuthLane): Model<string>[] {
  return BUNDLED_MODEL_CATALOG.flatMap((entry) => {
    const model = catalogModelForLane(entry.id, lane, { nativeFirst: false });
    return model ? [model] : [];
  });
}

export function catalogModelForLane(
  canonicalModel: string,
  lane: ModelAuthLane,
  options: { nativeFirst?: boolean } = {},
): Model<string> | undefined {
  if (options.nativeFirst !== false && isPiNativeModel(canonicalModel)) {
    return undefined;
  }
  const entry = CATALOG_BY_ID.get(canonicalModel as ModelCatalogEntry['id']);
  if (!entry || !entry.lanes[lane]) return undefined;
  return materializeCatalogModel(entry, lane);
}

export function materializeCatalogModel(
  entry: ModelCatalogEntry,
  lane: ModelAuthLane,
): Model<string> {
  const profileId = entry.lanes[lane];
  if (!profileId) {
    throw new Error(`Catalog model ${entry.id} has no compiled profile for ${lane}.`);
  }
  const { provider, modelId } = splitCanonicalModel(entry.id);
  const model = compiledModelProfile(profileId, {
    id: modelId,
    name: entry.displayName ?? modelId,
  });
  const expectedProvider = providerForLane(lane);
  if (provider !== canonicalProviderForLane(lane) || model.provider !== expectedProvider || model.id !== modelId) {
    throw new Error(`Catalog model ${entry.id} does not match compiled profile ${profileId}.`);
  }

  const contextWindow = shrinkOnlyLimit(
    entry.contextWindow,
    model.contextWindow,
    'contextWindow',
  );
  const maxTokens = shrinkOnlyLimit(entry.maxTokens, model.maxTokens, 'maxTokens');
  if (maxTokens > contextWindow) {
    throw new Error(`Catalog model ${entry.id} maxTokens cannot exceed contextWindow.`);
  }
  return {
    ...model,
    ...(entry.displayName ? { name: entry.displayName } : {}),
    contextWindow,
    maxTokens,
  };
}

export function isPiNativeModel(canonicalModel: string): boolean {
  const parsed = trySplitCanonicalModel(canonicalModel);
  if (!parsed) return false;
  const readBuiltin = getBuiltinModel as unknown as (
    provider: string,
    modelId: string,
  ) => Model<string> | undefined;
  return readBuiltin(parsed.provider, parsed.modelId) !== undefined;
}

function openAiEntry(
  modelId: 'gpt-5.6-luna' | 'gpt-5.6-sol' | 'gpt-5.6-terra',
  displayName: string,
  apiProfile:
    | 'openai-platform-responses-luna-tier@1'
    | 'openai-platform-responses-sol-tier@1'
    | 'openai-platform-responses-terra-tier@1',
): ModelCatalogEntry {
  return {
    id: `openai/${modelId}`,
    displayName,
    lanes: {
      openai_api_key: apiProfile,
      openai_subscription: 'openai-codex-responses-standard@1',
    },
  };
}

function subscriptionOnlyEntry(
  modelId: 'gpt-5.3-codex-spark' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.5',
  displayName: string,
  textOnly = false,
): ModelCatalogEntry {
  return {
    id: `openai/${modelId}`,
    displayName,
    lanes: {
      openai_subscription: textOnly
        ? 'openai-codex-responses-text-only@1'
        : 'openai-codex-responses-standard@1',
    },
  };
}

function providerForLane(lane: ModelAuthLane): string {
  if (lane === 'openai_subscription') return 'openai-codex';
  return canonicalProviderForLane(lane);
}

function canonicalProviderForLane(lane: ModelAuthLane): CatalogProviderId {
  return lane === 'anthropic_api_key' ? 'anthropic' : 'openai';
}

function shrinkOnlyLimit(
  candidate: number | undefined,
  ceiling: number,
  field: 'contextWindow' | 'maxTokens',
): number {
  if (candidate === undefined) return ceiling;
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new Error(`Catalog ${field} must be a positive integer.`);
  }
  if (candidate > ceiling) {
    throw new Error(`Catalog ${field} cannot exceed compiled profile ceiling.`);
  }
  return candidate;
}

function splitCanonicalModel(canonicalModel: string): {
  provider: CatalogProviderId;
  modelId: string;
} {
  const parsed = trySplitCanonicalModel(canonicalModel);
  if (!parsed) throw new Error(`Invalid catalog model id: ${canonicalModel}.`);
  return parsed;
}

function trySplitCanonicalModel(canonicalModel: string): {
  provider: CatalogProviderId;
  modelId: string;
} | undefined {
  const match = canonicalModel.match(/^(openai|anthropic)\/([a-z0-9][a-z0-9._-]{0,127})$/);
  if (!match) return undefined;
  return { provider: match[1] as CatalogProviderId, modelId: match[2] as string };
}
