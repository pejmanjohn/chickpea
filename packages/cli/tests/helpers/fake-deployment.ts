import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const SCOPE = 'chickpea:workspace';

export type FakeEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export type FakeMode = 'ready' | 'setup-incomplete' | 'wrong-origin';

export interface FakeDeploymentOptions {
  mode?: FakeMode;
  accessTokenTtlSeconds?: number;
  now?: () => number;
  tools?: Record<string, (args: Record<string, unknown>) => FakeEnvelope>;
}

interface IssuedAccessToken {
  clientId: string;
  expiresAt: number;
  revoked: boolean;
}

interface IssuedRefreshToken {
  clientId: string;
  revoked: boolean;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string | null;
}

/**
 * In-process stand-in for a deployment's public surface, shaped after
 * `tests/management-oauth.test.ts`: discovery documents, public-client DCR,
 * PKCE S256 code exchange with refresh rotation, RFC 7009 revocation, and a
 * stateless MCP handler behind a bearer check with the same 401 challenge.
 */
export class FakeDeployment {
  readonly registrations: Array<Record<string, unknown>> = [];
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly revocations: URLSearchParams[] = [];
  readonly toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  refreshCount = 0;

  private server: Server | undefined;
  private origin = '';
  private readonly clients = new Map<string, Record<string, unknown>>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, IssuedAccessToken>();
  private readonly refreshTokens = new Map<string, IssuedRefreshToken>();
  private readonly mode: FakeMode;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly tools: Record<string, (args: Record<string, unknown>) => FakeEnvelope>;

  constructor(options: FakeDeploymentOptions = {}) {
    this.mode = options.mode ?? 'ready';
    this.ttl = options.accessTokenTtlSeconds ?? 900;
    this.now = options.now ?? Date.now;
    this.tools = {
      inspect_workspace: () => ({ ok: true, result: { organizationId: 'org_test', agents: [], channels: [], providers: [], connectors: [], effectiveRevision: 'r1' } }),
      ...options.tools,
    };
  }

  get url(): string {
    return this.origin;
  }

