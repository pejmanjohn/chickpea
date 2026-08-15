import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import {
  createBetterAuth,
  requireSupportedOrigin,
  type BetterAuthPrivateSeam,
} from './better-auth.ts';
import { DUMMY_PASSWORD_RECORD, type PasswordPrimitive } from './password.ts';
import { validateBrowserMutationProvenance } from './request-provenance.ts';

const MAX_AUTH_BODY_BYTES = 32 * 1024;
type PublicRoute = 'session' | 'sign-in' | 'sign-out';

const PUBLIC_ROUTES = new Map<string, PublicRoute>([
  ['GET /api/auth/get-session', 'session'],
  ['POST /api/auth/sign-in/email', 'sign-in'],
  ['POST /api/auth/sign-out', 'sign-out'],
] as const);

const UNIFORM_LOGIN_FAILURE = Object.freeze({
  code: 'INVALID_EMAIL_OR_PASSWORD',
  message: 'Invalid email or password.',
});

export interface BetterAuthPublicHandlerInput {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  secret: string;
  password: PasswordPrimitive;
  privateSeam?: BetterAuthPrivateSeam;
  loginSourceAllowed(source: string): Promise<boolean>;
  loginIdentityAllowed(email: string): Promise<boolean>;
  loginResult?(source: string, email: string, credentialExists: boolean, success: boolean): Promise<void>;
  sourceKey(request: Request): string;
}

interface SignInBody {
  email: string;
  password: string;
}

/**
 * A deny-by-default public boundary around Better Auth. Setup, enrollment,
 * password mutation, organization mutation, and native sign-up remain private
 * server operations even if the pinned Better Auth release adds endpoints.
 */
export function createBetterAuthPublicHandler(input: BetterAuthPublicHandlerInput) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  const auth = createBetterAuth({ ...input, baseURL, allowSignUp: false });

  return async function handleBetterAuthPublicRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = PUBLIC_ROUTES.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (!route || url.origin !== baseURL) return notFound();

    if (request.method !== 'GET') {
      const provenance = validatePublicMutation(request, baseURL);
      if (provenance) return provenance;
    }

    if (route === 'sign-in') {
      const body = await readSignInBody(request);
      if (!body) return uniformLoginFailure();
      const email = normalizeEmail(body.email);
      const source = input.sourceKey(request);
      if (!await input.loginSourceAllowed(source)) return uniformLoginFailure();

      const credentialExists = email.length > 0 &&
        await input.backend.hasPasswordCredential(email);
      if (credentialExists && !await input.loginIdentityAllowed(email)) {
        return uniformLoginFailure();
      }
      if (!credentialExists) {
        await input.password.verify({ hash: DUMMY_PASSWORD_RECORD, password: body.password });
        await input.loginResult?.(source, email, false, false);
        return uniformLoginFailure();
      }

      const response = await auth.handler(request);
      await input.loginResult?.(source, email, true, response.ok);
      return response.ok ? response : uniformLoginFailure();
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

async function readSignInBody(request: Request): Promise<SignInBody | null> {
  try {
    const bytes = await request.clone().arrayBuffer();
    if (bytes.byteLength > MAX_AUTH_BODY_BYTES) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof parsed.email !== 'string' || typeof parsed.password !== 'string') return null;
    if (parsed.email.length > 320 || new TextEncoder().encode(parsed.password).length > 512) return null;
    return { email: parsed.email, password: parsed.password };
  } catch {
    return null;
  }
}

function normalizeEmail(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function uniformLoginFailure(): Response {
  return Response.json(UNIFORM_LOGIN_FAILURE, { status: 401 });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}
