import { createCimdClientDiscovery, validateClientIdUrl, type CimdOptions } from '@better-auth/cimd';
import { APIError, isAPIError } from 'better-auth/api';

import { createMcpGuardedFetch, validateMcpUrl } from '../config/mcp-url.ts';
import type { McpRegistrationThrottle } from './better-auth-backend.ts';
import { isLoopbackHost, validRedirectUri } from './mcp-oauth.ts';

type ClientDiscovery = ReturnType<typeof createCimdClientDiscovery>;
type Client = NonNullable<Awaited<ReturnType<ClientDiscovery['resolve']>>>;
export type ClientMetadataFetch = CimdOptions['fetchClientMetadataResource'];

/**
 * Whether a client ID is the URL of a metadata document Chickpea may fetch:
 * Better Auth's client ID rules (HTTPS, an explicit path, no credentials,
 * dot segment or fragment, no private or reserved host), the MCP egress
 * guard's (no internal or bare hostname), a DNS name for the consent page to
 * show rather than an IP address, and written as URL parsing writes it, so
 * one document has one client ID and no control character reaches a log.
 * Any other client ID is an unknown client, before any throttle, fetch
 * permit, write or fetch.
 */
export function isClientMetadataDocumentUrl(clientId: string): boolean {
  if (validateClientIdUrl(clientId) !== null || !validateMcpUrl(clientId).ok) return false;
  const url = new URL(clientId);
  return url.href === clientId && !IP_ADDRESS_HOST.test(url.hostname);
}

// URL parsing writes every IPv4 form as dotted decimal and brackets IPv6.
const IP_ADDRESS_HOST = /^(?:\[.*\]|[\d.]+)$/;

/** One transport's discovery, and the stored clients whose last fetch could not reach their document. */
interface TransportState {
  discovery: ClientDiscovery;
  unreachable: Set<string>;
}

const MAX_UNREACHABLE_CLIENTS = 1_000;
const STORED_CLIENT_STAND_IN_MS = 24 * 60 * 60_000;
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
 * host does not sign its users out. A client someone consented to also stands
 * in when the fetch budget is spent, so strangers who spend it cannot sign its
 * users out. A document that answers still replaces the stored client, or
 * refuses it.
 */
export function clientMetadataDiscovery(
  fetchClientMetadataResource: ClientMetadataFetch | undefined,
  gate: NewClientGate,
): ClientDiscovery {
  const transport = fetchClientMetadataResource ??
    (guardedFetch ??= createMcpGuardedFetch({ followRedirects: false }));
  const { discovery, unreachable } = transports.get(transport) ?? createState(transport);
  return {
    ...discovery,
    matches: isClientMetadataDocumentUrl,
    async resolve(ctx, clientId, existing) {
      // Better Auth asks `matches` first; asking again keeps the throttle, the
      // pending bound and the plugin's fetch permit behind the URL check
      // whatever order it calls in.
      if (!isClientMetadataDocumentUrl(clientId)) return null;
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
      const consented = Boolean(await ctx.context.adapter.findOne({
        model: 'oauthConsent', where: [{ field: 'clientId', value: clientId }],
      }));
      if (!consented) await assertSourceAdmitted(gate, source);
      let client: Client | null;
      try {
        client = await discovery.resolve(ctx, clientId, existing);
        unreachable.delete(clientId);
      } catch (error) {
        const failure = readFailure(error);
        // The plugin pauses a client's fetches for a second after a failed one
        // and declines every fetch once its budget is spent; either decline
        // stands in for the last fetch's outcome. A spent budget also lets a
        // client someone consented to stand in. A pause after a refused fetch
        // never does.
        const lastFetchUnreachable = failure === 'unreachable' || (failure !== undefined && unreachable.has(clientId));
        if (!lastFetchUnreachable && !(failure === 'budget' && consented)) {
          unreachable.delete(clientId);
          throw error;
        }
        if (lastFetchUnreachable) remember(unreachable, clientId);
        const why = lastFetchUnreachable ? 'unreachable' : 'not fetched, the fetch budget is spent';
        // The plugin rewrites updatedAt each time the document answers, changed or not.
        if (Date.now() - (existing.updatedAt?.getTime() ?? 0) > STORED_CLIENT_STAND_IN_MS) {
          ctx.context.logger.warn(`Client metadata document ${why} over a day after it last answered; refusing the stored client: ${clientId}`);
          throw error;
        }
        ctx.context.logger.warn(`Client metadata document ${why}; using the stored client: ${clientId}`);
        client = existing;
      }
      const refusal = client && registrationRefusal(client);
      if (refusal) throw refusal;
      return client;
    },
  };
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
  };
  transports.set(transport, state);
  return state;
}

function remember(unreachable: Set<string>, clientId: string): void {
  unreachable.delete(clientId);
  if (unreachable.size >= MAX_UNREACHABLE_CLIENTS) unreachable.delete(unreachable.values().next().value!);
  unreachable.add(clientId);
}

const UNREACHABLE_DOCUMENT = /^(?:Failed to fetch metadata document|Metadata document fetch timed out|Metadata document fetch returned HTTP (?:429|5\d\d)$)/;
const PAUSED_CLIENT = 'metadata document fetch is within the per-client minimum interval';

/** Why the plugin did not resolve a stored client: its fetch could not reach the document, it paused this client after a failed fetch, or its budget is spent. */
function readFailure(error: unknown): 'unreachable' | 'paused' | 'budget' | undefined {
  if (!isAPIError(error)) return undefined;
  const description = (error.body as { error_description?: unknown } | undefined)?.error_description;
  if (error.status === 'TOO_MANY_REQUESTS') return description === PAUSED_CLIENT ? 'paused' : 'budget';
  return typeof description === 'string' && UNREACHABLE_DOCUMENT.test(description) ? 'unreachable' : undefined;
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
