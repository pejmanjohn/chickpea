import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  JournalValidationError,
  appendRunJournal,
  createRunJournal,
  readRunJournal,
} from '../qa/live/safety/journal.ts';

const HEADER = {
  runId: 'run-journal-001',
  manifestDigest: 'sha256:manifest',
  targetFingerprint: 'sha256:target',
  repositoryRevision: '0123456789abcdef',
  servingVersion: 'version-1',
  suite: 'case' as const,
  variantIds: ['LC01-V1-create-welcome'],
  createdAt: '2026-09-01T12:00:00.000Z',
};

function directory(context: test.TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'chickpea-live-journal-'));
  context.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('journal creates one no-overwrite header and durably sequences append-only records', (context) => {
  const path = join(directory(context), 'run.jsonl');
  createRunJournal(path, HEADER);
  assert.throws(() => createRunJournal(path, HEADER), (error: unknown) =>
    error instanceof JournalValidationError && error.code === 'JOURNAL_EXISTS');

  const intent = appendRunJournal(path, {
    type: 'intent',
    intentId: 'intent-1',
    variantId: 'LC01-V1-create-welcome',
    actionRef: 'LC01-V1-create-welcome:1:1',
    actionId: 'agent.create',
    mutation: 'create',
    direction: 'forward',
  }, { runId: HEADER.runId, manifestDigest: HEADER.manifestDigest });
  const transition = appendRunJournal(path, {
    type: 'transition',
    from: 'preflight',
    to: 'action_required',
    output: 'action_required',
    variantId: 'LC01-V1-create-welcome',
    actionRef: 'LC01-V1-create-welcome:1:1',
  }, { runId: HEADER.runId, manifestDigest: HEADER.manifestDigest });

  assert.equal(intent.seq, 1);
  assert.equal(transition.seq, 2);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 3);
  assert.deepEqual(readRunJournal(path, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
  }).events.map((event) => event.seq), [1, 2]);
});

test('resume preserves or discards only an incomplete final record', (context) => {
  const path = join(directory(context), 'run.jsonl');
  createRunJournal(path, HEADER);
  appendFileSync(path, '{"record":"event","seq":1');

  const preserved = readRunJournal(path, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
    incompleteFinal: 'preserve',
  });
  assert.equal(preserved.incompleteFinalRecord, '{"record":"event","seq":1');
  assert.match(readFileSync(path, 'utf8'), /"seq":1$/);

  const repaired = readRunJournal(path, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
    incompleteFinal: 'discard',
  });
  assert.equal(repaired.incompleteFinalRecord, undefined);
  assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true);
});

test('resume rejects malformed complete, foreign-run, wrong-manifest, and out-of-sequence records', (context) => {
  const scenarios: Array<[string, object | string, string]> = [
    ['malformed', '{bad-json', 'MALFORMED_RECORD'],
    ['foreign', {
      record: 'event', seq: 1, runId: 'foreign-run', manifestDigest: HEADER.manifestDigest,
      at: HEADER.createdAt, event: { type: 'transition', from: 'preflight', to: 'complete', output: 'terminal' },
    }, 'FOREIGN_RUN'],
    ['manifest', {
      record: 'event', seq: 1, runId: HEADER.runId, manifestDigest: 'sha256:other',
      at: HEADER.createdAt, event: { type: 'transition', from: 'preflight', to: 'complete', output: 'terminal' },
    }, 'WRONG_MANIFEST'],
    ['sequence', {
      record: 'event', seq: 3, runId: HEADER.runId, manifestDigest: HEADER.manifestDigest,
      at: HEADER.createdAt, event: { type: 'transition', from: 'preflight', to: 'complete', output: 'terminal' },
    }, 'OUT_OF_SEQUENCE'],
  ];

  for (const [name, record, code] of scenarios) {
    const path = join(directory(context), `${name}.jsonl`);
    createRunJournal(path, HEADER);
    appendFileSync(path, `${typeof record === 'string' ? record : JSON.stringify(record)}\n`);
    assert.throws(() => readRunJournal(path, {
      runId: HEADER.runId,
      manifestDigest: HEADER.manifestDigest,
    }), (error: unknown) => error instanceof JournalValidationError && error.code === code);
  }
});

test('journal rejects a complete blank record in the middle of JSONL', (context) => {
  const path = join(directory(context), 'blank-line.jsonl');
  createRunJournal(path, HEADER);
  appendFileSync(path, `\n${JSON.stringify({
    record: 'event',
    seq: 1,
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
    at: HEADER.createdAt,
    event: { type: 'transition', from: 'preflight', to: 'complete', output: 'terminal' },
  })}\n`);
  assert.throws(() => readRunJournal(path, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
  }), (error: unknown) => error instanceof JournalValidationError && error.code === 'MALFORMED_RECORD');
});

test('journal rejects a replaced header and unsafe complete record instead of repairing it', (context) => {
  const path = join(directory(context), 'run.jsonl');
  createRunJournal(path, HEADER);
  const header = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  header.runId = 'foreign-run';
  chmodSync(path, 0o600);
  writeFileSync(path, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  assert.throws(() => readRunJournal(path, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
  }), (error: unknown) => error instanceof JournalValidationError && error.code === 'FOREIGN_RUN');

  const unsafePath = join(directory(context), 'unsafe.jsonl');
  createRunJournal(unsafePath, HEADER);
  appendFileSync(unsafePath, `${JSON.stringify({
    record: 'event',
    seq: 1,
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
    at: HEADER.createdAt,
    event: {
      type: 'transition', from: 'preflight', to: 'complete', output: 'terminal',
      body: 'private action text',
    },
  })}\n`);
  assert.throws(() => readRunJournal(unsafePath, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
  }), (error: unknown) => error instanceof JournalValidationError && error.code === 'INVALID_EVENT');
});
