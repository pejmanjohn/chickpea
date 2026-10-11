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
  parseRoutineExecutionInitialData,
  ROUTINE_RESULT_DATA_NAME,
  type RoutineExecutionInitialData,
} from '../agents/routine-execution-data.ts';
import {
  compileRuntimePlanV2,
  type RuntimePlanBrowserCapabilityV1,
  type RuntimePlanWebsiteLoginV1,
  type RuntimePlanCodingModelV1,
  type RuntimePlanImageCapabilityV3,
} from '../agents/runtime-plan.ts';
import {
  canonicalRuntimeModel,
  freezeRuntimeModelRoute,
  resolveRuntimeModel,
  safeRuntimeModelRouteEvidence,
  type FrozenRuntimeModelRoute,
  type ProviderAuthRoute,
} from '../config/runtime-model.ts';
import {
  installationRefusesWork,
  InstallationNotAdmittedError,
  isInstallationRefusal,
} from '../config/installation-admission.ts';
import { isCredentialKeyringUnavailable } from '../slack/credential-keyring.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import { isCreditsExhausted, postRunFee } from '../config/platform-funding.ts';
import { qualifiesAsTask } from '../usage/run-fees.ts';
import {
  creditBackFailedRun,
  creditBackReason,
  hostedRun,
  planFunding,
  withCreditedBack,
} from '../usage/run-settlement.ts';
import {
  imageCapabilityForResolution,
  resolveAgentModelRoleFromStore,
  type ModelRoleReader,
} from '../config/model-policy.ts';
import type { EffectiveSlackConfig } from '../config/effective-config.ts';
import { loadModelCatalog } from '../model-catalog/index.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { browserCapabilityForTurn, websiteLoginsForTurn } from '../browser/capability.ts';
import {
  getConfigStore,
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import { sandboxBindingInstalled } from '../sandbox/select.ts';
import {
  freezeCodingModelForTurn,
  resolveCodingWorkspaceDecision,
} from '../slack/run-turn.ts';
import {
  CHICKPEA_RESPONSE_METADATA_KEY,
  type ChickpeaResponseMetadata,
} from '../usage/response-metadata.ts';
import {
  recordRoutineTerminalWithoutRecorder,
  RoutineUsageRecorder,
  type UsagePersistenceEvent,
  usageRuntimeRecordingEnabled,
} from '../usage/runtime-recorder.ts';
import { opaqueId } from '../work/admission.ts';
import {
  installationOwnershipOf,
  scopedObjectName,
  type InstallationOwnership,
} from '../config/installation-scope.ts';
import { externalActionAuthorityInstructions } from '../connections/runtime.ts';
import { createWorkExecutionLifecycle } from '../work/executor.ts';
import { shadowRunExecutionId, type ShadowWorkLifecycle } from '../work/lifecycle.ts';
import type { RunExecutionRecord, RunId } from '../work/types.ts';
import type { WorkStore } from '../work/types.ts';
import type { UsageStore } from '../usage/types.ts';
import {
  deliverRoutineRecoveryNotice,
  deliverRoutineFailureNotice,
  deliverRoutineResult,
  routineDeliveryFailure,
} from './delivery.ts';
import { CREDITS_EXHAUSTED_TEXT, SANDBOX_UNAVAILABLE_FALLBACK_NOTICE } from '../slack/web-client-presenter.ts';
import {
  normalizeRoutineModelResult,
  prepareRoutinePrompt,
  routineExecutionInstructions,
  RoutineModelResultSchema,
  type PreparedRoutinePrompt,
} from './prompt.ts';
import { ROUTINE_SCHEDULE_SIGNAL_TYPE } from './schedule-signal.ts';
import {
  parseSlackArtifactReceipts,
  SLACK_ARTIFACT_RECEIPTS_DATA_NAME,
  type SlackArtifactReceipt,
} from '../slack/artifact-receipts.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
  type RoutineRuntimeAccess,
} from './runtime.ts';
import { markRoutineAuthorityNeedsAttention } from './agent-authority.ts';
import {
  emitRoutinePersistenceTelemetry,
  type RoutinePersistenceSummary,
  type RoutinePersistenceTelemetrySink,
} from './telemetry.ts';
import type {
  RoutineAdmissionAttempt,
  RoutineAgentDispatchEnvelope,
  RoutineAgentDispatchEnvelopeV2,
  RoutineAgentReceiptV1,
  RoutineAgentSettlementV1,
  RoutineAgentUsageV1,
  RoutineDefinition,
  RoutineFailureClass,
  RoutineRun,
  RoutineStore,
} from './types.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';

export type RoutineExecutionOutcome = 'completed' | 'resumable' | 'superseded';

interface RoutineExecutionDependencies {
  resolveAccess?: typeof resolveRoutineRuntimeAccess;
  resolveModel?: typeof resolveRuntimeModel;
  preparePrompt?: typeof prepareRoutinePrompt;
  /** Focused seam: whether the Agent's coding workspace is configured, before the live binding check. */
  codingWorkspaceConfigured?: (
    assignment: RoutineRuntimeAccess['config'],
    env: PlatformEnv | undefined,
  ) => Promise<boolean>;
  resolveWorkspaceDecision?: typeof resolveCodingWorkspaceDecision;
  sandboxInstalled?: typeof sandboxBindingInstalled;
  resolveCredential?: typeof resolveModelCredentialAttribution;
  handle?: AgentInstanceHandle;
  now?: () => number;
  usageRecordingEnabled?: boolean;
  usageStore?: UsageStore;
  settingsStore?: SettingsStore;
  /** Role authority for the image capability; production reads the config store. */
  modelRoleReader?: ModelRoleReader;
  workStore?: WorkStore;
  persistenceTelemetrySink?: RoutinePersistenceTelemetrySink;
  productTelemetry?: ProductTelemetryCapture;
  loadCatalog?: typeof loadModelCatalog;
}

