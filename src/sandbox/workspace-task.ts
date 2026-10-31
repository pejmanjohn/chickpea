import {
  AgentInstanceNotFoundError,
  AgentRunError,
  defineTool,
  SandboxDiedError,
  type AgentReply,
  type ConversationStreamChunk,
  type DispatchReceipt,
} from '@flue/runtime';
import * as v from 'valibot';

import { activityStatus, type ActivityStatus } from '../activity/semantic.ts';
import { toolActivityStatus } from '../activity/status.ts';
import type { TurnPullRequestProgress } from '../config/state-rpc.ts';
import { emitCodingTaskSteering } from '../observability/runtime-latency.ts';
import {
  safeBranchName,
  WORKSPACE_MILESTONES,
  type CodingWorkerUsageRecord,
  type WorkspaceMilestone,
  type WorkspaceMilestoneOutcome,
  type WorkspaceMilestoneRecord,
} from '../slack/coding-worker-run.ts';
import {
  CHICKPEA_RESPONSE_METADATA_KEY,
  parseChickpeaResponseMetadata,
} from '../usage/response-metadata.ts';
import { workspaceTaskDispatchKey, type CodingTaskRecordV1 } from './coding-task-record.ts';
import type { CodingWorkerBinding } from './coding-worker-binding.ts';
import {
  SandboxConnectionDroppedError,
  SandboxSessionCapError,
  SandboxUnavailableError,
} from './errors.ts';
import { WORKSPACE_DIR } from './workspace-lifecycle.ts';
import {
  MAX_RUNNING_TASKS_PER_WORKSPACE,
  WorkspaceLimitError,
  WorkspaceNameError,
  normalizeWorkspaceName,
} from './workspace-limits.ts';
import type { WorkspaceSession } from './workspace-session.ts';
import {
  WORKSPACE_NAME,
  workspaceSessionCapMessage,
  WORKSPACE_TASK_RESUME_TOOL_NAME,
  WORKSPACE_TASK_STEER_TOOL_NAME,
  WORKSPACE_TASK_TOOL_NAME,
  WORKSPACE_UNAVAILABLE_MESSAGE,
  withRestoreNotice,
  type WorkspaceResolver,
} from './workspace-tools.ts';

/**
 * Default and longest wall time for one delegated task. A first live run on a
 * full repository (install, tests, push) took about 20 minutes for a one-file
 * fix, so an hour leaves room for real work.
 */
export const WORKSPACE_TASK_TIMEOUT_MS = 60 * 60_000;
/**
 * The harness deadline sits this far past the task's own, so an expired task
 * reports a typed timeout (after aborting the worker) before the harness gives
 * up on the call.
 */
const WORKSPACE_TASK_TOOL_GRACE_MS = 60_000;
/**
 * Tasks one response may delegate. With the coordinator's submission budget
 * (`CHICKPEA_SUBMISSION_DURABILITY`) this keeps two full-length tasks plus the
 * coordinator's own model time inside one response.
 */
export const MAX_WORKSPACE_TASKS_PER_RESPONSE = 2;
/** Longest brief the worker receives. */
export const MAX_WORKSPACE_TASK_BRIEF_CHARS = 32 * 1024;
/** The worker's answer returned to the coordinator keeps its end, where the result line is. */
export const MAX_WORKSPACE_TASK_REPLY_CHARS = 16 * 1024;
const MAX_REPORTED_PULL_REQUESTS = 10;

export type WorkspaceTaskFailureReason =
  | 'workspace_unavailable'
  | 'session_cap'
  | 'timeout'
  | 'stopped'
  | 'worker_failed'
  | 'busy'
  | 'task_limit'
  | 'workspace_limit'
  | 'invalid_input'
  | 'no_task'
  | 'finished'
  | 'not_sent';

export type WorkspaceTaskFailure = {
  ok: false;
  reason: WorkspaceTaskFailureReason;
  message: string;
};

export type WorkspaceTaskPullRequest = {
  url: string;
  repository: string;
  number: number;
  branch?: string;
};

export type WorkspaceTaskResult = {
  ok: true;
  workspace: string;
  reply: string;
  replyTruncated: boolean;
  pullRequests: WorkspaceTaskPullRequest[];
};

/** The task still runs: the wait returned early so the model can read new messages. */
export type WorkspaceTaskPause = {
  ok: true;
  running: true;
  workspace: string;
  message: string;
};

type WorkspaceTaskOutcome = WorkspaceTaskResult | WorkspaceTaskFailure | WorkspaceTaskPause;

/** One worker instance, as the tool drives it. */
export interface CodingWorkerHandle {
  dispatch(request: {
    message: string;
    initialData: CodingWorkerBinding;
    idempotencyKey: string;
  }): Promise<DispatchReceipt>;
  abort(): Promise<void>;
}

/**
 * How the tool reaches coding workers. Production dispatches with Flue's
 * `init()` and observes with the bounded reader: never Flue's long-poll
 * `read()`, which nests cross-object subrequests on Cloudflare until the
 * platform rejects them (see ../slack/bounded-agent-observation.ts).
 */
export interface CodingWorkerClient {
  handle(instanceId: string): CodingWorkerHandle;
  observe(input: {
    instanceId: string;
    receipt: DispatchReceipt;
    onEvent: (chunk: ConversationStreamChunk) => void;
    signal: AbortSignal;
  }): Promise<AgentReply>;
  /** Whether the submission has settled, from one read that never waits. */
  settled(input: { instanceId: string; submissionId: string }): Promise<boolean>;
}

