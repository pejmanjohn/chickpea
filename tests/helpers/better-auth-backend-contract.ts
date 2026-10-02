import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import {
  createBetterAuth,
  type BetterAuthAdmissionOperation,
  type ReconciledSlackIdentity,
} from '../../src/auth/better-auth.ts';
import type { BetterAuthDatabaseBackend } from '../../src/auth/better-auth-backend.ts';
import { createBetterAuthPublicHandler } from '../../src/auth/better-auth-routes.ts';

export interface BetterAuthBackendSubject {
  backend: BetterAuthDatabaseBackend;
  /** Rows in one table, read directly from the database. */
  count(table: string): Promise<number>;
  close(): Promise<void>;
}

export interface BetterAuthBackendContract {
  label: string;
  open(): Promise<BetterAuthBackendSubject>;
  /** A reason to skip every case, decided when the cases run. */
  unavailable?(): Promise<string | undefined>;
}

const ORIGIN = 'https://chickpea.example';
const REDIRECT = 'http://127.0.0.1:47321/callback';

/** One behavior contract for every Better Auth database backend. */
export function testBetterAuthBackendContract(contract: BetterAuthBackendContract): void {
  const it = (name: string, body: (fixture: Fixture) => Promise<void>) => {
    test(`${contract.label}: ${name}`, { timeout: 60_000 }, async (t) => {
      const fixture = await openFixture(t, contract);
      if (fixture) await body(fixture);
    });
  };

  it('an empty database has no authority and reads unknown IDs as absent', async ({ backend }) => {
    assert.equal(await backend.hasIdentityAuthority(), false);
    for (const id of [randomUUID(), 'not-a-canonical-id']) {
      assert.equal(await backend.getUser(id), null);
      assert.equal(await backend.getOrganization(id), null);
      assert.equal(await backend.getMembership(id), null);
      assert.equal(await backend.getMembershipForUser(id, id), null);
      assert.deepEqual(await backend.listMemberships(id), []);
      assert.deepEqual(await backend.listMembershipsForUser(id), []);
      assert.equal(await backend.deleteSessionsForUser(id), 0);
    }
    assert.equal(await backend.findUserByEmail('nobody@identity.invalid'), null);
    assert.equal(await backend.absoluteExpiryForToken('missing'), null);
    assert.equal(await backend.countMcpOAuthClients(), 0);
  });

  it('two installations with colliding Slack user IDs stay separate', async (f) => {
    const a = await f.reconcile('TAAAA', 'U0001', 'chickpea-org_a');
    const b = await f.reconcile('TBBBB', 'U0001', 'chickpea-org_b');
    assert.notEqual(a.userId, b.userId);
    assert.notEqual(a.organizationId, b.organizationId);
    assert.notEqual(a.membershipId, b.membershipId);
    assert.equal(a.accountId, 'slack:TAAAA:U0001');
    assert.equal(b.accountId, 'slack:TBBBB:U0001');
    assert.deepEqual(await f.reconcile('TAAAA', 'U0001', 'chickpea-org_a'), a);
    assert.equal(await f.backend.hasIdentityAuthority(), true);

    const user = await f.backend.getUser(a.userId);
    assert.equal(user?.id, a.userId);
    assert.equal(user.name, 'TAAAA/U0001');
    assert.ok(user.createdAt > 0 && user.updatedAt >= user.createdAt);
    assert.equal((await f.backend.findUserByEmail(user.email.toUpperCase()))?.id, a.userId);
    const organization = await f.backend.getOrganization(a.organizationId);
    assert.equal(organization?.id, a.organizationId);
    assert.equal(organization.name, 'chickpea-org_a');
    assert.ok(organization.createdAt > 0);
    assert.equal((await f.backend.getMembership(a.membershipId))?.userId, a.userId);
    assert.equal((await f.backend.getMembershipForUser(a.userId, a.organizationId))?.id, a.membershipId);
    assert.equal(await f.backend.getMembershipForUser(a.userId, b.organizationId), null);

    const members = await f.backend.listMemberships(a.organizationId);
    assert.deepEqual(members.map((member) => [member.id, member.role, member.user?.id]),
      [[a.membershipId, 'member', a.userId]]);
    assert.deepEqual((await f.backend.listMembershipsForUser(b.userId)).map((member) => member.organizationId),
      [b.organizationId]);
  });

  it('revoking one login\'s sessions takes effect on the next read', async (f) => {
    const a = await f.reconcile('TAAAA', 'U0001', 'chickpea-org_a');
    const b = await f.reconcile('TBBBB', 'U0001', 'chickpea-org_b');
    const cookieA = await f.signIn(a, 'TAAAA', 'U0001');
    const cookieB = await f.signIn(b, 'TBBBB', 'U0001');
    const sessionA = await f.session(cookieA);
    assert.equal(sessionA?.user.id, a.userId);
    assert.equal((await f.session(cookieB))?.user.id, b.userId);

    const absolute = await f.backend.absoluteExpiryForToken(sessionA.session.token);
    assert.ok(absolute instanceof Date);
    assert.ok(absolute.getTime() > Date.now() + 29 * 24 * 60 * 60 * 1_000);

    assert.equal(await f.backend.deleteSessionsForUser(a.userId), 1);
    assert.equal(await f.session(cookieA), null);
    assert.equal((await f.session(cookieB))?.user.id, b.userId);
  });

  it('an unauthenticated MCP client registers, counts and is pruned once unused', async (f) => {
    const registered = await f.handler(json('/api/auth/oauth2/register', registration('Contract')));
    assert.equal(registered.status, 201, await registered.clone().text());
    assert.equal(await f.backend.countMcpOAuthClients(), 1);
    assert.equal(await f.backend.pruneUnusedMcpOAuthClients(new Date(Date.now() - 60_000).toISOString()), 0);
    assert.equal(await f.backend.countMcpOAuthClients(), 1);
    assert.equal(await f.backend.pruneUnusedMcpOAuthClients(new Date(Date.now() + 60_000).toISOString()), 1);
    assert.equal(await f.backend.countMcpOAuthClients(), 0);
  });

  it('an OAuth continuation is consumed once and an expired one is refused', async (f) => {
    const now = Date.now();
    await f.backend.putMcpOAuthContinuation({
      idHash: 'live', authorizationPath: '/api/auth/oauth2/authorize?x=1',
      expiresAt: now + 600_000, createdAt: now,
    });
    await f.backend.putMcpOAuthContinuation({
      idHash: 'stale', authorizationPath: '/api/auth/oauth2/authorize?x=2',
      expiresAt: now - 1, createdAt: now - 600_000,
    });
    assert.equal(await f.backend.consumeMcpOAuthContinuation('live', now), '/api/auth/oauth2/authorize?x=1');
    assert.equal(await f.backend.consumeMcpOAuthContinuation('live', now), null);
    assert.equal(await f.backend.consumeMcpOAuthContinuation('stale', now), null);
    assert.equal(await f.backend.consumeMcpOAuthContinuation('missing', now), null);
    assert.equal(await f.count('chickpea_mcp_oauth_continuation'), 0);
  });

  it('concurrent first sign-ins converge on one login, organization and membership', async (f) => {
    const same = await Promise.all(Array.from({ length: 8 }, () =>
      f.reconcile('TCCCC', 'U0009', 'chickpea-org_c')));
    assert.equal(new Set(same.map((identity) => JSON.stringify(identity))).size, 1);
    assert.equal(await f.count('user'), 1);
    assert.equal(await f.count('account'), 1);
    assert.equal(await f.count('organization'), 1);
    assert.equal(await f.count('member'), 1);

    // Different people racing on a new organization all join the one that wins.
    const members = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      f.reconcile('TDDDD', `U00${index}`, 'chickpea-org_d')));
    assert.equal(new Set(members.map((identity) => identity.organizationId)).size, 1);
    assert.equal(new Set(members.map((identity) => identity.membershipId)).size, 8);
    assert.equal(await f.count('organization'), 2);
    assert.equal(await f.count('member'), 9);
  });
}