interface PreparedExecution {
  env: PlatformEnv;
  store: RoutineStore;
  run: RoutineRun;
  routine: RoutineDefinition;
  access: RoutineRuntimeAccess;
  prompt: PreparedRoutinePrompt;
  envelope: RoutineAgentDispatchEnvelope;
  receipt: RoutineAgentReceiptV1 | null;
  usageRecorder?: RoutineUsageRecorder;
  workLifecycle?: ShadowWorkLifecycle;
  persistence: RoutinePersistenceTracker;
  sandboxUnavailableFallback: boolean;
  productTelemetry?: ProductTelemetryCapture;
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
  // A suspended or ended installation starts nothing and is delivered
  // nothing: the occurrence is skipped, with no notice, no pause and no
  // failure counted, and never replayed on resume. One never prepared is
  // skipped here. One already prepared has its dispatched attempt stopped
  // first, then goes on below only to settle what preparing it opened (its
  // Work and usage).
  const refused = await installationRefusesWork(input.env);
  if (refused && current.status === 'admitting') {
    await skipRun(input.store, current.id, now(), REFUSED_SKIP);
    return 'completed';
  }
  if (refused) await abortRefusedAttempt(current, admission, dependencies.handle);

  let prepared: PreparedExecution;
  let access: RoutineRuntimeAccess | undefined;
  const resolveAccess = dependencies.resolveAccess ?? resolveRoutineRuntimeAccess;
  try {
    const settingsStore = dependencies.settingsStore ?? getSettingsStore(input.env);
    await (dependencies.loadCatalog ?? loadModelCatalog)(settingsStore, input.env).catch(() => undefined);
    access = await resolveAccess(current, routine, input.env);
    prepared = await prepareExecution(
      { ...input, run: current, routine, admission, access, settingsStore },
      dependencies,
    );
  } catch (error) {
    if (error instanceof RoutineSupersededError) return 'superseded';
    if (refused) {
      await settleRefusedWithoutPreparation(
        { env: input.env, run: current, admission, attempt: input.attempt },
        dependencies,
      );
      await skipRun(input.store, current.id, now(), REFUSED_SKIP);
      return 'completed';
    }
    // The deployment keyring not loading is transient: the occurrence waits
    // for a later heartbeat, and nothing is failed, paused or posted for it.
    if (isCredentialKeyringUnavailable(error)) return 'resumable';
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
    const creditedBack = await creditBackFailedRun(
      hostedRun(input.env, admission.flueAgentReceipt?.submissionId),
      creditBackReason(failure.failureClass, { funding: planFunding(undefined) }),
    );
    let terminalFailure = false;
    if (
      failure.failureClass === 'assignment_missing' &&
      current.status === 'admitting' &&
      routine.destination.kind === 'channel'
    ) {
      await skipRun(input.store, current.id, now(), {
        failureClass: 'assignment_missing',
        publicError: failure.publicError,
        skipReason: 'unresolved_assignment',
      });
    } else {
      await failUnsettledRun(
        input.store,
        current.id,
        failure.failureClass,
        failure.publicError,
        now(),
      );
      terminalFailure = true;
    }
    if (terminalFailure && access) {
      const terminalRun = await input.store.getRun(current.id);
      if (terminalRun) {
        const freshAccess = await resolveAccess(terminalRun, routine, input.env).catch(() => undefined);
        if (freshAccess) {
          await deliverFailureNoticeBestEffort({
            store: input.store,
            runId: current.id,
            access: freshAccess,
          }, withCreditedBack(terminalRun.publicError ?? failure.publicError, creditedBack));
        }
      }
    }
    return 'completed';
  }
  if (prepared.run.flueAgentSettlement) {
    try {
      await recordUsage(prepared, prepared.run.flueAgentSettlement);
      if (refused) return await skipWithoutResult(prepared, REFUSED_SKIP, now());
      return await finalizeSettlement(prepared, prepared.run.flueAgentSettlement, now(), prepared.receipt?.submissionId);
    } finally {
      await prepared.usageRecorder?.repairAfterTerminal();
      prepared.persistence.emit();
    }
  }

