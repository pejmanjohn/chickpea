import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import {
  getIdentityStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { createBetterAuthPublicHandler } from './better-auth-routes.ts';
import { AuthRateLimitError, AuthRateLimiter } from './rate-limit.ts';
import { requestAuthSourceKey } from './source-key.ts';
import {
  resolveBetterAuthEnvironment,
  type BetterAuthEnvironment,
} from './better-auth-environment.ts';

interface BetterAuthRuntimeOptions {
  identity?: IdentityStore;
  authSecret?: string;
  environment?: BetterAuthEnvironment;
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

  const handle = async (c: Context) => {
    try {
      return await dispatch(c, options);
    } catch {
      return c.json({ error: 'auth_unavailable' }, 503);
    }
  };

  app.all('/api/auth/*', handle);
  app.all('/.well-known/oauth-protected-resource', handle);
  app.all('/.well-known/oauth-protected-resource/mcp', handle);
  app.all('/.well-known/oauth-authorization-server/api/auth', handle);

  return app;
}

async function dispatch(c: Context, options: BetterAuthRuntimeOptions): Promise<Response> {
  const platformEnv = c.env as PlatformEnv | undefined;
  const identity = options.identity ?? getIdentityStore(platformEnv);
  const control = await identity.getAuthControl();
  if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
      !control.canonicalAdminOrigin ||
      !control.betterAuthOrganizationId) {
    return new Response('Not Found', { status: 404 });
  }

  const environment = options.environment ?? await resolveBetterAuthEnvironment({
    control,
    platformEnv,
    authSecret: options.authSecret,
  });
  if (!environment) return Response.json({ error: 'auth_unavailable' }, { status: 503 });

  if (c.req.method === 'POST' && c.req.path === '/api/auth/oauth2/register') {
    const limiter = new AuthRateLimiter(identity, {
      pepper: environment.secret,
      perKeyLimit: 20,
      globalLimit: 1_000,
    });
    const source = requestAuthSourceKey(c.req.raw);
    try {
      await limiter.assertAllowed('mcp_dcr', source);
      // DCR is an anonymous resource-allocation attempt, so every attempt
      // consumes quota regardless of whether Better Auth later accepts it.
      await limiter.recordFailure('mcp_dcr', source);
    } catch (error) {
      if (!(error instanceof AuthRateLimitError)) throw error;
      return Response.json(
        { error: 'registration_rate_limited' },
        {
          status: 429,
          headers: {
            'retry-after': String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))),
          },
        },
      );
    }
  }

  const handler = createBetterAuthEnvironmentPublicHandler({
    environment,
  });
  return handler(c.req.raw);
}

export function createBetterAuthEnvironmentPublicHandler(input: {
  environment: BetterAuthEnvironment;
}) {
  return createBetterAuthPublicHandler(input.environment);
}
