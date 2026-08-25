import {
  AgentRunError,
  init,
  type AgentInstanceHandle,
  type AgentReply,
  type ConversationStreamChunk,
  type DispatchReceipt,
} from '@flue/runtime';
import * as v from 'valibot';

import {
  ChickpeaRoutineExecution,
  parseRoutineExecutionInitialData,
  ROUTINE_RESULT_DATA_NAME,
  type RoutineExecutionInitialData,
} from '../agents/routine-execution.ts';
import {
  compileRuntimePlanV2,
  runtimePlanSandboxConversationKey,
} from '../agents/runtime-plan.ts';
import {
  canonicalRuntimeModel,
  resolveRuntimeModel,
  safeRuntimeModelRouteEvidence,
  type ProviderAuthRoute,
} from '../config/runtime-model.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import type { EffectiveSlackConfig } from '../config/effective-config.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import { sandboxBindingInstalled } from '../sandbox/select.ts';
import {
  prepareCloudflareSandboxTurn,
  releaseCloudflareSandboxTurn,
} from '../slack/flue-dispatch.ts';
import {
  resolveCloudflareSandboxDecision,
  shouldUseCloudflareSandbox,
} from '../slack/run-turn.ts';
import {
  CHICKPEA_RESPONSE_METADATA_KEY,
  type ChickpeaResponseMetadata,
} from '../usage/response-metadata.ts';
import {
  RoutineUsageRecorder,
  usageRuntimeRecordingEnabled,
} from '../usage/runtime-recorder.ts';
import { opaqueId } from '../work/admission.ts';
import { externalActionAuthorityInstructions } from '../connections/runtime.ts';
import { createWorkExecutionLifecycle } from '../work/executor.ts';
import type { ShadowWorkLifecycle } from '../work/lifecycle.ts';
import type { RunId } from '../work/types.ts';
import type { WorkStore } from '../work/types.ts';
import type { UsageStore } from '../usage/types.ts';
import {
  deliverRoutineFailureNotice,
  deliverRoutineResult,
} from './delivery.ts';
import { SANDBOX_UNAVAILABLE_FALLBACK_NOTICE } from '../slack/web-client-presenter.ts';
import {
  normalizeRoutineModelResult,
  prepareRoutinePrompt,
  RoutineModelResultSchema,
  type PreparedRoutinePrompt,
} from './prompt.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
  type RoutineRuntimeAccess,
} from './runtime.ts';
import { markRoutineAuthorityNeedsAttention } from './agent-authority.ts';
import type {
  RoutineAdmissionAttempt,
  RoutineAgentDispatchEnvelopeV1,
  RoutineAgentReceiptV1,
  RoutineAgentSettlementV1,
  RoutineAgentUsageV1,
  RoutineDefinition,
  RoutineFailureClass,
  RoutineRun,
  RoutineStore,
} from './types.ts';

export type RoutineExecutionOutcome = 'completed' | 'resumable' | 'superseded';

interface RoutineExecutionDependencies {
  resolveAccess?: typeof resolveRoutineRuntimeAccess;
  resolveModel?: typeof resolveRuntimeModel;
  preparePrompt?: typeof prepareRoutinePrompt;
  useCloudflareSandbox?: typeof shouldUseCloudflareSandbox;
  resolveSandboxDecision?: typeof resolveCloudflareSandboxDecision;
  sandboxInstalled?: typeof sandboxBindingInstalled;
  prepareSandbox?: typeof prepareCloudflareSandboxTurn;
  releaseSandbox?: typeof releaseCloudflareSandboxTurn;
  resolveCredential?: typeof resolveModelCredentialAttribution;
  handle?: AgentInstanceHandle;
  now?: () => number;
  usageRecordingEnabled?: boolean;
  usageStore?: UsageStore;
  settingsStore?: SettingsStore;
  workStore?: WorkStore;
}

interface PreparedExecution {
  store: RoutineStore;
  run: RoutineRun;
  routine: RoutineDefinition;
  access: RoutineRuntimeAccess;
  prompt: PreparedRoutinePrompt;
  envelope: RoutineAgentDispatchEnvelopeV1;
  sandboxConversationKey: string;
  receipt: RoutineAgentReceiptV1 | null;
  usageRecorder?: RoutineUsageRecorder;
  workLifecycle?: ShadowWorkLifecycle;
  usedCloudflareSandbox: boolean;
  sandboxUnavailableFallback: boolean;
}

