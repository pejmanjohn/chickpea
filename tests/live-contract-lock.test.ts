import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TargetLockError,
  acquireTargetLock,
  clearTargetLock,
  readTargetLock,
} from '../qa/live/safety/lock.ts';
import {
  appendRunJournal,
  createRunJournal,
  readRunJournal,
} from '../qa/live/safety/journal.ts';

const MANIFEST = `sha256:${'a'.repeat(64)}`;

function tempFixture(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-live-lock-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    lockPath: join(directory, 'target.lock'),
    journalPath: join(directory, 'run.jsonl'),
  };
}

function createJournal(path: string, runId = 'run-one') {
  createRunJournal(path, {
    runId,
    manifestDigest: MANIFEST,
    targetFingerprint: 'sha256:target',
    repositoryRevision: 'revision-one',
    servingVersion: 'version-one',
    suite: 'case',
    variantIds: ['LC01-V1-create-welcome'],
    createdAt: '2026-09-01T00:00:00.000Z',
  });
}

test('the target lock is no-overwrite while its local PID is active', (context) => {
  const { lockPath } = tempFixture(context);
  const owner = { runId: 'run-one', pid: 101, host: 'qa-host', startedAt: '2026-09-01T00:00:00.000Z' };

  assert.equal(acquireTargetLock(lockPath, owner, { isPidActive: () => true }), 'acquired');
  assert.throws(
    () => acquireTargetLock(lockPath, { ...owner, pid: 202 }, { isPidActive: () => true }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_ACTIVE',
  );
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), owner);
});

test('a stale same-run lock must be safely cleared before a fresh exclusive acquire', (context) => {
  const { lockPath, journalPath } = tempFixture(context);
  const owner = { runId: 'run-one', pid: 101, host: 'qa-host', startedAt: '2026-09-01T00:00:00.000Z' };
  acquireTargetLock(lockPath, owner, { isPidActive: () => false });
  createJournal(journalPath);

  assert.throws(
    () => acquireTargetLock(lockPath, { ...owner, host: 'foreign-host', pid: 202 }, { isPidActive: () => false }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_FOREIGN_HOST',
  );
  assert.throws(
    () => acquireTargetLock(lockPath, { ...owner, runId: 'run-two', pid: 202 }, { isPidActive: () => false }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_DIFFERENT_RUN',
  );

  assert.throws(
    () => acquireTargetLock(lockPath, { ...owner, pid: 202 }, { isPidActive: () => false }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_ACTIVE',
  );
  clearTargetLock(lockPath, {
    runId: 'run-one', host: 'qa-host',
    journal: readRunJournal(journalPath, { runId: 'run-one', manifestDigest: MANIFEST }),
    isPidActive: () => false,
  });
  assert.equal(acquireTargetLock(lockPath, { ...owner, pid: 202 }), 'acquired');
  assert.equal(readTargetLock(lockPath)?.pid, 202);
});

test('--clear-lock refuses a durable product mutation without verified cleanup', (context) => {
  const { lockPath, journalPath } = tempFixture(context);
  acquireTargetLock(lockPath, {
    runId: 'run-one', pid: 101, host: 'qa-host', startedAt: '2026-09-01T00:00:00.000Z',
  });
  createJournal(journalPath);
  appendRunJournal(journalPath, {
    type: 'mutation_receipt', receiptId: 'receipt-lock-mutation',
    caseId: 'LC01-V1-create-welcome', stepId: 'create-agent', attempt: 1,
    targetAlias: 'dedicated-qa', actionChallengeDigest: 'sha256:challenge',
    operatorReceiptDigest: 'sha256:operator', beforeStateDigest: 'sha256:absent',
    immutableId: 'agent_lock_mutation', beforeRevision: 'absent', revision: 'revision-1',
    stateDigest: 'sha256:created', resourceKind: 'agent', mutation: 'create',
    fixtureClass: 'run_owned', cleanupStrategy: 'exact_reversal', reversalActionId: 'agent.archive',
    direction: 'forward',
  }, { runId: 'run-one', manifestDigest: MANIFEST });

  assert.throws(() => clearTargetLock(lockPath, {
    runId: 'run-one', host: 'qa-host',
    journal: readRunJournal(journalPath, { runId: 'run-one', manifestDigest: MANIFEST }),
    isPidActive: () => false,
  }), (error: unknown) => error instanceof TargetLockError && error.code === 'UNRESOLVED_CLEANUP');
});

test('--clear-lock requires a stopped local owner and no unresolved journal intent', (context) => {
  const { lockPath, journalPath } = tempFixture(context);
  const owner = { runId: 'run-one', pid: 101, host: 'qa-host', startedAt: '2026-09-01T00:00:00.000Z' };
  acquireTargetLock(lockPath, owner, { isPidActive: () => false });
  createJournal(journalPath);
  appendRunJournal(journalPath, {
    type: 'intent',
    intentId: 'intent-one',
    variantId: 'LC01-V1-create-welcome',
    actionRef: 'LC01-V1-create-welcome:0:1',
    actionId: 'agent.create',
    mutation: 'create',
    direction: 'forward',
  }, { runId: 'run-one', manifestDigest: MANIFEST });

  const unresolved = readRunJournal(journalPath, { runId: 'run-one', manifestDigest: MANIFEST });
  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one', host: 'qa-host', journal: unresolved, isPidActive: () => false,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'UNRESOLVED_INTENT',
  );

  appendRunJournal(journalPath, {
    type: 'receipt',
    intentId: 'intent-one',
    variantId: 'LC01-V1-create-welcome',
    actionRef: 'LC01-V1-create-welcome:0:1',
    outcome: 'completed',
  }, { runId: 'run-one', manifestDigest: MANIFEST });
  const resolved = readRunJournal(journalPath, { runId: 'run-one', manifestDigest: MANIFEST });

  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one', host: 'qa-host', journal: resolved, isPidActive: () => true,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_ACTIVE',
  );
  clearTargetLock(lockPath, {
    runId: 'run-one', host: 'qa-host', journal: resolved, isPidActive: () => false,
  });
  assert.equal(readTargetLock(lockPath), undefined);
});

test('an ambiguous readback remains unresolved and prevents --clear-lock', (context) => {
  const { lockPath, journalPath } = tempFixture(context);
  acquireTargetLock(lockPath, {
    runId: 'run-one', pid: 101, host: 'qa-host', startedAt: '2026-09-01T00:00:00.000Z',
  }, { isPidActive: () => false });
  createJournal(journalPath);
  appendRunJournal(journalPath, {
    type: 'intent',
    intentId: 'intent-ambiguous',
    variantId: 'LC01-V1-create-welcome',
    actionRef: 'LC01-V1-create-welcome:0:1',
    actionId: 'agent.create',
    mutation: 'create',
    direction: 'forward',
  }, { runId: 'run-one', manifestDigest: MANIFEST });
  appendRunJournal(journalPath, {
    type: 'readback',
    intentId: 'intent-ambiguous',
    variantId: 'LC01-V1-create-welcome',
    actionRef: 'LC01-V1-create-welcome:0:1',
    outcome: 'ambiguous',
  }, { runId: 'run-one', manifestDigest: MANIFEST });

  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one',
      host: 'qa-host',
      journal: readRunJournal(journalPath, { runId: 'run-one', manifestDigest: MANIFEST }),
      isPidActive: () => false,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'UNRESOLVED_INTENT',
  );
  assert.equal(readTargetLock(lockPath)?.runId, 'run-one');
});

