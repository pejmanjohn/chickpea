import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { resolveRepositoryAccess } from '../src/agents/slack-thread.ts';
import { createConnectorScopedBash, DEFAULT_EGRESS_POLICY, type ConnectorFetchResult } from '../src/config/egress.ts';
import { configureHostedGithub, resetHostedGithubForTests } from '../src/config/hosted-github.ts';
import { configureInstallationAdmission, resetInstallationAdmissionForTests } from '../src/config/installation-admission.ts';
import { scopeInstallationEnv, splitInstallationObjectName } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore, type SettingsPatch } from '../src/config/settings-store.ts';
import type { RepositoryGrant } from '../src/config/types.ts';
import type { SandboxEgressContext } from '../src/sandbox/cloudflare-policy.ts';
import { decideSandboxEgress } from '../src/sandbox/egress-handler.ts';
import { githubSandboxOutbound, SANDBOX_BLOCKED_STATUS, type SandboxEgressStub } from '../src/sandbox/egress-outbound.ts';
import {
  admitGithubRequest,
  admitGithubWrite,
  githubConnectorWriteGate,
  githubSecondaryLimitSeconds,
  GITHUB_HOLD_RECHECK_MS,
  GITHUB_LATCH_ALERT_WINDOW_MS,
  GITHUB_PULL_REQUEST_WINDOW_MS,
  GITHUB_PULL_REQUESTS_PER_WINDOW,
  GITHUB_SECONDARY_LIMIT_MAX_SECONDS,
  GITHUB_SECONDARY_LIMIT_MIN_SECONDS,
  GITHUB_WRITE_WINDOW_MS,
  GITHUB_WRITES_KEY,
  GITHUB_WRITES_PER_WINDOW,
  latchGithubRequests,
  resetGithubLatchesForTests,
  type GithubAdmission,
} from '../src/sandbox/github-write-rate.ts';
import { withEnv } from './helpers/env.ts';

/**
 * H14a′: on a deployment serving many installations, an Agent's Worker-side
 * bash reaches GitHub through connectors carrying a platform App token. Its
 * writes draw on the same per-installation budget as container egress,
 * judged by the egress decision's own logic, and both paths stop every
 * request, reads included, while GitHub's secondary limit holds the
 * installation. Standalone is unchanged.
 */

const INSTALLATION_A = `inst_${'0123456789abcdef'.repeat(2)}`;
const INSTALLATION_B = `inst_${'fedcba9876543210'.repeat(2)}`;
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const PRIVATE_KEY = String(generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
const GITHUB_A = 101;
const GITHUB_B = 202;
const GRANT_A: RepositoryGrant = { id: 'repo_a', installationId: GITHUB_A, accountLogin: 'acme-a', fullName: 'acme-a/app', enabled: true };
const GRANT_B: RepositoryGrant = { id: 'repo_b', installationId: GITHUB_B, accountLogin: 'acme-b', fullName: 'acme-b/app', enabled: true };
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
/** A clock far from the real one, for waits GitHub gives as an HTTP date. */
const T_FAR = Date.UTC(2031, 0, 1);
const SECONDARY_LIMIT_BODY = JSON.stringify({
  message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
});

type Store = Pick<SqliteSettingsStore, 'getSetting' | 'applySettingsPatch'>;

function settingsStore(t: TestContext): SqliteSettingsStore {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  return store;
}

async function stored(store: Store): Promise<{ writes: number[]; pullRequests: number[]; latchedUntil?: number } | undefined> {
  const raw = await store.getSetting(GITHUB_WRITES_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

/** Writes already spent: `count` writes and `pullRequests` pull requests, each `ageMs` ago. */
const spentWrites = (count: number, pullRequests = 0, ageMs = 0) => JSON.stringify({
  writes: Array.from({ length: count }, () => Date.now() - ageMs),
  pullRequests: Array.from({ length: pullRequests }, () => Date.now() - ageMs),
});

/** A Retry-After of `seconds`, less the few the test itself took on the real clock. */
function assertWait(retryAfter: string | null | undefined, seconds: number, message = 'Retry-After'): void {
  const value = Number(retryAfter);
  assert.ok(value > seconds - 5 && value <= seconds, `${message}: ${retryAfter}, expected about ${seconds}`);
}

/** No holds or operator events left from another test in this isolate, before or after this one. */
function freshIsolate(t: TestContext): void {
  resetGithubLatchesForTests();
  t.after(() => resetGithubLatchesForTests());
}

/**
 * A hosted deployment on Cloudflare: the platform App with A bound to
 * acme-a and B to acme-b, every installation admitted, and each
 * installation's own state store.
 */
async function hosted(t: TestContext, seeds: Record<string, Record<string, string>> = {}) {
  resetHostedGithubForTests();
  resetInstallationAdmissionForTests();
  freshIsolate(t);
  configureHostedGithub({
    app: () => ({ appId: '910100', appSlug: 'chickpea-staging', privateKeyPem: PRIVATE_KEY, botUserId: 910_200 }),
    bindings: {
      list: async (installationId) => [installationId === INSTALLATION_A
        ? { githubInstallationId: GITHUB_A, accountLogin: 'acme-a', accountType: 'Organization', repositorySelection: 'selected', status: 'active' }
        : { githubInstallationId: GITHUB_B, accountLogin: 'acme-b', accountType: 'Organization', repositorySelection: 'selected', status: 'active' }],
      disconnect: async () => false,
      reportGone() {},
    },
  });
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => { resetHostedGithubForTests(); resetInstallationAdmissionForTests(); });
  onCloudflare(t);
  const stores = new Map<string, SqliteSettingsStore>();
  for (const installationId of [INSTALLATION_A, INSTALLATION_B]) {
    const store = settingsStore(t);
    for (const [key, value] of Object.entries(seeds[installationId] ?? {})) await store.setSetting(key, value);
    stores.set(installationId, store);
  }
  let countsBroken = false;
  const TAG_STATE = tagState(
    (name) => stores.get(splitInstallationObjectName(name).scope?.installationId ?? name),
    (key) => countsBroken && key === GITHUB_WRITES_KEY,
  );
  return {
    store: (installationId: string) => stores.get(installationId)!,
    /** From now on the state store fails every read and write of the GitHub counts. */
    breakCounts() { countsBroken = true; },
    env: (installationId: string) => scopeInstallationEnv({ ...HOSTED, TAG_STATE } as Record<string, unknown>, { installationId }),
    egressEnv: (installationId: string) => egressEnv({ ...HOSTED, TAG_STATE }, {
      installationId, turnId: 'turn_1', policy: { grants: [installationId === INSTALLATION_A ? GRANT_A : GRANT_B], mode: 'app' },
    }),
  };
}

/** Cloudflare's TAG_STATE over one settings store per object name; a `failing` key's reads and writes throw. */
function tagState(storeFor: (name: string) => SqliteSettingsStore | undefined, failing: (key: string) => boolean = () => false) {
  const check = (keys: ReadonlyArray<string | undefined>) => {
    if (keys.some((key) => key !== undefined && failing(key))) throw new Error('state store unavailable');
  };
  return {
    getByName(name: string) {
      const settings = storeFor(name);
      if (!settings) throw new Error('no such installation');
      return {
        async settingGet(key: string) {
          check([key]);
          return { ok: true, value: (await settings.getSetting(key)) ?? null };
        },
        async settingGetMany(keys: readonly string[]) {
          check(keys);
          return { ok: true, value: (await settings.getSettings(keys)).map((value) => value ?? null) };
        },
        async settingApplyPatch(patch: SettingsPatch) {
          check([patch.expected?.key, ...(patch.set ?? []).map(({ key }) => key)]);
          return { ok: true, value: await settings.applySettingsPatch(patch) };
        },
      };
    },
  };
}

function onCloudflare(t: TestContext): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}

function egressEnv(base: Record<string, unknown>, context: SandboxEgressContext) {
  const stub: SandboxEgressStub = {
    async egressContext() { return context; },
    async getTurnId() { return context.turnId; },
    async recordPullRequestProgress() { return true; },
  };
  return { ...base, SANDBOX: { idFromString: (id: string) => ({ id }), get: () => stub } };
}

interface Sent { method: string; url: string; headers: Headers }

/**
 * GitHub as the tests see it: DNS answers a public address, mints answer a
 * token, and every other request is recorded and answered by `answer`
 * (200 by default).
 */
function github(t: TestContext, answer: (request: Sent) => Response = () => new Response('{}')): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.hostname === 'cloudflare-dns.com') {
      return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '140.82.112.6' }] : [] });
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    const entry = { method: request.method, url: request.url, headers: request.headers };
    sent.push(entry);
    return answer(entry);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return sent;
}

