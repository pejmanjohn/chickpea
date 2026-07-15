/**
 * SSRF guard for user-supplied MCP server URLs. The node lane can reach
 * localhost and RFC-1918 space directly, so private targets are rejected
 * up front — at save/test time in the admin routes and again at turn time.
 * Hostname checks only (no DNS resolution pinning in v1).
 */
export type McpUrlResult = { ok: true; url: string } | { ok: false; reason: string };

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost'];

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
  const host = url.hostname.toLowerCase();
  const bracketless = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || BLOCKED_HOSTNAME_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'Local and internal hostnames are not allowed.' };
  }
  if (isIpv4(bracketless)) {
    if (isPrivateIpv4(bracketless)) {
      return { ok: false, reason: 'Private and internal IP addresses are not allowed.' };
    }
  } else if (bracketless.includes(':')) {
    if (isPrivateIpv6(bracketless)) {
      return { ok: false, reason: 'Private and internal IP addresses are not allowed.' };
    }
  } else if (!host.includes('.')) {
    return { ok: false, reason: 'Bare hostnames are not allowed — use a fully qualified domain.' };
  }
  url.hash = '';
  return { ok: true, url: url.toString() };
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.some((p) => Number.isNaN(p) || p > 255)) return true; // malformed → reject
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 ULA
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  // IPv4-mapped IPv6, dotted-quad form (::ffff:10.0.0.1).
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(h);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  // IPv4-mapped IPv6, hextet form — the WHATWG URL parser normalizes
  // ::ffff:10.0.0.1 to ::ffff:a00:1, so decode the low 32 bits to IPv4.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex?.[1] !== undefined && mappedHex[2] !== undefined) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
    return isPrivateIpv4(dotted);
  }
  return false;
}
