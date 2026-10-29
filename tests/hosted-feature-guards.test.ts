import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { browserCapabilityForTurn } from '../src/browser/capability.ts';
import { BROWSER_ENV_VARS } from '../src/browser/settings.ts';
import {
  connectionAccountSecretEnvVar,
  connectorCredentialBindingEnvVar,
  connectorCredentialEnvVar,
  describeConnectorCredentialSource,
  resolveConnectionAccountSecret,
  resolveConnectorCredential,
  saveConnectionAccountSecret,
  saveConnectorCredential,
} from '../src/config/connector-secrets.ts';
import { configureHostedBrowser, resetHostedBrowserForTests } from '../src/config/hosted-browser.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  describeMcpSecretSources,
  mcpBearerEnvVar,
  mcpCredentialBindingEnvVar,
  mcpHeaderEnvVar,
  resolveMcpSecrets,
  saveMcpSecrets,
} from '../src/config/mcp-secrets.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { withEnv } from './helpers/env.ts';

/**
 * Features a deployment serving many installations must not share across
 * them: a deployment variable never answers for one installation's
 * connection credentials, and the browser is offered only through the
 * host's port, never through a key an installation stores.
 */

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const ENV_A = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_guard_a' });
const ENV_B = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_guard_b' });
// Agent and connection IDs are local to an installation, so both have the same ones.
const ACCOUNT = { secretRefId: 'secret_shared' };
const CONNECTOR = {
  agentId: 'agent_shared', connectionId: 'crm',
  credentialRef: 'connection_11111111111111111111111111111111', credentialBinding: 'test:crm',
};
const MCP = {
  agentId: 'agent_shared', connectionId: 'docs',
  credentialRef: 'connection_22222222222222222222222222222222', credentialBinding: 'test:docs',
};
const DEPLOYMENT_VARIABLES = {
  CHICKPEA_TENANCY: undefined,
  [connectionAccountSecretEnvVar(ACCOUNT.secretRefId)]: 'deployment-account-secret',
  [connectorCredentialEnvVar(CONNECTOR)]: 'deployment-connector-secret',
  [connectorCredentialBindingEnvVar(CONNECTOR)]: CONNECTOR.credentialBinding,
  [mcpBearerEnvVar(MCP)]: 'deployment-mcp-bearer',
  [mcpCredentialBindingEnvVar(MCP)]: MCP.credentialBinding,
  [mcpHeaderEnvVar(MCP, 'X-Team')]: 'deployment-mcp-header',
};

test('under tenancy a deployment variable never answers for an installation\'s connection credentials', async (t) => {
  const settingsA = new SqliteSettingsStore(':memory:');
  const settingsB = new SqliteSettingsStore(':memory:');
  t.after(() => { settingsA.close(); settingsB.close(); });
  await saveConnectionAccountSecret(ACCOUNT.secretRefId, 'a-account-secret', ENV_A, settingsA);
  await saveConnectorCredential(CONNECTOR, 'a-connector-secret', ENV_A, settingsA);
  await saveMcpSecrets(MCP, { bearerToken: 'a-mcp-bearer', headers: { 'X-Team': 'a-mcp-header' } }, ENV_A, settingsA);

  await withEnv(DEPLOYMENT_VARIABLES, async () => {
    // A's own settings answer; B, with none, gets nothing rather than the deployment's.
    assert.equal(await resolveConnectionAccountSecret(ACCOUNT, ENV_A, settingsA), 'a-account-secret');
    assert.equal(await resolveConnectionAccountSecret(ACCOUNT, ENV_B, settingsB), undefined);
    assert.equal(await resolveConnectorCredential(CONNECTOR, ENV_A, settingsA), 'a-connector-secret');
    assert.equal(await resolveConnectorCredential(CONNECTOR, ENV_B, settingsB), undefined);
    assert.equal(await describeConnectorCredentialSource(CONNECTOR, ENV_A, settingsA), 'stored');
    assert.equal(await describeConnectorCredentialSource(CONNECTOR, ENV_B, settingsB), 'missing');
    assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], ENV_A, settingsA),
      { bearer: 'a-mcp-bearer', headers: { 'X-Team': 'a-mcp-header' } });
    assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], ENV_B, settingsB), { headers: {} });
    assert.deepEqual(await describeMcpSecretSources(MCP, ['X-Team'], ENV_B, settingsB),
      { bearer: 'missing', headers: { 'X-Team': 'missing' } });

    // A caller that passes no env still gets the deployment's own tenancy.
    await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
      assert.equal(await resolveConnectionAccountSecret(ACCOUNT, undefined, settingsB), undefined);
      assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], undefined, settingsB), { headers: {} });
    });
  });
});