/** An Agent's Worker-side bash with the installation's repository connectors. */
async function agentBash(env: Record<string, unknown>, grants: RepositoryGrant[]) {
  const access = await resolveRepositoryAccess(grants, env as never);
  assert.ok(access.connectors.length > 0, 'the turn has repository connectors');
  const sandbox = await createConnectorScopedBash(DEFAULT_EGRESS_POLICY, true, access.connectors).createSandbox({} as never);
  return {
    access,
    /** curl's own result, for a request that may fail. */
    exec: (args: string) => sandbox.exec(`curl -sS -i ${args}`),
    /** The HTTP status curl reports, and its Retry-After when one was sent. */
    async curl(args: string): Promise<{ status: number; retryAfter?: string }> {
      const result = await sandbox.exec(`curl -sS -i ${args}`);
      assert.equal(result.exitCode, 0, result.stderr);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(result.stdout)?.[1]);
      const retryAfter = /^retry-after: (.+?)\r?$/im.exec(result.stdout)?.[1];
      return { status, ...(retryAfter ? { retryAfter } : {}) };
    },
  };
}

const ISSUE = `-X POST https://api.github.com/repos/acme-a/app/issues -d '{"title":"x"}'`;
const PULL = `-X POST https://api.github.com/repos/acme-a/app/pulls -d '{"head":"x","base":"main"}'`;
const READ = 'https://api.github.com/repos/acme-a/app/contents/README.md';

// --- The budget on the bash path ---------------------------------------------

test('bash: an installation\'s GitHub writes are counted, and past the budget refused with a 429 before they leave', async (t) => {
  const deployment = await hosted(t, {
    [INSTALLATION_A]: { [GITHUB_WRITES_KEY]: spentWrites(GITHUB_WRITES_PER_WINDOW - 1, 0, 200_000) },
  });
  const sent = github(t);
  const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  assert.deepEqual(await bash.curl(ISSUE), { status: 200 }, 'the last write of the window');
  assert.equal((await stored(deployment.store(INSTALLATION_A)))?.writes.length, GITHUB_WRITES_PER_WINDOW, 'counted');
  // Refused until the oldest write, 200 seconds old, leaves the ten-minute window.
  const refused = await bash.curl(ISSUE);
  assert.equal(refused.status, 429);
  assertWait(refused.retryAfter, GITHUB_WRITE_WINDOW_MS / 1_000 - 200);
  const patch = await bash.curl(`-X PATCH https://api.github.com/repos/acme-a/app/pulls/4 -d '{}'`);
  assert.equal(patch.status, 429);
  assertWait(patch.retryAfter, GITHUB_WRITE_WINDOW_MS / 1_000 - 200);
  assert.deepEqual(sent.map(({ method, url }) => `${method} ${url}`), ['POST https://api.github.com/repos/acme-a/app/issues'],
    'refused writes never reach GitHub');
  assert.equal((await stored(deployment.store(INSTALLATION_A)))?.writes.length, GITHUB_WRITES_PER_WINDOW, 'refusals are not counted');
});

