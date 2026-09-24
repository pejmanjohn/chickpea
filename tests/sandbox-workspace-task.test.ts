import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentInstanceNotFoundError,
  AgentRunError,
  type AgentReply,
  type ConversationStreamChunk,
  type DispatchReceipt,
  type Sandbox,
} from '@flue/runtime';

import { CodingWorker } from '../src/agents/coding-worker.ts';
import { CHICKPEA_SUBMISSION_DURABILITY } from '../src/agents/coding-worker-task.ts';
import { CHICKPEA_CODING_WORKER_AGENT_NAME } from '../src/agents/names.ts';
import { ChickpeaRoutineExecution } from '../src/agents/routine-execution.ts';
import { ChickpeaSlack } from '../src/agents/slack-thread.ts';
import type { RuntimePlanCodingModelV1, RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ActivityStatus } from '../src/activity/semantic.ts';
import {
  codingWorkerBindingForPlan,
  codingWorkerInstanceId,
  codingWorkerRepositoryGrants,
  parseCodingWorkerBinding,
  type CodingWorkerBindingV1,
} from '../src/sandbox/coding-worker-binding.ts';
import { CODING_WORKER_INSTRUCTIONS } from '../src/sandbox/coding-worker-instructions.ts';
import {
  DEFAULT_WORKSPACE_NAME,
  WorkspaceSession,
  defaultWorkspaceId,
  type WorkspaceSandboxStub,
} from '../src/sandbox/workspace-session.ts';
import {
  MAX_WORKSPACE_TASKS_PER_RESPONSE,
  WORKSPACE_TASK_TIMEOUT_MS,
  createProgressRelay,
  createWorkspaceTaskTool,
  pullRequestLinks,
  type CodingWorkerClient,
  type WorkspaceTaskResponseState,
} from '../src/sandbox/workspace-task.ts';
import { WORKSPACE_TOOL_NAMES } from '../src/sandbox/workspace-tools.ts';
import { CODING_WORKER_RUN_DATA_NAME, parseCodingWorkerRunModel } from '../src/slack/coding-worker-run.ts';
import { resultFromAgentReply } from '../src/slack/flue-dispatch.ts';
import { replyFooterModelLabel } from '../src/slack/message-format.ts';

const WORKSPACE_ID = defaultWorkspaceId('sandbox_' + 'a'.repeat(40));

const PLAN = {
  agentId: 'agent-1',
  model: 'anthropic/claude-sonnet-5',
  runtimeModel: 'anthropic/claude-sonnet-5',
  repositories: [
    { id: 'grant-1', fullName: 'acme/app' },
    { id: 'grant-2', fullName: '', allRepos: true as const, accountLogin: 'tools-org' },
  ],
} satisfies Partial<RuntimePlanV2>;

const CODING_MODEL: RuntimePlanCodingModelV1 = {
  model: 'openai/gpt-6',
  runtimeModel: 'openai/gpt-6',
  attribution: { role: 'coding', source: 'workspace_default', providerId: 'openai', fallback: false },
};

function plan(codingModel?: RuntimePlanCodingModelV1) {
  return {
    ...PLAN,
    codingWorkspace: { available: true as const, ...(codingModel ? { codingModel } : {}) },
  };
}

// --- binding -----------------------------------------------------------------

test('the worker binding carries the frozen coding model, or the Agent route when none is frozen', () => {
  const withRole = codingWorkerBindingForPlan(plan(CODING_MODEL), WORKSPACE_ID);
  assert.deepEqual(withRole, {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    agentId: 'agent-1',
    codingModel: { model: 'openai/gpt-6', runtimeModel: 'openai/gpt-6' },
    repositories: PLAN.repositories,
  });
  const fallback = codingWorkerBindingForPlan(plan(), WORKSPACE_ID);
  assert.deepEqual(fallback.codingModel, {
    model: 'anthropic/claude-sonnet-5',
    runtimeModel: 'anthropic/claude-sonnet-5',
  });
  // The binding round-trips through the worker's initialData validator and
  // never carries a credential or an attribution record.
  assert.deepEqual(parseCodingWorkerBinding(JSON.parse(JSON.stringify(withRole))), withRole);
  assert.equal(JSON.stringify(withRole).includes('attribution'), false);
});