  // The agent module carries the whole turn runtime (Flue, provider SDKs,
  // the sandbox shell). Loading it here, when a routine actually runs, keeps
  // it out of the Worker's startup graph for every Admin and Slack request.
  const { ChickpeaRoutineExecution } = await import('../agents/routine-execution.ts');
  const handle = dependencies.handle ?? init(ChickpeaRoutineExecution, {
    id: prepared.envelope.instanceId,
    ...(prepared.receipt?.uid ? { uid: prepared.receipt.uid } : {}),
  });
  let receipt = prepared.receipt;
  const toolCalls = new ToolCallCounter('submit_routine_result');
  let modelSettled = false;
  // Why the attempt ended without a result to post: refused, or an outage.
  let withoutResult: SkipReason | undefined;
  let failureCause: RoutineFailureClass | undefined;
  let settledUsage: RoutineAgentUsageV1 | null = null;
  let settlement: RoutineAgentSettlementV1;
  // Only model execution and result validation belong to this catch. Once a
  // settlement is saved, delivery cannot rewrite it as a different execution.
  try {
    // Its dispatched attempt was stopped above; the refusal settles like one met mid-run.
    if (refused) throw new InstallationNotAdmittedError();
    if (!receipt) {
      if (now() >= prepared.run.deadlineAt) {
        throw new RoutineRuntimeError(
          'deadline_exceeded',
          'The routine occurrence exceeded its execution deadline.',
        );
      }
      let admitted: DispatchReceipt;
      try {
        admitted = await handle.dispatch({
          message: prepared.envelope.message,
          initialData: prepared.envelope.initialData,
          idempotencyKey: prepared.envelope.idempotencyKey,
        });
      } catch (error) {
        if (now() < prepared.run.deadlineAt) return 'resumable';
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
      if (isLocalReadInterruption(error) && now() < prepared.run.deadlineAt) return 'resumable';
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
      prepared.prompt.prompt !== executionPrompt(prepared.envelope) ||
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
    settlement = {
      schemaVersion: 1,
      outcome: 'completed',
      settledAt: now(),
      result: { ...result, toolCallCount: toolCalls.count, usage: settledUsage },
    };
  } catch (error) {
    const toolCallCount = toolCalls.count;
    failureCause = runtimeFailure(error, false).failureClass;
    // A model request the installation's admission refused, or the deployment
    // keyring not loading, ended the attempt: not the routine's failure.
    withoutResult = isInstallationRefusal(error) ? REFUSED_SKIP
      : isCredentialKeyringUnavailable(error) ? KEYRING_UNAVAILABLE_SKIP
      : undefined;
    const failure = withoutResult ?? runtimeFailure(error, toolCallCount > 0);
    settlement = {
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
        ...(withoutResult === REFUSED_SKIP
          ? refusedExecutionSettlement(receipt !== null)
          : toolCallCount > 0
            ? { outcome: 'ambiguous' as const, rawStatus: 'flue_ambiguous' }
            : { outcome: 'failed' as const, rawStatus: 'flue_failed' }),
        safeFailureCode: routineLifecycleFailureCode(failure.failureClass),
        ...(receipt ? { flueSubmissionRef: opaqueId('fluesubmission', receipt.submissionId) } : {}),
      });
    }
  }
  await recordUsage(prepared, settlement);
  try {
    prepared.run = await input.store.recordAgentSettlement({
      occurrenceId: prepared.run.id,
      settlement,
    });
    // Refused while the attempt ran: the settlement is kept, the occurrence
    // is skipped, and nothing is posted or counted against the routine.
    withoutResult ??= await installationRefusesWork(input.env) ? REFUSED_SKIP : undefined;
    if (withoutResult) return await skipWithoutResult(prepared, withoutResult, now());
    return await finalizeSettlement(prepared, settlement, now(), receipt?.submissionId, failureCause);
  } finally {
    await prepared.usageRecorder?.repairAfterTerminal();
    prepared.persistence.emit();
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
    access: RoutineRuntimeAccess;
    settingsStore: SettingsStore;
  },
  dependencies: RoutineExecutionDependencies,
): Promise<PreparedExecution> {
  const now = dependencies.now ?? Date.now;
  // Checked only once live access resolves, so an occurrence that expired
  // before it began still reaches its destination with the failure notice.
  if (input.run.deadlineAt <= now() && !input.run.flueAgentSettlement) {
    throw new RoutineRuntimeError(
      'deadline_exceeded',
      'The routine occurrence expired before execution began.',
    );
  }
  const access = input.access;
  if (input.run.flueAgentEnvelope) {
    assertRoutineReattachmentAttribution(input.run, input.run.flueAgentEnvelope, access);
  }
  const settingsStore = input.settingsStore;
  const usageStore = dependencies.usageStore ?? getUsageStore(input.env);
  const resolveModel = dependencies.resolveModel ?? resolveRuntimeModel;
  const frozenInitialData = input.run.flueAgentEnvelope
    ? executionInitialData(input.run.flueAgentEnvelope)
    : undefined;
  const runtimeModel = frozenInitialData
    ? {
        model: frozenInitialData.runtimePlan.runtimeModel ?? frozenInitialData.runtimePlan.model,
        ...(input.run.providerAuthRoute
          ? { providerAuthRoute: input.run.providerAuthRoute }
          : {}),
      }
    : await resolveModel(access.config.agentId, access.config.model, {
        settings: settingsStore,
        env: input.env,
      });
  const runtimeModelRoute = frozenInitialData
    ? frozenInitialData.runtimePlan.runtimeModelRoute
    : freezeRuntimeModelRoute(access.config.model, runtimeModel.providerAuthRoute, input.env);
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
    const workspaceDecision = dependencies.codingWorkspaceConfigured
      ? await (async () => {
          const configured = await dependencies.codingWorkspaceConfigured!(
            access.config,
            input.env,
          );
          const installed = (dependencies.sandboxInstalled ?? sandboxBindingInstalled)(input.env);
          return {
            capability: configured && installed ? 'available' as const : 'unavailable' as const,
            unavailableFallback: configured && !installed,
          };
        })()
      : await (dependencies.resolveWorkspaceDecision ?? resolveCodingWorkspaceDecision)(
          access.config,
          input.env,
          settingsStore,
        );
    const reader = dependencies.modelRoleReader ?? getConfigStore(input.env);
    // Same store authority as a Slack turn: a routine's Agent keeps whatever
    // image role its workspace or per-Agent override resolves to.
    const [imageRole, browserCapability, websiteLogins] = await Promise.all([
      resolveAgentModelRoleFromStore({
        role: 'image',
        workspaceId: input.routine.workspaceId,
        agent: { id: access.config.agent.id, kind: access.config.agent.kind },
        reader: {
          getWorkspaceModelRole: (workspaceId, role) =>
            reader.getWorkspaceModelRole(workspaceId, role),
          getAgentModelRole: (agentId, role) => reader.getAgentModelRole(agentId, role),
        },
        ...(input.env ? { env: input.env } : {}),
        settings: settingsStore,
      }),
      browserCapabilityForTurn(settingsStore, input.env),
      websiteLoginsForTurn(settingsStore, access.config.agent.websiteLogins),
    ]);
    const imageCapability = imageCapabilityForResolution(imageRole);
    const codingWorkspace = workspaceDecision.capability === 'available';
    const codingModel = codingWorkspace
      ? await freezeCodingModelForTurn({
          workspaceId: input.routine.workspaceId,
          agent: access.config.agent,
          reader,
          agentRoute: {
            model: access.config.model,
            runtimeModel: runtimeModel.model,
            ...(runtimeModelRoute ? { runtimeModelRoute } : {}),
          },
          settings: settingsStore,
          ...(input.env ? { env: input.env } : {}),
          resolveModel,
          agentCredential: modelCredential,
        })
      : undefined;
    const installation = installationOwnershipOf(input.env);
    envelope = createEnvelope({
      ...(installation ? { installation } : {}),
      routine: input.routine,
      run: input.run,
      access,
      prompt,
      attemptId,
      canonicalModel: access.config.model,
      runtimeModel: runtimeModel.model,
      ...(runtimeModelRoute ? { runtimeModelRoute } : {}),
      imageCapability,
      ...(codingWorkspace ? { codingWorkspace, ...(codingModel ? { codingModel } : {}) } : {}),
      ...(browserCapability ? { browserCapability, websiteLogins } : {}),
      modelCredential,
    });
    sandboxUnavailableFallback = workspaceDecision.unavailableFallback;
  }
  // Validate the admitted envelope before starting. The workspace tools open
  // the coding workspace themselves, and the Agent releases it when its run
  // settles, so this relay prepares and releases nothing.
  executionInitialData(envelope);
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

  const usageEnabled = dependencies.usageRecordingEnabled ?? usageRuntimeRecordingEnabled(input.env);
  const persistence = new RoutinePersistenceTracker({
    usageEnabled,
    workExpected: Boolean(run.canonicalRunId),
    sink: dependencies.persistenceTelemetrySink ?? console,
  });
  const usageRecorder = usageEnabled
    ? new RoutineUsageRecorder({
        operationId: run.id,
        executionId: `exec:${run.id}:${attemptId}`,
        ...(run.canonicalRunId ? { runId: run.canonicalRunId as RunId } : {}),
        startedAt: run.startedAt ?? run.queuedAt,
        workspaceId: input.routine.workspaceId,
        channelId: input.routine.channelId,
        ...(input.routine.destination.kind === 'direct_thread'
          ? { channelLabel: null, conversationKind: 'direct_message' as const }
          : {}),
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
        persistenceMode: 'durable',
        ...(run.flueAgentSettlement
          ? { replaySettlementAt: run.flueAgentSettlement.settledAt }
          : {}),
        deadlineAt: run.deadlineAt,
        now,
        onPersistence: (event) => persistence.recordUsage(event),
      })
    : undefined;
  await usageRecorder?.admit();

  const workLifecycle = await createRoutineShadowLifecycle({
    run,
    access,
    envelope,
    providerAuthRoute: runtimeModel.providerAuthRoute,
    modelCredential: modelCredential ?? undefined,
    workStore: dependencies.workStore ?? getWorkStore(input.env),
    env: input.env,
    attemptNumber: input.attempt,
    now,
    onGap: () => persistence.recordWorkGap(),
  });
  if (workLifecycle) {
    persistence.linkWork();
    usageRecorder?.linkRunExecution(workLifecycle.executionId);
  }
  return {
    store: input.store,
    run,
    routine: input.routine,
    access,
    prompt,
    envelope,
    env: input.env,
    receipt: input.admission.flueAgentReceipt ?? null,
    ...(usageRecorder ? { usageRecorder } : {}),
    ...(workLifecycle ? { workLifecycle } : {}),
    persistence,
    sandboxUnavailableFallback,
    ...(dependencies.productTelemetry ? { productTelemetry: dependencies.productTelemetry } : {}),
  };
}

