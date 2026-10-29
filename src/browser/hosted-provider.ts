/**
 * The browser provider of one installation on a deployment serving many.
 *
 * Every Browserbase call made for such an installation goes through this
 * wrapper, keyed by the host's access (config/hosted-browser.ts). Nothing
 * here reads an installation's `browser.browserbase.*` settings or a
 * `BROWSERBASE_*` variable.
 */
import { hostedBrowserAccess, type HostedBrowserAccess } from '../config/hosted-browser.ts';
import { requireInstallationScope } from '../config/installation-scope.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { createBrowserbaseProvider } from './browserbase.ts';
import { HostedBrowserRefusal, type BrowserProvider } from './provider.ts';

export interface HostedBrowserProviderOptions {
  access: HostedBrowserAccess;
  installationId: string;
  store: Pick<SettingsStore, 'getSettings' | 'applySettingsPatch'>;
  fetch?: typeof fetch;
}

export function createHostedBrowserProvider(options: HostedBrowserProviderOptions): BrowserProvider {
  return createBrowserbaseProvider({
    apiKey: options.access.apiKey,
    projectId: options.access.projectId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/**
 * The provider for the installation `env` serves, from the host's access.
 * Throws the unavailable refusal when the host installed no port or its
 * access is incomplete, so a caller never falls back to another key.
 */
export function hostedBrowserProvider(
  store: HostedBrowserProviderOptions['store'],
  env: Record<string, unknown> | undefined,
): BrowserProvider {
  const installationId = requireInstallationScope(env)?.installationId;
  const access = hostedBrowserAccess();
  if (!installationId || !access) throw new HostedBrowserRefusal('unavailable');
  return createHostedBrowserProvider({ access, installationId, store });
}
