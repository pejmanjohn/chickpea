import { McpBlockedUrlError } from './mcp-errors.ts';
import { isCloudflareTarget } from './runtime-target.ts';

/**
 * SSRF guard for user-supplied MCP server URLs. The node lane can reach
 * localhost and RFC-1918 space directly, so private targets are rejected
 * up front — at save/test time in the admin routes and again at turn time.
 */
type McpUrlResult = { ok: true; url: string } | { ok: false; reason: string };

interface McpResolvedAddress {
  address: string;
  family: number;
}

export type McpAddressResolver = (
  hostname: string,
) => Promise<readonly McpResolvedAddress[]>;

type McpPinnedFetch = (
  request: Request,
  addresses: readonly McpResolvedAddress[],
) => Promise<Response>;

export interface McpGuardedFetchOptions {
  /** Workers/test seam; production Workers delegate to global fetch. */
  fetch?: typeof fetch;
  /** Node test seam; production uses an HTTPS request pinned to these answers. */
  pinnedFetch?: McpPinnedFetch;
  /** Test seam; production uses node:dns on the Node lane. */
  resolveAddresses?: McpAddressResolver;
  /** Runtime override for tests. */
  cloudflare?: boolean;
  /** Abort the whole MCP connection attempt, including response streams. */
  signal?: AbortSignal;
  /** Pin every request the transport makes to the configured MCP origin. */
  allowedOrigin?: string;
  /** Defaults to five same-origin redirects. */
  maxRedirects?: number;
}

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost'];
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADER_NAMES = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
];

export function validateMcpUrl(raw: string): McpUrlResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Enter a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'MCP server URLs must use https.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed.' };
  }
  const rawHost = url.hostname.toLowerCase();
  // A single trailing dot marks a root-anchored FQDN: `localhost.` resolves
  // exactly like `localhost`, so without stripping it the blocklist below is
  // trivially dodged by appending a dot. IPv6 literals never carry one.
  const host = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  const bracketless = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || BLOCKED_HOSTNAME_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'Local and internal hostnames are not allowed.' };
  }
  if (isIpv4(bracketless)) {
    if (!isPublicIpv4(bracketless)) {
      return { ok: false, reason: 'Private and internal IP addresses are not allowed.' };
    }
  } else if (bracketless.includes(':')) {
    if (!isPublicIpv6(bracketless)) {
      return { ok: false, reason: 'Private and internal IP addresses are not allowed.' };
    }
  } else if (!host.includes('.')) {
    return { ok: false, reason: 'Bare hostnames are not allowed — use a fully qualified domain.' };
  }
  url.hash = '';
  // Return the dot-stripped host so the persisted/fetched URL matches what the
  // guard actually validated (no trailing-dot variant slips downstream).
  if (rawHost.endsWith('.')) {
    url.hostname = host;
  }
  return { ok: true, url: url.toString() };
}

/**
 * Fetch implementation for Flue's MCP transports.
 *
 * Redirects are handled manually so every hop goes through the URL/DNS guard.
 * Cross-origin redirects are rejected outright because MCP custom-header auth
 * can use ANY header name; stripping only `Authorization` would still leak an
 * operator's `X-Api-Key` (or equivalent) to the redirected origin.
 *
 * Node resolves every hostname before each request and rejects the entire DNS
 * answer set if any address is not globally routable. Workers do not expose a
 * DNS API, so that lane retains the literal/hostname guard and relies on the
 * platform fetch implementation for address routing while still enforcing the
 * redirect and origin rules here.
 */
