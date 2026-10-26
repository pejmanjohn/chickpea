import {
  connectionAccountCredentialBinding,
  sameApiCredentialPolicy,
  sameMcpCredentialPolicy,
} from '../config/connection-credential-binding.ts';
import type {
  AgentConnectionBinding,
  ApiConnectionConfig,
  ConnectionAccount,
  ConnectionAccountApiPolicy,
  ConnectionAccountMcpPolicy,
  CustomAgentConfig,
  McpConnectionConfig,
  McpConnectionIdentity,
  McpConnectionToolInfo,
} from '../config/types.ts';
import { CONNECTION_ID_PATTERN } from '../config/agent-write-rules.ts';
import { canonicalJson } from './contracts.ts';
import { AgentWriteRuleError } from './types.ts';

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
    const kept: Omit<McpConnectionConfig, 'lifecycleStatus' | 'statusText' | 'discoveredTools'> = {
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
    // An account stores one credential; with no bearer or OAuth auth it goes in the one header.
    const [onlyHeader] = kept.headerNames;
    if (!kept.credentialHeaderName && kept.authMode === 'none' && onlyHeader !== undefined) {
      kept.credentialHeaderName = onlyHeader;
    }
    const ready = kept.authMode === 'none' &&
      (!kept.credentialHeaderName || kept.credentialOptional === true);
    return {
      ...kept,
      lifecycleStatus: ready ? 'ready' : 'pending',
      statusText: ready ? 'Ready' : 'Setup required',
      // Discovery narrows a non-empty grant to these names. An empty list
      // counts as never discovered, so outside review mode the first
      // discovery grants every tool the server offers.
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
    return { ...(kept ?? API_CONNECTION_AWAITING_CREDENTIAL), ...policy };
  });
}

/** A new API connection, or one whose credential policy changed, waits for its credential. */
export const API_CONNECTION_AWAITING_CREDENTIAL = {
  lifecycleStatus: 'pending',
  statusText: 'Setup required',
} as const satisfies Pick<ApiConnectionConfig, 'lifecycleStatus' | 'statusText'>;

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

export type ConnectionLane = 'mcp' | 'api';

export type NativeConnectionAccount = ConnectionAccount & {
  policy: ConnectionAccountApiPolicy | ConnectionAccountMcpPolicy;
};

export interface AgentConnectionEntry {
  account: NativeConnectionAccount;
  binding: AgentConnectionBinding;
}

/**
 * An Agent's MCP servers and API connections as one member manages them: the
 * Agent's enabled bindings to native connection accounts, team-owned or the
 * member's own, which are the accounts Admin lists under "In this Agent". A
 * connection's id is its account's provider id, or the account id when two
 * connections in the lane share a provider id.
 */
export interface AgentConnections {
  mcpServers: McpConnectionConfig[];
  apiConnections: ApiConnectionConfig[];
  mcp: ReadonlyMap<string, AgentConnectionEntry>;
  api: ReadonlyMap<string, AgentConnectionEntry>;
}


const ACCOUNT_STATUS = {
  ready: { lifecycleStatus: 'ready', statusText: 'Connected' },
  pending: { lifecycleStatus: 'pending', statusText: 'Setup required' },
  needs_attention: { lifecycleStatus: 'failed', statusText: 'Needs attention' },
} as const satisfies Record<
  Exclude<ConnectionAccount['lifecycle'], 'revoked'>,
  { lifecycleStatus: McpConnectionConfig['lifecycleStatus']; statusText: string }
>;

export function agentConnections(
  accounts: readonly ConnectionAccount[],
  bindings: readonly AgentConnectionBinding[],
  membershipId: string,
): AgentConnections {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const entries = bindings.flatMap((binding): AgentConnectionEntry[] => {
    const account = byId.get(binding.connectionAccountId);
    return account && isNativeAccount(account) && binding.enabled &&
        account.providerId === binding.providerId && account.lifecycle !== 'revoked' &&
        (account.ownerKind === 'team' || account.ownerMembershipId === membershipId)
      ? [{ account, binding }]
      : [];
  });
  const mcp = laneEntries(entries, 'mcp');
  const api = laneEntries(entries, 'api');
  return {
    mcp,
    api,
    mcpServers: [...mcp].map(([id, entry]) => mcpConnectionFromAccount(id, entry)),
    apiConnections: [...api].map(([id, entry]) => apiConnectionFromAccount(id, entry)),
  };
}

/** The connection id an existing connection has in the lane, given its connection or account id. */
export function resolveAgentConnectionId(
  connections: AgentConnections,
  lane: ConnectionLane,
  id: string,
): string | undefined {
  const entries = connections[lane];
  if (entries.has(id)) return id;
  for (const [connectionId, { account }] of entries) {
    if (account.id === id) return connectionId;
  }
  return undefined;
}

/**
 * The written connections with each existing one named by its connection id.
 * Any other id names a new connection and must be a new provider id.
 */
