import {
  type CatalogProviderId,
} from '../model-catalog/types.ts';
import { resolveActiveCatalogRoute } from '../model-catalog/catalog.ts';
import type { PlatformEnv } from '../config/state-backend.ts';

class UnsupportedBuiltinModelError extends Error {
  constructor(readonly canonicalModel: string) {
    super(`Model ${canonicalModel} is not supported by this Chickpea release.`);
    this.name = 'UnsupportedBuiltinModelError';
  }
}

/** The model specifier for an API-key model in `env`'s installation's active catalog. */
export function resolveApiKeyModelSpecifier(
  canonicalModel: string,
  provider: Extract<CatalogProviderId, 'anthropic' | 'openai'>,
  env?: PlatformEnv,
): string {
  if (!canonicalModel.startsWith(`${provider}/`)) {
    throw new UnsupportedBuiltinModelError(canonicalModel);
  }
  const lane = provider === 'openai' ? 'openai_api_key' : 'anthropic_api_key';
  const route = resolveActiveCatalogRoute(canonicalModel, lane, env);
  if (!route) throw new UnsupportedBuiltinModelError(canonicalModel);
  return route.modelSpecifier;
}
