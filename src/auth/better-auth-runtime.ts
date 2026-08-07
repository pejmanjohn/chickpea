import { Hono, type Context } from 'hono';

import {
  getIdentityStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { createBetterAuthPublicHandler } from './better-auth-routes.ts';
import { cloudflareLoginAllowed } from './better-auth-cloudflare.ts';
import {
  resolveBetterAuthEnvironment,
  type BetterAuthEnvironment,
} from './better-auth-environment.ts';
import { AuthRateLimitError, AuthRateLimiter } from './rate-limit.ts';
import { requestAuthSourceKey } from './source-key.ts';

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
  if (control?.authMode !== 'password_active' || !control.canonicalAdminOrigin) {
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
    cloudflare: Boolean(environment.cloudflareEnv),
  });
  return handler(c.req.raw);
}

export function createBetterAuthEnvironmentPublicHandler(input: {
  environment: BetterAuthEnvironment;
  identity: IdentityStore;
  cloudflare: boolean;
}) {
  const { environment, identity } = input;
  if (environment.cloudflareEnv) {
    return createBetterAuthPublicHandler({
      ...environment,
      loginAllowed: (source, email) => cloudflareLoginAllowed(
        environment.cloudflareEnv!, source, email,
      ),
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
    loginAllowed: async (source, email) => {
      try {
        await Promise.all([
          limiter.assertAllowed('better_auth_login_source', source),
          limiter.assertAllowed('better_auth_login_identity', email),
        ]);
        return true;
      } catch (error) {
        if (error instanceof AuthRateLimitError) return false;
        throw error;
      }
    },
    loginResult: async (source, email, success) => {
      const operation = success ? 'recordSuccess' : 'recordFailure';
      await Promise.all([
        limiter[operation]('better_auth_login_source', source),
        limiter[operation]('better_auth_login_identity', email),
      ]);
    },
    sourceKey: (request) => requestAuthSourceKey(request, false),
  });
}