export function withAgentConnectionIds<T extends { id: string }>(
  connections: AgentConnections,
  lane: ConnectionLane,
  written: readonly T[],
): T[] {
  const providerIds = [...connections[lane].values()].map(({ account }) => account.providerId);
  const shared = new Set(providerIds.filter((id, index) => providerIds.indexOf(id) !== index));
  return written.map((connection) => {
    const id = resolveAgentConnectionId(connections, lane, connection.id);
    if (id !== undefined) return { ...connection, id };
    if (shared.has(connection.id)) {
      throw new AgentWriteRuleError(
        `More than one connection uses ${connection.id}. Name the one to change by its id from inspect_workspace.`,
      );
    }
    // A new connection's id becomes its account's provider id; account ids start with connection_.
    if (!CONNECTION_ID_PATTERN.test(connection.id) || connection.id.startsWith('connection_')) {
      throw new AgentWriteRuleError(
        `Connection ${connection.id} is not on this Agent. A new connection needs a short id of lowercase letters, digits, "-" or "_".`,
      );
    }
    return connection;
  });
}

type NativeConnectionPolicy = ConnectionAccountApiPolicy | ConnectionAccountMcpPolicy;

export type AgentConnectionWrite =
  | { kind: 'create'; providerId: string; label: string; policy: NativeConnectionPolicy }
  | {
      kind: 'update';
      entry: AgentConnectionEntry;
      label: string;
      policy: NativeConnectionPolicy;
      identity?: McpConnectionIdentity;
      resetCredential: boolean;
    }
  | { kind: 'revoke'; entry: AgentConnectionEntry };

/**
 * The account writes that turn an Agent's current connections into the
 * desired ones, which mcpConnectionsAfterWrite and apiConnectionsAfterWrite
 * computed over the current connections. A lane the write leaves out stays.
 */
export function agentConnectionWrites(
  current: AgentConnections,
  desired: { mcpServers?: readonly McpConnectionConfig[]; apiConnections?: readonly ApiConnectionConfig[] },
): AgentConnectionWrite[] {
  return [
    ...laneWrites(current, 'mcp', current.mcpServers, desired.mcpServers, mcpAccountPolicy, sameMcpCredentialPolicy),
    ...laneWrites(current, 'api', current.apiConnections, desired.apiConnections, apiAccountPolicy, sameApiCredentialPolicy),
  ];
}

function laneWrites<T extends McpConnectionConfig | ApiConnectionConfig>(
  current: AgentConnections,
  lane: ConnectionLane,
  stored: readonly T[],
  next: readonly T[] | undefined,
  accountPolicy: (connection: T, kept?: AgentConnectionEntry) => NativeConnectionPolicy,
  sameCredentialPolicy: (left: T, right: T) => boolean,
): AgentConnectionWrite[] {
  if (!next) return [];
  const storedById = new Map(stored.map((connection) => [connection.id, connection]));
  const writes: AgentConnectionWrite[] = next.flatMap((connection): AgentConnectionWrite[] => {
    const entry = current[lane].get(connection.id);
    const previous = storedById.get(connection.id);
    if (!entry || !previous) {
      return [{
        kind: 'create',
        providerId: connection.id,
        label: connection.displayName,
        policy: accountPolicy(connection),
      }];
    }
    const resetCredential = !sameCredentialPolicy(previous, connection);
    const policy = accountPolicy(connection, resetCredential ? undefined : entry);
    if (!resetCredential && entry.account.label === connection.displayName &&
        canonicalJson(entry.account.policy) === canonicalJson(policy)) return [];
    return [{
      kind: 'update',
      entry,
      label: connection.displayName,
      policy,
      ...(connection.identity ? { identity: connection.identity } : {}),
      resetCredential,
    }];
  });
  const kept = new Set(next.map(({ id }) => id));
  for (const [id, entry] of current[lane]) {
    if (!kept.has(id)) writes.push({ kind: 'revoke', entry });
  }
  return writes;
}

/** The fence a setup link holds on one connection: its account's secret slot and credential policy. */
export function connectionSetupBinding(entry: AgentConnectionEntry): string {
  const { account } = entry;
  return connectionAccountCredentialBinding(account.secretRefId, account.policy.kind === 'mcp'
    ? { lane: 'mcp', policy: mcpConnectionFromAccount(account.id, entry) }
    : { lane: 'api', policy: apiConnectionFromAccount(account.id, entry) });
}

/** The one setup form field an MCP connection's credential goes in. */
export function mcpCredentialField(policy: ConnectionAccountMcpPolicy): string {
  return policy.credentialHeaderName ? `header:${policy.credentialHeaderName}` : 'bearerToken';
}

function isNativeAccount(account: ConnectionAccount): account is NativeConnectionAccount {
  return account.policy.kind === 'mcp' || account.policy.kind === 'api';
}

