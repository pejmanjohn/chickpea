import { init, type AgentInstanceHandle, type DurabilityConfig } from '@flue/runtime';

import { createCloudflareBoundedAgentReplyReader } from '../slack/bounded-agent-observation.ts';
import { publishActivityStatus } from '../slack/activity-publisher.ts';
import {
  codingWorkerBindingForPlan,
  codingWorkerInstanceId,
} from '../sandbox/coding-worker-binding.ts';
import { currentWorkspaceRegistry, type WorkspaceTurnRegistry } from '../sandbox/workspace-registry.ts';
import { WORKSPACE_DELEGATION_GUIDANCE } from '../sandbox/workspace-skill.ts';
import {
  createWorkspaceTaskTool,
  emptyWorkspaceTaskResponseState,
  type CodingWorkerClient,
  type WorkspaceTaskResponseState,
  type WorkspaceTaskToolOptions,
} from '../sandbox/workspace-task.ts';
import { CHICKPEA_CODING_WORKER_AGENT_NAME } from './names.ts';
import type {
  CodingWorkerRunRecord,
  CodingWorkerUsageRecord,
  WorkspaceMilestoneRecord,
} from '../slack/coding-worker-run.ts';
import type { RuntimePlanV2 } from './runtime-plan.ts';

/**
 * The budget of one coordinator submission (Flue's default is one hour and 10
 * attempts). It covers `MAX_WORKSPACE_TASKS_PER_RESPONSE` full-length coding
 * tasks plus the coordinator's own model time.
 */
export const CHICKPEA_SUBMISSION_DURABILITY: DurabilityConfig = {
  maxAttempts: 10,
  timeoutMs: 155 * 60_000,
};

/** The coordinator's standing instruction on delegating; the tool description carries the brief. */
export const WORKSPACE_TASK_INSTRUCTION =
  `${WORKSPACE_DELEGATION_GUIDANCE} The worker runs on the workspace's coding model. Report the pull request links it returns. When a request spans two repositories, give each its own named workspace; tasks in different workspaces can run in parallel. If a workspace tool reports the workspace unavailable or the worker failed, say so and use the Repositories API path when it covers the request.`;

/** `workspace_task` for a coordinator running `plan`. */
export function createRuntimePlanWorkspaceTaskTool(input: {
  plan: RuntimePlanV2;
  /** The coordinator's own instance id; its status line shows the worker's progress. */
  coordinatorId: string;
  resolve: WorkspaceTaskToolOptions['resolve'];
  onWorkerStarted: (record: CodingWorkerRunRecord) => void;
  onWorkerUsage: (record: CodingWorkerUsageRecord) => void;
  onMilestone: (record: WorkspaceMilestoneRecord) => void;
}) {
  return createWorkspaceTaskTool({
    resolve: input.resolve,
    binding: (workspaceId) => codingWorkerBindingForPlan(input.plan, workspaceId),
    instanceId: codingWorkerInstanceId,
    client: cloudflareCodingWorkerClient(),
    responseState: () => responseState(currentWorkspaceRegistry()),
    onWorkerStarted: (model) => input.onWorkerStarted({ schemaVersion: 1, model }),
    onWorkerUsage: input.onWorkerUsage,
    onMilestone: input.onMilestone,
    publishProgress: (status) => publishActivityStatus(input.coordinatorId, status),
    recordedPullRequest: async (session) => {
      const stub = await session.activatable();
      return (await stub.getTurnProgress?.())?.pullRequest;
    },
  });
}

const responseStates = new WeakMap<WorkspaceTurnRegistry, WorkspaceTaskResponseState>();

/** One bookkeeping object per submission, keyed by its workspace registry. */
function responseState(registry: WorkspaceTurnRegistry | undefined): WorkspaceTaskResponseState {
  if (!registry) return emptyWorkspaceTaskResponseState();
  let state = responseStates.get(registry);
  if (!state) {
    state = emptyWorkspaceTaskResponseState();
    responseStates.set(registry, state);
  }
  return state;
}

/** Whether this submission has a coding task running in the workspace with this id. */
export function workspaceTaskRunning(workspaceId: string): boolean {
  const registry = currentWorkspaceRegistry();
  return registry ? (responseStates.get(registry)?.running.get(workspaceId) ?? 0) > 0 : false;
}

/**
 * Dispatch through Flue's `init()` and observe through the bounded reader on
 * the worker's Durable Object namespace. The agent module is imported lazily,
 * on the first task.
 */
function cloudflareCodingWorkerClient(): CodingWorkerClient {
  const workerHandle = async (instanceId: string): Promise<AgentInstanceHandle> => {
    const { CodingWorker } = await import('./coding-worker.ts');
    return init(CodingWorker, { id: instanceId });
  };
  return {
    handle: (instanceId) => {
      let worker: Promise<AgentInstanceHandle> | undefined;
      const get = () => (worker ??= workerHandle(instanceId));
      return {
        dispatch: async (request) => (await get()).dispatch(request),
        abort: async () => (await get()).abort(),
      };
    },
    observe: async ({ instanceId, receipt, onEvent, signal }) => {
      const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
      const reader = createCloudflareBoundedAgentReplyReader(
        getCloudflareContext().env as Record<string, unknown>,
        CHICKPEA_CODING_WORKER_AGENT_NAME,
      );
      return reader({ handle: await workerHandle(instanceId), instanceId, receipt, onEvent, signal });
    },
  };
}
