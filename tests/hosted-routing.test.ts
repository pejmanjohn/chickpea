import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, test, type TestContext } from 'node:test';

import type { ExecutionContext } from 'hono';
import pg from 'pg';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  configureBetterAuthBackendFactory,
  withBetterAuthAccessRevoker,
  withBetterAuthBackend,
} from '../src/auth/better-auth-environment.ts';
import { openPostgresBetterAuthBackend } from '../src/auth/better-auth-postgres.ts';
import { applyPostgresBetterAuthMigrations } from '../src/auth/better-auth-postgres-migrations.ts';
import { BetterAuthDirectory } from '../src/auth/better-auth-principal.ts';
import { createBetterAuthRuntimeRoutes } from '../src/auth/better-auth-runtime.ts';
import { hostedLoginFence, hostedLoginOf, withHostedLogin, type HostedRouteReads } from '../src/auth/hosted-login.ts';
import {
  isHostedSharedAuthPath,
  resolveHostedLogin,
  routeHostedRequest,
  serveHostedSharedAuth,
  type HostedRouting,
} from '../src/auth/hosted-routing.ts';
import { activateInstallerOwner } from '../src/auth/installer-owner.ts';
import { signInSlackMember } from '../src/auth/member-sign-in.ts';
import { applyGatewaySlackUserChange } from '../src/auth/slack-membership-events.ts';
import { createMcpOAuthRuntimeRoutes } from '../src/auth/mcp-oauth-routes.ts';
import {
  resolveInstallationEnv,
  type InstallationKey,
  type InstallationLookup,
  type InstallationRecord,
} from '../src/config/installation-lookup.ts';
import { installationScopeOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { holdUntilResponseEnds } from '../src/http/response-lifetime.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { startPostgresTestCluster, type PostgresTestClusterStart } from './helpers/postgres-cluster.ts';

const ORIGIN = 'https://hosted.example';
const SECRET = randomBytes(32).toString('base64url');
const HOSTED = { CHICKPEA_TENANCY: 'installation', CHICKPEA_AUTH_SECRET: SECRET };
const RESOURCE = `${ORIGIN}/mcp`;
const RENEWABLE_SCOPE = 'chickpea:workspace offline_access';
const REDIRECT = 'http://127.0.0.1:47321/callback';

// Skipped only when CHICKPEA_TEST_POSTGRES_BIN is set empty; a missing server fails.
let started: Promise<PostgresTestClusterStart> | undefined;
const cluster = () => started ??= startPostgresTestCluster();
after(async () => (await started?.catch(() => undefined))?.cluster?.stop());

/** Cleanup that runs last-in, first-out when the test ends. */
function deferrals(t: TestContext) {
  const steps: Array<() => unknown> = [];
  t.after(async () => {
    for (const step of steps.reverse()) await step();
  });
  return (step: () => unknown) => void steps.push(step);
}

const capability = (name: string) => `${name}-capability-0123456789abcdef0123`;

function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.includes('session_token='));
  assert.ok(cookie, 'a session cookie was issued');
  return cookie.split(';', 1)[0]!;
}

/**
 * A host serving two installations on one PostgreSQL Better Auth: an
 * in-memory registry, one identity store per installation (the stand-in for
 * its TagStateStore), and the env each request gets.
 */