/**
 * Where the tool keeps each coding job's durable active-task record
 * (./coding-task-record.ts), under the host turn its workspace is bound to.
 * A stop reads them to abort and confirm the workers, because Flue discards
 * an aborted call's own result.
 */
export interface CodingTaskRecordStore {
  /** Write or replace one job's record. */
  put(hostTurnId: string, record: CodingTaskRecordV1): Promise<void>;
  /** Drop a job's record once its submission settled. */
  settle(hostTurnId: string, taskKey: string): Promise<void>;
  /** The host turn's records, for a wait the coordinator lost track of (a restart after a pause). */
  list?(hostTurnId: string): Promise<CodingTaskRecordV1[]>;
}

type AcceptedCodingTaskRecord = Extract<CodingTaskRecordV1, { state: 'accepted' }>;

/** A task a worker accepted this response whose answer the model has not read yet. */
interface OpenWorkspaceTask {
  record: AcceptedCodingTaskRecord;
  hostTurnId: string | undefined;
  milestones: MilestoneRecorder;
  /** The pull request egress recorded before the task started; undefined when not known. */
  pullRequestBefore: string | null | undefined;
  /** A call is waiting on it now. */
  observing: boolean;
  /** It paused once because the message check kept failing; it pauses so again only after a check succeeds. */
  checkFailed: boolean;
}

/** Per-response bookkeeping: tasks started, tasks running by workspace id, and the ones still open. */
export interface WorkspaceTaskResponseState {
  started: number;
  running: Map<string, number>;
  /** Accepted tasks the model has not read the answer of, by workspace id. */
  open: Map<string, OpenWorkspaceTask>;
  /** Pauses so far; bounded, so a check that keeps answering yes cannot loop. */
  pauses: number;
  /** Times the finish check sent the model back to a task it left running. */
  reminders: number;
}

export function emptyWorkspaceTaskResponseState(): WorkspaceTaskResponseState {
  return { started: 0, running: new Map(), open: new Map(), pauses: 0, reminders: 0 };
}

export interface WorkspaceTaskToolOptions {
  /** The session for a workspace name this response; a `use` that opens it. */
  resolve: WorkspaceResolver;
  /** The worker binding for a workspace id, frozen from the coordinator's plan. */
  binding: (workspaceId: string) => CodingWorkerBinding;
  /** The worker instance id for a binding. */
  instanceId: (binding: CodingWorkerBinding) => string;
  /**
   * Make the worker addressable before anything names it: before its task
   * record is written, and so before its dispatch. A failure refuses the
   * task as an unavailable workspace.
   */
  prepareWorker?: (instanceId: string, binding: CodingWorkerBinding, taskKey: string) => Promise<void>;
  client: CodingWorkerClient;
  /** This response's bookkeeping; one object for the whole response. */
  responseState: () => WorkspaceTaskResponseState;
  /** Called once a worker accepted a task, with the model it runs on. */
  onWorkerStarted?: (model: string) => void;
  /**
   * Called once for every task a worker accepted, when it settles, with the
   * worker's own model usage (absent when unknown). Not called when the
   * observation itself broke and the tool throws.
   */
  onWorkerUsage?: (record: CodingWorkerUsageRecord) => void;
  /**
   * Records the task's steps (workspace, changes, pull request) for the run's
   * working indicator. Every step a task starts is settled once its answer
   * is read or it ends; a pause leaves them open.
   */
  onMilestone?: (record: WorkspaceMilestoneRecord) => void;
  /** Relays the worker's progress to the coordinator's visible status. */
  publishProgress?: (status: ActivityStatus) => void;
  /** Pull requests the workspace's egress recorded for this turn. */
  recordedPullRequest?: (session: WorkspaceSession) => Promise<TurnPullRequestProgress | undefined>;
  /**
   * Each job's active-task record for a stop. With a store, a job whose
   * record cannot be written before its dispatch is refused: a stop could
   * not find it.
   */
  taskRecords?: CodingTaskRecordStore;
  /**
   * Whether new messages wait to join this response (the follow-up fold's
   * check). A wait asks at its start and then every
   * WORKSPACE_TASK_MESSAGE_CHECK_MS, and pauses when the answer is yes, so
   * the messages join at that tool boundary. Absent, a wait never pauses.
   */
  pendingMessages?: () => Promise<boolean>;
  /** Whether the run's turn has ended or carries a stop record; a relay refuses then. */
  turnStopped?: () => Promise<boolean>;
  /** Test seam for the task deadline. */
  taskTimeoutMs?: number;
  /** Test seam for the message check's interval. */
  messageCheckMs?: number;
  /** Test seam for when a task was dispatched and when it settled. */
  now?: () => number;
}

/**
 * How often a wait checks for new messages: about 240 state-store calls in
 * a full-length task, so a message reaches the Agent within about this long.
 */
export const WORKSPACE_TASK_MESSAGE_CHECK_MS = 15_000;
/** Failed checks in a row (about a minute) after which a wait pauses anyway. */
const MAX_FAILED_MESSAGE_CHECKS = 3;
/** Pauses in one response; the follow-up fold takes at most as many folds after tool steps. */
export const MAX_WORKSPACE_TASK_PAUSES = 12;
/** Times one response is sent back to a task it left running before the task is stopped. */
const MAX_WORKSPACE_TASK_REMINDERS = 2;
/** Longest guidance relayed to a running worker. */
export const MAX_WORKSPACE_TASK_GUIDANCE_CHARS = 8 * 1024;

