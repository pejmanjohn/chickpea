import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { activityStatus } from '../src/activity/status.ts';
import {
  carriedGatewayIdentity,
  resetIdentityVerificationsForTests,
  seedGatewayIdentity,
} from '../src/slack/installation-execution.ts';
import { parseAdmissionAgentWake } from '../src/slack/admission-agent-wake.ts';
import { parseAdmissionStatusMark } from '../src/slack/admission-activity.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
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

test('a runner instance resumes a running job at once and runs admitted jobs only in its alarm', () => {
  const runner = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  // On first load after a replacement: a running job, or a stop that still
  // owes its abort or coding cascade, re-arms the alarm now.
  // A runner without its job table (one a receipt woke) has nothing to
  // resume, and checking for the table creates none.
  assert.match(runner, /blockConcurrencyWhile\(async \(\) => \{\s*try \{[\s\S]{0,200}if \(!ThreadRunnerJobStore\.existsIn\(new DoSqlStateDb\(this\.ctx\.storage\)\)\) return;\s*if \(!this\.store\(\)\.hasRunning\(\) && !this\.store\(\)\.hasOwedStops\(\)\) return;[\s\S]{0,200}setAlarm\(Date\.now\(\)\)/);
  // admit never starts the loop in the admitting request (work left running
  // after it returns loses its logs and is not resumed after a replacement):
  // it wakes a running drain and makes the alarm due now, keeping an earlier one.
  const admit = runner.slice(runner.indexOf('async admit('), runner.indexOf('async status('));
  assert.doesNotMatch(admit, /runSoon|runAlarm/);
  assert.match(admit, /this\.wakeDrain\?\.\(\);\s*const existing = await this\.ctx\.storage\.getAlarm\(\);\s*if \(existing === null \|\| existing > Date\.now\(\)\) await this\.ctx\.storage\.setAlarm\(Date\.now\(\)\);/);
  assert.equal(runner.match(/this\.runSoon\(\)/g)?.length, 1, 'only the alarm runs the loop');
  assert.match(runner, /async alarm\(\): Promise<void> \{\s*this\.boot\.call\('alarm'\);\s*await this\.runSoon\(\);/);
});

test('every runner entry point reports its call to the activation marks before it touches the instance', () => {
  const path = new URL('../src/slack/thread-runner.ts', import.meta.url);
  const source = ts.createSourceFile('thread-runner.ts', readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const runner = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'SlackThreadRunner');
  assert.ok(runner);
  // The first statement that reaches the instance (a plain local may come before it).
  const firstStatement = (method: ts.MethodDeclaration) =>
    method.body?.statements.map((statement) => statement.getText(source))
      .find((text) => text.includes('this.')) ?? '';
  const methods = runner.members.filter((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member));
  const entries = methods.filter((method) =>
    !method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
  assert.ok(entries.length >= 10, 'the RPC methods, the alarm and the host functions');
  for (const method of entries) {
    const name = method.name.getText(source);
    // A missed entry point would credit its activation to a later call.
    if (name.startsWith('chickpeaHost')) {
      assert.match(firstStatement(method), new RegExp(`^return this\\.host\\(\\)\\.${name}\\(`), name);
    } else {
      assert.equal(firstStatement(method).startsWith(`this.boot.call('${name}'`), true, name);
    }
  }
  const host = methods.find((method) => method.name.getText(source) === 'host');
  assert.equal(host && firstStatement(host), "this.boot.call('host');");
  // The constructor's end is marked however its resume check exits.
  assert.match(readFileSync(path, 'utf8'), /\} finally \{\s*this\.boot\.constructed\(\);\s*\}\s*\}\);/);
});

test("the runner's admit reports the hand-off's send time and keeps its delay for that job's first attempt", async () => {
  const text = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('thread-runner.ts', text, ts.ScriptTarget.Latest, true);
  const runner = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'SlackThreadRunner');
  const member = (name: string) => runner?.members.find((node) =>
    (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && node.name.getText(source) === name);
  const parts = ['handoffs', 'admit', 'takeHandoff'].map(member);
  assert.ok(parts.every(Boolean));
  const AdmitProbe = vm.runInNewContext(
    ts.transpileModule(`class AdmitProbe { ${parts.map((part) => part!.getText(source)).join('\n')} }\nAdmitProbe`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { Date: { now: () => 70_000 }, assertInstallationOwnership: () => undefined, seedGatewayIdentity, parseAdmissionAgentWake, parseAdmissionStatusMark, console },
  ) as new () => Record<string, unknown> & {
    admit(job: unknown): Promise<Record<string, unknown>>;
    takeHandoff(jobId: string): { latency: Record<string, unknown> };
  };
  const probe = () => {
    const marks: unknown[][] = [];
    const answers = [{ admitted: true }];
    const instance = new AdmitProbe();
    Object.assign(instance, {
      env: {},
      boot: { call: (method: string, from: Record<string, unknown>) => marks.push([method, { ...from }]) },
      store: () => ({ admit: () => answers.shift() ?? { admitted: false } }),
      ctx: { storage: { getAlarm: async () => null, setAlarm: async () => undefined } },
    });
    return { instance, marks };
  };

  const sent = probe();
  assert.deepEqual({ ...await sent.instance.admit({ id: 'turn_1', threadKey: 'k', payload: {}, sentAt: 68_100 }) },
    { admitted: true });
  assert.deepEqual(sent.marks, [['admit', { sentAt: 68_100, turnJobId: 'turn_1' }]]);
  // The state store retrying a hand-off the runner already holds keeps the first delay.
  await sent.instance.admit({ id: 'turn_1', threadKey: 'k', payload: {}, sentAt: 69_500 });
  assert.deepEqual({ ...sent.instance.takeHandoff('turn_2').latency }, {}, "another job never reads this job's delay");
  assert.deepEqual({ ...sent.instance.takeHandoff('turn_1').latency }, { handoffMs: 1_900 });
  assert.deepEqual({ ...sent.instance.takeHandoff('turn_1').latency }, {}, 'a later attempt of the job carries none');

  // A state store on an older version sends no clock: no delay, no send time.
  const older = probe();
  assert.deepEqual({ ...await older.instance.admit({ id: 'turn_1', threadKey: 'k', payload: {} }) },
    { admitted: true });
  assert.deepEqual(older.marks, [['admit', { sentAt: undefined, turnJobId: 'turn_1' }]]);
  assert.deepEqual({ ...older.instance.takeHandoff('turn_1').latency }, {});
});

// Defects caught: a runner that drops the carried identity (its turn asks
// Slack again before its first status), one that stores it with the job, and
// one that takes it from a hand-off of another installation.
test("the runner's admit takes a carried gateway identity into its cache and stores no payload", async () => {
  const text = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('thread-runner.ts', text, ts.ScriptTarget.Latest, true);
  const runner = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'SlackThreadRunner');
  const admit = runner?.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === 'admit');
  assert.ok(admit);
  const AdmitProbe = vm.runInNewContext(
    ts.transpileModule(`class AdmitProbe { handoffs = new Map();\n${admit.getText(source)} }\nAdmitProbe`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      Date,
      assertInstallationOwnership: (installation: unknown) => {
        if (installation === 'another') throw new Error('installation mismatch');
      },
      seedGatewayIdentity,
      parseAdmissionAgentWake,
      parseAdmissionStatusMark,
      console: { warn() {} },
    },
  ) as new () => { admit(job: unknown): Promise<Record<string, unknown>> };
  const stored: unknown[] = [];
  const instance = Object.assign(new AdmitProbe(), {
    env: {},
    boot: { call() {} },
    store: () => ({
      admit: (job: { payload: unknown }) => {
        stored.push(job.payload);
        return { admitted: true };
      },
    }),
    ctx: { storage: { getAlarm: async () => null, setAlarm: async () => undefined } },
  });
  const installation = {
    workspaceId: 'TGATEWAY', transportMode: 'gateway' as const, gatewayBindingId: 'binding_test', botUserId: 'UBOT',
  };
  const gatewayIdentity = {
    workspaceId: 'TGATEWAY', bindingId: 'binding_test', botUserId: 'UBOT', expiresAt: Date.now() + 30_000,
  };
  resetIdentityVerificationsForTests();
  try {
    await instance.admit({ id: 'turn_other', threadKey: 'k', payload: { gatewayIdentity }, installation: 'another' });
    assert.equal(carriedGatewayIdentity(installation), undefined, 'another installation\'s hand-off seeds nothing');

    await instance.admit({ id: 'turn_1', threadKey: 'k', payload: { gatewayIdentity } });
    assert.deepEqual(carriedGatewayIdentity(installation), gatewayIdentity,
      "the turn's resolution finds the state store's verification (no auth.test)");
    assert.equal(JSON.stringify(stored), '[{}]', 'the job is stored without its payload');
  } finally {
    resetIdentityVerificationsForTests();
  }
});

test('the Worker entry exports SlackThreadRunner for its v11 binding', () => {
  const entry = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  assert.match(entry, /export \{ SlackThreadRunner \} from '\.\/slack\/thread-runner\.ts';/);
});

test('the runner executes through the shared turn executor as the runner executor', () => {
  const runner = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  // The turn's latency context takes the hand-off delay of the job it runs,
  // and the turn the wake admission sent its Agent object; the turn runs
  // inside the reads its batch answers (turn-reads.ts).
  assert.match(runner, /const handoff = this\.takeHandoff\(job\.id\);[\s\S]{0,400}?prefetchTurnReads\(env, job,[\s\S]{0,200}?return withTurnReads\(reads, \(\) => executeTurnJob\(job, ports, \{\s*latency: \{ lane: 'cloudflare', executor: 'runner', \.\.\.handoff\.latency \},\s*\.\.\.\(handoff\.agentWake \? \{ agentWake: handoff\.agentWake \} : \{\}\),/);
  assert.match(runner, /observationRoute: \{ executor: 'runner'/);
  assert.match(runner, /statusRegistry: this\.registry/);
});

test('an older runner table gains the run-facts columns, and run facts round-trip per job', () => {
  const db = new NodeStateDb(new DatabaseSync(':memory:'));
  db.exec(`CREATE TABLE runner_jobs (
    id TEXT PRIMARY KEY,
    thread_key TEXT NOT NULL,
    job_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'admitted',
    admitted_at INTEGER NOT NULL
  )`);
  db.run("INSERT INTO runner_jobs (id, thread_key, job_json, state, admitted_at) VALUES ('old', 'k', 'null', 'running', 1)");
  const store = new ThreadRunnerJobStore(db);
  assert.equal(store.runFacts('old'), undefined, 'a row from an older release has no run facts');
  store.saveRunFacts('old', { startedAt: 10, step: 'Running the test suite…', progressAt: 20, milestones: 2 });
  assert.deepEqual(store.runFacts('old'), { startedAt: 10, step: 'Running the test suite…', progressAt: 20, milestones: 2 });
  store.saveRunFacts('old', { startedAt: 10, progressAt: 30, milestones: 3 });
  assert.deepEqual(store.runFacts('old'), { startedAt: 10, progressAt: 30, milestones: 3 });
  store.saveRunFacts('missing', { startedAt: 1, progressAt: 1, milestones: 0 });
  assert.equal(store.runFacts('missing'), undefined, 'facts belong to a job the runner holds');
  // A second store on the same storage (a new instance) reads them unchanged.
  assert.deepEqual(new ThreadRunnerJobStore(db).runFacts('old')?.progressAt, 30);
});

test('run facts survive a simulated eviction and read back through the runner status RPC', async (t) => {
  const start = 1_790_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const db = new NodeStateDb(new DatabaseSync(':memory:'));
  // Wired as SlackThreadRunner wires its registry to its job store.
  const runner = () => {
    const jobs = new ThreadRunnerJobStore(db);
    return new SlackStatusRegistry({
      runFacts: { load: (id) => jobs.runFacts(id), save: (id, facts) => jobs.saveRunFacts(id, facts) },
    });
  };
  new ThreadRunnerJobStore(db).admit({ id: 'turn-1', threadKey: 'T1:C1:1.0', payload: null }, start);
  const before = runner();
  const shown: string[] = [];
  before.registerTurn('agent-instance', {
    setStatus: async (update) => { shown.push(update.text); return true; },
    showNativeIndicator: async () => { shown.push('native'); return true; },
  }, { generation: 'turn-1', observedMinIntervalMs: 1 });
  t.mock.timers.tick(10_000);
  before.setObservedStatus('agent-instance', 'turn-1', activityStatus('running', 'Running', 'the test suite', 'workspace'));
  // The throttle saves within 30 s; the object is then evicted mid-turn
  // (nothing closes the turn).
  t.mock.timers.tick(20_000);

  const after = runner();
  assert.deepEqual(after.runFactsView('turn-1'), {
    startedAt: start,
    step: 'Running the test suite…',
    progressAt: start + 10_000,
    at: start + 30_000,
  }, 'read from storage: no live turn in the new instance');
  t.mock.timers.tick(12 * 60_000 - 30_000 + 10_000);
  assert.equal(after.runFactsView('turn-1')?.quietFor, '10+');
  assert.equal(after.runFactsView('turn-unknown'), undefined);

  const source = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  // The runner's registry persists run facts in its own job store...
  assert.match(source, /new SlackStatusRegistry\(\{[\s\S]{0,300}load: \(id\) => this\.store\(\)\.runFacts\(id\)[\s\S]{0,120}save: \(id, facts\) => this\.store\(\)\.saveRunFacts\(id, facts\)/);
  // ...and its status RPC reads them through that registry.
  const rpc = source.slice(source.indexOf('async runFacts('), source.indexOf('async presentationGet('));
  assert.match(rpc, /this\.registry\.runFactsView\(turnJobId\)/);
});

const STOP_NOTICE = {
  turnJobId: 'turn-1',
  runnerKey: 'T1:C1:1.0',
  executor: 'runner' as const,
  record: {
    schemaVersion: 1 as const, role: 'stopped' as const, source: 'typed' as const,
    stopperUserId: 'U1', cutoffTs: '1.5', stoppedAt: 10,
  },
  attempts: 0,
  instanceId: 'agent',
};

test('a stop marker keeps its first decision, merges later coordinates, and keeps its first coding report', () => {
  const store = new ThreadRunnerJobStore(new NodeStateDb(new DatabaseSync(':memory:')));
  const first = store.recordStop(STOP_NOTICE, { abort: 'owed', cascade: 'owed' }, 100);
  assert.deepEqual(first, {
    turnJobId: 'turn-1', notice: STOP_NOTICE, abort: 'owed', abortAttempts: 0, cascade: 'owed', receivedAt: 100,
  });
  assert.equal(store.hasOwedStops(), true);
  assert.deepEqual(store.owedStops().map((marker) => marker.turnJobId), ['turn-1']);
  // A redelivery adds the receipt and the guest Sandbox the first notice
  // lacked; its own decision is ignored.
  const guestSandboxKey = `sandbox_${'a'.repeat(40)}`;
  const merged = store.recordStop(
    { ...STOP_NOTICE, attempts: 2, uid: 'uid-1', submissionId: 'sub-1', guestSandboxKey },
    { abort: 'none', cascade: 'none' },
    200,
  );
  assert.equal(merged.abort, 'owed');
  assert.equal(merged.receivedAt, 100);
  assert.deepEqual(merged.notice, { ...STOP_NOTICE, attempts: 2, uid: 'uid-1', submissionId: 'sub-1', guestSandboxKey });
  assert.equal(
    store.recordStop({ ...STOP_NOTICE, attempts: 3 }, { abort: 'none', cascade: 'none' }, 300).notice?.guestSandboxKey,
    guestSandboxKey,
    'a later notice without the key never drops it',
  );
  store.updateStop('turn-1', { abort: 'done', abortAttempts: 1, abortedSubmissionId: 'sub-1' });
  const report = { recordsRead: true, allSettled: true, tasks: [] };
  assert.deepEqual(store.saveCodingStopReport('turn-1', report), report);
  assert.deepEqual(store.saveCodingStopReport('turn-1', { recordsRead: false, allSettled: false, tasks: [] }),
    report, 'the first report stands');
  assert.deepEqual({ ...store.stopMarker('turn-1'), notice: undefined }, {
    turnJobId: 'turn-1', notice: undefined, abort: 'done', abortAttempts: 1,
    abortedSubmissionId: 'sub-1', cascade: 'done', codingReport: report, receivedAt: 100,
  });
  assert.equal(store.hasOwedStops(), false);
  assert.equal(store.stopMarker('unknown'), undefined);
});

test('a stopped ending is counted once for the alarm record, and a settled stop is forgotten after a week', () => {
  const db = new NodeStateDb(new DatabaseSync(':memory:'));
  const store = new ThreadRunnerJobStore(db);
  const week = 7 * 24 * 60 * 60 * 1_000;
  assert.equal(store.recordStopEnding('head', 'dropped', 2, 10), true);
  assert.equal(store.recordStopEnding('head', 'dropped', 2, 11), false, 'a replayed ending');
  assert.equal(store.recordStopEnding('race', 'released', 3, 12), true);
  assert.equal(store.takeUnreportedDrops(), 2, 'released rows are not dropped');
  assert.equal(store.takeUnreportedDrops(), 0);
  store.admit({ id: 'kept', threadKey: 'k', payload: null }, 1);
  store.recordStop({ ...STOP_NOTICE, turnJobId: 'kept' }, { abort: 'none', cascade: 'none' }, 1);
  store.recordStop({ ...STOP_NOTICE, turnJobId: 'owed' }, { abort: 'owed', cascade: 'none' }, 1);
  store.purge(20 + week);
  assert.equal(store.stopMarker('head'), undefined);
  assert.equal(store.stopMarker('race'), undefined);
  assert.ok(store.stopMarker('kept'), 'its job is still held here');
  assert.ok(store.stopMarker('owed'), 'it still owes its abort');
});

test('an admitted or yielded job is made due; a running or settled one is left as it is', () => {
  const store = new ThreadRunnerJobStore(new NodeStateDb(new DatabaseSync(':memory:')));
  for (const id of ['admitted', 'yielded', 'deferred']) store.admit({ id, threadKey: 'k', payload: null }, 1);
  store.settle('admitted', 'admitted', 1, 5_000);
  store.settle('yielded', 'yielded', 1, 5_000);
  store.settle('deferred', 'deferred', 1, 5_000);
  for (const id of ['admitted', 'yielded', 'deferred']) store.makeDue(id);
  assert.equal(store.get('admitted')!.retryAt, undefined);
  assert.equal(store.get('yielded')!.retryAt, undefined);
  assert.equal(store.get('deferred')!.retryAt, 5_000);
});

test("the runner's stop RPC persists the stop first, leaves slow work to its alarm, and aborts through the dispatch envelope's handle", () => {
  const runner = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  const rpc = runner.slice(runner.indexOf('async stop('), runner.indexOf('async status('));
  // Persist (and abort) through the runner's stops, then make the alarm due
  // now as admit does; never run the loop or a cascade in the RPC's request.
  assert.match(rpc, /taken = await this\.stops\(\)\.receive\(notice\);[\s\S]*this\.wakeDrain\?\.\(\);\s*const existing = await this\.ctx\.storage\.getAlarm\(\);\s*if \(existing === null \|\| existing > Date\.now\(\)\) await this\.ctx\.storage\.setAlarm\(Date\.now\(\)\);/);
  assert.doesNotMatch(rpc, /runSoon|runAlarm|codingReport|stopCodingTasks/);
  assert.match(rpc, /return \{ acknowledged: false \};/, 'a stop it could not persist stays owed');
  // The host abort is the Flue handle built from the persisted envelope, and
  // the cascade reads the host turn's records on the Sandbox the notice
  // names: a guest's own, else the thread's. No row read: the row may be
  // delivered or parked by the time a cascade runs.
  assert.match(runner, /abortHost: \(target\) => abortSlackThreadAgent\(target\)/);
  assert.match(runner, /turnSandboxKey: notice\.guestSandboxKey \?\? sandboxThreadKey\(notice\.runnerKey\),\s*hostTurnId: notice\.turnJobId,\s*workers: cloudflareCodingWorkerStopClient\(env\)/);
  assert.doesNotMatch(runner, /stateStore\(\)\.view\(notice/);
  assert.match(runner, /env\.SANDBOX \?\? env\.Sandbox\s*\?\s*\{\s*stopCodingTasks:/,
    'no Sandbox binding, no coding job: a stop owes no cascade');
  // The alarm runs what each stop owes, and the turn port reports receipts
  // and settlements to it.
  assert.match(runner, /turnJobs: runnerTurnJobsPort\(rows, jobs, Date\.now, this\.stops\(\)\)/);
  assert.match(runner, /stops: this\.stops\(\),/);
  // R22: the executor reads a stop the runner took, else the state store's row.
  assert.match(runner, /stopRecorded: \(\) => runnerStopRecorded\(jobs, rows, job\.id\),/);
  // The state store's outbox reaches it with no compatibility cast, and a
  // runner that does not answer in time counts as not acknowledged.
  const entry = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  assert.match(entry, /const taken = await boundedStopCall\(runner\.stop\(notice\), STOP_NOTICE_DELIVERY_TIMEOUT_MS\);\s*return taken\.acknowledged === true;/);
  assert.doesNotMatch(entry, /Partial<TurnStopNoticeReceiver>/);
  assert.match(entry, /this\.stopAborts\.run\(notice\.runnerKey, \(\) => receiveAlarmExecutorStop\(\s*stores\.turnJobs\.runnerView\(notice\.turnJobId\),\s*\(target\) => abortSlackThreadAgent\(target\),\s*\(\) => stores\.turnJobs\.runnerView\(notice\.turnJobId\),\s*\)\)/,
    "the alarm executor's own turns are aborted in-process, inside their thread's fence");
  assert.match(entry, /await this\.stopAborts\.clear\(threadKeyOf\(job\)\);\s*const jobStartedAt = Date\.now\(\);/,
    'the alarm starts no turn of a thread while its stop abort is out');
});
