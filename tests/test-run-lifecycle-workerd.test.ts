import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { compileTestRunPlan } from '../src/agents/test-run-plan.ts';
import { scopedObjectName } from '../src/config/installation-scope.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { TestRunStartRequest, TestRunStartResult, TestRunView } from '../src/management/test-run-types.ts';
import { practiceQuestionDigest } from '../src/management/test-runs.ts';
import { TEST_RUN_DEADLINE_MS, TEST_RUN_FORCED_ERASE_MS } from '../src/state/test-run-lifecycle.ts';
import { TestRunUsageRecorder } from '../src/usage/test-run-usage.ts';

// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { reserveVerificationPort } from '../scripts/lib/verification-ports.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'test-run', 'test-run-worker.ts');
const INSTALLATION_ID = 'inst_workerd_test_run';
const STORE = scopedObjectName({ installationId: INSTALLATION_ID }, 'state');
const MINUTE = 60_000;

const ASSIGNMENT: ResolvedAssignment = {
  workspaceId: 'T0WORKERD', channelId: 'D0WORKERD', agentId: 'agent_tested', model: 'faux/test-run-probe',
  runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
  agent: {
    id: 'agent_tested', kind: 'user', revision: 1, name: 'Tested', instructions: 'Answer.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
};

let sequence = 0;

/**
 * A start request as practice_agent builds one: by default the caller's
 * first question, which starts a conversation; with `practiceId`, a later
 * turn of that conversation.
 */
function startRequest(ask: string, options: { member?: string; practiceId?: string } = {}): { request: TestRunStartRequest; instanceId: string } {
  sequence += 1;
  const member = options.member ?? 'membership_caller';
  const testRunId = `testrun_workerd_${sequence}`;
  const coordinateToken = `abcdefghijklmnopqrstuvwxy${'abcdefghijklmnopqrstuvwxyz'[sequence]}`;
  const plan = compileTestRunPlan({
    assignment: ASSIGNMENT, runtimeModel: 'faux/test-run-probe',
    imageCapability: { role: 'image', filled: false, acceptsImageInput: false }, sandboxUnavailableFallback: false,
    websiteLogins: [], webSearch: false, connections: [],
  }, {
    workspaceId: 'T0WORKERD', actorMembershipId: member, testRunId, coordinateToken,
    installation: { version: 1, installationId: INSTALLATION_ID }, instructions: 'Answer.', memoryEpoch: 1,
  });
  return {
    instanceId: deriveRuntimePlanInstanceId(plan),
    request: {
      run: {
        testRunId, runToken: `tr_${testRunId}`, coordinateToken, organizationId: 'org_workerd',
        actorMembershipId: member, agentId: 'agent_tested', idempotencyKey: `key_${testRunId}`,
        practiceId: options.practiceId ?? null, newPracticeId: `pr_${testRunId}`,
        question: ask, questionDigest: practiceQuestionDigest('org_workerd', ask), planDigest: 'plan_workerd', admitted: {},
        usage: TestRunUsageRecorder.admission({
          testRunId, startedAt: Date.now(), workspaceId: 'T0WORKERD', agentId: 'agent_tested', agentLabel: 'Tested',
          requesterMembershipId: member, requestedModel: 'faux/test-run-probe', credentialRefId: null,
          credentialVersion: null,
        }),
      },
      initialData: { runtimePlan: JSON.parse(JSON.stringify(plan)) as unknown, requester: { name: 'Pat', timezone: 'UTC', askedAt: Date.now() } },
    },
  };
}

interface Row {
  status: string; failure: string | null; submissionId: string | null; planJson: string | null; erasedAt: number | null;
  usageOperationId: string; result: { reply?: string; read?: string[]; skills?: string[]; steps?: unknown[] } | null; practiceId: string | null;
  question: string | null; createdAt: number; settledAt: number | null;
}

/**
 * A practice run's lifecycle on real workerd at installation tenancy, against
 * a real Flue agent object: admission and dispatch from the state store, the
 * settlement read across objects, the host erase, a run nobody reads again,
 * runs side by side, a follow-up during its turn, a cancellation mid-run, the
 * restore refusal while an instance is not erased, the deadline a direct
 * message's timeout sets and the forced erase, a restore inside a run whose
 * instance is gone, and each run's erase an hour after it settles.
 */
test('a practice run is admitted, dispatched, settled and erased on workerd, and its bounds hold', { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-test-run-'));
  const configPath = join(root, 'wrangler.json');
  const port = await reserveVerificationPort();
  const compatibilityDate = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-test-run-lifecycle',
    main: FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    vars: { CHICKPEA_TENANCY: 'installation' },
    durable_objects: {
      bindings: [
        { name: 'STATE', class_name: 'TestRunStateStore' },
        { name: 'FLUE_CHICKPEA_TEST_TURN_V1_AGENT', class_name: 'FlueChickpeaTestTurnV1Agent' },
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['TestRunStateStore', 'FlueChickpeaTestTurnV1Agent'] }],
  }, null, 2));

  let worker: WorkerHandle | undefined;
  try {
    worker = startWorker(configPath, port);
    const origin = `http://127.0.0.1:${port}`;
    await waitForWorker(worker, `${origin}/`);
    const call = async <T>(path: string, body: Record<string, unknown> = {}): Promise<T> => {
      const response = await fetch(`${origin}${path}?store=${encodeURIComponent(STORE)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const text = await response.text();
      assert.equal(response.status, 200, `${path}: ${text}\n${worker!.output().slice(-4_000)}`);
      return JSON.parse(text) as T;
    };
    const row = (testRunId: string) => call<Row>('/row', { testRunId });
    /** Reads the row until `done`; with `alarmOnly`, nothing but the store's own alarm moves the run. */
    const until = async (testRunId: string, done: (row: Row) => boolean, what: string, alarmOnly = false) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (!alarmOnly) await call('/pass', { mode: 'due' });
        const current = await row(testRunId);
        if (done(current)) return current;
        assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(current)}\n${worker!.output().slice(-4_000)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    const reply = 'Order 42 shipped on Monday.';
    const ofCaller = (member: string, runToken: string) =>
      call<TestRunView | null>('/observe', { query: { organizationId: 'org_workerd', actorMembershipId: member, runToken } });

    // A dropped client: nobody reads the run again, and the store's alarm alone settles it and erases its instance.
    const dropped = startRequest('Where is order 5?');
    assert.equal((await call<TestRunStartResult>('/start', { request: dropped.request })).kind, 'admitted');
    const unread = await until(dropped.request.run.testRunId, (current) => current.erasedAt !== null, 'settled and erased by the alarm', true);
    assert.deepEqual([unread.status, unread.result?.reply], ['answered', reply]);

    // Answered: the reply is read across objects and the instance is erased.
    const answered = startRequest('Where is order 42?');
    const admitted = await call<TestRunStartResult>('/start', { request: answered.request });
    assert.equal(admitted.kind, 'admitted', JSON.stringify(admitted));
    const live = await row(answered.request.run.testRunId);
    assert.equal(live.status, 'running', 'its receipt bound the submission');
    assert.ok(live.submissionId);
    const done = await until(answered.request.run.testRunId, (current) => current.erasedAt !== null, 'answered and erased');
    assert.deepEqual([done.status, done.failure, done.planJson, done.result],
      ['answered', null, null, { reply: 'Order 42 shipped on Monday.', read: [], skills: [], steps: [] }]);
    assert.deepEqual(await call('/usage', { operationId: done.usageOperationId }),
      { status: 'completed', billingRunId: live.submissionId });
    assert.equal(await call('/restore-refusal'), null, 'every instance is erased: a restore may be prepared');
    const view = await call<TestRunView>('/observe', {
      query: { organizationId: 'org_workerd', actorMembershipId: 'membership_caller', runToken: answered.request.run.runToken },
    });
    assert.equal(view.status, 'answered');

    // A cancellation mid-run: its instance is aborted and the run fails.
    const cancelled = startRequest('Please be slow about order 7.');
    assert.equal((await call<TestRunStartResult>('/start', { request: cancelled.request })).kind, 'admitted');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const pass = await call<{ erased: number; unerased: number }>('/pass', { mode: 'cancel' });
    const afterCancel = await row(cancelled.request.run.testRunId);
    assert.deepEqual([afterCancel.status, afterCancel.failure, afterCancel.planJson], ['failed', 'cancelled', null]);
    assert.equal(pass.erased + pass.unerased, 1);
    if (afterCancel.erasedAt === null) {
      assert.match(String(await call('/restore-refusal')), /a test run not yet erased/, 'no restore while its instance holds data');
      await call('/advance', { ms: 10 * MINUTE });
      await until(cancelled.request.run.testRunId, (current) => current.erasedAt !== null, 'cancelled run erased');
    }
    assert.equal(await call('/restore-refusal'), null);

    // Two people at once, and one person in two conversations: nothing holds one for another.
    const together = [
      startRequest('Where is order 11?'),
      startRequest('Where is order 11?', { member: 'membership_other' }),
      startRequest('Where is order 12?'),
    ];
    const starts = await Promise.all(together.map(({ request }) => call<TestRunStartResult>('/start', { request })));
    assert.deepEqual(starts.map(({ kind }) => kind), ['admitted', 'admitted', 'admitted'], JSON.stringify(starts));
    const settled = [];
    for (const { request } of together) {
      settled.push(await until(request.run.testRunId, (current) => current.erasedAt !== null, `${request.run.testRunId} answered`));
    }
    assert.deepEqual(settled.map(({ status, result }) => [status, result?.reply]), Array(3).fill(['answered', reply]));
    assert.equal(new Set(settled.map(({ practiceId }) => practiceId)).size, 3, 'each its own conversation');
    assert.equal(await ofCaller('membership_other', together[0]!.request.run.runToken), null, 'one person never reads another\'s run');

    // A follow-up while its conversation's turn is still going waits for it; another member's stuck run holds no one else.
    const slow = startRequest('Please be slow about order 13.');
    assert.equal((await call<TestRunStartResult>('/start', { request: slow.request })).kind, 'admitted');
    const conversation = (await row(slow.request.run.testRunId)).practiceId!;
    const followUp = startRequest('And order 14?', { practiceId: conversation });
    assert.deepEqual(await call('/start', { request: followUp.request }), { kind: 'in_progress', runToken: slow.request.run.runToken });
    assert.equal(await row(followUp.request.run.testRunId), null, 'nothing stored or dispatched for it');
    const beside = startRequest('Where is order 15?', { member: 'membership_other' });
    assert.equal((await call<TestRunStartResult>('/start', { request: beside.request })).kind, 'admitted');
    const besideDone = await until(beside.request.run.testRunId, (current) => current.erasedAt !== null, 'answered beside a stuck run');
    assert.equal(besideDone.result?.reply, reply);
    assert.equal((await row(slow.request.run.testRunId)).status, 'running', 'the stuck run is still going');
    assert.equal(await ofCaller('membership_other', slow.request.run.runToken), null);
    await call('/pass', { mode: 'cancel' });
    assert.equal((await row(slow.request.run.testRunId)).failure, 'cancelled');
    await call('/advance', { ms: 10 * MINUTE });
    await until(slow.request.run.testRunId, (current) => current.erasedAt !== null, 'stuck run erased');

    // With every instance erased, the alarm wakes next an hour after the earliest run settled, and then every run goes, text and row.
    await ofCaller('membership_caller', cancelled.request.run.runToken);
    const oldest = await row(dropped.request.run.testRunId);
    assert.equal(await call('/alarm-at'), oldest.settledAt! + 60 * MINUTE);
    await call('/advance', { ms: 60 * MINUTE });
    await call('/wake');
    for (const { request } of [answered, dropped, ...together, slow, beside, cancelled]) {
      assert.equal(await row(request.run.testRunId), null, `${request.run.testRunId}: the run is gone`);
    }
    assert.equal(await ofCaller('membership_caller', answered.request.run.runToken), null, 'and its caller reads it no more');

    // A restore inside a run: the row comes back live, past its deadline. Its object was erased but is
    // still in memory, so its stream reads as an error, not as not found: the store's own bounds end it.
    const again = startRequest('Where is order 21?');
    assert.equal((await call<TestRunStartResult>('/start', { request: again.request })).kind, 'admitted');
    await until(again.request.run.testRunId, (current) => current.erasedAt !== null, 'answered and erased');
    await call('/restore-row', { testRunId: again.request.run.testRunId });
    await call('/advance', { ms: TEST_RUN_DEADLINE_MS });
    await call('/pass', { mode: 'due' });
    const restored = await row(again.request.run.testRunId);
    assert.deepEqual([restored.status, restored.failure, restored.erasedAt], ['failed', 'deadline', null],
      'failed at once, since its deadline has passed');
    assert.match(String(await call('/restore-refusal')), /a test run not yet erased/);
    await call('/advance', { ms: TEST_RUN_FORCED_ERASE_MS - TEST_RUN_DEADLINE_MS });
    await until(again.request.run.testRunId, (current) => current.erasedAt !== null, 'restored run erased at the forced bound');

    // An instance that never settles: aborted 5 s past Flue's timeout, failed 30 s past it whatever it reports, erased by the forced bound.
    const stuck = startRequest('Please be slow about order 9.');
    assert.equal((await call<TestRunStartResult>('/start', { request: stuck.request })).kind, 'admitted');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await call('/advance', { ms: TEST_RUN_DEADLINE_MS });
    await call('/pass', { mode: 'due' });
    const deadline = await row(stuck.request.run.testRunId);
    assert.deepEqual([deadline.status, deadline.failure, deadline.planJson], ['failed', 'deadline', null]);
    assert.deepEqual(await call('/usage', { operationId: deadline.usageOperationId }),
      { status: 'interrupted', billingRunId: deadline.submissionId });
    // Another run starts while its instance waits to be erased.
    const next = startRequest('Where is order 3?');
    assert.equal((await call<TestRunStartResult>('/start', { request: next.request })).kind, 'admitted');
    await call('/advance', { ms: TEST_RUN_FORCED_ERASE_MS - TEST_RUN_DEADLINE_MS });
    const erased = await until(stuck.request.run.testRunId, (current) => current.erasedAt !== null, 'stuck run erased');
    assert.equal(erased.failure, 'deadline');
    await until(next.request.run.testRunId, (current) => current.erasedAt !== null, 'the next run erased');

    // Runs that went to their deadline, past the hour since they started, still go only an hour after they settled.
    for (const { request } of [again, stuck, next]) {
      assert.notEqual((await row(request.run.testRunId))?.question ?? null, null, `${request.run.testRunId} keeps its text inside its hour`);
    }
    await call('/advance', { ms: 60 * MINUTE });
    await call('/wake');
    for (const { request } of [again, stuck, next]) {
      assert.equal(await row(request.run.testRunId), null, `${request.run.testRunId}: gone an hour after it settled`);
    }
  } finally {
    if (worker) await stopWorker(worker);
    rmSync(root, { recursive: true, force: true });
  }
});

interface WorkerHandle { child: ChildProcess; output(): string }

function startWorker(configPath: string, port: number): WorkerHandle {
  const child = spawn(WRANGLER, ['dev', '--config', configPath, '--port', String(port), '--inspector-port', '0'], {
    cwd: ROOT,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  return { child, output: () => output };
}

async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { handle.child.kill('SIGKILL'); resolve(); }, 5_000);
    handle.child.once('exit', () => { clearTimeout(timeout); resolve(); });
    handle.child.kill('SIGTERM');
  });
}

async function waitForWorker(handle: WorkerHandle, url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev did not become ready:\n${handle.output()}`);
}
