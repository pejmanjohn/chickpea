import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import {
  DEFAULT_RUN_BODY_RETENTION_DAYS,
  resolveRunBodyRetentionDays,
} from '../src/work/retention.ts';
import { WorkStoreLogic } from '../src/work/store.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = 1_800_000_000_000;

test('Run body retention defaults to 30 days and fails closed outside 1-365', () => {
  assert.equal(resolveRunBodyRetentionDays({}), DEFAULT_RUN_BODY_RETENTION_DAYS);
  assert.equal(resolveRunBodyRetentionDays({ TAG_RUN_BODY_RETENTION_DAYS: '1' }), 1);
  assert.equal(resolveRunBodyRetentionDays({ TAG_RUN_BODY_RETENTION_DAYS: '365' }), 365);
  for (const value of ['0', '366', '1.5', 'Infinity', '-1', ' 30 ']) {
    assert.throws(
      () => resolveRunBodyRetentionDays({ TAG_RUN_BODY_RETENTION_DAYS: value }),
      /integer from 1 to 365/,
      value,
    );
  }
});

test('Cloudflare deployment exposes the canonical Run body retention control', () => {
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const devVars = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
  assert.match(wrangler, /"TAG_RUN_BODY_RETENTION_DAYS"\s*:\s*"30"/);
  assert.doesNotMatch(devVars, /^TAG_RUN_BODY_RETENTION_DAYS=/m);
});

test('content records an immutable expiry, denies reads at expiry, and purges bodies idempotently', () => {
  const db = openStateDb(':memory:');
  try {
    let retention = '2';
    const store = new WorkStoreLogic(db, {
      now: () => NOW,
      env: new Proxy<Record<string, string | undefined>>({}, {
        get: (_target, key) => key === 'TAG_RUN_BODY_RETENTION_DAYS' ? retention : undefined,
      }),
    });
    const first = store.putContent({ sensitivity: 'private', body: 'same body', createdAt: NOW });
    retention = '5';
    const second = store.putContent({ sensitivity: 'private', body: 'same body', createdAt: NOW });
    assert.notEqual(first.ref, second.ref);
    assert.equal(first.expiresAt, NOW + 2 * DAY_MS);
    assert.equal(second.expiresAt, NOW + 5 * DAY_MS);
    assert.equal(store.getContent(first.ref, first.expiresAt - 1)?.body, 'same body');
    assert.equal(store.getContent(first.ref, first.expiresAt), undefined);

    assert.deepEqual(store.purgeContent(first.expiresAt, 1), {
      purgedCount: 1,
      remainingExpiredCount: 0,
    });
    assert.deepEqual(store.purgeContent(first.expiresAt, 1), {
      purgedCount: 0,
      remainingExpiredCount: 0,
    });
    const purged = db.get('SELECT * FROM ledger_content WHERE ref = ?', first.ref);
    assert.equal(purged?.body, null);
    assert.equal(purged?.byte_size, 0);
    assert.equal(purged?.purged_at, first.expiresAt);
    assert.equal(
      db.all('PRAGMA table_info(ledger_content)').some((column) =>
        /digest|hash/i.test(String(column.name))),
      false,
    );
    retention = '2';
    const later = store.putContent({ sensitivity: 'private', body: 'same body', createdAt: NOW });
    assert.notEqual(later.ref, first.ref);
  } finally {
    db.close();
  }
});

test('invalid retention never writes a body', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, {
      now: () => NOW,
      env: { TAG_RUN_BODY_RETENTION_DAYS: 'NaN' },
    });
    assert.throws(
      () => store.putContent({ sensitivity: 'public', body: 'not written' }),
      /integer from 1 to 365/,
    );
    assert.equal(db.get('SELECT COUNT(*) AS count FROM ledger_content')?.count, 0);
  } finally {
    db.close();
  }
});
