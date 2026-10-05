import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { resolveRepositoryAccess, runtimePlanWorkspaceFacts } from '../src/agents/slack-thread.ts';
import {
  createInstallationToken,
  exchangeGithubAppManifest,
  getCachedInstallationToken,
  getGithubConnection,
  getRepositoryInstallation,
  GITHUB_SETTING_KEYS,
  GithubInstallationNotMintableError,
  listInstallationRepos,
  listInstallations,
  mintableInstallation,
  resolveGithubAppBotUser,
  type GithubConnection,
} from '../src/config/github-app.ts';
import {
  configureHostedGithub,
  configureHostedGithubConnect,
  disconnectHostedGithubBinding,
  hostedGithubConnectPath,
  HOSTED_GITHUB_BINDINGS_TTL_MS,
  resetHostedGithubForTests,
  type HostedGithubPort,
} from '../src/config/hosted-github.ts';
import {
  configureInstallationAdmission,
  InstallationNotAdmittedError,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv, splitInstallationObjectName } from '../src/config/installation-scope.ts';
import {
  beginOnboardingJourney,
  parseOnboardingJourney,
  readOnboardingJourney,
  selectOnboardingProvider,
  settleOnboardingGithubStep,
  startOnboardingTry,
} from '../src/config/onboarding-state.ts';
import { rotateInstallationModelCredential } from '../src/config/model-credential-refs.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig, RepositoryGrant } from '../src/config/types.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { exportWorkspaceRecipe, previewWorkspaceRecipe } from '../src/management/recipes.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { resolveRepositoryInstallationScope } from '../src/sandbox/egress-handler.ts';
import { githubSandboxOutbound, SANDBOX_BLOCKED_STATUS, type SandboxEgressStub } from '../src/sandbox/egress-outbound.ts';
import type { SandboxEgressContext } from '../src/sandbox/cloudflare-policy.ts';
import { NEUTRAL_GIT_IDENTITY, resolveWorkspaceGitIdentity } from '../src/sandbox/git-identity.ts';
import { GITHUB_WRITES_KEY } from '../src/sandbox/github-write-rate.ts';
import { resolveCodingWorkspaceDecision } from '../src/slack/run-turn.ts';
import { buildTurnEnvelope } from '../src/slack/turn-envelope-builder.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { configureHostedSandboxPolicy, resetHostedSandboxPolicyForTests } from '../src/config/hosted-sandbox-policy.ts';
// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { REQUIRED_PACKAGED_FILES } from '../scripts/lib/source-export-policy.mjs';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * H14a: a deployment serving many installations shares one platform GitHub
 * App, so Core mints, lists and resolves only the requesting installation's
 * own bound GitHub accounts, from the host's port, and never reads a tenant's
 * stored App or the deployment's GITHUB_APP_* variables. Standalone is
 * unchanged.
 */

const INSTALLATION_A = `inst_${'0123456789abcdef'.repeat(2)}`;
const INSTALLATION_B = `inst_${'fedcba9876543210'.repeat(2)}`;
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const hostedEnv = (installationId: string, bindings: Record<string, unknown> = {}) =>
  scopeInstallationEnv({ ...HOSTED, ...bindings } as Record<string, unknown>, { installationId });
const ENV_A = hostedEnv(INSTALLATION_A);
const ENV_B = hostedEnv(INSTALLATION_B);

const PRIVATE_KEY = String(generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
const PLATFORM_APP = { appId: '900100', appSlug: 'chickpea-staging', privateKeyPem: PRIVATE_KEY, botUserId: 900_200 };
/** A's organization is installation 101; B's is 202. */
const GITHUB_A = 101;
const GITHUB_B = 202;
const binding = (githubInstallationId: number, accountLogin: string, status: 'active' | 'suspended' = 'active') => ({
  githubInstallationId, accountLogin, accountType: 'Organization', repositorySelection: 'all', status,
});

interface Port {
  appReads: number;
  bindings: Map<string, unknown[]>;
  disconnected: Array<[string, number]>;
  gone: Array<[string, number]>;
  lists: string[];
}

/** The host's port with A bound to acme-a (101) and B to acme-b (202), and every installation admitted. */
function platform(t: TestContext, options: { app?: unknown; admitted?: (id: string) => boolean } = {}): Port {
  resetHostedGithubForTests();
  resetInstallationAdmissionForTests();
  const state: Port = {
    appReads: 0,
    bindings: new Map<string, unknown[]>([
      [INSTALLATION_A, [binding(GITHUB_A, 'acme-a')]],
      [INSTALLATION_B, [binding(GITHUB_B, 'acme-b')]],
    ]),
    disconnected: [],
    gone: [],
    lists: [],
  };
  const unbind = (installationId: string, githubInstallationId: number) => {
    const live = state.bindings.get(installationId) ?? [];
    const kept = live.filter((entry) => (entry as { githubInstallationId: number }).githubInstallationId !== githubInstallationId);
    state.bindings.set(installationId, kept);
    return kept.length !== live.length;
  };
  const port: HostedGithubPort = {
    app: () => { state.appReads += 1; return 'app' in options ? options.app : PLATFORM_APP; },
    bindings: {
      async list(installationId) { state.lists.push(installationId); return state.bindings.get(installationId) ?? []; },
      async disconnect(installationId, githubInstallationId) {
        state.disconnected.push([installationId, githubInstallationId]);
        return unbind(installationId, githubInstallationId);
      },
      // The host's re-check, a round trip later: GitHub no longer knows the installation, so its binding ends.
      async reportGone(installationId, githubInstallationId) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state.gone.push([installationId, githubInstallationId]);
        unbind(installationId, githubInstallationId);
      },
    },
  };
  configureHostedGithub(port);
  configureInstallationAdmission(async (id) => (options.admitted?.(id) ?? true) ? 'admitted' : 'refused');
  t.after(() => { resetHostedGithubForTests(); resetInstallationAdmissionForTests(); });
  return state;
}

interface Fetched { method: string; url: string; body?: string }

const SKILL_COMMIT = '5'.repeat(40);

/**
 * GitHub as each test sees it: every request recorded; tokens, repository
 * lists and repository installations answered, and an installation token
 * reads a private repository holding one skill. `anonymous` is how GitHub
 * answers the Worker's anonymous repository probe.
 */