test('the worker binding validator rejects unknown fields and malformed models', () => {
  const binding = codingWorkerBindingForPlan(plan(CODING_MODEL), WORKSPACE_ID);
  assert.throws(() => parseCodingWorkerBinding({ ...binding, token: 'x' }), /unknown field/);
  assert.throws(() => parseCodingWorkerBinding({ ...binding, schemaVersion: 2 }));
  assert.throws(() => parseCodingWorkerBinding({ ...binding, codingModel: { model: 'x' } }));
  assert.throws(() => parseCodingWorkerBinding({ ...binding, workspaceId: '' }));
  const validator = CodingWorker.initialData as unknown as { '~standard': { validate(value: unknown): unknown } };
  const good = validator['~standard'].validate(binding) as { issues?: unknown };
  const bad = validator['~standard'].validate({ ...binding, extra: 1 }) as { issues?: unknown };
  assert.equal(good.issues, undefined);
  assert.ok(bad.issues);
});

test('a changed coding model or grant list addresses a new worker on the same workspace', () => {
  const base = codingWorkerBindingForPlan(plan(CODING_MODEL), WORKSPACE_ID);
  const id = codingWorkerInstanceId(base);
  assert.match(id, /^codingworker_[a-f0-9]{40}$/);
  assert.equal(codingWorkerInstanceId(structuredClone(base)), id, 'stable for the same binding');
  const otherModel = codingWorkerBindingForPlan(plan({ ...CODING_MODEL, model: 'openai/gpt-6-mini', runtimeModel: 'openai/gpt-6-mini' }), WORKSPACE_ID);
  assert.notEqual(codingWorkerInstanceId(otherModel), id);
  assert.equal(otherModel.workspaceId, base.workspaceId, 'the workspace itself is unchanged');
  const otherGrants = { ...base, repositories: [base.repositories[0]!] };
  assert.notEqual(codingWorkerInstanceId(otherGrants), id);
  const reordered = { ...base, repositories: [...base.repositories].reverse() };
  assert.equal(codingWorkerInstanceId(reordered), id, 'grant order is not identity');
});

test('the worker derives policy-only repository grants', () => {
  const grants = codingWorkerRepositoryGrants(codingWorkerBindingForPlan(plan(), WORKSPACE_ID));
  assert.deepEqual(grants, [
    { id: 'grant-1', installationId: null, accountLogin: 'acme', fullName: 'acme/app', enabled: true },
    { id: 'grant-2', installationId: null, accountLogin: 'tools-org', fullName: '', allRepos: true, enabled: true },
  ]);
});

test('agent statics: the worker identity, and submission budgets that fit the task limits', () => {
  assert.equal(CodingWorker.agentName, CHICKPEA_CODING_WORKER_AGENT_NAME);
  // Every coordinator that mounts workspace_task can wait out its task limit.
  for (const agent of [ChickpeaSlack, ChickpeaRoutineExecution]) {
    assert.equal(agent.durability, CHICKPEA_SUBMISSION_DURABILITY);
  }
  assert.ok(
    CHICKPEA_SUBMISSION_DURABILITY.timeoutMs! >=
      MAX_WORKSPACE_TASKS_PER_RESPONSE * (WORKSPACE_TASK_TIMEOUT_MS + 60_000) + 30 * 60_000,
  );
  // The worker settles on its own before a coordinator stops waiting for long.
  assert.ok(CodingWorker.durability!.timeoutMs! > WORKSPACE_TASK_TIMEOUT_MS);
  assert.ok(CodingWorker.durability!.timeoutMs! < CHICKPEA_SUBMISSION_DURABILITY.timeoutMs!);
});

