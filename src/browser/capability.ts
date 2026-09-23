import {
  compileWebsiteLogins,
  type RuntimePlanBrowserCapabilityV1,
  type RuntimePlanWebsiteLoginV1,
} from '../agents/runtime-plan.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { WebsiteLoginGrant } from '../config/types.ts';
import { listWebsiteLogins } from './logins.ts';
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
    const settings = await resolveBrowserSettings(store, env);
    return settings.connected ? { provider: 'browserbase' } : undefined;
  } catch {
    // A settings read failure must not fail the turn; browse is simply off.
    return undefined;
  }
}

/**
 * Freezes the Agent's granted website logins (metadata only) for an admitted
 * turn. One settings read, skipped when no grant is enabled. Grants may come
 * from an Agent frozen before the field existed, hence the undefined guard.
 * A read failure freezes no logins rather than failing the turn.
 */
export async function websiteLoginsForTurn(
  store: SettingsStore,
  grants: readonly WebsiteLoginGrant[] | undefined,
): Promise<RuntimePlanWebsiteLoginV1[]> {
  if (!grants?.some((grant) => grant.enabled)) return [];
  try {
    return compileWebsiteLogins(grants, await listWebsiteLogins(store));
  } catch {
    return [];
  }
}