function laneEntries(
  entries: readonly AgentConnectionEntry[],
  lane: ConnectionLane,
): Map<string, AgentConnectionEntry> {
  const inLane = entries.filter(({ account }) => account.policy.kind === lane);
  const providerCounts = new Map<string, number>();
  for (const { account } of inLane) {
    providerCounts.set(account.providerId, (providerCounts.get(account.providerId) ?? 0) + 1);
  }
  return new Map(inLane.map((entry) => [
    providerCounts.get(entry.account.providerId) === 1 ? entry.account.providerId : entry.account.id,
    entry,
  ]));
}

function mcpConnectionFromAccount(id: string, { account, binding }: AgentConnectionEntry): McpConnectionConfig {
  const { policy, lifecycle } = account;
  if (policy.kind !== 'mcp' || lifecycle === 'revoked') throw new Error('Not a connected MCP server.');
  return {
    id,
    displayName: account.label,
    url: policy.url,
    transport: policy.transport,
    authMode: policy.authMode,
    headerNames: [...policy.headerNames],
    ...pickDefined(policy, MCP_HEADER_POLICY_FIELDS),
    enabled: binding.enabled,
    ...ACCOUNT_STATUS[lifecycle],
    discoveredTools: [...policy.discoveredTools],
    ...(policy.toolAccessMode ? { toolAccessMode: policy.toolAccessMode } : {}),
    ...(policy.toolPolicies ? { toolPolicies: policy.toolPolicies } : {}),
    allowedTools: [...policy.allowedTools],
    ...(policy.oauthScope ? { oauthScope: policy.oauthScope } : {}),
    ...(policy.oauthAttemptId ? { oauthAttemptId: policy.oauthAttemptId } : {}),
    ...(account.identity ? { identity: account.identity } : {}),
    ...(policy.presetId ? { presetId: policy.presetId } : {}),
  };
}

function apiConnectionFromAccount(id: string, { account, binding }: AgentConnectionEntry): ApiConnectionConfig {
  const { policy, lifecycle } = account;
  if (policy.kind !== 'api' || lifecycle === 'revoked') throw new Error('Not a connected API connection.');
  return {
    id,
    displayName: account.label,
    allowedHosts: [...policy.allowedHosts],
    pathPrefixes: [...policy.pathPrefixes],
    headerName: policy.headerName,
    ...(policy.headerValuePrefix ? { headerValuePrefix: policy.headerValuePrefix } : {}),
    allowedMethods: [...policy.allowedMethods],
    enabled: binding.enabled,
    authMode: policy.authMode,
    ...(policy.oauthProvider ? { oauthProvider: policy.oauthProvider } : {}),
    ...(policy.oauthScopes ? { oauthScopes: [...policy.oauthScopes] } : {}),
    ...(policy.oauthAppType ? { oauthAppType: policy.oauthAppType } : {}),
    ...ACCOUNT_STATUS[lifecycle],
    ...(account.identity ? { identity: account.identity } : {}),
    ...(policy.presetId ? { presetId: policy.presetId } : {}),
  };
}

function mcpAccountPolicy(connection: McpConnectionConfig): ConnectionAccountMcpPolicy {
  return {
    kind: 'mcp',
    url: connection.url,
    transport: connection.transport,
    authMode: connection.authMode,
    headerNames: [...connection.headerNames],
    ...pickDefined(connection, MCP_HEADER_POLICY_FIELDS),
    discoveredTools: [...connection.discoveredTools],
    ...(connection.toolAccessMode ? { toolAccessMode: connection.toolAccessMode } : {}),
    ...(connection.toolPolicies ? { toolPolicies: connection.toolPolicies } : {}),
    allowedTools: [...connection.allowedTools],
    ...(connection.oauthScope ? { oauthScope: connection.oauthScope } : {}),
    ...(connection.oauthAttemptId ? { oauthAttemptId: connection.oauthAttemptId } : {}),
    ...(connection.presetId ? { presetId: connection.presetId } : {}),
  };
}

/** API connections never expose their OAuth attempt, so an account that keeps its credential keeps it. */
function apiAccountPolicy(connection: ApiConnectionConfig, kept?: AgentConnectionEntry): ConnectionAccountApiPolicy {
  const attempt = kept?.account.policy.oauthAttemptId;
  return {
    kind: 'api',
    allowedHosts: [...connection.allowedHosts],
    pathPrefixes: [...connection.pathPrefixes],
    headerName: connection.headerName,
    ...(connection.headerValuePrefix ? { headerValuePrefix: connection.headerValuePrefix } : {}),
    allowedMethods: [...connection.allowedMethods],
    authMode: connection.authMode ?? 'credential',
    ...(connection.oauthProvider ? { oauthProvider: connection.oauthProvider } : {}),
    ...(connection.oauthScopes ? { oauthScopes: [...connection.oauthScopes] } : {}),
    ...(connection.oauthAppType ? { oauthAppType: connection.oauthAppType } : {}),
    ...(attempt ? { oauthAttemptId: attempt } : {}),
    ...(connection.presetId ? { presetId: connection.presetId } : {}),
  };
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
