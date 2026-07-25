import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteMemoryStateStore } from '../src/memory/store.ts';

test('public queries cannot match entries from a private store id', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    const privateStore = await state.ensurePrivateStore('T_TEST', 'C_PRIVATE', 1);
    await state.createEntry({
      entryId: 'private_1', storeId: privateStore.storeId, workspaceId: 'T_TEST',
      sourceChannelId: 'C_PRIVATE', slug: 'secret', description: 'Private fact.',
      type: 'fact', body: 'PRIVATE_CANARY', actorId: 'U_MEMBER', actorClass: 'member',
      idempotencyKey: 'private:create:1',
    });
    assert.deepEqual(
      await state.listEntries({ storeId: 'store_public_T_TEST', workspaceId: 'T_TEST' }),
      [],
    );
    assert.equal(JSON.stringify(await state.listAuditEvents()).includes('PRIVATE_CANARY'), false);
  } finally {
    state.close();
  }
});