/** Execute or reattach one durable routine attempt from app-owned checkpoints. */
export async function executeRoutineOccurrence(
  input: {
    env: PlatformEnv;
    store: RoutineStore;
    occurrenceId: string;
    attempt: number;
  },
  dependencies: RoutineExecutionDependencies = {},
): Promise<RoutineExecutionOutcome> {
  const now = dependencies.now ?? Date.now;
  const current = await input.store.getRun(input.occurrenceId);
  if (!current || !['admitting', 'running'].includes(current.status)) return 'superseded';
  const routine = await input.store.getRoutine(current.routineId);
  if (!routine || routine.deletedAt !== null || routine.version < current.routineVersion) {
    await failUnsettledRun(
      input.store,
      current.id,
      'result_invalid',
      'The saved routine revision is unavailable.',
      now(),
    );
    return 'completed';
  }
  const admission = (await input.store.listAdmissions(current.id))
    .find((candidate) => candidate.attempt === input.attempt);
  if (!admission) return 'superseded';

  let prepared: PreparedExecution;
  try {
    prepared = await prepareExecution(
      { ...input, run: current, routine, admission },
      dependencies,
    );
  } catch (error) {
    if (error instanceof RoutineSupersededError) return 'superseded';
    const failure = runtimeFailure(error, false);
    if ([
      'assignment_missing',
      'creator_ineligible',
      'channel_ineligible',
      'credential_unavailable',
    ].includes(failure.failureClass)) {
      await Promise.all([
        markRoutineAuthorityNeedsAttention(routine.id, input.env).catch(() => undefined),
        input.store.control({
          routineId: routine.id,
          expectedVersion: routine.version,
          action: 'pause',
          actorId: routine.creatorUserId,
          actorClass: 'system',
          reasonCode: failure.failureClass,
          idempotencyKey:
            `routine:authority-pause:${routine.id}:${routine.version}:${failure.failureClass}`,
        }).catch(() => undefined),
      ]);
    }
    if (failure.failureClass === 'assignment_missing' && current.status === 'admitting') {
      await skipUnresolvedRun(input.store, current.id, failure.publicError, now());
    } else {
      await failUnsettledRun(
        input.store,
        current.id,
        failure.failureClass,
        failure.publicError,
        now(),
      );
    }
    return 'completed';
  }
  if (prepared.run.flueAgentSettlement) {
    try {
      await finalizeSettlement(prepared, prepared.run.flueAgentSettlement, now());
      await prepared.usageRecorder?.repairAfterTerminal();
      return 'completed';
    } finally {
      await releasePreparedSandbox(input.env, prepared, dependencies);
    }
  }

  const handle = dependencies.handle ?? init(ChickpeaRoutineExecution, {
    id: prepared.envelope.instanceId,
    ...(prepared.receipt?.uid ? { uid: prepared.receipt.uid } : {}),
  });
  let receipt = prepared.receipt;
  const toolCalls = new ToolCallCounter('submit_routine_result');
  let modelSettled = false;
  let settledUsage: RoutineAgentUsageV1 | null = null;
  let retainPreparedSandbox = false;
  try {
    if (!receipt) {
      let admitted: DispatchReceipt;
      try {
        admitted = await handle.dispatch({
          message: prepared.envelope.message,
          initialData: prepared.envelope.initialData,
          idempotencyKey: prepared.envelope.idempotencyKey,
        });
      } catch (error) {
        if (now() < prepared.run.deadlineAt) {
          retainPreparedSandbox = true;
          return 'resumable';
        }
        throw error;
      }
      const checkpoint = boundedReceipt(admitted);
      const recorded = await input.store.recordAgentReceipt({
        occurrenceId: prepared.run.id,
        attempt: input.attempt,
        receipt: checkpoint,
        at: now(),
      });
      receipt = recorded.flueAgentReceipt ?? checkpoint;
    }
    await prepared.workLifecycle?.markInvoked();

    const remainingMs = prepared.run.deadlineAt - now();
    if (remainingMs <= 0) {
      await handle.abort();
      throw new RoutineRuntimeError(
        'deadline_exceeded',
        'The routine occurrence exceeded its execution deadline.',
      );
    }
    let reply: AgentReply;
    try {
      reply = await handle.read(receipt as DispatchReceipt, {
        signal: AbortSignal.timeout(remainingMs),
        onEvent: (event) => toolCalls.observe(event),
      });
    } catch (error) {
      if (isLocalReadInterruption(error) && now() < prepared.run.deadlineAt) {
        retainPreparedSandbox = true;
        return 'resumable';
      }
      if (isLocalReadInterruption(error)) {
        await handle.abort().catch(() => undefined);
        throw new RoutineRuntimeError(
          'deadline_exceeded',
          'The routine occurrence exceeded its execution deadline.',
        );
      }
      throw error;
    }

    settledUsage = routineUsageFromAgentReply(reply, prepared.access.config.model);
    await prepared.workLifecycle?.settleExecution({
      outcome: 'succeeded',
      rawStatus: 'flue_succeeded',
      flueSubmissionRef: opaqueId('fluesubmission', reply.submissionId),
    });
    modelSettled = true;
    if (
      prepared.prompt.prompt !== prepared.envelope.message ||
      prepared.prompt.memoryEpoch !== executionInitialData(prepared.envelope).runtimePlan.memoryEpoch ||
      !(await prepared.prompt.validateMemoryLease())
    ) {
      throw new RoutineRuntimeError(
        toolCalls.count > 0 ? 'unknown_external_outcome' : 'access_denied',
        'Channel access changed while the routine was running.',
      );
    }
    await prepared.prompt.confirmMemory();
    const result = routineResult(reply, prepared.run, prepared.routine);
    if (prepared.sandboxUnavailableFallback) {
      result.message = result.message
        ? `${SANDBOX_UNAVAILABLE_FALLBACK_NOTICE}\n\n${result.message}`
        : SANDBOX_UNAVAILABLE_FALLBACK_NOTICE;
    }
    const settlement: RoutineAgentSettlementV1 = {
      schemaVersion: 1,
      outcome: 'completed',
      settledAt: now(),
      result: { ...result, toolCallCount: toolCalls.count, usage: settledUsage },
    };
    await recordUsage(prepared, settlement);
    prepared.run = await input.store.recordAgentSettlement({
      occurrenceId: prepared.run.id,
      settlement,
    });
    await finalizeSettlement(prepared, settlement, now());
    await prepared.usageRecorder?.repairAfterTerminal();
    return 'completed';
  } catch (error) {
    const toolCallCount = toolCalls.count;
    const failure = runtimeFailure(error, toolCallCount > 0);
    const settlement: RoutineAgentSettlementV1 = {
      schemaVersion: 1,
      outcome: error instanceof AgentRunError && error.outcome === 'aborted' ? 'aborted' : 'failed',
      settledAt: now(),
      failureClass: failure.failureClass,
      publicError: failure.publicError,
      toolCallCount,
      usage: settledUsage,
    };
    if (!modelSettled) {
      await prepared.workLifecycle?.settleExecution({
        outcome: toolCallCount > 0 ? 'ambiguous' : 'failed',
        rawStatus: toolCallCount > 0 ? 'flue_ambiguous' : 'flue_failed',
        safeFailureCode: routineLifecycleFailureCode(failure.failureClass),
        ...(receipt ? { flueSubmissionRef: opaqueId('fluesubmission', receipt.submissionId) } : {}),
      });
    }
    await recordUsage(prepared, settlement);
    try {
      prepared.run = await input.store.recordAgentSettlement({
        occurrenceId: prepared.run.id,
        settlement,
      });
      await finalizeSettlement(prepared, settlement, now());
    } finally {
      await prepared.usageRecorder?.repairAfterTerminal();
    }
    return 'completed';
  } finally {
    if (!retainPreparedSandbox) {
      await releasePreparedSandbox(input.env, prepared, dependencies);
    }
  }
}

