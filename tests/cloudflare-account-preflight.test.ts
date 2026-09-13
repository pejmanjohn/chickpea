import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// @ts-expect-error Deployment tooling JavaScript helper.
import { preflightCloudflareAccount, assertCloudflareAccountConfig } from '../scripts/lib/cloudflare-account-preflight.mjs';

const ACCOUNT = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const SECRET = 'private-test-credential';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(config: Record<string, unknown> = {}) {
  const commands: string[][] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const options = {
    runnerRoot: ROOT, projectRoot: ROOT, configPath: path.join(ROOT, 'wrangler.jsonc'), env: {},
    providerContext: ['--profile', 'chosen', '--env', 'staging'],
    readConfig: () => config,
    runWrangler: (args: string[]) => {
      commands.push(args);
      return { status: 0, stdout: JSON.stringify(args[0] === 'whoami'
        ? { accounts: [{ id: ACCOUNT }] } : { type: 'oauth', token: SECRET }) };
    },
    fetchImpl: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ success: true, result: { subdomain: 'chosen-subdomain' } });
    },
  };
  return { options, commands, requests };
}

test('account preflight uses supported Wrangler auth and exactly the selected provider context', async () => {
  const f = fixture({ account_id: ACCOUNT });
  assert.deepEqual(await preflightCloudflareAccount(f.options), { accountId: ACCOUNT, workersDev: true });
  assert.deepEqual(f.commands, [
    ['auth', 'token', '--json', '--profile', 'chosen', '--env', 'staging'],
  ]);
  assert.equal(f.requests[0]!.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain`);
  assert.equal(f.requests[0]!.init.method, 'GET');
  assert.equal(f.requests[0]!.init.redirect, 'error');
  assert.ok(f.requests[0]!.init.signal);
  assert.deepEqual(f.requests[0]!.init.headers, { Authorization: `Bearer ${SECRET}` });
});

test('a named profile requires an explicit account instead of unsupported whoami discovery', async () => {
  const f = fixture();
  await assert.rejects(preflightCloudflareAccount(f.options), /CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED.*CLOUDFLARE_ACCOUNT_ID/);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.requests, []);
});

test('the active profile can discover one account without a named-profile override', async () => {
  const f = fixture();
  f.options.providerContext = ['--env', 'staging'];
  assert.equal((await preflightCloudflareAccount(f.options)).accountId, ACCOUNT);
  assert.deepEqual(f.commands, [
    ['whoami', '--json', '--env', 'staging'],
    ['auth', 'token', '--json', '--env', 'staging'],
  ]);
});

test('effective workers.dev disabled and custom-route defaults need no account authentication', async () => {
  for (const config of [{ workers_dev: false }, { routes: ['example.test/*'] }, { route: 'example.test/*' }]) {
    const f = fixture(config);
    assert.equal((await preflightCloudflareAccount(f.options)).workersDev, false);
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.requests, []);
  }
});

test('account selection refuses conflicting or ambiguous identities before network access', async () => {
  const f = fixture({ account_id: ACCOUNT });
  for (const extra of [{ env: { CLOUDFLARE_ACCOUNT_ID: OTHER } }, { expectedAccount: OTHER },
    { env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CF_ACCOUNT_ID: OTHER } }]) {
    await assert.rejects(preflightCloudflareAccount({ ...f.options, ...extra }), /CLOUDFLARE_ACCOUNT_CONFLICT/);
  }
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.requests, []);
  const g = fixture();
  g.options.providerContext = [];
  await assert.rejects(preflightCloudflareAccount({ ...g.options,
    runWrangler: () => ({ status: 0, stdout: JSON.stringify({ accounts: [{ id: ACCOUNT }, { id: OTHER }] }) }),
  }), /CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED/);
  assert.deepEqual(g.requests, []);
});

test('explicit config account is used without choosing an account from whoami', async () => {
  const f = fixture({ account_id: OTHER });
  assert.equal((await preflightCloudflareAccount(f.options)).accountId, OTHER);
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0]![0], 'auth');
  assert.ok(f.requests[0]!.url.includes(OTHER));
});

test('only endpoint-specific missing-subdomain evidence gives registration guidance', async () => {
  const f = fixture({ account_id: ACCOUNT });
  for (const status of [400, 404]) {
    await assert.rejects(preflightCloudflareAccount({ ...f.options,
      fetchImpl: async () => Response.json({ success: false, errors: [{ code: 10007, message: SECRET }] }, { status }),
    }), (error: Error) => {
      assert.match(error.message, /CLOUDFLARE_SUBDOMAIN_MISSING/);
      assert.ok(error.message.includes(`https://dash.cloudflare.com/${ACCOUNT}/workers-and-pages`));
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      assert.match(error.message, /same npm run deploy/);
      return true;
    });
  }
  for (const response of [Response.json({}, { status: 404 }), Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 500 }),
    new Response('not-json'), Response.json({ success: true, result: {} }), new Response(SECRET, { status: 302 }),
    new Response('x'.repeat(65537))]) {
    await assert.rejects(preflightCloudflareAccount({ ...f.options, fetchImpl: async () => response }), /CLOUDFLARE_SUBDOMAIN_UNKNOWN/);
  }
});

test('auth and network failures remain distinct and never expose provider output', async () => {
  const f = fixture({ account_id: ACCOUNT });
  for (const status of [401, 403]) {
    await assert.rejects(preflightCloudflareAccount({ ...f.options,
      fetchImpl: async () => new Response(SECRET, { status }),
    }), /CLOUDFLARE_ACCOUNT_ACCESS_DENIED/);
  }
  for (const extra of [
    { fetchImpl: async () => { throw new Error(SECRET); } },
    { runWrangler: () => ({ status: 1, stdout: SECRET, stderr: SECRET }) },
    { runWrangler: () => ({ status: 0, stdout: SECRET }) },
  ]) {
    await assert.rejects(preflightCloudflareAccount({ ...f.options, ...extra }), (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      assert.match(error.message, /CLOUDFLARE_(AUTH_UNAVAILABLE|SUBDOMAIN_UNKNOWN)/);
      return true;
    });
  }
});

test('real Wrangler JSONC resolution respects the selected environment and ignores stale build redirects', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-account-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'wrangler.jsonc');
  mkdirSync(path.join(directory, '.wrangler/deploy'), { recursive: true });
  writeFileSync(path.join(directory, '.wrangler/deploy/config.json'), JSON.stringify({ configPath: '../../stale.json' }));
  writeFileSync(path.join(directory, 'stale.json'), JSON.stringify({ name: 'stale', account_id: ACCOUNT, workers_dev: false }));
  writeFileSync(configPath, `{
    // Account selection belongs to the chosen environment.
    "name": "test-worker", "compatibility_date": "2026-08-20", "account_id": "${ACCOUNT}",
    "env": { "staging": { "account_id": "${OTHER}", "workers_dev": true, }, },
  }`);
  const f = fixture();
  const { readConfig, ...options } = f.options;
  assert.equal((await preflightCloudflareAccount({ ...options, configPath })).accountId, OTHER);
  assert.ok(f.requests[0]!.url.includes(OTHER));
  assertCloudflareAccountConfig({ ...options, configPath }, { accountId: OTHER, workersDev: true });
  assert.throws(() => assertCloudflareAccountConfig({ ...options, configPath }, { accountId: ACCOUNT, workersDev: true }), /CLOUDFLARE_ACCOUNT_CHANGED/);
});
