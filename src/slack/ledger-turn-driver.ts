import type { WebClient } from '@slack/web-api';

import type { PlatformEnv } from '../config/state-backend.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { UsageStore } from '../usage/types.ts';
import { opaqueId } from '../work/admission.ts';
import type { RunDriverHandlerResult } from '../work/driver.ts';
import type {
  InteractiveRunClaim,
  WorkStore,
} from '../work/types.ts';
import { getClient, runTurn, type RunTurnOptions } from './run-turn.ts';
import {
  deliverPersistedSlackPayload,
  PersistedSlackDeliveryError,
} from './web-client-presenter.ts';
import {
  MAX_POST_DISPATCH_ATTEMPTS,
  MAX_TURN_ATTEMPTS,
  type PendingTurnJob,
} from './turn-jobs.ts';
import type { NormalizedSlackTurn } from './types.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { FrozenRuntimePlanDecision } from './turn-job-types.ts';
import type {
  FlueDispatchReceiptV1,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
} from './turn-job-types.ts';
import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { slackThreadKey } from './thread-key.ts';
import type { SlackInteractionIntent } from './interaction-intent.ts';
import type { SlackInteractionProgressPatch } from '../config/state-rpc.ts';
import type { SlackContinuityNoticeProgress } from '../config/state-rpc.ts';
import { ContinuityNoticeDeliveryError } from './continuity-notice.ts';
import { AgentPromptFailure } from './flue-dispatch.ts';

type MaybePromise<T> = T | Promise<T>;

export interface LedgerSlackTurnStore {
  getPendingByRunId(runId: string): MaybePromise<PendingTurnJob | undefined>;
  freezeRuntimePlan(
    id: string,
    candidate: RuntimePlanV2,
  ): MaybePromise<FrozenRuntimePlanDecision>;
  prepareFlueDispatch(
    id: string,
    message: string,
    observation: FlueTurnObservationV1,
  ): MaybePromise<import('./turn-job-types.ts').FlueDispatchEnvelopeV1>;
  reconcileFlueExistingInstance(
    id: string,
    uid: string,
  ): MaybePromise<import('./turn-job-types.ts').FlueDispatchEnvelopeV1>;
  recordFlueReceipt(id: string, receipt: FlueDispatchReceiptV1): MaybePromise<FlueDispatchReceiptV1>;
  recordFlueSettlement(
    id: string,
    settlement: FlueSettlementCheckpointV1,
  ): MaybePromise<FlueSettlementCheckpointV1>;
  recordContinuityNotice(
    id: string,
    notice: SlackContinuityNoticeProgress,
  ): MaybePromise<unknown>;
  markRecoveryRequired(id: string, reason: string): MaybePromise<void>;
  recordAttempt(id: string, attempts: number): MaybePromise<void>;
  recordInteractionIntent(id: string, intent: SlackInteractionIntent): MaybePromise<unknown>;
  recordSlackInteractionProgress(
    id: string,
    patch: SlackInteractionProgressPatch,
  ): MaybePromise<unknown>;
  markDelivered(id: string): MaybePromise<void>;
  markError(id: string): MaybePromise<void>;
}

export type LedgerSlackTurnExecutor = (
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  options?: RunTurnOptions,
) => Promise<void>;

export interface LedgerSlackRunHandlerOptions {
  work: WorkStore;
  turns: LedgerSlackTurnStore;
  client?: WebClient;
  platformEnv?: PlatformEnv;
  settingsStore?: SettingsStore;
  usageStore?: UsageStore;
  executeTurn?: LedgerSlackTurnExecutor;
  setActiveWork?: (key: string, generation: string, active: boolean) => MaybePromise<void>;
  now?: () => number;
}

/** Slack adapter handler for a ledger-owned claim. It keeps adapter payloads in
 * the compatibility TurnJob table for the v1 cutover, but only the common Run
 * lease/fence owns execution. A response-ready claim replays persisted render
 * bytes and never re-enters the model path. */