async function hostedDeployment(t: TestContext) {
  const defer = deferrals(t);
  const running = await cluster();
  if (!running.cluster) {
    t.skip(running.skip);
    return undefined;
  }
  const created = await running.cluster.createDatabase();
  defer(() => created.drop());
  const config = { ...running.cluster.connection, database: created.name };
  const migrator = new pg.Pool({ ...config, max: 1 });
  try {
    await applyPostgresBetterAuthMigrations(migrator);
  } finally {
    await migrator.end();
  }
  const backend = openPostgresBetterAuthBackend(config);
  defer(() => backend.close());
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };

  const records: InstallationRecord[] = [];
  const lookup: InstallationLookup = {
    async find(key: InstallationKey) {
      const matches = records.filter((record) => 'slackTeamId' in key
        ? record.slackTeamId === key.slackTeamId
        : record.identity.installationId === key.installationId);
      return matches.find((record) => record.status === 'active') ?? matches.at(-1);
    },
    async listActive() {
      return records.filter((record) => record.status === 'active');
    },
  };
  const stores = new Map<string, SqliteIdentityStore>();
  const storeOf = (env: PlatformEnv) => {
    const store = stores.get(installationScopeOf(env)?.installationId ?? '');
    assert.ok(store, 'the env names a known installation');
    return store;
  };
  const routing: HostedRouting<PlatformEnv> = {
    environment,
    installationEnv: (login) => resolveInstallationEnv(
      lookup,
      withBetterAuthBackend(HOSTED as PlatformEnv, backend),
      { slackTeamId: login.slackTeamId },
    ),
    identity: storeOf,
  };

  async function install(slackTeamId: string, organizationId: string, ownerSlackUserId: string) {
    const installationId = `inst_${organizationId}`;
    const identity = new SqliteIdentityStore(':memory:', { installation: () => ({ organizationId, installationId }) });
    defer(() => identity.close());
    stores.set(installationId, identity);
    const record: { -readonly [K in keyof InstallationRecord]: InstallationRecord[K] } = {
      identity: { organizationId, installationId }, slackTeamId, status: 'active',
    };
    records.push(record);
    const ownerCookie = sessionCookie(await activateInstallerOwner({
      identity, environment,
      proof: { slackTeamId, slackUserId: ownerSlackUserId, displayName: 'Owner', eligibility: 'install_grant' },
      installGrant: { slackTeamId, installerSlackUserId: ownerSlackUserId },
      capability: capability(`install-${organizationId}`),
      request: new Request(`${ORIGIN}/start/install/callback`),
    }));
    return {
      identity, record, installationId, ownerCookie,
      /** A Member Slack provisioned, signed in through the host. */
      async member(slackUserId: string) {
        const provisioned = await identity.provisionSlackMember({ slackTeamId, slackUserId, displayName: 'Member' });
        const cookie = sessionCookie(await signInSlackMember({
          identity, environment, proof: { slackTeamId, slackUserId, displayName: 'Member' },
          capability: capability(`member-${slackUserId}`), request: new Request(`${ORIGIN}/start/callback`),
        }));
        return { cookie, membershipId: provisioned.resolution.membership.id };
      },
    };
  }

  const shared = async (request: Request) => {
    const response = await serveHostedSharedAuth(request, routing);
    assert.ok(response, `${new URL(request.url).pathname} is served before any installation`);
    return response;
  };
  const token = (body: Record<string, string>) => shared(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  }));

  /** Connects an MCP client as the person `cookie` signs in, through the shared routes only. */
  async function mcpGrant(cookie: string) {
    const registered = await shared(new Request(`${ORIGIN}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        application_type: 'native', client_name: 'Hosted client',
        grant_types: ['authorization_code', 'refresh_token'], redirect_uris: [REDIRECT],
        response_types: ['code'], token_endpoint_auth_method: 'none', scope: RENEWABLE_SCOPE,
      }),
    }));
    assert.equal(registered.status, 201, await registered.clone().text());
    const { client_id: clientId } = await registered.json() as { client_id: string };
    const { code, verifier } = await authorizationCode(clientId, cookie);
    const exchanged = await token({
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier,
      redirect_uri: REDIRECT, resource: RESOURCE,
    });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const tokens = await exchanged.json() as { access_token: string; refresh_token: string };
    return { clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  }

  async function authorizationCode(clientId: string, cookie: string) {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: RENEWABLE_SCOPE,
      state: 'client-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    const authorize = await shared(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, { headers: { cookie } }));
    assert.equal(authorize.status, 302);
    const location = new URL(authorize.headers.get('location')!, ORIGIN);
    if (location.pathname === '/callback') return { code: location.searchParams.get('code')!, verifier };
    assert.equal(location.pathname, '/auth/mcp/consent');
    assert.equal((await shared(new Request(location, { headers: { cookie } }))).status, 200);
    const consent = await shared(new Request(`${ORIGIN}/auth/mcp/consent`, {
      method: 'POST',
      headers: {
        cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ oauth_query: location.search.slice(1), decision: 'allow' }),
    }));
    assert.equal(consent.status, 200, await consent.clone().text());
    const destination = /url=([^"]+)"/.exec(await consent.text())![1]!.replaceAll('&amp;', '&');
    return { code: new URL(destination).searchParams.get('code')!, verifier };
  }

  const refresh = (grant: { clientId: string; refreshToken: string }) => token({
    grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refreshToken, resource: RESOURCE,
  });

  /** Routes a request as the host would and lets Core serve it with the env that comes back. */
  const background: Promise<unknown>[] = [];
  defer(() => Promise.allSettled(background));
  const executionCtx = { waitUntil: (promise: Promise<unknown>) => void background.push(promise), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const mcpApp = (env: PlatformEnv) => createMcpOAuthRuntimeRoutes({
    identity: storeOf(env),
    createServer: (principal) => async () => Response.json(principal),
  });
  const adminApps = new Map<string, ReturnType<typeof createAdminRoutes>>();
  const adminApp = (env: PlatformEnv) => {
    const key = installationScopeOf(env)!.installationId;
    let app = adminApps.get(key);
    if (!app) {
      const store = new SqliteConfigStore(':memory:', { agents: [] });
      const settings = new SqliteSettingsStore(':memory:');
      defer(() => { store.close(); settings.close(); });
      app = createAdminRoutes({ identity: storeOf(env), store, settings });
      adminApps.set(key, app);
    }
    return app;
  };
  async function serve(request: Request) {
    const routed = await routeHostedRequest(request, routing);
    if (routed.kind !== 'installation') return { routed, response: routed.response };
    const app = new URL(request.url).pathname === '/mcp' ? mcpApp(routed.env) : adminApp(routed.env);
    return { routed, response: await app.fetch(request, routed.env, executionCtx) };
  }
  const mcpRequest = (accessToken?: string) => new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    body: '{}',
  });
  const adminRequest = (path: string, cookie?: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string> | undefined) },
  });

  return {
    config, backend, environment, routing, records, lookup, stores, storeOf,
    install, shared, mcpGrant, authorizationCode, token, refresh, serve, mcpRequest, adminRequest,
  };
}

test('a session and an MCP token reach only their own installation; nothing the client sends redirects them', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const beta = await hosted.install('TBETA', 'org_beta', 'UOWNERB');

  for (const [tenant, slackUserId] of [[acme, 'UOWNERA'], [beta, 'UOWNERB']] as const) {
    const { routed, response } = await hosted.serve(hosted.adminRequest('/admin/api/team', tenant.ownerCookie));
    assert.equal(routed.kind, 'installation');
    if (routed.kind !== 'installation') return;
    assert.deepEqual(installationScopeOf(routed.env), { installationId: tenant.installationId });
    assert.equal(routed.login.slackUserId, slackUserId);
    assert.deepEqual(hostedLoginOf(routed.env), routed.login);
    assert.equal(response?.status, 200, await response?.clone().text() ?? 'no response');
    const team = await response!.json() as { members: Array<{ slackUserId: string }> };
    assert.deepEqual(team.members.map((member) => member.slackUserId), [slackUserId], 'each Admin lists only its own team');
  }

  // A URL, query or header naming the other installation changes nothing.
  const redirected = await hosted.serve(hosted.adminRequest(
    `/admin/api/team?installationId=${beta.installationId}&organizationId=org_beta`,
    acme.ownerCookie,
    { headers: { 'x-chickpea-installation': beta.installationId, 'x-chickpea-organization': 'org_beta' } },
  ));
  assert.equal(redirected.routed.kind === 'installation' && installationScopeOf(redirected.routed.env)?.installationId,
    acme.installationId);
  // Without a session there is nothing to route by.
  assert.deepEqual(await routeHostedRequest(hosted.adminRequest('/admin/api/team'), hosted.routing), { kind: 'unauthenticated' });
  assert.deepEqual(await routeHostedRequest(hosted.adminRequest('/admin/api/team', 'better-auth.session_token=forged'), hosted.routing),
    { kind: 'unauthenticated' });

  // MCP: a token connected through the shared routes reaches its own installation only.
  const acmeGrant = await hosted.mcpGrant(acme.ownerCookie);
  const betaGrant = await hosted.mcpGrant(beta.ownerCookie);
  for (const [grant, tenant] of [[acmeGrant, acme], [betaGrant, beta]] as const) {
    const { routed, response } = await hosted.serve(hosted.mcpRequest(grant.accessToken));
    assert.equal(routed.kind === 'installation' && installationScopeOf(routed.env)?.installationId, tenant.installationId);
    assert.equal(response?.status, 200, await response?.clone().text() ?? 'no response');
    const principal = await response!.json() as { organizationId: string; role: string };
    assert.deepEqual([principal.organizationId, principal.role], [tenant.record.identity.organizationId, 'owner']);
  }
  const missing = await hosted.serve(hosted.mcpRequest());
  assert.equal(missing.response?.status, 401);
  assert.doesNotMatch(missing.response?.headers.get('www-authenticate') ?? '', /error=/);
  assert.match(missing.response?.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/hosted\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  const forged = await hosted.serve(hosted.mcpRequest(`${acmeGrant.accessToken.slice(0, -4)}AAAA`));
  assert.equal(forged.response?.status, 401);
  assert.match(forged.response?.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

  // Even a host that served A's credentials with B's env would get nothing from Core.
  const acmeRoute = await routeHostedRequest(hosted.mcpRequest(acmeGrant.accessToken), hosted.routing);
  assert.equal(acmeRoute.kind, 'installation');
  if (acmeRoute.kind !== 'installation') return;
  const betaEnv = await hosted.routing.installationEnv({ betterAuthUserId: 'x', slackTeamId: 'TBETA', slackUserId: 'UOWNERB' });
  for (const env of [betaEnv, withHostedLogin(betaEnv, acmeRoute.login)]) {
    const mcp = await createMcpOAuthRuntimeRoutes({
      identity: hosted.storeOf(env), createServer: () => async () => Response.json({ served: true }),
    }).fetch(hosted.mcpRequest(acmeGrant.accessToken), env);
    assert.equal(mcp.status, 403, 'B serves nobody routed by another login, or by none');
  }
  const crossAdmin = await createAdminRoutes({
    identity: hosted.storeOf(betaEnv),
    store: new SqliteConfigStore(':memory:', { agents: [] }),
    settings: new SqliteSettingsStore(':memory:'),
  }).fetch(hosted.adminRequest('/admin/api/team', acme.ownerCookie), withHostedLogin(betaEnv, acmeRoute.login));
  assert.equal(crossAdmin.status, 401);

  // Hosted Admin authenticates the routed browser session only, never a bearer.
  const bearer = await hosted.serve(hosted.adminRequest('/admin/api/team', acme.ownerCookie, {
    headers: { authorization: 'Bearer chp_pat_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' },
  }));
  assert.equal(bearer.response?.status, 401);
});

test('an installation whose stored association disagrees with the login fails closed', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const route = () => routeHostedRequest(hosted.adminRequest('/admin/api/team', acme.ownerCookie), hosted.routing);
  const routed = await route();
  assert.equal(routed.kind, 'installation');
  if (routed.kind !== 'installation') return;
  const userId = routed.login.betterAuthUserId;

  // The account now names another person in the workspace than the binding the installation stored.
  await hosted.backend.pool.query(`UPDATE account SET "accountId" = 'slack:TACME:USOMEONE' WHERE "userId" = $1`, [userId]);
  assert.deepEqual(await route(), { kind: 'refused' });
  // A login with a second Slack account has no single workspace.
  await hosted.backend.pool.query(`UPDATE account SET "accountId" = 'slack:TACME:UOWNERA' WHERE "userId" = $1`, [userId]);
  assert.equal((await route()).kind, 'installation');
  await hosted.backend.pool.query(
    `INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt", issuer)
     SELECT gen_random_uuid(), 'slack:TOTHER:UOWNERA', "providerId", "userId", now(), now(), issuer FROM account WHERE "userId" = $1`,
    [userId],
  );
  assert.deepEqual(await route(), { kind: 'unauthenticated' });
  await hosted.backend.pool.query(`DELETE FROM account WHERE "accountId" = 'slack:TOTHER:UOWNERA'`);
  assert.equal((await route()).kind, 'installation');

  // A reinstall is a new installation: a session from the old one finds no binding there.
  acme.record.status = 'revoked';
  await hosted.install('TACME', 'org_acme2', 'UOWNERX');
  assert.deepEqual(await route(), { kind: 'refused' });

  // Inside an installation the directory holds a principal to the routed login, and to the
  // workspace the installation itself records.
  const control = (await acme.identity.getAuthControl())!;
  const directory = (login?: typeof routed.login, organizationTeam = 'TACME') => new BetterAuthDirectory({
    backend: hosted.backend,
    access: new Proxy(acme.identity, {
      get(target, property, receiver) {
        if (property !== 'resolveBetterAuthPrincipal') return Reflect.get(target, property, receiver);
        return async (betterAuthUserId: string) => {
          const stored = await target.resolveBetterAuthPrincipal(betterAuthUserId);
          return stored && { ...stored, organization: { ...stored.organization!, slackTeamId: organizationTeam } };
        };
      },
    }),
    organizationId: control.betterAuthOrganizationId!,
    canonicalAdminOrigin: ORIGIN,
    hostedLogin: { login },
  });
  assert.equal((await directory(routed.login).resolveBetterAuthUser(userId))?.membership.role, 'owner');
  assert.equal(await directory(undefined).resolveBetterAuthUser(userId), undefined, 'no login, no principal');
  assert.equal(await directory({ ...routed.login, betterAuthUserId: 'another' }).resolveBetterAuthUser(userId), undefined);
  assert.equal(await directory({ ...routed.login, slackUserId: 'USOMEONE' }).resolveBetterAuthUser(userId), undefined);
  assert.equal(await directory(routed.login, 'TOTHER').resolveBetterAuthUser(userId), undefined);
  // Standalone has no fence.
  assert.equal(hostedLoginFence({}), undefined);
  assert.deepEqual(hostedLoginFence(HOSTED), { login: undefined });
});

test('removed membership blocks a live session, an MCP grant and its refresh on the hosted path', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const beta = await hosted.install('TBETA', 'org_beta', 'UOWNERB');
  const member = await acme.member('UMEMBERA');
  const grant = await hosted.mcpGrant(member.cookie);
  const pendingCode = await hosted.authorizationCode(grant.clientId, member.cookie);
  const betaGrant = await hosted.mcpGrant(beta.ownerCookie);
  assert.equal((await hosted.serve(hosted.adminRequest('/admin/api/mcp-clients', member.cookie))).response?.status, 200);
  assert.equal((await hosted.serve(hosted.mcpRequest(grant.accessToken))).response?.status, 200);

  // The Owner removes the Member in Admin, served by Core for the installation the host resolved.
  const removed = await hosted.serve(hosted.adminRequest(`/admin/api/team/memberships/${member.membershipId}`, acme.ownerCookie, {
    method: 'PATCH',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'removed' }),
  }));
  assert.equal(removed.response?.status, 200, await removed.response?.clone().text() ?? 'no response');

  // The still-unexpired session is gone, and the MCP access token reaches no principal.
  assert.deepEqual(await routeHostedRequest(hosted.adminRequest('/admin/api/mcp-clients', member.cookie), hosted.routing),
    { kind: 'unauthenticated' });
  const mcp = await hosted.serve(hosted.mcpRequest(grant.accessToken));
  assert.equal(mcp.routed.kind, 'installation', 'the token still names its installation');
  assert.equal(mcp.response?.status, 403);
  // Neither the refresh token nor a code issued before the removal yields a token.
  const refreshed = await hosted.refresh(grant);
  assert.equal(refreshed.status, 400);
  assert.equal((await refreshed.json() as { error: string }).error, 'invalid_grant');
  const exchanged = await hosted.token({
    grant_type: 'authorization_code', client_id: grant.clientId, code: pendingCode.code,
    code_verifier: pendingCode.verifier, redirect_uri: REDIRECT, resource: RESOURCE,
  });
  assert.equal(exchanged.status, 400, 'its session ended with the membership');
  assert.equal((await exchanged.json() as { access_token?: unknown }).access_token, undefined);
  // The other installation is untouched.
  assert.equal((await hosted.refresh(betaGrant)).status, 200);
  assert.equal((await hosted.serve(hosted.adminRequest('/admin/api/team', acme.ownerCookie))).response?.status, 200);
});

test('Sign out ends a hosted session through Core\'s logout and lands on the host\'s sign-in', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const beta = await hosted.install('TBETA', 'org_beta', 'UOWNERB');
  assert.equal((await hosted.serve(hosted.adminRequest('/admin/api/team', acme.ownerCookie))).response?.status, 200);

  const signedOut = await hosted.serve(hosted.adminRequest('/admin/logout', acme.ownerCookie, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  }));
  assert.equal(signedOut.routed.kind === 'installation' && installationScopeOf(signedOut.routed.env)?.installationId,
    acme.installationId);
  assert.equal(signedOut.response?.status, 303, await signedOut.response?.clone().text() ?? 'no response');
  assert.equal(signedOut.response?.headers.get('location'), '/auth/slack/sign-in?destination=%2Fadmin');
  assert.deepEqual(await routeHostedRequest(hosted.adminRequest('/admin/api/team', acme.ownerCookie), hosted.routing),
    { kind: 'unauthenticated' }, 'the ended session routes nowhere');
  assert.equal((await hosted.serve(hosted.adminRequest('/admin/api/team', beta.ownerCookie))).response?.status, 200,
    'another installation\'s session is untouched');
});

test('a membership suspended without revoking grants still cannot refresh, and its refresh token stays unrotated', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const member = await acme.member('UMEMBERA');
  const grant = await hosted.mcpGrant(member.cookie);
  const owner = (await acme.identity.listMemberships()).find((membership) => membership.role === 'owner')!;
  // A path that changes the membership alone (no Better Auth revocation).
  const setStatus = (status: 'suspended' | 'active') => acme.identity.updateMembershipAuthority({
    membershipId: member.membershipId, status, actorMembershipId: owner.id,
    authenticationSurface: 'better_auth', correlationId: `request_${status}`, reasonCode: 'owner_suspended_member',
  });
  const pendingCode = await hosted.authorizationCode(grant.clientId, member.cookie);
  await setStatus('suspended');
  const refused = await hosted.refresh(grant);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { error: string }).error, 'invalid_grant');
  // Its session survives here, so only the issuance check stops a code issued before.
  const exchanged = await hosted.token({
    grant_type: 'authorization_code', client_id: grant.clientId, code: pendingCode.code,
    code_verifier: pendingCode.verifier, redirect_uri: REDIRECT, resource: RESOURCE,
  });
  assert.equal(exchanged.status, 400);
  assert.equal((await exchanged.json() as { error: string }).error, 'invalid_grant');
  assert.equal((await hosted.serve(hosted.mcpRequest(grant.accessToken))).response?.status, 403);
  assert.equal((await hosted.serve(hosted.adminRequest('/admin/api/mcp-clients', member.cookie))).response?.status, 401);
  // The refused refresh left its token unrotated (the refused code is spent): once active
  // again the same refresh token works.
  await setStatus('active');
  const renewed = await hosted.refresh(grant);
  assert.equal(renewed.status, 200, await renewed.clone().text());
});

test('a refresh replayed inside the reuse window returns only tokens that are refused when used', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const owner = (await acme.identity.listMemberships()).find((membership) => membership.role === 'owner')!;
  const rotate = async (grant: { clientId: string; refreshToken: string }) => {
    const response = await hosted.refresh(grant);
    assert.equal(response.status, 200, await response.clone().text());
    const tokens = await response.json() as { access_token: string; refresh_token: string };
    return { clientId: grant.clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  };

  // Suspended without revoking: the provider replays the rotation it just made
  // (MCP's 30-second reuse window) without asking the installation again.
  const suspended = await acme.member('UMEMBERA');
  const before = await hosted.mcpGrant(suspended.cookie);
  const rotated = await rotate(before);
  await acme.identity.updateMembershipAuthority({
    membershipId: suspended.membershipId, status: 'suspended', actorMembershipId: owner.id,
    authenticationSurface: 'better_auth', correlationId: 'request_suspend', reasonCode: 'owner_suspended_member',
  });
  const replay = await hosted.refresh(before);
  assert.equal(replay.status, 200, 'the window returns the tokens already issued');
  const replayed = await replay.json() as { access_token: string; refresh_token: string };
  assert.equal(replayed.refresh_token, rotated.refreshToken);
  // Those tokens reach nothing: the MCP resource refuses, and the next refresh asks again.
  assert.equal((await hosted.serve(hosted.mcpRequest(replayed.access_token))).response?.status, 403);
  const next = await hosted.refresh({ clientId: before.clientId, refreshToken: replayed.refresh_token });
  assert.equal(next.status, 400);
  assert.equal((await next.json() as { error: string }).error, 'invalid_grant');

  // Removed through Admin: the rotated family is revoked, so there is nothing to replay.
  const removed = await acme.member('UMEMBERB');
  const grant = await hosted.mcpGrant(removed.cookie);
  await rotate(grant);
  const patched = await hosted.serve(hosted.adminRequest(`/admin/api/team/memberships/${removed.membershipId}`, acme.ownerCookie, {
    method: 'PATCH',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'removed' }),
  }));
  assert.equal(patched.response?.status, 200);
  const refused = await hosted.refresh(grant);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { error: string }).error, 'invalid_grant');
});

test('a suspended, revoked or provisioning installation fails closed for sessions, MCP and refresh, naming nothing', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const beta = await hosted.install('TBETA', 'org_beta', 'UOWNERB');
  const grant = await hosted.mcpGrant(acme.ownerCookie);
  const betaGrant = await hosted.mcpGrant(beta.ownerCookie);
  for (const status of ['suspended', 'revoked', 'provisioning', 'deleted'] as const) {
    acme.record.status = status;
    assert.deepEqual(await routeHostedRequest(hosted.adminRequest('/admin/api/team', acme.ownerCookie), hosted.routing),
      { kind: 'refused' }, status);
    const mcp = await hosted.serve(hosted.mcpRequest(grant.accessToken));
    assert.equal(mcp.routed.kind, 'refused');
    assert.equal(mcp.response?.status, 403);
    const refused = await hosted.refresh(grant);
    assert.equal(refused.status, 400);
    const body = await refused.text();
    assert.match(body, /invalid_grant/);
    for (const text of [body, await mcp.response!.text()]) {
      assert.doesNotMatch(text, /inst_|org_acme|TACME|suspend|revok|provision/i, 'a refusal names nothing');
    }
    assert.equal((await hosted.refresh(betaGrant)).status, 200, 'the other installation is unaffected');
    // Refresh tokens rotate; keep B's current one.
    Object.assign(betaGrant, { refreshToken: await currentRefresh(betaGrant) });
  }
  acme.record.status = 'active';
  assert.equal((await hosted.serve(hosted.adminRequest('/admin/api/team', acme.ownerCookie))).response?.status, 200);
  assert.equal((await hosted.refresh(grant)).status, 200, 'the grant survives a suspension');

  async function currentRefresh(current: { clientId: string; refreshToken: string }) {
    const response = await hosted!.refresh(current);
    assert.equal(response.status, 200);
    return (await response.json() as { refresh_token: string }).refresh_token;
  }
});

test('discovery, JWKS and the MCP sign-in continuation are served before any installation', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const routing: HostedRouting<PlatformEnv> = {
    ...hosted.routing,
    installationEnv: async () => { throw new Error('no installation is resolved for shared routes'); },
  };
  const shared = async (path: string, init?: RequestInit) => {
    const response = await serveHostedSharedAuth(new Request(`${ORIGIN}${path}`, init), routing);
    assert.ok(response);
    return response;
  };
  const authorizationServer = await (await shared('/.well-known/oauth-authorization-server/api/auth')).json() as Record<string, unknown>;
  assert.equal(authorizationServer.issuer, `${ORIGIN}/api/auth`);
  assert.equal(authorizationServer.token_endpoint, `${ORIGIN}/api/auth/oauth2/token`);
  const resource = await (await shared('/.well-known/oauth-protected-resource/mcp')).json() as Record<string, unknown>;
  assert.equal(resource.resource, RESOURCE);
  const jwks = await (await shared('/api/auth/jwks')).json() as { keys: unknown[] };
  assert.ok(jwks.keys.length > 0);
  assert.equal((await shared('/api/auth/organization/list')).status, 404, 'only the public Better Auth routes answer');

  // An MCP client without a session is sent to sign in and back to its authorization.
  const registered = await shared('/api/auth/oauth2/register', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      application_type: 'native', client_name: 'Hosted client', grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [REDIRECT], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  });
  const { client_id: clientId } = await registered.json() as { client_id: string };
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: RENEWABLE_SCOPE, state: 's',
    resource: RESOURCE, code_challenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const authorize = await shared(`/api/auth/oauth2/authorize?${query}`);
  const login = new URL(authorize.headers.get('location')!, ORIGIN);
  assert.equal(login.pathname, '/auth/mcp/login');
  const signIn = new URL((await shared(`${login.pathname}${login.search}`)).headers.get('location')!, ORIGIN);
  assert.equal(signIn.pathname, '/auth/slack/sign-in');
  const resume = signIn.searchParams.get('destination')!;
  assert.match(resume, /^\/auth\/mcp\/resume\//);
  const back = new URL((await shared(resume)).headers.get('location')!, ORIGIN);
  assert.equal(back.pathname, '/api/auth/oauth2/authorize');
  assert.equal((await shared(resume)).status, 410, 'a continuation is used once');

  for (const path of ['/admin', '/admin/api/team', '/mcp', '/setup/abc', '/oauth/callback', '/.well-known/oauth-client-metadata.json']) {
    assert.equal(isHostedSharedAuthPath(path), false, path);
    assert.equal(await serveHostedSharedAuth(new Request(`${ORIGIN}${path}`), routing), undefined);
  }
});

test('the host\'s registration limits reach Core\'s registration gate', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const register = (policy: HostedRouting<PlatformEnv>['mcpRegistrationPolicy']) => serveHostedSharedAuth(
    new Request(`${ORIGIN}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        application_type: 'native', client_name: 'Hosted client', grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [REDIRECT], response_types: ['code'], token_endpoint_auth_method: 'none',
      }),
    }),
    { ...hosted.routing, mcpRegistrationPolicy: policy },
  ) as Promise<Response>;
  assert.equal((await register({ maxClients: 1 })).status, 201);
  const full = await register({ maxClients: 1 });
  assert.equal(full.status, 429);
  assert.deepEqual(await full.json(), { error: 'registration_quota_exceeded' });
  assert.equal((await register({ maxClients: 2 })).status, 201, 'the cap is the host\'s to set');
  const throttled = await register({ maxRegistrationsPerWindow: 0 });
  assert.equal(throttled.status, 429);
  assert.deepEqual(await throttled.json(), { error: 'registration_rate_limited' });
});

