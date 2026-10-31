import { createCimdClientDiscovery, validateClientIdUrl, type CimdOptions } from '@better-auth/cimd';
import { APIError, getSessionFromCtx, isAPIError } from 'better-auth/api';

import { createMcpGuardedFetch, validateMcpUrl } from '../config/mcp-url.ts';
import type { McpRegistrationThrottle } from './better-auth-backend.ts';
import { isLoopbackHost, validRedirectUri } from './mcp-oauth.ts';

type ClientDiscovery = ReturnType<typeof createCimdClientDiscovery>;
type ResolveContext = Parameters<ClientDiscovery['resolve']>[0];
type Client = NonNullable<Awaited<ReturnType<ClientDiscovery['resolve']>>>;
export type ClientMetadataFetch = CimdOptions['fetchClientMetadataResource'];

/**
 * Whether a client ID is the URL of a metadata document Chickpea may fetch:
 * Better Auth's client ID rules (HTTPS, an explicit path, no credentials,
 * dot segment or fragment, no private or reserved host), the MCP egress
 * guard's (no internal or bare hostname), a DNS name for the consent page to
 * show rather than an IP address, written as URL parsing writes it with no
 * trailing dot, so one document has one client ID and no control character
 * reaches a log, and off Chickpea's own origin, which it would fetch itself.
 * Any other client ID is an unknown client, before any throttle, fetch
 * permit, write or fetch.
 */
export function isClientMetadataDocumentUrl(clientId: string, ownOrigin: string): boolean {
  if (validateClientIdUrl(clientId) !== null || !validateMcpUrl(clientId).ok) return false;
  const url = new URL(clientId);
  return url.href === clientId && !url.hostname.endsWith('.') && !IP_ADDRESS_HOST.test(url.hostname) &&
    url.origin !== new URL(ownOrigin).origin;
}

// URL parsing writes every IPv4 form as dotted decimal and brackets IPv6.
const IP_ADDRESS_HOST = /^(?:\[.*\]|[\d.]+)$/;

/**
 * One transport's discovery, the stored clients whose last fetch could not
 * reach their document, and those whose document last answered by refusing
 * them, which nothing lets stand in until it answers well again.
 */
interface TransportState {
  discovery: ClientDiscovery;
  unreachable: Set<string>;
  refused: Set<string>;
}

const MAX_REMEMBERED_CLIENTS = 1_000;
/** How long after its document last answered a stored client stands in for a document it cannot reach. */
const STORED_CLIENT_STAND_IN_MS = 24 * 60 * 60_000;
/** How long after its document last answered a stored client stands in while the fetch budget is spent. */
const SPENT_BUDGET_STAND_IN_MS = 60 * 60_000;
let guardedFetch: ClientMetadataFetch | undefined;
const transports = new WeakMap<ClientMetadataFetch, TransportState>();

interface NewClientGate {
  throttle?: McpRegistrationThrottle | undefined;
  admitPending(): Promise<boolean>;
}

/**
 * Sign-in for a client whose `client_id` is the HTTPS URL of its Client ID
 * Metadata Document (MCP 2026-07-28), whoever publishes it. The discovery
 * matches only a client ID isClientMetadataDocumentUrl accepts, and Better
 * Auth asks it before resolving a client, so any other client ID is an
 * unknown client: never fetched, throttled or stored. Better Auth fetches
 * the document over `fetchClientMetadataResource`, by default the MCP
 * connection guard: public HTTPS hosts only, every DNS answer checked and
 * pinned on Node, no redirect followed. The plugin adds a 5-second timeout,
 * a 5 KB JSON-only body and the MCP profile's required fields. A document
 * client must be public, redirect as a registered one must, and redirect only
 * to its own host or loopback; a refused new one is not kept.
 *
 * Better Auth is built per request, so the discovery, which caches documents
 * and budgets fetches per origin, is kept per transport for the isolate.
 * Storing a client the database does not hold yet first passes `gate`: the
 * per-source limit and the bound on clients no one consented to that dynamic
 * registration has. A stored client no one has consented to still passes the
 * per-source limit at every lookup, so its document cannot be fetched again
 * faster than that limit allows; one someone consented to never does.
 *
 * A stored client's document is fetched again once its cached copy lapses.
 * When that fetch cannot reach the document, the stored client stands for up
 * to a day after the document last answered, so an outage at the client's
 * host does not sign its users out. While the fetch budget is spent, a stored
 * client stands in for an hour after its document last answered, and only
 * for a person who has consented to it, so strangers who spend the budget
 * cannot sign that person out. A document that answers still replaces the
 * stored client, or refuses it.
 */
