import { connectionAccountIdFromOAuthRef } from '../config/api-oauth.ts';
import { mcpOAuthSettingKeys, type McpOAuthDependencies } from '../config/mcp-oauth.ts';
import type { McpSecretRef } from '../config/mcp-secrets.ts';
import { validateMcpUrl } from '../config/mcp-url.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import { findConnectionAccountForOAuthRef, markConnectionAccountNeedsAttention } from './store.ts';

/**
 * Lifecycle for MCP OAuth credentials, shared by Admin and the native runtime.
 * An account whose authorization can no longer be renewed is demoted to
 * needs-attention so Admin offers Reconnect and dependent schedules pause.
 */
export function mcpOAuthLifecycleDependencies(
  config: ConfigStore,
  settings: SettingsStore,
  workspaceId?: string,
): Pick<McpOAuthDependencies, 'getConnectionRevision' | 'onReauthorizationRequired'> {
  const findAccount = (ref: McpSecretRef) =>
    findConnectionAccountForOAuthRef(config, ref, workspaceId);
  return {
    getConnectionRevision: async (ref) => (await findAccount(ref))?.revision,
    onReauthorizationRequired: async (ref, serverUrl, expectedRevision) => {
      if (!connectionAccountIdFromOAuthRef(ref)) {
        await config.markOAuthReauthorizationRequired({ lane: 'mcp', ...ref, serverUrl });
        return;
      }
      if (expectedRevision === undefined) return;
      const account = await findAccount(ref);
      if (!account || account.revision !== expectedRevision || account.lifecycle !== 'ready' ||
          account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth') return;
      const validated = validateMcpUrl(account.policy.url);
      if (!validated.ok || validated.url !== serverUrl) return;
      // Only a credential that is still absent: a reconnect or concurrent
      // refresh that stored a replacement token wins over this report.
      if (await settings.getSetting(mcpOAuthSettingKeys(ref)[2])) return;
      await markConnectionAccountNeedsAttention(config, account);
    },
  };
}
