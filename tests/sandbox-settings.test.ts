import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseSandboxAllowedHosts,
  resolveSandboxSettings,
  SANDBOX_SETTING_KEYS,
} from '../src/config/sandbox-settings.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

test('sandbox install-level settings keys round-trip without a profile key', async () => {
  assert.deepEqual(SANDBOX_SETTING_KEYS, {
    installRequested: 'sandbox.installRequested',
    enabled: 'sandbox.enabled',
    allowedHosts: 'sandbox.allowedHosts',
    monthlySessionCap: 'sandbox.monthlySessionCap',
  });
  assert.equal(
    Object.values(SANDBOX_SETTING_KEYS).some((key) => key.includes('profile')),
    false,
  );

  const store = new SqliteSettingsStore(':memory:');
  try {
    await store.setSetting(SANDBOX_SETTING_KEYS.installRequested, 'true');
    await store.setSetting(SANDBOX_SETTING_KEYS.enabled, 'true');
    // Legacy runtime-editable values are ignored: container size is declared
    // in wrangler.jsonc and only changes on deployment.
    await store.setSetting('sandbox.instanceType', 'standard-4');
    await store.setSetting(
      SANDBOX_SETTING_KEYS.allowedHosts,
      JSON.stringify(['registry.npmjs.org', 'files.pythonhosted.org']),
    );
    await store.setSetting(SANDBOX_SETTING_KEYS.monthlySessionCap, '350');

    assert.deepEqual(await store.getSettings(Object.values(SANDBOX_SETTING_KEYS)), [
      'true',
      'true',
      '["registry.npmjs.org","files.pythonhosted.org"]',
      '350',
    ]);
    assert.deepEqual(await resolveSandboxSettings(store), {
      installRequested: true,
      enabled: true,
      instanceType: 'standard-1',
      allowedHosts: ['registry.npmjs.org', 'files.pythonhosted.org'],
      monthlySessionCap: 350,
      monthlySessionCapConfigured: true,
    });
  } finally {
    store.close();
  }
});

test('sandbox allowed-host settings accept only the supported package registries', () => {
  // An explicit list is honored and filtered to the curated set.
  assert.deepEqual(
    parseSandboxAllowedHosts(
      JSON.stringify([
        'REGISTRY.NPMJS.ORG',
        'files.pythonhosted.org',
        'packages.example.com',
        'registry.npmjs.org',
      ]),
    ),
    ['registry.npmjs.org', 'files.pythonhosted.org'],
  );
  // An explicit empty array blocks every registry (operator lockdown).
  assert.deepEqual(parseSandboxAllowedHosts(JSON.stringify([])), []);
  // Only an explicitly configured curated subset narrows the default.
  assert.deepEqual(parseSandboxAllowedHosts(JSON.stringify(['pypi.org'])), ['pypi.org']);
});

test('sandbox allowed-hosts default-permit the curated registries so the loop works out of the box', () => {
  const curated = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'];
  // Unset, malformed, or wrong-shaped values fall back to permitting the full
  // curated set — a coding sandbox that cannot npm/pip install is useless, and
  // the set is a vetted constant, not arbitrary operator input.
  assert.deepEqual(parseSandboxAllowedHosts(undefined), curated);
  assert.deepEqual(parseSandboxAllowedHosts('not-json'), curated);
  assert.deepEqual(parseSandboxAllowedHosts(JSON.stringify('registry.npmjs.org')), curated);
});
