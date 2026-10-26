import {
  availableRoleModels,
  chatModelPickerProviders,
  modelRoleChoiceError,
  PLATFORM_MODELS_SOURCE,
  uniqueStrings,
  workspaceModelChoiceRefusal,
  type ChatModelPickerProvider,
} from '../config/model-choices.ts';
import { resolveModelEfforts } from '../config/model-effort-capability.ts';
import { resolveModelReadiness } from '../config/model-readiness.ts';
import { resolveOpenAiAuthMethod } from '../config/openai-auth.ts';
import { deploymentServesManyInstallations } from '../config/installation-scope.ts';
import { listInstallationModelProviders, PROVIDER_KEY_IDS } from '../config/provider-keys.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { loadModelCatalog } from '../model-catalog/index.ts';
import type {
  ManagementModelAccess,
  ManagementModelProviderId,
  ManagementModelSources,
} from './types.ts';

/**
 * Admin's model pickers, provider readiness and choice checks, read for
 * workspace management so both apply one set of rules.
 */
export function createManagementModelSources(input: {
  env: PlatformEnv | undefined;
  settings: SettingsStore;
}): ManagementModelSources {
  const { env, settings } = input;
  return {
    async availability() {
      await loadModelCatalog(settings, env);
      const runtimeProviders = await listInstallationModelProviders(env, settings);
      const [providers, image] = await Promise.all([
        chatModelPickerProviders({ settings, env, runtimeProviders }),
        availableRoleModels('image', settings, env),
      ]);
      // Admin's picker leaves out the REST Workers AI provider and refuses a
      // model the active catalog or its provider cannot serve.
      const candidates = uniqueStrings(providers
        .filter(({ id, configured }) => configured && id !== 'cloudflare-workers-ai')
        .flatMap(({ suggestions }) => suggestions));
      const [unavailable, openAiAuthMethod] = await Promise.all([
        resolveModelReadiness({ settings, env, runtimeProviders }),
        resolveOpenAiAuthMethod(settings),
      ]);
      const ready = await Promise.all(candidates.map(async (id) => !(await unavailable(id))));
      // The catalog is loaded above and the auth method read once, not once per model.
      const effortLookup = { settings, env, catalogLoaded: true, openAiAuthMethod } as const;
      const chat = await Promise.all(candidates.filter((_, index) => ready[index]).map(async (id) => ({
        id,
        efforts: await resolveModelEfforts(id, effortLookup),
      })));
      const access = new Map<ManagementModelProviderId, ManagementModelAccess>();
      for (const provider of providers) {
        const id = managementProviderId(provider.id);
        if (id && provider.configured) access.set(id, providerAccess(id, provider));
      }
      // A deployment serving many offers its installations no Workers AI.
      const offered: ManagementModelProviderId[] = deploymentServesManyInstallations(env)
        ? [...PROVIDER_KEY_IDS]
        : [...PROVIDER_KEY_IDS, 'workers-ai'];
      return {
        catalog: { chat, image: image.map(({ id, name }) => ({ id, name })) },
        providers: offered.map((id) => {
          const via = access.get(id);
          return via ? { id, access: via } : { id };
        }),
      };
    },
    async workspaceModelRefusal({ role, model, effort }) {
      return workspaceModelChoiceRefusal({
        role,
        modelId: model,
        effort,
        settings,
        env,
        runtimeProviders: await listInstallationModelProviders(env, settings),
      });
    },
    agentImageModelRefusal: (model) => modelRoleChoiceError({
      settingsStore: settings,
      ...(env ? { platformEnv: env } : {}),
      role: 'image',
      modelId: model,
    }),
  };
}

function managementProviderId(pickerId: string): ManagementModelProviderId | undefined {
  if (pickerId === 'cloudflare' || pickerId === 'cloudflare-workers-ai') return 'workers-ai';
  return pickerId === 'anthropic' || pickerId === 'openai' || pickerId === 'openrouter'
    ? pickerId
    : undefined;
}

function providerAccess(
  id: ManagementModelProviderId,
  provider: ChatModelPickerProvider,
): ManagementModelAccess {
  if (provider.source === PLATFORM_MODELS_SOURCE) return 'platform';
  if (id === 'workers-ai') return 'workers_ai';
  return provider.authMethods?.activeMethod === 'subscription' ? 'chatgpt_plan' : 'api_key';
}
