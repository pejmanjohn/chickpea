import {
  catalogModelForLane,
  listActiveCatalogModels,
} from '../model-catalog/index.ts';
import { OPENAI_SUBSCRIPTION_MODELS } from './protocol.ts';

export interface OpenAiSubscriptionModelCatalogEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: Array<'text' | 'image'>;
}

export const BUNDLED_OPENAI_SUBSCRIPTION_MODELS: readonly OpenAiSubscriptionModelCatalogEntry[] =
  OPENAI_SUBSCRIPTION_MODELS.map((id) => {
    const model = catalogModelForLane(`openai/${id}`, 'openai_subscription', {
      nativeFirst: false,
    });
    if (!model) throw new Error(`Missing compiled subscription profile for ${id}.`);
    return {
      id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
    };
  });

export function listOpenAiSubscriptionModels(): OpenAiSubscriptionModelCatalogEntry[] {
  return listActiveCatalogModels('openai_subscription').map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
  }));
}
