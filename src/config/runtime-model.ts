import { createHash } from 'node:crypto';

import { resolveOpenAiAuthMethod } from './openai-auth.ts';
import {
  applyResolvedProviderKey,
  isProviderKeyId,
  type ProviderKeyId,
} from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import {
  bindOpenAiSubscriptionProvider,
  isOpenAiSubscriptionProviderId,
  openAiSubscriptionModelSpecifier,
} from '../openai-subscription/provider.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import { requireOpenAiSubscriptionEnabled } from '../openai-subscription/feature.ts';
import {
  canonicalCompatibilityModel,
  isInternalCompatibilityProvider,
} from '../model-compat/provider.ts';
import { resolveApiKeyModelSpecifier } from '../model-compat/routing.ts';
import {
  activeModelCatalogSnapshot,
  loadModelCatalog,
  resolveActiveCatalogRoute,
  type ModelCatalogLoadResult,
} from '../model-catalog/index.ts';
import type { ModelCredentialAttribution } from './types.ts';
import type { RunExecutionRouteInput } from '../work/types.ts';

export type ProviderAuthRoute = 'openai_api_key' | 'openai_subscription';

export interface ResolvedRuntimeModel {
  /** Internal Flue model specifier. Never persist it as profile configuration. */
  model: string;
  /** Safe billing-lane fact for traces and product audit state. */
  providerAuthRoute?: ProviderAuthRoute;
}

export type SafeRuntimeModelRouteEvidence = Omit<
  RunExecutionRouteInput,
  'executionId' | 'recordedAt'
>;

/**
 * Resolve only the installation-owned OpenAI billing authority. This shares
 * the exact authority reader used by `resolveRuntimeModel`; it does not bind a
 * provider, touch either credential lane, or manufacture an alternate model
 * resolver.
 */
export async function resolveProviderAuthRoute(
  canonicalModel: string,
  settings: SettingsStore,
): Promise<ProviderAuthRoute | undefined> {
  if (providerPrefix(canonicalModel) !== 'openai') return undefined;
  return (await resolveOpenAiAuthMethod(settings)) === 'api_key'
    ? 'openai_api_key'
    : 'openai_subscription';
}

/** Build a secret-free immutable route projection from the active catalog. */
export function safeRuntimeModelRouteEvidence(
  canonicalModel: string,
  providerAuthRoute: ProviderAuthRoute | undefined,
  credential?: ModelCredentialAttribution,
): SafeRuntimeModelRouteEvidence {
  const lane = providerAuthRoute ?? (
    providerPrefix(canonicalModel) === 'anthropic' ? 'anthropic_api_key' : undefined
  );
  const route = lane ? resolveActiveCatalogRoute(canonicalModel, lane) : undefined;
  const snapshot = activeModelCatalogSnapshot();
  const entry = lane
    ? snapshot.entries.find((candidate) => candidate.id === canonicalModel)
    : undefined;
  const compiledProfile = lane && entry ? entry.lanes[lane] : undefined;
  return {
    ...(providerAuthRoute ? { providerAuthRoute } : {}),
    ...(route && compiledProfile
      ? {
          catalogSource: route.snapshot.source,
          catalogRevision: String(route.snapshot.revision),
          catalogDigest: /^[a-f0-9]{64}$/.test(route.snapshot.sha256)
            ? route.snapshot.sha256
            : createHash('sha256').update(route.snapshot.sha256).digest('hex'),
          compiledProfile,
        }
      : {}),
    ...(credential
      ? {
          modelCredentialRef: credential.credentialRefId,
          modelCredentialVersion: credential.version,
        }
      : {}),
  };
}

interface RuntimeModelDependencies {
  settings: SettingsStore;
  env?: PlatformEnv;
  resolveOpenAiAuthorization?: typeof resolveOpenAiAuthMethod;
  applyProviderKey?: (
    id: ProviderKeyId,
    env: PlatformEnv | undefined,
    settings: SettingsStore,
  ) => Promise<void>;
  bindSubscription?: typeof bindOpenAiSubscriptionProvider;
  requireSubscriptionEnabled?: (env?: PlatformEnv) => void;
  loadCatalog?: (settings: SettingsStore) => Promise<ModelCatalogLoadResult>;
}

/**
 * Resolve the one billing lane immediately before Flue constructs an Agent.
 * Subscription selection never reads or binds the Platform API key; any
 * subscription failure escapes directly and cannot cross lanes.
 */
export async function resolveRuntimeModel(
  _agentId: string,
  canonicalModel: string,
  dependencies: RuntimeModelDependencies,
): Promise<ResolvedRuntimeModel> {
  await (dependencies.loadCatalog ?? loadModelCatalog)(dependencies.settings);
  const providerId = providerPrefix(canonicalModel);
  if (isOpenAiSubscriptionProviderId(providerId)) {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  if (isInternalCompatibilityProvider(providerId)) {
    throw new Error('Internal model providers cannot be selected in profiles.');
  }
  if (providerId === 'anthropic') {
    const model = resolveApiKeyModelSpecifier(canonicalModel, 'anthropic');
    await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
      'anthropic',
      dependencies.env,
      dependencies.settings,
    );
    return { model };
  }
  if (providerId !== 'openai') {
    if (isProviderKeyId(providerId)) {
      await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
        providerId,
        dependencies.env,
        dependencies.settings,
      );
    }
    return { model: canonicalModel };
  }

  const authorization = await (
    dependencies.resolveOpenAiAuthorization ?? resolveOpenAiAuthMethod
  )(dependencies.settings);
  if (authorization === 'api_key') {
    const model = resolveApiKeyModelSpecifier(canonicalModel, 'openai');
    await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
      'openai',
      dependencies.env,
      dependencies.settings,
    );
    return { model, providerAuthRoute: 'openai_api_key' };
  }

  // The rollout switch is checked after resolving the installation-wide
  // billing authority but before touching either credential lane. Disabling
  // the preview preserves the setting and stored tokens while making every
  // OpenAI operation fail closed.
  (dependencies.requireSubscriptionEnabled ?? requireOpenAiSubscriptionEnabled)(
    dependencies.env,
  );

  // Reject malformed model ids before touching credentials. The provider then
  // validates safe ids against the account-scoped cached or live catalog.
  const modelId = canonicalModel.slice('openai/'.length);
  const route = resolveActiveCatalogRoute(canonicalModel, 'openai_subscription');
  if (!route) throw new OpenAiSubscriptionError('unsupported_model');
  const internalModel = openAiSubscriptionModelSpecifier(modelId, route);
  await (dependencies.bindSubscription ?? bindOpenAiSubscriptionProvider)({
    settings: dependencies.settings,
    modelId,
    route,
  });
  return {
    model: internalModel,
    providerAuthRoute: 'openai_subscription',
  };
}

export function canonicalRuntimeModel(model: string): string {
  const separator = model.indexOf('/');
  const providerId = separator > 0 ? model.slice(0, separator) : model;
  const canonical = isOpenAiSubscriptionProviderId(providerId)
    ? `openai/${model.slice(separator + 1)}`
    : model;
  return canonicalCompatibilityModel(canonical);
}

function providerPrefix(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : model;
}