function createEnvelope(input: {
  installation?: InstallationOwnership;
  routine: RoutineDefinition;
  run: RoutineRun;
  access: RoutineRuntimeAccess;
  prompt: PreparedRoutinePrompt;
  attemptId: string;
  canonicalModel: string;
  runtimeModel: string;
  runtimeModelRoute?: FrozenRuntimeModelRoute;
  imageCapability?: RuntimePlanImageCapabilityV3;
  codingWorkspace?: boolean;
  codingModel?: RuntimePlanCodingModelV1;
  browserCapability?: RuntimePlanBrowserCapabilityV1;
  websiteLogins?: readonly RuntimePlanWebsiteLoginV1[];
  modelCredential: EffectiveSlackConfig['modelCredential'] | null;
}): RoutineAgentDispatchEnvelopeV2 {
  const runtimePlan = compileRuntimePlanV2({
    ...(input.installation ? { installation: input.installation } : {}),
    turn: input.prompt.turn,
    assignment: {
      workspaceId: input.routine.workspaceId,
      channelId: input.routine.channelId,
      agentId: input.access.config.agentId,
      agent: input.access.config.agent,
      model: input.canonicalModel,
      modelAttribution: input.access.config.modelAttribution,
      ...(input.access.config.ownerIncarnation
        ? { ownerIncarnation: input.access.config.ownerIncarnation }
        : {}),
      ...(input.modelCredential ? { modelCredential: input.modelCredential } : {}),
    },
    runtimeModel: input.runtimeModel,
    ...(input.runtimeModelRoute ? { runtimeModelRoute: input.runtimeModelRoute } : {}),
    ...(input.imageCapability ? { imageCapability: input.imageCapability } : {}),
    ...(input.codingWorkspace
      ? { codingWorkspace: true, ...(input.codingModel ? { codingModel: input.codingModel } : {}) }
      : {}),
    ...(input.browserCapability ? { browserCapability: input.browserCapability } : {}),
    ...(input.websiteLogins ? { websiteLogins: input.websiteLogins } : {}),
    instructions: [
      input.access.config.instructions,
      externalActionAuthorityInstructions(input.access.config.agent.instructions),
      ...routineExecutionInstructions(input.routine.destination.kind, Boolean(input.routine.destination.threadTs)),
    ].join('\n'),
    memoryEpoch: input.prompt.memoryEpoch,
    // Artifacts follow the saved destination only. The prompt turn's
    // thread is the synthetic due-time stamp when no thread was saved.
    artifactThreadTs: input.routine.destination.threadTs ?? null,
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
    schemaVersion: 2,
    attemptId: input.attemptId,
    instanceId: input.installation
      ? scopedObjectName(input.installation, opaqueId('routineagent', input.attemptId))
      : opaqueId('routineagent', input.attemptId),
    idempotencyKey: input.attemptId,
    message: {
      kind: 'signal',
      type: ROUTINE_SCHEDULE_SIGNAL_TYPE,
      body: input.prompt.prompt,
      attributes: {
        routineId: input.routine.id,
        occurrenceId: input.run.id,
        workspaceId: input.routine.workspaceId,
        conversationId: input.routine.channelId,
        destinationKind: input.routine.destination.kind,
        ownerAgentId: input.access.config.agentId,
        ownerMembershipId: input.access.actorMembershipId ?? 'legacy_membership',
        threadTs: input.routine.destination.threadTs ?? '',
        triggerSource: input.run.triggerSource,
        scheduledFor: String(input.run.scheduledFor),
        // Mirrors the actor the prompt stamped into its envelope so admission
        // can cross-check identity, not only the due time.
        actorSlackUserId: input.access.actorSlackUserId ?? input.routine.creatorUserId,
      },
    },
    initialData,
  };
}

function executionInitialData(envelope: RoutineAgentDispatchEnvelope): RoutineExecutionInitialData {
  return parseRoutineExecutionInitialData(envelope.initialData);
}

function executionPrompt(envelope: RoutineAgentDispatchEnvelope): string {
  return envelope.schemaVersion === 1 ? envelope.message : envelope.message.body;
}

function assertRoutineReattachmentAttribution(
  run: RoutineRun,
  envelope: RoutineAgentDispatchEnvelope,
  access: RoutineRuntimeAccess,
): void {
  const runtimePlan = executionInitialData(envelope).runtimePlan;
  const admittedAgentId = runtimePlan.agentId;
  const legacyAccessHash = access.legacyAccessHashForCatalogRevision?.(
    runtimePlan.modelAttribution?.catalogRevision,
  );
  if (
    !run.resolvedAgentId ||
    !run.resolvedAccessHash ||
    run.resolvedAgentId !== admittedAgentId ||
    access.config.agentId !== admittedAgentId ||
    access.accessHash !== run.resolvedAccessHash &&
    legacyAccessHash !== run.resolvedAccessHash
  ) {
    throw new RoutineRuntimeError(
      'access_denied',
      'Channel access changed while the routine was running.',
    );
  }
}

async function createRoutineShadowLifecycle(
  input: {
    run: RoutineRun;
    access: RoutineRuntimeAccess;
    envelope: RoutineAgentDispatchEnvelope;
    providerAuthRoute: ProviderAuthRoute | undefined;
    modelCredential:
      | NonNullable<Awaited<ReturnType<typeof resolveModelCredentialAttribution>>>
      | undefined;
    workStore: WorkStore;
    env: PlatformEnv | undefined;
    attemptNumber?: number;
    now?: () => number;
    onGap?: () => void;
  },
): Promise<ShadowWorkLifecycle | undefined> {
  const {
    run,
    access,
    envelope,
    providerAuthRoute,
    modelCredential,
    workStore,
    env,
    attemptNumber = 1,
    now = Date.now,
    onGap,
  } = input;
  if (!run.canonicalRunId) return undefined;
  try {
    const lifecycle = await beforeOccurrenceDeadline(
      () => createWorkExecutionLifecycle(workStore, {
        runId: run.canonicalRunId!,
        attemptNumber,
        executorKind: 'agent',
        agentName: access.config.agentId,
        canonicalModel: access.config.model,
        flueInstanceRef: opaqueId('flueinstance', envelope.instanceId),
        routeEvidence: safeRuntimeModelRouteEvidence(
          access.config.model,
          providerAuthRoute,
          modelCredential,
          env,
        ),
      }, {
        mode: 'observe',
        persistenceMode: 'durable',
        deadlineAt: run.deadlineAt,
        now,
        ...(onGap ? { onGap } : {}),
      }),
      run.deadlineAt,
      now,
    );
    if (!lifecycle) {
      onGap?.();
      return undefined;
    }
    return await lifecycle.prepareExecution(executionPrompt(envelope)) ? lifecycle : undefined;
  } catch {
    onGap?.();
    return undefined;
  }
}

async function beforeOccurrenceDeadline<T>(
  work: () => Promise<T>,
  deadlineAt: number,
  now: () => number,
): Promise<T | undefined> {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work().then((value) => ({ kind: 'value' as const, value })),
      new Promise<{ kind: 'expired' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'expired' }), remainingMs);
      }),
    ]);
    return result.kind === 'value' ? result.value : undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function finalizeSettlement(
  prepared: PreparedExecution,
  settlement: RoutineAgentSettlementV1,
  at: number,
  submissionId: string | undefined,
  cause?: RoutineFailureClass,
): Promise<RoutineExecutionOutcome> {
  if (settlement.outcome === 'completed') {
    prepared.run = await prepared.store.getRun(prepared.run.id) ?? prepared.run;
    let failure: RoutineRuntimeError | undefined;
    let refusedTask: RoutineRuntimeError | undefined;
    if (settlement.result.status === 'succeeded') {
      if (prepared.run.deliveryStatus === 'leased') {
        // A concurrent post may still be in flight. Keep its lease intact.
        if ((prepared.run.deliveryLeaseUntil ?? Infinity) > at) return 'resumable';
        prepared.run = await prepared.store.recordDelivery({
          occurrenceId: prepared.run.id, outcome: 'unknown', at, failureClass: 'delivery_unknown',
        });
      }
      if (prepared.run.deliveryStatus === 'none') refusedTask = failure = await requireDeliveryTaskFee(prepared, submissionId);
      if (refusedTask) {
        await prepared.workLifecycle?.settleWithoutDelivery({
          terminalDisposition: 'failed',
          safeFailureCode: routineLifecycleFailureCode(refusedTask.failureClass),
        });
      } else if (prepared.run.deliveryStatus === 'none') {
        try {
          await deliverRoutineResult({
            store: prepared.store, run: prepared.run, routine: prepared.routine,
            access: prepared.access, message: settlement.result.message,
            changeKeyHash: settlement.result.changeKeyHash,
            ...(settlement.result.artifacts ? { artifacts: settlement.result.artifacts } : {}),
            ...(prepared.workLifecycle ? { workLifecycle: prepared.workLifecycle } : {}),
          }, prepared.access.client);
        } catch (error) {
          if (!(error instanceof RoutineRuntimeError)) throw error;
          failure = error;
        }
        prepared.run = await prepared.store.getRun(prepared.run.id) ?? prepared.run;
      }
      if (prepared.run.deliveryStatus === 'delivered') {
        // The receipt is authoritative even if a later bookkeeping callback failed.
        failure = undefined;
      } else if (!failure) {
        const cause = prepared.run.failureClass;
        failure = routineDeliveryFailure(
          cause === 'direct_thread_unavailable' || cause === 'channel_destination_unavailable' ||
          cause === 'slack_rate_limited' ? cause : 'delivery_unknown',
        );
      }
    } else {
      await prepared.workLifecycle?.settleWithoutDelivery({ terminalDisposition: 'no_op' });
    }
    if (failure) {
      await creditBackFailedRun(
        hostedRun(prepared.env, submissionId),
        creditBackReason(failure.failureClass, {
          funding: planFunding(executionInitialData(prepared.envelope).runtimePlan),
          toolCallCount: settlement.result.toolCallCount,
        }),
      );
    }
    const usage = settlement.result.usage;
    prepared.run = await prepared.store.transitionRun({
      occurrenceId: prepared.run.id,
      from: ['running'],
      to: failure ? 'failed' : settlement.result.status,
      at,
      ...(failure ? { failureClass: failure.failureClass, publicError: failure.publicError } : {}),
      model: routineModelLabel(usage.returnedModel, usage.requestedModel),
      ...(usage.inputTokens === null ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === null ? {} : { outputTokens: usage.outputTokens }),
      ...(usage.cacheReadTokens === null ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === null ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(prepared.usageRecorder ? {
        usageLedgerOperationId: prepared.run.id, usageProvenance: 'usage_ledger' as const,
      } : {}),
      usageCompleteness: usage.completeness,
      toolCallCount: settlement.result.toolCallCount,
      changeKeyHash: settlement.result.changeKeyHash,
      suppressedAsNoOp: settlement.result.suppressedAsNoOp,
    });
    captureScheduledRun(prepared, failure ? 'failed' : settlement.result.status);
    if (refusedTask) {
      await deliverFailureNoticeBestEffort({
        store: prepared.store,
        runId: prepared.run.id,
        access: prepared.access,
        ...(prepared.workLifecycle ? { workLifecycle: prepared.workLifecycle } : {}),
      }, refusedTask.publicError);
    }
    if (failure) await deliverPauseNoticeBestEffort(prepared);
    return 'completed';
  }
  const creditedBack = await creditBackFailedRun(
    hostedRun(prepared.env, submissionId),
    creditBackReason(cause ?? settlement.failureClass, {
      funding: planFunding(executionInitialData(prepared.envelope).runtimePlan),
      toolCallCount: settlement.toolCallCount,
    }),
  );
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
  captureScheduledRun(prepared, 'failed');
  await deliverFailureNoticeBestEffort({
    store: prepared.store,
    runId: prepared.run.id,
    access: prepared.access,
    ...(prepared.workLifecycle ? { workLifecycle: prepared.workLifecycle } : {}),
  }, withCreditedBack(settlement.publicError, creditedBack));
  await deliverPauseNoticeBestEffort(prepared);
  return 'completed';
}

async function requireDeliveryTaskFee(
  prepared: PreparedExecution,
  submissionId: string | undefined,
): Promise<RoutineRuntimeError | undefined> {
  const run = hostedRun(prepared.env, submissionId);
  if (!run || !qualifiesAsTask({ kind: 'scheduled' }, { kind: 'post' })) return undefined;
  const outcome = await postRunFee({ ...run, tier: 'task', agentId: prepared.access.config.agentId });
  return outcome.kind === 'refused' ? new RoutineRuntimeError('spend_limited', CREDITS_EXHAUSTED_TEXT) : undefined;
}

function captureScheduledRun(
  prepared: PreparedExecution,
  outcome: 'succeeded' | 'no_op' | 'failed',
): void {
  prepared.productTelemetry?.capture({
    event: 'run_completed',
    workspaceId: prepared.routine.workspaceId,
    agentId: prepared.access.config.agentId,
    triggerKind: 'scheduled',
    outcome,
  });
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
          ...(usage.cacheWrite1hTokens ? { cacheWrite1h: usage.cacheWrite1hTokens } : {}),
          totalTokens: usage.totalTokens,
        } }
      : {}),
    ...(usage?.returnedModel ? { returnedModel: usage.returnedModel } : {}),
    ...(usage ? {} : { unknownReason: 'provider_request_unknown' }),
  });
}