function github(
  t: TestContext,
  options: { repositoryInstallation?: Record<string, number>; mintStatus?: number; anonymous?: ResponseInit } = {},
): Fetched[] {
  const fetched: Fetched[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = request.method === 'GET' ? undefined : await request.clone().text();
    fetched.push({ method: request.method, url: request.url, ...(body ? { body } : {}) });
    const url = new URL(request.url);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint) {
      if (options.mintStatus) return new Response('{}', { status: options.mintStatus });
      return Response.json({ token: `token-${mint[1]}-${fetched.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (url.pathname === '/installation/repositories') {
      return Response.json({ total_count: 1, repositories: [{ full_name: 'acme-a/app', private: true, default_branch: 'main' }] });
    }
    const lookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (lookup) {
      const owner = lookup[1]!.toLowerCase();
      const id = options.repositoryInstallation?.[owner] ?? ({ 'acme-a': GITHUB_A, 'acme-b': GITHUB_B } as Record<string, number>)[owner];
      return id ? Response.json({ id, account: { login: lookup[1], type: 'Organization' } }) : new Response('{}', { status: 404 });
    }
    if (url.hostname === 'api.github.com' && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      // Anonymous metadata: a private repository is not found.
      if (!request.headers.has('authorization')) return new Response('{}', options.anonymous ?? { status: 404 });
      return Response.json({ default_branch: 'main', private: true });
    }
    if (url.pathname.endsWith('/commits/main')) return new Response(SKILL_COMMIT);
    if (url.pathname.endsWith(`/git/trees/${SKILL_COMMIT}`)) return Response.json({ tree: [{ path: 'SKILL.md', type: 'blob' }] });
    if (url.pathname.endsWith('/contents/SKILL.md')) {
      return new Response('---\nname: bound-skill\ndescription: Bound instructions.\n---\n# Body');
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return fetched;
}

const mints = (fetched: Fetched[]) => fetched.filter(({ url }) => url.endsWith('/access_tokens')).map(({ url }) => Number(url.split('/').at(-2)));
const appListings = (fetched: Fetched[]) => fetched.filter(({ url }) => new URL(url).pathname === '/app/installations');

/** A settings store that records every key read or written, and holds a tenant-written App and bot user. */
async function tenantSettings(t: TestContext) {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await settings.setSetting(GITHUB_SETTING_KEYS.appId, PLATFORM_APP.appId);
  await settings.setSetting(GITHUB_SETTING_KEYS.privateKey, PRIVATE_KEY);
  await settings.setSetting(GITHUB_SETTING_KEYS.botUser, JSON.stringify({
    appId: PLATFORM_APP.appId, slug: 'impostor', id: 666, resolvedAt: Date.now(),
  }));
  const touched: string[] = [];
  for (const method of ['getSetting', 'getSettings', 'setSetting', 'applySettingsPatch'] as const) {
    const original = settings[method].bind(settings) as (...args: unknown[]) => unknown;
    t.mock.method(settings, method, (...args: unknown[]) => {
      touched.push(`${method}:${JSON.stringify(args[0])}`);
      return original(...args);
    });
  }
  return { settings, touched };
}

const githubKeysTouched = (touched: string[]) => touched.filter((entry) => entry.includes('github.'));

/** The installation's connection; any settings read fails it. */
async function hostedConnection(env: Record<string, unknown>) {
  return getGithubConnection(untouchable<SqliteSettingsStore>(), env);
}

// --- §5 acceptance: tenancy from the deployment, the port, and the lowest-layer gate ---

test('under tenancy the connection is the platform App scoped to the installation\'s own bindings, and never a tenant\'s stored App', async (t) => {
  platform(t);
  const { settings, touched } = await tenantSettings(t);
  await withEnv({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY }, async () => {
    const a = await getGithubConnection(settings, ENV_A);
    assert.equal(a.mode, 'app');
    assert.ok(a.mode === 'app' && a.platform);
    assert.equal(a.appId, PLATFORM_APP.appId, 'the platform App, never the deployment variable or the stored App');
    assert.deepEqual(a.platform.bindings.map(({ githubInstallationId }) => githubInstallationId), [GITHUB_A]);
    assert.equal(a.platform.installationId, INSTALLATION_A);
    const b = await getGithubConnection(settings, ENV_B);
    assert.ok(b.mode === 'app' && b.platform);
    assert.deepEqual(b.platform.bindings.map(({ githubInstallationId }) => githubInstallationId), [GITHUB_B]);
  });
  assert.deepEqual(githubKeysTouched(touched), [], 'no github.app.* setting is read under tenancy');
});

test('a caller that passes no env still gets hosted rules: no tenant App, no deployment variable, not connected', async (t) => {
  platform(t);
  const { settings, touched } = await tenantSettings(t);
  await withEnv({ CHICKPEA_TENANCY: 'installation', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY }, async () => {
    assert.deepEqual(await getGithubConnection(settings), { mode: 'none' });
    assert.equal(await resolveGithubAppBotUser(settings), undefined);
    // Without the port, a scoped env is not connected either.
    configureHostedGithub(undefined);
    assert.deepEqual(await getGithubConnection(settings, ENV_A), { mode: 'none' });
  });
  assert.deepEqual(githubKeysTouched(touched), []);
});

test('without the port, with an incomplete App, or with no active binding, an installation is not connected', async (t) => {
  for (const app of [undefined, { ...PLATFORM_APP, botUserId: 0 }, { ...PLATFORM_APP, appSlug: 'Bad Slug' }, { ...PLATFORM_APP, privateKeyPem: '' }]) {
    platform(t, { app });
    assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' }, JSON.stringify(app ?? null));
  }
  const port = platform(t);
  port.bindings.set(INSTALLATION_A, [binding(GITHUB_A, 'acme-a', 'suspended')]);
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' }, 'a suspended binding mints nothing');
  port.bindings.set(INSTALLATION_A, [{ ...binding(GITHUB_A, 'acme-a'), accountLogin: '../evil' }]);
  resetHostedGithubForTests();
  configureHostedGithub({ app: () => PLATFORM_APP, bindings: { list: async () => port.bindings.get(INSTALLATION_A)!, disconnect: async () => false, reportGone() {} } });
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' }, 'a malformed binding is dropped');
  // Two bindings naming one account (or one GitHub installation) are a host fault: neither is used.
  configureHostedGithub({ app: () => PLATFORM_APP, bindings: {
    list: async () => [binding(GITHUB_A, 'acme-a'), binding(GITHUB_B, 'ACME-A')], disconnect: async () => false, reportGone() {},
  } });
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' });
  configureHostedGithub({ app: () => PLATFORM_APP, bindings: { list: async () => { throw new Error('registry down'); }, disconnect: async () => false, reportGone() {} } });
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' }, 'an unreadable list is none');
});

test('the lowest layer refuses a standalone-shaped or forged connection on a hosted deployment, and an unbound installation, before GitHub', async (t) => {
  platform(t);
  const fetched = github(t);
  const standaloneShaped: GithubConnection = { mode: 'app', appId: PLATFORM_APP.appId, privateKeyPem: PRIVATE_KEY };
  await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
    for (const call of [
      () => createInstallationToken(standaloneShaped, GITHUB_B, {}),
      () => getCachedInstallationToken(standaloneShaped, GITHUB_B, {}),
      () => listInstallations(standaloneShaped),
      () => getRepositoryInstallation(standaloneShaped, 'acme-b/secret'),
      () => listInstallationRepos(standaloneShaped, GITHUB_B),
    ]) {
      await assert.rejects(call(), GithubInstallationNotMintableError);
    }
  });
  const a = await hostedConnection(ENV_A);
  assert.ok(a.mode === 'app' && a.platform);
  // A copied scope that names B's installation was not issued by getGithubConnection.
  const forged: GithubConnection = { ...a, platform: { ...a.platform, bindings: [...a.platform.bindings, binding(GITHUB_B, 'acme-b')] as never } };
  await assert.rejects(createInstallationToken(forged, GITHUB_B, {}), GithubInstallationNotMintableError);
  await assert.rejects(createInstallationToken(a, GITHUB_B, {}), GithubInstallationNotMintableError);
  await assert.rejects(getCachedInstallationToken(a, GITHUB_B, {}), GithubInstallationNotMintableError);
  await assert.rejects(listInstallationRepos(a, GITHUB_B), GithubInstallationNotMintableError);
  assert.deepEqual(fetched, [], 'nothing reached GitHub');
  // A spread copy of an issued connection keeps its scope.
  await createInstallationToken({ ...a }, GITHUB_A, {});
  assert.deepEqual(mints(fetched), [GITHUB_A]);
});

test('no GET /app/installations and no unbound mint under tenancy; an unadmitted installation mints nothing', async (t) => {
  platform(t, { admitted: (id) => id !== INSTALLATION_B });
  const fetched = github(t);
  const a = await hostedConnection(ENV_A);
  assert.deepEqual(await listInstallations(a), [{ id: GITHUB_A, accountLogin: 'acme-a', accountType: 'Organization' }]);
  const b = await hostedConnection(ENV_B);
  await assert.rejects(createInstallationToken(b, GITHUB_B, {}), InstallationNotAdmittedError);
  await assert.rejects(getCachedInstallationToken(b, GITHUB_B, {}), InstallationNotAdmittedError);
  await assert.rejects(getRepositoryInstallation(b, 'acme-b/app'), InstallationNotAdmittedError);
  assert.deepEqual(appListings(fetched), []);
  assert.deepEqual(fetched, []);
});

test('the mint gate runs before the token cache, and the cache key carries the installation served', async (t) => {
  const port = platform(t);
  const fetched = github(t);
  const a = await hostedConnection(ENV_A);
  const first = await getCachedInstallationToken(a, GITHUB_A, { repositories: ['app'] });
  assert.equal((await getCachedInstallationToken(a, GITHUB_A, { repositories: ['app'] })).token, first.token, 'cached');
  assert.deepEqual(mints(fetched), [GITHUB_A]);
  // A swaps acme-a for another account: its new connection holds no binding for 101, and the cached token is refused.
  port.bindings.set(INSTALLATION_A, [binding(303, 'acme-c')]);
  resetHostedGithubForTests();
  configureHostedGithub({ app: () => PLATFORM_APP, bindings: {
    list: async (id) => port.bindings.get(id) ?? [], disconnect: async () => false, reportGone() {},
  } });
  const swapped = await hostedConnection(ENV_A);
  assert.equal(swapped.mode, 'app');
  await assert.rejects(getCachedInstallationToken(swapped, GITHUB_A, { repositories: ['app'] }), GithubInstallationNotMintableError);
  // A disconnects, and B binds the same GitHub installation (GitHub keeps one per account).
  port.bindings.set(INSTALLATION_A, []);
  port.bindings.set(INSTALLATION_B, [binding(GITHUB_A, 'acme-a')]);
  resetHostedGithubForTests();
  configureHostedGithub({ app: () => PLATFORM_APP, bindings: {
    list: async (id) => port.bindings.get(id) ?? [], disconnect: async () => false, reportGone() {},
  } });
  configureInstallationAdmission(async () => 'admitted');
  // A's earlier connection is refused for the cached token once it no longer holds the binding.
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' });
  const b = await hostedConnection(ENV_B);
  const minted = await getCachedInstallationToken(b, GITHUB_A, { repositories: ['app'] });
  assert.notEqual(minted.token, first.token, 'B never receives the token A cached');
  assert.deepEqual(mints(fetched), [GITHUB_A, GITHUB_A]);
});

test('a binding list serves 30 seconds, then the host is asked again', async (t) => {
  let now = 1_000_000;
  const port = platform(t);
  resetHostedGithubForTests({ now: () => now });
  configureHostedGithub({ app: () => PLATFORM_APP, bindings: {
    list: async (id) => { port.lists.push(id); return port.bindings.get(id) ?? []; }, disconnect: async () => false, reportGone() {},
  } });
  await hostedConnection(ENV_A);
  await hostedConnection(ENV_A);
  assert.deepEqual(port.lists, [INSTALLATION_A]);
  port.bindings.set(INSTALLATION_A, []);
  now += HOSTED_GITHUB_BINDINGS_TTL_MS;
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' }, 'an ended binding stops within the TTL');
  assert.deepEqual(port.lists, [INSTALLATION_A, INSTALLATION_A]);
});

test('a mint GitHub answers 404 fails once the host has taken its report, and the binding the host ended is read again', async (t) => {
  const port = platform(t);
  github(t, { mintStatus: 404 });
  const notFound = (error: unknown) => (error as { status?: number }).status === 404;
  await assert.rejects(createInstallationToken(await hostedConnection(ENV_A), GITHUB_A, {}), notFound);
  // Nothing is left running: on Workers, work a request leaves unawaited is cancelled with its response.
  assert.deepEqual(port.gone, [[INSTALLATION_A, GITHUB_A]]);
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' });
  assert.deepEqual(port.lists, [INSTALLATION_A, INSTALLATION_A]);

  // A host that cannot take the report: the mint still fails with GitHub's answer.
  const warn = t.mock.method(console, 'warn', () => {});
  configureHostedGithub({ app: () => PLATFORM_APP, bindings: {
    list: async () => [binding(GITHUB_A, 'acme-a')], disconnect: async () => false,
    reportGone: async () => { throw new Error('registry down'); },
  } });
  await assert.rejects(createInstallationToken(await hostedConnection(ENV_A), GITHUB_A, {}), notFound);
  assert.deepEqual(warn.mock.calls.map(({ arguments: [line] }) => JSON.parse(String(line))),
    [{ component: 'hosted_github', event: 'github_report_gone_failed' }]);
});

test('mintableInstallation maps a grant to its account\'s binding under tenancy, and to its own ID on standalone', async (t) => {
  platform(t);
  const a = await hostedConnection(ENV_A);
  assert.equal(mintableInstallation(a, { accountLogin: 'ACME-A', installationId: GITHUB_B }), GITHUB_A, 'never the stored ID');
  assert.equal(mintableInstallation(a, { accountLogin: 'acme-a', installationId: null }), GITHUB_A);
  assert.equal(mintableInstallation(a, { accountLogin: 'acme-b', installationId: GITHUB_B }), undefined);
  // A repository outside the grant's own account never maps to the account's binding.
  assert.equal(mintableInstallation(a, { accountLogin: 'acme-a', installationId: null, fullName: 'acme-b/secret' }), undefined);
  assert.equal(mintableInstallation(a, { accountLogin: 'acme-a', installationId: null, fullName: 'ACME-A/app' }), GITHUB_A);
  assert.equal(mintableInstallation(a, { accountLogin: 'acme-a', installationId: null, fullName: '', allRepos: true }), GITHUB_A);
  const standalone: GithubConnection = { mode: 'app', appId: '1', privateKeyPem: PRIVATE_KEY };
  assert.equal(mintableInstallation(standalone, { accountLogin: 'acme-b', installationId: GITHUB_B }), GITHUB_B);
  assert.equal(mintableInstallation(standalone, { accountLogin: 'acme-b', installationId: null }), undefined);
  await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
    assert.equal(mintableInstallation(standalone, { accountLogin: 'acme-b', installationId: GITHUB_B }), undefined);
  });
});

// --- X1: grant save ---

const ADMIN_TOKEN = 'hosted-github-admin-token';

/** A signed-in Member: may use Agents, may not configure the installation. */
const memberPrincipal = (): AuthPrincipal => ({
  userId: 'user_test_member', membershipId: 'membership_test_member', organizationId: 'org_oss', role: 'member',
  authenticatorKind: 'test_slack_session', credentialId: 'session_test_member', correlationId: 'request_test_member', machine: false,
});

function hostedAdmin(
  t: TestContext,
  agents: CustomAgentConfig[] = [],
  as: { identity?: SqliteIdentityStore; principal?: AuthPrincipal } = {},
) {
  const store = new SqliteConfigStore(':memory:', { agents });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { store.close(); settings.close(); });
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store, settings, knownProviders: new Set(['local-stub']), ...testAdminAuthority(ADMIN_TOKEN, undefined, as.identity, as.principal),
  }));
  const request = (env: Record<string, unknown> | undefined, path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { ...testAdminHeaders(ADMIN_TOKEN), 'content-type': 'application/json', ...init.headers },
  }, env);
  return { store, settings, request };
}

function agent(repositories: RepositoryGrant[] = []): CustomAgentConfig {
  return {
    id: 'agent-coder', revision: 1, name: 'Coder', instructions: 'Work on code.', enabled: true, model: 'local-stub/coder',
    skills: [], mcpServers: [], apiConnections: [], repositories, kind: 'user',
  };
}

test('X1: a grant save names the installation\'s binding for its account, and refuses another installation\'s account', async (t) => {
  platform(t);
  const fetched = github(t);
  const kept: RepositoryGrant = { id: 'repo_old', installationId: 303, accountLogin: 'acme-old', fullName: 'acme-old/legacy', enabled: true };
  const { store, request } = hostedAdmin(t, [agent([kept])]);
  const patch = (repositories: RepositoryGrant[], expectedRevision: number) => request(ENV_A, '/admin/api/agents/agent-coder', {
    method: 'PATCH', body: JSON.stringify({ expectedRevision, repositories }),
  });
  // B's installation and account, all repositories: refused.
  const stolen = await patch([kept, { id: 'repo_b', installationId: GITHUB_B, accountLogin: 'acme-b', fullName: '', allRepos: true, enabled: true }], 1);
  assert.equal(stolen.status, 400);
  assert.deepEqual(await stolen.json(), { error: 'github_account_not_connected' });
  // B's installation ID under A's own account: stored as A's binding.
  const relabelled = await patch([kept, { id: 'repo_a', installationId: GITHUB_B, accountLogin: 'acme-a', fullName: 'acme-a/app', enabled: true }], 1);
  assert.equal(relabelled.status, 200, await relabelled.clone().text());
  const saved = (await store.getAgent('agent-coder')).repositories;
  assert.deepEqual(saved.find(({ id }) => id === 'repo_a')?.installationId, GITHUB_A);
  // A grant of an account no longer connected stays as stored, and may be switched off, but not changed.
  assert.deepEqual(saved.find(({ id }) => id === 'repo_old'), kept);
  const off = await patch([{ ...kept, enabled: false }, saved.find(({ id }) => id === 'repo_a')!], 2);
  assert.equal(off.status, 200);
  assert.equal((await store.getAgent('agent-coder')).repositories.find(({ id }) => id === 'repo_old')?.enabled, false);
  const moved = await patch([{ ...kept, fullName: 'acme-old/other' }], 3);
  assert.equal(moved.status, 400);
  // Create refuses an account the installation has not connected.
  const created = await request(ENV_A, '/admin/api/agents', { method: 'POST', body: JSON.stringify({
    id: 'agent-new', name: 'New', instructions: 'New.', enabled: true, model: 'local-stub/coder',
    repositories: [{ id: 'repo_b', installationId: GITHUB_B, accountLogin: 'acme-b', fullName: 'acme-b/secret', enabled: true }],
  }) });
  assert.equal(created.status, 400);
  assert.deepEqual(await created.json(), { error: 'github_account_not_connected' });
  // A's own account naming a repository of B's account: refused, though GitHub would refuse A's token there too.
  const elsewhere = await patch([{ ...kept, enabled: false }, { id: 'repo_x', installationId: null, accountLogin: 'acme-a', fullName: 'acme-b/secret', enabled: true }], 3);
  assert.equal(elsewhere.status, 400);
  assert.deepEqual(await elsewhere.json(), { error: 'github_account_not_connected' });
  assert.deepEqual(fetched, []);
});

test('X1 standalone: a grant save stores the installation ID it was given, as before', async (t) => {
  const { store, request } = hostedAdmin(t, [agent()]);
  const grant = { id: 'repo_b', installationId: GITHUB_B, accountLogin: 'acme-b', fullName: 'acme-b/app', enabled: true };
  const response = await request(undefined, '/admin/api/agents/agent-coder', {
    method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, repositories: [grant] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await store.getAgent('agent-coder')).repositories, [grant]);
});

// --- X2: runtime mint (Worker-side connectors) and container egress ---

/** Run on the Cloudflare target with a state store that refuses every read, so nothing tenant-stored is consulted. */
function onCloudflare(t: TestContext): Record<string, unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const reads: string[] = [];
  const TAG_STATE = {
    getByName(name: string) {
      const installationId = splitInstallationObjectName(name).scope?.installationId ?? name;
      return new Proxy({}, { get(_target, property) {
        if (property === 'then') return undefined;
        return async (...args: unknown[]) => {
          // The installation's GitHub write counts and hold, which its own GitHub requests check.
          if (String(property) === 'settingGet' && args[0] === GITHUB_WRITES_KEY) return { ok: true, value: null };
          reads.push(`${installationId}:${String(property)}:${JSON.stringify(args[0])}`);
          if (String(property) === 'settingGet' || String(property) === 'settingGetMany') {
            throw new Error('a tenant setting was read');
          }
          return { ok: true, value: null };
        };
      } });
    },
  };
  return { TAG_STATE, reads };
}

test('X2: a turn mints only through its own installation\'s bindings, whatever installation ID or account its grants name', async (t) => {
  platform(t);
  const fetched = github(t);
  const { TAG_STATE } = onCloudflare(t);
  const env = hostedEnv(INSTALLATION_A, { TAG_STATE });
  const grants: RepositoryGrant[] = [
    { id: 'repo_b_all', installationId: GITHUB_B, accountLogin: 'acme-b', fullName: '', allRepos: true, enabled: true },
    { id: 'repo_b', installationId: GITHUB_B, accountLogin: 'acme-b', fullName: 'acme-b/secret', enabled: true },
    { id: 'repo_a', installationId: GITHUB_B, accountLogin: 'acme-a', fullName: 'acme-a/turn-app', enabled: true },
  ];
  const access = await resolveRepositoryAccess(grants, env as never);
  assert.deepEqual(access.grants.map(({ id }) => id), ['repo_a']);
  assert.deepEqual(mints(fetched), [GITHUB_A], 'B\'s installation is never minted');
  assert.deepEqual(JSON.parse(fetched[0]!.body!).repositories, ['turn-app']);
  assert.ok(access.connectors.every((connector) => connector.pathPrefixes.every((prefix) => !prefix.includes('acme-b'))));
  // Only B's account: governed, and nothing minted.
  fetched.length = 0;
  const none = await resolveRepositoryAccess(grants.slice(0, 2), env as never);
  assert.deepEqual(none, { grants: [], connectors: [], credentialMode: 'app', governsGithubHosts: true });
  assert.deepEqual(fetched, []);
});

/** A Sandbox namespace whose objects answer egress with `context`. */
function egressEnv(base: Record<string, unknown>, context: SandboxEgressContext) {
  const stub: SandboxEgressStub = {
    async egressContext() { return context; },
    async getTurnId() { return context.turnId; },
    async recordPullRequestProgress() { return true; },
  };
  return { ...base, SANDBOX: { idFromString: (id: string) => ({ id }), get: () => stub } };
}

test('X2 Sandbox egress: a container request mints only its installation\'s binding', async (t) => {
  platform(t);
  const fetched = github(t);
  const { TAG_STATE } = onCloudflare(t);
  const grantB = { id: 'repo_b', installationId: GITHUB_B, accountLogin: 'acme-b', fullName: 'acme-b/secret', enabled: true };
  const grantA = { id: 'repo_a', installationId: GITHUB_B, accountLogin: 'acme-a', fullName: 'acme-a/egress-app', enabled: true };
  const env = egressEnv({ ...HOSTED, TAG_STATE }, {
    installationId: INSTALLATION_A, turnId: 'turn_a', policy: { grants: [grantA, grantB], mode: 'app' },
  });
  const denied = await githubSandboxOutbound(new Request('https://api.github.com/repos/acme-b/secret/contents/README.md'), env, { containerId: 'do_a' });
  assert.equal(denied.status, SANDBOX_BLOCKED_STATUS);
  const clone = await githubSandboxOutbound(new Request('https://github.com/acme-b/secret.git/info/refs?service=git-upload-pack'), env, { containerId: 'do_a' });
  assert.equal(clone.status, SANDBOX_BLOCKED_STATUS);
  assert.deepEqual(mints(fetched), []);
  const allowed = await githubSandboxOutbound(new Request('https://api.github.com/repos/acme-a/egress-app/contents/README.md'), env, { containerId: 'do_a' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(mints(fetched), [GITHUB_A], 'the binding, never the stored installation ID');
  const forwarded = fetched.filter(({ url }) => url.includes('/contents/'));
  assert.deepEqual(forwarded.map(({ url }) => url), ['https://api.github.com/repos/acme-a/egress-app/contents/README.md']);
  assert.deepEqual(resolveRepositoryInstallationScope([grantA], ['acme-a/egress-app']), { id: GITHUB_B, repositories: ['egress-app'] },
    'standalone resolution is unchanged: the grant\'s own ID');
});

test('a coding task\'s mint GitHub answers 404, in its turn or its Sandbox\'s egress, fails once the host has taken the report', async (t) => {
  t.mock.method(console, 'warn', () => {});
  github(t, { mintStatus: 404 });
  const { TAG_STATE } = onCloudflare(t);
  const grant = { id: 'repo_a', installationId: GITHUB_A, accountLogin: 'acme-a', fullName: 'acme-a/coding-app', enabled: true };
  let port = platform(t);
  const turn = await resolveRepositoryAccess([grant], hostedEnv(INSTALLATION_A, { TAG_STATE }) as never);
  assert.deepEqual(turn.grants, []);
  assert.deepEqual(port.gone, [[INSTALLATION_A, GITHUB_A]]);

  port = platform(t);
  const env = egressEnv({ ...HOSTED, TAG_STATE }, {
    installationId: INSTALLATION_A, turnId: 'turn_a', policy: { grants: [grant], mode: 'app' },
  });
  const egress = await githubSandboxOutbound(new Request('https://api.github.com/repos/acme-a/coding-app/contents/README.md'), env, { containerId: 'do_a' });
  assert.equal(egress.status, SANDBOX_BLOCKED_STATUS);
  assert.deepEqual(port.gone, [[INSTALLATION_A, GITHUB_A]]);
});

// --- X3, X4, X5 through Admin, and the tenancy refusals ---

test('X3 and X4: Admin lists only the installation\'s own accounts, and the picker refuses another installation\'s ID', async (t) => {
  platform(t);
  const fetched = github(t);
  const { request } = hostedAdmin(t, [agent()]);
  const status = await request(ENV_A, '/admin/api/github/status');
  assert.equal(status.status, 200);
  const body = await status.json() as { mode: string; installations: Array<{ id: number; accountLogin: string; repoCount: number | null }> };
  assert.equal(body.mode, 'app');
  assert.deepEqual(body.installations.map(({ id, accountLogin }) => [id, accountLogin]), [[GITHUB_A, 'acme-a']]);
  assert.deepEqual(appListings(fetched), [], 'never the App\'s full installation list');
  assert.deepEqual(mints(fetched), [GITHUB_A], 'the count reads A\'s own installation only');
  fetched.length = 0;
  const foreign = await request(ENV_A, `/admin/api/github/installations/${GITHUB_B}/repos`);
  assert.equal(foreign.status, 404);
  assert.deepEqual(fetched, []);
  const own = await request(ENV_A, `/admin/api/github/installations/${GITHUB_A}/repos`);
  assert.equal(own.status, 200);
  assert.deepEqual(mints(fetched), [GITHUB_A]);
  // B, connected to nothing, is told so.
  const port = platform(t);
  port.bindings.set(INSTALLATION_B, []);
  assert.deepEqual(await (await request(ENV_B, '/admin/api/github/status')).json(), {
    mode: 'none', installations: [], connectPath: null, referencingAgents: [],
  });
});

test('Settings › GitHub answers once the host has taken the report of an installation GitHub no longer knows', async (t) => {
  const port = platform(t);
  github(t, { mintStatus: 404 });
  const { request } = hostedAdmin(t, [agent()]);
  const status = await (await request(ENV_A, '/admin/api/github/status')).json() as {
    installations: Array<{ id: number; repoCount: number | null }>;
  };
  assert.deepEqual(status.installations.map(({ id, repoCount }) => [id, repoCount]), [[GITHUB_A, null]]);
  assert.deepEqual(port.gone, [[INSTALLATION_A, GITHUB_A]]);
  // The next visit reads the bindings again, and the one the host ended is gone.
  const after = await (await request(ENV_A, '/admin/api/github/status')).json() as { mode: string; installations: unknown[] };
  assert.deepEqual([after.mode, after.installations], ['none', []]);
});

test('X5 skill import: a private repository resolves only through the installation\'s own binding for its owner', async (t) => {
  platform(t);
  const { request } = hostedAdmin(t);
  const resolve = (source: string) => request(ENV_A, '/admin/api/skills/resolve', { method: 'POST', body: JSON.stringify({ source }) });
  let fetched = github(t);
  const foreign = await resolve('acme-b/secret');
  assert.equal(foreign.status, 404);
  assert.deepEqual(fetched.filter(({ url }) => url.endsWith('/installation') || url.endsWith('/access_tokens')), [],
    'no App lookup and no mint for an account A has not bound');
  // A repository under A's account that GitHub now places in B's installation (transferred) fails closed.
  fetched = github(t, { repositoryInstallation: { 'acme-a': GITHUB_B } });
  const transferred = await resolve('acme-a/moved');
  assert.equal(transferred.status, 404);
  assert.deepEqual(mints(fetched), []);
  fetched = github(t);
  await resolve('acme-a/skills');
  assert.deepEqual(mints(fetched), [GITHUB_A]);
  const token = fetched.find(({ url }) => url.endsWith('/access_tokens'))!;
  assert.deepEqual(JSON.parse(token.body!), { repositories: ['skills'], permissions: { contents: 'read' } });
});

test('X5 skill import: a rate-limited anonymous probe still imports through the binding that grants the repository, and otherwise stays rate-limited', async (t) => {
  platform(t);
  const { request } = hostedAdmin(t);
  const resolve = (env: Record<string, unknown>, source: string) =>
    request(env, '/admin/api/skills/resolve', { method: 'POST', body: JSON.stringify({ source }) });
  const rateLimited = {
    error: 'github_rate_limited',
    message: 'GitHub rate limit reached. For a public skill, try a direct link to its folder or SKILL.md file, or retry after the limit resets.',
  };
  for (const anonymous of [{ status: 429 }, { status: 403, headers: { 'retry-after': '60' } }]) {
    const label = String(anonymous.status);
    let fetched = github(t, { anonymous });
    const own = await resolve(ENV_A, 'acme-a/skills');
    assert.equal(own.status, 200, label);
    const { resolution } = await own.json() as { resolution: { source: unknown; skills: Array<{ name: string }> } };
    assert.deepEqual(resolution.source, { visibility: 'private', access: 'github_app' }, label);
    assert.deepEqual(resolution.skills.map(({ name }) => name), ['bound-skill'], label);
    assert.deepEqual(mints(fetched), [GITHUB_A], label);

    // B holds no binding for A's account: still the rate limit, with no App lookup and no mint.
    fetched = github(t, { anonymous });
    const foreign = await resolve(ENV_B, 'acme-a/skills');
    assert.equal(foreign.status, 429, label);
    assert.deepEqual(await foreign.json(), rateLimited, label);
    assert.deepEqual(fetched.filter(({ url }) => url.endsWith('/installation') || url.endsWith('/access_tokens')), [], label);

    // A's binding does not select the repository, so GitHub refuses its token.
    github(t, { anonymous, mintStatus: 422 });
    const unselected = await resolve(ENV_A, 'acme-a/unselected');
    assert.equal(unselected.status, 429, label);
    assert.deepEqual(await unselected.json(), rateLimited, label);
  }
});

test('X5 lookup: getRepositoryInstallation answers only the binding for the owner, and only while GitHub agrees', async (t) => {
  platform(t);
  let fetched = github(t);
  const a = await hostedConnection(ENV_A);
  assert.equal(await getRepositoryInstallation(a, 'acme-b/secret'), null);
  assert.deepEqual(fetched, []);
  assert.deepEqual(await getRepositoryInstallation(a, 'ACME-A/app'), { id: GITHUB_A, accountLogin: 'ACME-A', accountType: 'Organization' });
  fetched = github(t, { repositoryInstallation: { 'acme-a': GITHUB_B } });
  assert.equal(await getRepositoryInstallation(a, 'acme-a/moved'), null);
  assert.equal(fetched.length, 1);
});

test('X5 management: a repository setup finishes only through the installation\'s own binding, and never creates an App', async (t) => {
  platform(t);
  const fetched = github(t);
  const START = 1_800_100_000_000;
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'h14a-management' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { identity.close(); config.close(); management.close(); settings.close(); });
  const unconnected = (id: string, fullName: string): RepositoryGrant => ({ id, installationId: null, accountLogin: 'unconnected', fullName, enabled: true });
  await config.createAgent({
    id: 'agent_repo', name: 'Repository Agent', creatorMembershipId: owner.membership.id, editPolicy: 'all_workspace_members',
    instructions: 'Work in the configured repositories.', enabled: true, skills: [], mcpServers: [], apiConnections: [],
    repositories: [unconnected('repo_b', 'acme-b/secret'), unconnected('repo_a', 'acme-a/app'), unconnected('repo_c', 'acme-a/other'),
    unconnected('repo_d', 'acme-a/callback')],
  });
  let sequence = 0;
  let issued = '';
  const service = new WorkspaceManagementService({
    identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
    randomId: () => `h14a_${++sequence}`, randomCapability: () => { issued = String(++sequence).padStart(43, 'r'); return issued; },
  });
  let principal: AuthPrincipal = {
    userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId,
    role: 'owner', authenticatorKind: 'better_auth', credentialId: 'session_h14a', correlationId: 'h14a', machine: false,
  };
  const setup = async (repositoryId: string, env: Record<string, unknown>) => {
    const result = await service.applyWorkspaceChanges({
      context: { userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId, origin: { kind: 'mcp', clientId: 'codex' } },
      idempotencyKey: `repository-${repositoryId}-${sequence}`,
      operations: [{ itemId: 'repository', kind: 'request_setup', target: { kind: 'repository_access', agentId: 'agent_repo', repositoryId } }],
    });
    assert.notEqual(result.status, 'clarification_required');
    const setupId = (result as { outcomes: Array<{ setupOperationId?: string }> }).outcomes[0]!.setupOperationId!;
    const app = createManagementSetupRoutes({
      management, config, settings, identity, now: () => START, platformEnv: env as never,
      randomCapability: () => `${setupId}`.padEnd(43, 's').slice(0, 43), authenticatePrincipal: async () => principal,
    });
    const exchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: issued }),
    });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
    const authorize = await app.request(`http://localhost/setup/${setupId}/authorize`, {
      method: 'POST', headers: { origin: 'http://localhost', cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ organization: 'acme-b' }).toString(),
    });
    return { setupId, app, cookie, authorize };
  };
  const finish = async ({ setupId, app, cookie }: Awaited<ReturnType<typeof setup>>) =>
    app.request(`http://localhost/setup/${setupId}/repository/finish`, { headers: { cookie } });
  const grant = async (id: string) => (await config.getAgent('agent_repo')).repositories.find((candidate) => candidate.id === id)!;

  // B's repository: A holds no binding for acme-b, so nothing is asked of GitHub and the grant stays unconnected.
  const foreign = await setup('repo_b', ENV_A);
  assert.equal(foreign.authorize.status, 303);
  assert.match(foreign.authorize.headers.get('location') ?? '', /\/repository\/finish$/);
  const refused = await finish(foreign);
  assert.match(refused.headers.get('location') ?? '', /status=failed/);
  assert.deepEqual(await grant('repo_b'), unconnected('repo_b', 'acme-b/secret'));
  assert.deepEqual(fetched, []);
  // A's own repository resolves to A's binding, for an Agent editor too: A's GitHub is connected, so no App is created.
  principal = { ...principal, role: 'member' };
  const own = await setup('repo_a', ENV_A);
  assert.equal(own.authorize.status, 303);
  const finished = await finish(own);
  assert.doesNotMatch(finished.headers.get('location') ?? '', /status=failed/);
  assert.deepEqual(await grant('repo_a'), { ...unconnected('repo_a', 'acme-a/app'), installationId: GITHUB_A, accountLogin: 'acme-a' });
  // The callback that would store an App is refused under tenancy, even for an Owner, before any exchange.
  principal = { ...principal, role: 'owner' };
  const pending = await setup('repo_d', ENV_A);
  await settings.setSetting(`management.${pending.setupId}.github-state`, 'unused');
  const callback = await pending.app.request(`http://localhost/setup/${pending.setupId}/github/callback?code=c&state=s`,
    { headers: { cookie: pending.cookie } });
  assert.equal(callback.status, 403);
  assert.equal(await settings.getSetting(`management.${pending.setupId}.github-state`), 'unused', 'the state is not consumed');
  // With no binding at all, the setup fails instead of offering to create an App.
  const port = platform(t);
  port.bindings.set(INSTALLATION_A, []);
  const unbound = await setup('repo_c', ENV_A);
  assert.ok(unbound.authorize.status >= 400, String(unbound.authorize.status));
  assert.doesNotMatch(await unbound.authorize.clone().text(), /settings\/apps\/new|manifest/);
  assert.notEqual((await management.getSetup(unbound.setupId))?.status, 'completed');
  assert.deepEqual(await grant('repo_c'), unconnected('repo_c', 'acme-a/other'));
  assert.ok((fetched as Fetched[]).every(({ url }) => !url.includes('app-manifests')));
  assert.equal(await settings.getSetting(GITHUB_SETTING_KEYS.appId), undefined);
});

