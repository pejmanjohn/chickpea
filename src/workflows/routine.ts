import {
  ResultUnavailableError,
  defineAgent,
  defineWorkflow,
  getRun,
  observe,
  type ActionContext,
  type AgentRuntimeConfig,
  type PromptUsage,
} from '@flue/runtime';
import * as v from 'valibot';

import { createSlackAgentRuntime, resolveAgentPlatformEnv } from '../agents/slack-thread.ts';
import {
  canonicalRuntimeModel,
  resolveRuntimeModel,
  type ProviderAuthRoute,
} from '../config/runtime-model.ts';
import {
  getRoutineStore,
  getSettingsStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  RoutineModelResultSchema,
  normalizeRoutineModelResult,
  prepareRoutinePrompt,
} from '../routines/prompt.ts';
import {
  deliverRoutineFailureNotice,
  deliverRoutineResult,
} from '../routines/delivery.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
  type RoutineRuntimeAccess,
} from '../routines/runtime.ts';
import type {
  RoutineDefinition,
  RoutineFailureClass,
  RoutineRun,
  RoutineStore,
} from '../routines/types.ts';
import {
  prepareCloudflareSandboxTurn,
  releaseCloudflareSandboxTurn,
} from '../slack/agent-dispatch.ts';
import { shouldUseCloudflareSandbox } from '../slack/run-turn.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';

const InputSchema = v.object({
  occurrenceId: v.pipe(v.string(), v.regex(/^rrun_[A-Za-z0-9_-]+$/)),
});

const OutputSchema = v.object({
  occurrenceId: v.string(),
  status: v.picklist(['succeeded', 'no_op']),
  message: v.string(),
  changeKeyHash: v.nullable(v.string()),
});

export interface RoutineWorkflowRuntime {
  flueRunId: string;
  env: PlatformEnv;
  store: RoutineStore;
  run: RoutineRun;
  routine: RoutineDefinition;
  access: RoutineRuntimeAccess;
  agentInstanceId: string;
  providerAuthRoute?: ProviderAuthRoute;
  usedCloudflareSandbox: boolean;
}

const runtimeByOccurrence = new Map<string, RoutineWorkflowRuntime>();

interface RoutineWorkflowInitializerDependencies {
  resolveAccess?: typeof resolveRoutineRuntimeAccess;
  useCloudflareSandbox?: typeof shouldUseCloudflareSandbox;
  prepareSandbox?: typeof prepareCloudflareSandboxTurn;
  releaseSandbox?: typeof releaseCloudflareSandboxTurn;
  createAgent?: typeof createSlackAgentRuntime;
  resolveModel?: typeof resolveRuntimeModel;
}

interface InterruptedRoutineWorkflowDependencies {
  env?: PlatformEnv;
  store?: RoutineStore;
  now?: () => number;
  releaseSandbox?: typeof releaseCloudflareSandboxTurn;
}

const routineAgent = defineAgent(async ({ id, env }) => {
  const platformEnv = env as PlatformEnv;
  const record = await getRun(id);
  const parsed = v.safeParse(InputSchema, record?.input);
  if (!record || record.workflowName !== 'routine' || !parsed.success) {
    throw new Error('Routine Workflow input is unavailable.');
  }
  const store = getRoutineStore(platformEnv);
  const run = await store.getRun(parsed.output.occurrenceId);
  if (!run) throw new Error('Routine occurrence is unavailable.');
  const routine = await store.getRoutine(run.routineId);
  if (!routine || routine.deletedAt !== null || routine.version < run.routineVersion) {
    await failBeforeStart(
      store,
      run,
      'result_invalid',
      'The saved routine revision is unavailable.',
    );
    throw new Error('Routine occurrence cannot resolve its saved revision.');
  }
  if (run.deadlineAt <= Date.now()) {
    await failBeforeStart(
      store,
      run,
      'deadline_exceeded',
      'The routine occurrence expired before execution began.',
    );
    throw new Error('Routine occurrence deadline expired.');
  }

  const runtime = await initializeRoutineWorkflowRuntime(
    { flueRunId: id, env: platformEnv, store, run, routine },
  );
  runtimeByOccurrence.set(run.id, runtime);
  return runtime.config;
});

