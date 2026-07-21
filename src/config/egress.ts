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

interface PrefixEntry {
  url: string;
  transform?: [{ headers: Record<string, string> }];
}

interface ConnectorScopeSpec {
  entries: PrefixEntry[];
  methods: string[];
}

// A per-connector egress scope: a network whose allow-list contains ONLY this
// connector's own hosts (with its credential transform) and whose methods are
// exactly this connector's. Each scope becomes its own secure-fetch delegate, so
// a redirect off a connector host cannot reach — or carry an elevated method to —
// any host outside the connector's own allow-list.
export interface EgressScope {
  prefixes: string[];
  methods: Set<string>;
  network: NetworkConfig;
}

export interface EgressPlan {
  scopes: EgressScope[];
  // Requests matching no connector scope (operator "Domains" and, in open mode,
  // arbitrary hosts) go through this network at the baseline method set.
  baseNetwork: NetworkConfig;
  baseMethods: Set<string>;
  // A single fail-closed network used only if just-bash stops exposing its
  // secureFetch property: every prefix (credentials still inject) but capped at
  // the baseline methods, so connector write methods are never granted globally.
  fallbackNetwork: NetworkConfig;
}

export interface ScopedDelegate {
  prefixes: string[];
  methods: Set<string>;
  delegate: SecureFetch;
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

// The combined network: every allow-listed prefix (domains + all connector
// transforms) under one global method set. Used for the descriptive whole-policy
// view and, at the baseline method set, for the fail-closed fallback network.
function buildCombinedNetwork(
  entries: PrefixEntry[],
  policy: EgressPolicy,
  opts: { cloudflare: boolean },
  methods: readonly string[],
): NetworkConfig {
  const network: NetworkConfig = {
    allowedMethods: [...methods] as NonNullable<NetworkConfig['allowedMethods']>,
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
  return network;
}

function unionMethods(connectors: ResolvedApiConnection[]): string[] {
  return [
    ...new Set([...BASE_EGRESS_METHODS, ...connectors.flatMap((c) => c.allowedMethods)]),
  ];
}

export function buildEgressNetworkConfig(
  policy: EgressPolicy,
  opts: { cloudflare: boolean },
  connectors: ResolvedApiConnection[] = [],
): NetworkConfig {
  const entries = [
    ...buildDomainEntries(policy),
    ...buildConnectorScopeSpecs(connectors).flatMap((spec) => spec.entries),
  ];
  return buildCombinedNetwork(entries, policy, opts, unionMethods(connectors));
}

export function buildEgressPlan(
  policy: EgressPolicy,
  opts: { cloudflare: boolean },
  connectors: ResolvedApiConnection[] = [],
): EgressPlan {
  const domainEntries = buildDomainEntries(policy);
  const connectorSpecs = buildConnectorScopeSpecs(connectors);

  // Operator domains keep the GET/HEAD baseline; open mode reaches arbitrary
  // hosts at the read/create baseline. Connector hosts are handled by their own
  // scopes, so neither the base nor the open path grants connector write methods.
  const baseMethods = new Set<string>(policy.mode === 'open' ? BASE_EGRESS_METHODS : ['GET', 'HEAD']);
  const baseNetwork = buildCombinedNetwork(domainEntries, policy, opts, [...baseMethods]);

  const scopes: EgressScope[] = connectorSpecs.map((spec) => ({
    prefixes: spec.entries.map((entry) => entry.url),
    methods: new Set(spec.methods),
    // A scope network is never open-internet: its allow-list is exactly this
    // connector's hosts, so a redirect target outside them is refused by
    // just-bash's own allow-list re-check on each redirect hop.
    network: buildScopeNetwork(spec, opts),
  }));

  const fallbackNetwork = buildCombinedNetwork(
    [...domainEntries, ...connectorSpecs.flatMap((spec) => spec.entries)],
    policy,
    opts,
    [...BASE_EGRESS_METHODS],
  );

  return { scopes, baseNetwork, baseMethods, fallbackNetwork };
}

function buildScopeNetwork(spec: ConnectorScopeSpec, opts: { cloudflare: boolean }): NetworkConfig {
  const network: NetworkConfig = {
    allowedMethods: [...new Set(spec.methods)] as NonNullable<NetworkConfig['allowedMethods']>,
    denyPrivateRanges: true,
    allowedUrlPrefixes: spec.entries.map(({ url, transform }) =>
      transform === undefined ? url : { url, transform },
    ),
  };
  if (opts.cloudflare) {
    network._dnsResolve = dohResolve;
  }
  return network;
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

// Route each request to the delegate that owns its URL: a connector scope (whose
// own secure-fetch enforces that connector's hosts and methods, including across
// redirects) when a prefix matches, otherwise the base delegate at the baseline
// method set. A connector's write methods can therefore only ever reach that
// connector's own hosts.
export function createScopedFetch(params: {
  scopes: ScopedDelegate[];
  baseDelegate: SecureFetch;
  baseMethods: Set<string>;
}): SecureFetch {
  const routes = params.scopes
    .flatMap((scope) =>
      scope.prefixes.map((prefix) => ({
        prefix,
        methods: scope.methods,
        delegate: scope.delegate,
      })),
    )
    .sort((left, right) => right.prefix.length - left.prefix.length);

  return async (url, options) => {
    const method = (options?.method || 'GET').toUpperCase();
    const route = routes.find((entry) => matchesEgressPrefix(url, entry.prefix));
    const allowed = route ? route.methods : params.baseMethods;
    if (!allowed.has(method)) {
      const error = new Error(
        "HTTP method '" + method + "' not allowed. Allowed methods: " + [...allowed].join(', '),
      );
      error.name = 'MethodNotAllowedError';
      throw error;
    }
    return (route ? route.delegate : params.baseDelegate)(url, options);
  };
}

function buildDomainEntries(policy: EgressPolicy): PrefixEntry[] {
  if (policy.mode !== 'allowlist') return [];
  return [
    ...new Set(
      policy.domains
        .map(normalizeDomain)
        .filter((domain): domain is string => domain !== undefined),
    ),
  ].map((url) => ({ url }));
}

function buildConnectorScopeSpecs(connectors: ResolvedApiConnection[]): ConnectorScopeSpec[] {
  return connectors
    .filter((connector) => connector.headerValue)
    .map((connector) => {
      const prefixes = connector.pathPrefixes.length > 0 ? connector.pathPrefixes : [''];
      const entries: PrefixEntry[] = connector.allowedHosts.flatMap((host) =>
        prefixes.map((prefix) => ({
          // Strip trailing slashes so routing (matchesEgressPrefix, which
          // normalizes) and enforcement (just-bash's raw allow-list entry) use
          // identical prefix semantics — otherwise `/v1/` would route into a
          // scope whose network rejects the very same URL.
          url: 'https://' + host + prefix.replace(/\/+$/, ''),
          transform: [{ headers: { [connector.headerName]: connector.headerValue } }] as [
            { headers: Record<string, string> },
          ],
        })),
      );
      return { entries, methods: connector.allowedMethods };
    });
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
