import {
  sameApiCredentialPolicy,
  sameMcpCredentialPolicy,
} from '../config/connection-credential-binding.ts';
import type {
  ApiConnectionConfig,
  CustomAgentConfig,
  McpConnectionConfig,
  McpConnectionIdentity,
  McpConnectionToolInfo,
} from '../config/types.ts';

/**
 * The connection fields a management client reads from inspect_workspace and
 * writes back. The server owns every other field: the credential namespace and
 * header policy, status, discovered tools and their schema fingerprints, review
 * mode, and the provider-reported identity.
 */
export const MCP_CLIENT_FIELDS = [
  'id',
  'displayName',
  'url',
  'transport',
  'authMode',
  'headerNames',
  'enabled',
  'allowedTools',
  'toolPolicies',
  'oauthScope',
  'presetId',
] as const satisfies readonly (keyof McpConnectionConfig)[];

export const API_CLIENT_FIELDS = [
  'id',
  'displayName',
  'allowedHosts',
  'pathPrefixes',
  'headerName',
  'headerValuePrefix',
  'allowedMethods',
  'enabled',
  'authMode',
  'oauthProvider',
  'oauthScopes',
  'oauthAppType',
  'presetId',
] as const satisfies readonly (keyof ApiConnectionConfig)[];

const MCP_HEADER_POLICY_FIELDS = [
  'credentialHeaderName',
  'credentialValuePrefix',
  'credentialOptional',
] as const satisfies readonly (keyof McpConnectionConfig)[];

const MCP_OBSERVED_FIELDS = [
  'credentialRef',
  'lifecycleStatus',
  'statusText',
  'discoveredTools',
  'oauthAttemptId',
  'lastCheckedAt',
  'identity',
] as const satisfies readonly (keyof McpConnectionConfig)[];

const API_OBSERVED_FIELDS = [
  'credentialRef',
  'lifecycleStatus',
  'statusText',
  'identity',
] as const satisfies readonly (keyof ApiConnectionConfig)[];

export type ManagementMcpConnection = Pick<McpConnectionConfig, typeof MCP_CLIENT_FIELDS[number]>;
export type ManagementApiConnection = Pick<ApiConnectionConfig, typeof API_CLIENT_FIELDS[number]>;

/** Read-only server state of one Agent connection, reported beside the writable policy. */
export interface ManagementConnectionStatus {
  kind: 'mcp' | 'api';
  id: string;
  lifecycleStatus: 'pending' | 'ready' | 'failed';
  statusText: string;
  discoveredTools?: Array<Omit<McpConnectionToolInfo, 'inputSchema'>>;
  identity?: McpConnectionIdentity;
  lastCheckedAt?: number;
}

export function managementMcpConnection(connection: ManagementMcpConnection): ManagementMcpConnection {
  return pickDefined(connection, MCP_CLIENT_FIELDS);
}

export function managementApiConnection(connection: ManagementApiConnection): ManagementApiConnection {
  return pickDefined(connection, API_CLIENT_FIELDS);
}

/**
 * The stored MCP connections after a management write. Each takes only the
 * client fields from the write. Matched by id, the stored connection supplies
 * review mode and its header policy, and, while the credential policy is
 * unchanged, its secret namespace and observed state. A connection that is new
 * or whose credential policy changed starts unconfigured.
 */
export function mcpConnectionsAfterWrite(
  stored: readonly McpConnectionConfig[],
  written: readonly ManagementMcpConnection[],
): McpConnectionConfig[] {
  const storedById = new Map(stored.map((connection) => [connection.id, connection]));
  return written.map((input) => {
    const policy = managementMcpConnection(input);
    const previous = storedById.get(policy.id);
    const kept = {
      ...policy,
      ...(previous && headerPolicyStillApplies(previous, policy)
        ? pickDefined(previous, MCP_HEADER_POLICY_FIELDS)
        : {}),
      ...(previous?.toolAccessMode ? { toolAccessMode: previous.toolAccessMode } : {}),
    };
    if (previous) {
      const carried: McpConnectionConfig = { ...pickDefined(previous, MCP_OBSERVED_FIELDS), ...kept };
      if (sameMcpCredentialPolicy(previous, carried)) return carried;
    }
    const ready = kept.authMode === 'none' &&
      (!kept.credentialHeaderName || kept.credentialOptional === true);
    return {
      ...kept,
      lifecycleStatus: ready ? 'ready' : 'pending',
      statusText: ready ? 'Ready' : 'Setup required',
      // Discovery narrows a grant to these names; an empty list would let the
      // first discovery grant every tool the server offers.
      discoveredTools: kept.allowedTools.map((name) => ({ name })),
    };
  });
}

/** The stored API connections after a management write; see mcpConnectionsAfterWrite. */
export function apiConnectionsAfterWrite(
  stored: readonly ApiConnectionConfig[],
  written: readonly ManagementApiConnection[],
): ApiConnectionConfig[] {
  const storedById = new Map(stored.map((connection) => [connection.id, connection]));
  return written.map((input) => {
    const policy = managementApiConnection(input);
    const kept = apiConnectionStateKept(storedById.get(policy.id), policy);
    return kept ? { ...kept, ...policy } : { ...policy, lifecycleStatus: 'pending', statusText: 'Setup required' };
  });
}

/**
 * The server-owned state a written API connection keeps from its stored
 * entry: all of it while the credential policy is unchanged, none otherwise.
 * Admin and management writes both take it from storage, never from input.
 */
export function apiConnectionStateKept(
  previous: ApiConnectionConfig | undefined,
  next: ManagementApiConnection,
): Pick<ApiConnectionConfig, typeof API_OBSERVED_FIELDS[number]> | undefined {
  return previous && sameApiCredentialPolicy(previous, next)
    ? pickDefined(previous, API_OBSERVED_FIELDS)
    : undefined;
}

export function managementConnectionStatus(
  agent: Pick<CustomAgentConfig, 'mcpServers' | 'apiConnections'>,
): ManagementConnectionStatus[] {
  return [
    ...agent.mcpServers.map((connection): ManagementConnectionStatus => ({
      kind: 'mcp',
      id: connection.id,
      lifecycleStatus: connection.lifecycleStatus,
      statusText: connection.statusText,
      discoveredTools: connection.discoveredTools.map(({ inputSchema: _inputSchema, ...tool }) => tool),
      ...(connection.identity ? { identity: connection.identity } : {}),
      ...(connection.lastCheckedAt !== undefined ? { lastCheckedAt: connection.lastCheckedAt } : {}),
    })),
    ...agent.apiConnections.map((connection): ManagementConnectionStatus => ({
      kind: 'api',
      id: connection.id,
      // A legacy credential connection has no status and is in use.
      lifecycleStatus: connection.lifecycleStatus ?? 'ready',
      statusText: connection.statusText ?? '',
      ...(connection.identity ? { identity: connection.identity } : {}),
    })),
  ];
}

function headerPolicyStillApplies(
  previous: McpConnectionConfig,
  next: ManagementMcpConnection,
): boolean {
  const header = previous.credentialHeaderName?.toLowerCase();
  return previous.authMode === next.authMode &&
    (header === undefined || next.headerNames.some((name) => name.toLowerCase() === header));
}

/** Copies the named fields that hold a value; an absent optional field stays absent. */
function pickDefined<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.flatMap((key) =>
    value[key] === undefined ? [] : [[key, value[key]]])) as Pick<T, K>;
}
