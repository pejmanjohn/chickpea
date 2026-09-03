import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TargetLockError,
  acquireTargetLock,
  clearTargetLock,
  readRunJournalStatus,
  readTargetLockStatus,
  targetLockPath,
} from '../qa/live/safety/lock.ts';

function fixture(context: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-target-lock-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const owner = {
  runId: 'run-one', pid: 101, host: 'qa-host', startedAt: '2026-09-01T00:00:00.000Z',
};

test('two target evidence roots have independent locks', (context) => {
  const root = fixture(context);
  const amber = targetLockPath(join(root, 'amber'));
  const cobalt = targetLockPath(join(root, 'cobalt'));
  assert.equal(acquireTargetLock(amber, owner), 'acquired');
  assert.equal(acquireTargetLock(cobalt, { ...owner, runId: 'run-two', pid: 202 }), 'acquired');
  assert.equal(readTargetLockStatus(amber, { host: 'qa-host', isPidActive: () => true }).ownerRunId, 'run-one');
  assert.equal(readTargetLockStatus(cobalt, { host: 'qa-host', isPidActive: () => true }).ownerRunId, 'run-two');
});

test('read-only journal status makes safe clear explicit', (context) => {
  const root = fixture(context);
  const lockPath = targetLockPath(root);
  const journalPath = join(root, 'runs', 'run-one.jsonl');
  acquireTargetLock(lockPath, owner);
  mkdirSync(join(root, 'runs'), { recursive: true });
  writeFileSync(journalPath, [
    JSON.stringify({
      record: 'header', schemaVersion: 'chickpea-live-journal/v1', seq: 0, runId: 'run-one',
    }),
    JSON.stringify({
      record: 'event', seq: 1, runId: 'run-one',
      event: { type: 'intent', intentId: 'intent-one' },
    }),
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });

  const unresolved = readRunJournalStatus(journalPath, 'run-one');
  assert.equal(unresolved.safeToClear, false);
  assert.deepEqual(unresolved.unresolvedIntentIds, ['intent-one']);
  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one', host: 'qa-host', journal: unresolved, isPidActive: () => false,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'UNRESOLVED_INTENT',
  );

  writeFileSync(journalPath, [
    JSON.stringify({
      record: 'header', schemaVersion: 'chickpea-live-journal/v1', seq: 0, runId: 'run-one',
    }),
    JSON.stringify({
      record: 'event', seq: 1, runId: 'run-one',
      event: { type: 'intent', intentId: 'intent-one' },
    }),
    JSON.stringify({
      record: 'event', seq: 2, runId: 'run-one',
      event: { type: 'receipt', intentId: 'intent-one', outcome: 'completed' },
    }),
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  const resolved = readRunJournalStatus(journalPath, 'run-one');
  assert.equal(resolved.safeToClear, true);
  clearTargetLock(lockPath, {
    runId: 'run-one', host: 'qa-host', journal: resolved, isPidActive: () => false,
  });
  assert.equal(existsSync(lockPath), false);
});

test('safe clear refuses a live PID, a foreign run, and unresolved cleanup', (context) => {
  const root = fixture(context);
  const lockPath = targetLockPath(root);
  acquireTargetLock(lockPath, owner);
  const clearJournal = {
    runId: 'run-one', unresolvedIntentIds: [], unresolvedCleanupIds: [], safeToClear: true,
  } as const;
  assert.equal(
    readTargetLockStatus(lockPath, { host: 'other-host', isPidActive: () => false }).status,
    'foreign',
  );
  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one', host: 'other-host', journal: clearJournal, isPidActive: () => false,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_FOREIGN_HOST',
  );
  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one', host: 'qa-host', journal: clearJournal, isPidActive: () => true,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_ACTIVE',
  );
  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-two', host: 'qa-host',
      journal: { ...clearJournal, runId: 'run-two' }, isPidActive: () => false,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_DIFFERENT_RUN',
  );
  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one', host: 'qa-host',
      journal: {
        runId: 'run-one', unresolvedIntentIds: [], unresolvedCleanupIds: ['receipt-one'], safeToClear: false,
      },
      isPidActive: () => false,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'UNRESOLVED_CLEANUP',
  );
  assert.equal(existsSync(lockPath), true);
});