test('under installation tenancy Core\'s own app leaves the shared auth routes to the host', async () => {
  const env = scopeInstallationEnv(HOSTED as PlatformEnv, { installationId: 'inst_any' });
  const unused = new Proxy({}, { get() { throw new Error('no installation store is read'); } });
  for (const path of ['/api/auth/jwks', '/.well-known/oauth-protected-resource/mcp', '/api/auth/oauth2/token']) {
    const response = await createBetterAuthRuntimeRoutes({ identity: unused as never }).fetch(new Request(`${ORIGIN}${path}`), env);
    assert.equal(response.status, 404, path);
  }
  for (const path of ['/auth/mcp/login', '/auth/mcp/resume/abc', '/auth/mcp/consent']) {
    const response = await createMcpOAuthRuntimeRoutes({ identity: unused as never }).fetch(new Request(`${ORIGIN}${path}`), env);
    assert.equal(response.status, 404, path);
  }
});

test('the hosted login rides only in a frozen env copy and cannot be swapped', async () => {
  const login = { betterAuthUserId: 'user-1', slackTeamId: 'TACME', slackUserId: 'UOWNERA' };
  const env = scopeInstallationEnv(HOSTED as PlatformEnv, { installationId: 'inst_any' });
  const carried = withHostedLogin(env, login);
  assert.notEqual(carried, env);
  assert.ok(Object.isFrozen(carried));
  assert.equal(hostedLoginOf(env), undefined);
  assert.deepEqual(hostedLoginOf(carried), login);
  assert.deepEqual(installationScopeOf(carried), { installationId: 'inst_any' });
  assert.equal(withHostedLogin(carried, { ...login }), carried);
  assert.throws(() => withHostedLogin(carried, { ...login, slackUserId: 'UOTHER' }), /another login/);
  // A request payload is not an env: a string key never reads as a login.
  assert.equal(hostedLoginOf({ ...HOSTED, 'chickpea.hosted-login': login }), undefined);

  // What routing read rides with the login, once, and only on an installation's env.
  const reads = { principal: { binding: {} } } as unknown as HostedRouteReads;
  const routed = withHostedLogin(env, login, reads);
  assert.ok(Object.isFrozen(routed));
  assert.equal(hostedLoginFence(routed)?.routed?.principal, reads.principal);
  assert.equal(hostedLoginFence(carried)?.routed, undefined);
  assert.throws(() => withHostedLogin(routed, login, reads), /together with the login/);
  assert.throws(() => withHostedLogin(HOSTED as PlatformEnv, login, reads), /installation's env/);
  // Copied onto another installation's env, they serve nothing there.
  const elsewhere = scopeInstallationEnv(HOSTED as PlatformEnv, { installationId: 'inst_other' });
  const copied = Object.freeze({
    ...elsewhere,
    ...Object.fromEntries(Object.getOwnPropertySymbols(routed)
      .filter((symbol) => symbol.description?.startsWith('chickpea.hosted-'))
      .map((symbol) => [symbol, (routed as Record<symbol, unknown>)[symbol]])),
  }) as PlatformEnv;
  assert.deepEqual(hostedLoginOf(copied), login);
  assert.deepEqual(hostedLoginFence(copied), { login });
});

test('a routed request carries its session and stored principal, for its own installation only', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const beta = await hosted.install('TBETA', 'org_beta', 'UOWNERB');
  const routed = await routeHostedRequest(hosted.adminRequest('/admin/api/team', acme.ownerCookie), hosted.routing);
  assert.equal(routed.kind, 'installation');
  if (routed.kind !== 'installation') return;
  const reads = hostedLoginFence(routed.env)?.routed;
  assert.equal(reads?.session?.betterAuthUserId, routed.login.betterAuthUserId);
  assert.equal(reads?.session?.cookie, acme.ownerCookie);
  assert.deepEqual(reads?.session?.setCookies, [], 'a fresh session has nothing to refresh');
  assert.deepEqual(reads?.principal, await acme.identity.resolveBetterAuthPrincipal(routed.login.betterAuthUserId));

  // An MCP token carries the principal and no session.
  const grant = await hosted.mcpGrant(acme.ownerCookie);
  const mcp = await routeHostedRequest(hosted.mcpRequest(grant.accessToken), hosted.routing);
  assert.equal(mcp.kind === 'installation' && hostedLoginFence(mcp.env)?.routed?.session, undefined);
  assert.ok(mcp.kind === 'installation' && hostedLoginFence(mcp.env)?.routed?.principal);

  // A confused host serving A's routed reads with B's env gets nothing from B.
  const betaEnv = await hosted.routing.installationEnv({ betterAuthUserId: 'x', slackTeamId: 'TBETA', slackUserId: 'UOWNERB' });
  const confused = Object.freeze({
    ...betaEnv,
    ...Object.fromEntries(Object.getOwnPropertySymbols(routed.env)
      .filter((symbol) => symbol.description?.startsWith('chickpea.hosted-'))
      .map((symbol) => [symbol, (routed.env as Record<symbol, unknown>)[symbol]])),
  }) as PlatformEnv;
  const crossAdmin = await createAdminRoutes({
    identity: hosted.storeOf(betaEnv),
    store: new SqliteConfigStore(':memory:', { agents: [] }),
    settings: new SqliteSettingsStore(':memory:'),
  }).fetch(hosted.adminRequest('/admin/api/team', acme.ownerCookie), confused);
  assert.equal(crossAdmin.status, 401);
  assert.equal((await hosted.serve(hosted.adminRequest('/admin/api/team', beta.ownerCookie))).response?.status, 200);
});

