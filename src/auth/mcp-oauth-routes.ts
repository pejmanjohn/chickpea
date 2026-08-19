import { createLocalJWKSet, jwtVerify, type JWK, type JWTPayload } from 'jose';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';

import {
  getIdentityStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { IdentityStore, OrganizationRole } from '../identity/types.ts';
import { BETTER_AUTH_BASE_PATH, createBetterAuth } from './better-auth.ts';
import { BetterAuthDirectory } from './better-auth-principal.ts';
import { createBetterAuthPublicHandler } from './better-auth-routes.ts';
import {
  resolveBetterAuthEnvironment,
  type BetterAuthEnvironment,
} from './better-auth-environment.ts';
import {
  MCP_WORKSPACE_SCOPE,
  mcpResourceForOrigin,
} from './mcp-oauth.ts';
import { BetterAuthMcpOAuthContinuationStore } from './mcp-oauth-continuation.ts';
import { validateBrowserMutationProvenance } from './request-provenance.ts';

const MCP_BROWSER_BODY_LIMIT_BYTES = 16 * 1024;

export interface McpAuthenticatedPrincipal {
  betterAuthUserId: string;
  userId: string;
  membershipId: string;
  organizationId: string;
  role: OrganizationRole;
}

export type McpRequestHandler = (request: Request) => Promise<Response>;
export type McpServerFactory = (
  principal: McpAuthenticatedPrincipal,
) => Promise<McpRequestHandler> | McpRequestHandler;

interface McpAuthenticatedRequestHandlerInput {
  baseURL: string;
  getJwks(): Promise<{ keys: JWK[] }>;
  resolvePrincipal(betterAuthUserId: string): Promise<McpAuthenticatedPrincipal | undefined>;
  createServer: McpServerFactory;
}

interface McpOAuthRuntimeOptions {
  identity?: IdentityStore;
  authSecret?: string;
  createServer?: McpServerFactory;
}

export function createMcpAuthenticatedRequestHandler(
  input: McpAuthenticatedRequestHandlerInput,
): McpRequestHandler {
  const resource = mcpResourceForOrigin(input.baseURL);
  const issuer = `${new URL(input.baseURL).origin}${BETTER_AUTH_BASE_PATH}`;
  const metadata = `${new URL(input.baseURL).origin}/.well-known/oauth-protected-resource/mcp`;

  return async (request) => {
    const token = bearerToken(request.headers.get('authorization'));
    if (!token) return oauthChallenge(401, metadata);

    let claims: JWTPayload;
    try {
      const jwks = await input.getJwks();
      const verified = await jwtVerify(token, createLocalJWKSet(jwks), {
        algorithms: ['EdDSA'],
        issuer,
        audience: resource,
        clockTolerance: 30,
        maxTokenAge: '20m',
      });
      claims = verified.payload;
    } catch {
      return oauthChallenge(401, metadata, 'invalid_token');
    }

    const scopes = grantedScopes(claims.scope);
    if (!scopes.has(MCP_WORKSPACE_SCOPE)) {
      return oauthChallenge(403, metadata, 'insufficient_scope');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) {
      return oauthChallenge(401, metadata, 'invalid_token');
    }

    const principal = await input.resolvePrincipal(claims.sub).catch(() => undefined);
    if (!principal) return forbidden();
    const server = await input.createServer(principal);
    return server(request);
  };
}

export function createMcpOAuthRuntimeRoutes(options: McpOAuthRuntimeOptions = {}): Hono {
  const app = new Hono();
  app.use('/auth/mcp/consent', bodyLimit({
    maxSize: MCP_BROWSER_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  }));
  app.get('/auth/mcp/login', (c) => beginMcpLogin(c, options));
  app.get('/auth/mcp/resume/:continuation', (c) => resumeMcpLogin(c, options));
  app.get('/auth/mcp/consent', (c) => showMcpConsent(c, options));
  app.post('/auth/mcp/consent', (c) => submitMcpConsent(c, options));
  app.all('/mcp', async (c) => {
    try {
      return await dispatchMcp(c, options);
    } catch {
      return Response.json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'MCP is temporarily unavailable.' },
        id: null,
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  });
  return app;
}

async function beginMcpLogin(c: Context, options: McpOAuthRuntimeOptions): Promise<Response> {
  const runtime = await resolveMcpRuntime(c, options);
  if (!runtime) return c.notFound();
  const query = new URL(c.req.url).searchParams;
  if (!await verifySignedOAuthQuery(query, runtime.environment.secret)) {
    return invalidBrowserRequest();
  }
  const store = new BetterAuthMcpOAuthContinuationStore({ backend: runtime.environment.backend });
  const continuation = await store.issue({
    authorizationPath: `${BETTER_AUTH_BASE_PATH}/oauth2/authorize?${query.toString()}`,
  });
  const destination = `/auth/mcp/resume/${continuation.id}`;
  return noStoreRedirect(`/auth/slack/sign-in?${new URLSearchParams({ destination })}`);
}

async function resumeMcpLogin(c: Context, options: McpOAuthRuntimeOptions): Promise<Response> {
  const runtime = await resolveMcpRuntime(c, options);
  if (!runtime) return c.notFound();
  const store = new BetterAuthMcpOAuthContinuationStore({ backend: runtime.environment.backend });
  const continuation = await store.consume(c.req.param('continuation') ?? '');
  if (!continuation) {
    return browserError('This authorization request expired or was already used.', 410);
  }
  return noStoreRedirect(continuation.authorizationPath);
}

async function showMcpConsent(c: Context, options: McpOAuthRuntimeOptions): Promise<Response> {
  const runtime = await resolveMcpRuntime(c, options);
  if (!runtime) return c.notFound();
  const query = new URL(c.req.url).searchParams;
  if (!await verifySignedOAuthQuery(query, runtime.environment.secret)) {
    return invalidBrowserRequest();
  }
  const clientId = query.get('client_id') ?? '';
  const scope = query.get('scope') ?? MCP_WORKSPACE_SCOPE;
  return new Response(renderConsentPage({ clientId, scope, oauthQuery: query.toString() }), {
    status: 200,
    headers: browserHeaders('text/html; charset=utf-8'),
  });
}

async function submitMcpConsent(c: Context, options: McpOAuthRuntimeOptions): Promise<Response> {
  const runtime = await resolveMcpRuntime(c, options);
  if (!runtime) return c.notFound();
  const provenance = validateBrowserMutationProvenance(c.req.raw, {
    canonicalOrigin: runtime.environment.baseURL,
    maxBodyBytes: MCP_BROWSER_BODY_LIMIT_BYTES,
    requireJson: false,
  });
  if (!provenance.ok) {
    const status = provenance.code === 'body_too_large' ? 413 : 403;
    return Response.json({ error: provenance.code }, {
      status,
      headers: browserHeaders('application/json'),
    });
  }
  const form = await c.req.parseBody();
  const oauthQuery = typeof form.oauth_query === 'string' ? form.oauth_query : '';
  const query = new URLSearchParams(oauthQuery);
  if (!await verifySignedOAuthQuery(query, runtime.environment.secret)) {
    return invalidBrowserRequest();
  }
  const accept = form.decision === 'allow';
  const handler = createBetterAuthPublicHandler(runtime.environment);
  const body = JSON.stringify({ accept, oauth_query: oauthQuery });
  const headers = new Headers(c.req.raw.headers);
  headers.set('content-type', 'application/json');
  headers.set('content-length', String(Buffer.byteLength(body)));
  headers.set('origin', runtime.environment.baseURL);
  const result = await handler(new Request(
    `${runtime.environment.baseURL}${BETTER_AUTH_BASE_PATH}/oauth2/consent`,
    { method: 'POST', headers, body },
  ));
  if (!result.ok) return result;
  const response = await result.clone().json().catch(() => undefined) as
    | { redirect?: unknown; url?: unknown }
    | undefined;
  if (response?.redirect === true && typeof response.url === 'string' &&
      validClientRedirect(response.url)) {
    return noStoreRedirect(response.url);
  }
  return result;
}

async function dispatchMcp(c: Context, options: McpOAuthRuntimeOptions): Promise<Response> {
  const runtime = await resolveMcpRuntime(c, options);
  if (!runtime) return new Response('Not Found', { status: 404 });

  const handler = authenticatedRuntimeHandler({
    environment: runtime.environment,
    identity: runtime.identity,
    betterAuthOrganizationId: runtime.betterAuthOrganizationId,
    createServer: options.createServer ?? unavailableServer,
  });
  return handler(c.req.raw);
}

async function resolveMcpRuntime(c: Context, options: McpOAuthRuntimeOptions): Promise<{
  environment: BetterAuthEnvironment;
  identity: IdentityStore;
  betterAuthOrganizationId: string;
} | undefined> {
  const platformEnv = c.env as PlatformEnv | undefined;
  const identity = options.identity ?? getIdentityStore(platformEnv);
  const control = await identity.getAuthControl();
  if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
      !control.canonicalAdminOrigin || !control.betterAuthOrganizationId) return undefined;
  const environment = await resolveBetterAuthEnvironment({
    control,
    platformEnv,
    authSecret: options.authSecret,
  });
  if (!environment) return undefined;
  return {
    environment,
    identity,
    betterAuthOrganizationId: control.betterAuthOrganizationId,
  };
}