const WORKER_FAILED_MESSAGE =
  'The coding worker could not finish this task (its container or its coding model failed). Say so plainly. If the work is small, use the Repositories API path; otherwise the person can ask again later. Do not retry this call in the same reply.';
const TIMEOUT_MESSAGE =
  'The coding task did not finish in time and was stopped. Report what is known; a pushed branch may already hold partial work. Do not retry the same task in the same reply.';
const STOPPED_MESSAGE =
  'This run was stopped, so the coding task was stopped with it. Do not retry it.';
const FINISHED_MESSAGE =
  'The coding task had already finished, so the guidance did not reach it. Call workspace_task_resume to read its answer. If the change is still needed, say so and offer to run a new task with it.';
const NOT_SENT_MESSAGE =
  'The guidance could not be passed to the coding task. Call workspace_task_resume to wait for its answer, then say what the task did not take into account.';

function pauseMessage(workspace: string): string {
  return `The coding task in the "${workspace}" workspace is still running. This is a pause so you can read new messages from the thread; take them into account. To pass a change to the running task, call workspace_task_steer with this workspace and the change written as a complete instruction. If the task cannot take the change, say so and offer to stop it and start again with the change. Then call workspace_task_resume with this workspace to wait for its answer. Do not start the task again, and do not reply before its answer.`;
}

function noTaskMessage(workspace: string): string {
  return `No coding task this response started is still running in the "${workspace}" workspace. Its answer was already returned, or it was never started.`;
}

function guidanceMessage(guidance: string): string {
  return `Guidance from the agent that sent your brief, sent while you work on it:\n\n${guidance}\n\nTake it into account from your next step.`;
}

/**
 * `workspace_task`: brief a coding worker to do multi-step repository work in
 * a coding workspace, and wait for its answer. Durable: the dispatch receipt
 * is a recorded step, so a coordinator retry re-observes the same task instead
 * of starting a second one. When new messages arrive meanwhile, the wait
 * pauses (see createWorkspaceTaskTools).
 */
