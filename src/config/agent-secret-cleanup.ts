import { apiOAuthSettingKeys } from './api-oauth.ts';
import { boundApiCredentialRef, boundMcpCredentialRef } from './connection-credential-binding.ts';
import {
  finishConnectorSecretCleanup,
  stageConnectorSecretCleanup,
  stageConnectorSettingCleanup,
} from './connector-secrets.ts';
import { mcpOAuthSettingKeys } from './mcp-oauth.ts';
import {
  finishMcpSecretCleanup,
  mcpBearerSettingKey,
  mcpHeaderSettingKey,
  stageMcpSecretCleanup,
} from './mcp-secrets.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import type { CustomAgentConfig } from './types.ts';

/**
 * Record every secret of an Agent's own connections behind a durable cleanup
 * marker before the Agent is deleted, so a retry after a partial failure, or
 * after a delete whose response was lost, finishes the job.
 */
export async function stageAgentSecretCleanup(
  agent: Pick<CustomAgentConfig, 'id' | 'mcpServers' | 'apiConnections'>,
  env: PlatformEnv | undefined,
  settings: SettingsStore,
  scope: string,
): Promise<void> {
  const secretKeys = new Set<string>();
  for (const server of agent.mcpServers) {
    const credentialRef = boundMcpCredentialRef(agent.id, server);
    secretKeys.add(mcpBearerSettingKey(credentialRef));
    for (const name of server.headerNames) secretKeys.add(mcpHeaderSettingKey(credentialRef, name));
    for (const key of mcpOAuthSettingKeys(credentialRef)) secretKeys.add(key);
  }
  await stageMcpSecretCleanup(agent.id, [...secretKeys], settings, scope);
  await stageConnectorSecretCleanup(
    agent.id,
    agent.apiConnections.map((connection) => boundApiCredentialRef(agent.id, connection)),
    env,
    settings,
    scope,
  );
  await stageConnectorSettingCleanup(
    agent.id,
    agent.apiConnections.filter((connection) => connection.authMode === 'oauth').flatMap((connection) =>
      apiOAuthSettingKeys(boundApiCredentialRef(agent.id, connection))),
    env,
    settings,
    scope,
  );
}

/** Delete what stageAgentSecretCleanup recorded; true when a marker was found. */
export async function finishAgentSecretCleanup(
  agentId: string,
  env: PlatformEnv | undefined,
  settings: SettingsStore,
  scope: string,
): Promise<boolean> {
  const mcp = await finishMcpSecretCleanup(agentId, settings, scope);
  const connector = await finishConnectorSecretCleanup(agentId, env, settings, scope);
  return mcp || connector;
}
