import {
  ComposioConfigurationStateError,
  composioProviderLineage,
  resolveComposioConfiguration,
  type ComposioConfigurationOptions,
} from '../config/composio-settings.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  createManagedConnectionProviderRegistry,
  createResolvedManagedConnectionProviderRegistry,
  type ManagedConnectionProviderRegistry,
} from './managed.ts';
import type { ManagedAuthorizationProviderContext } from './managed-authorization-flow.ts';

export async function resolveManagedAuthorizationProviderContext(input: {
  settings: SettingsStore;
  platformEnv?: PlatformEnv;
  providers?: ManagedConnectionProviderRegistry;
  composioConfiguration?: Omit<ComposioConfigurationOptions, 'settings' | 'env'>;
}): Promise<ManagedAuthorizationProviderContext> {
  const platformEnv = input.platformEnv ? { platformEnv: input.platformEnv } : {};
  if (input.providers) {
    return {
      providers: input.providers,
      generation: 1,
      lineage: '0'.repeat(24),
      ...platformEnv,
    };
  }
  try {
    const resolved = await resolveComposioConfiguration({
      ...input.composioConfiguration,
      settings: input.settings,
      ...(input.platformEnv ? { env: input.platformEnv } : {}),
    });
    return {
      providers: createResolvedManagedConnectionProviderRegistry(
        resolved,
        input.platformEnv,
      ),
      generation: resolved.generation,
      lineage: composioProviderLineage(resolved),
      ...platformEnv,
    };
  } catch (error) {
    if (!(error instanceof ComposioConfigurationStateError)) throw error;
    return {
      providers: createManagedConnectionProviderRegistry([]),
      generation: 1,
      lineage: '0'.repeat(24),
      ...platformEnv,
    };
  }
}
