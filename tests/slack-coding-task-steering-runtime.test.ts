import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import {
  init, instrument, useModel, useTool,
  type AgentProps, type AgentReply, type FlueExecutionInterceptor, type LlmMessage, type Sandbox,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { useWorkspaceTaskFinishGuard } from '../src/agents/coding-worker-task.ts';
import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  bindCurrentRequestConversation, memoryToolPolicyInterceptor, observeMemoryToolPolicy,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { codingWorkerBindingForPlan, codingWorkerInstanceId } from '../src/sandbox/coding-worker-binding.ts';
import { DEFAULT_WORKSPACE_NAME } from '../src/sandbox/workspace-limits.ts';
import { WorkspaceSession, defaultWorkspaceId, type WorkspaceSandboxStub } from '../src/sandbox/workspace-session.ts';
import {
  createWorkspaceTaskFinishCheck, createWorkspaceTaskResumeTool, createWorkspaceTaskSteerTool,
  createWorkspaceTaskTool, emptyWorkspaceTaskResponseState, type WorkspaceTaskResponseState,
  type WorkspaceTaskToolOptions,
} from '../src/sandbox/workspace-task.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import { slackToolBoundaryFoldInterceptor, useSlackFollowUpFold, type LateFoldRequest } from '../src/slack/follow-up-fold.ts';
import { SLACK_REPLY_IN_THREAD_TOOL_NAME } from '../src/slack/follow-ups.ts';
import { createMidRunReplyHandler, useSlackMidRunReplyTool } from '../src/slack/midrun-reply.ts';
import type { SlackPresentationMidRunReply } from '../src/slack/run-presentations.ts';
import { registerSlackStatusTurn } from '../src/slack/status-registry.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';

/**
 * Steering C5 through the real Flue harness: a message the person sends
 * while the Agent waits on a coding job pauses the wait, reaches the model
 * at that tool boundary through the state store's own fold, and the model
 * relays it to the job and waits again. The job is never aborted. A message
 * read at a pause is read mid-run, so reply_in_thread may answer it there.
 */

const MODEL = 'faux/coding-task-steering';
const PERSON = 'U_PERSON';
const GENERATION = 'gen-coding-task-steering';
const NOW = 1_800_000_000_000;
const LATE = 'Actually use Postgres, not SQLite.';
const WORKSPACE_ID = defaultWorkspaceId('sandbox_' + 'c'.repeat(40));
const BINDING = codingWorkerBindingForPlan({
  agentId: 'agent_steer',
  model: 'anthropic/claude-sonnet-5',
  runtimeModel: 'anthropic/claude-sonnet-5',
  repositories: [{ id: 'grant-1', fullName: 'acme/app' }],
  codingWorkspace: { available: true },
}, WORKSPACE_ID);

interface Scenario {
  plan: RuntimePlanV2;
  instanceId: string;
  turns: TurnJobStoreLogic;
  calls: LateFoldRequest[];
  arrive(id: string, text: string): void;
  close(): void;
}

/** The fake coding worker: its dispatches, aborts and observations. */
interface Worker {
  dispatched: Array<{ message: string; idempotencyKey: string }>;
  aborted: number;
  observations: number;
  /** Runs as observation `n` (1-based) starts; resolves with the job's answer, or never. */
  onObserve: (n: number) => Promise<AgentReply | undefined>;
}

let scenario: Scenario;
let worker: Worker;
let responseState: WorkspaceTaskResponseState;
let requests: Array<{ late: number; toolResults: string[]; reminded: boolean }> = [];
/** The threaded replies posted mid-run, with the job's state when each posted. */
let replies: Array<{ text: string; dispatched: number; observations: number }> = [];

function workspace(): WorkspaceSession {
  const stub = {
    async getTurnId() { return 'head'; },
    async prepareTurn() {},
    async beginWorkspaceTurn() { return { state: 'fresh', reservationId: 'head', restorable: false }; },
    async configureEgress() {},
    async restoreWorkspace() { return 'restored'; },
    async exists() { return true; },
    async describeWorkspace() { return { running: false, hasCheckpoint: false }; },
    async discardWorkspace() {},
    async destroy() {},
    async endTurn() {},
    async applyGitIdentity() {},
    async getTurnProgress() { return {}; },
  } as WorkspaceSandboxStub;
  return new WorkspaceSession({
    id: WORKSPACE_ID,
    name: DEFAULT_WORKSPACE_NAME,
    agentId: 'agent_steer',
    turnId: 'head',
    grants: [{ id: 'grant-1', installationId: 42, accountLogin: 'acme', fullName: 'acme/app', enabled: true }],
    credentialMode: 'app',
    mintStub: async () => stub,
    reserveSession: async () => true,
    toSandbox: async (activatable) => ({ exists: (path: string) => activatable.exists(path) }) as unknown as Sandbox,
  });
}

function taskOptions(waiting: () => Promise<boolean>): WorkspaceTaskToolOptions {
  const session = workspace();
  return {
    resolve: async (name) => (name === DEFAULT_WORKSPACE_NAME ? session : undefined),
    binding: () => BINDING,
    instanceId: codingWorkerInstanceId,
    client: {
      handle: () => ({
        async dispatch(request) {
          worker.dispatched.push({ message: request.message, idempotencyKey: request.idempotencyKey });
          return { submissionId: 'sub_worker', acceptedAt: new Date().toISOString(), uid: 'uid_worker' };
        },
        async abort() { worker.aborted += 1; },
      }),
      observe: ({ signal }) => new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        worker.observations += 1;
        void worker.onObserve(worker.observations).then((reply) => { if (reply) resolve(reply); });
      }),
      settled: async () => false,
    },
    responseState: () => responseState,
    pendingMessages: waiting,
    turnStopped: async () => false,
    messageCheckMs: 10,
  };
}