test('standalone still reads the deployment variable first, as before', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await saveConnectionAccountSecret(ACCOUNT.secretRefId, 'stored-account-secret', undefined, settings);
  await saveConnectorCredential(CONNECTOR, 'stored-connector-secret', undefined, settings);
  await saveMcpSecrets(MCP, { bearerToken: 'stored-mcp-bearer' }, undefined, settings);
  await withEnv(DEPLOYMENT_VARIABLES, async () => {
    assert.equal(await resolveConnectionAccountSecret(ACCOUNT, undefined, settings), 'deployment-account-secret');
    assert.equal(await resolveConnectorCredential(CONNECTOR, undefined, settings), 'deployment-connector-secret');
    assert.equal(await describeConnectorCredentialSource(CONNECTOR, undefined, settings), 'env');
    assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], undefined, settings),
      { bearer: 'deployment-mcp-bearer', headers: { 'X-Team': 'deployment-mcp-header' } });
    assert.deepEqual(await describeMcpSecretSources(MCP, ['X-Team'], undefined, settings),
      { bearer: 'env', headers: { 'X-Team': 'env' } });
  });
});

/** Stores that fail any read, so a response proves where the request stopped. */
function untouchable<T extends object>(): T {
  return new Proxy({} as T, { get(_target, property) {
    if (property === 'then') return undefined;
    throw new Error(`store read: ${String(property)}`);
  } });
}

const BROWSER_KEY_ROUTES: Array<[string, string]> = [
  ['GET', '/admin/api/browser/status'], ['PUT', '/admin/api/browser/key'], ['DELETE', '/admin/api/browser/key'],
];
const WEBSITE_LOGIN_ROUTES: Array<[string, string]> = [
  ['GET', '/admin/api/agents/agent_shared/website-logins'], ['POST', '/admin/api/agents/agent_shared/website-logins'],
  ['PATCH', '/admin/api/agents/agent_shared/website-logins/login_1'],
  ['DELETE', '/admin/api/agents/agent_shared/website-logins/login_1'],
];
const BROWSER_ROUTES = [...BROWSER_KEY_ROUTES, ...WEBSITE_LOGIN_ROUTES];
const ROUTE_VARIANTS = (path: string) => [
  path, path.replace('/admin/api/', '/admin//api/'), `${path}/`,
  path.replace('/browser/', '/%62rowser/').replace('/website-logins', '/%77ebsite-logins'),
];
const BROWSER_POLICY = { enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 };

function hostedBrowser(t: TestContext, enabled: boolean): void {
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({ policy: () => ({ ...BROWSER_POLICY, enabled }), access: () => ({ apiKey: 'bb_live_platform', projectId: 'proj' }) });
}

test('under tenancy Admin\'s browser key routes, and website-login routes without the host\'s browser, are not found, before any store is read', async (t) => {
  t.mock.method(console, 'error', () => {});
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  const routes = createAdminRoutes({ identity: untouchable(), store: untouchable(), settings: untouchable() });
  for (const [method, path] of BROWSER_ROUTES) {
    for (const variant of new Set(ROUTE_VARIANTS(path))) {
      const response = await routes.request(`https://hosted.example${variant}`, { method }, ENV_A);
      assert.equal(response.status, 404, `no port: ${method} ${variant}`);
    }
  }
  // An Agent's other routes, and standalone's browser routes, get past the guard.
  assert.equal((await routes.request('https://hosted.example/admin/api/agents/agent_shared', {}, ENV_A)).status, 500);
  for (const [method, path] of BROWSER_ROUTES) {
    assert.equal((await routes.request(`http://localhost${path}`, { method })).status, 500, `standalone ${method} ${path}`);
  }
});

test('with the host\'s browser off, saved website logins can still be listed and removed, never added or changed', async (t) => {
  t.mock.method(console, 'error', () => {});
  hostedBrowser(t, false);
  const routes = createAdminRoutes({ identity: untouchable(), store: untouchable(), settings: untouchable() });
  for (const [method, path] of WEBSITE_LOGIN_ROUTES) {
    const served = method === 'GET' || method === 'DELETE';
    for (const variant of new Set(ROUTE_VARIANTS(path))) {
      const response = await routes.request(`https://hosted.example${variant}`, { method }, ENV_A);
      assert.equal(response.status, served ? 500 : 404, `${method} ${variant} ${served ? 'reaches the store' : 'is not found'}`);
    }
  }
  for (const [method, path] of BROWSER_KEY_ROUTES) {
    for (const variant of new Set(ROUTE_VARIANTS(path))) {
      assert.equal((await routes.request(`https://hosted.example${variant}`, { method }, ENV_A)).status, 404, `${method} ${variant}`);
    }
  }
});

test('with the host\'s browser on, hosted website-login routes get past the guard, and the browser key routes stay not found', async (t) => {
  t.mock.method(console, 'error', () => {});
  hostedBrowser(t, true);
  const routes = createAdminRoutes({ identity: untouchable(), store: untouchable(), settings: untouchable() });
  for (const [method, path] of WEBSITE_LOGIN_ROUTES) {
    for (const variant of new Set(ROUTE_VARIANTS(path))) {
      const response = await routes.request(`https://hosted.example${variant}`, { method }, ENV_A);
      assert.equal(response.status, 500, `${method} ${variant} reaches the store`);
    }
  }
  for (const [method, path] of BROWSER_KEY_ROUTES) {
    for (const variant of new Set(ROUTE_VARIANTS(path))) {
      assert.equal((await routes.request(`https://hosted.example${variant}`, { method }, ENV_A)).status, 404, `${method} ${variant}`);
    }
  }
});