test('a session Better Auth refuses while refreshing it routes nowhere', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  // Due for refresh, and gone by the time the refresh writes (no row updates).
  await hosted.backend.pool.query(`UPDATE session SET "expiresAt" = now() + interval '5 days', "updatedAt" = now() - interval '2 days'`);
  await hosted.backend.pool.query(`CREATE FUNCTION keep_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
  await hosted.backend.pool.query('CREATE TRIGGER keep_session BEFORE UPDATE ON session FOR EACH ROW EXECUTE FUNCTION keep_session()');
  assert.deepEqual(await routeHostedRequest(hosted.adminRequest('/admin/api/team', acme.ownerCookie), hosted.routing),
    { kind: 'unauthenticated' });
  // Reading without refreshing still finds it.
  assert.equal((await resolveHostedLogin(hosted.adminRequest('/admin', acme.ownerCookie), hosted.environment))?.slackUserId, 'UOWNERA');
});

test('a database failure while routing reads the session fails the request rather than signing it out', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  await hosted.backend.pool.query('ALTER TABLE session RENAME TO session_unreachable');
  try {
    await assert.rejects(routeHostedRequest(hosted.adminRequest('/admin/api/team', acme.ownerCookie), hosted.routing));
  } finally {
    await hosted.backend.pool.query('ALTER TABLE session_unreachable RENAME TO session');
  }
  assert.equal((await routeHostedRequest(hosted.adminRequest('/admin/api/team', acme.ownerCookie), hosted.routing)).kind, 'installation');
});

test('resolving a login reads the credential the route uses and nothing else', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const grant = await hosted.mcpGrant(acme.ownerCookie);
  const session = await resolveHostedLogin(hosted.adminRequest('/admin', acme.ownerCookie), hosted.environment);
  assert.deepEqual([session?.slackTeamId, session?.slackUserId], ['TACME', 'UOWNERA']);
  // /mcp reads only its bearer token; elsewhere only the session.
  assert.equal(await resolveHostedLogin(new Request(`${ORIGIN}/mcp`, { headers: { cookie: acme.ownerCookie } }), hosted.environment), undefined);
  assert.deepEqual(
    await resolveHostedLogin(new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${grant.accessToken}` } }), hosted.environment),
    session,
  );
  assert.equal(await resolveHostedLogin(new Request(`${ORIGIN}/admin`, { headers: { authorization: `Bearer ${grant.accessToken}` } }), hosted.environment), undefined);
  // A session past its absolute expiry is ended, not resolved.
  await hosted.backend.pool.query(`UPDATE session SET "absoluteExpiresAt" = now() - interval '1 minute'`);
  assert.equal(await resolveHostedLogin(hosted.adminRequest('/admin', acme.ownerCookie), hosted.environment), undefined);
  assert.equal((await hosted.backend.pool.query('SELECT count(*)::int AS count FROM session')).rows[0].count, 0);
});