test('the worker instructions describe the workspace, not Slack, and end with a result line', () => {
  assert.match(CODING_WORKER_INSTRUCTIONS, /\/workspace/);
  assert.match(CODING_WORKER_INSTRUCTIONS, /Pull request:/);
  assert.equal(/slack/i.test(CODING_WORKER_INSTRUCTIONS), false);
  assert.equal(/post_artifact/.test(CODING_WORKER_INSTRUCTIONS), false);
});

test('workspace_task joins the workspace tool family', () => {
  assert.ok((WORKSPACE_TOOL_NAMES as readonly string[]).includes('workspace_task'));
});

// --- tool --------------------------------------------------------------------

interface Harness {
  calls: string[];
  dispatched: Array<{ instanceId: string; message: string; initialData: CodingWorkerBindingV1; idempotencyKey: string }>;
  aborted: string[];
  started: string[];
  progress: ActivityStatus[];
  steps: Map<string, unknown>;
  state: WorkspaceTaskResponseState;
}

function stub(calls: string[], options: { broken?: boolean } = {}): WorkspaceSandboxStub {
  return {
    async getTurnId() { return 'turn-1'; },
    async prepareTurn() {},
    async beginWorkspaceTurn() {
      calls.push('beginWorkspaceTurn');
      return { state: 'fresh', reservationId: 'turn-1', restorable: false };
    },
    async configureEgress() { calls.push('configureEgress'); },
    async restoreWorkspace() { return 'restored'; },
    async exists() {
      calls.push('exists');
      if (options.broken) throw new Error('container was unavailable');
      return true;
    },
    async describeWorkspace() { return { running: false, hasCheckpoint: false }; },
    async discardWorkspace() {},
    async destroy() {},
    async endTurn() {},
    async getTurnProgress() {
      return { pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', repository: 'acme/app', branch: 'fix-test' } };
    },
  };
}

function workspace(calls: string[], options: { broken?: boolean; capped?: boolean } = {}) {
  return new WorkspaceSession({
    id: WORKSPACE_ID,
    name: DEFAULT_WORKSPACE_NAME,
    agentId: 'agent-1',
    grants: [{ id: 'grant-1', installationId: 42, accountLogin: 'acme', fullName: 'acme/app', enabled: true }],
    credentialMode: 'app',
    mintStub: async () => stub(calls, options),
    reserveSession: async () => {
      calls.push('reserveSession');
      return !options.capped;
    },
    toSandbox: async (activatable) => ({
      async exists(path: string) {
        return activatable.exists(path);
      },
    }) as unknown as Sandbox,
  });
}

function receipt(submissionId = 'sub-1'): DispatchReceipt {
  return { submissionId, acceptedAt: '2026-09-24T00:00:00.000Z', uid: 'uid-1' };
}

function harness(): Harness {
  return {
    calls: [],
    dispatched: [],
    aborted: [],
    started: [],
    progress: [],
    steps: new Map(),
    state: { started: 0, running: new Set() },
  };
}

function taskTool(
  h: Harness,
  target: WorkspaceSession | undefined,
  observe: CodingWorkerClient['observe'],
  extra: { taskTimeoutMs?: number } = {},
) {
  return createWorkspaceTaskTool({
    resolve: async (name) => (name === DEFAULT_WORKSPACE_NAME ? target : undefined),
    binding: (workspaceId) => codingWorkerBindingForPlan(plan(CODING_MODEL), workspaceId),
    instanceId: codingWorkerInstanceId,
    client: {
      handle: (instanceId) => ({
        async dispatch(request) {
          h.calls.push('dispatch');
          h.dispatched.push({ instanceId, ...request });
          return receipt();
        },
        async abort() {
          h.aborted.push(instanceId);
        },
      }),
      observe,
    },
    responseState: () => h.state,
    onWorkerStarted: (model) => h.started.push(model),
    publishProgress: (status) => h.progress.push(status),
    recordedPullRequest: async (session) => (await (await session.activatable()).getTurnProgress?.())?.pullRequest,
    ...extra,
  });
}

async function run(tool: ReturnType<typeof taskTool>, h: Harness, data: object, toolCallId = 'call-1', signal?: AbortSignal) {
  const step = {
    async do<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      if (h.steps.has(name)) return h.steps.get(name) as T;
      const value = await fn();
      h.steps.set(name, value);
      return value;
    },
  };
  const result = await tool.run({
    toolCallId,
    log: { info() {}, warn() {}, error() {} },
    data,
    step,
    ...(signal ? { signal } : {}),
  } as never) as { output: Record<string, unknown> };
  return result.output;
}

