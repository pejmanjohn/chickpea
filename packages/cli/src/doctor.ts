import { MCP_WORKSPACE_SCOPE, mcpUrl } from './origin.ts';

export interface DoctorCheck {
  id: 'protected_resource' | 'authorization_server' | 'jwks' | 'mcp_challenge';
  label: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  origin: string;
  mcpUrl: string;
  ok: boolean;
  /** True when the auth surface answered 404, which a fresh deployment does until Slack setup completes. */
  setupIncomplete: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SETUP_INCOMPLETE = 'HTTP 404: the deployment has not finished setup. Open its private setup link, complete Slack setup, and rerun doctor.';

type Probe =
  | { kind: 'response'; status: number; headers: Headers; body: unknown; text: string }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'error'; message: string };

/**
 * The unauthenticated half of `scripts/verify-management-mcp.mjs`, run from
 * outside the checkout: discovery documents, the signing keys, and the 401
 * challenge every MCP client relies on to start OAuth.
 */
export async function runDoctor(origin: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const resource = mcpUrl(origin);
  const issuer = `${origin}/api/auth`;
  const checks: DoctorCheck[] = [];
  let setupIncomplete = false;

  const probe = async (path: string, init: RequestInit = {}): Promise<Probe> => {
    try {
      const response = await fetchFn(new URL(path, origin), {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        return { kind: 'redirect', status: response.status, location: response.headers.get('location') ?? '' };
      }
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = undefined; }
      return { kind: 'response', status: response.status, headers: response.headers, body, text };
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  };

  const failureDetail = (result: Probe, expected: string): string | undefined => {
    if (result.kind === 'error') return `request failed (${result.message})`;
    if (result.kind === 'redirect') {
      return `HTTP ${result.status} redirect to ${describeLocation(result.location)}; use the deployment's canonical origin`;
    }
    if (result.status === 404) {
      setupIncomplete = true;
      return SETUP_INCOMPLETE;
    }
    if (result.status !== 200) return `HTTP ${result.status}; expected ${expected}`;
    if (!result.body || typeof result.body !== 'object') return 'response is not a JSON document';
    return undefined;
  };

  // 1. Protected resource metadata
  {
    const result = await probe('/.well-known/oauth-protected-resource/mcp', { headers: { accept: 'application/json' } });
    const failure = failureDetail(result, 'HTTP 200 with JSON metadata');
    if (failure) {
      checks.push({ id: 'protected_resource', label: 'protected resource metadata', ok: false, detail: failure });
    } else {
      const body = (result as Extract<Probe, { kind: 'response' }>).body as Record<string, unknown>;
      const servers = Array.isArray(body.authorization_servers) ? body.authorization_servers : [];
      const scopes = Array.isArray(body.scopes_supported) ? body.scopes_supported : [];
      const problems: string[] = [];
      if (body.resource !== resource) {
        problems.push(`resource is ${String(body.resource)}, not ${resource} (the deployment's canonical origin differs from the URL you used)`);
      }
      if (servers.length !== 1 || servers[0] !== issuer) {
        problems.push(`authorization_servers is ${JSON.stringify(servers)}, expected ["${issuer}"]`);
      }
      if (!scopes.includes(MCP_WORKSPACE_SCOPE)) problems.push(`scopes_supported lacks ${MCP_WORKSPACE_SCOPE}`);
      checks.push({
        id: 'protected_resource',
        label: 'protected resource metadata',
        ok: problems.length === 0,
        detail: problems.length ? problems.join('; ') : `${resource} is protected by ${issuer}`,
      });
    }
  }

  // 2. Authorization server metadata
  {
    const result = await probe('/.well-known/oauth-authorization-server/api/auth', { headers: { accept: 'application/json' } });
    const failure = failureDetail(result, 'HTTP 200 with JSON metadata');
    if (failure) {
      checks.push({ id: 'authorization_server', label: 'authorization server metadata', ok: false, detail: failure });
    } else {
      const body = (result as Extract<Probe, { kind: 'response' }>).body as Record<string, unknown>;
      const problems: string[] = [];
      if (body.issuer !== issuer) problems.push(`issuer is ${String(body.issuer)}, expected ${issuer}`);
      for (const [key, path] of [
        ['authorization_endpoint', '/api/auth/oauth2/authorize'],
        ['token_endpoint', '/api/auth/oauth2/token'],
        ['registration_endpoint', '/api/auth/oauth2/register'],
        ['revocation_endpoint', '/api/auth/oauth2/revoke'],
      ] as const) {
        if (body[key] !== `${origin}${path}`) problems.push(`${key} is ${String(body[key])}, expected ${origin}${path}`);
      }
      const methods = Array.isArray(body.code_challenge_methods_supported) ? body.code_challenge_methods_supported : [];
      if (!methods.includes('S256')) problems.push('code_challenge_methods_supported lacks S256');
      const scopes = Array.isArray(body.scopes_supported) ? body.scopes_supported : [];
      if (!scopes.includes(MCP_WORKSPACE_SCOPE)) problems.push(`scopes_supported lacks ${MCP_WORKSPACE_SCOPE}`);
      checks.push({
        id: 'authorization_server',
        label: 'authorization server metadata',
        ok: problems.length === 0,
        detail: problems.length ? problems.join('; ') : 'PKCE S256, dynamic registration, token and revocation endpoints published',
      });
    }
  }

  // 3. JWKS
  {
    const result = await probe('/api/auth/jwks', { headers: { accept: 'application/json' } });
    const failure = failureDetail(result, 'HTTP 200 with a JWK set');
    if (failure) {
      checks.push({ id: 'jwks', label: 'signing keys (JWKS)', ok: false, detail: failure });
    } else {
      const body = (result as Extract<Probe, { kind: 'response' }>).body as Record<string, unknown>;
      const keys = Array.isArray(body.keys) ? body.keys : [];
      checks.push({
        id: 'jwks',
        label: 'signing keys (JWKS)',
        ok: keys.length > 0,
        detail: keys.length > 0 ? `${keys.length} key${keys.length === 1 ? '' : 's'} published` : 'JWK set is empty',
      });
    }
  }

  // 4. Unauthenticated MCP challenge
  {
    const result = await probe('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'doctor', method: 'tools/list', params: {} }),
    });
    if (result.kind === 'error') {
      checks.push({ id: 'mcp_challenge', label: 'MCP challenge without a token', ok: false, detail: `request failed (${result.message})` });
    } else if (result.kind === 'redirect') {
      checks.push({ id: 'mcp_challenge', label: 'MCP challenge without a token', ok: false, detail: `HTTP ${result.status} redirect to ${describeLocation(result.location)}; use the deployment's canonical origin` });
    } else if (result.status === 404) {
      setupIncomplete = true;
      checks.push({ id: 'mcp_challenge', label: 'MCP challenge without a token', ok: false, detail: SETUP_INCOMPLETE });
    } else if (result.status !== 401) {
      checks.push({ id: 'mcp_challenge', label: 'MCP challenge without a token', ok: false, detail: `HTTP ${result.status}; expected 401 with a WWW-Authenticate challenge` });
    } else {
      const challenge = result.headers.get('www-authenticate') ?? '';
      const metadata = /resource_metadata="?([^",\s]+)"?/.exec(challenge)?.[1];
      let detail: string;
      let ok = false;
      if (!metadata) {
        detail = 'HTTP 401 without resource_metadata in WWW-Authenticate';
      } else if (safeOrigin(metadata) !== origin) {
        detail = `challenge points at ${metadata}, which is not on ${origin}`;
      } else {
        ok = true;
        detail = `HTTP 401 with resource_metadata=${metadata}`;
      }
      checks.push({ id: 'mcp_challenge', label: 'MCP challenge without a token', ok, detail });
    }
  }

  return {
    origin,
    mcpUrl: resource,
    ok: checks.every((check) => check.ok),
    setupIncomplete,
    checks,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.label}: ${check.detail}`);
  const failed = report.checks.filter((check) => !check.ok).length;
  if (report.ok) {
    lines.push(`Doctor: ready. Connect MCP clients to ${report.mcpUrl} (see: chickpea mcp config ${report.origin}).`);
  } else if (report.setupIncomplete) {
    lines.push(`Doctor: ${failed} check${failed === 1 ? '' : 's'} failed. The deployment has not finished setup.`);
  } else {
    lines.push(`Doctor: ${failed} check${failed === 1 ? '' : 's'} failed.`);
  }
  return lines.join('\n');
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function describeLocation(location: string): string {
  if (!location) return 'an unspecified location';
  return safeOrigin(location) ?? location;
}
