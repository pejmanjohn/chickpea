import { createCimdClientDiscovery, validateClientIdUrl, type CimdOptions } from '@better-auth/cimd';
import { APIError, isAPIError } from 'better-auth/api';

import { createMcpGuardedFetch } from '../config/mcp-url.ts';

type ClientDiscovery = ReturnType<typeof createCimdClientDiscovery>;
export type ClientMetadataFetch = CimdOptions['fetchClientMetadataResource'];

/** One transport's discovery, and the stored clients whose last fetch could not reach their document. */
interface TransportState {
  discovery: ClientDiscovery;
  unreachable: Set<string>;
}

const MAX_UNREACHABLE_CLIENTS = 1_000;
let guardedFetch: ClientMetadataFetch | undefined;
const transports = new WeakMap<ClientMetadataFetch, TransportState>();

/**
 * Sign-in for a client whose `client_id` is the HTTPS URL of its Client ID
 * Metadata Document (MCP 2026-07-28), as Claude signs in. Better Auth fetches
 * the document over `fetchClientMetadataResource`, by default the MCP
 * connection guard: public HTTPS hosts only, every DNS answer checked and
 * pinned on Node, no redirect followed. The plugin adds a 5-second timeout, a
 * 5 KB JSON-only body and the MCP profile's required fields.
 *
 * Better Auth is built per request, so the discovery, which caches documents
 * and budgets fetches per origin, is kept per transport for the isolate.
 * Storing a client the database does not hold yet first asks `admitNewClient`,
 * the same bound dynamic registration has on clients no one consented to; a
 * URL the plugin would refuse unfetched never asks.
 *
 * A stored client's document is fetched again once its cached copy lapses.
 * When that fetch cannot reach the document, the stored client stands, so an
 * outage at the client's host does not sign its users out. A document that
 * answers still replaces the stored client, or refuses it.
 */
export function clientMetadataDiscovery(
  fetchClientMetadataResource: ClientMetadataFetch | undefined,
  admitNewClient: () => Promise<boolean>,
): ClientDiscovery {
  const transport = fetchClientMetadataResource ??
    (guardedFetch ??= createMcpGuardedFetch({ followRedirects: false }));
  const { discovery, unreachable } = transports.get(transport) ?? createState(transport);
  return {
    ...discovery,
    async resolve(ctx, clientId, existing) {
      if (!existing) {
        if (validateClientIdUrl(clientId) === null && !(await admitNewClient())) {
          throw new APIError('TOO_MANY_REQUESTS', {
            error: 'temporarily_unavailable',
            error_description: 'Too many apps are waiting for sign-in approval. Try again later.',
          });
        }
        return discovery.resolve(ctx, clientId, null);
      }
      try {
        const client = await discovery.resolve(ctx, clientId, existing);
        unreachable.delete(clientId);
        return client;
      } catch (error) {
        const failure = readFailure(error);
        // The plugin declines to fetch again for a second after any failure,
        // so a decline stands in for the last fetch's outcome.
        if (failure === 'unreachable' || (failure === 'declined' && unreachable.has(clientId))) {
          remember(unreachable, clientId);
          ctx.context.logger.warn(`Client metadata document unreachable; using the stored client: ${clientId}`);
          return existing;
        }
        unreachable.delete(clientId);
        throw error;
      }
    },
  };
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

/** The plugin's refusals that say nothing about the document: no answer, a 5xx, or no fetch at all. */
const UNREACHABLE_DOCUMENT = /^(?:Failed to fetch metadata document|Metadata document fetch timed out|Metadata document fetch returned HTTP 5\d\d$)/;

function readFailure(error: unknown): 'unreachable' | 'declined' | undefined {
  if (!isAPIError(error)) return undefined;
  if (error.status === 'TOO_MANY_REQUESTS') return 'declined';
  const description = (error.body as { error_description?: unknown } | undefined)?.error_description;
  return typeof description === 'string' && UNREACHABLE_DOCUMENT.test(description) ? 'unreachable' : undefined;
}

/** The host that published a client's metadata document, or undefined when its client ID is not a document URL. */
export function clientMetadataHost(clientId: string): string | undefined {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}
