import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BROWSER_SETTING_KEYS,
  clearBrowserSettings,
  describeBrowserSettings,
  looksLikeBrowserbaseKey,
  readBrowserMonthlyUsage,
  recordBrowserSessionUsage,
  resolveBrowserSettings,
  saveBrowserSettings,
} from '../src/browser/settings.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

test('describeBrowserSettings: env wins over stored and never echoes the key', () => {
  const env = describeBrowserSettings({ storedApiKey: 'bb_live_stored', envApiKey: 'bb_live_fromenv1234' });
  assert.equal(env.source, 'env');
  assert.equal(env.connected, true);
  assert.equal(env.keyHint, '1234');
  assert.equal(env.apiKey, 'bb_live_fromenv1234');

  const stored = describeBrowserSettings({ storedApiKey: '  bb_live_stored5678  ' });
  assert.equal(stored.source, 'stored');
  assert.equal(stored.keyHint, '5678');

  const missing = describeBrowserSettings({ storedApiKey: '   ', envApiKey: '' });
  assert.equal(missing.connected, false);
  assert.equal(missing.source, 'missing');
  assert.equal(missing.apiKey, undefined);
  assert.equal(missing.keyHint, undefined);
});

test('save, resolve and clear round-trip through the settings store', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    assert.equal((await resolveBrowserSettings(store, {})).connected, false);
    await saveBrowserSettings(store, { apiKey: 'bb_live_abcdefgh1234', projectId: ' proj-1 ' });
    const resolved = await resolveBrowserSettings(store, {});
    assert.equal(resolved.connected, true);
    assert.equal(resolved.source, 'stored');
    assert.equal(resolved.projectId, 'proj-1');
    assert.equal(await store.getSetting(BROWSER_SETTING_KEYS.apiKey), 'bb_live_abcdefgh1234');

    await saveBrowserSettings(store, { apiKey: 'bb_live_abcdefgh9999' });
    assert.equal((await resolveBrowserSettings(store, {})).projectId, undefined);

    await clearBrowserSettings(store);
    const cleared = await resolveBrowserSettings(store, {});
    assert.equal(cleared.connected, false);
    assert.equal(await store.getSetting(BROWSER_SETTING_KEYS.projectId), undefined);
  } finally {
    store.close?.();
  }
});

test('an environment variable overrides the stored key', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    await saveBrowserSettings(store, { apiKey: 'bb_live_storedkey0001' });
    const resolved = await resolveBrowserSettings(store, { BROWSERBASE_API_KEY: 'bb_live_envkey000002' });
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.keyHint, '0002');
  } finally {
    store.close?.();
  }
});

test('looksLikeBrowserbaseKey accepts the documented shape only', () => {
  assert.equal(looksLikeBrowserbaseKey('bb_live_FiP5-Yie-TVE7nYApT4S2NRRSb8'), true);
  assert.equal(looksLikeBrowserbaseKey(' bb_test_abcdefghij '), true);
  assert.equal(looksLikeBrowserbaseKey('sk-ant-nope'), false);
  assert.equal(looksLikeBrowserbaseKey('bb_live_'), false);
});

test('monthly usage tallies sessions and seconds, once per session id', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    const now = new Date('2026-09-22T12:00:00Z');
    const first = await recordBrowserSessionUsage({ store, sessionId: 's1', seconds: 42.6, now });
    assert.deepEqual(first, { month: '2026-09', sessions: 1, seconds: 43 });
    const again = await recordBrowserSessionUsage({ store, sessionId: 's1', seconds: 42.6, now });
    assert.deepEqual(again, { month: '2026-09', sessions: 1, seconds: 43 });
    const second = await recordBrowserSessionUsage({ store, sessionId: 's2', seconds: 7, now });
    assert.deepEqual(second, { month: '2026-09', sessions: 2, seconds: 50 });
    assert.deepEqual(await readBrowserMonthlyUsage(store, now), { month: '2026-09', sessions: 2, seconds: 50 });
    assert.deepEqual(await readBrowserMonthlyUsage(store, new Date('2026-10-01T00:00:00Z')), {
      month: '2026-10',
      sessions: 0,
      seconds: 0,
    });
  } finally {
    store.close?.();
  }
});