export function createMcpGuardedFetch(options: McpGuardedFetchOptions = {}): typeof fetch {
  const delegate = options.fetch ?? globalThis.fetch;
  const pinnedFetch = options.pinnedFetch ?? nodePinnedFetch;
  const resolveAddresses = options.resolveAddresses ?? resolveNodeAddresses;
  const cloudflare = options.cloudflare ?? isCloudflareTarget();
  const allowedOrigin =
    options.allowedOrigin === undefined ? undefined : new URL(options.allowedOrigin).origin;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError('maxRedirects must be a non-negative integer');
  }

  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const initial = new Request(input, init);
    const originalSignal = initial.signal;
    const body = initial.body === null ? undefined : await initial.clone().arrayBuffer();
    let url = new URL(initial.url);
    let method = initial.method;
    const headers = new Headers(initial.headers);
    let redirects = 0;

    while (true) {
      const destination = await guardMcpDestination(url, {
        cloudflare,
        resolveAddresses,
        allowedOrigin,
      });
      url = destination.url;
      const signal = combinedSignal(originalSignal, options.signal);
      const outbound = new Request(url, {
        method,
        headers,
        ...(body !== undefined && method !== 'GET' && method !== 'HEAD'
          ? { body: body.slice(0) }
          : {}),
        redirect: 'manual',
        signal,
      });
      const response = cloudflare
        ? await delegate(outbound)
        : await pinnedFetch(outbound, destination.addresses);
      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }

      const location = response.headers.get('location');
      if (location === null) {
        return response;
      }
      if (redirects >= maxRedirects) {
        await cancelBody(response);
        throw new Error('Too many redirects while connecting to the MCP server.');
      }

      const nextUrl = new URL(location, url);
      const validatedNext = validateMcpUrl(nextUrl.href);
      if (!validatedNext.ok) {
        await cancelBody(response);
        throw new McpBlockedUrlError(validatedNext.reason);
      }
      const normalizedNext = new URL(validatedNext.url);
      if (normalizedNext.origin !== url.origin) {
        await cancelBody(response);
        throw new McpBlockedUrlError('Cross-origin redirects are not allowed.');
      }

      await cancelBody(response);
      if (
        (response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        method = 'GET';
        for (const name of BODY_HEADER_NAMES) headers.delete(name);
      }
      url = normalizedNext;
      redirects += 1;
    }
  };

  return guardedFetch as typeof fetch;
}

async function guardMcpDestination(
  url: URL,
  options: {
    cloudflare: boolean;
    resolveAddresses: McpAddressResolver;
    allowedOrigin: string | undefined;
  },
): Promise<{ url: URL; addresses: readonly McpResolvedAddress[] }> {
  const validated = validateMcpUrl(url.href);
  if (!validated.ok) {
    throw new McpBlockedUrlError(validated.reason);
  }
  const normalized = new URL(validated.url);
  if (options.allowedOrigin !== undefined && normalized.origin !== options.allowedOrigin) {
    throw new McpBlockedUrlError('Requests outside the configured origin are not allowed.');
  }
  if (options.cloudflare) {
    return { url: normalized, addresses: [] };
  }

  const host = normalized.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIpAddress(host)
    ? [{ address: host, family: host.includes(':') ? 6 : 4 }]
    : await options.resolveAddresses(host);
  if (addresses.length === 0) {
    throw new Error('DNS returned no addresses for MCP server hostname.');
  }
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new McpBlockedUrlError(
      'The MCP server hostname resolves to a private or reserved IP address.',
    );
  }
  return { url: normalized, addresses };
}

async function resolveNodeAddresses(hostname: string): Promise<readonly McpResolvedAddress[]> {
  const { lookup } = await import('node:dns/promises');
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Node-only HTTPS fetch with DNS pinning. The URL hostname remains unchanged so
 * TLS certificate verification and SNI use the configured MCP host, while the
 * custom lookup can return only the public addresses validated immediately
 * before this call. Native fetch is intentionally not used here: it would do a
 * second DNS lookup and reopen the rebinding window.
 */
/**
 * Exported so the security-critical transport wiring can be exercised without
 * making a real network request. Production callers omit `requestHttps` and
 * use Node's HTTPS implementation; tests inject only that final I/O boundary.
 */
export async function nodePinnedFetch(
  request: Request,
  addresses: readonly McpResolvedAddress[],
  requestHttps?: typeof import('node:https').request,
): Promise<Response> {
  const [httpsRequest, { Readable }] = await Promise.all([
    requestHttps === undefined
      ? import('node:https').then(({ request: nodeHttpsRequest }) => nodeHttpsRequest)
      : Promise.resolve(requestHttps),
    import('node:stream'),
  ]);
  const payload = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers) headers[name] = value;

  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpsRequest(
      request.url,
      {
        method: request.method,
        headers,
        // Never reuse a process-global socket whose DNS lookup may have
        // happened outside this guard. A one-off agent guarantees this
        // request invokes the pinned lookup above before it connects.
        agent: false,
        lookup: createPinnedLookup(addresses),
        signal: request.signal,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
        }
        const status = incoming.statusCode ?? 502;
        const hasBody = request.method !== 'HEAD' && ![101, 204, 205, 304].includes(status);
        const responseBody = hasBody
          ? (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>)
          : null;
        resolve(
          new Response(responseBody, {
            status,
            headers: responseHeaders,
            ...(incoming.statusMessage === undefined
              ? {}
              : { statusText: incoming.statusMessage }),
          }),
        );
      },
    );
    outgoing.once('error', reject);
    if (payload === undefined) outgoing.end();
    else outgoing.end(payload);
  });
}

