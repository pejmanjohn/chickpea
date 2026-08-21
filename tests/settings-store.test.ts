import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

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

test('mergeSettingStringSet preserves every member across concurrent callers', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    await Promise.all([
      store.mergeSettingStringSet('mcp-secret-inventory.agent', ['connection-a']),
      store.mergeSettingStringSet('mcp-secret-inventory.agent', ['connection-b']),
    ]);

    assert.equal(
      await store.getSetting('mcp-secret-inventory.agent'),
      JSON.stringify(['connection-a', 'connection-b']),
    );
  } finally {
    store.close();
  }
});

test('applySettingsPatch compares a revision and changes related settings as one unit', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    await store.setSetting('connection.revision', 'revision-1');
    await store.setSetting('connection.token', 'token-1');
    await store.setSetting('connection.staleMetadata', 'remove-me');

    const stale = await store.applySettingsPatch({
      expected: { key: 'connection.revision', value: 'revision-0' },
      set: [
        { key: 'connection.revision', value: 'revision-2' },
        { key: 'connection.token', value: 'token-2' },
      ],
      delete: ['connection.staleMetadata'],
    });
    assert.equal(stale, false);
    assert.deepEqual(
      await store.getSettings([
        'connection.revision',
        'connection.token',
        'connection.staleMetadata',
        'connection.missing',
      ]),
      ['revision-1', 'token-1', 'remove-me', undefined],
    );

    const applied = await store.applySettingsPatch({
      expected: { key: 'connection.revision', value: 'revision-1' },
      set: [
        { key: 'connection.revision', value: 'revision-2' },
        { key: 'connection.token', value: 'token-2' },
      ],
      delete: ['connection.staleMetadata'],
    });
    assert.equal(applied, true);
    assert.deepEqual(
      await store.getSettings([
        'connection.revision',
        'connection.token',
        'connection.staleMetadata',
      ]),
      ['revision-2', 'token-2', undefined],
    );
  } finally {
    store.close();
  }
});

test('applySettingsPatch rolls every write back when one setting fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-settings-patch-'));
  const path = join(dir, 'state.db');
  const store = new SqliteSettingsStore(path);
  try {
    await store.setSetting('connection.revision', 'revision-1');
    await store.setSetting('connection.token', 'token-1');
    await store.setSetting('connection.secret', 'secret-1');
    await store.setSetting('connection.team', 'Old Team');

    const triggerDb = openStateDb(path);
    triggerDb.exec(
      `CREATE TRIGGER block_secret_rotation
       BEFORE UPDATE OF value ON app_settings
       WHEN OLD.key = 'connection.secret'
       BEGIN SELECT RAISE(ABORT, 'blocked rotation'); END`,
    );
    triggerDb.close();

    await assert.rejects(
      () =>
        store.applySettingsPatch({
          expected: { key: 'connection.revision', value: 'revision-1' },
          set: [
            { key: 'connection.token', value: 'token-2' },
            { key: 'connection.secret', value: 'secret-2' },
            { key: 'connection.revision', value: 'revision-2' },
          ],
          delete: ['connection.team'],
        }),
      /blocked rotation/,
    );
    assert.deepEqual(
      await store.getSettings([
        'connection.revision',
        'connection.token',
        'connection.secret',
        'connection.team',
      ]),
      ['revision-1', 'token-1', 'secret-1', 'Old Team'],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteSettingsStore persists across restart on a file database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-settings-store-'));
  const path = join(dir, 'state.db');
  try {
    const first = new SqliteSettingsStore(path);
    await first.setSetting('slack.botUserId', 'UBOT');
    first.close();

    const second = new SqliteSettingsStore(path);
    assert.equal(await second.getSetting('slack.botUserId'), 'UBOT');
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
  const config = new SqliteConfigStore(path, { agents: [] });
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