test('under tenancy the coding sandbox install, uninstall and settings routes are not found, before any store is read; its status stays served', async (t) => {
  t.mock.method(console, 'error', () => {});
  const routes = createAdminRoutes({ identity: untouchable(), store: untouchable(), settings: untouchable() });
  const install = '/admin/api/sandbox/install';
  for (const method of ['POST', 'DELETE']) {
    for (const variant of [install, '/admin//api/sandbox/install', `${install}/`, '/admin/api/sandbox/%69nstall']) {
      const response = await routes.request(`https://hosted.example${variant}`, { method }, ENV_A);
      assert.equal(response.status, 404, `${method} ${variant}`);
    }
    assert.equal((await routes.request(`http://localhost${install}`, { method })).status, 500, `standalone ${method}`);
  }
  // The host's policy owns a hosted sandbox's settings; its status stays
  // readable for an operator, so only GET gets past the guard (to the store,
  // which fails here).
  const status = '/admin/api/sandbox/status';
  for (const method of ['PUT', 'PATCH']) {
    for (const variant of [status, '/admin//api/sandbox/status', `${status}/`, '/admin/api/sandbox/%73tatus']) {
      const response = await routes.request(`https://hosted.example${variant}`, { method }, ENV_A);
      assert.equal(response.status, 404, `hosted ${method} ${variant}`);
    }
    assert.equal((await routes.request(`http://localhost${status}`, { method })).status, 500, `standalone ${method} status`);
  }
  assert.equal((await routes.request(`https://hosted.example${status}`, {}, ENV_A)).status, 500, 'hosted GET status');
});

test('the retired Outbound access route is not found in either mode, and its setting is neither read nor written', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  t.after(() => { settings.close(); store.close(); });
  const routes = createAdminRoutes({ store, settings, ...testAdminAuthority('egress-retired-token') });
  const headers = { ...testAdminHeaders('egress-retired-token'), 'content-type': 'application/json' };
  const reads = t.mock.method(settings, 'getSetting');
  const writes = t.mock.method(settings, 'setSetting');
  for (const [mode, env] of [['standalone', undefined], ['hosted', ENV_A]] as const) {
    for (const method of ['GET', 'PUT']) {
      const response = await routes.request('http://localhost/admin/api/egress', {
        method,
        headers,
        ...(method === 'PUT' ? { body: JSON.stringify({ mode: 'open', domains: ['api.example.com'] }) } : {}),
      }, env);
      assert.equal(response.status, 404, `${mode} ${method}`);
    }
  }
  const policyKey = ({ arguments: [key] }: { arguments: unknown[] }) => key === 'egress.policy';
  assert.equal(reads.mock.calls.filter(policyKey).length, 0, 'no policy is read');
  assert.equal(writes.mock.calls.filter(policyKey).length, 0, 'no policy is written');
});

test('under tenancy no turn or occurrence is offered the browser, even with a deployment Browserbase key', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const key = { [BROWSER_ENV_VARS.apiKey]: 'bb_live_deployment_key_0000000000' };
  assert.equal(await browserCapabilityForTurn(settings, { ...ENV_A, ...key }), undefined);
  assert.equal(await browserCapabilityForTurn(settings, scopeInstallationEnv({ ...HOSTED, ...key }, { installationId: 'inst_guard_a' })), undefined);
  assert.deepEqual(await browserCapabilityForTurn(settings, key), { provider: 'browserbase' }, 'standalone is unchanged');
});

test('the hosted Admin page tells its client browser setup is not offered, website logins only with the host\'s browser on, and the deployment is not self-hosted; standalone\'s says all are', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  t.after(() => { settings.close(); store.close(); });
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  const routes = createAdminRoutes({ store, settings, ...testAdminAuthority('feature-guard-token') });
  const page = async (env?: Record<string, unknown>) => (await routes.request('http://localhost/admin', {
    headers: testAdminHeaders('feature-guard-token'),
  }, env)).text();
  const hosted = await page(ENV_A);
  const standalone = await page();
  assert.match(hosted, /"browserSetupOffered":false,"websiteLoginsOffered":false,"websiteLoginsRemoveOnly":false/);
  assert.match(standalone, /"browserSetupOffered":true,"websiteLoginsOffered":true,"websiteLoginsRemoveOnly":false/);
  assert.match(hosted, /"selfHosted":false/);
  assert.match(standalone, /"selfHosted":true/);
  hostedBrowser(t, false);
  assert.match(await page(ENV_A), /"websiteLoginsOffered":false,"websiteLoginsRemoveOnly":true/, 'the host\'s browser is off');
  hostedBrowser(t, true);
  assert.match(await page(ENV_A), /"browserSetupOffered":false,"websiteLoginsOffered":true,"websiteLoginsRemoveOnly":false/);
});
