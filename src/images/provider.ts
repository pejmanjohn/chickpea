import { InstallationNotAdmittedError } from '../config/installation-admission.ts';
import { installationModelAccessGrant, RuntimeModelReadinessError } from '../config/installation-model-access.ts';
import { ModelAccessError, sendImageRequest, type ModelAccessGrant } from '../config/model-access.ts';
import { ModelCredentialRevisionError } from '../config/model-credential-refs.ts';
import {
  CreditsExhaustedError,
  installationFunding,
  PlatformFundingUnavailableError,
} from '../config/platform-funding.ts';
import { describeProviderKeySources } from '../config/provider-keys.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { findImageModel, type ImageModelProfile } from '../model-catalog/image-profiles.ts';
import { openAiSubscriptionAvailable } from '../openai-subscription/availability.ts';
import { getOpenAiSubscriptionAuthorizationStatus } from '../openai-subscription/device-auth.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import { createOpenAiSubscriptionImagesClient } from '../openai-subscription/images-client.ts';
import {
  createOpenAiImagesClient,
  type ImageCallResult,
  type ImageRequestSender,
  type OpenAiImagesClient,
} from './openai-images-client.ts';
import { currentImagePrice } from './request-record.ts';

export type ImageProviderResolution =
  | { ok: true; profile: ImageModelProfile; client: OpenAiImagesClient }
  | { ok: false; reason: 'unsupported' | 'unknown-model' | 'misconfigured'; detail: string };

export interface ImageProviderOptions {
  /** Test seam; production callers take the catalog endpoint and global fetch. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Read-only readiness for one concrete profile; it never decrypts a bearer. */
export async function imageModelProfileReady(
  profile: ImageModelProfile,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<boolean> {
  if (profile.authMethod === 'subscription') {
    if (!openAiSubscriptionAvailable() || !store) return false;
    return (await getOpenAiSubscriptionAuthorizationStatus(store)).state === 'connected';
  }
  if (await installationFunding(env) === 'platform') {
    return currentImagePrice(profile.provider, profile.model, Date.now()) !== null;
  }
  return (await describeProviderKeySources(env, store))[profile.provider] !== 'missing';
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
  if (profile.authMethod === 'subscription') {
    if (!openAiSubscriptionAvailable()) {
      return { ok: false, reason: 'misconfigured', detail: 'unsupported_runtime' };
    }
    if (!store) {
      return { ok: false, reason: 'misconfigured', detail: 'subscription_not_connected' };
    }
    const status = await getOpenAiSubscriptionAuthorizationStatus(store);
    if (status.state !== 'connected') {
      return { ok: false, reason: 'misconfigured', detail: 'subscription_not_connected' };
    }
    try {
      return {
        ok: true,
        profile,
        client: createOpenAiSubscriptionImagesClient({
          profile,
          settings: store,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        }),
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'misconfigured',
        detail: err instanceof OpenAiSubscriptionError && err.code === 'unsupported_runtime'
          ? 'unsupported_runtime'
          : 'subscription_not_connected',
      };
    }
  }

  let grant: ModelAccessGrant | undefined;
  try {
    grant = await installationModelAccessGrant('openai', env, 'image-generation', store);
  } catch (err) {
    const refused = refusal(err);
    if (refused) return { ok: false, reason: 'misconfigured', detail: refused.detail };
    throw err;
  }
  if (!grant) {
    // No credential, no request: the role resolves as unset upstream and the
    // honesty instruction applies instead of a provider auth failure.
    return { ok: false, reason: 'misconfigured', detail: 'missing_api_key' };
  }
  const request = {
    grant,
    env,
    model: profile.model,
    defaultBaseUrl: options.baseUrl ?? profile.baseUrl,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const send: ImageRequestSender = async (call) => {
    try {
      return await sendImageRequest(request, call);
    } catch (err) {
      const refused = refusal(err);
      if (refused) return refused;
      throw err;
    }
  };
  return { ok: true, profile, client: createOpenAiImagesClient({ profile, send }) };
}

function refusal(err: unknown): Extract<ImageCallResult, { ok: false }> | undefined {
  if (err instanceof ModelAccessError) return { ok: false, reason: 'misconfigured', detail: err.code };
  if (err instanceof ModelCredentialRevisionError) return { ok: false, reason: 'misconfigured', detail: 'credential_changed' };
  if (err instanceof RuntimeModelReadinessError) return { ok: false, reason: 'misconfigured', detail: 'missing_api_key' };
  if (
    err instanceof CreditsExhaustedError ||
    err instanceof PlatformFundingUnavailableError ||
    err instanceof InstallationNotAdmittedError
  ) return { ok: false, reason: 'unreachable', detail: err.code };
  return undefined;
}