export async function initializeRoutineWorkflowRuntime(
  input: {
    flueRunId: string;
    env: PlatformEnv;
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
  },
  dependencies: RoutineWorkflowInitializerDependencies = {},
): Promise<RoutineWorkflowRuntime & { config: AgentRuntimeConfig }> {
  const resolveAccess = dependencies.resolveAccess ?? resolveRoutineRuntimeAccess;
  const useCloudflareSandbox = dependencies.useCloudflareSandbox ?? shouldUseCloudflareSandbox;
  const prepareSandbox = dependencies.prepareSandbox ?? prepareCloudflareSandboxTurn;
  const releaseSandbox = dependencies.releaseSandbox ?? releaseCloudflareSandboxTurn;
  const createAgent = dependencies.createAgent ?? createSlackAgentRuntime;
  const resolveModel = dependencies.resolveModel ?? resolveRuntimeModel;
  let access: RoutineRuntimeAccess;
  try {
    access = await resolveAccess(input.run, input.routine, input.env);
  } catch (error) {
    const failure = runtimeFailure(error, false);
    await failBeforeStart(input.store, input.run, failure.failureClass, failure.publicError);
    throw new Error(failure.publicError);
  }
  let runtimeModel;
  try {
    runtimeModel = await resolveModel(access.config.agentId, access.config.model, {
      settings: getSettingsStore(input.env),
      env: input.env,
    });
  } catch (error) {
    const failure = runtimeFailure(error, false);
    await failBeforeStart(input.store, input.run, failure.failureClass, failure.publicError);
    throw new Error(failure.publicError);
  }
  const began = await input.store.beginOccurrence({
    occurrenceId: input.run.id,
    flueRunId: input.flueRunId,
    startedAt: Date.now(),
    resolvedAccessHash: access.accessHash,
    resolvedAgentId: access.config.agentId,
    model: access.config.model,
    ...(runtimeModel.providerAuthRoute
      ? { providerAuthRoute: runtimeModel.providerAuthRoute }
      : {}),
    traceId: input.flueRunId,
  });
  if (began === 'superseded') {
    throw new Error('Routine Workflow admission was superseded.');
  }

  const agentInstanceId = routineAgentInstanceId(input.flueRunId, input.routine);
  let usedCloudflareSandbox = false;
  try {
    usedCloudflareSandbox = await useCloudflareSandbox(access.config, input.env);
    if (usedCloudflareSandbox) {
      await prepareSandbox(input.env, agentInstanceId, input.run.id);
    }
    const config = await createAgent({
      id: agentInstanceId,
      platformEnv: input.env,
      workspaceId: input.routine.workspaceId,
      channelId: input.routine.channelId,
      liveConfig: access.config,
      runtimeModel,
      freezeChannel: false,
      artifactThreadTs: null,
    });
    return {
      flueRunId: input.flueRunId,
      env: input.env,
      store: input.store,
      run: input.run,
      routine: input.routine,
      access,
      agentInstanceId,
      ...(runtimeModel.providerAuthRoute
        ? { providerAuthRoute: runtimeModel.providerAuthRoute }
        : {}),
      usedCloudflareSandbox,
      config,
    };
  } catch (error) {
    await releaseSandbox(input.env, agentInstanceId, usedCloudflareSandbox);
    const failure = runtimeFailure(error, false);
    await failAfterStart(input.store, input.run, failure.failureClass, failure.publicError, 0);
    throw new Error(failure.publicError);
  }
}

export function routineAgentInstanceId(
  flueRunId: string,
  routine: Pick<RoutineDefinition, 'workspaceId' | 'channelId'>,
): string {
  return `routine:${flueRunId}:${routine.workspaceId}:${routine.channelId}`;
}

