import type { NetworkConfig, SecureFetch } from 'just-bash';

import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

export type EgressMode = 'allowlist' | 'open' | 'off';

export interface EgressPolicy {
  mode: EgressMode;
  domains: string[];
}

export interface ResolvedApiConnection {
  allowedHosts: string[];
  pathPrefixes: string[];
  headerName: string;
  headerValue: string;
  allowedMethods: string[];
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  mode: 'allowlist',
  domains: [],
};

export const EGRESS_SETTING_KEY = 'egress.policy';

interface DnsAnswer {
  type?: unknown;
  data?: unknown;
}

interface DnsResponse {
  Answer?: unknown;
}

type DnsResult = { address: string; family: number };

interface EgressEntry {
  url: string;
  transform?: [{ headers: Record<string, string> }];
  methods: string[];
}

export interface EgressMethodEntry {
  prefix: string;
  methods: Set<string>;
}

// The methods permitted for any host NOT governed by a specific connection —
// operator "Domains" and, in `open` mode, arbitrary internet hosts. A connector
// requesting a broader method must not widen this baseline for unrelated hosts.
export const BASE_EGRESS_METHODS = ['GET', 'HEAD', 'POST'] as const;

const dnsCache = new Map<string, Promise<DnsResult[]>>();

export function parseEgressPolicy(raw: string | undefined): EgressPolicy {
  if (raw === undefined) return DEFAULT_EGRESS_POLICY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_EGRESS_POLICY;
  }

  if (!isEgressPolicyShape(parsed)) return DEFAULT_EGRESS_POLICY;

  return {
    mode: parsed.mode,
    domains: [...new Set(parsed.domains.map((domain) => domain.trim()).filter(Boolean))],
  };
}

export async function resolveEgressPolicy(env?: PlatformEnv): Promise<EgressPolicy> {
  return parseEgressPolicy(await getSettingsStore(env).getSetting(EGRESS_SETTING_KEY));
}

export function buildEgressNetworkConfig(
  policy: EgressPolicy,
  opts: { cloudflare: boolean },
  connectors: ResolvedApiConnection[] = [],
): NetworkConfig {
  return buildEgressPlan(policy, opts, connectors).network;
}

export function buildEgressPlan(
  policy: EgressPolicy,
  opts: { cloudflare: boolean },
  connectors: ResolvedApiConnection[] = [],
): { network: NetworkConfig; methodMap: EgressMethodEntry[] } {
  const entries = buildEgressEntries(policy, connectors);
  const allowedMethods = [
    ...new Set([
      ...BASE_EGRESS_METHODS,
      ...connectors.flatMap((connector) => connector.allowedMethods),
    ]),
  ] as NonNullable<NetworkConfig['allowedMethods']>;
  const network: NetworkConfig = {
    // This global union remains the graceful fallback when just-bash's
    // unsupported secureFetch property is unavailable.
    allowedMethods,
    denyPrivateRanges: true,
  };

  if (opts.cloudflare) {
    // just-bash marks _dnsResolve @internal, so this hook carries rename risk.
    network._dnsResolve = dohResolve;
  }

  if (policy.mode === 'open') {
    network.dangerouslyAllowFullInternetAccess = true;
  } else {
    network.allowedUrlPrefixes = [];
  }

  if (entries.length > 0) {
    network.allowedUrlPrefixes = entries.map(({ url, transform }) =>
      transform === undefined ? url : { url, transform },
    );
  }

  return {
    network,
    methodMap: entries
      .map(({ url, methods }) => ({ prefix: url, methods: new Set(methods) }))
      .sort((left, right) => right.prefix.length - left.prefix.length),
  };
}

// Match a request URL against a method-map prefix using the SAME semantics as
// just-bash's allow-list: exact origin, then path-segment boundaries — NOT a
// raw string prefix. Without this a connector prefix `/v1` would wrongly match
// `/v10` (a sibling path served by a broader allow-list entry), leaking the
// connector's methods onto a path it does not govern.
function matchesEgressPrefix(url: string, prefix: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(prefix);
  } catch {
    return false;
  }
  if (target.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (basePath === '') return true; // whole-origin entry allows any path
  return target.pathname === basePath || target.pathname.startsWith(basePath + '/');
}

export function createMethodEnforcingFetch(
  delegate: SecureFetch,
  methodMap: EgressMethodEntry[],
): SecureFetch {
  const baseMethods = new Set<string>(BASE_EGRESS_METHODS);
  return async (url, options) => {
    const method = (options?.method || 'GET').toUpperCase();
    const match = methodMap.find((entry) => matchesEgressPrefix(url, entry.prefix));
    // A URL matching no connector/domain prefix (only reachable in `open` mode)
    // is held to the read/create baseline — a connector's extra methods never
    // widen access to unrelated internet hosts.
    const allowed = match ? match.methods : baseMethods;
    if (!allowed.has(method)) {
      const error = new Error(
        "HTTP method '" +
          method +
          "' not allowed. Allowed methods: " +
          [...allowed].join(', '),
      );
      error.name = 'MethodNotAllowedError';
      throw error;
    }
    return delegate(url, options);
  };
}

function buildEgressEntries(
  policy: EgressPolicy,
  connectors: ResolvedApiConnection[],
): EgressEntry[] {
  const entries: EgressEntry[] = [];

  if (policy.mode === 'allowlist') {
    for (const url of new Set(
      policy.domains
        .map(normalizeDomain)
        .filter((domain): domain is string => domain !== undefined),
    )) {
      entries.push({ url, methods: ['GET', 'HEAD'] });
    }
  }

  for (const connector of connectors.filter((candidate) => candidate.headerValue)) {
    for (const host of connector.allowedHosts) {
      for (const prefix of connector.pathPrefixes.length > 0 ? connector.pathPrefixes : ['']) {
        entries.push({
          url: 'https://' + host + prefix,
          transform: [{ headers: { [connector.headerName]: connector.headerValue } }],
          methods: connector.allowedMethods,
        });
      }
    }
  }

  return entries;
}

function isEgressPolicyShape(value: unknown): value is EgressPolicy {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as { mode?: unknown; domains?: unknown };
  return (
    (candidate.mode === 'allowlist' || candidate.mode === 'open' || candidate.mode === 'off') &&
    Array.isArray(candidate.domains) &&
    candidate.domains.every((domain) => typeof domain === 'string')
  );
}

function normalizeDomain(domain: string): string | undefined {
  const trimmed = domain.trim();
  if (trimmed === '') return undefined;

  const url = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// A-records only for now; IPv6/AAAA rebinding is not covered and needs a follow-up.
function dohResolve(hostname: string): Promise<DnsResult[]> {
  const cacheKey = hostname.toLowerCase();
  const cached = dnsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lookup = fetchDns(cacheKey);
  dnsCache.set(cacheKey, lookup);
  return lookup;
}

async function fetchDns(hostname: string): Promise<DnsResult[]> {
  const response = await globalThis.fetch(
    'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(hostname) + '&type=A',
    { headers: { accept: 'application/dns-json' } },
  );
  if (!response.ok) {
    throw new Error('DoH HTTP ' + response.status);
  }

  const payload = (await response.json()) as DnsResponse;
  const answers = Array.isArray(payload.Answer) ? (payload.Answer as DnsAnswer[]) : [];
  const results = answers
    .filter((answer) => answer.type === 1 && typeof answer.data === 'string')
    .map((answer) => ({ address: answer.data as string, family: 4 }));

  if (results.length === 0) {
    const error = new Error('DoH returned no A records for ' + hostname) as Error & {
      code?: string;
    };
    error.code = 'ENODATA';
    throw error;
  }

  return results;
}
