import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AuditStoreLogic } from '../src/audit/store.ts';
import { NodeStateDb } from '../src/state/node-state-db.ts';
import type { SqlParam } from '../src/state/state-db.ts';

class CloudflareLimitDb extends NodeStateDb {
  override all(sql: string, ...params: SqlParam[]) {
    // https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits
    assert.ok(params.length <= 100, `DO SQLite rejects ${params.length} bound parameters`);
    return super.all(sql, ...params);
  }
}

for (const runCount of [97, 98, 100]) {
  test(`routine audit lookup retains every subject at ${runCount} historical runs`, () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      const store = new AuditStoreLogic(new CloudflareLimitDb(sqlite));
      const subjects = ['routine_fixture', ...Array.from({ length: runCount }, (_, i) => `run_${i}`)];
      for (const [index, subjectId] of subjects.entries()) {
        store.append({ eventId: `event_${String(index).padStart(3, '0')}`, domain: 'scheduled_work',
          eventType: 'fixture', outcome: 'success', actorClass: 'system', subjectId, createdAt: 100 });
      }
      store.append({ eventId: 'outside', domain: 'scheduled_work', eventType: 'fixture',
        outcome: 'success', actorClass: 'system', subjectId: 'outside', createdAt: 101 });
      const result = store.list({ domain: 'scheduled_work', subjectIds: subjects, limit: 500 });
      assert.equal(result.length, runCount + 1);
      assert.deepEqual(result.map(({ subjectId }) => subjectId), [...subjects].reverse());
      assert.deepEqual(store.list({ domain: 'scheduled_work', subjectIds: subjects, limit: 3 }), result.slice(0, 3));
    } finally { sqlite.close(); }
  });
}

test('subject membership remains bound data and composes with every audit filter', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const store = new AuditStoreLogic(new CloudflareLimitDb(sqlite));
    const subject = 'fixture\"), OR 1=1 --';
    const event = { eventId: 'matching', domain: 'scheduled_work' as const, eventType: 'fixture',
      outcome: 'success' as const, actorClass: 'system', subjectId: subject,
      channelId: 'channel', storeId: 'store', idempotencyKey: 'key', createdAt: 10 };
    store.append(event);
    store.append({ ...event, eventId: 'other-domain', domain: 'identity', idempotencyKey: 'other' });
    const subjects = [...Array.from({ length: 100 }, (_, i) => `run_${i}`), subject, subject];
    const result = store.list({ domain: 'scheduled_work', eventType: 'fixture', idempotencyKey: 'key',
      subjectId: subject, subjectIds: subjects, channelId: 'channel', storeId: 'store', limit: 500 });
    assert.deepEqual(result.map(({ eventId }) => eventId), ['matching']);
    assert.equal(store.list({ subjectIds: [...Array.from({ length: 101 }, (_, i) => `other_${i}`), subject] }).length, 0,
      'the existing 101 unique subject ceiling remains enforced');
  } finally { sqlite.close(); }
});