test('bash: pull requests count per day as well', async (t) => {
  const deployment = await hosted(t, {
    [INSTALLATION_A]: { [GITHUB_WRITES_KEY]: spentWrites(0, GITHUB_PULL_REQUESTS_PER_WINDOW - 1, 3_600_000) },
  });
  const sent = github(t);
  const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  assert.equal((await bash.curl(PULL)).status, 200);
  // Refused until the oldest pull request, an hour old, leaves the day.
  const refused = await bash.curl(PULL);
  assert.equal(refused.status, 429);
  assertWait(refused.retryAfter, (GITHUB_PULL_REQUEST_WINDOW_MS - 3_600_000) / 1_000);
  assert.equal((await bash.curl(ISSUE)).status, 200, 'other writes go on');
  assert.deepEqual(sent.map(({ url }) => new URL(url).pathname), ['/repos/acme-a/app/pulls', '/repos/acme-a/app/issues']);
  const counted = await stored(deployment.store(INSTALLATION_A));
  assert.equal(counted?.pullRequests.length, GITHUB_PULL_REQUESTS_PER_WINDOW);
  assert.equal(counted?.writes.length, 2);
});

test('bash: reads are never counted, and go on when the budget is spent', async (t) => {
  const spent = spentWrites(GITHUB_WRITES_PER_WINDOW, GITHUB_PULL_REQUESTS_PER_WINDOW);
  const deployment = await hosted(t, { [INSTALLATION_A]: { [GITHUB_WRITES_KEY]: spent } });
  const sent = github(t);
  const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  assert.equal((await bash.curl(READ)).status, 200);
  assert.equal((await bash.curl('https://api.github.com/repos/acme-a/app/pulls?state=open')).status, 200);
  assert.equal((await bash.curl('"https://github.com/acme-a/app.git/info/refs?service=git-upload-pack"')).status, 200);
  assert.equal((await bash.curl(`-X POST https://github.com/acme-a/app.git/git-upload-pack -d '0000'`)).status, 200,
    'Git\'s fetch posts');
  assert.equal(sent.length, 4);
  assert.equal(await deployment.store(INSTALLATION_A).getSetting(GITHUB_WRITES_KEY), spent, 'nothing counted');
});

test('bash: a method override header or `_method` parameter makes a read a write, as on egress', async (t) => {
  const deployment = await hosted(t);
  const sent = github(t);
  const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  for (const name of ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override']) {
    assert.equal((await bash.curl(`-H '${name}: PATCH' https://api.github.com/repos/acme-a/app/pulls/4`)).status, 200, name);
  }
  assert.equal((await bash.curl('"https://api.github.com/repos/acme-a/app/pulls/4?_method=PATCH"')).status, 200);
  assert.equal((await bash.curl(`-H 'X-HTTP-Method-Override: PUT' -X POST https://github.com/acme-a/app.git/git-upload-pack -d '0000'`)).status,
    200);
  assert.equal((await bash.curl(`-H 'X-HTTP-Method-Override: POST' https://api.github.com/repos/acme-a/app/pulls`)).status, 200);
  const counted = await stored(deployment.store(INSTALLATION_A));
  assert.equal(counted?.writes.length, 6, 'each counted as a write');
  assert.equal(counted?.pullRequests.length, 1, 'an overridden pull request path counts per day');
  assert.equal(sent.length, 6);

  // With the budget spent, the same requests are refused before they leave.
  await deployment.store(INSTALLATION_A).setSetting(GITHUB_WRITES_KEY, spentWrites(GITHUB_WRITES_PER_WINDOW));
  assert.equal((await bash.curl(`-H 'x-http-method-override: PATCH' https://api.github.com/repos/acme-a/app/pulls/4`)).status, 429);
  assert.equal((await bash.curl('"https://api.github.com/repos/acme-a/app/pulls/4?_METHOD=patch"')).status, 429);
  assert.equal(sent.length, 6);
});

test('the bash gate counts exactly what the egress decision judges a write', async (t) => {
  freshIsolate(t);
  const cases: Array<[string, string, Record<string, string>?]> = [
    ['https://api.github.com/repos/acme-a/app/pulls', 'GET'],
    ['https://api.github.com/repos/acme-a/app/pulls', 'POST'],
    ['https://api.github.com/repos/acme-a/app/PULLS/', 'POST'],
    ['https://api.github.com/repos/acme-a/app/%70ulls', 'PUT'],
    ['https://api.github.com/repos/acme-a/app//pulls', 'PATCH'],
    ['https://api.github.com/repos/acme-a/app/issues/1/comments', 'POST'],
    ['https://api.github.com/repos/acme-a/app/contents/a.md', 'PUT'],
    ['https://api.github.com/repos/acme-a/app/pulls/4', 'GET', { 'X-HTTP-Method-Override': 'PATCH' }],
    ['https://api.github.com/repos/acme-a/app/pulls/4?_method=PATCH', 'GET'],
    ['https://api.github.com/search/code?q=x+repo:acme-a/app', 'GET'],
    ['https://github.com/acme-a/app.git/info/refs?service=git-receive-pack', 'GET'],
    ['https://github.com/acme-a/app.git/git-upload-pack', 'POST'],
    ['https://github.com/acme-a/app.git/git-upload-pack?x=1', 'POST'],
    ['https://github.com/acme-a/app.git/GIT-UPLOAD-PACK', 'POST'],
    ['https://github.com/acme-a/app.git/git-upload-pack', 'POST', { 'X-HTTP-Method-Override': 'PUT' }],
    ['https://github.com/acme-a/app.git/git-receive-pack', 'POST'],
    ['https://github.com/acme-a/app.git/info/lfs/objects/batch', 'POST'],
  ];
  for (const [url, method, headers] of cases) {
    const decision = decideSandboxEgress({
      url, method, grants: [GRANT_A], allowedHosts: [], ...(headers ? { headers: new Headers(headers) } : {}),
    });
    assert.ok(decision.allowed && decision.kind === 'github', url);
    const store = settingsStore(t);
    const gate = githubConnectorWriteGate({ store, installationId: INSTALLATION_A, now: () => T0 });
    let sends = 0;
    await gate({ url, method, headers: new Headers(headers) }, async () => {
      sends += 1;
      return { status: 200, statusText: 'OK', headers: {}, body: new Uint8Array(), url };
    });
    assert.equal(sends, 1);
    const counted = await stored(store);
    const effect = counted === undefined ? 'read' : counted.pullRequests.length ? 'pull_request' : 'write';
    assert.equal(effect, decision.effect, `${method} ${url} ${JSON.stringify(headers ?? {})}`);
  }
});