test('--clear-lock revalidates the owner immediately before unlink', (context) => {
  const { lockPath, journalPath } = tempFixture(context);
  const owner = {
    runId: 'run-one', pid: 101, host: 'qa-host', startedAt: '2026-09-01T00:00:00.000Z',
  };
  acquireTargetLock(lockPath, owner, { isPidActive: () => false });
  createJournal(journalPath);
  const changed = { ...owner, pid: 202, startedAt: '2026-09-01T00:01:00.000Z' };

  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one',
      host: 'qa-host',
      journal: readRunJournal(journalPath, { runId: 'run-one', manifestDigest: MANIFEST }),
      isPidActive: () => {
        writeFileSync(lockPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
        return false;
      },
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_CHANGED',
  );
  assert.deepEqual(readTargetLock(lockPath), changed);
});

test('a foreign-host lock remains blocked even when its recorded PID appears inactive', (context) => {
  const { lockPath, journalPath } = tempFixture(context);
  acquireTargetLock(lockPath, {
    runId: 'run-one', pid: 101, host: 'foreign-host', startedAt: '2026-09-01T00:00:00.000Z',
  }, { isPidActive: () => false });
  createJournal(journalPath);

  assert.throws(
    () => clearTargetLock(lockPath, {
      runId: 'run-one',
      host: 'qa-host',
      journal: readRunJournal(journalPath, { runId: 'run-one', manifestDigest: MANIFEST }),
      isPidActive: () => false,
    }),
    (error: unknown) => error instanceof TargetLockError && error.code === 'LOCK_FOREIGN_HOST',
  );
});