function createPinnedLookup(
  addresses: readonly McpResolvedAddress[],
): import('node:net').LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    const requestedFamily =
      lookupOptions.family === 'IPv4'
        ? 4
        : lookupOptions.family === 'IPv6'
          ? 6
          : lookupOptions.family;
    const eligible = addresses.filter(
      ({ family }) => requestedFamily === undefined || requestedFamily === 0 || family === requestedFamily,
    );
    if (eligible.length === 0) {
      const error = new Error('No validated address matches the requested IP family.') as NodeJS.ErrnoException;
      error.code = 'EAI_ADDRFAMILY';
      callback(error, '');
      return;
    }
    if (lookupOptions.all) {
      callback(
        null,
        eligible.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    const selected = eligible[0];
    if (selected === undefined) {
      callback(new Error('No validated MCP address is available.'), '');
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function combinedSignal(requestSignal: AbortSignal, connectionSignal: AbortSignal | undefined) {
  return connectionSignal === undefined
    ? requestSignal
    : AbortSignal.any([requestSignal, connectionSignal]);
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isIpAddress(host: string): boolean {
  return isIpv4(host) || host.includes(':');
}

function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpv4(normalized)) return isPublicIpv4(normalized);
  if (normalized.includes(':')) return isPublicIpv6(normalized);
  return false;
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPublicIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part > 255)) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmark testing
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  return true;
}

function isPublicIpv6(host: string): boolean {
  const words = ipv6Words(host);
  if (words === undefined) return false;

  // RFC 6052's well-known NAT64 prefix (64:ff9b::/96) is commonly returned
  // alongside A records on DNS64-enabled hosts, including macOS networks. It
  // is safe only to the same extent as the IPv4 destination encoded in its
  // final 32 bits, so apply the existing IPv4 policy rather than treating the
  // entire transition prefix as either globally public or categorically
  // reserved.
  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0) &&
    words[6] !== undefined &&
    words[7] !== undefined
  ) {
    const hi = words[6];
    const lo = words[7];
    return isPublicIpv4(
      [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'),
    );
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96) inherits the embedded IPv4 policy.
  if (
    words.slice(0, 5).every((word) => word === 0) &&
    words[5] === 0xffff &&
    words[6] !== undefined &&
    words[7] !== undefined
  ) {
    const hi = words[6];
    const lo = words[7];
    return isPublicIpv4(
      [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'),
    );
  }

  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  // Only global-unicast 2000::/3 is eligible; this excludes unspecified,
  // loopback, ULA, link-local, multicast, and other special-use blocks.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second <= 0x01ff) return false; // IETF special-purpose /23
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4
  if (first === 0x3fff && (second & 0xf000) === 0) return false; // documentation /20
  return true;
}

function ipv6Words(host: string): number[] | undefined {
  let normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized.includes('%')) return undefined;

  const dottedTail = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (dottedTail?.[2]) {
    if (!isIpv4(dottedTail[2])) return undefined;
    const bytes = dottedTail[2].split('.').map(Number);
    if (bytes.some((part) => !Number.isInteger(part) || part > 255)) return undefined;
    normalized =
      normalized.slice(0, -dottedTail[2].length) +
      (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)).toString(16) +
      ':' +
      (((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)).toString(16);
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = parseIpv6Half(halves[0] ?? '');
  const right = parseIpv6Half(halves[1] ?? '');
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;

  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Half(value: string): number[] | undefined {
  if (value === '') return [];
  const parts = value.split(':');
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.map((part) => parseInt(part, 16));
}