function reply(text: string): AgentReply {
  return { text, data: {}, submissionId: 'sub-1' };
}

test('workspace_task activates the workspace, dispatches once with the binding, and reports the reply and pull requests', async () => {
  const h = harness();
  const calls: string[] = [];
  const tool = taskTool(h, workspace(calls), async ({ instanceId, receipt: observed }) => {
    assert.equal(observed.submissionId, 'sub-1');
    assert.equal(instanceId, h.dispatched[0]!.instanceId);
    return reply('Added a failing test and fixed it.\nBranch: fix-test · Pull request: https://github.com/acme/app/pull/7');
  });
  assert.equal(tool.durable, true);
  assert.equal(tool.timeoutMs, WORKSPACE_TASK_TIMEOUT_MS + 60_000);

  const output = await run(tool, h, { task: 'Add a failing test, fix it, open a PR.' });
  assert.deepEqual(output, {
    ok: true,
    workspace: 'main',
    reply: 'Added a failing test and fixed it.\nBranch: fix-test · Pull request: https://github.com/acme/app/pull/7',
    replyTruncated: false,
    pullRequests: [{ number: 7, url: 'https://github.com/acme/app/pull/7', repository: 'acme/app', branch: 'fix-test' }],
  });
  // The coordinator's session owns activation: cap reservation and the
  // readiness probe happen before any worker is involved.
  assert.deepEqual(calls.slice(0, 4), ['beginWorkspaceTurn', 'configureEgress', 'reserveSession', 'exists']);
  assert.equal(h.dispatched.length, 1);
  const sent = h.dispatched[0]!;
  assert.equal(sent.message, 'Add a failing test, fix it, open a PR.');
  assert.equal(sent.idempotencyKey, 'workspace_task:call-1');
  assert.equal(sent.initialData.workspaceId, WORKSPACE_ID);
  assert.equal(sent.instanceId, codingWorkerInstanceId(sent.initialData));
  assert.equal('uid' in sent, false, 'initialData is never combined with a uid condition');
  assert.deepEqual(h.started, ['openai/gpt-6']);
  assert.deepEqual(h.aborted, []);
  assert.deepEqual(h.state, { started: 1, running: new Set() });
});

test('a retried coordinator replays the recorded dispatch instead of starting a second task', async () => {
  const h = harness();
  h.steps.set('dispatch', receipt('sub-earlier'));
  const tool = taskTool(h, workspace([]), async ({ receipt: observed }) => {
    assert.equal(observed.submissionId, 'sub-earlier');
    return reply('done');
  });
  const output = await run(tool, h, { task: 'again' });
  assert.equal(output.ok, true);
  assert.equal(h.dispatched.length, 0);
});

test('a failed or aborted worker settlement maps to worker_failed', async () => {
  for (const error of [
    new AgentRunError({ outcome: 'failed', submissionId: 'sub-1' }),
    new AgentInstanceNotFoundError({ id: 'codingworker_x' }),
  ]) {
    const h = harness();
    const output = await run(taskTool(h, workspace([]), async () => { throw error; }), h, { task: 'x' });
    assert.equal(output.ok, false);
    assert.equal(output.reason, 'worker_failed');
    assert.match(String(output.message), /could not finish/);
    assert.deepEqual(h.aborted, [], 'a settled worker needs no abort');
  }
});