async function prepareExecution(
  input: {
    env: PlatformEnv;
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    admission: RoutineAdmissionAttempt;
    attempt: number;
  },
  dependencies: RoutineExecutionDependencies,
): Promise<PreparedExecution> {
  const now = dependencies.now ?? Date.now;
  if (input.run.deadlineAt <= now() && !input.run.flueAgentSettlement) {
    throw new RoutineRuntimeError(
      'deadline_exceeded',
      'The routine occurrence expired before execution began.',
    );
  }
  const resolveAccess = dependencies.resolveAccess ?? resolveRoutineRuntimeAccess;
  const access = await resolveAccess(input.run, input.routine, input.env);
  if (input.run.flueAgentEnvelope) {
    assertRoutineReattachmentAttribution(input.run, input.run.flueAgentEnvelope, access);
  }
  const settingsStore = dependencies.settingsStore ?? getSettingsStore(input.env);
  const usageStore = dependencies.usageStore ?? getUsageStore(input.env);
  const resolveModel = dependencies.resolveModel ?? resolveRuntimeModel;
  const frozenInitialData = input.run.flueAgentEnvelope
    ? executionInitialData(input.run.flueAgentEnvelope)
    : undefined;
  const runtimeModel = frozenInitialData
    ? {
        model: frozenInitialData.runtimePlan.model,
        ...(input.run.providerAuthRoute
          ? { providerAuthRoute: input.run.providerAuthRoute }
          : {}),
      }
    : await resolveModel(access.config.agentId, access.config.model, {
        settings: settingsStore,
        env: input.env,
      });
  const modelCredential = access.config.modelCredential ?? await (
    dependencies.resolveCredential ?? resolveModelCredentialAttribution
  )(
    access.config.model,
    input.env,
    settingsStore,
    usageStore,
  ).catch(() => null);
  const prompt = await (dependencies.preparePrompt ?? prepareRoutinePrompt)(
    input.run,
    input.routine,
    access,
    input.env,
    access.client,
  );
  const attemptId = input.admission.attemptId;
  if (!attemptId) throw new Error('Routine attempt identity is unavailable.');
  let envelope = input.run.flueAgentEnvelope;
  let sandboxUnavailableFallback = false;
  if (!envelope) {
    const sandboxDecision = dependencies.useCloudflareSandbox
      ? await (async () => {
          const cloudflareRequested = await dependencies.useCloudflareSandbox!(
            access.config,
            input.env,
          );
          const installed = (dependencies.sandboxInstalled ?? sandboxBindingInstalled)(input.env);
          return {
            selection: cloudflareRequested && installed ? 'cloudflare' as const : 'bash' as const,
            unavailableFallback: cloudflareRequested && !installed,
          };
        })()
      : await (dependencies.resolveSandboxDecision ?? resolveCloudflareSandboxDecision)(
          access.config,
          input.env,
          settingsStore,
        );
    envelope = createEnvelope({
      routine: input.routine,
      run: input.run,
      access,
      prompt,
      attemptId,
      runtimeModel: runtimeModel.model,
      modelCredential,
      sandboxMode: sandboxDecision.selection,
    });
    sandboxUnavailableFallback = sandboxDecision.unavailableFallback;
  }
  const initialData = executionInitialData(envelope);
  const cloudflareSandboxRequested = initialData.runtimePlan.sandbox.mode === 'cloudflare';
  const sandboxInstalled = (dependencies.sandboxInstalled ?? sandboxBindingInstalled)(input.env);
  sandboxUnavailableFallback ||= cloudflareSandboxRequested && !sandboxInstalled;
  const usedCloudflareSandbox = cloudflareSandboxRequested && sandboxInstalled;
  const sandboxConversationKey = runtimePlanSandboxConversationKey(
    initialData.runtimePlan,
    envelope.instanceId,
  );
  const started = await input.store.prepareAgentDispatch({
    occurrenceId: input.run.id,
    attempt: input.attempt,
    startedAt: input.run.startedAt ?? now(),
    envelope,
    resolvedAccessHash: access.accessHash,
    resolvedAgentId: access.config.agentId,
    resolvedAuthorityReceiptId: access.authorityReceiptId ?? 'legacy_authority',
    resolvedRunsAsMembershipId: access.actorMembershipId ?? 'legacy_membership',
    model: access.config.model,
    ...(runtimeModel.providerAuthRoute ? { providerAuthRoute: runtimeModel.providerAuthRoute } : {}),
    traceId: input.run.id,
  });
  if (started === 'superseded') throw new RoutineSupersededError();
  const run = await input.store.getRun(input.run.id);
  if (!run) throw new Error('Routine occurrence was not readable after admission.');

  const usageRecorder = (dependencies.usageRecordingEnabled ?? usageRuntimeRecordingEnabled(input.env))
    ? new RoutineUsageRecorder({
        operationId: run.id,
        executionId: `exec:${run.id}:${attemptId}`,
        ...(run.canonicalRunId ? { runId: run.canonicalRunId as RunId } : {}),
        startedAt: run.startedAt ?? run.queuedAt,
        workspaceId: input.routine.workspaceId,
        channelId: input.routine.channelId,
        agentId: access.config.agentId,
        agentLabel: access.config.agent.name,
        routineId: input.routine.id,
        routineLabel: input.routine.name,
        requestedModel: access.config.model,
        requesterMembershipId: access.actorMembershipId ?? null,
        executionPrincipalId: access.config.agentId,
        modelAttribution: access.config.modelAttribution,
        credentialRefId: modelCredential?.credentialRefId ?? null,
        credentialVersion: modelCredential?.version ?? null,
        store: usageStore,
        platformEnv: input.env,
        now,
      })
    : undefined;
  await usageRecorder?.admit();

  const prepareSandbox = !input.run.flueAgentSettlement && usedCloudflareSandbox;
  if (prepareSandbox) {
    try {
      await (dependencies.prepareSandbox ?? prepareCloudflareSandboxTurn)(
        input.env,
        sandboxConversationKey,
        input.run.id,
      );
    } catch (error) {
      await usageRecorder?.recordTerminal({
        status: 'failed',
        unknownReason: 'provider_request_unknown',
      });
      await usageRecorder?.repairAfterTerminal();
      await (dependencies.releaseSandbox ?? releaseCloudflareSandboxTurn)(
        input.env,
        sandboxConversationKey,
        usedCloudflareSandbox,
      );
      throw error;
    }
  }

  const workLifecycle = await createRoutineShadowLifecycle(
    run,
    access,
    envelope,
    runtimeModel.providerAuthRoute,
    modelCredential ?? undefined,
    dependencies.workStore ?? getWorkStore(input.env),
    input.attempt,
  );
  if (workLifecycle) {
    usageRecorder?.linkRunExecution(workLifecycle.executionId);
  }
  return {
    store: input.store,
    run,
    routine: input.routine,
    access,
    prompt,
    envelope,
    sandboxConversationKey,
    receipt: input.admission.flueAgentReceipt ?? null,
    ...(usageRecorder ? { usageRecorder } : {}),
    ...(workLifecycle ? { workLifecycle } : {}),
    usedCloudflareSandbox: prepareSandbox,
    sandboxUnavailableFallback,
  };
}

