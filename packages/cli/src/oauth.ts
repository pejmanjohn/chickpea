import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import { CliError } from './errors.ts';
import { MCP_WORKSPACE_SCOPE, mcpUrl } from './origin.ts';
import {
  CredentialStore,
  tokensExpired,
  withExpiry,
  type StoredDeployment,
  type StoredTokens,
} from './store.ts';
import { CLI_VERSION } from './version.ts';

export const CLI_CLIENT_NAME = 'Chickpea CLI';
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOOPBACK_HOST = '127.0.0.1';

export interface AuthDeps {
  fetch: typeof fetch;
  store: CredentialStore;
  now: () => number;
  /** Open the authorization URL. Must not throw when no browser is available. */
  openBrowser: (url: string) => Promise<void>;
  note: (text: string) => void;
}

export interface LoginOptions {
  timeoutMs?: number;
  /** Test hook: receives the authorization URL after the browser is asked to open it. */
  onAuthorizationUrl?: (url: string) => void;
}

export interface LoginResult {
  origin: string;
  clientId: string;
  expiresAt: number | undefined;
  path: string;
}

type ProviderMode = 'login' | 'session';

/**
 * The SDK drives discovery, dynamic registration, PKCE, the code exchange,
 * and refresh. This provider only decides where the pieces live: in memory
 * while a login is in flight, and in the 0600 credential file afterwards.
 */
class CliOAuthProvider implements OAuthClientProvider {
  private client: StoredOAuthClientInformation | undefined;
  private storedTokens: StoredTokens | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private verifier: string | undefined;
  private expectedState: string | undefined;

  constructor(private readonly options: {
    origin: string;
    store: CredentialStore;
    mode: ProviderMode;
    now: () => number;
    loginRedirectUrl?: string;
    onRedirect?: (url: URL) => Promise<void>;
  }) {
    if (options.mode === 'session') {
      const entry = options.store.read(options.origin);
      this.client = entry?.client;
      this.storedTokens = entry?.tokens;
      this.discovery = entry?.discovery;
    }
  }

