import { CliError } from './errors.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const MCP_RESOURCE_PATH = '/mcp';
export const MCP_WORKSPACE_SCOPE = 'chickpea:workspace';

export function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
}

/**
 * Mirrors the server's `mcpResourceForOrigin` rules: HTTPS or loopback HTTP,
 * no credentials, no query or fragment. A trailing `/` or `/mcp` is accepted
 * and dropped so a pasted MCP URL still resolves to its deployment origin.
 */
export function normalizeDeploymentOrigin(input: string): string {
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new CliError('INVALID_URL', `"${trimmed}" is not a deployment URL`, 'Pass the origin, for example https://chickpea.example.com');
  }
  if (parsed.username || parsed.password) {
    throw new CliError('INVALID_URL', 'The deployment URL must not contain credentials', 'Pass the bare origin, for example https://chickpea.example.com');
  }
  if (parsed.search || parsed.hash) {
    throw new CliError('INVALID_URL', 'The deployment URL must not contain a query or fragment', 'Pass the bare origin, for example https://chickpea.example.com');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== MCP_RESOURCE_PATH) {
    throw new CliError('INVALID_URL', `The deployment URL must not contain a path (got ${parsed.pathname})`, 'Pass the bare origin, for example https://chickpea.example.com');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new CliError('INVALID_URL', 'The deployment URL must use HTTPS (plain HTTP is allowed only for loopback development)', 'Use https://<host> or http://127.0.0.1:<port>');
  }
  return parsed.origin;
}

export function mcpUrl(origin: string): string {
  return `${origin}${MCP_RESOURCE_PATH}`;
}
