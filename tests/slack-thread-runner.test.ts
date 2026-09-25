import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { NodeStateDb } from '../src/state/node-state-db.ts';

// Execution behaviour of the runner lives in thread-runner-loop.ts and is
// covered against fakes in slack-thread-runner-execution.test.ts.

test('job store persists one row per job id and counts by state', () => {
  const store = new ThreadRunnerJobStore(new NodeStateDb(new DatabaseSync(':memory:')));
  assert.deepEqual(store.status(), { jobs: {}, total: 0 });
  assert.deepEqual(store.admit({ id: 'job-1', threadKey: 'T1:C1:1.0', payload: { a: 1 } }, 10),
    { admitted: true });
  assert.deepEqual(store.admit({ id: 'job-1', threadKey: 'T1:C1:1.0', payload: { a: 2 } }, 11),
    { admitted: false }, 'a repeated hand-off keeps the first row');
  assert.deepEqual(store.admit({ id: 'job-2', threadKey: 'T1:C1:1.0', payload: null }, 12),
    { admitted: true });
  assert.deepEqual(store.status(), { jobs: { admitted: 2 }, total: 2 });
  assert.equal(store.openCount(), 2);
  assert.throws(() => store.admit({ id: '', threadKey: 'T1:C1:1.0', payload: null }, 13), /id and a thread key/);
  assert.throws(() => store.admit({ id: 'job-3', threadKey: '', payload: null }, 13), /id and a thread key/);
});

test('settled jobs are forgotten after a week unless their outcome is unrecorded', () => {
  const store = new ThreadRunnerJobStore(new NodeStateDb(new DatabaseSync(':memory:')));
  const week = 7 * 24 * 60 * 60 * 1_000;
  store.admit({ id: 'done', threadKey: 'k', payload: null }, 1);
  store.admit({ id: 'unsynced', threadKey: 'k', payload: null }, 2);
  store.admit({ id: 'open', threadKey: 'k', payload: null }, 3);
  store.settle('done', 'done', 10);
  store.settleTerminal('unsynced', 'done', 10);
  assert.equal(store.purge(11 + week), 0, 'a settled turn first owes its cleanup check');
  assert.deepEqual(store.dueCleanups(10).map((job) => job.id), ['done']);
  store.scheduleCleanup('done', undefined, 1);
  assert.equal(store.purge(10 + week), 0);
  assert.equal(store.purge(11 + week), 1);
  assert.deepEqual(store.unsyncedTerminals().map((job) => job.id), ['unsynced']);
  assert.deepEqual(store.status().jobs, { admitted: 1, done: 1 });
});

test('the job store tells a new instance that a job was running', () => {
  const store = new ThreadRunnerJobStore(new NodeStateDb(new DatabaseSync(':memory:')));
  store.admit({ id: 'job', threadKey: 'k', payload: null }, 1);
  assert.equal(store.hasRunning(), false);
  store.markRunning('job');
  assert.equal(store.hasRunning(), true);
});

test('a runner instance resumes a running job at once and starts admitted jobs in the admitting request', () => {
  const runner = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  // On first load after a replacement: a running job re-arms the alarm now.
  assert.match(runner, /blockConcurrencyWhile\(async \(\) => \{\s*try \{\s*if \(!this\.store\(\)\.hasRunning\(\)\) return;[\s\S]{0,200}setAlarm\(Date\.now\(\)\)/);
  // admit starts the loop in the same request; the alarm is the backstop.
  assert.match(runner, /this\.wake\?\.\(\);\s*void this\.runSoon\(\);/);
  assert.match(runner, /async alarm\(\): Promise<void> \{\s*await this\.runSoon\(\);/);
});

test('the Worker entry exports SlackThreadRunner for its v11 binding', () => {
  const entry = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  assert.match(entry, /export \{ SlackThreadRunner \} from '\.\/slack\/thread-runner\.ts';/);
});

test('the runner executes through the shared turn executor as the runner executor', () => {
  const runner = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  assert.match(runner, /executeTurnJob\(job, ports, \{\s*latency: \{ lane: 'cloudflare', executor: 'runner' \}/);
  assert.match(runner, /observationRoute: \{ executor: 'runner'/);
  assert.match(runner, /statusRegistry: this\.registry/);
});
