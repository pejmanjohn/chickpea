import { createLocalJWKSet, jwtVerify, type JWK, type JWTPayload } from 'jose';
import { Hono, type Context } from 'hono';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';

import { escapeHtml } from '../security/html-escape.ts';
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
import { createWorkspaceManagementMcpHandler } from '../management/mcp.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import { emitManagementMetric } from '../management/telemetry.ts';
import {
  actualBodyLimit,
  readBoundedRequestBody,
  requestWithBufferedBody,
} from '../security/request-body-limit.ts';

const MCP_BROWSER_BODY_LIMIT_BYTES = 16 * 1024;
export const MCP_PROTOCOL_BODY_LIMIT_BYTES = 1_048_576;

export interface McpAuthenticatedPrincipal {
  betterAuthUserId: string;
  userId: string;
  membershipId: string;
  organizationId: string;
  role: OrganizationRole;
  /** OAuth client identity from the verified access token (`azp`). */
  clientId: string;
}

export type McpRequestHandler = (request: Request) => Promise<Response>;
type McpServerFactory = (
  principal: McpAuthenticatedPrincipal,
) => Promise<McpRequestHandler> | McpRequestHandler;

interface McpAuthenticatedRequestHandlerInput {
  baseURL: string;
  getJwks(): Promise<{ keys: JWK[] }>;
  resolvePrincipal(
    betterAuthUserId: string,
  ): Promise<Omit<McpAuthenticatedPrincipal, 'clientId'> | undefined>;
  createServer: McpServerFactory;
}

interface McpOAuthRuntimeOptions {
  identity?: IdentityStore;
  authSecret?: string;
  createServer?: McpServerFactory;
  productTelemetry?: (c: Context) => ProductTelemetryCapture;
}

export function createMcpAuthenticatedRequestHandler(
  input: McpAuthenticatedRequestHandlerInput,
): McpRequestHandler {
  const resource = mcpResourceForOrigin(input.baseURL);
  const issuer = `${new URL(input.baseURL).origin}${BETTER_AUTH_BASE_PATH}`;
  const metadata = `${new URL(input.baseURL).origin}/.well-known/oauth-protected-resource/mcp`;

  return async (request) => {
    const token = bearerToken(request.headers.get('authorization'));
    if (!token) {
      emitManagementMetric('oauth.request', {
        stage: 'bearer', outcome: 'denied', reason: 'missing_token',
      });
      return oauthChallenge(401, metadata);
    }

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
      emitManagementMetric('oauth.request', {
        stage: 'bearer', outcome: 'denied', reason: 'invalid_token',
      });
      return oauthChallenge(401, metadata, 'invalid_token');
    }

    const scopes = grantedScopes(claims.scope);
    if (!scopes.has(MCP_WORKSPACE_SCOPE)) {
      emitManagementMetric('oauth.request', {
        stage: 'scope', outcome: 'denied', reason: 'insufficient_scope',
      });
      return oauthChallenge(403, metadata, 'insufficient_scope');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) {
      return oauthChallenge(401, metadata, 'invalid_token');
    }
    const clientId = oauthClientId(claims);
    if (!clientId) return oauthChallenge(401, metadata, 'invalid_token');

    const resolved = await input.resolvePrincipal(claims.sub).catch(() => undefined);
    if (!resolved) {
      emitManagementMetric('oauth.request', {
        stage: 'membership', outcome: 'denied', reason: 'live_access_denied',
      });
      return forbidden();
    }
    const server = await input.createServer({ ...resolved, clientId });
    emitManagementMetric('oauth.request', {
      stage: 'membership', outcome: 'success',
    });
    return server(request);
  };
}