/** Stores that fail any read, so a response proves where the request stopped. */
function untouchable<T extends object>(): T {
  return new Proxy({} as T, { get(_target, property) {
    if (property === 'then') return undefined;
    throw new Error(`store read: ${String(property)}`);
  } });
}

test('under tenancy an installation cannot create, store or remove its own GitHub App, before any store is read', async (t) => {
  t.mock.method(console, 'error', () => {});
  const routes = createAdminRoutes({ identity: untouchable(), store: untouchable(), settings: untouchable() });
  const refused: Array<[string, string]> = [
    ['POST', '/admin/api/github/manifest'],
    ['GET', '/admin/api/github/setup/callback?code=c&state=s'],
    ['GET', '/oauth/github/setup/callback?code=c&state=s'],
    ['DELETE', '/admin/api/github'],
  ];
  for (const [method, path] of refused) {
    const [route, query = ''] = path.split('?');
    for (const variant of new Set([route!, route!.replace('/api/', '//api/'), `${route}/`, route!.replace('/github', '/%67ithub')])) {
      const response = await routes.request(`https://hosted.example${variant}${query ? `?${query}` : ''}`, { method }, ENV_A);
      assert.equal(response.status, 404, `${method} ${variant}`);
    }
    // Standalone gets past the guard (to the store, which fails here, or to its own validation).
    assert.notEqual((await routes.request(`http://localhost${path}`, { method })).status, 404, `standalone ${method} ${path}`);
  }
  // Status, the picker and the per-account disconnect stay served.
  for (const [method, path] of [['GET', '/admin/api/github/status'], ['GET', `/admin/api/github/installations/${GITHUB_A}/repos`]] as const) {
    assert.notEqual((await routes.request(`https://hosted.example${path}`, { method }, ENV_A)).status, 404, `${method} ${path}`);
  }
});

