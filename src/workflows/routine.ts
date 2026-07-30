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
  safeRuntimeModelRouteEvidence,
  type ProviderAuthRoute,
  type SafeRuntimeModelRouteEvidence,
} from '../config/runtime-model.ts';
import {
  getRoutineStore,
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import type { SettingsStore } from '../config/settings-store.ts';
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
import {
  RoutineUsageRecorder,
  usageRuntimeRecordingEnabled,
} from '../usage/runtime-recorder.ts';
import type { UsageStore } from '../usage/types.ts';
import { createWorkExecutionLifecycle } from '../work/executor.ts';
import { shadowRunExecutionId } from '../work/lifecycle.ts';
import type { ShadowWorkLifecycle } from '../work/lifecycle.ts';
import type { RunId } from '../work/types.ts';
import { opaqueId } from '../work/admission.ts';

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
  routeEvidence: SafeRuntimeModelRouteEvidence;
  usedCloudflareSandbox: boolean;
  usageRecorder?: RoutineUsageRecorder;
  workLifecycle?: ShadowWorkLifecycle;
}

const runtimeByOccurrence = new Map<string, RoutineWorkflowRuntime>();

interface RoutineWorkflowInitializerDependencies {
  resolveAccess?: typeof resolveRoutineRuntimeAccess;
  useCloudflareSandbox?: typeof shouldUseCloudflareSandbox;
  prepareSandbox?: typeof prepareCloudflareSandboxTurn;
  releaseSandbox?: typeof releaseCloudflareSandboxTurn;
  createAgent?: typeof createSlackAgentRuntime;
  usageStore?: UsageStore;
  settingsStore?: SettingsStore;
  resolveCredential?: typeof resolveModelCredentialAttribution;
  usageRecordingEnabled?: boolean;
  now?: () => number;
  resolveModel?: typeof resolveRuntimeModel;
}

interface InterruptedRoutineWorkflowDependencies {
  env?: PlatformEnv;
  store?: RoutineStore;
  now?: () => number;
  releaseSandbox?: typeof releaseCloudflareSandboxTurn;
  usageStore?: UsageStore;
  usageRecordingEnabled?: boolean;
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
  const now = dependencies.now ?? Date.now;
  const resolveModel = dependencies.resolveModel ?? resolveRuntimeModel;
  let access: RoutineRuntimeAccess;
  try {
    access = await resolveAccess(input.run, input.routine, input.env);
  } catch (error) {
    const failure = runtimeFailure(error, false);
    await failBeforeStart(input.store, input.run, failure.failureClass, failure.publicError);
    throw new Error(failure.publicError);
  }
  const startedAt = now();
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
    startedAt,
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

  const usageStore = dependencies.usageStore ?? getUsageStore(input.env);
  const resolveCredential = dependencies.resolveCredential ?? resolveModelCredentialAttribution;
  const modelCredential = access.config.modelCredential ?? await resolveCredential(
    access.config.model,
    input.env,
    dependencies.settingsStore ?? getSettingsStore(input.env),
    usageStore,
  ).catch(() => null);
  if (modelCredential && !access.config.modelCredential) {
    access = { ...access, config: { ...access.config, modelCredential } };
  }
  const routeEvidence = safeRuntimeModelRouteEvidence(
    access.config.model,
    runtimeModel.providerAuthRoute,
    modelCredential ?? undefined,
  );

  let usageRecorder: RoutineUsageRecorder | undefined;
  const recordingEnabled = dependencies.usageRecordingEnabled ??
    usageRuntimeRecordingEnabled(input.env);
  if (recordingEnabled) {
    const canonicalRunId = input.run.canonicalRunId as RunId | null | undefined;
    usageRecorder = new RoutineUsageRecorder({
      operationId: input.run.id,
      executionId: `exec:${input.run.id}:${input.flueRunId}`,
      ...(canonicalRunId
        ? {
            runId: canonicalRunId,
            runExecutionId: shadowRunExecutionId(canonicalRunId, 1),
          }
        : {}),
      startedAt,
      workspaceId: input.routine.workspaceId,
      channelId: input.routine.channelId,
      profileId: access.config.agentId,
      profileLabel: access.config.agent.name,
      routineId: input.routine.id,
      routineLabel: input.routine.name,
      requestedModel: access.config.model,
      credentialRefId: modelCredential?.credentialRefId ?? null,
      credentialVersion: modelCredential?.version ?? null,
      store: usageStore,
      platformEnv: input.env,
      now,
    });
    await usageRecorder.admit();
  }