export function createWorkspaceTaskTool(options: WorkspaceTaskToolOptions) {
  const taskTimeoutMs = options.taskTimeoutMs ?? WORKSPACE_TASK_TIMEOUT_MS;
  const tasks = workspaceTaskWaits(options);
  return defineTool({
    name: WORKSPACE_TASK_TOOL_NAME,
    description:
      `Brief a coding worker that works in the coding workspace with its own shell and file tools: it can clone, install dependencies, edit files, run tests or a build, push a branch, and open a pull request. The worker cannot see this conversation, so the task must be a complete brief: the repository, what to change, how to verify it, the branch name to use, and whether to open a pull request. It returns the worker's answer and any pull requests it opened. One task can run for up to ${taskTimeoutMs / 60_000} minutes; at most ${MAX_WORKSPACE_TASKS_PER_RESPONSE} tasks per response. If new messages arrive while it runs, it returns early with running: true; follow its message. Use workspace_write and workspace_read to move files in and out, and post_artifact with the workspace to attach a file the worker made.`,
    input: v.object({
      workspace: WORKSPACE_NAME,
      task: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_WORKSPACE_TASK_BRIEF_CHARS)),
    }),
    durable: true,
    timeoutMs: taskTimeoutMs + WORKSPACE_TASK_TOOL_GRACE_MS,
    async run({ data, step, signal, toolCallId }) {
      let session: WorkspaceSession | undefined;
      try {
        session = await options.resolve(normalizeWorkspaceName(data.workspace), 'use');
      } catch (error) {
        const mapped = workspaceFailure(error);
        if (mapped) return { output: mapped };
        throw error;
      }
      if (!session) return { output: failure('workspace_unavailable', WORKSPACE_UNAVAILABLE_MESSAGE) };

      // Checked and claimed with no await between, so parallel calls in one
      // step cannot both pass.
      const state = options.responseState();
      const running = state.running.get(session.id) ?? 0;
      if (running >= MAX_RUNNING_TASKS_PER_WORKSPACE) {
        return { output: failure('busy', `A coding task is already running in the "${session.name}" workspace. Wait for its answer before sending another there, or use another workspace.`) };
      }
      if (state.started >= MAX_WORKSPACE_TASKS_PER_RESPONSE) {
        return { output: failure('task_limit', `This response already delegated ${MAX_WORKSPACE_TASKS_PER_RESPONSE} coding tasks. Report what they returned; the person can ask for more in a follow-up.`) };
      }
      state.started += 1;
      state.running.set(session.id, running + 1);
      const milestones = createMilestoneRecorder(toolCallId, options.onMilestone);
      let paused = false;
      try {
        const outcome = await runTask(session, data.task);
        paused = isPause(outcome);
        return { output: withRestoreNotice(session, outcome) };
      } finally {
        // A throw (or an abandoned call) leaves its step failed and later
        // steps not run, so the indicator never shows work still going. A
        // paused task keeps running, and keeps its steps open.
        if (!paused) tasks.close(session.id, milestones);
      }

      async function runTask(target: WorkspaceSession, task: string): Promise<WorkspaceTaskOutcome> {
        // Activate the workspace here, in the coordinator: the session cap and
        // checkpoint restore belong to this turn's workspace session, and a
        // container that cannot start is answered without involving a worker.
        milestones.start('workspace');
        try {
          const sandbox = await target.sandbox();
          await sandbox.exists(WORKSPACE_DIR).catch(async (error: unknown) => {
            // Activation can lose the Durable Object connection mid-way; the
            // next call reconnects, so probe once more before failing.
            if (!(error instanceof SandboxConnectionDroppedError)) throw error;
            await sandbox.exists(WORKSPACE_DIR);
          });
        } catch (error) {
          const mapped = workspaceFailure(error);
          if (mapped) {
            milestones.stop('workspace_unavailable');
            return mapped;
          }
          throw error;
        }

        // Egress records only the first pull request a workspace sees in a
        // turn, so an earlier task's pull request is still recorded when a
        // later task in the same workspace finishes. Note it before this
        // task starts (recorded, so a retry compares against the same one)
        // and report the record only if this task made it.
        const before = await step.do('pull-request-before', async () => {
          const recorded = await options.recordedPullRequest?.(target).catch(() => undefined);
          return { url: recorded?.url ?? null };
        });

        const binding = options.binding(target.id);
        const instanceId = options.instanceId(binding);
        const handle = options.client.handle(instanceId);
        const taskKey = workspaceTaskDispatchKey(toolCallId);
        const stopped = (): WorkspaceTaskFailure => {
          milestones.stop('stopped');
          return failure('stopped', STOPPED_MESSAGE);
        };
        // A stopped run never dispatches: abort() does not cover a later
        // dispatch.
        if (signal?.aborted) return stopped();

        // The job's active-task record goes to the host turn before the
        // dispatch, so a stop always finds the worker (KTD4); it stays until
        // the job's submission settles or the stop reconciles it.
        const pending: CodingTaskRecordV1 = {
          schemaVersion: 1,
          taskKey,
          toolCallId,
          workspace: target.name,
          workspaceId: target.id,
          instanceId,
          state: 'dispatch_pending',
          pendingAt: (options.now ?? Date.now)(),
          timeoutMs: taskTimeoutMs,
        };
        if (options.prepareWorker) {
          try {
            await options.prepareWorker(instanceId, binding, taskKey);
          } catch {
            console.warn('[chickpea] coding worker could not be prepared');
            milestones.stop('workspace_unavailable');
            return failure('workspace_unavailable', WORKSPACE_UNAVAILABLE_MESSAGE);
          }
        }
        let hostTurnId: string | undefined;
        if (options.taskRecords) {
          try {
            // The turn this workspace is bound to: the host turn.
            hostTurnId = await (await target.activatable()).getTurnId();
            if (!hostTurnId) throw new Error('The workspace is bound to no turn.');
            await options.taskRecords.put(hostTurnId, pending);
          } catch {
            console.warn('[chickpea] coding task record write failed');
            milestones.stop('workspace_unavailable');
            return failure('workspace_unavailable', WORKSPACE_UNAVAILABLE_MESSAGE);
          }
        }

        // Stopped while the record was written: the stop, which aborts this
        // run before it reads the records, reconciles the pending one.
        if (signal?.aborted) return stopped();

        // A retried coordinator replays the recorded receipt; the idempotency
        // key also collapses a dispatch whose receipt was never recorded.
        const receipt = await step.do('dispatch', async () => boundedReceipt(await handle.dispatch({
          message: task,
          initialData: binding,
          idempotencyKey: taskKey,
        })));
        const accepted: AcceptedCodingTaskRecord = {
          ...pending,
          state: 'accepted',
          submissionId: receipt.submissionId,
          uid: receipt.uid,
          acceptedAt: receipt.acceptedAt,
        };
        if (options.taskRecords && hostTurnId) {
          // Best effort: the pending record already names the worker.
          await options.taskRecords.put(hostTurnId, accepted).catch(() => {
            console.warn('[chickpea] coding task record write failed');
          });
        }
        options.onWorkerStarted?.(binding.codingModel.model);
        milestones.settle('workspace', 'completed');
        milestones.start('changes');
        const open: OpenWorkspaceTask = {
          record: accepted,
          hostTurnId,
          milestones,
          pullRequestBefore: before.url,
          observing: false,
          checkFailed: false,
        };
        state.open.set(target.id, open);
        return tasks.wait(target, open, signal);
      }
    },
  });
}

/**
 * `workspace_task_resume`: wait again for a task whose wait paused. It
 * observes the same worker submission with the time left from its
 * acceptance, keeps the task's steps open, does not count toward the
 * per-response task limit, and answers as `workspace_task` would (or pauses
 * again).
 */
export function createWorkspaceTaskResumeTool(options: WorkspaceTaskToolOptions) {
  const taskTimeoutMs = options.taskTimeoutMs ?? WORKSPACE_TASK_TIMEOUT_MS;
  const tasks = workspaceTaskWaits(options);
  return defineTool({
    name: WORKSPACE_TASK_RESUME_TOOL_NAME,
    description:
      'Keep waiting for a coding task this response started, after workspace_task returned running: true. It returns the task\'s answer as workspace_task would, or returns running: true again if more messages arrive. It starts nothing and does not count toward the task limit.',
    input: v.object({ workspace: WORKSPACE_NAME }),
    timeoutMs: taskTimeoutMs + WORKSPACE_TASK_TOOL_GRACE_MS,
    async run({ data, signal }) {
      const found = await tasks.find(data.workspace);
      if (!('task' in found)) return { output: found };
      const { session, task } = found;
      if (task.observing) {
        return { output: failure('busy', `This response is already waiting for the task in the "${session.name}" workspace.`) };
      }
      task.milestones.write = options.onMilestone;
      let paused = false;
      try {
        const outcome = await tasks.wait(session, task, signal);
        paused = isPause(outcome);
        emitCodingTaskSteering({ turnJobId: task.hostTurnId, op: 'resume', outcome: outcomeToken(outcome) });
        return { output: outcome };
      } finally {
        if (!paused) tasks.close(session.id, task.milestones);
      }
    },
  });
}