interface Fixture extends BetterAuthBackendSubject {
  handler(request: Request): Promise<Response>;
  reconcile(team: string, user: string, slug: string): Promise<ReconciledSlackIdentity>;
  signIn(identity: ReconciledSlackIdentity, team: string, user: string): Promise<string>;
  session(cookie: string): Promise<{ user: { id: string }; session: { token: string } } | null>;
}

async function openFixture(t: TestContext, contract: BetterAuthBackendContract): Promise<Fixture | undefined> {
  const reason = await contract.unavailable?.();
  if (reason) {
    t.skip(reason);
    return undefined;
  }
  const subject = await contract.open();
  t.after(() => subject.close());
  const admissions = new Map<string, BetterAuthAdmissionOperation>();
  const options = {
    backend: subject.backend,
    baseURL: ORIGIN,
    secret: randomBytes(32).toString('base64url'),
    privateSeam: { resolveAdmissionOperation: async (id: string) => admissions.get(id) ?? null },
  };
  const auth = createBetterAuth(options);
  // Better Auth initializes against the database in the background.
  await auth.$context;
  return {
    ...subject,
    handler: createBetterAuthPublicHandler(options),
    reconcile: (team, user, slug) => auth.chickpea.reconcileSlackIdentity({
      slackTeamId: team, slackUserId: user, displayName: `${team}/${user}`,
      organization: { name: slug, slug },
    }),
    async signIn(identity, team, user) {
      const operationId = randomUUID();
      admissions.set(operationId, {
        operationId, status: 'active', chickpeaRole: 'owner', slackTeamId: team, slackUserId: user,
        betterAuthUserId: identity.userId, betterAuthOrganizationId: identity.organizationId,
        betterAuthMembershipId: identity.membershipId,
      });
      const response = await auth.chickpea.issueSession(operationId);
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
    },
    session: async (cookie) => await auth.api.getSession({ headers: new Headers({ cookie }) }),
  };
}

function registration(name: string) {
  return {
    application_type: 'native', client_name: name,
    grant_types: ['authorization_code', 'refresh_token'], redirect_uris: [REDIRECT],
    response_types: ['code'], token_endpoint_auth_method: 'none',
  };
}

function json(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
