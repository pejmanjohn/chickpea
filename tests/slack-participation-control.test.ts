import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIVE_WORK_TTL_MS, SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import { parseSlackParticipationControl } from '../src/slack/participation-control.ts';

test('participation controls recognize bounded channel and thread instructions only', () => {
  assert.deepEqual(
    parseSlackParticipationControl('<@UBOT> only respond when mentioned in this channel'),
    { mode: 'mention_only', scope: 'channel' },
  );
  assert.deepEqual(
    parseSlackParticipationControl('<@UBOT> respond again without a mention in this thread'),
    { mode: 'ambient', scope: 'thread' },
  );
  assert.equal(
    parseSlackParticipationControl('Should bots only respond when mentioned?'),
    null,
  );
  assert.equal(
    parseSlackParticipationControl('Claude said only respond when mentioned in this channel'),
    null,
  );
  assert.equal(
    parseSlackParticipationControl('Do you think we should only reply when tagged in this channel?'),
    null,
  );
  assert.deepEqual(
    parseSlackParticipationControl('<@UBOT> please stay quiet in this thread.'),
    { mode: 'mention_only', scope: 'thread' },
  );
});

test('thread participation is content-free, bounded state', async () => {
  const store = new SqliteSlackStateStore(':memory:');
  assert.equal(await store.getParticipation('T:C:1.0'), 'ambient');
  await store.setParticipation('T:C:1.0', 'mention_only');
  assert.equal(await store.getParticipation('T:C:1.0'), 'mention_only');
  store.close();
});

test('active-work state clears explicitly and self-heals after its bounded TTL', async () => {
  let now = 1_000;
  const store = new SqliteSlackStateStore(':memory:', () => now);
  const key = 'T:C:1.0';
  assert.equal(await store.isActiveWork(key), false);
  await store.setActiveWork(key, 'msg:1', true);
  assert.equal(await store.isActiveWork(key), true);
  await store.setActiveWork(key, 'msg:2', true);
  await store.setActiveWork(key, 'msg:1', false);
  assert.equal(await store.isActiveWork(key), true, 'a newer in-flight turn remains active');
  now += ACTIVE_WORK_TTL_MS + 1;
  assert.equal(await store.isActiveWork(key), false);
  await store.setActiveWork(key, 'msg:1', true);
  await store.setActiveWork(key, 'msg:1', false);
  assert.equal(await store.isActiveWork(key), false);
  store.close();
});