export function clientMetadataDiscovery(
  fetchClientMetadataResource: ClientMetadataFetch | undefined,
  gate: NewClientGate,
  ownOrigin: string,
): ClientDiscovery {
  const transport = fetchClientMetadataResource ??
    (guardedFetch ??= createMcpGuardedFetch({ followRedirects: false }));
  const { discovery, unreachable, refused } = transports.get(transport) ?? createState(transport);
  return {
    ...discovery,
    matches: (clientId) => isClientMetadataDocumentUrl(clientId, ownOrigin),
    async resolve(ctx, clientId, existing) {
      // Better Auth asks `matches` first; asking again keeps the throttle, the
      // pending bound and the plugin's fetch permit behind the URL check
      // whatever order it calls in.
      if (!isClientMetadataDocumentUrl(clientId, ownOrigin)) return null;
      const source = ctx.request ?? new Request(ctx.context.baseURL, { headers: ctx.headers ?? {} });
      if (!existing) {
        await assertSourceAdmitted(gate, source);
        await assertPendingAdmitted(gate);
        const created = await discovery.resolve(ctx, clientId, null);
        const refusal = created && registrationRefusal(created);
        if (refusal) {
          await ctx.context.adapter.delete({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
          throw refusal;
        }
        return created;
      }
      const consentedByAnyone = Boolean(await ctx.context.adapter.findOne({
        model: 'oauthConsent', where: [{ field: 'clientId', value: clientId }],
      }));
      if (!consentedByAnyone) await assertSourceAdmitted(gate, source);
      let client: Client | null;
      try {
        client = await discovery.resolve(ctx, clientId, existing);
        unreachable.delete(clientId);
        refused.delete(clientId);
      } catch (error) {
        const failure = readFailure(error);
        if (failure === 'refused') {
          unreachable.delete(clientId);
          remember(refused, clientId);
        }
        if (failure === 'refused' || refused.has(clientId)) throw error;
        // The plugin rewrites updatedAt each time the document answers, changed or not.
        const sinceAnswered = Date.now() - (existing.updatedAt?.getTime() ?? 0);
        // The plugin declines a fetch for a second after a failed one, or when
        // its budget is spent; a decline stands in for the last fetch's
        // outcome. Otherwise a decline lets the stored client stand in, for an
        // hour, only for a person who consented to it.
        const lastFetchUnreachable = failure === 'unreachable' || (failure === 'declined' && unreachable.has(clientId));
        const declinedStandIn = !lastFetchUnreachable && failure === 'declined' &&
          sinceAnswered <= SPENT_BUDGET_STAND_IN_MS && await requesterConsented(ctx, clientId);
        if (!lastFetchUnreachable && !declinedStandIn) {
          unreachable.delete(clientId);
          throw error;
        }
        if (lastFetchUnreachable) {
          remember(unreachable, clientId);
          if (sinceAnswered > STORED_CLIENT_STAND_IN_MS) {
            ctx.context.logger.warn(`Client metadata document unreachable for over a day; refusing the stored client: ${clientId}`);
            throw error;
          }
        }
        const why = lastFetchUnreachable ? 'unreachable' : 'not fetched, the fetch budget is spent';
        ctx.context.logger.warn(`Client metadata document ${why}; using the stored client: ${clientId}`);
        client = existing;
      }
      const refusal = client && registrationRefusal(client);
      if (refusal) throw refusal;
      return client;
    },
  };
}

/**
 * Whether the person this request acts for has consented to the client: the
 * owner of the refresh token or code at the token endpoint, otherwise the
 * signed-in person. A request that acts for no known person has not.
 */
async function requesterConsented(ctx: ResolveContext, clientId: string): Promise<boolean> {
  const userId = await requestingUserId(ctx);
  return userId !== undefined && Boolean(await ctx.context.adapter.findOne({
    model: 'oauthConsent', where: [{ field: 'clientId', value: clientId }, { field: 'userId', value: userId }],
  }));
}

async function requestingUserId(ctx: ResolveContext): Promise<string | undefined> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
    const token = await ctx.context.adapter.findOne<{ userId?: string | null }>({
      model: 'oauthRefreshToken', where: [{ field: 'token', value: await storedTokenDigest(body.refresh_token) }],
    });
    return token?.userId ?? undefined;
  }
  if (body.grant_type === 'authorization_code' && typeof body.code === 'string') {
    const verification = await ctx.context.internalAdapter.findVerificationValue(await storedTokenDigest(body.code));
    const value: unknown = verification ? JSON.parse(verification.value) : undefined;
    const userId = value && typeof value === 'object' && 'userId' in value ? value.userId : undefined;
    return typeof userId === 'string' ? userId : undefined;
  }
  if (body.grant_type !== undefined) return undefined;
  return (await getSessionFromCtx(ctx))?.user.id;
}