/**
 * `workspace_task_steer`: pass the Agent's guidance to a task that is still
 * running, as a dispatch to the same worker, which Flue joins into the
 * worker's running response at its next step. The worker is the one the
 * task's binding names, so guidance never reaches another workspace or
 * gains a repository grant. It is sent only while the task's submission is
 * unsettled and the run's turn carries no stop record. A dispatch to a
 * worker whose task has just settled would wake a new response there, and
 * abort() does not cover a later dispatch, so the task is read again after
 * the dispatch: if it had settled, the worker is aborted (the woken
 * response is then its only unsettled work).
 */
export function createWorkspaceTaskSteerTool(options: WorkspaceTaskToolOptions) {
  const tasks = workspaceTaskWaits(options);
  return defineTool({
    name: WORKSPACE_TASK_STEER_TOOL_NAME,
    description:
      'Pass a change to a coding task that is still running, after workspace_task returned running: true. The worker reads it at its next step and adjusts its work; it gets no new access. The worker cannot see this conversation, so write the change as a complete instruction. Then call workspace_task_resume to wait for its answer.',
    input: v.object({
      workspace: WORKSPACE_NAME,
      guidance: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_WORKSPACE_TASK_GUIDANCE_CHARS)),
    }),
    durable: true,
    async run({ data, step, signal, toolCallId }) {
      const found = await tasks.find(data.workspace);
      if (!('task' in found)) return { output: found };
      const { session, task } = found;
      const { record } = task;
      const relayed = (outcome: string, output: WorkspaceTaskFailure | WorkspaceTaskRelay) => {
        emitCodingTaskSteering({ turnJobId: task.hostTurnId, op: 'relay', outcome });
        return { output };
      };
      if (signal?.aborted) return relayed('stopped', failure('stopped', STOPPED_MESSAGE));
      const binding = options.binding(record.workspaceId);
      // Grants that changed since the task started address another worker.
      if (options.instanceId(binding) !== record.instanceId) return relayed('not_sent', failure('not_sent', NOT_SENT_MESSAGE));
      const settled = () => options.client.settled({ instanceId: record.instanceId, submissionId: record.submissionId });
      try {
        if (await options.turnStopped?.()) return relayed('stopped', failure('stopped', STOPPED_MESSAGE));
        if (await settled()) return relayed('finished', failure('finished', FINISHED_MESSAGE));
      } catch {
        return relayed('not_sent', failure('not_sent', NOT_SENT_MESSAGE));
      }
      if (signal?.aborted) return relayed('stopped', failure('stopped', STOPPED_MESSAGE));
      const handle = options.client.handle(record.instanceId);
      // One key per relay call: a retried coordinator replays the receipt.
      await step.do('guidance', async () => boundedReceipt(await handle.dispatch({
        message: guidanceMessage(data.guidance),
        initialData: binding,
        idempotencyKey: `${record.taskKey}:guidance:${toolCallId}`,
      })));
      if (await settled().catch(() => false)) {
        await handle.abort().catch(() => undefined);
        return relayed('finished', failure('finished', FINISHED_MESSAGE));
      }
      return relayed('sent', {
        ok: true,
        workspace: session.name,
        sent: true,
        message: 'The worker reads the change at its next step. Call workspace_task_resume to wait for its answer.',
      });
    },
  });
}

export type WorkspaceTaskRelay = { ok: true; workspace: string; sent: true; message: string };

/**
 * The would-stop check for tasks a response left running: while one runs
 * with nobody waiting on it, the model is sent back to wait (the signal body
 * this returns), at most MAX_WORKSPACE_TASK_REMINDERS times. Past that, or
 * once the response can do no more work, nobody will read those tasks, so
 * their workers are stopped as a timeout stops them. A stopped run is left
 * to the stop, which stops them from their records.
 */
export function createWorkspaceTaskFinishCheck(options: WorkspaceTaskToolOptions) {
  const tasks = workspaceTaskWaits(options);
  return async (input: { workEnded: boolean }): Promise<string | undefined> => {
    const state = options.responseState();
    const left = [...state.open.entries()].filter(([, task]) => !task.observing);
    if (left.length === 0) return undefined;
    if (await options.turnStopped?.().catch(() => false)) return undefined;
    if (!input.workEnded && state.reminders < MAX_WORKSPACE_TASK_REMINDERS) {
      state.reminders += 1;
      const names = left.map(([, task]) => `"${task.record.workspace}"`).join(', ');
      return `A coding task this response started is still running (workspace ${names}), and nobody will read its answer once this reply posts. Call workspace_task_resume for it now, and answer once it returns.`;
    }
    for (const [workspaceId, task] of left) {
      await options.client.handle(task.record.instanceId).abort().catch(() => undefined);
      tasks.recordUsage(task, 'interrupted');
      task.milestones.write = options.onMilestone;
      tasks.close(workspaceId, task.milestones);
    }
    return undefined;
  };
}

