import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHICKPEA_CODING_WORKER_AGENT_NAME } from '../src/agents/names.ts';
import type { SandboxPolicyStorage } from '../src/sandbox/cloudflare-policy.ts';
import {
  parseCodingTaskRecord,
  putStoredCodingTask,
  readStoredCodingTasks,
  settleStoredCodingTask,
  workspaceTaskDispatchKey,
  type CodingTaskRecordV1,
} from '../src/sandbox/coding-task-record.ts';
import {
  cloudflareCodingWorkerStopClient,
  stopCodingTasks,
  threadCodingTaskStopPorts,
  type CodingTaskStopPorts,
  type CodingWorkerStopClient,
} from '../src/sandbox/coding-task-stop.ts';

function memoryStorage(): SandboxPolicyStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, structuredClone(value)); },
  };
}

function pending(toolCallId: string, instanceId: string, workspace = 'main'): CodingTaskRecordV1 {
  return {
    schemaVersion: 1,
    taskKey: workspaceTaskDispatchKey(toolCallId),
    toolCallId,
    workspace,
    workspaceId: `sandbox_${workspace}`,
    instanceId,
    state: 'dispatch_pending',
    pendingAt: 1_000,
    timeoutMs: 60 * 60_000,
  };
}

function accepted(toolCallId: string, instanceId: string, workspace = 'main'): CodingTaskRecordV1 {
  return {
    ...pending(toolCallId, instanceId, workspace),
    state: 'accepted',
    submissionId: `sub-${toolCallId}`,
    uid: 'uid-1',
    acceptedAt: '2026-09-26T00:00:00.000Z',
  };
}

// --- records -----------------------------------------------------------------

test('a host turn keeps one record per coding job, upserted by its dispatch key and dropped once it settles', async () => {
  const storage = memoryStorage();
  await putStoredCodingTask(storage, 'turn-1', pending('call-a', 'worker-a'), 10);
  await putStoredCodingTask(storage, 'turn-1', accepted('call-a', 'worker-a'), 11);
  await putStoredCodingTask(storage, 'turn-1', pending('call-b', 'worker-b', 'web'), 12);
  await putStoredCodingTask(storage, 'turn-2', pending('call-c', 'worker-a'), 13);
  assert.deepEqual(await readStoredCodingTasks(storage, 'turn-1'), [
    accepted('call-a', 'worker-a'),
    pending('call-b', 'worker-b', 'web'),
  ]);
  assert.deepEqual(await readStoredCodingTasks(storage, 'turn-3'), []);

  await settleStoredCodingTask(storage, 'turn-1', workspaceTaskDispatchKey('call-a'), 14);
  await settleStoredCodingTask(storage, 'turn-1', workspaceTaskDispatchKey('call-a'), 15);
  assert.deepEqual(await readStoredCodingTasks(storage, 'turn-1'), [pending('call-b', 'worker-b', 'web')]);
  await settleStoredCodingTask(storage, 'turn-1', workspaceTaskDispatchKey('call-b'), 16);
  assert.deepEqual(await readStoredCodingTasks(storage, 'turn-1'), []);
  // A turn with nothing left is dropped; another turn's records are untouched.
  const [stored] = [...storage.values.values()] as Array<{ turns: Array<{ turnId: string }> }>;
  assert.deepEqual(stored!.turns.map((turn) => turn.turnId), ['turn-2']);
});

test('records are validated on write, and malformed stored entries are ignored on read', async () => {
  const storage = memoryStorage();
  const { submissionId: _dropped, ...noSubmission } = accepted('call-a', 'worker-a') as CodingTaskRecordV1 & { submissionId: string };
  await assert.rejects(putStoredCodingTask(storage, 'turn-1', noSubmission, 1), /record is invalid/);
  await assert.rejects(putStoredCodingTask(storage, '', pending('call-a', 'worker-a'), 1), /turn id is invalid/);
  assert.equal(parseCodingTaskRecord({ ...pending('call-a', 'worker-a'), schemaVersion: 2 }), undefined);

  await putStoredCodingTask(storage, 'turn-1', pending('call-a', 'worker-a'), 1);
  const [key, value] = [...storage.values.entries()][0] as [string, { turns: Array<{ tasks: unknown[] }> }];
  value.turns[0]!.tasks.push({ garbage: true }, { ...pending('call-b', 'worker-b'), state: 'running' });
  storage.values.set(key, value);
  assert.deepEqual(await readStoredCodingTasks(storage, 'turn-1'), [pending('call-a', 'worker-a')]);
  storage.values.set(key, 'not a record');
  assert.deepEqual(await readStoredCodingTasks(storage, 'turn-1'), []);
});

