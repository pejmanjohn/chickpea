import { createCimdClientDiscovery, type CimdOptions } from '@better-auth/cimd';
import { APIError } from 'better-auth/api';

import { createMcpGuardedFetch } from '../config/mcp-url.ts';

type ClientDiscovery = ReturnType<typeof createCimdClientDiscovery>;
export type ClientMetadataFetch = CimdOptions['fetchClientMetadataResource'];

let guardedFetch: ClientMetadataFetch | undefined;
const discoveries = new WeakMap<ClientMetadataFetch, ClientDiscovery>();

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
 * the same bound dynamic registration has on clients no one consented to.
 */
export function clientMetadataDiscovery(
  fetchClientMetadataResource: ClientMetadataFetch | undefined,
  admitNewClient: () => Promise<boolean>,
): ClientDiscovery {
  const transport = fetchClientMetadataResource ??
    (guardedFetch ??= createMcpGuardedFetch({ followRedirects: false }));
  const shared = discoveries.get(transport) ?? createDiscovery(transport);
  return {
    ...shared,
    async resolve(ctx, clientId, existing) {
      if (!existing && !(await admitNewClient())) {
        throw new APIError('TOO_MANY_REQUESTS', {
          error: 'temporarily_unavailable',
          error_description: 'Too many apps are waiting for sign-in approval. Try again later.',
        });
      }
      return shared.resolve(ctx, clientId, existing);
    },
  };
}

function createDiscovery(transport: ClientMetadataFetch): ClientDiscovery {
  const discovery = createCimdClientDiscovery({ fetchClientMetadataResource: transport, metadataProfile: 'mcp-2026-07-28' });
  discoveries.set(transport, discovery);
  return discovery;
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