  const agentInstanceId = routineAgentInstanceId(input.flueRunId);
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
      routeEvidence,
      usedCloudflareSandbox,
      ...(usageRecorder ? { usageRecorder } : {}),
      config,
    };
  } catch (error) {
    await releaseSandbox(input.env, agentInstanceId, usedCloudflareSandbox);
    const failure = runtimeFailure(error, false);
    await usageRecorder?.recordTerminal({
      status: 'failed',
      unknownReason: 'provider_request_unknown',
    });
    await failAfterStart(
      input.store,
      input.run,
      failure.failureClass,
      failure.publicError,
      0,
      usageRecorder ? usageTransitionMetadata(input.run.id, 'not_reported') : undefined,
    );
    await usageRecorder?.repairAfterTerminal();
    throw new Error(failure.publicError);
  }
}

export function routineAgentInstanceId(
  flueRunId: string,
): string {
  return opaqueId('routineagent', flueRunId);
}

async function createRoutineShadowLifecycle(
  runtime: RoutineWorkflowRuntime,
  preparedInput: string,
): Promise<ShadowWorkLifecycle | undefined> {
  if (!runtime.run.canonicalRunId) return undefined;
  try {
    const store = getWorkStore(runtime.env);
    const lifecycle = await createWorkExecutionLifecycle(store, {
      runId: runtime.run.canonicalRunId,
      attemptNumber: 1,
      executorKind: 'workflow',
      agentName: runtime.access.config.agentId,
      canonicalModel: runtime.access.config.model,
      flueInstanceRef: opaqueId('flueinstance', runtime.agentInstanceId),
      routeEvidence: runtime.routeEvidence,
    });
    return await lifecycle.prepareExecution(preparedInput) ? lifecycle : undefined;
  } catch {
    console.warn('[work] Routine shadow lifecycle initialization failed; Workflow will continue');
    return undefined;
  }
}

