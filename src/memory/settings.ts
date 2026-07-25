import type { MemoryStateStore } from './types.ts';

export interface EffectiveMemorySetting {
  enabled: boolean;
  managedByEnvironment: boolean;
}

export async function resolveMemorySetting(
  store: MemoryStateStore,
  env: Record<string, string | undefined> = process.env,
): Promise<EffectiveMemorySetting> {
  const override = env.SLACK_TAG_MEMORY_ENABLED;
  if (override !== undefined) {
    return {
      enabled: override.trim().toLowerCase() === 'true',
      managedByEnvironment: true,
    };
  }
  return { enabled: await store.getMemoryEnabled(), managedByEnvironment: false };
}