function authenticatedRuntimeHandler(input: {
  environment: BetterAuthEnvironment;
  identity: IdentityStore;
  betterAuthOrganizationId: string;
  createServer: McpServerFactory;
}): McpRequestHandler {
  const auth = createBetterAuth(input.environment);
  const directory = new BetterAuthDirectory({
    backend: input.environment.backend,
    access: input.identity,
    organizationId: input.betterAuthOrganizationId,
    canonicalAdminOrigin: input.environment.baseURL,
  });
  return createMcpAuthenticatedRequestHandler({
    baseURL: input.environment.baseURL,
    getJwks: async () => {
      const api = auth.api as unknown as { getJwks(): Promise<{ keys?: JWK[] }> };
      const result = await api.getJwks();
      return { keys: Array.isArray(result.keys) ? result.keys : [] };
    },
    resolvePrincipal: async (betterAuthUserId) => {
      const resolution = await directory.resolveBetterAuthUser(betterAuthUserId);
      if (!resolution || resolution.membership.status !== 'active') return undefined;
      return {
        betterAuthUserId,
        userId: resolution.user.id,
        membershipId: resolution.membership.id,
        organizationId: resolution.membership.organizationId,
        role: resolution.membership.role,
      };
    },
    createServer: input.createServer,
  });
}