  get redirectUrl(): string {
    if (this.options.loginRedirectUrl) return this.options.loginRedirectUrl;
    const registered = (this.client as { redirect_uris?: string[] } | undefined)?.redirect_uris?.[0];
    return registered ?? `http://${LOOPBACK_HOST}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLI_CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      scope: MCP_WORKSPACE_SCOPE,
    };
  }

  state(): string {
    this.expectedState ??= randomBytes(24).toString('base64url');
    return this.expectedState;
  }

  get authorizationState(): string | undefined {
    return this.expectedState;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.client;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.client = info;
    this.persistIfSession();
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.storedTokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.storedTokens = withExpiry(tokens, this.options.now());
    this.persistIfSession();
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.options.mode !== 'login' || !this.options.onRedirect) {
      throw new CliError(
        'SESSION_EXPIRED',
        `The saved session for ${this.options.origin} can no longer be refreshed`,
        `Sign in again with: chickpea login ${this.options.origin}`,
      );
    }
    await this.options.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new CliError('LOGIN_STATE_LOST', 'The PKCE verifier for this login is missing', 'Start over with: chickpea login <deployment-url>');
    return this.verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
    this.persistIfSession();
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.client = undefined;
    if (scope === 'all' || scope === 'tokens') this.storedTokens = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    this.persistIfSession();
  }

  snapshot(): StoredDeployment {
    return {
      origin: this.options.origin,
      ...(this.client ? { client: this.client } : {}),
      ...(this.storedTokens ? { tokens: this.storedTokens } : {}),
      ...(this.discovery ? { discovery: this.discovery } : {}),
      updatedAt: new Date(this.options.now()).toISOString(),
    };
  }

  persist(): void {
    this.options.store.write(this.snapshot());
  }

  private persistIfSession(): void {
    if (this.options.mode === 'session') this.persist();
  }
}

interface LoopbackListener {
  redirectUrl: string;
  waitForCallback(): Promise<URLSearchParams>;
  close(): Promise<void>;
}

async function startLoopbackListener(): Promise<LoopbackListener> {
  let resolveCallback: ((params: URLSearchParams) => void) | undefined;
  const callback = new Promise<URLSearchParams>((resolve) => { resolveCallback = resolve; });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
      return;
    }
    const denied = url.searchParams.get('error');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(
      denied
        ? '<!doctype html><title>Chickpea CLI</title><p>Authorization was not completed. You can close this window.</p>'
        : '<!doctype html><title>Chickpea CLI</title><p>Signed in to Chickpea. You can close this window and return to the terminal.</p>',
    );
    resolveCallback?.(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUrl: `http://${LOOPBACK_HOST}:${port}/callback`,
    waitForCallback: () => callback,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

/**
 * Look at the protected-resource document before opening a browser so the
 * three common failures get their own code: unfinished setup (404), a URL
 * that is not the deployment's canonical origin, and a non-Chickpea host.
 */
async function preflightDiscovery(origin: string, deps: AuthDeps): Promise<void> {
  let response: Response;
  try {
    response = await deps.fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliError('NETWORK', `Cannot reach ${origin} (${error instanceof Error ? error.message : String(error)})`, 'Check the deployment URL, DNS, and TLS, then run: chickpea doctor <deployment-url>');
  }
  const text = await response.text().catch(() => '');
  if (response.status === 404) {
    throw new CliError('SETUP_INCOMPLETE', `${origin} has not finished setup`, 'Open its private setup link, complete Slack setup, then sign in again');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CliError('WRONG_ORIGIN', `${origin} redirects elsewhere`, "Use the deployment's canonical origin (see: chickpea doctor <deployment-url>)");
  }
  if (response.status !== 200) {
    throw new CliError('DISCOVERY_FAILED', `${origin} answered HTTP ${response.status} for its OAuth metadata`, 'Run: chickpea doctor <deployment-url>');
  }
  let resource: unknown;
  try {
    resource = (JSON.parse(text) as { resource?: unknown }).resource;
  } catch {
    throw new CliError('DISCOVERY_FAILED', `${origin} did not return OAuth metadata`, 'Check that the URL points at a Chickpea deployment');
  }
  if (resource !== mcpUrl(origin)) {
    throw new CliError('WRONG_ORIGIN', `${origin} is not the deployment's canonical origin (its MCP resource is ${String(resource)})`, 'Sign in with the canonical origin instead');
  }
}

export async function login(origin: string, deps: AuthDeps, options: LoginOptions = {}): Promise<LoginResult> {
  await preflightDiscovery(origin, deps);
  const listener = await startLoopbackListener();
  const serverUrl = mcpUrl(origin);
  const provider = new CliOAuthProvider({
    origin,
    store: deps.store,
    mode: 'login',
    now: deps.now,
    loginRedirectUrl: listener.redirectUrl,
    onRedirect: async (url) => {
      deps.note(`Opening your browser to sign in to ${origin}.`);
      deps.note(`If it does not open, visit:\n  ${url.href}`);
      options.onAuthorizationUrl?.(url.href);
      await deps.openBrowser(url.href);
    },
  });

  try {
    const first = await auth(provider, { serverUrl, scope: MCP_WORKSPACE_SCOPE, fetchFn: deps.fetch });
    if (first !== 'AUTHORIZED') {
      const params = await withTimeout(
        listener.waitForCallback(),
        options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
        () => new CliError('LOGIN_TIMEOUT', 'No authorization response arrived from the browser', 'Retry and finish the Slack sign-in and consent screens'),
      );
      const denied = params.get('error');
      if (denied) {
        throw new CliError('AUTHORIZATION_DENIED', `The deployment refused the authorization (${denied})`, 'You must be a member of that Chickpea workspace; retry after signing in to the right Slack workspace');
      }
      if (params.get('state') !== provider.authorizationState) {
        throw new CliError('STATE_MISMATCH', 'The authorization response did not match this login attempt', 'Retry: chickpea login <deployment-url>');
      }
      const code = params.get('code');
      if (!code) throw new CliError('AUTHORIZATION_DENIED', 'The authorization response carried no code', 'Retry: chickpea login <deployment-url>');
      const iss = params.get('iss');
      const result = await auth(provider, {
        serverUrl,
        authorizationCode: code,
        scope: MCP_WORKSPACE_SCOPE,
        fetchFn: deps.fetch,
        ...(iss ? { iss } : {}),
      });
      if (result !== 'AUTHORIZED') throw new CliError('AUTHORIZATION_FAILED', 'The authorization code could not be exchanged for tokens', 'Retry: chickpea login <deployment-url>');
    }
    provider.persist();
    const snapshot = provider.snapshot();
    return {
      origin,
      clientId: snapshot.client?.client_id ?? '',
      expiresAt: snapshot.tokens?.expires_at,
      path: deps.store.path,
    };
  } finally {
    await listener.close();
  }
}

export interface LogoutResult {
  origin: string;
  revoked: boolean;
}

/**
 * RFC 7009 revocation with the public client's id. A 400 means the token was
 * already unusable (or is a self-contained JWT, which the server reports as
 * `unsupported_token_type`); either way nothing is left to revoke.
 */
export async function logout(origin: string, deps: AuthDeps): Promise<LogoutResult> {
  const entry = deps.store.read(origin);
  if (!entry) throw new CliError('NOT_LOGGED_IN', `No saved session for ${origin}`, `Nothing to revoke. Sign in with: chickpea login ${origin}`);
  const metadata = entry.discovery?.authorizationServerMetadata as Record<string, unknown> | undefined;
  const endpoint = typeof metadata?.revocation_endpoint === 'string'
    ? metadata.revocation_endpoint
    : `${origin}/api/auth/oauth2/revoke`;
  const clientId = entry.client?.client_id;
  let revoked = false;
  if (clientId && entry.tokens) {
    const attempts: Array<[string | undefined, 'refresh_token' | 'access_token']> = [
      [entry.tokens.refresh_token, 'refresh_token'],
      [entry.tokens.access_token, 'access_token'],
    ];
    for (const [token, hint] of attempts) {
      if (!token) continue;
      let response: Response;
      try {
        response = await deps.fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new CliError('REVOKE_FAILED', `Could not reach the revocation endpoint (${error instanceof Error ? error.message : String(error)})`, `Retry, or remove the entry by hand from ${deps.store.path}`);
      }
      await response.text().catch(() => undefined);
      if (response.ok && hint === 'refresh_token') revoked = true;
      if (!response.ok && response.status !== 400 && response.status !== 401) {
        throw new CliError('REVOKE_FAILED', `The deployment answered HTTP ${response.status} to the revocation request`, `Retry, or remove the entry by hand from ${deps.store.path}`);
      }
    }
  }
  deps.store.delete(origin);
  return { origin, revoked };
}

export interface ManagementConnection {
  client: Client;
  close(): Promise<void>;
}

/** Connect with the saved session, refreshing first when the access token has expired. */
export async function connectManagementClient(origin: string, deps: AuthDeps): Promise<ManagementConnection> {
  const entry = deps.store.read(origin);
  if (!entry?.tokens || !entry.client) {
    throw new CliError('NOT_LOGGED_IN', `No saved session for ${origin}`, `Sign in with: chickpea login ${origin}`);
  }
  const provider = new CliOAuthProvider({ origin, store: deps.store, mode: 'session', now: deps.now });
  const serverUrl = mcpUrl(origin);
  if (tokensExpired(entry.tokens, deps.now())) {
    const result = await auth(provider, { serverUrl, scope: MCP_WORKSPACE_SCOPE, fetchFn: deps.fetch });
    if (result !== 'AUTHORIZED') {
      throw new CliError('SESSION_EXPIRED', `The saved session for ${origin} could not be refreshed`, `Sign in again with: chickpea login ${origin}`);
    }
  }
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider,
    fetch: deps.fetch,
  });
  const client = new Client({ name: 'chickpea-cli', version: CLI_VERSION });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