function routineLifecycleFailureCode(failureClass: RoutineFailureClass): string {
  const normalized = failureClass.replace(/[^a-z0-9_]/g, '_');
  return normalized.length >= 3 && normalized.length <= 63
    ? normalized
    : 'routine_failed';
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
    let modelSettled = false;
    let promptUsage: PromptUsage | undefined;
    let promptModel: { provider: string; id: string } | undefined;
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
      const workLifecycle = await createRoutineShadowLifecycle(runtime, prepared.prompt);
      if (workLifecycle) runtime.workLifecycle = workLifecycle;
      const remainingMs = runtime.run.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new RoutineRuntimeError(
          'deadline_exceeded',
          'The routine occurrence exceeded its execution deadline.',
        );
      }
      const session = await harness.session();
      await runtime.workLifecycle?.markInvoked();
      const response = await session.prompt(prepared.prompt, {
        result: RoutineModelResultSchema,
        signal: AbortSignal.timeout(remainingMs),
      });
      promptUsage = response.usage;
      promptModel = response.model;
      await runtime.workLifecycle?.settleExecution({
        outcome: 'succeeded',
        rawStatus: 'flue_succeeded',
        flueSubmissionRef: opaqueId('fluesubmission', runtime.flueRunId),
      });
      modelSettled = true;
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
          ...(runtime.workLifecycle ? { workLifecycle: runtime.workLifecycle } : {}),
        });
        delivered = true;
      } else {
        await runtime.workLifecycle?.settleWithoutDelivery({
          terminalDisposition: 'no_op',
        });
      }
      await runtime.usageRecorder?.recordTerminal({
        status: 'completed',
        usage: response.usage,
        returnedModel: response.model,
      });
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
          ...(runtime.usageRecorder
            ? usageTransitionMetadata(runtime.run.id, routineUsageCompleteness(response.usage))
            : {}),
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
      await runtime.usageRecorder?.repairAfterTerminal();
      return {
        occurrenceId: runtime.run.id,
        status: result.status,
        message: result.message,
        changeKeyHash: result.changeKeyHash,
      };
    } catch (error) {
      const failure = runtimeFailure(error, toolCallCount > 0);
      if (!modelSettled) {
        await runtime.workLifecycle?.settleExecution({
          outcome: toolCallCount > 0 ? 'ambiguous' : 'failed',
          rawStatus: toolCallCount > 0 ? 'flue_ambiguous' : 'flue_failed',
          safeFailureCode: routineLifecycleFailureCode(failure.failureClass),
          flueSubmissionRef: opaqueId('fluesubmission', runtime.flueRunId),
        });
      }
      const completeness = routineUsageCompleteness(promptUsage);
      await runtime.usageRecorder?.recordTerminal({
        status: failure.failureClass === 'workflow_interrupted' ? 'interrupted' : 'failed',
        ...(promptUsage ? { usage: promptUsage } : {}),
        ...(promptModel ? { returnedModel: promptModel } : {}),
        unknownReason: failure.failureClass === 'deadline_exceeded'
          ? 'stream_interrupted'
          : 'provider_request_unknown',
      });
      await failAfterStart(
        runtime.store,
        runtime.run,
        failure.failureClass,
        failure.publicError,
        toolCallCount,
        runtime.usageRecorder
          ? usageTransitionMetadata(runtime.run.id, completeness)
          : undefined,
      );
      await runtime.usageRecorder?.repairAfterTerminal();
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
  const recordingEnabled = dependencies.usageRecordingEnabled ?? usageRuntimeRecordingEnabled(env);
  const usageRecorder = recordingEnabled && routine
    ? new RoutineUsageRecorder({
        operationId: run.id,
        executionId: `exec:${run.id}:${run.flueRunId ?? 'interrupted'}`,
        startedAt: run.startedAt ?? run.admittedAt ?? run.queuedAt,
        workspaceId: routine.workspaceId,
        channelId: routine.channelId,
        profileId: run.resolvedAgentId,
        profileLabel: run.resolvedAgentId,
        routineId: routine.id,
        routineLabel: routine.name,
        requestedModel: run.model,
        credentialRefId: null,
        credentialVersion: null,
        store: dependencies.usageStore ?? getUsageStore(env),
        ...(env ? { platformEnv: env } : {}),
        now,
      })
    : undefined;
  try {
    await usageRecorder?.admit();
    await usageRecorder?.recordTerminal({
      status: 'interrupted',
      unknownReason: 'stream_interrupted',
    });
    await store.transitionRun({
      occurrenceId,
      from: [run.status],
      to: 'failed',
      at: now(),
      failureClass: 'workflow_interrupted',
      publicError: 'The routine Workflow was interrupted before execution could resume safely.',
      toolCallCount: run.toolCallCount,
      ...(usageRecorder ? usageTransitionMetadata(run.id, 'not_reported') : {}),
    });
  } finally {
    await usageRecorder?.repairAfterTerminal();
    if (routine && run.flueRunId) {
      await releaseSandbox(
        env,
        routineAgentInstanceId(run.flueRunId),
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
      ...(runtime.workLifecycle ? { workLifecycle: runtime.workLifecycle } : {}),
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
  usage?: Pick<
    Parameters<RoutineStore['transitionRun']>[0],
    'usageLedgerOperationId' | 'usageProvenance' | 'usageCompleteness'
  >,
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
    ...usage,
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

function routineUsageCompleteness(
  usage: Pick<PromptUsage, 'input' | 'output' | 'totalTokens'> | undefined,
): 'complete' | 'not_reported' {
  if (!usage) return 'not_reported';
  return usage.input === 0 && usage.output === 0 && usage.totalTokens === 0
    ? 'not_reported'
    : 'complete';
}

function usageTransitionMetadata(
  operationId: string,
  completeness: 'complete' | 'partial' | 'not_reported',
): {
  usageLedgerOperationId: string;
  usageProvenance: 'usage_ledger';
  usageCompleteness: 'complete' | 'partial' | 'not_reported';
} {
  return {
    usageLedgerOperationId: operationId,
    usageProvenance: 'usage_ledger',
    usageCompleteness: completeness,
  };
}

export function routineModelLabel(model: { provider: string; id: string }): string {
  return canonicalRuntimeModel(
    model.id.includes('/') ? model.id : `${model.provider}/${model.id}`,
  );
}