function SteerProbe({ id }: AgentProps) {
  useModel(MODEL);
  bindCurrentRequestConversation(scenario.plan.conversation);
  const followUps = useSlackFollowUpFold({
    instanceId: id,
    blocked: () => false,
    fold: async (request) => {
      scenario.calls.push(request);
      return scenario.turns.fold(request);
    },
  });
  const options = taskOptions(followUps.waiting);
  useTool(createWorkspaceTaskTool(options));
  useTool(createWorkspaceTaskResumeTool(options));
  useTool(createWorkspaceTaskSteerTool(options));
  useWorkspaceTaskFinishGuard(createWorkspaceTaskFinishCheck(options));
  useSlackMidRunReplyTool(followUps);
}

let thread = 0;

function openScenario(): Scenario {
  thread += 1;
  const threadTs = `1800003${String(thread).padStart(3, '0')}.000100`;
  const conversation = { workspaceId: 'T_STEER', channelId: 'C_STEER', threadTs };
  const turn = (messageTs: string, text: string): NormalizedSlackTurn => ({
    ...conversation, eventId: `Ev_${messageTs}`, text, userId: PERSON, messageTs,
    source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
    requesterTimezone: 'America/Los_Angeles',
  });
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_STEER', channelId: 'C_STEER', agentId: 'agent_steer', model: MODEL,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_steer', kind: 'user', revision: 1, name: 'Steer', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  const clock = { now: NOW };
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => clock.now);
  let sequence = 200;
  const enqueue = (id: string, text: string) => {
    const queued: TurnJob = {
      id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, runId: `run_${id}`,
      turn: turn(`${threadTs.split('.')[0]}.000${sequence++}`, text), assignment,
    };
    turns.enqueue(queued);
    clock.now += 1;
  };
  enqueue('head', 'Add a database to the app.');
  const head = turns.runnerView('head').job!;
  const plan = compileRuntimePlanV2({ turn: head.turn, assignment, instructions: 'Help.', memoryEpoch: 1 });
  turns.freezeRuntimePlan('head', plan);
  turns.prepareFlueDispatch('head', `Add a database to the app.\n\n${serializeCurrentRequestEnvelope(
    '', false, PERSON, head.turn.messageTs, { schemaVersion: 2 },
  )}`, { generation: GENERATION });
  return {
    plan,
    instanceId: turns.getFrozenRuntimePlan('head')!.instanceId,
    turns,
    calls: [],
    arrive: enqueue,
    close: () => db.close(),
  };
}

function dispatchState(turns: TurnJobStoreLogic): SlackFlueDispatchState {
  const envelope = turns.getDispatchEnvelope('head')!;
  return {
    prepare: () => envelope,
    recordReceipt: (receipt) => turns.recordFlueReceipt('head', receipt),
    recordSettlement: (settlement) => turns.recordFlueSettlement('head', settlement),
    reconcileExistingInstance: () => { throw new Error('Unexpected incarnation conflict.'); },
    markRecoveryRequired: (reason) => { throw new Error(`Unexpected recovery: ${reason}`); },
  };
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === 'string' ? content
    : content.flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : []).join('\n');
}

const call = (name: string, input: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: 'toolUse' });
const startTask = () => call('workspace_task', { task: 'Add SQLite storage to acme/app and open a pull request.' });
const answer = (text: string) => fauxAssistantMessage(text);
const JOB_DONE: AgentReply = {
  text: 'Added Postgres storage.\nBranch: add-db · Pull request: https://github.com/acme/app/pull/9',
  data: {},
  submissionId: 'sub_worker',
};