class RoutinePersistenceTracker {
  private readonly startedAt = performance.now();
  private readonly usageEvents: UsagePersistenceEvent[] = [];
  private workLinked = false;
  private workGap = false;
  private emitted = false;

  constructor(private readonly options: {
    usageEnabled: boolean;
    workExpected: boolean;
    sink: RoutinePersistenceTelemetrySink;
  }) {}

  recordUsage(event: UsagePersistenceEvent): void {
    this.usageEvents.push(event);
  }

  linkWork(): void {
    this.workLinked = true;
  }

  recordWorkGap(): void {
    this.workGap = true;
  }

  emit(): void {
    if (this.emitted) return;
    this.emitted = true;
    const usage = this.usageOutcome();
    const work = !this.options.workExpected
      ? 'not_linked' as const
      : this.workLinked && !this.workGap
        ? 'recorded' as const
        : 'unrepaired' as const;
    const outcome: RoutinePersistenceSummary['outcome'] =
      usage === 'unrepaired' || work === 'unrepaired'
        ? 'unrepaired'
        : usage === 'repaired'
          ? 'repaired'
          : 'recorded';
    emitRoutinePersistenceTelemetry({
      phase: work === 'unrepaired'
        ? 'work'
        : usage === 'repaired' || usage === 'unrepaired'
          ? 'repair'
          : 'terminal',
      outcome,
      usage,
      work,
      durationMs: performance.now() - this.startedAt,
    }, this.options.sink);
  }

