import type { DBAdapter } from 'better-auth';
import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import {
  createBetterAuth,
  requireSupportedOrigin,
  type BetterAuthPrivateSeam,
} from './better-auth.ts';
import {
  MCP_OFFLINE_SCOPE,
  MCP_WORKSPACE_SCOPE,
  validatePublicMcpClientRegistration,
  type McpClientRegistrationDenial,
} from './mcp-oauth.ts';
import { validateBrowserMutationProvenance } from './request-provenance.ts';
import { emitManagementMetric } from '../management/telemetry.ts';
import { readBoundedRequestBody, requestWithBufferedBody } from '../security/request-body-limit.ts';

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

const AUTHORIZATION_SERVER_METADATA_PATHS = new Set([
  '/.well-known/oauth-authorization-server/api/auth',
  '/api/auth/.well-known/oauth-authorization-server',
]);

export interface BetterAuthPublicHandlerInput {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  secret: string;
  privateSeam?: BetterAuthPrivateSeam;
  mayIssueTokens?: (betterAuthUserId: string) => Promise<boolean>;
  mcpRegistrationPolicy?: Partial<McpRegistrationPolicy>;
}

interface McpRegistrationPolicy {
  maxPendingClients: number;
  pendingClientRetentionMs: number;
  consentWindowMs: number;
  now: () => number;
}

const DEFAULT_MCP_REGISTRATION_POLICY: McpRegistrationPolicy = {
  maxPendingClients: 1_000,
  pendingClientRetentionMs: 30 * 24 * 60 * 60_000,
  // Outlasts the 10-minute sign-in continuation and authorization code, and
  // holds a full cap no longer than the durable limiter's 15-minute window.
  consentWindowMs: 15 * 60_000,
  now: () => Date.now(),
};

/**
 * A deny-by-default public boundary around Better Auth. Setup, enrollment,
 * password mutation, organization mutation, and native sign-up remain private
 * server operations even if the pinned Better Auth release adds endpoints.
 */
export function createBetterAuthPublicHandler(input: BetterAuthPublicHandlerInput) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  let auth: ReturnType<typeof createBetterAuth> | undefined;
  const registrationPolicy = { ...DEFAULT_MCP_REGISTRATION_POLICY, ...input.mcpRegistrationPolicy };

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
      if (typeof validation === 'string') {
        emitManagementMetric('oauth.dcr', { stage: 'validation', outcome: 'denied', reason: validation });
        const tooLarge = validation === 'request_too_large' || validation === 'client_metadata_too_large';
        return Response.json({ error: validation }, { status: tooLarge ? 413 : 400 });
      }
      request = validation;
      const { maxPendingClients, pendingClientRetentionMs, consentWindowMs, now } = registrationPolicy;
      const at = now();
      const pending = await input.backend.prunePendingMcpOAuthClients({
        expiredBefore: new Date(at - pendingClientRetentionMs),
        evictableBefore: new Date(at - consentWindowMs),
        keep: Math.max(0, maxPendingClients - 1),
      });
      if (pending >= maxPendingClients) {
        emitManagementMetric('oauth.dcr', { stage: 'quota', outcome: 'denied', reason: 'http_429' });
        return Response.json({ error: 'registration_quota_exceeded' }, { status: 429 });
      }
    }

    auth ??= createBetterAuth({ ...input, baseURL });
    const context = await auth.$context;
    if (route === 'read' && url.pathname === '/api/auth/oauth2/authorize') {
      request = await withOfflineAccessForRenewableClient(request, context.adapter);
    }
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
    if (url.pathname.endsWith('/oauth2/revoke')) return await revocationResponse(response);
    return AUTHORIZATION_SERVER_METADATA_PATHS.has(url.pathname) ? await publicClientMetadata(response) : response;
  };
}

/**
 * What Better Auth's OAuth provider answers, as a 400, when the token to revoke
 * is unknown or already revoked. RFC 7009 2.2 answers 200, as the provider
 * means to: it checks `error.name === 'BAD_REQUEST'`, but its errors are named
 * `APIError`. Any other 400, such as a missing token, stays.
 */
const UNUSABLE_TOKEN_DESCRIPTIONS = new Set(['token not found', 'Invalid access token', 'refresh token revoked']);

async function revocationResponse(response: Response): Promise<Response> {
  if (response.status !== 400) return response;
  const body: unknown = await response.clone().json().catch(() => null);
  const description = body && typeof body === 'object' && 'error_description' in body ? body.error_description : null;
  return typeof description === 'string' && UNUSABLE_TOKEN_DESCRIPTIONS.has(description)
    ? new Response(null, { status: 200, headers: { 'content-type': 'application/json' } })
    : response;
}

interface RegisteredClient {
  grantTypes?: string[] | null;
  scopes?: string[] | null;
}

/**
 * MCP 2026-07-28 keeps offline_access out of the resource's challenge and
 * metadata and leaves renewal to the authorization server, so a client that
 * follows them asks for the workspace scope alone, and Better Auth issues a
 * refresh token only for offline_access.
 */
async function withOfflineAccessForRenewableClient(request: Request, adapter: DBAdapter): Promise<Request> {
  const url = new URL(request.url);
  const scopes = url.searchParams.get('scope')?.split(/\s+/).filter(Boolean) ?? [];
  const clientId = url.searchParams.get('client_id');
  if (!clientId || !scopes.includes(MCP_WORKSPACE_SCOPE) || scopes.includes(MCP_OFFLINE_SCOPE)) return request;
  const client = await adapter.findOne<RegisteredClient>({
    model: 'oauthClient',
    where: [{ field: 'clientId', value: clientId }],
  });
  if (!client || !registeredForRenewal(client)) return request;
  url.searchParams.set('scope', [...scopes, MCP_OFFLINE_SCOPE].join(' '));
  return new Request(url, request);
}

function registeredForRenewal(client: RegisteredClient): boolean {
  return Boolean(client.grantTypes?.includes('refresh_token') && client.scopes?.includes(MCP_OFFLINE_SCOPE));
}

async function validateRegistrationRequest(request: Request): Promise<Request | McpClientRegistrationDenial> {
  let body: unknown;
  try {
    const bounded = await readBoundedRequestBody(request, MAX_AUTH_BODY_BYTES);
    if (!bounded.ok) return bounded.reason === 'body_too_large' ? 'request_too_large' : 'invalid_client_metadata';
    body = JSON.parse(new TextDecoder().decode(bounded.body ?? new Uint8Array()));
  } catch {
    return 'invalid_client_metadata';
  }
  const validation = validatePublicMcpClientRegistration(body);
  if (!validation.ok) return validation.code;
  // Do not tee a validation clone: Node 22.19 can cancel the original unread
  // stream when the clone is collected. Hand Better Auth its own bounded body.
  return requestWithBufferedBody(request, new TextEncoder().encode(JSON.stringify(validation.registration)));
}

/**
 * Better Auth lists every confidential method it can verify and has no option
 * to narrow the list, and claude.ai registers with client_secret_post whenever
 * it is listed. Registration here accepts public clients only.
 */
async function publicClientMetadata(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const metadata = await response.json() as Record<string, unknown>;
  return Response.json(
    { ...metadata, token_endpoint_auth_methods_supported: ['none'] },
    { status: response.status, headers: response.headers },
  );
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