test('disconnect ends one of the installation\'s own bindings through the host; another installation\'s is not found; standalone has no such route', async (t) => {
  const port = platform(t);
  const fetched = github(t);
  const { request } = hostedAdmin(t, [agent([
    { id: 'repo_a', installationId: GITHUB_A, accountLogin: 'acme-a', fullName: 'acme-a/app', enabled: true },
  ])]);
  const foreign = await request(ENV_A, `/admin/api/github/installations/${GITHUB_B}`, { method: 'DELETE' });
  assert.equal(foreign.status, 404);
  assert.deepEqual(port.disconnected, [], 'the host is never asked to end another installation\'s binding');
  const own = await request(ENV_A, `/admin/api/github/installations/${GITHUB_A}`, { method: 'DELETE' });
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { ok: true, referencingAgents: [{ id: 'agent-coder', name: 'Coder' }] });
  assert.deepEqual(port.disconnected, [[INSTALLATION_A, GITHUB_A]]);
  assert.deepEqual(await hostedConnection(ENV_A), { mode: 'none' }, 'the cached list is dropped at once');
  const again = await request(ENV_A, `/admin/api/github/installations/${GITHUB_A}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
  const standalone = await request(undefined, `/admin/api/github/installations/${GITHUB_A}`, { method: 'DELETE' });
  assert.equal(standalone.status, 404);
  assert.deepEqual(fetched, []);
});

test('a Member cannot disconnect a connected GitHub account', async (t) => {
  const port = platform(t);
  github(t);
  const { request } = hostedAdmin(t, [], { principal: memberPrincipal() });
  const refused = await request(ENV_A, `/admin/api/github/installations/${GITHUB_A}`, { method: 'DELETE' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { error: string }).error, 'forbidden');
  assert.deepEqual(port.disconnected, [], 'the host is never asked');
});

test('the host is asked to end only a binding the installation holds', async (t) => {
  const port = platform(t);
  assert.equal(await disconnectHostedGithubBinding(INSTALLATION_A, GITHUB_B), undefined);
  assert.deepEqual(port.disconnected, []);
  assert.equal((await disconnectHostedGithubBinding(INSTALLATION_A, GITHUB_A))?.accountLogin, 'acme-a');
  assert.deepEqual(port.disconnected, [[INSTALLATION_A, GITHUB_A]]);
});

test('under tenancy no App manifest is exchanged, even by a caller past the routes', async (t) => {
  const fetched = github(t);
  await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
    await assert.rejects(exchangeGithubAppManifest('code'), GithubInstallationNotMintableError);
  });
  assert.deepEqual(fetched, []);
});

test('capability reads follow the installation\'s bindings, never a tenant-stored App', async (t) => {
  const port = platform(t);
  port.bindings.set(INSTALLATION_B, []);
  github(t);
  const { settings } = await tenantSettings(t);
  const config = new SqliteConfigStore(':memory:', { agents: [agent()] });
  t.after(() => config.close());
  const envelope = (env: Record<string, unknown>) => buildTurnEnvelope({
    plan: { agentId: 'agent-coder' } as never, settings, config, env: env as never,
  });
  assert.equal((await envelope(ENV_A))?.githubAppConnected, true);
  assert.equal((await envelope(ENV_B))?.githubAppConnected, false, 'B\'s stored App does not count');
  const { request } = hostedAdmin(t);
  const unmet = async (env: Record<string, unknown>) =>
    ((await (await request(env, '/admin/api/sandbox/status')).json()) as { unmetPrerequisites: string[] }).unmetPrerequisites;
  assert.ok(!(await unmet(ENV_A)).includes('github_app'));
  assert.ok((await unmet(ENV_B)).includes('github_app'));
});

test('the coding workspace is offered only with the installation\'s own binding, never for a tenant-stored App', async (t) => {
  const port = platform(t);
  port.bindings.set(INSTALLATION_B, []);
  github(t);
  onCloudflare(t);
  resetHostedSandboxPolicyForTests();
  configureHostedSandboxPolicy(async () => ({
    enabled: true, allowedHosts: [], monthlySessionCap: 5, monthlyContainerHours: 1, maxRunningContainers: 1,
  }));
  t.after(() => resetHostedSandboxPolicyForTests());
  const { settings } = await tenantSettings(t);
  const assignment = { agent: { repositories: [
    { id: 'repo_a', installationId: GITHUB_A, accountLogin: 'acme-a', fullName: 'acme-a/app', enabled: true },
  ] } } as never;
  const decide = async (installationId: string) =>
    (await resolveCodingWorkspaceDecision(assignment, hostedEnv(installationId, { SANDBOX: {} }) as never, settings)).capability;
  assert.equal(await decide(INSTALLATION_A), 'available');
  assert.notEqual(await decide(INSTALLATION_B), 'available');
  // A turn without a frozen envelope reads the same live.
  const live = async (installationId: string) =>
    (await runtimePlanWorkspaceFacts(settings, undefined, hostedEnv(installationId) as never)).githubAppConnected;
  assert.equal(await live(INSTALLATION_A), true);
  assert.equal(await live(INSTALLATION_B), false);
});

test('the Sandbox presets its Git identity with its own installation\'s env', () => {
  const source = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  assert.match(source, /resolveWorkspaceGitIdentity\(getSettingsStore\(this\.env\), fetch, this\.env\)/);
});

// --- Bot identity (S7) ---

test('under tenancy the workspace commits as the platform App\'s bot from the host, never a tenant-written bot row', async (t) => {
  platform(t);
  const fetched = github(t);
  const { settings, touched } = await tenantSettings(t);
  assert.deepEqual(await resolveGithubAppBotUser(settings, fetch, ENV_A), { appId: PLATFORM_APP.appId, slug: 'chickpea-staging', id: 900_200 });
  assert.deepEqual(await resolveWorkspaceGitIdentity(settings, fetch, ENV_A), {
    name: 'chickpea-staging[bot]', email: '900200+chickpea-staging[bot]@users.noreply.github.com',
  });
  // An installation with no binding commits under the neutral identity.
  const port = platform(t);
  port.bindings.set(INSTALLATION_B, []);
  assert.deepEqual(await resolveWorkspaceGitIdentity(settings, fetch, ENV_B), NEUTRAL_GIT_IDENTITY);
  assert.deepEqual(githubKeysTouched(touched), [], 'github.app.bot_user is neither read nor written');
  assert.deepEqual(fetched, []);
});

// --- Standalone unchanged ---

test('standalone ignores an installed port: its stored App, its own installation IDs and GitHub\'s installation list, as before', async (t) => {
  platform(t);
  const fetched = github(t);
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await settings.setSetting(GITHUB_SETTING_KEYS.appId, '12345');
  await settings.setSetting(GITHUB_SETTING_KEYS.privateKey, PRIVATE_KEY);
  await withEnv({ CHICKPEA_TENANCY: undefined, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }, async () => {
    const connection = await getGithubConnection(settings);
    assert.deepEqual(connection, { mode: 'app', appId: '12345', privateKeyPem: PRIVATE_KEY.trim() });
    await createInstallationToken(connection, GITHUB_B, {});
    await listInstallations(connection).catch(() => undefined);
    assert.deepEqual(mints(fetched), [GITHUB_B]);
    assert.equal(appListings(fetched).length, 1);
  });
});

// --- Import (S8) and the marker ---

test('an Agent imported into another deployment carries no installation ID: each grant fails closed until re-picked', async (t) => {
  const source = new SqliteConfigStore(':memory:', { agents: [] });
  const target = new SqliteConfigStore(':memory:', { agents: [] });
  t.after(() => { source.close(); target.close(); });
  const { model: _model, ...exported } = agent([
    { id: 'repo_a', installationId: GITHUB_A, accountLogin: 'acme-a', fullName: 'acme-a/app', enabled: true },
  ]);
  await source.createAgent(exported);
  const recipe = await exportWorkspaceRecipe(source, {});
  assert.doesNotMatch(JSON.stringify(recipe), /installationId|accountLogin|101/);
  const preview = await previewWorkspaceRecipe(target, async () => 'stored', { recipe });
  const created = preview.operations.find((operation) => operation.kind === 'create_agent') as { agent: { repositories: RepositoryGrant[] } };
  assert.deepEqual(created.agent.repositories.map(({ installationId, fullName }) => ({ installationId, fullName })), [
    { installationId: null, fullName: 'acme-a/app' },
  ]);
  // A recipe that names an installation is refused outright.
  const named = structuredClone(recipe) as unknown as { agents: Array<{ repositoryRequirements: Array<Record<string, unknown>> }> };
  named.agents[0]!.repositoryRequirements[0]!.installationId = GITHUB_B;
  await assert.rejects(previewWorkspaceRecipe(target, async () => 'stored', { recipe: named }), /non-portable|unsupported|invalid/i);
});

test('Core declares the GitHub platform gate in hosted-capabilities.json, and ships it', () => {
  const root = new URL('../', import.meta.url);
  assert.deepEqual(JSON.parse(readFileSync(new URL('hosted-capabilities.json', root), 'utf8')), { githubPlatformApp: 1 });
  const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { files: string[] };
  assert.ok(packageJson.files.includes('hosted-capabilities.json'), 'npm ships it');
  assert.ok((REQUIRED_PACKAGED_FILES as string[]).includes('hosted-capabilities.json'), 'the release pack check requires it');
});

// --- H14b: hosted Admin's GitHub status, connect path and onboarding step ---

test('hosted status lists active and suspended accounts, counts only active ones, and never names the App', async (t) => {
  const port = platform(t);
  port.bindings.set(INSTALLATION_A, [binding(GITHUB_A, 'acme-a'), binding(GITHUB_B + 1, 'acme-paused', 'suspended')]);
  const fetched = github(t);
  const { request } = hostedAdmin(t);
  const body = await (await request(ENV_A, '/admin/api/github/status')).json() as Record<string, unknown>;
  assert.deepEqual(body, {
    mode: 'app',
    installations: [
      { id: GITHUB_A, accountLogin: 'acme-a', accountType: 'Organization', status: 'active', repoCount: 1 },
      { id: GITHUB_B + 1, accountLogin: 'acme-paused', accountType: 'Organization', status: 'suspended', repoCount: null },
    ],
    connectPath: null,
    referencingAgents: [],
  });
  assert.deepEqual(mints(fetched), [GITHUB_A], 'a suspended account is never minted for');
  assert.deepEqual(appListings(fetched), []);
  // Only suspended accounts: not connected, but listed so Admin can say so.
  platform(t).bindings.set(INSTALLATION_A, [binding(GITHUB_A, 'acme-a', 'suspended')]);
  const suspended = await (await request(ENV_A, '/admin/api/github/status')).json() as { mode: string; installations: unknown[] };
  assert.equal(suspended.mode, 'none');
  assert.deepEqual(suspended.installations, [{ id: GITHUB_A, accountLogin: 'acme-a', accountType: 'Organization', status: 'suspended', repoCount: null }]);
  // Without a complete platform App, no account is listed.
  platform(t, { app: undefined });
  assert.deepEqual((await (await request(ENV_A, '/admin/api/github/status')).json() as { installations: unknown[] }).installations, []);
});

test('the connect path reaches Admin only from a host with a complete App, and only on a deployment serving many installations', async (t) => {
  assert.throws(() => configureHostedGithubConnect({ path: 'https://evil.example/connect' }), /same-origin/);
  assert.throws(() => configureHostedGithubConnect({ path: '//evil.example/connect' }), /same-origin/);
  assert.throws(() => configureHostedGithubConnect({ path: '/\\evil.example' }), /same-origin/);
  const port = platform(t);
  github(t);
  const { request } = hostedAdmin(t);
  const connectPath = async (env: Record<string, unknown> | undefined) =>
    ((await (await request(env, '/admin/api/github/status')).json()) as { connectPath?: unknown }).connectPath;
  assert.equal(await connectPath(ENV_A), null, 'no hook installed');
  configureHostedGithubConnect({ path: '/github/connect' });
  const reads = port.appReads;
  assert.equal(await connectPath(ENV_A), '/github/connect');
  assert.equal(port.appReads - reads, 2, 'the connection reads the App once, and the status once more');
  assert.equal(await connectPath(undefined), undefined, 'standalone status is unchanged');
  platform(t, { app: undefined });
  configureHostedGithubConnect({ path: '/github/connect' });
  assert.equal(await connectPath(ENV_A), null, 'no App, no Connect that would fail at the host');
  configureHostedGithub(undefined);
  assert.equal(await hostedGithubConnectPath(), null, 'no port, no Connect');
});

async function onboardingAtTry(t: TestContext) {
  const admin = hostedAdmin(t);
  await admin.store.ensureWorkspaceInstallation({
    workspaceId: 'TONBOARD', teamId: 'TONBOARD', appId: 'AONBOARD', botUserId: 'UONBOARDBOT',
    gatewayBindingId: 'onboarding-gateway-binding', transportMode: 'gateway', runtimeContract: 'chickpea-v1',
  });
  const begun = await beginOnboardingJourney(admin.settings, 100);
  const provider = await selectOnboardingProvider(admin.settings, { expectedRevision: begun.revision, workspaceId: 'TONBOARD', providerId: 'anthropic' });
  await startOnboardingTry(admin.settings, {
    expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: 'UONBOARD', tryStartedAt: 300,
  });
  const read = async (env: Record<string, unknown> | undefined) =>
    await (await admin.request(env, '/admin/api/onboarding')).json() as { stage: string; revision: string; githubConnectPath?: string };
  const settle = (env: Record<string, unknown> | undefined, expectedRevision: string) =>
    admin.request(env, '/admin/api/onboarding/github', { method: 'POST', body: JSON.stringify({ expectedRevision }) });
  return { ...admin, read, settle };
}

test('hosted onboarding stops at Connect GitHub after the model while the host can connect; settling it moves on to Try', async (t) => {
  platform(t);
  configureHostedGithubConnect({ path: '/github/connect' });
  const { settings, read, settle } = await onboardingAtTry(t);
  const before = await read(ENV_A);
  assert.equal(before.stage, 'connect_github');
  assert.equal(before.githubConnectPath, '/github/connect');
  assert.equal((await settle(ENV_A, 'stale')).status, 409);
  const settled = await settle(ENV_A, before.revision);
  assert.equal(settled.status, 200);
  const after = await settled.json() as { stage: string; revision: string; githubConnectPath?: string };
  assert.equal(after.stage, 'try');
  assert.equal(after.githubConnectPath, '/github/connect', 'the rail keeps five steps');
  assert.equal((await readOnboardingJourney(settings))?.journey.githubStepAt !== undefined, true, 'persisted as the other stages are');
  assert.equal((await read(ENV_A)).stage, 'try');
  // Settling again changes nothing.
  const again = await settle(ENV_A, after.revision);
  assert.equal((await again.json() as { revision: string }).revision, after.revision);
});

test('without a host connect path, and on standalone, onboarding goes from the model straight to Try', async (t) => {
  platform(t);
  const hosted = await onboardingAtTry(t);
  const plain = await hosted.read(ENV_A);
  assert.equal(plain.stage, 'try');
  assert.equal('githubConnectPath' in plain, false);
  assert.equal((await hosted.settle(ENV_A, plain.revision)).status, 404);
  configureHostedGithubConnect({ path: '/github/connect' });
  const standalone = await hosted.read(undefined);
  assert.equal(standalone.stage, 'try');
  assert.equal('githubConnectPath' in standalone, false);
  assert.equal((await hosted.settle(undefined, standalone.revision)).status, 404);
  assert.equal((await readOnboardingJourney(hosted.settings))?.journey.githubStepAt, undefined);
});

test('settling the GitHub step before the model is a conflict, not a server error', async (t) => {
  platform(t);
  configureHostedGithubConnect({ path: '/github/connect' });
  const admin = hostedAdmin(t);
  const begun = await beginOnboardingJourney(admin.settings, 100);
  const provider = await selectOnboardingProvider(admin.settings, { expectedRevision: begun.revision, workspaceId: 'TONBOARD', providerId: 'anthropic' });
  const early = await admin.request(ENV_A, '/admin/api/onboarding/github', { method: 'POST', body: JSON.stringify({ expectedRevision: provider.revision }) });
  assert.equal(early.status, 409);
  assert.deepEqual(await early.json(), { error: 'onboarding_try_required' });
  assert.equal((await readOnboardingJourney(admin.settings))?.revision, provider.revision, 'nothing is written');
});

test('a Member cannot settle the onboarding GitHub step', async (t) => {
  platform(t);
  configureHostedGithubConnect({ path: '/github/connect' });
  const { settings } = await onboardingAtTry(t);
  const before = await readOnboardingJourney(settings);
  const member = hostedAdmin(t, [], { principal: memberPrincipal() });
  const refused = await member.request(ENV_A, '/admin/api/onboarding/github', { method: 'POST', body: JSON.stringify({ expectedRevision: before!.revision }) });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { error: string }).error, 'forbidden');
});

/** An Owner's onboarding at Choose model, signed in as a Slack user of the workspace, and a request that starts Try. */
async function onboardingAtModel(t: TestContext, env: Record<string, unknown> | undefined) {
  const identity = new SqliteIdentityStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => { identity.close(); usage.close(); invalidateProviderKeyCache(); });
  invalidateProviderKeyCache();
  const owner = await createSlackOwner(identity, { teamId: 'TONBOARD', userId: 'UONBOARD', suffix: 'h14b-onboarding' });
  const admin = hostedAdmin(t, [], {
    identity,
    principal: {
      userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId,
      role: 'owner', authenticatorKind: 'test_slack_session', credentialId: 'session_h14b', correlationId: 'h14b', machine: false,
    },
  });
  await admin.store.ensureWorkspaceInstallation({
    workspaceId: 'TONBOARD', teamId: 'TONBOARD', appId: 'AONBOARD', botUserId: 'UONBOARDBOT',
    gatewayBindingId: 'onboarding-gateway-binding', transportMode: 'gateway', runtimeContract: 'chickpea-v1',
  });
  await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: 'h14b-onboarding-test-key' }, { env, settings: admin.settings, usage });
  const begun = await beginOnboardingJourney(admin.settings, 100);
  const provider = await selectOnboardingProvider(admin.settings, { expectedRevision: begun.revision, workspaceId: 'TONBOARD', providerId: 'anthropic' });
  const startTry = async () => {
    const workspace = await (await admin.request(env, '/admin/api/workspace-model-default')).json() as { workspaceDefault: { revision: number } };
    const tried = await admin.request(env, '/admin/api/onboarding/try', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: provider.revision, modelId: 'anthropic/claude-sonnet-5', expectedDefaultRevision: workspace.workspaceDefault.revision }),
    });
    assert.equal(tried.status, 200, await tried.clone().text());
    return await tried.json() as { stage: string };
  };
  return { ...admin, startTry };
}

test('a hosted journey that reached Try with no GitHub step offered stays at Try once the host can connect', async (t) => {
  platform(t);
  useDeploymentKeyring(t);
  // Nothing here reaches a provider or GitHub.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in this test'); });
  const hosted = await onboardingAtModel(t, ENV_A);
  assert.equal((await hosted.startTry()).stage, 'try');
  const journey = (await readOnboardingJourney(hosted.settings))!.journey;
  assert.equal(journey.githubStepAt, journey.tryStartedAt, 'the step not offered is settled when Try starts');
  // The host installs its connect path later: the journey stays at Try.
  configureHostedGithubConnect({ path: '/github/connect' });
  const later = await (await hosted.request(ENV_A, '/admin/api/onboarding')).json() as { stage: string; githubConnectPath?: string };
  assert.equal(later.stage, 'try');
  assert.equal(later.githubConnectPath, '/github/connect');
  // A host that offers the step when Try starts stops there instead.
  const offered = await onboardingAtModel(t, ENV_A);
  assert.equal((await offered.startTry()).stage, 'connect_github');
  assert.equal((await readOnboardingJourney(offered.settings))!.journey.githubStepAt, undefined);
  // Standalone never records the step.
  const standalone = await onboardingAtModel(t, undefined);
  assert.equal((await standalone.startTry()).stage, 'try');
  assert.equal((await readOnboardingJourney(standalone.settings))!.journey.githubStepAt, undefined);
});

test('the GitHub step is part of the journey: it follows the model, and choosing a provider again resets it', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const begun = await beginOnboardingJourney(settings, 100);
    await assert.rejects(settleOnboardingGithubStep(settings, begun.revision, 400), /before choosing a model/);
    const provider = await selectOnboardingProvider(settings, { expectedRevision: begun.revision, workspaceId: 'T1', providerId: 'anthropic' });
    const trying = await startOnboardingTry(settings, {
      expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: 'U1', tryStartedAt: 300,
    });
    const settled = await settleOnboardingGithubStep(settings, trying.revision, 400);
    assert.equal(settled.journey.githubStepAt, 400);
    assert.equal((await settleOnboardingGithubStep(settings, settled.revision, 500)).revision, settled.revision, 'once recorded it stays');
    const again = await startOnboardingTry(settings, {
      expectedRevision: settled.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: 'U1', tryStartedAt: 600,
      githubStepNotOffered: true,
    });
    assert.equal(again.journey.githubStepAt, 400, 'starting Try again keeps it');
    assert.throws(() => parseOnboardingJourney(JSON.stringify({ version: 2, state: 'active', startedAt: 100, githubStepAt: 400 })), /invalid/);
    const reselected = await selectOnboardingProvider(settings, { expectedRevision: again.revision, workspaceId: 'T1', providerId: 'openai' });
    assert.equal(reselected.journey.githubStepAt, undefined);
  } finally {
    settings.close();
  }
});
