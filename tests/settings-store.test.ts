import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';

test('SqliteSettingsStore round-trips set, overwrite, and delete', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    assert.equal(await store.getSetting('slack.botToken'), undefined);

    await store.setSetting('slack.botToken', 'xoxb-first');
    assert.equal(await store.getSetting('slack.botToken'), 'xoxb-first');

    // Upsert semantics: setting an existing key replaces the value.
    await store.setSetting('slack.botToken', 'xoxb-second');
    assert.equal(await store.getSetting('slack.botToken'), 'xoxb-second');

    // Keys are independent.
    await store.setSetting('slack.signingSecret', 'shhh');
    assert.equal(await store.getSetting('slack.botToken'), 'xoxb-second');
    assert.equal(await store.getSetting('slack.signingSecret'), 'shhh');

    await store.deleteSetting('slack.botToken');
    assert.equal(await store.getSetting('slack.botToken'), undefined);
    assert.equal(await store.getSetting('slack.signingSecret'), 'shhh');

    // Deleting a missing key is a no-op, not an error.
    await store.deleteSetting('slack.botToken');
  } finally {
    store.close();
  }
});

test('SqliteSettingsStore persists across restart on a file database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-settings-store-'));
  const path = join(dir, 'state.db');
  try {
    const first = new SqliteSettingsStore(path);
    await first.setSetting('slack.botUserId', 'U_BOT');
    first.close();

    const second = new SqliteSettingsStore(path);
    assert.equal(await second.getSetting('slack.botUserId'), 'U_BOT');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings share the state DB file with the other app stores without clashing', async () => {
  // All four app stores open the same SQLite file; the settings table must
  // coexist with the config/claims/snapshot tables created by the others.
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-settings-shared-'));
  const path = join(dir, 'state.db');
  const { SqliteConfigStore } = await import('../src/config/store.ts');
  const config = new SqliteConfigStore(path, { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(path);
  try {
    await settings.setSetting('slack.botToken', 'xoxb-shared');
    assert.equal(await settings.getSetting('slack.botToken'), 'xoxb-shared');
    assert.deepEqual(await config.listAgents(), []);
  } finally {
    settings.close();
    config.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