  private usageOutcome(): RoutinePersistenceSummary['usage'] {
    if (!this.options.usageEnabled) return 'disabled';
    if (this.usageEvents.some((event) => event.phase === 'repair' && event.outcome === 'recorded')) {
      return 'repaired';
    }
    const admission = this.usageEvents.findLast((event) => event.phase === 'admission');
    const terminal = this.usageEvents.findLast((event) => event.phase === 'terminal');
    return admission?.outcome === 'recorded' && terminal?.outcome === 'recorded'
      ? 'recorded'
      : 'unrepaired';
  }
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
  const normalized = normalizeRoutineModelResult(parsed.output, run, routine);
  let artifacts: SlackArtifactReceipt[];
  try {
    artifacts = parseSlackArtifactReceipts(reply.data[SLACK_ARTIFACT_RECEIPTS_DATA_NAME]);
  } catch {
    throw new RoutineRuntimeError('result_invalid', 'The routine staged files without a valid receipt.');
  }
  return {
    ...normalized,
    message: resolveFileDeliveryText(normalized.message, reply.data[FILE_DELIVERY_DATA_NAME]),
    ...(artifacts.length > 0 && normalized.status === 'succeeded' ? { artifacts } : {}),
  };
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
    ...(completeness === 'complete' && reported.cacheWrite1h
      ? { cacheWrite1hTokens: reported.cacheWrite1h }
      : {}),
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
      ...(isTokenCount(counts.cacheWrite1h) && counts.cacheWrite1h > 0
        ? { cacheWrite1h: counts.cacheWrite1h }
        : {}),
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
  if (isCreditsExhausted(error)) return { failureClass: 'spend_limited', publicError: CREDITS_EXHAUSTED_TEXT };
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

export interface SkipReason {
  readonly failureClass: RoutineFailureClass;
  readonly publicError: string;
  readonly skipReason: string;
}

/**
 * An occurrence the installation's admission refused, before or during its
 * attempt: skipped, with no notice and no failure counted. Like any skipped
 * occurrence of a one-time routine, it completes that routine unrun. A host
 * cancelling an installation's pending work skips its occurrences with this
 * too (state/pending-work.ts), so members see one wording either way.
 */
export const REFUSED_SKIP: SkipReason = {
  failureClass: 'policy_denied',
  publicError: 'The workspace was not admitted to run this occurrence.',
  skipReason: 'installation_not_admitted',
};

/**
 * A dispatched attempt the deployment keyring stopped: skipped like a
 * refusal, never the routine's failure. Its submission has failed, so it
 * cannot wait for the keyring as an undispatched occurrence does; a
 * one-time routine's only occurrence skipped this way completes the routine
 * unrun, with no notice.
 */
const KEYRING_UNAVAILABLE_SKIP: SkipReason = {
  failureClass: 'credential_unavailable',
  publicError: 'The deployment\'s credentials were temporarily unavailable.',
  skipReason: 'keyring_unavailable',
};

/** Skip an occurrence that has not settled; one already terminal is left as it is. */
async function skipRun(
  store: RoutineStore,
  occurrenceId: string,
  at: number,
  reason: SkipReason,
): Promise<void> {
  const run = await store.getRun(occurrenceId);
  if (!run || (run.status !== 'admitting' && run.status !== 'running')) return;
  await store.transitionRun({ occurrenceId: run.id, from: [run.status], to: 'skipped', at, ...reason });
}

/**
 * Stop a refused occurrence's dispatched attempt that has not settled. Only
 * its envelope and receipt are needed, so this happens before preparing the
 * occurrence again, which can fail once the installation has ended.
 */
async function abortRefusedAttempt(
  run: RoutineRun,
  admission: RoutineAdmissionAttempt,
  handle: AgentInstanceHandle | undefined,
): Promise<void> {
  const receipt = admission.flueAgentReceipt;
  if (!receipt || !run.flueAgentEnvelope || run.flueAgentSettlement) return;
  const attempt = handle ?? init(
    (await import('../agents/routine-execution.ts')).ChickpeaRoutineExecution,
    { id: run.flueAgentEnvelope.instanceId, ...(receipt.uid ? { uid: receipt.uid } : {}) },
  );
  await attempt.abort().catch(() => {
    console.warn('[chickpea] a refused routine attempt could not be stopped; its next model request is refused');
  });
}

/**
 * How a refused attempt's Work execution settles, whether or not it could be
 * prepared again: one dispatched may have reached the model, and what it did
 * there is never read; one never dispatched submitted nothing.
 */
function refusedExecutionSettlement(dispatched: boolean) {
  return dispatched
    ? { outcome: 'ambiguous' as const, rawStatus: 'flue_ambiguous' }
    : { outcome: 'not_submitted' as const, rawStatus: 'model_not_invoked' };
}

/**
 * Settle what an earlier preparation of a refused occurrence opened when
 * preparing it again fails, as it does once the installation has ended and
 * access no longer resolves: its Work execution settles and its Run is
 * skipped, and its usage terminal is recorded with spend unknown. Each part
 * is best effort, one already settled is left as it is, and one left open
 * is reported as unrepaired, as a prepared occurrence's gaps are. A host
 * cancelling an installation's pending work settles each running occurrence
 * it skips this way too (state/pending-work.ts).
 */
export async function settleRefusedWithoutPreparation(
  input: {
    env: PlatformEnv;
    run: RoutineRun;
    admission: RoutineAdmissionAttempt;
    attempt: number;
  },
  dependencies: Pick<
    RoutineExecutionDependencies,
    'now' | 'usageRecordingEnabled' | 'usageStore' | 'workStore' | 'persistenceTelemetrySink'
  >,
): Promise<void> {
  const { env, run, admission, attempt } = input;
  const now = dependencies.now ?? Date.now;
  const usageEnabled = dependencies.usageRecordingEnabled ?? usageRuntimeRecordingEnabled(env);
  const persistence = new RoutinePersistenceTracker({
    usageEnabled,
    workExpected: Boolean(run.canonicalRunId),
    sink: dependencies.persistenceTelemetrySink ?? console,
  });
  let execution: RunExecutionRecord | undefined;
  if (run.canonicalRunId) {
    const workStore = dependencies.workStore ?? getWorkStore(env);
    try {
      // One never opened when the attempt was prepared was a gap then, and is reported as one.
      execution = await workStore.getRunExecution(shadowRunExecutionId(run.canonicalRunId as RunId, attempt));
      if (execution) {
        await settleRefusedWork(workStore, execution, admission.flueAgentReceipt, now());
        persistence.linkWork();
      }
    } catch {
      persistence.recordWorkGap();
    }
  }
  if (usageEnabled && admission.attemptId) {
    const executionId = `exec:${run.id}:${admission.attemptId}`;
    const recorded = await recordRoutineTerminalWithoutRecorder({
      store: dependencies.usageStore ?? getUsageStore(env),
      operationId: run.id,
      executionId,
      ...(execution ? { runExecutionId: execution.id } : {}),
      status: 'failed',
      unknownReason: 'provider_request_unknown',
      at: now(),
      platformEnv: env,
    }).catch(() => false);
    // An operation with its terminal was admitted when the attempt was prepared.
    for (const phase of ['admission', 'terminal'] as const) {
      persistence.recordUsage({ phase, outcome: recorded ? 'recorded' : 'failed', executionId });
    }
  }
  persistence.emit();
}

/** Settle a refused occurrence's Work execution by its id, then skip its Run. */
async function settleRefusedWork(
  store: WorkStore,
  execution: RunExecutionRecord,
  receipt: RoutineAgentReceiptV1 | null,
  at: number,
): Promise<void> {
  if (execution.outcome === 'pending') {
    // An execution whose route was never recorded can only settle unsubmitted.
    const { outcome, rawStatus } = refusedExecutionSettlement(
      receipt !== null && execution.modelInvocationStatus !== 'not_invoked',
    );
    await store.settleRunExecution({
      executionId: execution.id,
      fencingToken: execution.fencingToken,
      outcome,
      modelInvocationStatus: outcome === 'ambiguous' ? 'settled' : 'not_invoked',
      rawSettlementRef: opaqueId('settlement', `${execution.id}:${rawStatus}`),
      rawSettlementStatus: rawStatus,
      safeFailureCode: routineLifecycleFailureCode(REFUSED_SKIP.failureClass),
      ...(receipt ? { flueSubmissionRef: opaqueId('fluesubmission', receipt.submissionId) } : {}),
      finishedAt: at,
    });
  }
  const workRun = await store.getRun(execution.runId);
  if (!workRun || workRun.status === 'settled') return;
  await store.settleRunWithoutDelivery({
    runId: execution.runId,
    fencingToken: execution.fencingToken,
    terminalDisposition: 'skipped',
    safeFailureCode: REFUSED_SKIP.skipReason,
    settledAt: at,
  });
}

/** Skip a prepared occurrence that ends without a result to post, settling its Work first. */
async function skipWithoutResult(
  prepared: PreparedExecution,
  reason: SkipReason,
  at: number,
): Promise<RoutineExecutionOutcome> {
  await prepared.workLifecycle?.settleWithoutDelivery({
    terminalDisposition: 'skipped',
    safeFailureCode: reason.skipReason,
  });
  await skipRun(prepared.store, prepared.run.id, at, reason);
  return 'completed';
}

async function deliverFailureNoticeBestEffort(
  input: {
    store: RoutineStore;
    runId: string;
    access: RoutineRuntimeAccess;
    workLifecycle?: ShadowWorkLifecycle;
  },
  publicError: string,
): Promise<void> {
  try {
    const run = await input.store.getRun(input.runId);
    if (!run || run.status !== 'failed' || run.deliveryStatus !== 'none') return;
    const routine = await input.store.getRoutine(run.routineId);
    if (!routine) return;
    await deliverRoutineFailureNotice({
      store: input.store,
      run,
      routine,
      access: input.access,
      publicError,
      ...(input.workLifecycle ? { workLifecycle: input.workLifecycle } : {}),
    }, input.access.client);
  } catch (error) {
    if (error instanceof RoutineRuntimeError &&
        error.failureClass === 'direct_thread_unavailable') {
      await (async () => {
        const run = await input.store.getRun(input.runId);
        if (!run) return;
        const routine = await input.store.getRoutine(run.routineId);
        if (!routine) return;
        await deliverRoutineRecoveryNotice({
          store: input.store,
          run,
          routine,
          access: input.access,
        }, input.access.client);
      })().catch(() => undefined);
    }
    // The failed occurrence remains available through its authorized management surface.
  }
}

async function deliverPauseNoticeBestEffort(prepared: PreparedExecution): Promise<void> {
  try {
    const run = await prepared.store.getRun(prepared.run.id);
    if (!run || !(await prepared.store.getRecoveryDelivery(run.id))) return;
    await deliverRoutineRecoveryNotice({
      store: prepared.store,
      run,
      routine: prepared.routine,
      access: prepared.access,
    }, prepared.access.client);
  } catch {
    // The durable root-notice claim prevents a duplicate if this outward result is ambiguous.
  }
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
import { FILE_DELIVERY_DATA_NAME, resolveFileDeliveryText } from '../slack/file-delivery-completion.ts';