/** The wait every task tool shares, over one response's bookkeeping. */
function workspaceTaskWaits(options: WorkspaceTaskToolOptions) {
  const now = options.now ?? Date.now;
  const checkMs = options.messageCheckMs ?? WORKSPACE_TASK_MESSAGE_CHECK_MS;

  const recordUsage = (task: OpenWorkspaceTask, status: CodingWorkerUsageRecord['status'], reply?: AgentReply) => {
    const metadata = reply
      ? parseChickpeaResponseMetadata(reply.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY])
      : undefined;
    try {
      options.onWorkerUsage?.({
        schemaVersion: 1,
        toolCallId: task.record.toolCallId,
        model: options.binding(task.record.workspaceId).codingModel.model,
        status,
        ...(metadata ? { usage: metadata.usage } : {}),
        ...(metadata?.returnedModel ? { returnedModel: metadata.returnedModel } : {}),
        settledAt: now(),
      });
    } catch (error) {
      console.warn(`[chickpea] coding worker usage write failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  };

  /** Release a task's workspace and settle its steps: its answer was read, or it ended. */
  const close = (workspaceId: string, milestones: MilestoneRecorder) => {
    milestones.stop('stopped');
    const state = options.responseState();
    if (state.open.get(workspaceId)?.milestones === milestones) state.open.delete(workspaceId);
    const remaining = (state.running.get(workspaceId) ?? 1) - 1;
    if (remaining > 0) state.running.set(workspaceId, remaining);
    else state.running.delete(workspaceId);
  };

  /**
   * The open task in a workspace: this response's, or (after the
   * coordinator restarted during a pause) the one its record names.
   */
  const find = async (name: string | undefined): Promise<{ session: WorkspaceSession; task: OpenWorkspaceTask } | WorkspaceTaskFailure> => {
    let session: WorkspaceSession | undefined;
    try {
      session = await options.resolve(normalizeWorkspaceName(name), 'inspect');
    } catch (error) {
      const mapped = workspaceFailure(error);
      if (mapped) return mapped;
      throw error;
    }
    if (!session) return failure('no_task', noTaskMessage(normalizeWorkspaceName(name)));
    const state = options.responseState();
    const open = state.open.get(session.id);
    if (open) return { session, task: open };
    const recovered = await recover(session).catch(() => undefined);
    if (!recovered) return failure('no_task', noTaskMessage(session.name));
    state.open.set(session.id, recovered);
    state.running.set(session.id, (state.running.get(session.id) ?? 0) + 1);
    return { session, task: recovered };
  };

  const recover = async (session: WorkspaceSession): Promise<OpenWorkspaceTask | undefined> => {
    if (!options.taskRecords?.list) return undefined;
    const hostTurnId = await (await session.activatable()).getTurnId();
    if (!hostTurnId) return undefined;
    const record = (await options.taskRecords.list(hostTurnId)).findLast(
      (entry): entry is AcceptedCodingTaskRecord => entry.state === 'accepted' && entry.workspaceId === session.id,
    );
    if (!record) return undefined;
    return {
      record,
      hostTurnId,
      milestones: createMilestoneRecorder(record.toolCallId, options.onMilestone, { settled: ['workspace'], active: 'changes' }),
      pullRequestBefore: undefined,
      observing: false,
      checkFailed: false,
    };
  };

  /**
   * Observe the task until it settles, its deadline (counted from its
   * acceptance) passes, the run stops, or new messages wait: then the call
   * returns a pause and the task, its record and its steps stay as they
   * are. The pause is its own signal, so it never reaches the branch that
   * aborts the worker.
   */
  const wait = async (
    target: WorkspaceSession,
    task: OpenWorkspaceTask,
    signal: AbortSignal | undefined,
  ): Promise<WorkspaceTaskOutcome> => {
    const { record, milestones } = task;
    const state = options.responseState();
    const handle = options.client.handle(record.instanceId);
    const receipt: DispatchReceipt = { submissionId: record.submissionId, acceptedAt: record.acceptedAt, uid: record.uid };
    const acceptedAt = Date.parse(record.acceptedAt);
    const elapsed = Number.isFinite(acceptedAt) ? Math.max(0, now() - acceptedAt) : 0;
    const deadline = AbortSignal.timeout(Math.max(0, record.timeoutMs - elapsed));
    const pause = new AbortController();
    const waited = new AbortController();
    const observation = AbortSignal.any([...(signal ? [signal] : []), deadline, pause.signal]);
    const settleRecord = async () => {
      if (!options.taskRecords || !task.hostTurnId) return;
      await options.taskRecords.settle(task.hostTurnId, record.taskKey).catch(() => {
        console.warn('[chickpea] coding task record settle failed');
      });
    };

    let pausedFor: 'messages' | 'unchecked' | undefined;
    const watch = async () => {
      const pending = options.pendingMessages;
      if (!pending) return;
      let failures = 0;
      while (!waited.signal.aborted && state.pauses < MAX_WORKSPACE_TASK_PAUSES) {
        try {
          const waiting = await pending();
          failures = 0;
          task.checkFailed = false;
          if (waiting) pausedFor = 'messages';
        } catch {
          failures += 1;
          // The fold pulls at the tool boundary whether or not this check
          // answered, so a pause still lets any waiting message land.
          if (failures >= MAX_FAILED_MESSAGE_CHECKS && !task.checkFailed) {
            task.checkFailed = true;
            pausedFor = 'unchecked';
          }
        }
        if (pausedFor) {
          pause.abort(new Error('The coding task wait paused for new messages.'));
          return;
        }
        await abortableDelay(checkMs, waited.signal);
      }
    };

    task.observing = true;
    void watch();
    let reply: AgentReply;
    try {
      reply = await options.client.observe({
        instanceId: record.instanceId,
        receipt,
        onEvent: createProgressRelay(record.submissionId, options.publishProgress),
        signal: observation,
      });
    } catch (error) {
      if (pause.signal.aborted && !signal?.aborted && !deadline.aborted) {
        state.pauses += 1;
        emitCodingTaskSteering({ turnJobId: task.hostTurnId, op: 'pause', outcome: pausedFor ?? 'messages' });
        return { ok: true, running: true, workspace: record.workspace, message: pauseMessage(record.workspace) };
      }
      if (observation.aborted) {
        // Stop the worker durably: a task nobody waits for must not keep
        // running, pushing, or spending. Not a confirmation, so the
        // record stays for a stop to confirm.
        await handle.abort().catch(() => undefined);
        recordUsage(task, 'interrupted');
        // The run itself was stopped. Flue discards this result; the
        // runner confirms the worker from the record (KTD4), and this
        // abort is only the fast path.
        if (signal?.aborted) {
          milestones.stop('stopped');
          return failure('stopped', STOPPED_MESSAGE);
        }
        milestones.stop('timeout');
        return failure('timeout', TIMEOUT_MESSAGE);
      }
      if (error instanceof AgentRunError || error instanceof AgentInstanceNotFoundError) {
        await settleRecord();
        recordUsage(task, 'failed');
        milestones.stop('worker_failed');
        return failure('worker_failed', WORKER_FAILED_MESSAGE);
      }
      // The observation broke, not the worker. Nobody will read this task
      // again, so stop it before reporting the fault.
      await handle.abort().catch(() => undefined);
      throw error;
    } finally {
      task.observing = false;
      waited.abort();
    }

    await settleRecord();
    recordUsage(task, 'completed', reply);

    // Egress saw a pull request being created: the authoritative record,
    // ahead of the links the worker wrote.
    const binding = options.binding(record.workspaceId);
    const found = new Map<string, WorkspaceTaskPullRequest>();
    const recorded = await options.recordedPullRequest?.(target).catch(() => undefined);
    if (recorded && recorded.url.toLowerCase() !== task.pullRequestBefore?.toLowerCase()) {
      found.set(recorded.url.toLowerCase(), { ...recorded });
    }
    for (const pullRequest of pullRequestLinks(reply.text, binding)) {
      if (!found.has(pullRequest.url.toLowerCase())) found.set(pullRequest.url.toLowerCase(), pullRequest);
    }
    const pullRequests = [...found.values()].slice(0, MAX_REPORTED_PULL_REQUESTS);
    const branch = workerBranch(reply.text);
    if (branch || pullRequests.length > 0) {
      milestones.settle('changes', 'changed', branch ? { branch } : { reason: 'no_branch' });
    } else {
      milestones.settle('changes', 'completed', { reason: 'no_branch' });
    }
    if (pullRequests.length > 0) {
      milestones.settle('pull_request', 'completed', {
        pullRequests: pullRequests.map(({ repository, number }) => ({ repository, number })),
      });
    } else {
      milestones.settle('pull_request', 'skipped', { reason: 'no_pull_request' });
    }
    const { text, truncated } = keepTail(reply.text.trim(), MAX_WORKSPACE_TASK_REPLY_CHARS);
    return {
      ok: true,
      workspace: record.workspace,
      reply: text,
      replyTruncated: truncated,
      pullRequests,
    };
  };

  return { wait, find, close, recordUsage };
}

function isPause(outcome: WorkspaceTaskOutcome): outcome is WorkspaceTaskPause {
  return outcome.ok && 'running' in outcome;
}

function outcomeToken(outcome: WorkspaceTaskOutcome): string {
  if (!outcome.ok) return outcome.reason;
  return isPause(outcome) ? 'paused' : 'completed';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, milliseconds);
    const done = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Pull request links in the worker's answer, limited to the granted
 * repositories so a model-invented link to anywhere else is never reported.
 */
export function pullRequestLinks(
  text: string,
  binding: Pick<CodingWorkerBinding, 'repositories'>,
): WorkspaceTaskPullRequest[] {
  const repositories = new Set(binding.repositories
    .filter((repository) => !repository.allRepos && repository.fullName)
    .map((repository) => repository.fullName.toLowerCase()));
  const owners = new Set(binding.repositories
    .filter((repository) => repository.allRepos)
    .map((repository) => (repository.accountLogin ?? repository.fullName.split('/', 1)[0] ?? '').toLowerCase())
    .filter(Boolean));
  const links: WorkspaceTaskPullRequest[] = [];
  const seen = new Set<string>();
  const pattern = /https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?![\w/])/g;
  for (const [, owner = '', name = '', digits = ''] of text.matchAll(pattern)) {
    const repository = `${owner}/${name}`;
    const granted = repositories.has(repository.toLowerCase()) || owners.has(owner.toLowerCase());
    const url = `https://github.com/${repository}/pull/${Number(digits)}`;
    if (!granted || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    links.push({ url, repository, number: Number(digits) });
  }
  return links;
}

/**
 * The branch the worker's answer names on its closing line
 * (`Branch: fix-login · Pull request: …`), or undefined for `none` or a name
 * that is not a plain branch name.
 */
export function workerBranch(text: string): string | undefined {
  const matches = [...text.matchAll(/^\s*[*_`]*Branch:?[*_`]*\s*:?\s*`?([^\s`·|]+)`?/gim)];
  const name = matches.at(-1)?.[1]?.replace(/[.,;]+$/, '');
  if (!name || /^(?:none|n\/a|-)$/i.test(name)) return undefined;
  return safeBranchName(name);
}

type MilestoneDetail = Pick<WorkspaceMilestoneRecord, 'reason' | 'branch' | 'pullRequests'>;

type MilestoneRecorder = ReturnType<typeof createMilestoneRecorder>;

/**
 * One task's milestone records, in order. It remembers which step is active
 * so `stop` can fail it and mark the rest not run, and it never lets a failed
 * write affect the task. A task recovered from its record resumes with its
 * workspace step settled and its changes step active.
 */
function createMilestoneRecorder(
  toolCallId: string,
  write: ((record: WorkspaceMilestoneRecord) => void) | undefined,
  resumed?: { settled: WorkspaceMilestone[]; active: WorkspaceMilestone },
) {
  const settled = new Set<WorkspaceMilestone>(resumed?.settled);
  let active: WorkspaceMilestone | undefined = resumed?.active;
  const record = (
    milestone: WorkspaceMilestone,
    state: WorkspaceMilestoneRecord['state'],
    detail: MilestoneDetail = {},
  ) => {
    if (!recorder.write) return;
    try {
      recorder.write({ schemaVersion: 1, toolCallId, milestone, state, ...detail });
    } catch (error) {
      console.warn(`[chickpea] workspace milestone write failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  };
  const recorder = {
    /** The writer of the call driving the task now; a resumed wait writes through its own. */
    write,
    start(milestone: WorkspaceMilestone) {
      if (settled.has(milestone) || active === milestone) return;
      active = milestone;
      record(milestone, 'started');
    },
    settle(milestone: WorkspaceMilestone, outcome: WorkspaceMilestoneOutcome, detail: MilestoneDetail = {}) {
      if (settled.has(milestone)) return;
      settled.add(milestone);
      if (active === milestone) active = undefined;
      record(milestone, outcome, detail);
    },
    /** Fail the active step (if any) and mark every unsettled step not run. */
    stop(reason: NonNullable<WorkspaceMilestoneRecord['reason']>) {
      if (settled.size === 0 && active === undefined) return;
      for (const milestone of WORKSPACE_MILESTONES) {
        if (settled.has(milestone)) continue;
        if (milestone === active) recorder.settle(milestone, 'failed', { reason });
        else recorder.settle(milestone, 'not_run', { reason: 'prior_failed' });
      }
    },
  };
  return recorder;
}

/**
 * The worker's tool calls as coordinator status lines. Only this task's
 * events count (a reused worker replays its earlier tasks first). A shell
 * command is reduced to one of a fixed set of stages (cloning, installing,
 * testing, committing, pushing, opening the pull request); nothing from a
 * tool's input or output reaches the line itself. A line is published only
 * when it changes.
 */
export function createProgressRelay(
  submissionId: string,
  publish: ((status: ActivityStatus) => void) | undefined,
): (chunk: ConversationStreamChunk) => void {
  let current = false;
  let last: string | undefined;
  return (chunk) => {
    const record = chunk as unknown as Record<string, unknown>;
    if (record.type === 'message-started') {
      current = record.submissionId === submissionId;
      return;
    }
    if (!current || record.type !== 'tool-input' || !publish) return;
    const status = workerToolStatus(String(record.toolName ?? ''), record.input);
    if (status.text === last) return;
    last = status.text;
    publish(status);
  };
}

function workerToolStatus(toolName: string, input: unknown): ActivityStatus {
  switch (toolName) {
    case 'bash': {
      const stage = toolActivityStatus('bash', input);
      // A command with no recognised stage keeps the workspace wording.
      if (stage.action === 'Running' && stage.object === 'a workspace command') {
        return activityStatus('running', 'Running commands in', 'the coding workspace', 'workspace');
      }
      return activityStatus(
        stage.kind ?? 'running',
        stage.action ?? 'Running',
        stage.object ?? 'commands',
        'workspace',
      );
    }
    case 'edit':
    case 'write':
      return activityStatus('writing', 'Editing files in', 'the coding workspace', 'workspace');
    case 'read':
    case 'grep':
    case 'glob':
      return activityStatus('reading', 'Reading code in', 'the coding workspace', 'workspace');
    default:
      return activityStatus('running', 'Working in', 'the coding workspace', 'workspace');
  }
}

function workspaceFailure(error: unknown): WorkspaceTaskFailure | undefined {
  if (error instanceof WorkspaceLimitError) return failure('workspace_limit', error.message);
  if (error instanceof WorkspaceNameError) return failure('invalid_input', error.message);
  if (error instanceof SandboxSessionCapError) return failure('session_cap', workspaceSessionCapMessage(error));
  if (
    error instanceof SandboxUnavailableError ||
    error instanceof SandboxConnectionDroppedError ||
    error instanceof SandboxDiedError
  ) {
    return failure('workspace_unavailable', WORKSPACE_UNAVAILABLE_MESSAGE);
  }
  return undefined;
}

function failure(reason: WorkspaceTaskFailureReason, message: string): WorkspaceTaskFailure {
  return { ok: false, reason, message };
}

function boundedReceipt(receipt: DispatchReceipt): DispatchReceipt {
  return {
    submissionId: receipt.submissionId,
    acceptedAt: receipt.acceptedAt,
    uid: receipt.uid,
  };
}

function keepTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}
