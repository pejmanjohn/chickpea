import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addSettingStringSetValues,
  readSettingStringSet,
  removeSettingStringSetValues,
  updateJsonSetting,
} from '../src/config/setting-string-set.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

test('a string set reads distinct members, filtered, and malformed rows as empty', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    assert.deepEqual(await readSettingStringSet(store, 'index'), []);
    await addSettingStringSetValues(store, 'index', ['a', 'b']);
    await addSettingStringSetValues(store, 'index', ['b', 'c']);
    assert.deepEqual(await readSettingStringSet(store, 'index'), ['a', 'b', 'c']);
    assert.deepEqual(await readSettingStringSet(store, 'index', (value) => value !== 'b'), ['a', 'c']);

    await store.setSetting('index', JSON.stringify(['a', 'a', 7, 'b']));
    assert.deepEqual(await readSettingStringSet(store, 'index'), ['a', 'b']);
    await store.setSetting('index', '{not json');
    assert.deepEqual(await readSettingStringSet(store, 'index'), []);
  } finally {
    store.close();
  }
});

test('removing members rewrites the set and deletes the row once it is empty', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    await removeSettingStringSetValues(store, 'index', ['a']);
    assert.equal(await store.getSetting('index'), undefined);

    await addSettingStringSetValues(store, 'index', ['a', 'b', 'c']);
    await removeSettingStringSetValues(store, 'index', ['b']);
    assert.equal(await store.getSetting('index'), JSON.stringify(['a', 'c']));
    await removeSettingStringSetValues(store, 'index', ['a', 'c']);
    assert.equal(await store.getSetting('index'), undefined);

    await Promise.all([
      addSettingStringSetValues(store, 'index', ['x', 'y', 'z']).then(() =>
        removeSettingStringSetValues(store, 'index', ['x'])),
      addSettingStringSetValues(store, 'index', ['w']),
    ]);
    assert.deepEqual(await readSettingStringSet(store, 'index'), ['y', 'z', 'w']);
  } finally {
    store.close();
  }
});

test('updateJsonSetting compare-and-sets one record, deletes on null, and leaves on undefined', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    assert.deepEqual(
      await updateJsonSetting<{ n: number }>(store, 'record', (current) => ({ n: (current?.n ?? 0) + 1 })),
      { n: 1 },
    );
    await Promise.all(Array.from({ length: 3 }, () =>
      updateJsonSetting<{ n: number }>(store, 'record', (current) => ({ n: (current?.n ?? 0) + 1 }))));
    assert.equal(JSON.parse((await store.getSetting('record'))!).n, 4);

    assert.equal(await updateJsonSetting(store, 'record', () => undefined), undefined);
    assert.equal(JSON.parse((await store.getSetting('record'))!).n, 4);

    assert.equal(await updateJsonSetting(store, 'record', () => null), null);
    assert.equal(await store.getSetting('record'), undefined);

    // A lost race retries against the fresh value.
    let calls = 0;
    const racing = Object.assign(Object.create(store) as SqliteSettingsStore, {
      getSetting: async (key: string) => {
        calls += 1;
        if (calls === 1) {
          const raw = await store.getSetting(key);
          await store.setSetting(key, JSON.stringify({ n: 10 }));
          return raw;
        }
        return store.getSetting(key);
      },
    });
    assert.deepEqual(
      await updateJsonSetting<{ n: number }>(racing, 'record', (current) => ({ n: (current?.n ?? 0) + 1 })),
      { n: 11 },
    );
  } finally {
    store.close();
  }
});
