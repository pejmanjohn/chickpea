import type { NetworkConfig } from 'just-bash';

import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

export type EgressMode = 'allowlist' | 'open' | 'off';

export interface EgressPolicy {
  mode: EgressMode;
  domains: string[];
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
): NetworkConfig {
  const network: NetworkConfig = {
    allowedMethods: ['GET', 'HEAD', 'POST'],
    denyPrivateRanges: true,
  };

  if (opts.cloudflare) {
    // just-bash marks _dnsResolve @internal, so this hook carries rename risk.
    network._dnsResolve = dohResolve;
  }

  if (policy.mode === 'open') {
    network.dangerouslyAllowFullInternetAccess = true;
    return network;
  }

  network.allowedUrlPrefixes =
    policy.mode === 'off'
      ? []
      : [
          ...new Set(
            policy.domains
              .map(normalizeDomain)
              .filter((domain): domain is string => domain !== undefined),
          ),
        ];
  return network;
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
