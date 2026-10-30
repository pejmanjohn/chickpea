export const MCP_WORKSPACE_SCOPE = 'chickpea:workspace';
export const MCP_OFFLINE_SCOPE = 'offline_access';
export const MCP_OAUTH_SCOPES: readonly string[] = Object.freeze([MCP_WORKSPACE_SCOPE, MCP_OFFLINE_SCOPE]);
const MCP_RESOURCE_PATH = '/mcp';
const MAX_MCP_DCR_BODY_BYTES = 16 * 1024;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_GRANTS = new Set(['authorization_code', 'refresh_token']);

/** Each error that registration validation refuses a client's metadata with. */
export const MCP_CLIENT_REGISTRATION_DENIALS = [
  'client_metadata_too_large',
  'invalid_client_metadata',
  'invalid_client_name',
  'invalid_redirect_uri',
  'invalid_scope',
  'public_clients_only',
  'request_too_large',
  'unsupported_application_type',
  'unsupported_grant_type',
  'unsupported_response_type',
] as const;
export type McpClientRegistrationDenial = typeof MCP_CLIENT_REGISTRATION_DENIALS[number];

type McpClientRegistrationValidation =
  | { ok: true; registration: Record<string, unknown> }
  | { ok: false; code: McpClientRegistrationDenial };

export function mcpResourceForOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError('MCP origin must be an absolute URL.');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('MCP origin must not contain credentials.');
  }
  if (parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new TypeError('MCP origin must not contain a path, query, or fragment.');
  }
  if (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new TypeError('MCP origin must use HTTPS except for loopback development.');
  }
  return `${parsed.origin}${MCP_RESOURCE_PATH}`;
}

export function validatePublicMcpClientRegistration(
  value: unknown,
): McpClientRegistrationValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return denied('invalid_client_metadata');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return denied('invalid_client_metadata');
  }
  if (Buffer.byteLength(encoded) > MAX_MCP_DCR_BODY_BYTES) {
    return denied('client_metadata_too_large');
  }

  const input = value as Record<string, unknown>;
  if (input.token_endpoint_auth_method !== 'none') {
    return denied('public_clients_only');
  }
  if (input.application_type !== undefined &&
      input.application_type !== 'native' && input.application_type !== 'web') {
    return denied('unsupported_application_type');
  }
  if (typeof input.client_name !== 'string' || !input.client_name.trim() ||
      input.client_name.length > 120) {
    return denied('invalid_client_name');
  }

  const grants = stringList(input.grant_types);
  if (!grants || !grants.includes('authorization_code') ||
      grants.some((grant) => !ALLOWED_GRANTS.has(grant))) {
    return denied('unsupported_grant_type');
  }
  const responseTypes = stringList(input.response_types);
  if (!responseTypes || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    return denied('unsupported_response_type');
  }
  if (input.scope !== undefined) {
    if (typeof input.scope !== 'string') return denied('invalid_scope');
    const scopes = input.scope.split(/\s+/).filter(Boolean);
    if (!scopes.includes(MCP_WORKSPACE_SCOPE) || scopes.some((scope) => !MCP_OAUTH_SCOPES.includes(scope))) {
      return denied('invalid_scope');
    }
  }

  const redirects = stringList(input.redirect_uris);
  if (!redirects || !redirects.length || redirects.length > 10 ||
      redirects.some((redirect) => !validRedirectUri(redirect))) {
    return denied('invalid_redirect_uri');
  }
  if (input.jwks !== undefined || input.jwks_uri !== undefined ||
      input.token_endpoint_auth_signing_alg !== undefined) {
    return denied('public_clients_only');
  }
  // application_type is OpenID Connect registration, not RFC 7591, so MCP
  // clients may omit it. Better Auth would then assume web and refuse a
  // loopback redirect. Infer it as the MCP TypeScript SDK does.
  const applicationType = input.application_type ??
    (redirects.some((redirect) => isLoopbackHost(new URL(redirect).hostname)) ? 'native' : 'web');
  return { ok: true, registration: { ...input, application_type: applicationType } };
}

function denied(code: McpClientRegistrationDenial): McpClientRegistrationValidation {
  return { ok: false, code };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

function validRedirectUri(value: string): boolean {
  if (!value || value.includes('*')) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) =>
    /^\d+$/.test(octet) && Number(octet) <= 255);
}