function createEnvelope(input: {
  routine: RoutineDefinition;
  run: RoutineRun;
  access: RoutineRuntimeAccess;
  prompt: PreparedRoutinePrompt;
  attemptId: string;
  runtimeModel: string;
  modelCredential: EffectiveSlackConfig['modelCredential'] | null;
  sandboxMode: 'bash' | 'cloudflare';
}): RoutineAgentDispatchEnvelopeV1 {
  const runtimePlan = compileRuntimePlanV2({
    turn: input.prompt.turn,
    assignment: {
      workspaceId: input.routine.workspaceId,
      channelId: input.routine.channelId,
      agentId: input.access.config.agentId,
      agent: input.access.config.agent,
      model: input.runtimeModel,
      modelAttribution: input.access.config.modelAttribution,
      ...(input.access.config.ownerIncarnation
        ? { ownerIncarnation: input.access.config.ownerIncarnation }
        : {}),
      ...(input.modelCredential ? { modelCredential: input.modelCredential } : {}),
    },
    instructions: [
      input.access.config.instructions,
      externalActionAuthorityInstructions(input.access.config.agent.instructions),
    ].join('\n'),
    memoryEpoch: input.prompt.memoryEpoch,
    sandboxMode: input.sandboxMode,
    ...(input.access.effectiveConnections
      ? { effectiveConnections: input.access.effectiveConnections }
      : {}),
  });
  const initialData: RoutineExecutionInitialData = {
    runtimePlan,
    requestedModel: input.access.config.model,
    connectorUsageCorrelation: {
      operationId: input.run.id,
      ...(input.run.canonicalRunId ? { runId: input.run.canonicalRunId } : {}),
    },
  };
  return {
    schemaVersion: 1,
    attemptId: input.attemptId,
    instanceId: opaqueId('routineagent', input.attemptId),
    idempotencyKey: input.attemptId,
    message: input.prompt.prompt,
    initialData,
  };
}

