import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { FakeDeployment, fakeBrowser, SCOPE } from './helpers/fake-deployment.ts';
import { runCli, temporaryStore } from './helpers/run-cli.ts';

const clock = { now: Date.parse('2026-09-04T12:00:00.000Z') };
const now = () => clock.now;
const deployment = new FakeDeployment({ accessTokenTtlSeconds: 1200, now });

before(() => deployment.start());
after(() => deployment.stop());

test('login registers a public PKCE client, exchanges the code, and stores tokens with mode 0600', async () => {
  const store = temporaryStore();
  let authorizationUrl = '';
  const result = await runCli(['login', deployment.url], {
    store,
    now,
    openBrowser: fakeBrowser,
    onAuthorizationUrl: (url) => { authorizationUrl = url; },
    loginTimeoutMs: 10_000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Signed in to http:\/\/127\.0\.0\.1:\d+\. Session saved to .*credentials\.json \(mode 0600\)\.\n$/);
  assert.match(result.stderr, /Opening your browser/);

  // Registration shape matches what the deployment accepts (tests/management-oauth.test.ts).
  const registration = deployment.registrations.at(-1)!;
  assert.equal(registration.token_endpoint_auth_method, 'none');
  assert.equal(registration.application_type, 'native');
  assert.equal(registration.client_name, 'Chickpea CLI');
  assert.deepEqual(registration.response_types, ['code']);
  assert.deepEqual(registration.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(registration.scope, SCOPE);
  const redirects = registration.redirect_uris as string[];
  assert.equal(redirects.length, 1);
  assert.match(redirects[0]!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  // Authorization request: PKCE S256, resource-bound, scoped, with state.
  const authorize = deployment.authorizeRequests.at(-1)!;
  assert.equal(authorize.get('code_challenge_method'), 'S256');
  assert.equal(authorize.get('resource'), `${deployment.url}/mcp`);
  assert.equal(authorize.get('scope'), SCOPE);
  assert.ok(authorize.get('state'));
  assert.ok(authorizationUrl.startsWith(`${deployment.url}/api/auth/oauth2/authorize?`));

  // Code exchange carried the verifier and the public client id, no secret.
  const exchange = deployment.tokenRequests.at(-1)!;
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.ok(exchange.get('code_verifier'));
  assert.equal(exchange.get('client_id'), registration.client_id ?? deployment.registrations.at(-1)!.client_id ?? exchange.get('client_id'));
  assert.equal(exchange.get('client_secret'), null);

  // Stored keyed by origin, 0600, with an absolute expiry derived from expires_in.
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(store.path, 'utf8')) as { deployments: Record<string, { tokens: { expires_at: number; refresh_token: string }; client: { client_id: string } }> };
  const entry = file.deployments[deployment.url]!;
  assert.equal(entry.tokens.expires_at, clock.now + 1200 * 1_000);
  assert.ok(entry.tokens.refresh_token);
  assert.ok(entry.client.client_id.startsWith('client_'));

  // Nothing secret reached the terminal.
  const printed = result.stdout + result.stderr;
  assert.doesNotMatch(printed, /at_|rt_|code=/);

  // The session works for an authenticated command.
  const inspect = await runCli(['workspace', 'inspect', deployment.url, '--json'], { store, now });
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).organizationId, 'org_test');
  assert.equal(deployment.refreshCount, 0);
});

test('an expired access token is refreshed silently before the call, and rotated tokens are saved', async () => {
  const store = temporaryStore();
  const login = await runCli(['login', deployment.url], { store, now, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
  const before = store.read(deployment.url)!.tokens!;
  const refreshesBefore = deployment.refreshCount;

  clock.now += 1201 * 1_000;
  const list = await runCli(['tools', 'list', deployment.url], { store, now });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /inspect_workspace\s+\[read-only\] Fake inspect_workspace\.\n/);
  assert.equal(deployment.refreshCount, refreshesBefore + 1);
  const refresh = deployment.tokenRequests.at(-1)!;
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('refresh_token'), before.refresh_token);
  const after = store.read(deployment.url)!.tokens!;
  assert.notEqual(after.access_token, before.access_token);
  assert.notEqual(after.refresh_token, before.refresh_token);
  assert.equal(after.expires_at, clock.now + 1200 * 1_000);
});

