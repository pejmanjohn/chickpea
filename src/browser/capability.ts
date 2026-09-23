import type { RuntimePlanBrowserCapabilityV1 } from '../agents/runtime-plan.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { resolveBrowserSettings } from './settings.ts';

/**
 * Freezes the bounded browser capability for an admitted turn. Only a
 * connected install freezes a record, so installs without a browser keep
 * their existing harness revision. The key never enters the plan: the tools
 * read it again at call time.
 */
export async function browserCapabilityForTurn(
  store: SettingsStore,
  env: Record<string, unknown> | undefined,
): Promise<RuntimePlanBrowserCapabilityV1 | undefined> {
  try {
    const settings = await resolveBrowserSettings(store, env ?? process.env);
    return settings.connected ? { provider: 'browserbase', enabled: true } : undefined;
  } catch {
    // A settings read failure must not fail the turn; browse is simply off.
    return undefined;
  }
}
