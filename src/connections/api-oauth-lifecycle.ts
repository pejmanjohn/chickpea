import {
  apiOAuthSettingKeys,
  connectionAccountIdFromOAuthRef,
  type ApiOAuthDependencies,
  type ApiOAuthRef,
} from '../config/api-oauth.ts';
import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { findConnectionAccountForOAuthRef, markApiOAuthAccountExpired } from './store.ts';

/** Shared by Admin and native runtime; embedded connections retain their own lane. */
export function apiOAuthLifecycleDependencies(
  config: ConfigStore,
  settings: SettingsStore,
  workspaceId?: string,
): Pick<ApiOAuthDependencies, 'getConnectionRevision' | 'onReauthorizationRequired'> {
  const findAccount = (ref: ApiOAuthRef) =>
    findConnectionAccountForOAuthRef(config, ref, workspaceId);
  return {
    getConnectionRevision: async (ref) => (await findAccount(ref))?.revision,
    onReauthorizationRequired: async (ref, provider, expectedRevision) => {
      if (!connectionAccountIdFromOAuthRef(ref)) {
        await config.markOAuthReauthorizationRequired({ lane: 'api', ...ref, provider });
        return;
      }
      if (expectedRevision === undefined) return;
      const account = await findAccount(ref);
      if (!account || account.revision !== expectedRevision || account.lifecycle !== 'ready' ||
          account.providerId !== provider || account.policy.kind !== 'api' ||
          account.policy.authMode !== 'oauth' || account.policy.oauthProvider !== provider) return;
      // The refresh deleted its exact token with CAS. A replacement token wins,
      // including a concurrent refresher that does not change account revision.
      if (await settings.getSetting(apiOAuthSettingKeys(ref)[2])) return;
      await markApiOAuthAccountExpired(config, account);
    },
  };
}