export function createMcpOAuthRuntimeRoutes(options: McpOAuthRuntimeOptions = {}): Hono {
  const app = new Hono();
  app.use('/auth/mcp/consent', actualBodyLimit({
    maxSize: MCP_BROWSER_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  }));
  app.use('/mcp', async (c, next) => {
    const ingress = await readMcpProtocolBody(c.req.raw);
    if (!ingress.ok) {
      return c.json(
        { error: ingress.status === 413 ? 'request_too_large' : 'invalid_request' },
        ingress.status,
      );
    }
    if (ingress.body) {
      c.req.raw = requestWithBufferedBody(c.req.raw, ingress.body);
    }
    await next();
  });
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

async function readMcpProtocolBody(
  request: Request,
): Promise<
  | { ok: true; body: Uint8Array | null }
  | { ok: false; status: 400 | 413 }
> {
  const result = await readBoundedRequestBody(request, MCP_PROTOCOL_BODY_LIMIT_BYTES);
  if (result.ok) return result;
  return {
    ok: false,
    status: result.reason === 'body_too_large' ? 413 : 400,
  };
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
  const clientName = await lookupMcpClientName(
    runtime.environment, query.get('client_id') ?? '', c.req.raw.headers,
  );
  const scope = query.get('scope') ?? MCP_WORKSPACE_SCOPE;
  return new Response(renderMcpConsentPage({ clientName, scope, oauthQuery: query.toString() }), {
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
    allowOpaqueOriginFormNavigation: true,
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
  if (response?.redirect === true && typeof response.url === 'string') {
    return createMcpConsentRedirectResponse(response.url);
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
    createServer: options.createServer ?? ((principal) =>
      createWorkspaceManagementMcpHandler(
        principal,
        c.env as PlatformEnv | undefined,
        runtime.environment.baseURL,
        options.productTelemetry?.(c),
      )),
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

function oauthClientId(claims: JWTPayload): string | undefined {
  const value = claims.client_id ?? claims.azp;
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined;
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

const CONSENT_STYLE = `
:root{--canvas:#f4ebd8;--card:#fffdf6;--well:#f8f1df;--line:rgba(59,50,32,.12);--text:#3b3220;--text-2:#6b5c42;--gold:#dda033;--gold-press:#b27e1f}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--text);font:16px/1.55 Quicksand,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:8vh auto 10vh;padding:0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 28px 24px;box-shadow:0 2px 0 rgba(59,50,32,.08)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.brand img{width:40px;height:40px;border-radius:10px}
.brand span{font-weight:700;letter-spacing:.02em}
h1{font-size:28px;line-height:1.15;margin:0 0 10px}
p{margin:0 0 14px;color:var(--text-2)}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 22px;padding:14px 16px;background:var(--well);border:1px solid var(--line);border-radius:12px}
dt{color:var(--text-2);font-size:14px}
dd{margin:0;font-size:15px;overflow-wrap:anywhere}
dd .note{color:var(--text-2);font-size:13px}
form{display:flex;gap:10px;flex-wrap:wrap}
button{font:inherit;font-weight:700;font-size:15px;padding:10px 18px;border:0;border-radius:10px;cursor:pointer}
button[value=allow]{background:var(--gold);color:#3b3220;box-shadow:0 2px 0 var(--gold-press)}
button[value=allow]:active{transform:translateY(1px);box-shadow:0 1px 0 var(--gold-press)}
button[value=deny]{background:transparent;color:var(--text-2);border:1px solid var(--line)}
a{color:#8a6410}
`.trim();

function brandPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="icon" href="/chickpea-favicon-32.png"><style>${CONSENT_STYLE}</style></head>
<body>
  <main>
    <div class="card">
      <div class="brand"><img src="/chickpea-mark-128.png" alt=""><span>Chickpea</span></div>
${body}
    </div>
  </main>
</body>
</html>`;
}

const MCP_CLIENT_NAME_DISPLAY_LIMIT = 60;

/**
 * Reads the self-asserted `client_name` from the client's registration. The
 * signed OAuth query already names a registered client; any lookup failure
 * falls back to the generic label rather than blocking consent.
 */
export async function lookupMcpClientName(
  environment: BetterAuthEnvironment,
  clientId: string,
  headers: Headers,
): Promise<string | undefined> {
  if (!clientId) return undefined;
  try {
    const auth = createBetterAuth(environment);
    const api = auth.api as unknown as {
      getOAuthClientPublic(input: {
        query: { client_id: string };
        headers: Headers;
      }): Promise<{ client_name?: unknown } | null | undefined>;
    };
    const client = await api.getOAuthClientPublic({ query: { client_id: clientId }, headers });
    return typeof client?.client_name === 'string' ? client.client_name : undefined;
  } catch {
    return undefined;
  }
}

/** Untrusted, app-chosen text: strip controls and bidi overrides, collapse, bound. */
export function displayMcpClientName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return undefined;
  const chars = [...cleaned];
  if (chars.length <= MCP_CLIENT_NAME_DISPLAY_LIMIT) return cleaned;
  return `${chars.slice(0, MCP_CLIENT_NAME_DISPLAY_LIMIT - 1).join('').trimEnd()}…`;
}

export function renderMcpConsentPage(input: {
  clientName?: string | undefined;
  scope: string;
  oauthQuery: string;
}): string {
  const name = displayMcpClientName(input.clientName);
  const app = name
    ? `${escapeHtml(name)} <span class="note">(name provided by the app)</span>`
    : 'An unnamed app';
  const permission = input.scope.split(/\s+/).filter(Boolean).map((scope) => {
    if (scope === MCP_WORKSPACE_SCOPE) return 'Manage this Chickpea workspace';
    if (scope === 'offline_access') return 'stay signed in';
    return scope;
  }).join(' and ');
  return brandPage('Authorize Chickpea', `      <h1>Allow workspace management?</h1>
      <p>A coding agent is asking to manage this Chickpea workspace as you. It signs in as you and can only do what you can do.</p>
      <dl><dt>App</dt><dd>${app}</dd><dt>Permission</dt><dd>${escapeHtml(permission)}</dd></dl>
      <form method="post" action="/auth/mcp/consent">
        <input type="hidden" name="oauth_query" value="${escapeHtml(input.oauthQuery)}">
        <button type="submit" name="decision" value="allow">Allow</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>`);
}

function browserHeaders(contentType: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    // Scriptless pages: inline styles only, brand images from this origin.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function createMcpConsentRedirectResponse(location: string): Response {
  if (!validClientRedirect(location)) return invalidBrowserRequest();
  const destination = escapeHtml(location);
  // Chrome applies the submitting page's form-action policy to HTTP redirects.
  // Finish the same-origin POST before navigating to the OAuth client's callback.
  // A scriptless document also supports loopback clients without relaxing CSP.
  return new Response(brandPage('Return to your coding agent', `      <h1>Return to your coding agent</h1>
      <p>You are being returned to the app that requested access.</p>
      <p><a href="${destination}">Continue</a> if you are not redirected automatically.</p>`).replace('<title>', `<meta http-equiv="refresh" content="0;url=${destination}"><title>`), {
    status: 200,
    headers: browserHeaders('text/html; charset=utf-8'),
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