test('a Slack deactivation with no request backend revokes through a backend the host\'s factory opens, then closes it', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  t.after(() => configureBetterAuthBackendFactory(undefined));
  const acme = await hosted.install('TACME', 'org_acme', 'UOWNERA');
  const member = await acme.member('UMEMBERA');
  const grant = await hosted.mcpGrant(member.cookie);
  // An env with no request backend, like a Durable Object's (scoped by its own name). Hosted
  // has the gateway session off, so today none reaches the gateway inbox; H07's direct ingress
  // and anything finished after its acknowledgement are the consumers.
  const backgroundEnv = scopeInstallationEnv(HOSTED as PlatformEnv, { installationId: acme.installationId });
  // The user_change branch both Slack paths now run.
  const deactivate = async (eventId: string) => withBetterAuthAccessRevoker({
    control: await acme.identity.getAuthControl(), platformEnv: backgroundEnv,
  }, (betterAuth) => applyGatewaySlackUserChange({
    identity: acme.identity,
    ...(betterAuth ? { betterAuth } : {}),
    payloadTeamId: 'TACME',
    apiAppId: 'A12345678',
    eventId,
    event: {
      type: 'user_change', event_ts: '1786100000.000100',
      user: { id: 'UMEMBERA', team_id: 'TACME', deleted: true, is_bot: false, is_app_user: false },
    },
  }));

  // Without a factory the deactivation is refused and changes nothing.
  await assert.rejects(deactivate('Ev_NO_FACTORY'), /access cannot be revoked; nothing was changed/);
  assert.equal((await acme.identity.getMembership(member.membershipId))?.status, 'active');

  const opened: Array<{ env: PlatformEnv; closed: boolean }> = [];
  configureBetterAuthBackendFactory((env) => {
    const backend = openPostgresBetterAuthBackend(hosted.config);
    const record = { env, closed: false };
    opened.push(record);
    return Object.assign(backend, {
      close: async () => {
        record.closed = true;
        await backend.pool.end();
      },
    });
  });
  const result = await deactivate('Ev_ALARM');
  assert.equal(result.outcome, 'suspended');
  assert.equal(opened.length, 1, 'one backend for the piece of work');
  assert.equal(opened[0]!.env, backgroundEnv);
  assert.equal(opened[0]!.closed, true, 'and closed when it settled');
  // Its sessions and MCP grants ended in PostgreSQL along with the membership.
  assert.equal((await acme.identity.getMembership(member.membershipId))?.status, 'suspended');
  assert.deepEqual(await routeHostedRequest(hosted.adminRequest('/admin/api/mcp-clients', member.cookie), hosted.routing),
    { kind: 'unauthenticated' });
  const refused = await hosted.refresh(grant);
  assert.equal(refused.status, 400);
  assert.equal((await hosted.backend.pool.query('SELECT count(*)::int AS count FROM "oauthRefreshToken"')).rows[0].count, 0);
});