  /** The origin the deployment believes it is served from. */
  private get canonical(): string {
    return this.mode === 'wrong-origin' ? 'https://other.example' : this.origin;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = this.server!.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** Simulate the server rejecting current access tokens without the clock moving. */
  invalidateAccessTokens(): void {
    for (const token of this.accessTokens.values()) token.revoked = true;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);
    const method = request.method ?? 'GET';
    const body = await readBody(request);
    const key = `${method} ${url.pathname}`;

    if (this.mode === 'setup-incomplete') {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
      return;
    }

    const issuer = `${this.canonical}/api/auth`;
    const resource = `${this.canonical}/mcp`;

    switch (key) {
      case 'GET /.well-known/oauth-protected-resource/mcp':
        return json(response, 200, {
          resource,
          authorization_servers: [issuer],
          bearer_methods_supported: ['header'],
          scopes_supported: [SCOPE],
        });
      case 'GET /.well-known/oauth-authorization-server/api/auth':
        return json(response, 200, {
          issuer,
          authorization_endpoint: `${this.canonical}/api/auth/oauth2/authorize`,
          token_endpoint: `${this.canonical}/api/auth/oauth2/token`,
          registration_endpoint: `${this.canonical}/api/auth/oauth2/register`,
          revocation_endpoint: `${this.canonical}/api/auth/oauth2/revoke`,
          jwks_uri: `${this.canonical}/api/auth/jwks`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: [SCOPE],
        });
      case 'GET /api/auth/jwks':
        return json(response, 200, {
          keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'MCowBQYDK2VwAyEAG9pHfmE3v0zKfQ0dFkE', kid: 'test-key', alg: 'EdDSA', use: 'sig' }],
        });
      case 'POST /api/auth/oauth2/register':
        return this.register(response, body);
      case 'GET /api/auth/oauth2/authorize':
        return this.authorize(response, url.searchParams);
      case 'POST /api/auth/oauth2/token':
        return this.token(response, new URLSearchParams(body));
      case 'POST /api/auth/oauth2/revoke':
        return this.revoke(response, new URLSearchParams(body));
      case 'POST /mcp':
        return this.mcp(request, response, body, url);
      default:
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
    }
  }

  private register(response: ServerResponse, body: string): void {
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return json(response, 400, { error: 'invalid_client_metadata' });
    }
    this.registrations.push(metadata);
    if (metadata.token_endpoint_auth_method !== 'none') return json(response, 400, { error: 'public_clients_only' });
    if (metadata.application_type !== 'native' && metadata.application_type !== 'web') {
      return json(response, 400, { error: 'unsupported_application_type' });
    }
    const redirects = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris as string[] : [];
    if (!redirects.length || redirects.some((uri) => !isLoopbackOrHttps(uri))) {
      return json(response, 400, { error: 'invalid_redirect_uri' });
    }
    if (typeof metadata.scope === 'string' && metadata.scope.split(/\s+/).some((scope) => scope !== SCOPE)) {
      return json(response, 400, { error: 'invalid_scope' });
    }
    const clientId = `client_${randomBytes(8).toString('hex')}`;
    const record = {
      client_id: clientId,
      client_id_issued_at: Math.floor(this.now() / 1_000),
      client_name: metadata.client_name,
      redirect_uris: redirects,
      grant_types: metadata.grant_types,
      response_types: metadata.response_types,
      token_endpoint_auth_method: 'none',
      application_type: metadata.application_type,
      scope: SCOPE,
      resources: [`${this.canonical}/mcp`],
    };
    this.clients.set(clientId, record);
    json(response, 201, record);
  }

  private authorize(response: ServerResponse, query: URLSearchParams): void {
    this.authorizeRequests.push(query);
    const client = this.clients.get(query.get('client_id') ?? '');
    const redirectUri = query.get('redirect_uri') ?? '';
    if (!client || !(client.redirect_uris as string[]).includes(redirectUri)) {
      return json(response, 400, { error: 'invalid_client' });
    }
    if (query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge')) {
      return json(response, 400, { error: 'invalid_request' });
    }
    const code = `code_${randomBytes(12).toString('base64url')}`;
    this.codes.set(code, {
      clientId: client.client_id as string,
      redirectUri,
      challenge: query.get('code_challenge')!,
      resource: query.get('resource'),
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('iss', `${this.canonical}/api/auth`);
    const state = query.get('state');
    if (state) target.searchParams.set('state', state);
    response.writeHead(302, { location: target.href, 'cache-control': 'no-store' }).end();
  }

  private token(response: ServerResponse, form: URLSearchParams): void {
    this.tokenRequests.push(form);
    const clientId = form.get('client_id') ?? '';
    if (!this.clients.has(clientId)) return json(response, 401, { error: 'invalid_client' });
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!pending || pending.clientId !== clientId) return json(response, 400, { error: 'invalid_grant' });
      if (pending.redirectUri !== form.get('redirect_uri')) return json(response, 400, { error: 'invalid_grant' });
      const verifier = form.get('code_verifier') ?? '';
      const digest = createHash('sha256').update(verifier).digest('base64url');
      if (digest !== pending.challenge) return json(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return json(response, 200, this.issue(clientId));
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const refresh = this.refreshTokens.get(presented);
      if (!refresh || refresh.revoked || refresh.clientId !== clientId) return json(response, 400, { error: 'invalid_grant' });
      refresh.revoked = true;
      this.refreshCount += 1;
      return json(response, 200, this.issue(clientId));
    }
    json(response, 400, { error: 'unsupported_grant_type' });
  }

  private issue(clientId: string): Record<string, unknown> {
    const accessToken = `at_${randomBytes(16).toString('base64url')}`;
    const refreshToken = `rt_${randomBytes(16).toString('base64url')}`;
    this.accessTokens.set(accessToken, { clientId, expiresAt: this.now() + this.ttl * 1_000, revoked: false });
    this.refreshTokens.set(refreshToken, { clientId, revoked: false });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.ttl,
      refresh_token: refreshToken,
      scope: SCOPE,
    };
  }

  private revoke(response: ServerResponse, form: URLSearchParams): void {
    this.revocations.push(form);
    const clientId = form.get('client_id') ?? '';
    if (!this.clients.has(clientId)) return json(response, 401, { error: 'invalid_client' });
    const token = form.get('token') ?? '';
    const refresh = this.refreshTokens.get(token);
    if (refresh) {
      if (refresh.clientId !== clientId) return json(response, 200, {});
      refresh.revoked = true;
      return json(response, 200, {});
    }
    if (this.accessTokens.has(token)) {
      return json(response, 400, { error: 'unsupported_token_type', error_description: 'JWT access tokens are self-contained and cannot be revoked server-side' });
    }
    json(response, 400, { error: 'invalid_request', error_description: 'token not found' });
  }

  private async mcp(request: IncomingMessage, response: ServerResponse, body: string, url: URL): Promise<void> {
    const authorization = request.headers.authorization ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
    const issued = bearer ? this.accessTokens.get(bearer) : undefined;
    if (!issued || issued.revoked || issued.expiresAt <= this.now()) {
      const parameters = [
        `resource_metadata="${this.canonical}/.well-known/oauth-protected-resource/mcp"`,
        `scope="${SCOPE}"`,
        ...(bearer ? ['error="invalid_token"'] : []),
      ];
      response.writeHead(401, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'www-authenticate': `Bearer ${parameters.join(', ')}`,
      }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Authorization required.' }, id: null }));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(', '));
    }
    const handler = createMcpHandler(() => this.createMcpServer(), { legacy: 'stateless' });
    const result = await handler.fetch(new Request(url.href, { method: 'POST', headers, body }));
    const outHeaders: Record<string, string> = {};
    result.headers.forEach((value, name) => { outHeaders[name] = value; });
    response.writeHead(result.status, outHeaders);
    if (result.body) {
      for await (const chunk of result.body as AsyncIterable<Uint8Array>) response.write(chunk);
    }
    response.end();
  }

  private createMcpServer(): McpServer {
    const server = new McpServer({ name: 'chickpea-workspace', version: '2.5.0' });
    for (const [name, implementation] of Object.entries(this.tools)) {
      server.registerTool(name, {
        title: name,
        description: `Fake ${name}. Second sentence that the CLI should not print.`,
        inputSchema: z.looseObject({}),
        annotations: name.startsWith('inspect') || name.startsWith('export') || name.startsWith('preview')
          ? { readOnlyHint: true }
          : name === 'confirm_workspace_change' ? { destructiveHint: true, idempotentHint: true } : {},
      }, async (args) => {
        const record = (args ?? {}) as Record<string, unknown>;
        this.toolCalls.push({ name, args: record });
        const envelope = implementation(record);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope,
          ...(envelope.ok ? {} : { isError: true }),
        };
      });
    }
    return server;
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}

function isLoopbackOrHttps(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** A browser stand-in: follow the authorization redirect straight to the CLI's loopback callback. */
export async function fakeBrowser(url: string): Promise<void> {
  const authorization = await fetch(url, { redirect: 'manual' });
  await authorization.text().catch(() => undefined);
  const location = authorization.headers.get('location');
  if (!location) throw new Error(`fake browser: authorize returned HTTP ${authorization.status} without a redirect`);
  const callback = await fetch(location);
  await callback.text();
}
