import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import {
  createBetterAuth,
  requireSupportedOrigin,
  type BetterAuthPrivateSeam,
} from './better-auth.ts';
import { validatePublicMcpClientRegistration } from './mcp-oauth.ts';
import { validateBrowserMutationProvenance } from './request-provenance.ts';
import { requestAuthSourceKey } from './source-key.ts';
import { emitManagementMetric } from '../management/telemetry.ts';

const MAX_AUTH_BODY_BYTES = 32 * 1024;
type PublicRoute = 'read' | 'browser-mutation' | 'protocol-mutation' | 'registration';

const PUBLIC_ROUTES = new Map<string, PublicRoute>([
  ['GET /.well-known/oauth-protected-resource', 'read'],
  ['GET /.well-known/oauth-protected-resource/mcp', 'read'],
  ['GET /.well-known/oauth-authorization-server/api/auth', 'read'],
  ['GET /api/auth/.well-known/oauth-authorization-server', 'read'],
  ['GET /api/auth/get-session', 'read'],
  ['GET /api/auth/jwks', 'read'],
  ['GET /api/auth/oauth2/authorize', 'read'],
  ['POST /api/auth/oauth2/authorize', 'protocol-mutation'],
  ['POST /api/auth/oauth2/consent', 'browser-mutation'],
  ['POST /api/auth/oauth2/continue', 'browser-mutation'],
  ['POST /api/auth/oauth2/register', 'registration'],
  ['POST /api/auth/oauth2/revoke', 'protocol-mutation'],
  ['POST /api/auth/oauth2/token', 'protocol-mutation'],
  ['POST /api/auth/sign-out', 'browser-mutation'],
] as const);

export interface BetterAuthPublicHandlerInput {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  secret: string;
  privateSeam?: BetterAuthPrivateSeam;
  mcpRegistrationPolicy?: Partial<McpRegistrationPolicy>;
}

interface McpRegistrationPolicy {
  maxRegistrationsPerWindow: number;
  windowMs: number;
  maxClients: number;
  unusedClientRetentionMs: number;
  now: () => number;
}

const DEFAULT_MCP_REGISTRATION_POLICY: McpRegistrationPolicy = {
  maxRegistrationsPerWindow: 20,
  windowMs: 10 * 60_000,
  maxClients: 1_000,
  unusedClientRetentionMs: 30 * 24 * 60 * 60_000,
  now: Date.now,
};

/**
 * A deny-by-default public boundary around Better Auth. Setup, enrollment,
 * password mutation, organization mutation, and native sign-up remain private
 * server operations even if the pinned Better Auth release adds endpoints.
 */
export function createBetterAuthPublicHandler(input: BetterAuthPublicHandlerInput) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  let auth: ReturnType<typeof createBetterAuth> | undefined;
  const registrationGate = new McpRegistrationGate({
    ...DEFAULT_MCP_REGISTRATION_POLICY,
    ...input.mcpRegistrationPolicy,
  });

  return async function handleBetterAuthPublicRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = PUBLIC_ROUTES.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (!route || url.origin !== baseURL) return notFound();

    if (route === 'browser-mutation') {
      const provenance = validatePublicMutation(request, baseURL);
      if (provenance) return provenance;
    }

    if (route === 'registration') {
      const validation = await validateRegistrationRequest(request);
      if (validation instanceof Response) {
        emitManagementMetric('oauth.dcr', {
          stage: 'validation',
          outcome: 'denied',
          reason: `http_${validation.status}`,
        });
        return validation;
      }
      request = validation;
      const registrationDenied = await registrationGate.check(request, input.backend);
      if (registrationDenied) {
        emitManagementMetric('oauth.dcr', {
          stage: 'quota',
          outcome: 'denied',
          reason: `http_${registrationDenied.status}`,
        });
        return registrationDenied;
      }
    }

    auth ??= createBetterAuth({ ...input, baseURL });
    await auth.$context;
    const response = await auth.handler(request);
    if (route === 'registration') {
      emitManagementMetric('oauth.dcr', {
        stage: 'registration',
        outcome: response.ok ? 'success' : 'failed',
        reason: `http_${response.status}`,
      });
    } else if (route === 'read' && url.pathname.includes('.well-known')) {
      emitManagementMetric('oauth.discovery', {
        stage: url.pathname.includes('protected-resource') ? 'resource' : 'authorization_server',
        outcome: response.ok ? 'success' : 'failed',
        reason: `http_${response.status}`,
      });
    } else if (url.pathname.endsWith('/oauth2/token')) {
      emitManagementMetric('oauth.token', {
        stage: 'exchange',
        outcome: response.ok ? 'success' : 'failed',
        reason: `http_${response.status}`,
      });
    }
    return response;
  };
}

class McpRegistrationGate {
  private readonly windows = new Map<string, { count: number; startedAt: number }>();

  constructor(private readonly policy: McpRegistrationPolicy) {}

  async check(request: Request, backend: BetterAuthDatabaseBackend): Promise<Response | null> {
    const now = this.policy.now();
    for (const [key, candidate] of this.windows) {
      if (candidate.startedAt + this.policy.windowMs <= now) this.windows.delete(key);
    }
    const source = requestAuthSourceKey(request);
    const current = this.windows.get(source);
    const window = !current || current.startedAt + this.policy.windowMs <= now
      ? { count: 0, startedAt: now }
      : current;
    if (window.count >= this.policy.maxRegistrationsPerWindow) {
      const retryAfter = Math.max(1, Math.ceil(
        (window.startedAt + this.policy.windowMs - now) / 1_000,
      ));
      return Response.json(
        { error: 'registration_rate_limited' },
        { status: 429, headers: { 'retry-after': String(retryAfter) } },
      );
    }

    const createdBefore = new Date(now - this.policy.unusedClientRetentionMs).toISOString();
    await backend.pruneUnusedMcpOAuthClients(createdBefore);
    if (await backend.countMcpOAuthClients() >= this.policy.maxClients) {
      return Response.json({ error: 'registration_quota_exceeded' }, { status: 429 });
    }

    window.count += 1;
    this.windows.set(source, window);
    return null;
  }
}

async function validateRegistrationRequest(request: Request): Promise<Request | Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_BODY_BYTES) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }
  const clone = request.clone();
  let body: unknown;
  try {
    body = await clone.json();
  } catch {
    return Response.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }
  const validation = validatePublicMcpClientRegistration(body);
  if (!validation.ok) {
    const status = validation.code === 'client_metadata_too_large' ? 413 : 400;
    return Response.json({ error: validation.code }, { status });
  }
  return request;
}

function validatePublicMutation(request: Request, canonicalOrigin: string): Response | null {
  const result = validateBrowserMutationProvenance(request, {
    canonicalOrigin,
    maxBodyBytes: MAX_AUTH_BODY_BYTES,
  });
  if (result.ok) return null;
  const status = result.code === 'cross_origin_denied'
    ? 403
    : result.code === 'content_type_denied' ? 415 : 413;
  return Response.json({ error: result.code }, { status });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}