test('a streamed response keeps the request database open until its body ends', { timeout: 120_000 }, async (t) => {
  const hosted = await hostedDeployment(t);
  if (!hosted) return;
  // What a host does around Core: one database per request, closed once
  // every piece of work handed to waitUntil has settled.
  async function serveWithRequestDatabase(hold: boolean) {
    const backend = openPostgresBetterAuthBackend(hosted!.config);
    const pending = new Set<Promise<unknown>>();
    const waitUntil = (promise: Promise<unknown>) => {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    };
    let produce!: () => void;
    const producing = new Promise<void>((resolve) => { produce = resolve; });
    // Core's handler returns at once; its body runs a query as it is written,
    // like an MCP tool call inside an event stream.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await producing;
        const { rows } = await backend.pool.query<{ answer: number }>('SELECT 42 AS answer');
        controller.enqueue(new TextEncoder().encode(`data: ${rows[0]!.answer}\n\n`));
        controller.close();
      },
    });
    const returned = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-kept': 'yes' } });
    const response = hold ? holdUntilResponseEnds(returned, waitUntil) : returned;
    const closed = (async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      await backend.close();
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    produce();
    const text = await response.text().catch((error: Error) => `failed: ${error.message}`);
    await closed;
    return { response, text };
  }
  const held = await serveWithRequestDatabase(true);
  assert.equal(held.text, 'data: 42\n\n');
  assert.equal(held.response.status, 200);
  assert.equal(held.response.headers.get('content-type'), 'text/event-stream');
  assert.equal(held.response.headers.get('x-kept'), 'yes');
  // The control: without it the database closes as the handler returns.
  assert.match((await serveWithRequestDatabase(false)).text, /failed: Cannot use a pool after calling end/);

  // A client that goes away settles it too; a response without a body is untouched.
  const waits: Promise<unknown>[] = [];
  const endless = holdUntilResponseEnds(new Response(new ReadableStream({ pull() {} })), (promise) => waits.push(promise));
  await endless.body!.cancel();
  await Promise.all(waits);
  const empty = new Response(null, { status: 204 });
  assert.equal(holdUntilResponseEnds(empty, () => assert.fail('nothing to wait for')), empty);
});
