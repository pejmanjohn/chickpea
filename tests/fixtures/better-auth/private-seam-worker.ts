import type { D1Database } from '@cloudflare/workers-types';

import { D1BetterAuthBackend } from '../../../src/auth/better-auth-cloudflare.ts';
import { createBetterAuthPublicHandler } from '../../../src/auth/better-auth-routes.ts';
import {
  BETTER_AUTH_PRIVATE_SESSION_PATH,
  BetterAuthIdentityConflictError,
  createBetterAuth,
  type BetterAuthAdmissionOperation,
  type ReconcileSlackIdentityInput,
} from '../../../src/auth/better-auth.ts';
import type { PasswordPrimitive } from '../../../src/auth/password.ts';

interface Env {
  AUTH_DB: D1Database;
}

const SECRET = 'u0-worker-secret-is-stable-across-isolate-restarts';
const ORGANIZATION = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Chickpea',
  slug: 'chickpea',
} as const;
const admissions = new Map<string, BetterAuthAdmissionOperation>();

const unusedPassword: PasswordPrimitive = {
  async hash() { throw new Error('Password hashing is outside the U0 Worker seam.'); },
  async verify() { return false; },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await dispatch(request, env);
    } catch (error) {
      if (error instanceof BetterAuthIdentityConflictError) {
        return Response.json({ error: 'identity_conflict' }, { status: 409 });
      }
      return Response.json({
        error: 'fixture_failure',
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      }, { status: 500 });
    }
  },
};

async function dispatch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const backend = new D1BetterAuthBackend(env.AUTH_DB);
  const privateSeam = {
    async resolveAdmissionOperation(operationId: string) {
      return admissions.get(operationId) ?? null;
    },
  };
  const auth = createBetterAuth({
    backend,
    baseURL: url.origin,
    secret: SECRET,
    password: unusedPassword,
    allowSignUp: false,
    privateSeam,
  });

  if (url.pathname === '/health') {
    const indexes = await env.AUTH_DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name IN (?, ?) ORDER BY name`,
    ).bind(
      'account_providerId_accountId_uidx',
      'member_organizationId_userId_uidx',
    ).all<{ name: string }>();
    return Response.json({ ok: true, indexes: indexes.results.map((row) => row.name) });
  }

  if (url.pathname === '/test/reconcile' && request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    return Response.json(await auth.chickpea.reconcileSlackIdentity(reconcileInput(body)));
  }

  if (url.pathname === '/test/finalize' && request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    const identity = await auth.chickpea.reconcileSlackIdentity(reconcileInput(body));
    const operationId = requiredString(body.operationId);
    admissions.set(operationId, {
      operationId,
      status: requiredString(body.status),
      chickpeaRole: requiredString(body.chickpeaRole),
      slackTeamId: requiredString(body.slackTeamId),
      slackUserId: requiredString(body.slackUserId),
      betterAuthUserId: identity.userId,
      betterAuthOrganizationId: identity.organizationId,
      betterAuthMembershipId: identity.membershipId,
    });
    return auth.chickpea.issueSession(operationId, request);
  }

  if (url.pathname === '/test/unmarked-private' && request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    const identity = await auth.chickpea.reconcileSlackIdentity(reconcileInput(body));
    const operationId = requiredString(body.operationId);
    admissions.set(operationId, {
      operationId,
      status: 'active',
      chickpeaRole: 'owner',
      slackTeamId: requiredString(body.slackTeamId),
      slackUserId: requiredString(body.slackUserId),
      betterAuthUserId: identity.userId,
      betterAuthOrganizationId: identity.organizationId,
      betterAuthMembershipId: identity.membershipId,
    });
    return auth.handler(new Request(`${url.origin}/api/auth${BETTER_AUTH_PRIVATE_SESSION_PATH}`, {
      method: 'POST',
      headers: {
        origin: url.origin,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({
        operationId,
        internalMarker: 'browser-forgery',
        userId: requiredString(body.injectedUserId),
      }),
    }));
  }

  if (url.pathname === '/test/snapshot') {
    const [users, accounts, members, sessions] = await Promise.all([
      env.AUTH_DB.prepare(
        'SELECT id, email, emailVerified FROM "user" ORDER BY createdAt, id',
      ).all(),
      env.AUTH_DB.prepare(
        'SELECT id, providerId, accountId, userId FROM account ORDER BY createdAt, id',
      ).all(),
      env.AUTH_DB.prepare(
        'SELECT id, organizationId, userId, role FROM member ORDER BY createdAt, id',
      ).all(),
      env.AUTH_DB.prepare(
        `SELECT id, userId, createdAt, expiresAt, absoluteExpiresAt
         FROM session ORDER BY createdAt, id`,
      ).all(),
    ]);
    return Response.json({
      users: users.results,
      accounts: accounts.results,
      members: members.results,
      sessions: sessions.results,
    });
  }

  if (url.pathname === '/test/expire-sessions' && request.method === 'POST') {
    await env.AUTH_DB.prepare('UPDATE session SET absoluteExpiresAt = ?').bind(Date.now() - 1).run();
    return Response.json({ ok: true });
  }

  if (url.pathname.startsWith('/api/auth/')) {
    return createBetterAuthPublicHandler({
      backend,
      baseURL: url.origin,
      secret: SECRET,
      password: unusedPassword,
      privateSeam,
      loginSourceAllowed: async () => true,
      loginIdentityAllowed: async () => true,
      sourceKey: () => 'u0-worker-fixture',
    })(request);
  }

  return new Response('Not Found', { status: 404 });
}

function reconcileInput(body: Record<string, unknown>): ReconcileSlackIdentityInput {
  return {
    slackTeamId: requiredString(body.slackTeamId),
    slackUserId: requiredString(body.slackUserId),
    displayName: requiredString(body.displayName),
    organization: ORGANIZATION,
    ...(typeof body.expectedUserId === 'string' ? { expectedUserId: body.expectedUserId } : {}),
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Fixture input requires a string.');
  return value;
}
