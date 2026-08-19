import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import {
  getIdentityStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { createBetterAuthPublicHandler } from './better-auth-routes.ts';
import {
  resolveBetterAuthEnvironment,
  type BetterAuthEnvironment,
} from './better-auth-environment.ts';

interface BetterAuthRuntimeOptions {
  identity?: IdentityStore;
  authSecret?: string;
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
  if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
      !control.canonicalAdminOrigin ||
      !control.betterAuthOrganizationId) {
    return new Response('Not Found', { status: 404 });
  }

  const environment = await resolveBetterAuthEnvironment({
    control,
    platformEnv,
    authSecret: options.authSecret,
  });
  if (!environment) return Response.json({ error: 'auth_unavailable' }, { status: 503 });

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
