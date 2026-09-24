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
import type { TurnPullRequestProgress } from '../config/state-rpc.ts';
import type { CodingWorkerBindingV1 } from './coding-worker-binding.ts';
import { SandboxSessionCapError, SandboxUnavailableError } from './errors.ts';
import { WORKSPACE_DIR } from './workspace-lifecycle.ts';
import { DEFAULT_WORKSPACE_NAME, type WorkspaceSession } from './workspace-session.ts';
import {
  WORKSPACE_SESSION_CAP_MESSAGE,
  WORKSPACE_TASK_TOOL_NAME,
  WORKSPACE_UNAVAILABLE_MESSAGE,
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
  | 'worker_failed'
  | 'busy'
  | 'task_limit'
  | 'unknown_workspace';

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

/** One worker instance, as the tool drives it. */
export interface CodingWorkerHandle {
  dispatch(request: {
    message: string;
    initialData: CodingWorkerBindingV1;
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
}

/** Per-response bookkeeping: tasks started and workspaces with a task running. */
export interface WorkspaceTaskResponseState {
  started: number;
  running: Set<string>;
}

export interface WorkspaceTaskToolOptions {
  /** The session for a workspace name this response, or undefined when it has none. */
  resolve: (name: string) => WorkspaceSession | undefined | Promise<WorkspaceSession | undefined>;
  /** The worker binding for a workspace id, frozen from the coordinator's plan. */
  binding: (workspaceId: string) => CodingWorkerBindingV1;
  /** The worker instance id for a binding. */
  instanceId: (binding: CodingWorkerBindingV1) => string;
  client: CodingWorkerClient;
  /** This response's bookkeeping; one object for the whole response. */
  responseState: () => WorkspaceTaskResponseState;
  /** Called once a worker accepted a task, with the model it runs on. */
  onWorkerStarted?: (model: string) => void;
  /** Relays the worker's progress to the coordinator's visible status. */
  publishProgress?: (status: ActivityStatus) => void;
  /** Pull requests the workspace's egress recorded for this turn. */
  recordedPullRequest?: (session: WorkspaceSession) => Promise<TurnPullRequestProgress | undefined>;
  /** Test seam for the task deadline. */
  taskTimeoutMs?: number;
}

const WORKER_FAILED_MESSAGE =
  'The coding worker could not finish this task (its container or its coding model failed). Say so plainly. If the work is small, use the Repositories API path; otherwise the person can ask again later. Do not retry this call in the same reply.';
const TIMEOUT_MESSAGE =
  'The coding task did not finish in time and was stopped. Report what is known; a pushed branch may already hold partial work. Do not retry the same task in the same reply.';

/**
 * `workspace_task`: brief a coding worker to do multi-step repository work in
 * a coding workspace, and wait for its answer. Durable: the dispatch receipt
 * is a recorded step, so a coordinator retry re-observes the same task instead
 * of starting a second one.
 */
export function createWorkspaceTaskTool(options: WorkspaceTaskToolOptions) {
  const taskTimeoutMs = options.taskTimeoutMs ?? WORKSPACE_TASK_TIMEOUT_MS;
  return defineTool({
    name: WORKSPACE_TASK_TOOL_NAME,
    description:
      `Delegate repository work that needs a real checkout to a coding worker in the coding workspace: cloning, installing dependencies, editing several files, running tests or a build, pushing a branch, and opening a pull request. The worker cannot see this conversation, so the task must be a complete brief: the repository, what to change, how to verify it, the branch name to use, and whether to open a pull request. It returns the worker's answer and any pull requests it opened. One task can run for up to ${taskTimeoutMs / 60_000} minutes; at most ${MAX_WORKSPACE_TASKS_PER_RESPONSE} tasks per response. Use workspace_write and workspace_read to move files in and out, and post_artifact with the workspace to attach a file the worker made.`,
    input: v.object({
      workspace: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
      task: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_WORKSPACE_TASK_BRIEF_CHARS)),
    }),
    durable: true,
    timeoutMs: taskTimeoutMs + WORKSPACE_TASK_TOOL_GRACE_MS,
    async run({ data, step, signal, toolCallId }) {
      const name = data.workspace ?? DEFAULT_WORKSPACE_NAME;
      if (name !== DEFAULT_WORKSPACE_NAME) {
        return { output: failure('unknown_workspace', `Only the "${DEFAULT_WORKSPACE_NAME}" workspace is available.`) };
      }
      const session = await options.resolve(name);
      if (!session) return { output: failure('workspace_unavailable', WORKSPACE_UNAVAILABLE_MESSAGE) };

      const state = options.responseState();
      if (state.running.has(session.id)) {
        return { output: failure('busy', 'A coding task is already running in this workspace. Wait for its answer before sending another.') };
      }
      if (state.started >= MAX_WORKSPACE_TASKS_PER_RESPONSE) {
        return { output: failure('task_limit', `This response already delegated ${MAX_WORKSPACE_TASKS_PER_RESPONSE} coding tasks. Report what they returned; the person can ask for more in a follow-up.`) };
      }
      state.started += 1;
      state.running.add(session.id);
      try {
        return { output: await runTask(session, data.task) };
      } finally {
        state.running.delete(session.id);
      }

      async function runTask(
        target: WorkspaceSession,
        task: string,
      ): Promise<WorkspaceTaskResult | WorkspaceTaskFailure> {
        // Activate the workspace here, in the coordinator: the session cap and
        // checkpoint restore belong to this turn's workspace session, and a
        // container that cannot start is answered without involving a worker.
        try {
          const sandbox = await target.sandbox();
          await sandbox.exists(WORKSPACE_DIR);
        } catch (error) {
          const mapped = workspaceFailure(error);
          if (mapped) return mapped;
          throw error;
        }

        const binding = options.binding(target.id);
        const instanceId = options.instanceId(binding);
        const handle = options.client.handle(instanceId);
        // A retried coordinator replays the recorded receipt; the idempotency
        // key also collapses a dispatch whose receipt was never recorded.
        const receipt = await step.do('dispatch', async () => boundedReceipt(await handle.dispatch({
          message: task,
          initialData: binding,
          idempotencyKey: `workspace_task:${toolCallId}`,
        })));
        options.onWorkerStarted?.(binding.codingModel.model);

        const deadline = AbortSignal.timeout(taskTimeoutMs);
        const observation = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const progress = createProgressRelay(receipt.submissionId, options.publishProgress);
        let reply: AgentReply;
        try {
          reply = await options.client.observe({
            instanceId,
            receipt,
            onEvent: progress,
            signal: observation,
          });
        } catch (error) {
          if (observation.aborted) {
            // Stop the worker durably: a task nobody waits for must not keep
            // running, pushing, or spending.
            await handle.abort().catch(() => undefined);
            return failure('timeout', TIMEOUT_MESSAGE);
          }
          if (error instanceof AgentRunError || error instanceof AgentInstanceNotFoundError) {
            return failure('worker_failed', WORKER_FAILED_MESSAGE);
          }
          // The observation broke, not the worker. Nobody will read this task
          // again, so stop it before reporting the fault.
          await handle.abort().catch(() => undefined);
          throw error;
        }

        // Egress saw a pull request being created: the authoritative record,
        // ahead of the links the worker wrote.
        const found = new Map<string, WorkspaceTaskPullRequest>();
        const recorded = await options.recordedPullRequest?.(target).catch(() => undefined);
        if (recorded) found.set(recorded.url.toLowerCase(), { ...recorded });
        for (const pullRequest of pullRequestLinks(reply.text, binding)) {
          if (!found.has(pullRequest.url.toLowerCase())) found.set(pullRequest.url.toLowerCase(), pullRequest);
        }
        const { text, truncated } = keepTail(reply.text.trim(), MAX_WORKSPACE_TASK_REPLY_CHARS);
        return {
          ok: true,
          workspace: target.name,
          reply: text,
          replyTruncated: truncated,
          pullRequests: [...found.values()].slice(0, MAX_REPORTED_PULL_REQUESTS),
        };
      }
    },
  });
}

/**
 * Pull request links in the worker's answer, limited to the granted
 * repositories so a model-invented link to anywhere else is never reported.
 */
export function pullRequestLinks(
  text: string,
  binding: Pick<CodingWorkerBindingV1, 'repositories'>,
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
 * The worker's tool calls as coordinator status lines. Only this task's
 * events count (a reused worker replays its earlier tasks first), only the
 * tool name is read (never its input or output), and a line is published only
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
    const status = workerToolStatus(String(record.toolName ?? ''));
    if (status.text === last) return;
    last = status.text;
    publish(status);
  };
}

function workerToolStatus(toolName: string): ActivityStatus {
  switch (toolName) {
    case 'bash':
      return activityStatus('running', 'Running commands in', 'the coding workspace', 'workspace');
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
  if (error instanceof SandboxSessionCapError) return failure('session_cap', WORKSPACE_SESSION_CAP_MESSAGE);
  if (error instanceof SandboxUnavailableError || error instanceof SandboxDiedError) {
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
