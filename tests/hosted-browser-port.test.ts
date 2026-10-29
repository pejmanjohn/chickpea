import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import {
  configureHostedBrowser,
  HOSTED_BROWSER_POLICY_OFF,
  hostedBrowserAccess,
  hostedBrowserConfigured,
  hostedBrowserPolicy,
  parseHostedBrowserPolicy,
  resetHostedBrowserForTests,
  type HostedBrowserPort,
} from '../src/config/hosted-browser.ts';

const POLICY = { enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 };

function install(t: TestContext, port: Partial<HostedBrowserPort>): void {
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({
    policy: () => POLICY,
    access: () => ({ apiKey: 'bb_live_platform', projectId: 'proj-platform' }),
    ...port,
  });
}

function quietly(t: TestContext): string[] {
  const logged: string[] = [];
  t.mock.method(console, 'error', (line: string) => { logged.push(line); });
  return logged;
}

test('with no port the browser is off and has no access', (t) => {
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  assert.equal(hostedBrowserConfigured(), false);
  assert.deepEqual(hostedBrowserPolicy(), HOSTED_BROWSER_POLICY_OFF);
  assert.equal(hostedBrowserAccess(), undefined);
});

test('a configured port answers its policy and access on every read', (t) => {
  let enabled = true;
  install(t, { policy: () => ({ ...POLICY, enabled }) });
  assert.equal(hostedBrowserConfigured(), true);
  assert.deepEqual(hostedBrowserPolicy(), POLICY);
  enabled = false;
  assert.equal(hostedBrowserPolicy().enabled, false, 'the policy is read again, not cached');
  assert.deepEqual(hostedBrowserAccess(), { apiKey: 'bb_live_platform', projectId: 'proj-platform' });
});

test('the policy parser takes only a complete policy, and fails closed to off', (t) => {
  assert.deepEqual(parseHostedBrowserPolicy(POLICY), POLICY);
  assert.deepEqual(parseHostedBrowserPolicy({ ...POLICY, monthlyBrowserHours: 0.5 }), { ...POLICY, monthlyBrowserHours: 0.5 });
  for (const invalid of [
    undefined, null, 'on', [],
    { ...POLICY, enabled: 'true' },
    { ...POLICY, monthlyBrowserHours: 0 },
    { ...POLICY, monthlyBrowserHours: Number.POSITIVE_INFINITY },
    { ...POLICY, maxRunningBrowsers: 0 },
    { ...POLICY, maxRunningBrowsers: 1.5 },
    { ...POLICY, sessionsPerMinute: -1 },
    { enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2 },
  ]) {
    assert.equal(parseHostedBrowserPolicy(invalid), undefined, JSON.stringify(invalid));
  }
  const logged = quietly(t);
  install(t, { policy: () => ({ ...POLICY, sessionsPerMinute: 0 }) });
  assert.deepEqual(hostedBrowserPolicy(), HOSTED_BROWSER_POLICY_OFF);
  install(t, { policy: () => { throw new Error('vars unreadable'); } });
  assert.deepEqual(hostedBrowserPolicy(), HOSTED_BROWSER_POLICY_OFF);
  assert.deepEqual(logged.map((line) => JSON.parse(line).event), ['policy_invalid', 'policy_unavailable']);
});

test('incomplete access is unavailable, and nothing it holds is logged', (t) => {
  const logged = quietly(t);
  for (const access of [{ apiKey: '', projectId: 'proj' }, { apiKey: 'bb_live_secret', projectId: ' ' }, null]) {
    install(t, { access: () => access as never });
    assert.equal(hostedBrowserAccess(), undefined);
  }
  install(t, { access: () => { throw new Error('bb_live_secret missing'); } });
  assert.equal(hostedBrowserAccess(), undefined);
  assert.ok(logged.length > 0);
  for (const line of logged) assert.doesNotMatch(line, /bb_live|proj/);
});

test('Core declares the hosted browser in hosted-capabilities.json', () => {
  const capabilities = JSON.parse(readFileSync(new URL('../hosted-capabilities.json', import.meta.url), 'utf8'));
  assert.equal(capabilities.hostedBrowser, 1);
});
