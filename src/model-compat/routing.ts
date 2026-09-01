import {
  type CatalogProviderId,
} from '../model-catalog/types.ts';
import { resolveActiveCatalogRoute } from '../model-catalog/catalog.ts';

class UnsupportedBuiltinModelError extends Error {
  constructor(readonly canonicalModel: string) {
    super(`Model ${canonicalModel} is not supported by this Chickpea release.`);
    this.name = 'UnsupportedBuiltinModelError';
  }
}

export function resolveApiKeyModelSpecifier(
  canonicalModel: string,
  provider: Extract<CatalogProviderId, 'anthropic' | 'openai'>,
): string {
  if (!canonicalModel.startsWith(`${provider}/`)) {
    throw new UnsupportedBuiltinModelError(canonicalModel);
  }
  const lane = provider === 'openai' ? 'openai_api_key' : 'anthropic_api_key';
  const route = resolveActiveCatalogRoute(canonicalModel, lane);
  if (!route) throw new UnsupportedBuiltinModelError(canonicalModel);
  return route.modelSpecifier;
}