export function createLedgerSlackRunHandler(
  options: LedgerSlackRunHandlerOptions,
): (claim: InteractiveRunClaim) => Promise<RunDriverHandlerResult> {
  const now = options.now ?? Date.now;
  const executeTurn = options.executeTurn ?? runTurn;
  return async (claim) => {
    const job = await options.turns.getPendingByRunId(claim.run.id);
    if (!job || job.executionAuthority !== 'ledger') {
      return { kind: 'recovery_required', reasonCode: 'ledger_adapter_payload_missing' };
    }
    if (claim.binding.adapterKind !== 'slack') {
      await options.turns.markError(job.id);
      await clearActiveWork(options, job);
      return { kind: 'recovery_required', reasonCode: 'ledger_adapter_unsupported' };
    }
    const attempt = job.attempts + 1;
    if (!job.turn.interactionIntent && job.progress.interactionIntent) {
      job.turn.interactionIntent = job.progress.interactionIntent;
    }
    await options.turns.recordAttempt(job.id, attempt);
    const client = options.client ?? await getClient(options.platformEnv);
    if (claim.phase === 'delivery') {
      return deliverPersistedResponse(options, claim, job, client, attempt, now);
    }
    const runtimePlanDecision = job.runtimePlan && job.agentInstanceId &&
        job.continuityNoticeRequired !== undefined
      ? {
          runtimePlan: job.runtimePlan,
          instanceId: job.agentInstanceId,
          continuityNoticeRequired: job.continuityNoticeRequired,
        }
      : undefined;
    try {
      await executeTurn(job.turn, job.assignment, options.platformEnv, {
        client,
        turnId: job.id,
        usageExecutionId: `exec:${job.id}:flue`,
        runId: claim.run.id,
        runAttempt: claim.fencingToken,
        runFencingToken: claim.fencingToken,
        executionAuthority: 'ledger',
        ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
        onRuntimePlan: (candidate) => options.turns.freezeRuntimePlan(job.id, candidate),
        flueDispatch: {
          ...(job.dispatchEnvelope ? { dispatchEnvelope: job.dispatchEnvelope } : {}),
          ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {}),
          ...(job.flueSettlement ? { flueSettlement: job.flueSettlement } : {}),
          prepare: (message, observation) =>
            options.turns.prepareFlueDispatch(job.id, message, observation),
          reconcileExistingInstance: (uid) =>
            options.turns.reconcileFlueExistingInstance(job.id, uid),
          recordReceipt: (receipt) => options.turns.recordFlueReceipt(job.id, receipt),
          recordSettlement: (settlement) =>
            options.turns.recordFlueSettlement(job.id, settlement),
          markRecoveryRequired: (reason) =>
            options.turns.markRecoveryRequired(job.id, reason),
        },
        ...(job.progress.continuityNotice
          ? { continuityNoticeProgress: job.progress.continuityNotice }
          : {}),
        onContinuityNoticeProgress: async (notice) => {
          await options.turns.recordContinuityNotice(job.id, notice);
        },
        workStore: options.work,
        ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
        ...(options.usageStore ? { usageStore: options.usageStore } : {}),
        onInteractionIntent: async (intent) => {
          await options.turns.recordInteractionIntent(job.id, intent);
          if (intent.disposition === 'work') {
            await options.setActiveWork?.(slackThreadKey(job.turn), job.id, true);
          }
        },
        ...(job.progress.slackInteraction
          ? { interactionProgress: job.progress.slackInteraction }
          : {}),
        onInteractionProgress: async (patch) => {
          await options.turns.recordSlackInteractionProgress(job.id, patch);
        },
        onDelivered: async () => {
          await options.turns.markDelivered(job.id);
          await clearActiveWork(options, job);
        },
      });
    } catch (error) {
      if (error instanceof AgentPromptFailure && error.recoveryRequired) {
        await clearActiveWork(options, job);
        return {
          kind: 'recovery_required',
          reasonCode: 'flue_dispatch_reconciliation_required',
        };
      }
      if (error instanceof AgentPromptFailure && error.retryable) {
        if (attempt >= MAX_POST_DISPATCH_ATTEMPTS) {
          await options.turns.markRecoveryRequired(
            job.id,
            'post_dispatch_attempts_exhausted',
          );
          await clearActiveWork(options, job);
          return { kind: 'recovery_required', reasonCode: 'post_dispatch_attempts_exhausted' };
        }
        return { kind: 'requeue', reasonCode: 'flue_reattachment_interrupted' };
      }
      if (error instanceof ContinuityNoticeDeliveryError) {
        if (error.recoveryRequired) {
          await options.turns.markRecoveryRequired(
            job.id,
            'continuity_notice_delivery_unknown',
          );
          await clearActiveWork(options, job);
          return { kind: 'recovery_required', reasonCode: 'continuity_notice_delivery_unknown' };
        }
        return { kind: 'requeue', reasonCode: 'continuity_notice_delivery_failed' };
      }
      return classifyExecutionFailure(options, claim, job, attempt, now);
    }
    const run = await options.work.getRun(claim.run.id);
    if (run?.status === 'settled') {
      await options.turns.markDelivered(job.id);
      await clearActiveWork(options, job);
      return { kind: 'completed' };
    }
    if (run?.status === 'recovery_required') {
      await options.turns.markError(job.id);
      await clearActiveWork(options, job);
      return { kind: 'completed' };
    }
    return classifyExecutionFailure(options, claim, job, attempt, now);
  };
}

