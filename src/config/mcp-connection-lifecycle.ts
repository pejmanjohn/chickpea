import { deleteMcpOAuthSettings } from './mcp-oauth.ts';
import { deleteMcpSecrets } from './mcp-secrets.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import type { CustomAgentConfig } from './types.ts';

export function mcpConnectionsWithChangedOrigin(
  current: CustomAgentConfig['mcpServers'],
  next: CustomAgentConfig['mcpServers'] | undefined,
): { connectionId: string; headerNames: string[] }[] {
  if (!next) return [];
  const nextById = new Map(next.map((server) => [server.id, server]));
  const changed: { connectionId: string; headerNames: string[] }[] = [];
  for (const existing of current) {
    const replacement = nextById.get(existing.id);
    if (!replacement) continue;
    const before = safeUrlOrigin(existing.url);
    const after = safeUrlOrigin(replacement.url);
    if (before !== undefined && after !== undefined && before === after) continue;
    changed.push({
      connectionId: existing.id,
      headerNames: [...new Set([...existing.headerNames, ...replacement.headerNames])],
    });
  }
  return changed;
}

export async function clearRepointedMcpCredentials(input: {
  agentId: string;
  current: CustomAgentConfig['mcpServers'];
  next: CustomAgentConfig['mcpServers'] | undefined;
  settings: SettingsStore;
  env?: PlatformEnv;
}): Promise<void> {
  for (const { connectionId, headerNames } of mcpConnectionsWithChangedOrigin(
    input.current,
    input.next,
  )) {
    const ref = { agentId: input.agentId, connectionId };
    await deleteMcpSecrets(ref, headerNames, input.env, input.settings);
    await deleteMcpOAuthSettings(ref, input.settings);
  }
}

export function safeUrlOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