function executionInitialData(envelope: RoutineAgentDispatchEnvelopeV1): RoutineExecutionInitialData {
  return parseRoutineExecutionInitialData(envelope.initialData);
}

function assertRoutineReattachmentAttribution(
  run: RoutineRun,
  envelope: RoutineAgentDispatchEnvelopeV1,
  access: RoutineRuntimeAccess,
): void {
  const admittedAgentId = executionInitialData(envelope).runtimePlan.agentId;
  if (
    !run.resolvedAgentId ||
    !run.resolvedAccessHash ||
    run.resolvedAgentId !== admittedAgentId ||
    access.config.agentId !== admittedAgentId ||
    access.accessHash !== run.resolvedAccessHash
  ) {
    throw new RoutineRuntimeError(
      'access_denied',
      'Channel access changed while the routine was running.',
    );
  }
}

async function createRoutineShadowLifecycle(
  run: RoutineRun,
  access: RoutineRuntimeAccess,
  envelope: RoutineAgentDispatchEnvelopeV1,
  providerAuthRoute: ProviderAuthRoute | undefined,
  modelCredential: NonNullable<Awaited<ReturnType<typeof resolveModelCredentialAttribution>>> | undefined,
  workStore: WorkStore,
  attemptNumber = 1,
): Promise<ShadowWorkLifecycle | undefined> {
  if (!run.canonicalRunId) return undefined;
  try {
    const lifecycle = await createWorkExecutionLifecycle(workStore, {
      runId: run.canonicalRunId,
      attemptNumber,
      executorKind: 'agent',
      agentName: access.config.agentId,
      canonicalModel: access.config.model,
      flueInstanceRef: opaqueId('flueinstance', envelope.instanceId),
      routeEvidence: safeRuntimeModelRouteEvidence(
        access.config.model,
        providerAuthRoute,
        modelCredential,
      ),
    });
    return await lifecycle.prepareExecution(envelope.message) ? lifecycle : undefined;
  } catch {
    console.warn('[work] Routine shadow lifecycle initialization failed; execution will continue');
    return undefined;
  }
}