test('only the most recent host turns keep leftover records', async () => {
  const storage = memoryStorage();
  for (let index = 0; index < 12; index += 1) {
    await putStoredCodingTask(storage, `turn-${index}`, pending(`call-${index}`, 'worker-a'), 100 + index);
  }
  assert.deepEqual(await readStoredCodingTasks(storage, 'turn-0'), []);
  assert.equal((await readStoredCodingTasks(storage, 'turn-11')).length, 1);
  const [stored] = [...storage.values.values()] as Array<{ turns: unknown[] }>;
  assert.equal(stored!.turns.length, 8);
});

// --- stop --------------------------------------------------------------------

interface FakeWorker {
  /** Replies of successive abort() calls: true while work was unsettled, or an error. */
  aborts: Array<boolean | Error>;
  /** The settlement outcome the worker reports, or undefined to never settle. */
  settlement?: string;
}

function fakePorts(records: CodingTaskRecordV1[], workers: Record<string, FakeWorker>) {
  const store = new Map(records.map((record) => [record.taskKey, record]));
  const abortCalls: string[] = [];
  const settled: string[] = [];
  const client: CodingWorkerStopClient = {
    async abort(instanceId) {
      abortCalls.push(instanceId);
      const worker = workers[instanceId]!;
      const next = worker.aborts.length > 1 ? worker.aborts.shift()! : worker.aborts[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    awaitSettlement(instanceId, _submissionId, signal) {
      const outcome = workers[instanceId]!.settlement;
      if (outcome !== undefined) return Promise.resolve(outcome);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const ports: CodingTaskStopPorts = {
    listTasks: async () => [...store.values()],
    settleTask: async (taskKey) => {
      settled.push(taskKey);
      store.delete(taskKey);
    },
    workers: client,
  };
  return { ports, store, abortCalls, settled };
}

const FAST = { sleep: async () => {}, settlementWaitMs: 20 };

test('a stop aborts the worker from its record and reports it confirmed', async () => {
  const fake = fakePorts([accepted('call-a', 'worker-a')], {
    'worker-a': { aborts: [true, false], settlement: 'aborted' },
  });
  const report = await stopCodingTasks(fake.ports, FAST);
  assert.deepEqual(report, {
    recordsRead: true,
    allSettled: true,
    tasks: [{
      taskKey: 'workspace_task:call-a',
      toolCallId: 'call-a',
      workspace: 'main',
      workspaceId: 'sandbox_main',
      instanceId: 'worker-a',
      submissionId: 'sub-call-a',
      confirmed: true,
      outcome: 'stopped',
    }],
  });
  // abort() is repeated until the instance reports nothing unsettled.
  assert.deepEqual(fake.abortCalls, ['worker-a', 'worker-a']);
  assert.deepEqual(fake.settled, ['workspace_task:call-a']);
});

test('a stop with two coding jobs from one response aborts both, and reconciles a record whose dispatch never landed', async () => {
  const fake = fakePorts([
    accepted('call-a', 'worker-a', 'api'),
    pending('call-b', 'worker-b', 'web'),
  ], {
    'worker-a': { aborts: [true, false], settlement: 'aborted' },
    'worker-b': { aborts: [false] },
  });
  const report = await stopCodingTasks(fake.ports, FAST);
  assert.equal(report.allSettled, true);
  assert.deepEqual(report.tasks.map((task) => [task.workspace, task.confirmed, task.outcome]), [
    ['api', true, 'stopped'],
    ['web', true, 'not_dispatched'],
  ]);
  assert.deepEqual(new Set(fake.abortCalls), new Set(['worker-a', 'worker-b']));
  assert.deepEqual(fake.store.size, 0, 'neither record is left pending');

  // A pending record whose dispatch did land is stopped like any other.
  const landed = fakePorts([pending('call-c', 'worker-c')], { 'worker-c': { aborts: [true, true, false] } });
  const landedReport = await stopCodingTasks(landed.ports, FAST);
  assert.deepEqual(landedReport.tasks.map((task) => [task.confirmed, task.outcome]), [[true, 'stopped']]);
  assert.equal(landed.abortCalls.length, 3);
});

test('a worker abort() that fails once and then succeeds is confirmed', async () => {
  const fake = fakePorts([accepted('call-a', 'worker-a')], {
    'worker-a': { aborts: [new Error('worker unreachable'), false], settlement: 'aborted' },
  });
  const report = await stopCodingTasks(fake.ports, FAST);
  assert.deepEqual(report.tasks.map((task) => [task.confirmed, task.outcome]), [[true, 'stopped']]);
  assert.equal(fake.abortCalls.length, 2);
  assert.equal(report.allSettled, true);
});

test('a worker that never confirms within the bound is reported unconfirmed, and its record is kept', async () => {
  const busy = fakePorts([accepted('call-a', 'worker-a')], { 'worker-a': { aborts: [true], settlement: 'aborted' } });
  const busyReport = await stopCodingTasks(busy.ports, { ...FAST, abortAttempts: 3 });
  assert.deepEqual(busyReport.tasks.map((task) => [task.confirmed, task.outcome]), [[false, 'unconfirmed']]);
  assert.equal(busyReport.allSettled, false, 'an unconfirmed job keeps the coding active-work marker');
  assert.equal(busy.abortCalls.length, 3, 'abort() is repeated only within the bound');
  assert.equal(busy.store.size, 1);

  const failing = fakePorts([accepted('call-a', 'worker-a')], { 'worker-a': { aborts: [new Error('down')] } });
  const failingReport = await stopCodingTasks(failing.ports, { ...FAST, abortAttempts: 2 });
  assert.equal(failingReport.tasks[0]!.confirmed, false);

  // The instance is clear but the job's own settlement never shows.
  const silent = fakePorts([accepted('call-a', 'worker-a')], { 'worker-a': { aborts: [false] } });
  const started = Date.now();
  const silentReport = await stopCodingTasks(silent.ports, FAST);
  assert.deepEqual(silentReport.tasks.map((task) => [task.confirmed, task.outcome]), [[false, 'unconfirmed']]);
  assert.ok(Date.now() - started < 1_000, 'the settlement check is bounded');
  assert.equal(silent.store.size, 1);
});

test('a job that finished before the stop took effect is confirmed as finished', async () => {
  for (const settlement of ['completed', 'failed']) {
    const fake = fakePorts([accepted('call-a', 'worker-a')], { 'worker-a': { aborts: [false], settlement } });
    const report = await stopCodingTasks(fake.ports, FAST);
    assert.deepEqual(report.tasks.map((task) => [task.confirmed, task.outcome]), [[true, 'finished']], settlement);
  }
});

test('a run with no coding jobs has nothing to stop; unreadable records leave the stop unconfirmed', async () => {
  const none = await stopCodingTasks(fakePorts([], {}).ports, FAST);
  assert.deepEqual(none, { recordsRead: true, allSettled: true, tasks: [] });

  let reads = 0;
  const unreadable = await stopCodingTasks({
    listTasks: async () => { reads += 1; throw new Error('sandbox unreachable'); },
    settleTask: async () => {},
    workers: fakePorts([], {}).ports.workers,
  }, { ...FAST, abortAttempts: 2 });
  assert.deepEqual(unreadable, { recordsRead: false, allSettled: false, tasks: [] });
  assert.equal(reads, 2);
});

test('a failed record removal never unconfirms a job the stop confirmed', async () => {
  const fake = fakePorts([accepted('call-a', 'worker-a')], { 'worker-a': { aborts: [false], settlement: 'aborted' } });
  fake.ports.settleTask = async () => { throw new Error('sandbox unreachable'); };
  const report = await stopCodingTasks(fake.ports, FAST);
  assert.equal(report.tasks[0]!.confirmed, true);
  assert.equal(report.allSettled, true);
});

test('the stop report carries the pull request the job\'s workspace recorded for the host turn', async () => {
  const fake = fakePorts([accepted('call-a', 'worker-a', 'api')], { 'worker-a': { aborts: [false], settlement: 'aborted' } });
  const pullRequest = { number: 4, url: 'https://github.com/acme/api/pull/4', repository: 'acme/api', branch: 'fix' };
  fake.ports.recordedPullRequest = async (workspaceId) => (workspaceId === 'sandbox_api' ? pullRequest : undefined);
  const report = await stopCodingTasks(fake.ports, FAST);
  assert.deepEqual(report.tasks[0]!.pullRequest, pullRequest);
});

// --- ports -------------------------------------------------------------------

test('the thread ports read the host turn\'s records from the thread Sandbox and the pull request from the job\'s workspace', async () => {
  const thread = memoryStorage();
  await putStoredCodingTask(thread, 'turn-1', accepted('call-a', 'worker-a', 'api'), 1);
  await putStoredCodingTask(thread, 'turn-9', accepted('call-z', 'worker-z'), 1);
  const opened: string[] = [];
  const turnIds: Record<string, string> = { sandbox_api: 'turn-1', sandbox_web: 'turn-0' };
  const pullRequest = { number: 4, url: 'https://github.com/acme/api/pull/4', repository: 'acme/api' };
  const sandboxes = (sandboxKey: string) => [0, 1].map((identity) => () => {
    opened.push(`${sandboxKey}#${identity}`);
    return {
      async getTurnId() { return identity === 0 ? turnIds[sandboxKey] : undefined; },
      async getTurnProgress() { return { pullRequest }; },
      readCodingTasks: (turnId: string) => readStoredCodingTasks(thread, turnId),
      settleCodingTask: (turnId: string, taskKey: string) => settleStoredCodingTask(thread, turnId, taskKey, 2),
    };
  });
  const workers: CodingWorkerStopClient = { abort: async () => false, awaitSettlement: async () => 'aborted' };
  const ports = threadCodingTaskStopPorts({ sandboxes, turnSandboxKey: 'T1:C1:1.2', hostTurnId: 'turn-1', workers });
  assert.deepEqual((await ports.listTasks()).map((task) => task.toolCallId), ['call-a']);
  // The coordinator writes through the primary Sandbox identity only.
  assert.deepEqual(opened, ['T1:C1:1.2#0']);
  assert.deepEqual(await ports.recordedPullRequest?.('sandbox_api'), pullRequest);
  assert.equal(await ports.recordedPullRequest?.('sandbox_web'), undefined, 'another turn\'s pull request is never reported');
  await ports.settleTask(workspaceTaskDispatchKey('call-a'));
  assert.deepEqual(await readStoredCodingTasks(thread, 'turn-1'), []);
  assert.equal((await readStoredCodingTasks(thread, 'turn-9')).length, 1);
});

test('the Cloudflare worker client aborts through the worker\'s route and reads its settlement from the updates view', async () => {
  const requests: string[] = [];
  let abortReplies = [true, false];
  let pages = 0;
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: unknown) => ({
      async fetch(request: Request) {
        const { name } = id as { name: string };
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}${url.search ? '?view' : ''} @${name}`);
        if (request.method === 'POST') return Response.json({ aborted: abortReplies.shift() ?? false });
        pages += 1;
        const chunks = pages === 1
          ? [{ type: 'stream-checkpoint' }, { type: 'message-started', submissionId: 'sub-1' }]
          : [{ type: 'submission-settled', submissionId: 'sub-1', outcome: 'aborted' }];
        return Response.json(chunks, { headers: { 'Stream-Next-Offset': String(pages) } });
      },
    }),
  };
  const binding = `FLUE_${CHICKPEA_CODING_WORKER_AGENT_NAME.toUpperCase().replace(/-/g, '_')}_AGENT`;
  const client = cloudflareCodingWorkerStopClient({ [binding]: namespace }, { pollIntervalMs: 1 });
  assert.equal(await client.abort('codingworker_1'), true);
  assert.equal(await client.abort('codingworker_1'), false);
  assert.equal(await client.awaitSettlement('codingworker_1', 'sub-1', new AbortController().signal), 'aborted');
  assert.deepEqual(requests.slice(0, 2), [
    `POST /agents/${CHICKPEA_CODING_WORKER_AGENT_NAME}/codingworker_1/abort @codingworker_1`,
    `POST /agents/${CHICKPEA_CODING_WORKER_AGENT_NAME}/codingworker_1/abort @codingworker_1`,
  ]);

  const failing = cloudflareCodingWorkerStopClient({
    [binding]: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response('no', { status: 503 }) }) },
  });
  await assert.rejects(failing.abort('codingworker_1'), /503/);
  // Without the binding there can be no coding jobs; only a use fails.
  await assert.rejects(cloudflareCodingWorkerStopClient({}).abort('codingworker_1'), /unavailable/);
  abortReplies = [];
});