test('a task past its deadline is aborted durably and reported as a timeout', async () => {
  const h = harness();
  const tool = taskTool(h, workspace([]), ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { taskTimeoutMs: 20 });
  const output = await run(tool, h, { task: 'slow' });
  assert.equal(output.reason, 'timeout');
  assert.equal(h.aborted.length, 1);
  assert.equal(h.aborted[0], h.dispatched[0]!.instanceId);
  assert.equal(h.state.running.size, 0);
});

test('a host abort of the coordinator also aborts the worker', async () => {
  const h = harness();
  const host = new AbortController();
  const tool = taskTool(h, workspace([]), ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    queueMicrotask(() => host.abort(new Error('stopped')));
  }));
  const output = await run(tool, h, { task: 'x' }, 'call-1', host.signal);
  assert.equal(output.reason, 'timeout');
  assert.equal(h.aborted.length, 1);
});

test('a broken observation aborts the worker and surfaces as a tool error', async () => {
  const h = harness();
  const tool = taskTool(h, workspace([]), async () => { throw new Error('transport'); });
  await assert.rejects(run(tool, h, { task: 'x' }), /transport/);
  assert.equal(h.aborted.length, 1);
  assert.equal(h.state.running.size, 0);
});

test('a broken container or a spent session cap is answered before any worker is dispatched', async () => {
  const broken = harness();
  const unavailable = await run(taskTool(broken, workspace([], { broken: true }), async () => reply('x')), broken, { task: 'x' });
  assert.equal(unavailable.reason, 'workspace_unavailable');
  assert.equal(broken.dispatched.length, 0);

  const capped = harness();
  const cap = await run(taskTool(capped, workspace([], { capped: true }), async () => reply('x')), capped, { task: 'x' });
  assert.equal(cap.reason, 'session_cap');
  assert.equal(capped.dispatched.length, 0);

  const missing = harness();
  const none = await run(taskTool(missing, undefined, async () => reply('x')), missing, { task: 'x' });
  assert.equal(none.reason, 'workspace_unavailable');
  const named = await run(taskTool(missing, workspace([]), async () => reply('x')), missing, { task: 'x', workspace: 'other' });
  assert.equal(named.reason, 'unknown_workspace');
});

