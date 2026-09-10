import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigStoreLogic, CONFIG_CHICKPEA_EXTENSION_MIGRATION } from '../src/config/store.ts';
import { reconcileSlackPublicContextMutation } from '../src/slack/public-context.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { attachStateDb } from '../src/state/schema-lifecycle.ts';

test('an existing extension marker still upgrades retained context before writes and edits', async () => {
  const db = openStateDb(':memory:');
  try {
    const original = new ConfigStoreLogic(db, { agents: [] });
    const input = { workspaceId: 'T_MIGRATION', channelId: 'C_MIGRATION', rootTs: '1000.000001',
      messageTs: '1001.000001', role: 'human' as const, text: 'Retained before upgrade.' };
    const before = original.putSlackPublicContext(input);
    const marker = db.get('SELECT * FROM config_migrations WHERE id = ?', CONFIG_CHICKPEA_EXTENSION_MIGRATION);
    assert.ok(marker);
    // Simulate the pre-change table while retaining the already-installed
    // extension marker and data: table creation now takes its early return.
    db.exec('ALTER TABLE config_slack_public_context DROP COLUMN content_version_ts');
    assert.equal(db.all('PRAGMA table_info(config_slack_public_context)').some((row) => row.name === 'content_version_ts'), false);

    const upgraded = new ConfigStoreLogic(db, { agents: [] });
    assert.deepEqual(upgraded.listSlackPublicContext(input.workspaceId, input.channelId, input.rootTs), [before]);
    assert.deepEqual(db.get('SELECT * FROM config_migrations WHERE id = ?', CONFIG_CHICKPEA_EXTENSION_MIGRATION), marker);
    assert.equal(db.all('PRAGMA table_info(config_slack_public_context)').find((row) => row.name === 'content_version_ts')?.notnull, 0);
    upgraded.putSlackPublicContext({ ...input, messageTs: '1002.000001', text: 'New accepted message.' });
    await reconcileSlackPublicContextMutation(upgraded, input.workspaceId, {
      type: 'message', subtype: 'message_changed', channel: input.channelId, ts: '1003.000001',
      message: { type: 'message', channel: input.channelId, thread_ts: input.rootTs,
        ts: input.messageTs, text: 'Corrected after upgrade.', edited: { ts: '1003.000001' } },
    });
    const edited = upgraded.listSlackPublicContext(input.workspaceId, input.channelId, input.rootTs);
    assert.equal(edited.length, 2);
    assert.equal(edited[0]?.text, 'Corrected after upgrade.');
    assert.equal(edited[0]?.contentVersionTs, '1003.000001');

    const reopened = new ConfigStoreLogic(db, { agents: [] });
    assert.deepEqual(reopened.listSlackPublicContext(input.workspaceId, input.channelId, input.rootTs), edited);
    const attached = new ConfigStoreLogic({ ...attachStateDb(db),
      exec: () => { assert.fail('attach must not execute schema DDL'); },
    }, { agents: [] });
    assert.deepEqual(attached.listSlackPublicContext(input.workspaceId, input.channelId, input.rootTs), edited);
  } finally { db.close(); }
});
