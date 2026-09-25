import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { NodeStateDb } from '../src/state/node-state-db.ts';

interface RunnerProbe {
  admit(job: unknown): Promise<{ admitted: boolean }>;
  status(): Promise<{ jobs: Record<string, number>; total: number }>;
  alarm(): Promise<void>;
}

/**
 * Compile the Durable Object class alone (the real `cloudflare:workers`
 * module exists only on workerd) against Node SQLite and a fake alarm.
 */
function runnerProbe(clock: () => number) {
  const source = ts.createSourceFile('thread-runner.ts',
    readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) =>
    ts.isClassDeclaration(node) && node.name?.text === 'SlackThreadRunner');
  assert.ok(declaration, 'src/slack/thread-runner.ts declares SlackThreadRunner');
  const compiled = ts.transpileModule(
    declaration.getText(source).replace(/^export /u, '') + '\nSlackThreadRunner',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const db = new NodeStateDb(new DatabaseSync(':memory:'));
  const logs: unknown[] = [];
  let alarmAt: number | null = null;
  const alarmWrites: number[] = [];
  const storage = {
    getAlarm: async () => alarmAt,
    setAlarm: async (time: number) => { alarmAt = time; alarmWrites.push(time); },
    deleteAlarm: async () => { alarmAt = null; },
  };
  const Runner = vm.runInNewContext(compiled, {
    DurableObject: class {
      constructor(public ctx: unknown, public env: unknown) {}
    },
    DoSqlStateDb: class { constructor() { return db; } },
    ThreadRunnerJobStore,
    Date: { now: clock },
    console: { info: (entry: unknown) => logs.push(structuredClone(entry)) },
  }) as new (ctx: object, env: object) => RunnerProbe;
  return {
    runner: new Runner({ storage }, {}),
    logs,
    alarmWrites,
    fire: () => { alarmAt = null; },
  };
}

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
  assert.throws(() => store.admit({ id: '', threadKey: 'T1:C1:1.0', payload: null }, 13), /id and a thread key/);
  assert.throws(() => store.admit({ id: 'job-3', threadKey: '', payload: null }, 13), /id and a thread key/);
});

test('SlackThreadRunner admits durably, arms its alarm once, and its alarm executes nothing', async () => {
  let now = 1_000;
  const probe = runnerProbe(() => now);
  const { runner } = probe;
  assert.equal(typeof runner.admit, 'function');
  assert.equal(typeof runner.status, 'function');
  assert.equal(typeof runner.alarm, 'function');

  // An alarm on an empty table (eviction, stale platform retry) never throws.
  await runner.alarm();
  assert.deepEqual(probe.logs, [
    { component: 'runtime', event: 'thread_runner_alarm', jobs: 0, executor: 'none' },
  ]);

  assert.deepEqual(await runner.admit({ id: 'job-1', threadKey: 'T1:C1:1.0', payload: {} }), { admitted: true });
  now += 50;
  await runner.admit({ id: 'job-2', threadKey: 'T1:C1:1.0', payload: {} });
  assert.deepEqual(probe.alarmWrites, [1_000], 'an armed alarm is never postponed');
  assert.deepEqual(await runner.status(), { jobs: { admitted: 2 }, total: 2 });

  probe.fire();
  await runner.alarm();
  assert.deepEqual(probe.logs.at(-1),
    { component: 'runtime', event: 'thread_runner_alarm', jobs: 2, executor: 'none' });
  assert.deepEqual(await runner.status(), { jobs: { admitted: 2 }, total: 2 },
    'no executor is enabled, so rows stay admitted');
  assert.deepEqual(probe.alarmWrites, [1_000], 'the inactive alarm does not re-arm itself');
});

test('the Worker entry exports SlackThreadRunner for its v11 binding', () => {
  const entry = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  assert.match(entry, /export \{ SlackThreadRunner \} from '\.\/slack\/thread-runner\.ts';/);
});