test('one task runs per workspace at a time, and a response delegates at most the task limit', async () => {
  const h = harness();
  const target = workspace([]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tool = taskTool(h, target, async () => {
    await gate;
    return reply('done');
  });
  const first = run(tool, h, { task: 'one' }, 'call-1');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const busy = await run(tool, h, { task: 'two' }, 'call-2');
  assert.equal(busy.reason, 'busy');
  release();
  assert.equal((await first).ok, true);

  h.steps.clear();
  assert.equal((await run(tool, h, { task: 'two' }, 'call-3')).ok, true);
  h.steps.clear();
  const limited = await run(tool, h, { task: 'three' }, 'call-4');
  assert.equal(limited.reason, 'task_limit');
  assert.equal(h.dispatched.length, MAX_WORKSPACE_TASKS_PER_RESPONSE);
});

test('long replies keep their end, where the result line is', async () => {
  const h = harness();
  const long = `${'x'.repeat(40_000)}\nPull request: https://github.com/acme/app/pull/9`;
  const output = await run(taskTool(h, workspace([]), async () => reply(long)), h, { task: 'x' });
  assert.equal(output.replyTruncated, true);
  assert.match(String(output.reply), /pull\/9$/);
  assert.ok(String(output.reply).length <= 16 * 1024);
});

test('pull request links are extracted only for granted repositories', () => {
  const binding = codingWorkerBindingForPlan(plan(), WORKSPACE_ID);
  const links = pullRequestLinks([
    'Opened https://github.com/acme/app/pull/12 and https://github.com/ACME/app/pull/12.',
    'Also https://github.com/tools-org/cli/pull/3,',
    'but not https://github.com/evil/app/pull/1 or https://github.com/acme/other/pull/2',
    'nor https://github.com/acme/app/pull/5/files',
  ].join('\n'), binding);
  assert.deepEqual(links, [
    { url: 'https://github.com/acme/app/pull/12', repository: 'acme/app', number: 12 },
    { url: 'https://github.com/tools-org/cli/pull/3', repository: 'tools-org/cli', number: 3 },
  ]);
});

// --- progress ----------------------------------------------------------------

test('progress relays only this task\'s tool calls, by tool name, without repeats', () => {
  const published: ActivityStatus[] = [];
  const relay = createProgressRelay('sub-2', (status) => published.push(status));
  const chunk = (value: object) => value as unknown as ConversationStreamChunk;
  // An earlier task on a reused worker replays first and is ignored.
  relay(chunk({ type: 'message-started', submissionId: 'sub-1', messageId: 'm1' }));
  relay(chunk({ type: 'tool-input', toolName: 'bash', toolCallId: 't0', input: { command: 'secret' } }));
  relay(chunk({ type: 'message-started', submissionId: 'sub-2', messageId: 'm2' }));
  relay(chunk({ type: 'tool-input', toolName: 'bash', toolCallId: 't1', input: { command: 'npm test' } }));
  relay(chunk({ type: 'tool-input', toolName: 'bash', toolCallId: 't2', input: {} }));
  relay(chunk({ type: 'tool-input', toolName: 'edit', toolCallId: 't3', input: {} }));
  relay(chunk({ type: 'tool-input', toolName: 'grep', toolCallId: 't4', input: {} }));
  relay(chunk({ type: 'message-delta', kind: 'text', delta: 'hello' }));
  assert.deepEqual(published.map((status) => status.text), [
    'Running commands in the coding workspace…',
    'Editing files in the coding workspace…',
    'Reading code in the coding workspace…',
  ]);
  assert.ok(published.every((status) => status.family === 'workspace'));
  assert.equal(JSON.stringify(published).includes('npm test'), false, 'tool input never reaches Slack');
});

test('a task relays progress lines while it runs', async () => {
  const h = harness();
  const tool = taskTool(h, workspace([]), async ({ onEvent }) => {
    onEvent({ type: 'message-started', submissionId: 'sub-1', messageId: 'm' } as unknown as ConversationStreamChunk);
    onEvent({ type: 'tool-input', toolName: 'bash', toolCallId: 't', input: {} } as unknown as ConversationStreamChunk);
    return reply('done');
  });
  await run(tool, h, { task: 'x' });
  assert.deepEqual(h.progress.map((status) => status.text), ['Running commands in the coding workspace…']);
});

// --- footer ------------------------------------------------------------------

test('the reply names the coding model only when a worker ran on a different model', () => {
  const agentReply = (data: Record<string, unknown[]>): AgentReply => ({ text: 'ok', data, submissionId: 's' });
  const ran = resultFromAgentReply(agentReply({
    [CODING_WORKER_RUN_DATA_NAME]: [{ schemaVersion: 1, model: 'openai/gpt-6' }],
  }), 'anthropic/claude-sonnet-5');
  assert.equal(ran.codingModel, 'openai/gpt-6');
  assert.equal(
    replyFooterModelLabel({ agentModel: 'anthropic/claude-sonnet-5', codingModel: ran.codingModel, codingWorkerRan: true }),
    'anthropic/claude-sonnet-5 · coding: openai/gpt-6',
  );
  assert.equal(resultFromAgentReply(agentReply({}), null).codingModel, undefined);
  assert.equal(parseCodingWorkerRunModel([{ schemaVersion: 1, model: 'openai/gpt-6', extra: 1 }]), undefined);
  assert.equal(parseCodingWorkerRunModel('openai/gpt-6'), undefined);
  assert.equal(
    parseCodingWorkerRunModel([{ schemaVersion: 1, model: 'a/one' }, { schemaVersion: 1, model: 'b/two' }]),
    'b/two',
  );
});