test('bash: a write is sent once, never again after a redirect; a read follows it', async (t) => {
  const deployment = await hosted(t);
  const sent = github(t, ({ url }) => new URL(url).pathname.endsWith('/moved')
    ? new Response('{}')
    : new Response(null, { status: 307, headers: { Location: 'https://api.github.com/repos/acme-a/app/moved' } }));
  const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  assert.equal((await bash.curl(`-X POST https://api.github.com/repos/acme-a/app/issues -d '{}'`)).status, 307);
  assert.deepEqual(sent.map(({ method, url }) => `${method} ${new URL(url).pathname}`), ['POST /repos/acme-a/app/issues']);
  assert.equal((await bash.curl(READ)).status, 200);
  assert.deepEqual(sent.slice(1).map(({ method, url }) => `${method} ${new URL(url).pathname}`),
    ['GET /repos/acme-a/app/contents/README.md', 'GET /repos/acme-a/app/moved']);
  assert.equal((await stored(deployment.store(INSTALLATION_A)))?.writes.length, 1);
});

test('bash: connectors salvaged per repository after a stale grant are gated too', async (t) => {
  const deployment = await hosted(t);
  const sent = github(t);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (/\/access_tokens$/.test(request.url)) {
      const { repositories } = await request.clone().json() as { repositories?: string[] };
      if (repositories?.length !== 1) return new Response('{}', { status: 422 });
    }
    return original(request);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  t.mock.method(console, 'warn', () => {});
  const grants: RepositoryGrant[] = [
    { ...GRANT_A, id: 'salvage_1', fullName: 'acme-a/salvage-one' },
    { ...GRANT_A, id: 'salvage_2', fullName: 'acme-a/salvage-two' },
  ];
  const bash = await agentBash(deployment.env(INSTALLATION_A), grants);
  assert.deepEqual(bash.access.grants.map(({ id }) => id), ['salvage_1', 'salvage_2'], 'salvaged per repository');
  assert.ok(bash.access.connectors.every((connector) => typeof connector.forward === 'function'));
  await deployment.store(INSTALLATION_A).setSetting(GITHUB_WRITES_KEY, spentWrites(GITHUB_WRITES_PER_WINDOW));
  assert.equal((await bash.curl(`-X POST https://api.github.com/repos/acme-a/salvage-two/issues -d '{}'`)).status, 429);
  assert.equal(sent.length, 0);
});

// --- One budget across both paths ----------------------------------------------

