import { createCimdClientDiscovery, validateClientIdUrl, type CimdOptions } from '@better-auth/cimd';
import { APIError, isAPIError } from 'better-auth/api';

import { createMcpGuardedFetch } from '../config/mcp-url.ts';

type ClientDiscovery = ReturnType<typeof createCimdClientDiscovery>;
type Client = NonNullable<Awaited<ReturnType<ClientDiscovery['resolve']>>>;
export type ClientMetadataFetch = CimdOptions['fetchClientMetadataResource'];

/** One transport's discovery, and the stored clients whose last fetch could not reach their document. */
interface TransportState {
  discovery: ClientDiscovery;
  unreachable: Set<string>;
}

const MAX_UNREACHABLE_CLIENTS = 1_000;
/** How long after its document last answered a stored client may stand in for it. */
const STORED_CLIENT_STAND_IN_MS = 24 * 60 * 60_000;
let guardedFetch: ClientMetadataFetch | undefined;
const transports = new WeakMap<ClientMetadataFetch, TransportState>();

/** What a client first seen by its metadata document passes before it is stored, as a registration does. */
interface NewClientGate {
  /** The per-source registration limit: a response refusing the request, or undefined. */
  throttle?: ((request: Request) => Promise<Response | undefined>) | undefined;
  /** Whether the pending-client bound has room for one more. */
  admitPending(): Promise<boolean>;
}

/**
 * Sign-in for a client whose `client_id` is the HTTPS URL of its Client ID
 * Metadata Document (MCP 2026-07-28), as Claude signs in. Better Auth fetches
 * the document over `fetchClientMetadataResource`, by default the MCP
 * connection guard: public HTTPS hosts only, every DNS answer checked and
 * pinned on Node, no redirect followed. The plugin adds a 5-second timeout, a
 * 5 KB JSON-only body and the MCP profile's required fields. A document client
 * must be public, as a registered one must; a refused new one is not kept.
 *
 * Better Auth is built per request, so the discovery, which caches documents
 * and budgets fetches per origin, is kept per transport for the isolate.
 * Storing a client the database does not hold yet first passes `gate`: the
 * per-source limit and the bound on clients no one consented to that dynamic
 * registration has. A stored client never does. A URL the plugin would refuse
 * unfetched is refused before the gate and the plugin, so it spends neither a
 * limit nor a fetch permit.
 *
 * A stored client's document is fetched again once its cached copy lapses.
 * When that fetch cannot reach the document, the stored client stands for up
 * to a day after the document last answered, so an outage at the client's
 * host does not sign its users out. A document that answers still replaces
 * the stored client, or refuses it.
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
    async resolve(ctx, clientId, existing) {
      if (!existing) {
        // The plugin takes a fetch permit before it checks the URL.
        const invalid = validateClientIdUrl(clientId);
        if (invalid) throw new APIError('BAD_REQUEST', { error: 'invalid_client', error_description: invalid });
        const throttled = await gate.throttle?.(ctx.request ?? new Request(ctx.context.baseURL, { headers: ctx.headers ?? {} }));
        if (throttled) {
          const retryAfter = throttled.headers.get('retry-after');
          throw new APIError('TOO_MANY_REQUESTS', {
            error: 'temporarily_unavailable',
            error_description: 'Too many new apps are signing in from here. Try again later.',
          }, retryAfter ? { 'retry-after': retryAfter } : undefined);
        }
        if (!(await gate.admitPending())) {
          throw new APIError('TOO_MANY_REQUESTS', {
            error: 'temporarily_unavailable',
            error_description: 'Too many apps are waiting for sign-in approval. Try again later.',
          });
        }
        const created = await discovery.resolve(ctx, clientId, null);
        if (created && !isPublicClient(created)) {
          await ctx.context.adapter.delete({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
          throw notPublicClient();
        }
        return created;
      }
      let client: Client | null;
      try {
        client = await discovery.resolve(ctx, clientId, existing);
        unreachable.delete(clientId);
      } catch (error) {
        const failure = readFailure(error);
        // The plugin declines a fetch for a second after a failed one, or when
        // its budget is spent; a decline stands in for the last fetch's outcome.
        if (failure !== 'unreachable' && !(failure === 'declined' && unreachable.has(clientId))) {
          unreachable.delete(clientId);
          throw error;
        }
        remember(unreachable, clientId);
        // The plugin rewrites updatedAt each time the document answers, changed or not.
        if (Date.now() - (existing.updatedAt?.getTime() ?? 0) > STORED_CLIENT_STAND_IN_MS) {
          ctx.context.logger.warn(`Client metadata document unreachable for over a day; refusing the stored client: ${clientId}`);
          throw error;
        }
        ctx.context.logger.warn(`Client metadata document unreachable; using the stored client: ${clientId}`);
        client = existing;
      }
      if (client && !isPublicClient(client)) throw notPublicClient();
      return client;
    },
  };
}

/**
 * Dynamic registration accepts public clients only (validatePublicMcpClientRegistration);
 * a document client meets the same rule, so no client assertion or key fetch ever serves one.
 */
function isPublicClient(client: Client): boolean {
  return client.tokenEndpointAuthMethod === 'none' && !client.jwks && !client.jwksUri;
}

function notPublicClient(): APIError {
  return new APIError('BAD_REQUEST', {
    error: 'invalid_client',
    error_description: 'metadata document must describe a public client: token_endpoint_auth_method "none", no jwks or jwks_uri',
  });
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

/** The plugin's refusals after a fetch the document did not answer: no response, a 429, or a 5xx. */
const UNREACHABLE_DOCUMENT = /^(?:Failed to fetch metadata document|Metadata document fetch timed out|Metadata document fetch returned HTTP (?:429|5\d\d)$)/;

function readFailure(error: unknown): 'unreachable' | 'declined' | undefined {
  if (!isAPIError(error)) return undefined;
  if (error.status === 'TOO_MANY_REQUESTS') return 'declined';
  const description = (error.body as { error_description?: unknown } | undefined)?.error_description;
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
