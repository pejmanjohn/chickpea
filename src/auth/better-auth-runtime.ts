import { Hono, type Context } from 'hono';

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
  recoveryToken?: string;
}

export function createBetterAuthRuntimeRoutes(options: BetterAuthRuntimeOptions = {}): Hono {
  const app = new Hono();

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
    recoveryToken: options.recoveryToken,
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