export default defineWorkflow({
  agent: routineAgent,
  input: InputSchema,
  output: OutputSchema,
  async run({ harness, input }: ActionContext<typeof InputSchema>) {
    const runtime = runtimeByOccurrence.get(input.occurrenceId);
    if (!runtime) {
      await failInterruptedRoutineWorkflow(input.occurrenceId);
      throw new Error('The routine Workflow was interrupted before execution could resume safely.');
    }
    let toolCallCount = 0;
    const unsubscribe = observe((event) => {
      if (event.runId === runtime.flueRunId && event.type === 'tool_start') {
        toolCallCount += 1;
      }
    });
    try {
      const prepared = await prepareRoutinePrompt(
        runtime.run,
        runtime.routine,
        runtime.access,
        runtime.env,
      );
      const remainingMs = runtime.run.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new RoutineRuntimeError(
          'deadline_exceeded',
          'The routine occurrence exceeded its execution deadline.',
        );
      }
      const session = await harness.session();
      const response = await session.prompt(prepared.prompt, {
        result: RoutineModelResultSchema,
        signal: AbortSignal.timeout(remainingMs),
      });
      if (!(await prepared.validateMemoryLease())) {
        throw new RoutineRuntimeError(
          toolCallCount > 0 ? 'unknown_external_outcome' : 'access_denied',
          'Channel access changed while the routine was running.',
        );
      }
      await prepared.confirmMemory();
      const result = normalizeRoutineModelResult(
        response.data,
        runtime.run,
        runtime.routine,
      );
      let delivered = false;
      if (result.status === 'succeeded') {
        await deliverRoutineResult({
          store: runtime.store,
          run: runtime.run,
          routine: runtime.routine,
          access: runtime.access,
          message: result.message,
          changeKeyHash: result.changeKeyHash,
        });
        delivered = true;
      }
      try {
        await runtime.store.transitionRun({
          occurrenceId: runtime.run.id,
          from: ['running'],
          to: result.status,
          at: Date.now(),
          model: routineModelLabel(response.model),
          ...routineUsageMetadata(response.usage, runtime.providerAuthRoute),
          toolCallCount,
          changeKeyHash: result.changeKeyHash,
          suppressedAsNoOp: result.suppressedAsNoOp,
        });
      } catch (error) {
        if (delivered) {
          throw new RoutineRuntimeError(
            'unknown_external_outcome',
            'The Slack result was posted but the occurrence could not be finalized.',
          );
        }
        throw error;
      }
      return {
        occurrenceId: runtime.run.id,
        status: result.status,
        message: result.message,
        changeKeyHash: result.changeKeyHash,
      };
    } catch (error) {
      const failure = runtimeFailure(error, toolCallCount > 0);
      await failAfterStart(
        runtime.store,
        runtime.run,
        failure.failureClass,
        failure.publicError,
        toolCallCount,
      );
      await deliverFailureNoticeBestEffort(runtime, failure.publicError);
      throw new Error(failure.publicError);
    } finally {
      unsubscribe();
      runtimeByOccurrence.delete(input.occurrenceId);
      await releaseCloudflareSandboxTurn(
        runtime.env,
        runtime.agentInstanceId,
        runtime.usedCloudflareSandbox,
      );
    }
  },
});

/**
 * A Workflow Action must never leave product state running when its ephemeral
 * initializer context is gone. Do not retry model/tool work: record a proven
 * interruption and let the next scheduled occurrence start independently.
 */
export async function failInterruptedRoutineWorkflow(
  occurrenceId: string,
  dependencies: InterruptedRoutineWorkflowDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? await resolveAgentPlatformEnv();
  const store = dependencies.store ?? getRoutineStore(env);
  const now = dependencies.now ?? Date.now;
  const releaseSandbox = dependencies.releaseSandbox ?? releaseCloudflareSandboxTurn;
  const run = await store.getRun(occurrenceId);
  if (!run || (run.status !== 'admitting' && run.status !== 'running')) return;
  const routine = await store.getRoutine(run.routineId);
  try {
    await store.transitionRun({
      occurrenceId,
      from: [run.status],
      to: 'failed',
      at: now(),
      failureClass: 'workflow_interrupted',
      publicError: 'The routine Workflow was interrupted before execution could resume safely.',
      toolCallCount: run.toolCallCount,
    });
  } finally {
    if (routine && run.flueRunId) {
      await releaseSandbox(
        env,
        routineAgentInstanceId(run.flueRunId, routine),
        true,
      );
    }
  }
}

