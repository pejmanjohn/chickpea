import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import {
  getIdentityStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { HumanIdentityDirectory, IdentityStore } from '../identity/types.ts';
import { createBetterAuthPublicHandler } from './better-auth-routes.ts';
import {
  cloudflareLoginIdentityAllowed,
  cloudflareLoginSourceAllowed,
} from './better-auth-cloudflare.ts';
import {
  resolveBetterAuthEnvironment,
  type BetterAuthEnvironment,
} from './better-auth-environment.ts';
import { AuthRateLimitError, AuthRateLimiter } from './rate-limit.ts';
import { requestAuthSourceKey } from './source-key.ts';
import { BetterAuthDirectory } from './better-auth-principal.ts';

interface BetterAuthRuntimeOptions {
  identity?: IdentityStore;
  recoveryToken?: string;
}

/**
 * Every other unauthenticated POST surface caps its body before buffering
 * (`/admin/login`, `/admin/setup`, `/admin/recovery`, `/admin/join`,
 * `/admin/reset`, `/admin/migrate` — see src/admin/routes.ts:1324-1343). This
 * one did not, so an anonymous client could stream an unbounded body into
 * sign-in. A sign-in payload is an email plus a password; 32 KiB is generous.
 * hono's bodyLimit reads chunk-by-chunk and bails on the running total, so a
 * chunked request with no content-length cannot walk past it.
 */
const AUTH_ROUTE_BODY_LIMIT_BYTES = 32 * 1024;

export function createBetterAuthRuntimeRoutes(options: BetterAuthRuntimeOptions = {}): Hono {
  const app = new Hono();

  app.use('/api/auth/*', bodyLimit({
    maxSize: AUTH_ROUTE_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  }));

  app.all('/api/auth/*', async (c) => {
    try {
      return await dispatch(c, options);
    } catch {
      return c.json({ error: 'auth_unavailable' }, 503);
    }
  });

  return app;
}

async function dispatch(c: Context, options: BetterAuthRuntimeOptions): Promise<Response> {
  const platformEnv = c.env as PlatformEnv | undefined;
  const identity = options.identity ?? getIdentityStore(platformEnv);
  const control = await identity.getAuthControl();
  if (control?.authMode !== 'password_active' || !control.canonicalAdminOrigin ||
      !control.betterAuthOrganizationId) {
    return new Response('Not Found', { status: 404 });
  }

  const sourceKey = requestAuthSourceKey(c.req.raw, Boolean(platformEnv?.AUTH_DB));
  const environment = await resolveBetterAuthEnvironment({
    control,
    platformEnv,
    recoveryToken: options.recoveryToken,
    passwordShardKey: sourceKey,
  });
  if (!environment) return Response.json({ error: 'auth_unavailable' }, { status: 503 });

  const handler = createBetterAuthEnvironmentPublicHandler({
    environment,
    identity,
    directory: new BetterAuthDirectory({
      backend: environment.backend,
      access: identity,
      organizationId: control.betterAuthOrganizationId,
      canonicalAdminOrigin: control.canonicalAdminOrigin,
    }),
  });
  return handler(c.req.raw);
}

export function createBetterAuthEnvironmentPublicHandler(input: {
  environment: BetterAuthEnvironment;
  identity: IdentityStore;
  directory?: HumanIdentityDirectory;
}) {
  const { environment, identity } = input;
  const directory = input.directory ?? identity;
  const identityIsAdmitted = (email: string) => loginAdmissionAllows(identity, directory, email);
  if (environment.cloudflareEnv) {
    return createBetterAuthPublicHandler({
      ...environment,
      loginSourceAllowed: (source) => cloudflareLoginSourceAllowed(
        environment.cloudflareEnv!, source,
      ),
      loginIdentityAllowed: async (email) =>
        await cloudflareLoginIdentityAllowed(environment.cloudflareEnv!, email) &&
        await identityIsAdmitted(email),
      sourceKey: (request) => requestAuthSourceKey(request, true),
    });
  }

  const limiter = new AuthRateLimiter(identity, {
    pepper: environment.recoveryToken,
    perKeyLimit: 10,
    globalLimit: 500,
  });
  return createBetterAuthPublicHandler({
    ...environment,
    loginSourceAllowed: async (source) => {
      try {
        await limiter.assertAllowed('better_auth_login_source', source);
        return true;
      } catch (error) {
        if (error instanceof AuthRateLimitError) return false;
        throw error;
      }
    },
    loginIdentityAllowed: async (email) => {
      try {
        await limiter.assertAllowed('better_auth_login_identity', email);
        return identityIsAdmitted(email);
      } catch (error) {
        if (error instanceof AuthRateLimitError) return false;
        throw error;
      }
    },
    loginResult: async (source, email, credentialExists, success) => {
      const operation = success ? 'recordSuccess' : 'recordFailure';
      await limiter[operation]('better_auth_login_source', source);
      if (credentialExists) {
        await limiter[operation]('better_auth_login_identity', email);
      }
    },
    sourceKey: (request) => requestAuthSourceKey(request, false),
  });
}

async function loginAdmissionAllows(
  identity: IdentityStore,
  directory: HumanIdentityDirectory,
  email: string,
): Promise<boolean> {
  const [organization, user] = await Promise.all([
    directory.getOrganization(),
    directory.findUserByEmail(email),
  ]);
  if (!organization || !user) return false;
  const membership = await directory.getMembershipForUser(user.id, organization.id);
  if (membership?.status === 'active') return true;
  if (membership) return false;
  const pendingInvitations = await identity.listAuthOperations(
    'invitation_enrollment',
    organization.id,
  );
  return pendingInvitations.some((operation) =>
    operation.status === 'pending' &&
    operation.expiresAt > Date.now() &&
    operation.expectedNormalizedEmail === email);
}