test('a token the server rejects early is refreshed on the 401 and the call is retried', async () => {
  const store = temporaryStore();
  const login = await runCli(['login', deployment.url], { store, now, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
  const refreshesBefore = deployment.refreshCount;
  deployment.invalidateAccessTokens();
  const inspect = await runCli(['workspace', 'inspect', deployment.url], { store, now });
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /^Workspace org_test/);
  assert.equal(deployment.refreshCount, refreshesBefore + 1);
});

test('logout revokes the refresh token with the public client id and deletes the entry', async () => {
  const store = temporaryStore();
  const login = await runCli(['login', deployment.url], { store, now, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
  const entry = store.read(deployment.url)!;
  const logout = await runCli(['logout', deployment.url], { store, now });
  assert.equal(logout.code, 0, logout.stderr);
  assert.equal(logout.stdout, `Revoked and removed the session for ${deployment.url}.\n`);
  const revocations = deployment.revocations.slice(-2);
  assert.equal(revocations[0]!.get('token'), entry.tokens!.refresh_token);
  assert.equal(revocations[0]!.get('token_type_hint'), 'refresh_token');
  assert.equal(revocations[0]!.get('client_id'), entry.client!.client_id);
  assert.equal(revocations[1]!.get('token_type_hint'), 'access_token');
  assert.equal(store.read(deployment.url), undefined);

  const afterLogout = await runCli(['workspace', 'inspect', deployment.url], { store, now });
  assert.equal(afterLogout.code, 1);
  assert.equal(afterLogout.stderr, `chickpea: NOT_LOGGED_IN: No saved session for ${deployment.url}. Sign in with: chickpea login ${deployment.url}.\n`);

  // The refresh token is dead server-side: a stale copy cannot be refreshed.
  store.write(entry);
  clock.now += 1201 * 1_000;
  const stale = await runCli(['workspace', 'inspect', deployment.url], { store, now });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /SESSION_EXPIRED/);
  assert.doesNotMatch(stale.stderr, /rt_|at_/);
});

test('login against a deployment that has not finished setup fails with a stable code', async () => {
  const incomplete = new FakeDeployment({ mode: 'setup-incomplete' });
  await incomplete.start();
  try {
    const result = await runCli(['login', incomplete.url], { store: temporaryStore(), now, openBrowser: fakeBrowser, loginTimeoutMs: 5_000 });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `chickpea: SETUP_INCOMPLETE: ${incomplete.url} has not finished setup. Open its private setup link, complete Slack setup, then sign in again.\n`);
    assert.equal(incomplete.registrations.length, 0);
  } finally {
    await incomplete.stop();
  }
});

test('login refuses a URL that is not the canonical origin before registering anything', async () => {
  const other = new FakeDeployment({ mode: 'wrong-origin' });
  await other.start();
  try {
    const result = await runCli(['login', other.url], { store: temporaryStore(), now, openBrowser: fakeBrowser, loginTimeoutMs: 5_000 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^chickpea: WRONG_ORIGIN: .*https:\/\/other\.example\/mcp/);
    assert.equal(other.registrations.length, 0);
  } finally {
    await other.stop();
  }
});

test('login times out when no authorization response arrives', async () => {
  const result = await runCli(['login', deployment.url, '--quiet'], {
    store: temporaryStore(),
    now,
    openBrowser: async () => undefined,
    loginTimeoutMs: 200,
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'chickpea: LOGIN_TIMEOUT: No authorization response arrived from the browser. Retry and finish the Slack sign-in and consent screens.\n');
});