async function failBeforeStart(
  store: RoutineStore,
  run: RoutineRun,
  failureClass: RoutineFailureClass,
  publicError: string,
): Promise<void> {
  await store.transitionRun({
    occurrenceId: run.id,
    from: ['admitting'],
    to: 'failed',
    at: Date.now(),
    failureClass,
    publicError,
  });
}

async function deliverFailureNoticeBestEffort(
  runtime: RoutineWorkflowRuntime,
  publicError: string,
): Promise<void> {
  try {
    const [run, routine] = await Promise.all([
      runtime.store.getRun(runtime.run.id),
      runtime.store.getRoutine(runtime.routine.id),
    ]);
    if (!run || !routine || run.status !== 'failed' || run.deliveryStatus !== 'none') return;
    await deliverRoutineFailureNotice({
      store: runtime.store,
      run,
      routine,
      access: runtime.access,
      publicError,
    });
  } catch {
    // Terminal notices are one best-effort attempt. The run remains visible in
    // `!routines show` and Admin Scheduled Work even when Slack is unavailable.
  }
}

async function failAfterStart(
  store: RoutineStore,
  run: RoutineRun,
  failureClass: RoutineFailureClass,
  publicError: string,
  toolCallCount: number,
): Promise<void> {
  const current = await store.getRun(run.id);
  if (current?.status !== 'running') return;
  await store.transitionRun({
    occurrenceId: run.id,
    from: ['running'],
    to: 'failed',
    at: Date.now(),
    failureClass,
    publicError,
    toolCallCount,
  });
}

function runtimeFailure(
  error: unknown,
  externalOutcomeMayBeUnknown: boolean,
): { failureClass: RoutineFailureClass; publicError: string } {
  if (externalOutcomeMayBeUnknown) {
    return {
      failureClass: 'unknown_external_outcome',
      publicError: 'The routine stopped after a tool call with an outcome that may require inspection.',
    };
  }
  if (error instanceof RoutineRuntimeError) {
    return { failureClass: error.failureClass, publicError: error.publicError };
  }
  if (error instanceof OpenAiSubscriptionError) {
    if (error.code === 'preview_disabled') {
      return {
        failureClass: 'policy_denied',
        publicError: 'The ChatGPT Subscription preview is disabled for this installation. API-key billing was not used.',
      };
    }
    if (
      error.code === 'auth_reconnect_required' ||
      error.code === 'authorization_missing' ||
      error.code === 'storage_invalid'
    ) {
      return {
        failureClass: 'credential_unavailable',
        publicError: 'The ChatGPT subscription connection needs attention in Settings. API-key billing was not used.',
      };
    }
    if (error.code === 'subscription_quota_exhausted') {
      return {
        failureClass: 'capacity_limited',
        publicError: 'The ChatGPT subscription quota could not serve this occurrence. API-key billing was not used.',
      };
    }
    if (
      error.code === 'entitlement_denied' ||
      error.code === 'client_rejected' ||
      error.code === 'originator_rejected'
    ) {
      return {
        failureClass: 'policy_denied',
        publicError: 'The connected ChatGPT subscription did not authorize this occurrence. API-key billing was not used.',
      };
    }
  }
  if (error instanceof ResultUnavailableError) {
    return {
      failureClass: 'result_invalid',
      publicError: 'The routine did not produce a valid structured result.',
    };
  }
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return {
      failureClass: 'deadline_exceeded',
      publicError: 'The routine occurrence exceeded its execution deadline.',
    };
  }
  return { failureClass: 'tool_failed', publicError: 'The routine could not complete safely.' };
}

export function routineUsageMetadata(usage: PromptUsage, route?: ProviderAuthRoute): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costEstimate?: number;
  costUnit: string;
} {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...(route === 'openai_subscription' ? {} : { costEstimate: usage.cost.total }),
    costUnit: route === 'openai_subscription'
      ? 'chatgpt_subscription_quota'
      : 'model_registry_unit',
  };
}

export function routineModelLabel(model: { provider: string; id: string }): string {
  return canonicalRuntimeModel(
    model.id.includes('/') ? model.id : `${model.provider}/${model.id}`,
  );
}