test('container egress and bash draw on one budget per installation', async (t) => {
  const deployment = await hosted(t, { [INSTALLATION_A]: { [GITHUB_WRITES_KEY]: spentWrites(GITHUB_WRITES_PER_WINDOW - 2) } });
  const sent = github(t);
  const push = () => new Request('https://github.com/acme-a/app.git/git-receive-pack', { method: 'POST', body: 'pack' });
  const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  assert.equal((await githubSandboxOutbound(push(), deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' })).status, 200);
  assert.equal((await bash.curl(ISSUE)).status, 200, 'the last write of the window, from bash');
  const refused = await githubSandboxOutbound(push(), deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' });
  assert.equal(refused.status, 429, 'egress sees the writes bash spent');
  assertWait(refused.headers.get('Retry-After'), GITHUB_WRITE_WINDOW_MS / 1_000);
  assert.equal((await bash.curl(ISSUE)).status, 429);
  assert.equal(sent.length, 2);

  // The other way round: egress spends, bash is refused. And B's budget is its own.
  const second = await hosted(t, { [INSTALLATION_A]: { [GITHUB_WRITES_KEY]: spentWrites(GITHUB_WRITES_PER_WINDOW - 1) } });
  const again = github(t);
  const bashA = await agentBash(second.env(INSTALLATION_A), [GRANT_A]);
  const bashB = await agentBash(second.env(INSTALLATION_B), [GRANT_B]);
  assert.equal((await githubSandboxOutbound(push(), second.egressEnv(INSTALLATION_A), { containerId: 'do_a' })).status, 200);
  assert.equal((await bashA.curl(ISSUE)).status, 429);
  assert.equal((await bashB.curl(`-X POST https://api.github.com/repos/acme-b/app/issues -d '{}'`)).status, 200);
  assert.equal((await stored(second.store(INSTALLATION_B)))?.writes.length, 1);
  assert.equal(again.length, 2);
});

// --- The secondary-limit latch -------------------------------------------------

const SHAPES: Array<{ name: string; answer: () => Response; seconds: number }> = [
  { name: '403 with retry-after', answer: () => new Response('{}', { status: 403, headers: { 'Retry-After': '120' } }), seconds: 120 },
  { name: '429 with retry-after', answer: () => new Response('{}', { status: 429, headers: { 'Retry-After': '90' } }), seconds: 90 },
  { name: '403 with the secondary-limit body', answer: () => new Response(SECONDARY_LIMIT_BODY, { status: 403 }), seconds: 60 },
  { name: '429 with the secondary-limit body', answer: () => new Response(SECONDARY_LIMIT_BODY, { status: 429 }), seconds: 60 },
];

const NOT_SECONDARY: Array<{ name: string; answer: () => Response }> = [
  { name: 'a plain 403', answer: () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 }) },
  { name: 'GitHub\'s 403 for a request without a User-Agent', answer: () => new Response('Request forbidden by administrative rules.', { status: 403 }) },
  { name: 'a 429 that names no wait', answer: () => new Response('{}', { status: 429 }) },
  {
    name: 'a primary limit',
    answer: () => new Response('{"message":"API rate limit exceeded for installation."}',
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1999999999' } }),
  },
  { name: 'a 500 with retry-after', answer: () => new Response('{}', { status: 500, headers: { 'Retry-After': '120' } }) },
  { name: 'a 200 with retry-after', answer: () => new Response('{}', { headers: { 'Retry-After': '120' } }) },
  { name: 'a 404 with the message', answer: () => new Response(SECONDARY_LIMIT_BODY, { status: 404 }) },
];

test('each secondary-limit shape, answered on bash, holds all the installation\'s requests on both paths', async (t) => {
  for (const shape of SHAPES) {
    const deployment = await hosted(t);
    let limited = true;
    const sent = github(t, () => (limited ? shape.answer() : new Response('{}')));
    const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
    const started = Date.now();
    assert.equal((await bash.curl(READ)).status, shape.answer().status, shape.name);
    const latchedUntil = (await stored(deployment.store(INSTALLATION_A)))?.latchedUntil;
    assert.ok(latchedUntil !== undefined, shape.name);
    assert.ok(latchedUntil >= started + shape.seconds * 1_000 && latchedUntil <= Date.now() + shape.seconds * 1_000, shape.name);
    limited = false;
    for (const request of [ISSUE, READ, PULL]) {
      const refused = await bash.curl(request);
      assert.equal(refused.status, 429, `${shape.name}: ${request}`);
      assertWait(refused.retryAfter, shape.seconds, `${shape.name}: ${request}`);
    }
    const egress = (request: Request) => githubSandboxOutbound(request, deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' });
    const push = new Request('https://github.com/acme-a/app.git/git-receive-pack', { method: 'POST', body: 'pack' });
    assert.equal((await egress(push)).status, 429, `${shape.name}: egress writes are held too`);
    const heldRead = await egress(new Request(READ));
    assert.equal(heldRead.status, 429, `${shape.name}: and egress reads`);
    assertWait(heldRead.headers.get('Retry-After'), shape.seconds, shape.name);
    assert.deepEqual(sent.map(({ method }) => method), ['GET'], `${shape.name}: nothing held left`);
    assert.equal((await stored(deployment.store(INSTALLATION_A)))?.writes.length, 0, 'held writes are not counted');
  }
});

test('each secondary-limit shape, answered on container egress, holds all the installation\'s requests on both paths', async (t) => {
  for (const shape of SHAPES) {
    const deployment = await hosted(t);
    let limited = true;
    const sent = github(t, () => (limited ? shape.answer() : new Response('{}')));
    const push = () => new Request('https://github.com/acme-a/app.git/git-receive-pack', { method: 'POST', body: 'pack' });
    const answered = await githubSandboxOutbound(push(), deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' });
    assert.equal(answered.status, shape.answer().status, `${shape.name}: GitHub's answer reaches the container`);
    assert.equal(await answered.text(), await shape.answer().text(), `${shape.name}: body intact`);
    assert.ok((await stored(deployment.store(INSTALLATION_A)))?.latchedUntil, shape.name);
    limited = false;
    const held = await githubSandboxOutbound(push(), deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' });
    assert.equal(held.status, 429, shape.name);
    const retryAfter = Number(held.headers.get('Retry-After'));
    assert.ok(retryAfter > shape.seconds - 5 && retryAfter <= shape.seconds, `${shape.name}: ${retryAfter}`);
    const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
    assert.equal((await bash.curl(ISSUE)).status, 429, `${shape.name}: bash writes are held too`);
    assert.equal((await bash.curl(READ)).status, 429, `${shape.name}: and bash reads`);
    assert.equal((await githubSandboxOutbound(new Request(READ), deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' })).status,
      429, `${shape.name}: and egress reads`);
    assert.deepEqual(sent.map(({ method }) => method), ['POST'], shape.name);
    // Another installation is not held.
    const bashB = await agentBash(deployment.env(INSTALLATION_B), [GRANT_B]);
    assert.equal((await bashB.curl(`-X POST https://api.github.com/repos/acme-b/app/issues -d '{}'`)).status, 200, shape.name);
  }
});

test('answers that are not a secondary limit hold nothing, on either path', async (t) => {
  for (const shape of NOT_SECONDARY) {
    const deployment = await hosted(t);
    github(t, shape.answer);
    const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
    await bash.curl(READ);
    await githubSandboxOutbound(new Request(READ), deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' });
    assert.equal(await deployment.store(INSTALLATION_A).getSetting(GITHUB_WRITES_KEY), undefined, shape.name);
  }
});

test('GitHub\'s wait is held at least a minute and at most an hour, in either Retry-After form', async () => {
  const seconds = (status: number, retryAfter: string | null, body = '') =>
    githubSecondaryLimitSeconds({ status, retryAfter, body: async () => body, now: T_FAR });
  assert.equal(await seconds(403, '5'), GITHUB_SECONDARY_LIMIT_MIN_SECONDS);
  assert.equal(await seconds(429, '0'), GITHUB_SECONDARY_LIMIT_MIN_SECONDS);
  assert.equal(await seconds(403, '61'), 61);
  assert.equal(await seconds(429, '99999'), GITHUB_SECONDARY_LIMIT_MAX_SECONDS);
  assert.equal(await seconds(403, 'soon'), GITHUB_SECONDARY_LIMIT_MIN_SECONDS, 'a wait it cannot read is a minute');
  assert.equal(await seconds(403, new Date(T_FAR + 300_000).toUTCString()), 300, 'an HTTP date, on the caller\'s clock');
  assert.equal(await seconds(403, null, SECONDARY_LIMIT_BODY), GITHUB_SECONDARY_LIMIT_MIN_SECONDS);
  assert.equal(await seconds(403, '', 'Secondary Rate Limit'), GITHUB_SECONDARY_LIMIT_MIN_SECONDS);
  assert.equal(await seconds(403, null, 'Forbidden'), undefined);
  // The body is read only when the status and a missing wait call for it.
  let reads = 0;
  const counting = async () => { reads += 1; return SECONDARY_LIMIT_BODY; };
  await githubSecondaryLimitSeconds({ status: 200, retryAfter: null, body: counting, now: T0 });
  await githubSecondaryLimitSeconds({ status: 403, retryAfter: '60', body: counting, now: T0 });
  assert.equal(reads, 0);
  assert.equal(await githubSecondaryLimitSeconds({
    status: 403, retryAfter: null, body: async () => { throw new Error('gone'); }, now: T0,
  }), undefined, 'an unreadable body is not the message');
});

test('the hold expires when its window passes, and a longer hold is kept', async (t) => {
  freshIsolate(t);
  const store = settingsStore(t);
  await latchGithubRequests({ store, installationId: INSTALLATION_A, seconds: 60, now: T0 });
  assert.deepEqual(await admitGithubWrite({ store, kind: 'write', now: T0 }), { admitted: false, retryAfterSeconds: 60 });
  assert.deepEqual(await admitGithubWrite({ store, kind: 'pull_request', now: T0 + 59_001 }),
    { admitted: false, retryAfterSeconds: 1 });
  assert.equal((await admitGithubWrite({ store, kind: 'write', now: T0 + 60_000 })).admitted, true, 'the window passed');
  assert.equal((await stored(store))?.latchedUntil, undefined, 'a passed hold is dropped');

  await latchGithubRequests({ store, installationId: INSTALLATION_A, seconds: 600, now: T0 + 60_000 });
  await latchGithubRequests({ store, installationId: INSTALLATION_A, seconds: 60, now: T0 + 61_000 });
  assert.equal((await stored(store))?.latchedUntil, T0 + 660_000, 'a shorter hold does not cut a longer one');
  assert.equal((await stored(store))?.writes.length, 1, 'holding keeps the count');
  assert.deepEqual(await admitGithubWrite({ store, kind: 'write', now: T0 + 659_500 }), { admitted: false, retryAfterSeconds: 1 });
  assert.equal((await admitGithubWrite({ store, kind: 'write', now: T0 + 660_000 })).admitted, true);
});

test('the bash gate\'s hold expires on its own clock, a dated wait included', async (t) => {
  freshIsolate(t);
  const store = settingsStore(t);
  let now = T_FAR;
  const gate = githubConnectorWriteGate({ store, installationId: INSTALLATION_A, now: () => now });
  const url = 'https://api.github.com/repos/acme-a/app/issues';
  let answer: ConnectorFetchResult = {
    status: 403, statusText: 'Forbidden', headers: { 'retry-after': new Date(T_FAR + 75_000).toUTCString() }, body: new Uint8Array(), url,
  };
  const sent: string[] = [];
  const send = async () => { sent.push(url); return answer; };
  const post = () => gate({ url, method: 'POST', headers: new Headers() }, send);
  const get = () => gate({ url, method: 'GET', headers: new Headers() }, send);
  assert.equal((await post()).status, 403);
  answer = { ...answer, status: 201, headers: {} };
  now = T_FAR + 74_000;
  const held = { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '1' }, body: new Uint8Array(), url };
  assert.deepEqual(await post(), held);
  assert.deepEqual(await get(), held, 'reads are held as long');
  now = T_FAR + 75_000;
  assert.equal((await get()).status, 201);
  assert.equal((await post()).status, 201);
  assert.equal(sent.length, 3);
});

test('reads check the hold in this isolate\'s memory, reading the state store at most once per recheck', async (t) => {
  freshIsolate(t);
  const inner = settingsStore(t);
  let reads = 0;
  const store: Store = {
    async getSetting(key) { reads += 1; return inner.getSetting(key); },
    applySettingsPatch: (patch) => inner.applySettingsPatch(patch),
  };
  let now = T0;
  const gate = githubConnectorWriteGate({ store, installationId: INSTALLATION_A, now: () => now });
  let sends = 0;
  const get = () => gate({ url: READ, method: 'GET', headers: new Headers() }, async () => {
    sends += 1;
    return { status: 200, statusText: 'OK', headers: {}, body: new Uint8Array(), url: READ };
  });
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await get()).status, 200);
    now += 100;
  }
  assert.equal(reads, 1, 'twenty reads, one state read');

  // Another isolate holds the installation: reads here learn of it at the next recheck.
  await inner.setSetting(GITHUB_WRITES_KEY, JSON.stringify({ writes: [], pullRequests: [], latchedUntil: T0 + 120_000 }));
  now = T0 + GITHUB_HOLD_RECHECK_MS - 1;
  assert.equal((await get()).status, 200, 'until the recheck, as this isolate last read it');
  now = T0 + GITHUB_HOLD_RECHECK_MS;
  assert.equal((await get()).headers['retry-after'], String(120 - GITHUB_HOLD_RECHECK_MS / 1_000));
  assert.equal(reads, 2);
  now += 60_000;
  assert.equal((await get()).status, 429);
  assert.equal(reads, 2, 'a hold this isolate knows needs no state read');
  now = T0 + 120_000;
  assert.equal((await get()).status, 200, 'the hold has passed');
  assert.equal(reads, 3);
  assert.equal(sends, 22);
});

// --- Concurrency and failure ---------------------------------------------------

/**
 * A state store where every read and patch first yields to other work, so
 * callers running together all read the row before any of them replaces it.
 */
function interleavingStore(t: TestContext) {
  const inner = settingsStore(t);
  let conflicts = 0;
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    inner,
    conflicts: () => conflicts,
    async getSetting(key: string) {
      await yieldTurn();
      return inner.getSetting(key);
    },
    async applySettingsPatch(patch: SettingsPatch) {
      await yieldTurn();
      const applied = await inner.applySettingsPatch(patch);
      if (!applied) conflicts += 1;
      return applied;
    },
  };
}

test('parallel writes admit exactly what the budget has left, however they interleave', async (t) => {
  const writes = interleavingStore(t);
  await writes.inner.setSetting(GITHUB_WRITES_KEY, JSON.stringify({
    writes: Array.from({ length: GITHUB_WRITES_PER_WINDOW - 8 }, () => T0 - 1_000), pullRequests: [],
  }));
  const admitted = await Promise.all(Array.from({ length: 20 }, () => admitGithubWrite({ store: writes, kind: 'write', now: T0 })));
  assert.equal(admitted.filter(({ admitted }) => admitted).length, 8);
  assert.ok(admitted.every((admission) => admission.admitted || admission.retryAfterSeconds === 599));
  assert.equal((await stored(writes.inner))?.writes.length, GITHUB_WRITES_PER_WINDOW, 'each admitted write counted once');
  assert.ok(writes.conflicts() > 0, 'the admissions raced');

  const pulls = interleavingStore(t);
  await pulls.inner.setSetting(GITHUB_WRITES_KEY, JSON.stringify({
    writes: [], pullRequests: Array.from({ length: GITHUB_PULL_REQUESTS_PER_WINDOW - 3 }, () => T0 - 1_000),
  }));
  const opened = await Promise.all(Array.from({ length: 10 }, () => admitGithubWrite({ store: pulls, kind: 'pull_request', now: T0 })));
  assert.equal(opened.filter(({ admitted }) => admitted).length, 3);
  assert.equal((await stored(pulls.inner))?.pullRequests.length, GITHUB_PULL_REQUESTS_PER_WINDOW);
  assert.ok(pulls.conflicts() > 0);
});

test('a hold racing admissions is never lost, and every admission after it is refused', async (t) => {
  freshIsolate(t);
  t.mock.method(console, 'warn', () => {});
  for (const position of [0, 3, 6]) {
    const store = interleavingStore(t);
    const admissions: Array<Promise<GithubAdmission>> = [];
    const started: Array<Promise<unknown>> = [];
    for (let index = 0; index <= 6; index += 1) {
      if (index === position) started.push(latchGithubRequests({ store, installationId: INSTALLATION_A, seconds: 60, now: T0 }));
      if (index < 6) {
        const admission = admitGithubWrite({ store, kind: 'write', now: T0 });
        admissions.push(admission);
        started.push(admission);
      }
    }
    await Promise.all(started);
    const results = await Promise.all(admissions);
    const row = await stored(store.inner);
    assert.equal(row?.latchedUntil, T0 + 60_000, `hold started ${position}th: stored`);
    assert.equal(results.filter(({ admitted }) => admitted).length, position, `hold started ${position}th: only earlier writes`);
    assert.equal(row?.writes.length, position, 'every admitted write counted');
    assert.ok(store.conflicts() > 0, 'the hold raced the admissions');
  }
});

test('a state store that fails during admission refuses the request before it leaves, on both paths', async (t) => {
  const deployment = await hosted(t);
  const sent = github(t);
  const bash = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  deployment.breakCounts();
  for (const request of [ISSUE, PULL, READ]) {
    const result = await bash.exec(request);
    assert.notEqual(result.exitCode, 0, `bash: ${request}`);
    assert.equal(result.stdout, '', `bash: ${request}`);
  }
  const egress = (request: Request) => githubSandboxOutbound(request, deployment.egressEnv(INSTALLATION_A), { containerId: 'do_a' });
  const push = new Request('https://github.com/acme-a/app.git/git-receive-pack', { method: 'POST', body: 'pack' });
  assert.equal((await egress(push)).status, SANDBOX_BLOCKED_STATUS);
  assert.equal((await egress(new Request(READ))).status, SANDBOX_BLOCKED_STATUS);
  assert.deepEqual(sent, [], 'nothing reached GitHub');

  // A store whose patches never land cannot count the write: it is refused, not sent.
  const racing: Store = { async getSetting() { return undefined; }, async applySettingsPatch() { return false; } };
  const gate = githubConnectorWriteGate({ store: racing, installationId: INSTALLATION_B, now: () => T0 });
  let sends = 0;
  await assert.rejects(gate({ url: 'https://api.github.com/repos/acme-b/app/issues', method: 'POST', headers: new Headers() }, async () => {
    sends += 1;
    return { status: 201, statusText: 'Created', headers: {}, body: new Uint8Array(), url: '' };
  }));
  assert.equal(sends, 0);
});

// --- The operator event --------------------------------------------------------

function capturedLogs(t: TestContext) {
  const lines: Array<{ level: string; record: Record<string, unknown> }> = [];
  for (const level of ['warn', 'error'] as const) {
    t.mock.method(console, level, (line: unknown) => {
      try { lines.push({ level, record: JSON.parse(String(line)) }); } catch { /* not a structured line */ }
    });
  }
  return lines;
}

test('two installations held within a minute raise one operator event; one, or two a minute apart, do not', async (t) => {
  freshIsolate(t);
  const lines = capturedLogs(t);
  const alerts = () => lines.filter(({ record }) => record.event === 'github_secondary_limit_installations');
  const storeA = settingsStore(t);
  const storeB = settingsStore(t);
  const storeC = settingsStore(t);

  await latchGithubRequests({ store: storeA, installationId: INSTALLATION_A, seconds: 60, now: T0 });
  await latchGithubRequests({ store: storeA, installationId: INSTALLATION_A, seconds: 60, now: T0 + 30_000 });
  assert.deepEqual(alerts(), [], 'one installation, however often');
  assert.deepEqual(lines.filter(({ record }) => record.event === 'github_requests_latched').map(({ record }) => record), [
    { component: 'hosted_github', event: 'github_requests_latched', installationId: INSTALLATION_A, retryAfterSeconds: 60 },
    { component: 'hosted_github', event: 'github_requests_latched', installationId: INSTALLATION_A, retryAfterSeconds: 60 },
  ]);

  await latchGithubRequests({ store: storeB, installationId: INSTALLATION_B, seconds: 60, now: T0 + GITHUB_LATCH_ALERT_WINDOW_MS - 1 });
  assert.deepEqual(alerts(), [{
    level: 'error',
    record: { component: 'hosted_github', event: 'github_secondary_limit_installations', installations: 2, windowSeconds: 60 },
  }]);
  await latchGithubRequests({ store: storeC, installationId: 'inst_third', seconds: 60, now: T0 + GITHUB_LATCH_ALERT_WINDOW_MS });
  assert.equal(alerts().length, 1, 'at most one event a minute');

  // A minute apart is not within a minute.
  resetGithubLatchesForTests();
  lines.length = 0;
  await latchGithubRequests({ store: storeA, installationId: INSTALLATION_A, seconds: 60, now: T0 });
  await latchGithubRequests({ store: storeB, installationId: INSTALLATION_B, seconds: 60, now: T0 + GITHUB_LATCH_ALERT_WINDOW_MS });
  assert.deepEqual(alerts(), [], 'a minute apart is not together');
  await latchGithubRequests({ store: storeC, installationId: 'inst_third', seconds: 60, now: T0 + GITHUB_LATCH_ALERT_WINDOW_MS + 1 });
  assert.equal(alerts().length, 1, 'B and C within the minute');
  assert.equal(alerts()[0]?.record.installations, 2);
});

test('the operator event comes from real answers on both paths', async (t) => {
  const deployment = await hosted(t);
  const lines = capturedLogs(t);
  github(t, () => new Response(SECONDARY_LIMIT_BODY, { status: 403 }));
  const bashA = await agentBash(deployment.env(INSTALLATION_A), [GRANT_A]);
  await bashA.curl(READ);
  await githubSandboxOutbound(new Request('https://api.github.com/repos/acme-b/app/contents/README.md'),
    deployment.egressEnv(INSTALLATION_B), { containerId: 'do_b' });
  assert.deepEqual(lines.filter(({ record }) => record.event === 'github_secondary_limit_installations').map(({ record }) => record),
    [{ component: 'hosted_github', event: 'github_secondary_limit_installations', installations: 2, windowSeconds: 60 }]);
});

test('a hold that cannot be stored is reported, and still holds this isolate\'s requests', async (t) => {
  freshIsolate(t);
  const lines = capturedLogs(t);
  const broken: Store = {
    async getSetting() { throw new Error('state store unavailable'); },
    async applySettingsPatch() { return false; },
  };
  await latchGithubRequests({ store: broken, installationId: INSTALLATION_A, seconds: 60, now: T0 });
  const racing: Store = { async getSetting() { return undefined; }, async applySettingsPatch() { return false; } };
  await latchGithubRequests({ store: racing, installationId: INSTALLATION_A, seconds: 60, now: T0 });
  assert.equal(lines.filter(({ record }) => record.event === 'github_requests_latch_failed').length, 2);
  for (const effect of ['read', 'write', 'pull_request'] as const) {
    assert.deepEqual(await admitGithubRequest({ store: broken, installationId: INSTALLATION_A, effect, now: T0 + 1_000 }),
      { admitted: false, retryAfterSeconds: 59 }, effect);
  }
  // A shorter hold does not cut a longer one this isolate holds.
  await latchGithubRequests({ store: racing, installationId: INSTALLATION_B, seconds: 600, now: T0 });
  await latchGithubRequests({ store: racing, installationId: INSTALLATION_B, seconds: 60, now: T0 + 1_000 });
  assert.deepEqual(await admitGithubRequest({ store: racing, installationId: INSTALLATION_B, effect: 'read', now: T0 + 120_000 }),
    { admitted: false, retryAfterSeconds: 480 });
});

// --- Mints and standalone ------------------------------------------------------

test('a rate-limited mint is not retried, per repository or otherwise', async (t) => {
  await hosted(t);
  const mints: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    mints.push(url);
    return new Response(SECONDARY_LIMIT_BODY, { status: 403, headers: { 'Retry-After': '60' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const env = scopeInstallationEnv({ ...HOSTED, TAG_STATE: tagState(() => settingsStore(t)) } as Record<string, unknown>,
    { installationId: INSTALLATION_A });
  const grants: RepositoryGrant[] = [
    { ...GRANT_A, id: 'mint_1', fullName: 'acme-a/mint-one' },
    { ...GRANT_A, id: 'mint_2', fullName: 'acme-a/mint-two' },
  ];
  t.mock.method(console, 'warn', () => {});
  const access = await resolveRepositoryAccess(grants, env as never);
  assert.deepEqual(access.connectors, []);
  assert.equal(mints.length, 1, 'one mint, no salvage');
});

test('standalone: bash connectors carry no gate, writes are not counted and GitHub\'s limits hold nothing', async (t) => {
  const store = settingsStore(t);
  const TAG_STATE = tagState(() => store);
  onCloudflare(t);
  freshIsolate(t);
  let answer = () => new Response('{}');
  const sent = github(t, () => answer());
  await withEnv({ GITHUB_APP_ID: 'standalone-app-77', GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY, CHICKPEA_TENANCY: undefined }, async () => {
    const env = { TAG_STATE };
    const access = await resolveRepositoryAccess([GRANT_A], env as never);
    assert.ok(access.connectors.length > 0);
    assert.ok(access.connectors.every((connector) => connector.forward === undefined), 'no gate');
    const sandbox = await createConnectorScopedBash(DEFAULT_EGRESS_POLICY, true, access.connectors).createSandbox({} as never);
    for (let index = 0; index <= GITHUB_WRITES_PER_WINDOW; index += 1) {
      const result = await sandbox.exec(`curl -sS -o /dev/null -w '%{http_code}' ${ISSUE}`);
      assert.equal(result.stdout, '200');
    }
    answer = () => new Response(SECONDARY_LIMIT_BODY, { status: 403, headers: { 'Retry-After': '60' } });
    assert.equal((await sandbox.exec(`curl -sS -o /dev/null -w '%{http_code}' ${READ}`)).stdout, '403');
    const before = sent.length;
    answer = () => (sent.length === before + 1
      ? new Response(null, { status: 307, headers: { Location: 'https://api.github.com/repos/acme-a/app/issues/moved' } })
      : new Response('{}'));
    assert.equal((await sandbox.exec(`curl -sS -o /dev/null -w '%{http_code}' ${ISSUE}`)).stdout, '200', 'redirects followed as before');
    assert.deepEqual(sent.slice(before).map(({ method, url }) => `${method} ${new URL(url).pathname}`),
      ['POST /repos/acme-a/app/issues', 'POST /repos/acme-a/app/issues/moved']);

    const egress = egressEnv({ TAG_STATE }, { turnId: 'turn_1', policy: { grants: [GRANT_A], mode: 'app' } });
    answer = () => new Response(SECONDARY_LIMIT_BODY, { status: 429, headers: { 'Retry-After': '60' } });
    const push = () => new Request('https://github.com/acme-a/app.git/git-receive-pack', { method: 'POST', body: 'pack' });
    assert.equal((await githubSandboxOutbound(push(), egress, { containerId: 'do_1' })).status, 429);
    answer = () => new Response('{}');
    assert.equal((await githubSandboxOutbound(push(), egress, { containerId: 'do_1' })).status, 200, 'GitHub\'s answer, not a hold');
  });
  assert.equal(await store.getSetting(GITHUB_WRITES_KEY), undefined, 'nothing counted or held');
});