test('a message sent during a coding job reaches the Agent at a pause, and the job keeps running', { timeout: 60_000 }, async (t) => {
  const faux = fauxProvider({ models: [{ id: 'coding-task-steering' }], tokensPerSecond: 100_000 });
  const observation = createWorkModelInvocationInterceptor({
    resolveTarget: async (instanceId, submissionId) => ({
      generation: GENERATION, turnJobId: 'head', instanceId, submissionId,
    }),
  });
  const interceptor: FlueExecutionInterceptor = (operation, context, next) =>
    memoryToolPolicyInterceptor(operation, context, () => observation(operation, context, () =>
      slackToolBoundaryFoldInterceptor(operation, context, next)));
  const stopInstrumentation = instrument({
    interceptor,
    observe(event, context) {
      observeMemoryToolPolicy(event, context);
      if (event.type !== 'turn_request' || event.purpose !== 'agent') return;
      const messages: readonly LlmMessage[] = event.request.input.messages;
      requests.push({
        late: messages.filter((message) => message.role === 'user' && textOf(message.content).includes(LATE)).length,
        toolResults: messages.flatMap((message) => message.role === 'toolResult' ? [textOf(message.content)] : []),
        reminded: messages.some((message) => message.role === 'user' &&
          textOf(message.content).includes('Call workspace_task_resume for it now')),
      });
    },
    dispose() {},
  });
  const runtime = await start({
    agents: [{ agent: SteerProbe, name: CHICKPEA_SLACK_AGENT_NAME }],
    providers: [faux.provider],
  });

  async function run(responses: FauxResponseStep[]) {
    requests = [];
    responseState = emptyWorkspaceTaskResponseState();
    faux.setResponses(responses);
    replies = [];
    const statuses: string[] = [];
    const recorded: SlackPresentationMidRunReply[] = [];
    const statusTurn = registerSlackStatusTurn(scenario.instanceId, {
      setStatus: async (update) => { statuses.push(update.text); return true; },
    }, {
      generation: GENERATION,
      observedMinIntervalMs: 0,
      midRunReply: createMidRunReplyHandler({
        presentation: {
          midRunReplies: async () => recorded,
          reserveMidRunReply: async (messageTs) => { recorded.push({ messageTs, at: Date.now() }); },
          recordMidRunReplyPosted: async () => {},
        },
        post: async (text) => {
          replies.push({ text, dispatched: worker.dispatched.length, observations: worker.observations });
        },
      }),
    });
    try {
      const result = await promptSlackThreadAgent({
        handle: init(SteerProbe, { id: scenario.instanceId }),
        state: dispatchState(scenario.turns),
        message: 'Add a database to the app.',
        turnId: 'head', conversationKey: scenario.instanceId, requestedModel: MODEL,
      });
      await statusTurn.drain();
      return { result, statuses };
    } finally {
      statusTurn.close();
    }
  }

  const calls = () => scenario.calls.map(({ phase, received, take }) => ({ phase, received, take }));

  try {
    await t.test('the wait pauses, the pull reads the message, the model relays it and resumes', async () => {
      scenario = openScenario();
      worker = {
        dispatched: [], aborted: 0, observations: 0,
        // The person writes while the job runs; the job finishes once resumed.
        onObserve: async (n) => {
          if (n === 1) { await sleep(25); scenario.arrive('late', LATE); return undefined; }
          await sleep(10);
          return JOB_DONE;
        },
      };
      try {
        const { result, statuses } = await run([
          startTask(),
          call('workspace_task_steer', { guidance: 'Use Postgres instead of SQLite for the storage.' }),
          call('workspace_task_resume', {}),
          answer('Opened https://github.com/acme/app/pull/9 with Postgres storage.'),
        ]);
        assert.equal(result.text, 'Opened https://github.com/acme/app/pull/9 with Postgres storage.');
        assert.deepEqual(requests.map((request) => request.late), [0, 1, 1, 1], 'read right after the pause, once');
        assert.match(requests[1]!.toolResults[0]!, /"running":true/, 'the boundary was the paused wait');
        assert.equal(worker.aborted, 0, 'the job was never aborted');
        assert.equal(worker.dispatched.length, 2, 'the job, then the guidance');
        assert.ok(worker.dispatched[1]!.idempotencyKey.startsWith(`${worker.dispatched[0]!.idempotencyKey}:guidance:`));
        assert.match(worker.dispatched[1]!.message, /Use Postgres instead of SQLite/);
        assert.equal(worker.observations, 2, 'the resume observed the same job again');
        assert.match(requests[3]!.toolResults.at(-1)!, /pull\/9/);
        assert.deepEqual(statuses, ['Reading 1 new message…']);
        // The wait's check claimed the message and the boundary's pull read
        // the same claim; later checks confirm it and find nothing new.
        const confirmedAt = calls().findIndex((entry) => entry.received === 1);
        assert.ok(confirmedAt >= 2, 'at least the wait\'s check and the boundary\'s pull');
        assert.ok(calls().slice(0, confirmedAt).every((entry) =>
          entry.phase === 'turn' && entry.received === 0 && entry.take), 'every check before the read claims cycle 1');
        assert.deepEqual(calls().at(-1), { phase: 'finish', received: 1, take: true });
        assert.equal(scenario.turns.runnerView('late').job!.fold?.cycle, 1, 'the check and the pull share one claim');
        assert.equal(scenario.turns.runnerView('late').job!.fold?.received, true);
        assert.equal(responseState.pauses, 1, 'the resumed wait found nothing unread and never paused again');
      } finally {
        scenario.close();
      }
    });

    await t.test('a pause right after another tool step still reads the message at its boundary', async () => {
      scenario = openScenario();
      worker = {
        dispatched: [], aborted: 0, observations: 0,
        onObserve: async (n) => {
          if (n === 1) { await sleep(25); scenario.arrive('late', LATE); return undefined; }
          await sleep(10);
          return JOB_DONE;
        },
      };
      try {
        // The steer finds no task: a quick step whose boundary checked just before the job starts.
        const { result } = await run([
          call('workspace_task_steer', { guidance: 'Nothing yet.' }),
          startTask(),
          call('workspace_task_resume', {}),
          answer('Opened https://github.com/acme/app/pull/9.'),
        ]);
        assert.equal(result.text, 'Opened https://github.com/acme/app/pull/9.');
        assert.deepEqual(requests.map((request) => request.late), [0, 0, 1, 1], 'the paused wait\'s boundary reads it');
        assert.equal(responseState.pauses, 1);
      } finally {
        scenario.close();
      }
    });

    await t.test('a reply to the message read at the pause posts while the job runs, then the job resumes and finishes', async () => {
      scenario = openScenario();
      worker = {
        dispatched: [], aborted: 0, observations: 0,
        onObserve: async (n) => {
          if (n === 1) { await sleep(25); scenario.arrive('late', LATE); return undefined; }
          await sleep(10);
          return JOB_DONE;
        },
      };
      try {
        const lateTs = () => scenario.turns.runnerView('late').job!.turn.messageTs;
        const { result } = await run([
          startTask(),
          () => call(SLACK_REPLY_IN_THREAD_TOOL_NAME, { message_ts: lateTs(), text: 'Switching to Postgres.' }),
          call('workspace_task_steer', { guidance: 'Use Postgres instead of SQLite for the storage.' }),
          call('workspace_task_resume', {}),
          answer('Opened https://github.com/acme/app/pull/9 with Postgres storage.'),
        ]);
        assert.equal(result.text, 'Opened https://github.com/acme/app/pull/9 with Postgres storage.', 'one final reply');
        assert.deepEqual(replies, [{ text: 'Switching to Postgres.', dispatched: 1, observations: 1 }],
          'one threaded reply, posted while the paused job ran and before the guidance');
        assert.match(requests[2]!.toolResults.at(-1)!, /Posted in the thread/);
        assert.equal(worker.aborted, 0, 'the job was never aborted');
        assert.equal(worker.dispatched.length, 2, 'the job, then the guidance');
        assert.equal(worker.observations, 2, 'the resume observed the same job again');
        assert.match(requests.at(-1)!.toolResults.at(-1)!, /pull\/9/);
        assert.equal(responseState.pauses, 1, 'the reply\'s boundary read nothing new and the resume never paused');
      } finally {
        scenario.close();
      }
    });

    await t.test('a reply that would end with the job unobserved is sent back to wait for it', async () => {
      scenario = openScenario();
      worker = {
        dispatched: [], aborted: 0, observations: 0,
        onObserve: async (n) => {
          if (n === 1) { await sleep(25); scenario.arrive('late', LATE); return undefined; }
          await sleep(10);
          return JOB_DONE;
        },
      };
      try {
        const { result } = await run([
          startTask(),
          answer('Noted, switching to Postgres.'),
          call('workspace_task_resume', {}),
          answer('Opened https://github.com/acme/app/pull/9.'),
        ]);
        assert.equal(result.text, 'Opened https://github.com/acme/app/pull/9.');
        assert.deepEqual(requests.map((request) => request.reminded), [false, false, true, true]);
        assert.equal(worker.aborted, 0);
        assert.equal(worker.observations, 2);
      } finally {
        scenario.close();
      }
    });
  } finally {
    await runtime.stop();
    await stopInstrumentation();
  }
});
