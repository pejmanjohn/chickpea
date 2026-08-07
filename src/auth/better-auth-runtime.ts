import { Hono, type Context } from 'hono';

import {
  getIdentityStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { createBetterAuthPublicHandler } from './better-auth-routes.ts';
import {
  D1BetterAuthBackend,
  cloudflareLoginAllowed,
  cloudflarePasswordPrimitive,
  type CloudflareBetterAuthEnv,
} from './better-auth-cloudflare.ts';
import { getNodeBetterAuthBackend } from './better-auth-node.ts';
import { nativePasswordPrimitive } from './password.ts';
import { AuthRateLimitError, AuthRateLimiter } from './rate-limit.ts';
import { deriveBetterAuthSecret } from './recovery-secret.ts';
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

  const recoveryToken = options.recoveryToken ?? recoverySecret(platformEnv);
  if (!recoveryToken) return Response.json({ error: 'auth_unavailable' }, { status: 503 });
  const secret = await deriveBetterAuthSecret(recoveryToken);

  if (isCloudflareTarget()) {
    const env = cloudflareAuthEnv(platformEnv);
    if (!env) return Response.json({ error: 'auth_unavailable' }, { status: 503 });
    const sourceKey = requestAuthSourceKey(c.req.raw, true);
    const handler = createBetterAuthPublicHandler({
      backend: new D1BetterAuthBackend(env.AUTH_DB),
      baseURL: control.canonicalAdminOrigin,
      secret,
      password: cloudflarePasswordPrimitive(env, sourceKey),
      loginAllowed: (source, email) => cloudflareLoginAllowed(env, source, email),
      sourceKey: (request) => requestAuthSourceKey(request, true),
    });
    return handler(c.req.raw);
  }

  const limiter = new AuthRateLimiter(identity, {
    pepper: recoveryToken,
    perKeyLimit: 10,
    globalLimit: 500,
  });
  const handler = createBetterAuthPublicHandler({
    backend: getNodeBetterAuthBackend(),
    baseURL: control.canonicalAdminOrigin,
    secret,
    password: nativePasswordPrimitive(),
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
  return handler(c.req.raw);
}

function recoverySecret(env: PlatformEnv | undefined): string | undefined {
  const bound = env?.CHICKPEA_RECOVERY_TOKEN;
  if (typeof bound === 'string' && bound) return bound;
  const local = process.env.CHICKPEA_RECOVERY_TOKEN;
  return local || undefined;
}

function cloudflareAuthEnv(env: PlatformEnv | undefined): CloudflareBetterAuthEnv | undefined {
  if (!env || typeof env.CHICKPEA_RECOVERY_TOKEN !== 'string') return undefined;
  const authDb = env.AUTH_DB as { prepare?: unknown } | undefined;
  const authGuard = env.AUTH_GUARD as { getByName?: unknown } | undefined;
  if (typeof authDb?.prepare !== 'function' || typeof authGuard?.getByName !== 'function') {
    return undefined;
  }
  return env as unknown as CloudflareBetterAuthEnv;
}