async function deliverPersistedResponse(
  options: LedgerSlackRunHandlerOptions,
  claim: InteractiveRunClaim,
  job: PendingTurnJob,
  client: WebClient,
  attempt: number,
  now: () => number,
): Promise<RunDriverHandlerResult> {
  const run = await options.work.getRun(claim.run.id);
  const rendered = run?.renderedPayloadRef
    ? await options.work.getContent(run.renderedPayloadRef)
    : undefined;
  if (!run || !rendered?.body) {
    await options.turns.markError(job.id);
    await clearActiveWork(options, job);
    return { kind: 'recovery_required', reasonCode: 'ledger_render_missing' };
  }
  const attemptId = opaqueId(
    'delivery',
    `${claim.run.id}:${claim.fencingToken}:persisted`,
  );
  try {
    const parsed = JSON.parse(rendered.body) as { method?: unknown };
    const method = typeof parsed?.method === 'string' ? parsed.method : 'invalid';
    await options.work.startRunDelivery({
      runId: claim.run.id,
      fencingToken: claim.fencingToken,
      method,
      attemptId,
      startedAt: now(),
    });
    const delivered = await deliverPersistedSlackPayload(client, rendered.body);
    await options.work.finalizeRunDelivery({
      runId: claim.run.id,
      fencingToken: claim.fencingToken,
      attemptId,
      outcome: 'delivered',
      deliveryRef: delivered.deliveryRef,
      terminalDisposition: 'succeeded',
      finalizedAt: now(),
    });
    await options.turns.markDelivered(job.id);
    await clearActiveWork(options, job);
    return { kind: 'completed' };
  } catch (error) {
    const failure = error instanceof PersistedSlackDeliveryError
      ? error
      : new PersistedSlackDeliveryError('unknown', 'delivery_receipt_persist_unknown');
    try {
      await options.work.finalizeRunDelivery({
        runId: claim.run.id,
        fencingToken: claim.fencingToken,
        attemptId,
        outcome: failure.outcome,
        safeFailureCode: failure.safeFailureCode,
        finalizedAt: now(),
      });
    } catch {
      await options.turns.markError(job.id);
      await clearActiveWork(options, job);
      return { kind: 'recovery_required', reasonCode: 'delivery_receipt_persist_unknown' };
    }
    if (failure.outcome === 'unknown') {
      await options.turns.markError(job.id);
      await clearActiveWork(options, job);
      return { kind: 'completed' };
    }
    if (attempt >= MAX_TURN_ATTEMPTS) {
      await options.work.settleRunWithoutDelivery({
        runId: claim.run.id,
        fencingToken: claim.fencingToken,
        terminalDisposition: 'failed',
        safeFailureCode: 'slack_delivery_exhausted',
        settledAt: now(),
      });
      await options.turns.markError(job.id);
      await clearActiveWork(options, job);
      return { kind: 'completed' };
    }
    return { kind: 'requeue', reasonCode: 'confirmed_delivery_failure' };
  }
}

async function classifyExecutionFailure(
  options: LedgerSlackRunHandlerOptions,
  claim: InteractiveRunClaim,
  job: PendingTurnJob,
  attempt: number,
  now: () => number,
): Promise<RunDriverHandlerResult> {
  const run = await options.work.getRun(claim.run.id);
  if (!run) {
    await options.turns.markError(job.id);
    await clearActiveWork(options, job);
    return { kind: 'recovery_required', reasonCode: 'ledger_run_missing' };
  }
  if (run.status === 'settled') {
    await options.turns.markDelivered(job.id);
    await clearActiveWork(options, job);
    return { kind: 'completed' };
  }
  if (run.status === 'recovery_required' || run.deliveryStatus === 'unknown') {
    await options.turns.markError(job.id);
    await clearActiveWork(options, job);
    return { kind: 'completed' };
  }
  if (run.status === 'response_ready' && run.deliveryStatus === 'failed') {
    if (attempt >= MAX_TURN_ATTEMPTS) {
      await options.work.settleRunWithoutDelivery({
        runId: claim.run.id,
        fencingToken: claim.fencingToken,
        terminalDisposition: 'failed',
        safeFailureCode: 'slack_delivery_exhausted',
        settledAt: now(),
      });
      await options.turns.markError(job.id);
      await clearActiveWork(options, job);
      return { kind: 'completed' };
    }
    return { kind: 'requeue', reasonCode: 'confirmed_delivery_failure' };
  }
  if (run.status === 'preparing_input' || run.status === 'input_ready' || run.status === 'executing') {
    // Presentation APIs keep executions in chronological order. Classify from
    // the newest bounded attempt, never the first historical pre-submit row.
    const executions = await options.work.listRunExecutions(claim.run.id, 50);
    const latest = executions.at(-1);
    if (!latest || latest.modelInvocationStatus === 'ready' ||
        latest.modelInvocationStatus === 'not_invoked' || latest.outcome === 'not_submitted') {
      if (attempt >= MAX_TURN_ATTEMPTS) {
        await options.turns.markError(job.id);
        await clearActiveWork(options, job);
        return { kind: 'recovery_required', reasonCode: 'ledger_turn_attempts_exhausted' };
      }
      return { kind: 'requeue', reasonCode: 'ledger_turn_failed_before_submit' };
    }
  }
  await options.turns.markError(job.id);
  await clearActiveWork(options, job);
  return { kind: 'recovery_required', reasonCode: 'ledger_turn_outcome_ambiguous' };
}

async function clearActiveWork(
  options: LedgerSlackRunHandlerOptions,
  job: PendingTurnJob,
): Promise<void> {
  if (job.turn.interactionIntent?.disposition !== 'work') return;
  await options.setActiveWork?.(slackThreadKey(job.turn), job.id, false);
}
