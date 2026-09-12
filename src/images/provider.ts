import { resolveProviderApiKey } from '../config/provider-keys.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { findImageModel, type ImageModelProfile } from '../model-catalog/image-profiles.ts';
import {
  createOpenAiImagesClient,
  OpenAiImagesConfigError,
  type OpenAiImagesClient,
} from './openai-images-client.ts';

export type ImageProviderResolution =
  | { ok: true; profile: ImageModelProfile; client: OpenAiImagesClient }
  | { ok: false; reason: 'unsupported' | 'unknown-model' | 'misconfigured'; detail: string };

export interface ImageProviderOptions {
  /** Test seam; production callers take the environment base and global fetch. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Maps a catalog image model id to a client bound to the workspace credential.
 * OpenAI is the only adapter in v1; every other provider resolves to a typed
 * `unsupported` result rather than an adapter error at call time.
 */
export async function resolveImageProvider(
  modelId: string,
  env?: PlatformEnv,
  store?: SettingsStore,
  options: ImageProviderOptions = {},
): Promise<ImageProviderResolution> {
  const providerId = modelId.split('/')[0] ?? '';
  if (providerId !== 'openai') {
    return { ok: false, reason: 'unsupported', detail: 'unsupported_image_provider' };
  }
  const profile = findImageModel(modelId);
  if (!profile) {
    return { ok: false, reason: 'unknown-model', detail: 'unknown_image_model' };
  }
  const { apiKey } = await resolveProviderApiKey('openai', env, store);
  if (!apiKey) {
    // No credential, no request: the role resolves as unset upstream and the
    // honesty instruction applies instead of a provider auth failure.
    return { ok: false, reason: 'misconfigured', detail: 'missing_api_key' };
  }
  try {
    const client = createOpenAiImagesClient({
      profile,
      apiKey,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return { ok: true, profile, client };
  } catch (err) {
    if (err instanceof OpenAiImagesConfigError) {
      return { ok: false, reason: 'misconfigured', detail: err.message };
    }
    throw err;
  }
}
