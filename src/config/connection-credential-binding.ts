import { createHash, randomUUID } from 'node:crypto';

import type { ApiConnectionConfig, McpConnectionConfig } from './types.ts';

const CREDENTIAL_REF_PATTERN = /^connection_[0-9a-f]{32}$/;
const AGENT_CREDENTIAL_INCARNATION_PATTERN = /^agent_[0-9a-f]{32}$/;

export interface AgentConnectionCredentialResets {
  mcp?: readonly string[];
  api?: readonly string[];
}

export interface AgentConnectionCredentialRequirements {
  agent?: string;
  mcp?: Readonly<Record<string, string>>;
  api?: Readonly<Record<string, string>>;
}

export function validAgentCredentialIncarnation(value: string | undefined): value is string {
  return value !== undefined && AGENT_CREDENTIAL_INCARNATION_PATTERN.test(value);
}

export function newAgentCredentialIncarnation(): string {
  return `agent_${randomUUID().replaceAll('-', '')}`;
}

export function agentCredentialConfigurationBinding(incarnation: string | undefined): string {
  if (!validAgentCredentialIncarnation(incarnation)) {
    throw new Error('Agent credential configuration binding is unavailable');
  }
  return `v1:${createHash('sha256')
    .update('agent')
    .update('\0')
    .update(incarnation)
    .digest('base64url')}`;
}

export function validConnectionCredentialRef(value: string | undefined): value is string {
  return value !== undefined && CREDENTIAL_REF_PATTERN.test(value);
}

export function newConnectionCredentialRef(): string {
  return `connection_${randomUUID().replaceAll('-', '')}`;
}

export function reconcileMcpCredentialRefs(
  current: readonly McpConnectionConfig[],
  next: readonly McpConnectionConfig[],
  resetIds: ReadonlySet<string> = new Set(),
): McpConnectionConfig[] {
  const currentById = new Map(current.map((connection) => [connection.id, connection]));
  return next.map((connection) => {
    const previous = currentById.get(connection.id);
    const credentialRef = previous && !resetIds.has(connection.id) &&
        validConnectionCredentialRef(previous.credentialRef) &&
        sameMcpCredentialPolicy(previous, connection)
      ? previous.credentialRef
      : newConnectionCredentialRef();
    return { ...connection, credentialRef };
  });
}

export function reconcileApiCredentialRefs(
  current: readonly ApiConnectionConfig[],
  next: readonly ApiConnectionConfig[],
  resetIds: ReadonlySet<string> = new Set(),
): ApiConnectionConfig[] {
  const currentById = new Map(current.map((connection) => [connection.id, connection]));
  return next.map((connection) => {
    const previous = currentById.get(connection.id);
    const credentialRef = previous && !resetIds.has(connection.id) &&
        validConnectionCredentialRef(previous.credentialRef) &&
        sameApiCredentialPolicy(previous, connection)
      ? previous.credentialRef
      : newConnectionCredentialRef();
    return { ...connection, credentialRef };
  });
}

export function sameMcpCredentialPolicy(
  left: McpConnectionConfig,
  right: McpConnectionConfig,
): boolean {
  return canonicalMcpCredentialPolicy(left) === canonicalMcpCredentialPolicy(right);
}

export function mcpCredentialBinding(connection: McpConnectionConfig): string {
  if (!validConnectionCredentialRef(connection.credentialRef)) {
    throw new Error('MCP connection credential binding is unavailable');
  }
  return credentialBinding('mcp', connection.credentialRef, canonicalMcpCredentialPolicy(connection));
}

export function boundMcpCredentialRef(agentId: string, connection: McpConnectionConfig) {
  if (!validConnectionCredentialRef(connection.credentialRef)) {
    throw new Error('MCP connection credential binding is unavailable');
  }
  return {
    agentId,
    connectionId: connection.id,
    credentialRef: connection.credentialRef,
    credentialBinding: mcpCredentialBinding(connection),
  };
}

export function sameApiCredentialPolicy(
  left: ApiConnectionConfig,
  right: ApiConnectionConfig,
): boolean {
  return canonicalApiCredentialPolicy(left) === canonicalApiCredentialPolicy(right);
}

export function apiCredentialBinding(connection: ApiConnectionConfig): string {
  if (!validConnectionCredentialRef(connection.credentialRef)) {
    throw new Error('API connection credential binding is unavailable');
  }
  return credentialBinding('api', connection.credentialRef, canonicalApiCredentialPolicy(connection));
}

export function boundApiCredentialRef(agentId: string, connection: ApiConnectionConfig) {
  if (!validConnectionCredentialRef(connection.credentialRef)) {
    throw new Error('API connection credential binding is unavailable');
  }
  return {
    agentId,
    connectionId: connection.id,
    credentialRef: connection.credentialRef,
    credentialBinding: apiCredentialBinding(connection),
  };
}

/** Fences a connection account's setup link to its secret slot and its credential policy. */
export function connectionAccountCredentialBinding(
  secretRefId: string,
  connection: { lane: 'mcp'; policy: McpConnectionConfig } | { lane: 'api'; policy: ApiConnectionConfig },
): string {
  return credentialBinding(
    connection.lane,
    secretRefId,
    connection.lane === 'mcp'
      ? canonicalMcpCredentialPolicy(connection.policy)
      : canonicalApiCredentialPolicy(connection.policy),
  );
}

function canonicalMcpCredentialPolicy(connection: McpConnectionConfig): string {
  return JSON.stringify({
    presetId: connection.presetId ?? null,
    url: connection.url,
    transport: connection.transport,
    authMode: connection.authMode,
    oauthScope: connection.oauthScope ?? null,
    headerNames: sorted(connection.headerNames, (value) => value.toLowerCase()),
    credentialHeaderName: connection.credentialHeaderName?.toLowerCase() ?? null,
    credentialValuePrefix: connection.credentialValuePrefix ?? '',
    credentialOptional: connection.credentialOptional === true,
  });
}

function canonicalApiCredentialPolicy(connection: ApiConnectionConfig): string {
  return JSON.stringify({
    presetId: connection.presetId ?? null,
    allowedHosts: sorted(connection.allowedHosts, (value) => value.toLowerCase()),
    pathPrefixes: sorted(connection.pathPrefixes),
    headerName: connection.headerName.toLowerCase(),
    headerValuePrefix: connection.headerValuePrefix ?? '',
    allowedMethods: sorted(connection.allowedMethods, (value) => value.toUpperCase()),
    authMode: connection.authMode ?? 'credential',
    oauthProvider: connection.oauthProvider ?? null,
    oauthScopes: sorted(connection.oauthScopes ?? []),
    oauthAppType: connection.oauthAppType ?? null,
  });
}

function sorted(values: readonly string[], normalize: (value: string) => string = String): string[] {
  return values.map(normalize).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function credentialBinding(
  lane: 'mcp' | 'api',
  credentialRef: string,
  canonicalPolicy: string,
): string {
  return `v2:${createHash('sha256')
    .update(lane)
    .update('\0')
    .update(credentialRef)
    .update('\0')
    .update(canonicalPolicy)
    .digest('base64url')}`;
}
