import {
  ComposioConfigurationStateError,
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
  if (input.providers) {
    return {
      providers: input.providers,
      generation: 1,
      lineage: '0'.repeat(24),
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
      lineage: resolved.keyFingerprint ?? resolved.lastKeyFingerprint ?? '0'.repeat(24),
    };
  } catch (error) {
    if (!(error instanceof ComposioConfigurationStateError)) throw error;
    return {
      providers: createManagedConnectionProviderRegistry([]),
      generation: 1,
      lineage: '0'.repeat(24),
    };
  }
}
