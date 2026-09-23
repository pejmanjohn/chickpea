import {
  createConnectionScopedFetch,
  type ConnectionScopedFetch,
  type ResolvedApiConnection,
} from '../config/egress.ts';

/** What the model may know about a connection: never its credential. */
export interface ConnectionDeclaration {
  id: string;
  displayName: string;
  allowedHosts: string[];
  pathPrefixes: string[];
  allowedMethods: string[];
  /** `https://<host><prefix>` for each host and path prefix a scope actually pairs. */
  urlPrefixes: string[];
  /** The request header that carries the credential; a request may not set it. */
  headerName: string;
}

export interface ConnectionFetch {
  fetch: ConnectionScopedFetch;
  /** The credential values in play, removed from anything the model reads. */
  secrets: readonly string[];
}

/** This turn's live API connections, each sendable only through its own scopes. */
export interface ConnectionAccess {
  connections: ConnectionDeclaration[];
  /** A fetch governed by ONE connection's scopes, so a shared host never borrows another's credential. */
  fetchFor(connectionId: string): Promise<ConnectionFetch | undefined>;
  /** A fetch governed by every connection's scopes, routed by URL. */
  fetchAll(): Promise<ConnectionFetch | undefined>;
}

export interface ResolvedConnectionEntry {
  policy: { id: string; displayName: string; headerName: string };
  /** Credential-bearing connectors, GitHub hosts already removed. */
  connectors: ResolvedApiConnection[];
}

/**
 * Build the turn's connection access from connections resolved live. The
 * declarations are the connectors' own hosts, prefixes, and methods (after
 * `filter`), so a declaration never names more than its scopes enforce.
 */
export function buildConnectionAccess(
  resolved: readonly ResolvedConnectionEntry[],
  options: {
    cloudflare: boolean;
    timeoutMs: number;
    filter?: (connector: ResolvedApiConnection) => boolean;
  },
): ConnectionAccess {
  const entries = resolved
    .map(({ policy, connectors }) => ({
      policy,
      connectors: connectors.filter((connector) => options.filter?.(connector) ?? true),
    }))
    .filter(({ connectors }) => connectors.length > 0);
  const open = async (connectors: ResolvedApiConnection[]): Promise<ConnectionFetch | undefined> => {
    const fetch = await createConnectionScopedFetch(connectors, {
      cloudflare: options.cloudflare,
      timeoutMs: options.timeoutMs,
    });
    if (!fetch) return undefined;
    return { fetch, secrets: connectionSecrets(connectors) };
  };
  return {
    connections: entries.map(({ policy, connectors }) => ({
      id: policy.id,
      displayName: policy.displayName,
      allowedHosts: unique(connectors.flatMap(({ allowedHosts }) => allowedHosts)),
      pathPrefixes: unique(connectors.flatMap(({ pathPrefixes }) => pathPrefixes)),
      allowedMethods: unique(connectors.flatMap(({ allowedMethods }) => allowedMethods.map((m) => m.toUpperCase()))),
      urlPrefixes: unique(connectors.flatMap(({ allowedHosts, pathPrefixes }) =>
        allowedHosts.flatMap((host) =>
          (pathPrefixes.length > 0 ? pathPrefixes : ['']).map((prefix) =>
            'https://' + host + prefix.replace(/\/+$/, ''))))),
      headerName: policy.headerName,
    })),
    fetchFor: async (connectionId) => {
      const entry = entries.find(({ policy }) => policy.id === connectionId);
      return entry ? open(entry.connectors) : undefined;
    },
    fetchAll: () => open(entries.flatMap(({ connectors }) => connectors)),
  };
}

/** Each credential value and its tail after a scheme prefix such as `Bearer `. */
function connectionSecrets(connectors: readonly ResolvedApiConnection[]): string[] {
  return connectors.flatMap(({ headerValue }) => [headerValue, headerValue.replace(/^\S+\s+/, '')]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