/**
 * How the OAuth provider stores a refresh token or code by default: SHA-256,
 * base64url without padding. Chickpea sets no `storeTokens`, token prefix or
 * `formatRefreshToken`; with one, this finds no one, and nothing stands in.
 */
async function storedTokenDigest(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function assertSourceAdmitted(gate: NewClientGate, request: Request): Promise<void> {
  const throttled = await gate.throttle?.(request);
  if (throttled) {
    const retryAfter = throttled.headers.get('retry-after');
    throw new APIError('TOO_MANY_REQUESTS', {
      error: 'temporarily_unavailable',
      error_description: 'Too many new apps are signing in from here. Try again later.',
    }, retryAfter ? { 'retry-after': retryAfter } : undefined);
  }
}

async function assertPendingAdmitted(gate: NewClientGate): Promise<void> {
  if (!(await gate.admitPending())) {
    throw new APIError('TOO_MANY_REQUESTS', {
      error: 'temporarily_unavailable',
      error_description: 'Too many apps are waiting for sign-in approval. Try again later.',
    });
  }
}

/**
 * Dynamic registration's rules (validatePublicMcpClientRegistration) that a
 * document client must meet too, and redirects that stay on the client ID's
 * host or loopback, so the consent page's Domain row also names where the
 * code goes.
 */
function registrationRefusal(client: Client): APIError | undefined {
  const refuse = (description: string) => new APIError('BAD_REQUEST', { error: 'invalid_client', error_description: description });
  if (client.tokenEndpointAuthMethod !== 'none' || client.jwks || client.jwksUri) {
    return refuse('metadata document must describe a public client: token_endpoint_auth_method "none", no jwks or jwks_uri');
  }
  const redirectUris = client.redirectUris ?? [];
  if (!redirectUris.every(validRedirectUri)) {
    return refuse('metadata document redirect_uris must be HTTPS, or HTTP on a loopback host, with no wildcard, credentials or fragment');
  }
  const clientHost = new URL(client.clientId).hostname;
  if (!redirectUris.every((uri) => {
    const { hostname } = new URL(uri);
    return isLoopbackHost(hostname) || hostname === clientHost || hostname.endsWith(`.${clientHost}`);
  })) {
    return refuse('metadata document redirect_uris must be on the client ID\'s host or a subdomain of it, or on a loopback host');
  }
  return undefined;
}

function createState(transport: ClientMetadataFetch): TransportState {
  const state = {
    discovery: createCimdClientDiscovery({ fetchClientMetadataResource: transport, metadataProfile: 'mcp-2026-07-28' }),
    unreachable: new Set<string>(),
    refused: new Set<string>(),
  };
  transports.set(transport, state);
  return state;
}

function remember(clients: Set<string>, clientId: string): void {
  clients.delete(clientId);
  if (clients.size >= MAX_REMEMBERED_CLIENTS) clients.delete(clients.values().next().value!);
  clients.add(clientId);
}

const UNREACHABLE_DOCUMENT = /^(?:Failed to fetch metadata document|Metadata document fetch timed out|Metadata document fetch returned HTTP (?:429|5\d\d)$)/;

/**
 * Why the plugin did not resolve a stored client: its fetch could not reach
 * the document, the document answered by refusing the client, or the plugin
 * declined to fetch, for its pause after a failed fetch or a spent budget.
 */
function readFailure(error: unknown): 'unreachable' | 'refused' | 'declined' | undefined {
  if (!isAPIError(error)) return undefined;
  if (error.status === 'TOO_MANY_REQUESTS') return 'declined';
  const description = (error.body as { error_description?: unknown } | undefined)?.error_description;
  if (typeof description === 'string' && UNREACHABLE_DOCUMENT.test(description)) return 'unreachable';
  return error.status === 'BAD_REQUEST' ? 'refused' : undefined;
}

/**
 * The host, with any non-default port, that published a client's metadata
 * document, or undefined when its client ID is not a document URL.
 */
export function clientMetadataHost(clientId: string): string | undefined {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' ? url.host : undefined;
  } catch {
    return undefined;
  }
}
