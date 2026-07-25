import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteMemoryStateStore } from '../src/memory/store.ts';

test('private to public seals private memory and creates a visibility barrier', async () => {
  let now = 100;
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    const privateState = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'private',
      displayName: 'secret-project',
      observedAt: now,
    });
    assert.equal(privateState.privateGeneration, 1);
    assert.ok(privateState.privateStoreId);

    now = 200;
    const publicState = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'public',
      displayName: 'launched-project',
      observedAt: now,
    });
    assert.equal(publicState.privacy, 'public');
    assert.equal(publicState.visibilityBarrierAt, 200);
    assert.equal(publicState.privateStoreId, null);
    assert.equal((await state.getStore(privateState.privateStoreId ?? ''))?.lifecycle, 'sealed');
  } finally {
    state.close();
  }
});

test('public to private preserves the frozen public label and starts a new generation', async () => {
  let now = 100;
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'public',
      displayName: 'product',
      observedAt: now,
    });
    now = 200;
    const privateState = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'private',
      displayName: 'renamed-private',
      observedAt: now,
    });
    assert.equal(privateState.privateGeneration, 1);
    assert.equal(privateState.lastPublicDisplayName, 'product');

    now = 300;
    await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'public',
      displayName: 'public-again',
      observedAt: now,
    });
    now = 400;
    const secondPrivate = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'private',
      displayName: 'private-again',
      observedAt: now,
    });
    assert.equal(secondPrivate.privateGeneration, 2);
    assert.notEqual(secondPrivate.privateStoreId, privateState.privateStoreId);
  } finally {
    state.close();
  }
});