async function finalizeSettlement(
  prepared: PreparedExecution,
  settlement: RoutineAgentSettlementV1,
  at: number,
): Promise<void> {
  if (settlement.outcome === 'completed') {
    let delivered = false;
    if (settlement.result.status === 'succeeded') {
      await deliverRoutineResult({
        store: prepared.store,
        run: prepared.run,
        routine: prepared.routine,
        access: prepared.access,
        message: settlement.result.message,
        changeKeyHash: settlement.result.changeKeyHash,
        ...(prepared.workLifecycle ? { workLifecycle: prepared.workLifecycle } : {}),
      }, prepared.access.client);
      delivered = true;
    } else {
      await prepared.workLifecycle?.settleWithoutDelivery({ terminalDisposition: 'no_op' });
    }
    const usage = settlement.result.usage;
    try {
      prepared.run = await prepared.store.transitionRun({
        occurrenceId: prepared.run.id,
        from: ['running'],
        to: settlement.result.status,
        at,
        model: routineModelLabel(usage.returnedModel, usage.requestedModel),
        ...(usage.inputTokens === null ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === null ? {} : { outputTokens: usage.outputTokens }),
        ...(prepared.usageRecorder
          ? {
              usageLedgerOperationId: prepared.run.id,
              usageProvenance: 'usage_ledger' as const,
            }
          : {}),
        usageCompleteness: usage.completeness,
        toolCallCount: settlement.result.toolCallCount,
        changeKeyHash: settlement.result.changeKeyHash,
        suppressedAsNoOp: settlement.result.suppressedAsNoOp,
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
    return;
  }
  await prepared.workLifecycle?.settleWithoutDelivery({
    terminalDisposition: 'failed',
    safeFailureCode: routineLifecycleFailureCode(settlement.failureClass),
  });
  prepared.run = await prepared.store.transitionRun({
    occurrenceId: prepared.run.id,
    from: ['running'],
    to: 'failed',
    at,
    failureClass: settlement.failureClass,
    publicError: settlement.publicError,
    toolCallCount: settlement.toolCallCount,
    ...(prepared.usageRecorder
      ? {
          usageLedgerOperationId: prepared.run.id,
          usageProvenance: 'usage_ledger' as const,
        }
      : {}),
    usageCompleteness: settlement.usage?.completeness ?? 'not_reported',
  });
  await deliverFailureNoticeBestEffort(prepared, settlement.publicError);
}

async function recordUsage(
  prepared: PreparedExecution,
  settlement: RoutineAgentSettlementV1,
): Promise<void> {
  const usage = settlement.outcome === 'completed' ? settlement.result.usage : settlement.usage;
  await prepared.usageRecorder?.recordTerminal({
    status: settlement.outcome === 'completed' ? 'completed' : 'failed',
    ...(usage && usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null
      ? { usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
          totalTokens: usage.totalTokens,
        } }
      : {}),
    ...(usage?.returnedModel ? { returnedModel: usage.returnedModel } : {}),
    ...(usage ? {} : { unknownReason: 'provider_request_unknown' }),
  });
}

function routineResult(reply: AgentReply, run: RoutineRun, routine: RoutineDefinition) {
  const values = reply.data[ROUTINE_RESULT_DATA_NAME] ?? [];
  if (values.length !== 1) {
    throw new RoutineRuntimeError('result_invalid', 'The routine did not produce one valid structured result.');
  }
  const parsed = v.safeParse(RoutineModelResultSchema, values[0]);
  if (!parsed.success) {
    throw new RoutineRuntimeError('result_invalid', 'The routine did not produce a valid structured result.');
  }
  return normalizeRoutineModelResult(parsed.output, run, routine);
}

export function routineUsageFromAgentReply(
  reply: AgentReply,
  requestedModel: string,
): RoutineAgentUsageV1 {
  const metadata = responseMetadata(reply);
  if (!metadata) {
    return {
      requestedModel,
      returnedModel: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      completeness: 'not_reported',
    };
  }
  const reported = metadata.usage;
  const completeness = reported.input === 0 && reported.output === 0 && reported.totalTokens === 0
    ? 'not_reported'
    : 'complete';
  return {
    requestedModel: metadata.requestedModel,
    returnedModel: metadata.returnedModel ?? null,
    inputTokens: completeness === 'complete' ? reported.input : null,
    outputTokens: completeness === 'complete' ? reported.output : null,
    cacheReadTokens: completeness === 'complete' ? reported.cacheRead : null,
    cacheWriteTokens: completeness === 'complete' ? reported.cacheWrite : null,
    totalTokens: completeness === 'complete' ? reported.totalTokens : null,
    completeness,
  };
}

function responseMetadata(reply: AgentReply): ChickpeaResponseMetadata | undefined {
  const value = reply.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  if (
    record.schemaVersion !== 1 ||
    typeof record.requestedModel !== 'string' ||
    !usage || typeof usage !== 'object' || Array.isArray(usage)
  ) return undefined;
  const counts = usage as Record<string, unknown>;
  if (![counts.input, counts.output, counts.totalTokens].every(isTokenCount)) return undefined;
  const returned = record.returnedModel;
  const returnedModel = returned && typeof returned === 'object' && !Array.isArray(returned) &&
    typeof (returned as Record<string, unknown>).provider === 'string' &&
    typeof (returned as Record<string, unknown>).id === 'string'
      ? {
          provider: (returned as Record<string, string>).provider!,
          id: (returned as Record<string, string>).id!,
        }
      : undefined;
  return {
    schemaVersion: 1,
    requestedModel: record.requestedModel,
    usage: {
      input: counts.input as number,
      output: counts.output as number,
      cacheRead: isTokenCount(counts.cacheRead) ? counts.cacheRead : 0,
      cacheWrite: isTokenCount(counts.cacheWrite) ? counts.cacheWrite : 0,
      totalTokens: counts.totalTokens as number,
    },
    ...(returnedModel ? { returnedModel } : {}),
  };
}

class ToolCallCounter {
  private readonly ids = new Set<string>();
  constructor(private readonly terminalToolName: string) {}
  get count(): number { return this.ids.size; }

  observe(event: ConversationStreamChunk): void {
    if (event.type === 'tool-input') this.add(event.toolName, event.toolCallId);
    if (event.type === 'conversation-reset') {
      for (const message of event.snapshot.messages) this.observeMessage(message.parts);
    }
    if (event.type === 'message-appended') this.observeMessage(event.message.parts);
  }

  private observeMessage(parts: Array<{ type: string; toolName?: string; toolCallId?: string }>): void {
    for (const part of parts) {
      if (part.type === 'dynamic-tool' && part.toolName && part.toolCallId) {
        this.add(part.toolName, part.toolCallId);
      }
    }
  }

  private add(name: string, id: string): void {
    if (name !== this.terminalToolName) this.ids.add(id);
  }
}

function boundedReceipt(receipt: DispatchReceipt): RoutineAgentReceiptV1 {
  return {
    submissionId: receipt.submissionId,
    acceptedAt: receipt.acceptedAt,
    ...(receipt.uid ? { uid: receipt.uid } : {}),
    ...(receipt.deduplicated ? { deduplicated: true } : {}),
  };
}

function runtimeFailure(
  error: unknown,
  externalOutcomeMayBeUnknown: boolean,
): { failureClass: RoutineFailureClass; publicError: string } {
  if (error instanceof RoutineSupersededError) {
    return { failureClass: 'internal_error', publicError: 'The routine occurrence was superseded.' };
  }
  if (externalOutcomeMayBeUnknown) {
    return {
      failureClass: 'unknown_external_outcome',
      publicError: 'The routine stopped after a tool call with an outcome that may require inspection.',
    };
  }
  if (error instanceof RoutineRuntimeError) {
    return { failureClass: error.failureClass, publicError: error.publicError };
  }
  if (error instanceof OpenAiSubscriptionError) return subscriptionFailure(error);
  if (error instanceof AgentRunError) {
    return { failureClass: 'tool_failed', publicError: 'The routine could not complete safely.' };
  }
  return { failureClass: 'tool_failed', publicError: 'The routine could not complete safely.' };
}

function subscriptionFailure(error: OpenAiSubscriptionError): {
  failureClass: RoutineFailureClass;
  publicError: string;
} {
  if (['auth_reconnect_required', 'authorization_missing', 'storage_invalid'].includes(error.code)) {
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
  return {
    failureClass: 'policy_denied',
    publicError: 'The connected ChatGPT subscription did not authorize this occurrence. API-key billing was not used.',
  };
}

async function failUnsettledRun(
  store: RoutineStore,
  occurrenceId: string,
  failureClass: RoutineFailureClass,
  publicError: string,
  at: number,
): Promise<void> {
  const run = await store.getRun(occurrenceId);
  if (!run) return;
  if (!['admitting', 'running'].includes(run.status)) return;
  await store.transitionRun({
    occurrenceId: run.id,
    from: [run.status],
    to: 'failed',
    at,
    failureClass,
    publicError,
  });
}

async function skipUnresolvedRun(
  store: RoutineStore,
  occurrenceId: string,
  publicError: string,
  at: number,
): Promise<void> {
  const run = await store.getRun(occurrenceId);
  if (!run || run.status !== 'admitting') return;
  await store.transitionRun({
    occurrenceId: run.id,
    from: ['admitting'],
    to: 'skipped',
    at,
    failureClass: 'assignment_missing',
    publicError,
    skipReason: 'unresolved_assignment',
  });
}

async function deliverFailureNoticeBestEffort(
  prepared: PreparedExecution,
  publicError: string,
): Promise<void> {
  try {
    const store = prepared.store;
    const run = await store.getRun(prepared.run.id);
    if (!run || run.status !== 'failed' || run.deliveryStatus !== 'none') return;
    await deliverRoutineFailureNotice({
      store,
      run,
      routine: prepared.routine,
      access: prepared.access,
      publicError,
      ...(prepared.workLifecycle ? { workLifecycle: prepared.workLifecycle } : {}),
    }, prepared.access.client);
  } catch {
    // The failed occurrence remains visible in Slack commands and Admin.
  }
}

async function releasePreparedSandbox(
  env: PlatformEnv,
  prepared: PreparedExecution,
  dependencies: RoutineExecutionDependencies,
): Promise<void> {
  await (dependencies.releaseSandbox ?? releaseCloudflareSandboxTurn)(
    env,
    prepared.sandboxConversationKey,
    prepared.usedCloudflareSandbox,
  );
}

function isLocalReadInterruption(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function routineLifecycleFailureCode(failureClass: RoutineFailureClass): string {
  const normalized = failureClass.replace(/[^a-z0-9_]/g, '_');
  return normalized.length >= 3 && normalized.length <= 63 ? normalized : 'routine_failed';
}

function routineModelLabel(
  returnedModel: { provider: string; id: string } | null,
  requestedModel: string,
): string {
  if (!returnedModel) return canonicalRuntimeModel(requestedModel);
  return canonicalRuntimeModel(
    returnedModel.id.includes('/')
      ? returnedModel.id
      : `${returnedModel.provider}/${returnedModel.id}`,
  );
}

class RoutineSupersededError extends Error {}