function bearerToken(header: string | null): string | undefined {
  if (!header || header.length > 16_384) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(header);
  return match?.[1];
}

function grantedScopes(value: unknown): Set<string> {
  if (typeof value === 'string') return new Set(value.split(/\s+/).filter(Boolean));
  if (Array.isArray(value) && value.every((scope) => typeof scope === 'string')) {
    return new Set(value as string[]);
  }
  return new Set();
}

function oauthChallenge(
  status: 401 | 403,
  metadata: string,
  error?: 'invalid_token' | 'insufficient_scope',
): Response {
  const parameters = [
    `resource_metadata="${metadata}"`,
    `scope="${MCP_WORKSPACE_SCOPE}"`,
    ...(error ? [`error="${error}"`] : []),
  ];
  return Response.json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: status === 403 ? 'Insufficient authorization.' : 'Authorization required.',
    },
    id: null,
  }, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Bearer ${parameters.join(', ')}`,
    },
  });
}

function forbidden(): Response {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32003, message: 'Current Chickpea access does not permit this request.' },
    id: null,
  }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

async function unavailableServer(): Promise<McpRequestHandler> {
  return async () => Response.json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Workspace management tools are not enabled yet.' },
    id: null,
  }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
}

export async function verifySignedOAuthQuery(
  query: URLSearchParams,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (query.toString().length > 4_096) return false;
  const clientId = query.get('client_id');
  const signatures = query.getAll('sig');
  const signature = signatures[0];
  const expires = Number(query.get('exp'));
  if (!clientId || clientId.length > 512 || signatures.length !== 1 || !signature ||
      signature.length > 512 || !Number.isFinite(expires) || expires * 1_000 < now) return false;

  const unsigned = new URLSearchParams(query);
  unsigned.delete('sig');
  const canonical = new URLSearchParams([...unsigned.entries()].sort(compareQueryEntries));
  const expected = await makeSignature(canonical.toString(), secret);
  return constantTimeEqual(signature, expected);
}

function compareQueryEntries(
  [keyA, valueA]: [string, string],
  [keyB, valueB]: [string, string],
): number {
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  if (valueA < valueB) return -1;
  if (valueA > valueB) return 1;
  return 0;
}

function renderConsentPage(input: {
  clientId: string;
  scope: string;
  oauthQuery: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Chickpea</title></head>
<body>
  <main>
    <h1>Allow workspace management?</h1>
    <p>A coding agent is requesting permission to manage this Chickpea workspace as you.</p>
    <dl><dt>Client</dt><dd>${escapeHtml(input.clientId)}</dd><dt>Permission</dt><dd>${escapeHtml(input.scope)}</dd></dl>
    <form method="post" action="/auth/mcp/consent">
      <input type="hidden" name="oauth_query" value="${escapeHtml(input.oauthQuery)}">
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>`;
}

function browserHeaders(contentType: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

function noStoreRedirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { 'Cache-Control': 'no-store', Location: location, 'Referrer-Policy': 'no-referrer' },
  });
}

function invalidBrowserRequest(): Response {
  return browserError('This authorization request is invalid.', 400);
}

function browserError(message: string, status: number): Response {
  return new Response(`<!doctype html><html lang="en"><body><main><h1>Authorization unavailable</h1><p>${escapeHtml(message)}</p></main></body></html>`, {
    status,
    headers: browserHeaders('text/html; charset=utf-8'),
  });
}

function validClientRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' ||
        url.hostname.startsWith('127.'));
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
