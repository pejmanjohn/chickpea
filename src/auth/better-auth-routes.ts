import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import {
  createBetterAuth,
  requireSupportedOrigin,
  type BetterAuthPrivateSeam,
} from './better-auth.ts';
import { validateBrowserMutationProvenance } from './request-provenance.ts';

const MAX_AUTH_BODY_BYTES = 32 * 1024;
type PublicRoute = 'session' | 'sign-out';

const PUBLIC_ROUTES = new Map<string, PublicRoute>([
  ['GET /api/auth/get-session', 'session'],
  ['POST /api/auth/sign-out', 'sign-out'],
] as const);

export interface BetterAuthPublicHandlerInput {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  secret: string;
  privateSeam?: BetterAuthPrivateSeam;
}

/**
 * A deny-by-default public boundary around Better Auth. Setup, enrollment,
 * password mutation, organization mutation, and native sign-up remain private
 * server operations even if the pinned Better Auth release adds endpoints.
 */
export function createBetterAuthPublicHandler(input: BetterAuthPublicHandlerInput) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  const auth = createBetterAuth({ ...input, baseURL });

  return async function handleBetterAuthPublicRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = PUBLIC_ROUTES.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (!route || url.origin !== baseURL) return notFound();

    if (request.method !== 'GET') {
      const provenance = validatePublicMutation(request, baseURL);
      if (provenance) return provenance;
    }

    return auth.handler(request);
  };
}

function validatePublicMutation(request: Request, canonicalOrigin: string): Response | null {
  const result = validateBrowserMutationProvenance(request, {
    canonicalOrigin,
    maxBodyBytes: MAX_AUTH_BODY_BYTES,
  });
  if (result.ok) return null;
  const status = result.code === 'cross_origin_denied'
    ? 403
    : result.code === 'content_type_denied' ? 415 : 413;
  return Response.json({ error: result.code }, { status });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}
