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

/** A start request as try_agent_once builds one, for this installation's caller. */
function startRequest(ask: string): { request: TestRunStartRequest; instanceId: string } {
  sequence += 1;
  const testRunId = `testrun_workerd_${sequence}`;
  const coordinateToken = `abcdefghijklmnopqrstuvwxy${'abcdefgh'[sequence]}`;
  const plan = compileTestRunPlan({
    assignment: ASSIGNMENT, runtimeModel: 'faux/test-run-probe',
    imageCapability: { role: 'image', filled: false, acceptsImageInput: false }, sandboxUnavailableFallback: false,
    websiteLogins: [], webSearch: false, connections: [],
  }, {
    workspaceId: 'T0WORKERD', actorMembershipId: 'membership_caller', testRunId, coordinateToken,
    installation: { version: 1, installationId: INSTALLATION_ID }, instructions: 'Answer.', memoryEpoch: 1,
  });
  return {
    instanceId: deriveRuntimePlanInstanceId(plan),
    request: {
      run: {
        testRunId, runToken: `tr_${testRunId}`, coordinateToken, organizationId: 'org_workerd',
        actorMembershipId: 'membership_caller', agentId: 'agent_tested', idempotencyKey: `key_${testRunId}`,
        usage: TestRunUsageRecorder.admission({
          testRunId, startedAt: Date.now(), workspaceId: 'T0WORKERD', agentId: 'agent_tested', agentLabel: 'Tested',
          requesterMembershipId: 'membership_caller', requestedModel: 'faux/test-run-probe', credentialRefId: null,
          credentialVersion: null,
        }),
      },
      message: ask,
      initialData: { runtimePlan: JSON.parse(JSON.stringify(plan)) as unknown, requester: { name: 'Pat', timezone: 'UTC', askedAt: Date.now() } },
    },
  };
}

interface Row { status: string; failure: string | null; submissionId: string | null; planJson: string | null; erasedAt: number | null; usageOperationId: string; result: { reply?: string; read?: string[] } | null }

/**
 * A test run's lifecycle on real workerd at installation tenancy, against a
 * real Flue agent object: admission and dispatch from the state store, the
 * settlement read across objects, the host erase, a cancellation mid-run,
 * the restore refusal while an instance is not erased, the 150-second bound
 * and the forced erase, and a restore inside a run whose instance is gone.
 */
test('a test run is admitted, dispatched, settled and erased on workerd, and its bounds hold', { timeout: 240_000 }, async () => {
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
    const until = async (testRunId: string, done: (row: Row) => boolean, what: string) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        await call('/pass', { mode: 'due' });
        const current = await row(testRunId);
        if (done(current)) return current;
        assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(current)}\n${worker!.output().slice(-4_000)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    // Answered: the reply is read across objects, the lock frees, the instance is erased.
    const answered = startRequest('Where is order 42?');
    const admitted = await call<TestRunStartResult>('/start', { request: answered.request });
    assert.equal(admitted.kind, 'admitted', JSON.stringify(admitted));
    const live = await row(answered.request.run.testRunId);
    assert.equal(live.status, 'running', 'its receipt bound the submission');
    assert.ok(live.submissionId);
    const done = await until(answered.request.run.testRunId, (current) => current.erasedAt !== null, 'answered and erased');
    assert.deepEqual([done.status, done.failure, done.planJson, done.result],
      ['answered', null, null, { reply: 'Order 42 shipped on Monday.', read: [] }]);
    assert.deepEqual(await call('/usage', { operationId: done.usageOperationId }),
      { status: 'completed', billingRunId: live.submissionId });
    assert.equal(await call('/restore-refusal'), null, 'every instance is erased: a restore may be prepared');
    const view = await call<TestRunView>('/observe', {
      query: { organizationId: 'org_workerd', actorMembershipId: 'membership_caller', runToken: answered.request.run.runToken },
    });
    assert.equal(view.status, 'answered');

    // A restore inside a run: the row comes back live, past its deadline. Its object was erased but is
    // still in memory, so its stream reads as an error, not as not found: the store's own bounds end it.
    await call('/restore-row', { testRunId: answered.request.run.testRunId });
    await call('/advance', { ms: 4 * MINUTE });
    await call('/pass', { mode: 'due' });
    const restored = await row(answered.request.run.testRunId);
    assert.deepEqual([restored.status, restored.failure, restored.erasedAt], ['failed', 'deadline', null],
      'failed at once, since 150 seconds have passed');
    assert.match(String(await call('/restore-refusal')), /a test run not yet erased/);
    await call('/advance', { ms: 6 * MINUTE });
    await until(answered.request.run.testRunId, (current) => current.erasedAt !== null, 'restored run erased at 10 minutes');

    // A cancellation mid-run: its instance is aborted and the run fails, freeing the lock.
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

    // An instance that never settles: aborted at 125 s, failed at 150 s whatever it reports, erased by 10 minutes.
    const stuck = startRequest('Please be slow about order 9.');
    assert.equal((await call<TestRunStartResult>('/start', { request: stuck.request })).kind, 'admitted');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await call('/advance', { ms: 150_000 });
    await call('/pass', { mode: 'due' });
    const deadline = await row(stuck.request.run.testRunId);
    assert.deepEqual([deadline.status, deadline.failure, deadline.planJson], ['failed', 'deadline', null]);
    assert.deepEqual(await call('/usage', { operationId: deadline.usageOperationId }),
      { status: 'interrupted', billingRunId: deadline.submissionId });
    // The lock is free while its instance waits to be erased.
    assert.equal((await call<TestRunStartResult>('/start', { request: startRequest('Where is order 3?').request })).kind, 'admitted');
    await call('/advance', { ms: 10 * MINUTE });
    const erased = await until(stuck.request.run.testRunId, (current) => current.erasedAt !== null, 'stuck run erased');
    assert.equal(erased.failure, 'deadline');
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
