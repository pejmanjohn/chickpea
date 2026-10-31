import type { D1Database } from '@cloudflare/workers-types';

import { D1BetterAuthBackend } from '../../../src/auth/better-auth-cloudflare.ts';
import { createBetterAuthPublicHandler } from '../../../src/auth/better-auth-routes.ts';

interface Env {
  AUTH_DB: D1Database;
  DOCUMENT_HOST: string;
}

const SECRET = 'cimd-workerd-secret-stable-for-this-probe-only';
const platformFetch = globalThis.fetch;
let documentHost: string | undefined;

// The default document transport hands its outbound request to the platform
// fetch. Only the destination changes: claude.ai is answered by the test's
// local document server, and every other part of the request goes as built.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://claude.ai' || documentHost === undefined) return platformFetch(request);
  return platformFetch(new Request(`${documentHost}${url.pathname}${url.search}`, request));
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    documentHost = env.DOCUMENT_HOST;
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/test/clients') {
      const { results } = await env.AUTH_DB.prepare(
        'SELECT clientId, clientDiscoveryId, name FROM oauthClient ORDER BY createdAt, clientId',
      ).all();
      return Response.json(results);
    }
    return createBetterAuthPublicHandler({
      backend: new D1BetterAuthBackend(env.AUTH_DB),
      baseURL: url.origin,
      secret: SECRET,
    })(request);
  },
};
