import { init, type AgentInstanceHandle, type DurabilityConfig } from '@flue/runtime';

import {
  agentObjectBindingName,
  createBoundedAgentReplyReader,
  type AgentObjectNamespace,
} from '../slack/bounded-agent-observation.ts';
import { publishActivityStatus } from '../slack/activity-publisher.ts';
import {
  codingWorkerBindingForPlan,
  codingWorkerInstanceId,
} from '../sandbox/coding-worker-binding.ts';
import { currentWorkspaceRegistry, type WorkspaceTurnRegistry } from '../sandbox/workspace-registry.ts';
import type { WorkspaceSession } from '../sandbox/workspace-session.ts';
import {
  createWorkspaceTaskTool,
  type CodingWorkerClient,
  type WorkspaceTaskResponseState,
} from '../sandbox/workspace-task.ts';
import { CHICKPEA_CODING_WORKER_AGENT_NAME } from './names.ts';
import type { CodingWorkerRunRecord } from '../slack/coding-worker-run.ts';
import type { RuntimePlanV2 } from './runtime-plan.ts';

/**
 * The budget of one coordinator submission (Flue's default is one hour and 10
 * attempts). It covers `MAX_WORKSPACE_TASKS_PER_RESPONSE` full-length coding
 * tasks plus the coordinator's own model time, and stays under the two-hour
 * Slack thread claim.
 */
export const CHICKPEA_SUBMISSION_DURABILITY: DurabilityConfig = {
  maxAttempts: 10,
  timeoutMs: 90 * 60_000,
};

/** The coordinator's one line on delegating; the tool description carries the rest. */
export const WORKSPACE_TASK_INSTRUCTION =
  'For repository work that needs a real checkout (installing dependencies, changing several files, running tests or a build, pushing a branch, opening a pull request), delegate to a coding worker with workspace_task and give it a complete brief; it runs on the workspace\'s coding model. Report the pull request links it returns. If a workspace tool reports the workspace unavailable or the worker failed, say so and use the Repositories API path when it covers the request.';

/** `workspace_task` for a coordinator running `plan`. */
export function createRuntimePlanWorkspaceTaskTool(input: {
  plan: RuntimePlanV2;
  /** The coordinator's own instance id; its status line shows the worker's progress. */
  coordinatorId: string;
  resolve: (name: string) => WorkspaceSession | undefined | Promise<WorkspaceSession | undefined>;
  onWorkerStarted: (record: CodingWorkerRunRecord) => void;
}) {
  return createWorkspaceTaskTool({
    resolve: input.resolve,
    binding: (workspaceId) => codingWorkerBindingForPlan(input.plan, workspaceId),
    instanceId: (binding) => {
      const id = codingWorkerInstanceId(binding);
      // Reading a submission on the instance running this tool deadlocks.
      if (id === input.coordinatorId) throw new Error('A coding worker cannot be its own coordinator.');
      return id;
    },
    client: cloudflareCodingWorkerClient(),
    responseState: () => responseState(currentWorkspaceRegistry()),
    onWorkerStarted: (model) => input.onWorkerStarted({ schemaVersion: 1, model }),
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
  if (!registry) return { started: 0, running: new Set() };
  let state = responseStates.get(registry);
  if (!state) {
    state = { started: 0, running: new Set() };
    responseStates.set(registry, state);
  }
  return state;
}

/**
 * Dispatch through Flue's `init()` and observe through the bounded reader on
 * the worker's Durable Object namespace. The agent module is imported lazily:
 * it imports the Slack agent module, which mounts this tool.
 */
function cloudflareCodingWorkerClient(): CodingWorkerClient {
  const workerHandle = async (instanceId: string): Promise<AgentInstanceHandle> => {
    const { CodingWorker } = await import('./coding-worker.ts');
    return init(CodingWorker, { id: instanceId });
  };
  const reader = createBoundedAgentReplyReader({
    agentName: CHICKPEA_CODING_WORKER_AGENT_NAME,
    resolveRoute: async (instanceId) => {
      const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
      const bindingName = agentObjectBindingName(CHICKPEA_CODING_WORKER_AGENT_NAME);
      const namespace = (getCloudflareContext().env as Record<string, unknown>)[bindingName] as
        AgentObjectNamespace | undefined;
      if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
        throw new Error(`Durable Object binding "${bindingName}" is unavailable.`);
      }
      const stub = namespace.get(namespace.idFromName(instanceId));
      return (request) => stub.fetch(request);
    },
  });
  return {
    handle: (instanceId) => ({
      dispatch: async (request) => (await workerHandle(instanceId)).dispatch(request),
      abort: async () => (await workerHandle(instanceId)).abort(),
    }),
    observe: async ({ instanceId, receipt, onEvent, signal }) => reader({
      handle: await workerHandle(instanceId),
      instanceId,
      receipt,
      onEvent,
      signal,
    }),
  };
}
