import { runtimePlanHasCodingWorkspace } from '../agents/runtime-plan.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { AppStores, PlatformEnv } from '../config/state-backend.ts';
import type { TurnProgress } from '../config/state-rpc.ts';
import type { TurnLatencyContext } from '../observability/runtime-latency.ts';
import { isStateStoreDisconnect } from '../config/cf-state-proxies.ts';
import { sandboxThreadKey } from '../sandbox/thread-key.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import type { UsageStore } from '../usage/types.ts';
import type { WorkStore } from '../work/types.ts';
import { isPlatformReset, settlementFailureFacts } from './agent-failure-diagnostics.ts';
import type { SlackPresentationStatePort } from './agent-view-presentation.ts';
import { alarmYieldIsFree, type AlarmTurnJobControl } from './alarm-turn-drain.ts';
import type { SlackStateLogic } from './claim-store.ts';
import type { SlackStatusRegistry } from './status-registry.ts';
import {
  AgentObservationYield,
  AgentPromptFailure,
  StateStoreUnavailable,
} from './flue-dispatch.ts';
import {
  effectiveTurnSlackInstallationId,
  normalizeSlackInstallationExecutionError,
  verifySlackInstallationTurnAccess,
  type SlackInstallationExecutionContext,
} from './installation-execution.ts';
import { recordSlackInstallationUnavailable } from './installation-observability.ts';
import {
  abandonTerminalSlackPresentationBestEffort,
  postRecoveryNoticeBestEffort,
} from './presentation-repair.ts';
import { recordDeliveredSlackAgentMessage } from './public-context.ts';
import {
  deliverAgentFailureFinal,
  sanitizeError,
  type runTurn,
  type RunTurnOptions,
} from './run-turn.ts';
import type { ThreadImageRecord } from './thread-images.ts';
import { slackAgentThreadKey } from './thread-key.ts';
import {
  MAX_DEPENDENCY_RETRY_AFTER_MS,
  retryableDependencyRetryAfterMs,
} from './transport/types.ts';
import type {
  FlueDispatchReceiptV1,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
} from './turn-job-types.ts';
import {
  MAX_POST_DISPATCH_ATTEMPTS,
  MAX_TURN_ATTEMPTS,
  replayTextForTurnProgress,
  type PendingTurnJob,
  type TurnJobStoreLogic,
} from './turn-jobs.ts';
import { DURABLE_RECOVERY_FAILURE_TEXT } from './web-client-presenter.ts';
import type { TurnEnvelopeV1 } from '../agents/turn-envelope.ts';

type MaybePromise<T> = T | Promise<T>;

/** Each method of `T`, which may also answer asynchronously (over RPC). */
type AsyncCapable<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => MaybePromise<R>
    : T[K];
};

/**
 * Everything one durable turn job touches while it runs, as ports. The shared
 * state store's alarm passes its own stores; a per-thread runner passes its
 * own presentation state and status registry and forwards the per-turn
 * writes to the state store over RPC.
 */
export interface TurnExecutionPorts {
  env: PlatformEnv;
  turnJobs: AsyncCapable<Pick<
    TurnJobStoreLogic,
    | 'recordAttempt'
    | 'markRecoveryRequired'
    | 'prepareFlueDispatch'
    | 'reconcileFlueExistingInstance'
    | 'recordFlueReceipt'
    | 'recordFlueSettlement'
    | 'recordPullRequest'
    | 'freezeRuntimePlan'
    | 'getBoundRuntimePlan'
    | 'recordUsagePersistence'
    | 'recordInteractionIntent'
    | 'recordSlackInteractionProgress'
    | 'markDelivered'
    | 'markError'
  >>;
  /** Slack claims and the per-thread active-work flag. */
  slack: AsyncCapable<Pick<
    SlackStateLogic,
    'setActiveWork' | 'markCodingActiveWork' | 'isCodingActiveWork' | 'release'
  >>;
  /** Thread context for every Agent message the turn delivers. */
  config: Parameters<typeof recordDeliveredSlackAgentMessage>[0];
  presentationState: SlackPresentationStatePort;
  /**
   * Local stores when the turn runs inside the shared state store. A thread
   * runner omits them, so the turn reaches them over RPC like any other
   * Durable Object.
   */
  settingsStore?: SettingsStore;
  usageStore?: UsageStore;
  workStore?: WorkStore;
  appStores?: AppStores;
  /**
   * How an approval turn applies its proposal. The shared state store's alarm
   * resolves its local management runtime (`managementApproval`); a thread
   * runner applies it in the state store over one RPC
   * (`invokeManagementApproval`). Each executor must supply one: without
   * either, a Cloudflare approval turn fails before it replies.
   */
  managementApproval?: RunTurnOptions['managementApproval'];
  invokeManagementApproval?: RunTurnOptions['invokeManagementApproval'];
  /** Where observed activity for this turn lands; the module default otherwise. */
  statusRegistry?: SlackStatusRegistry;
  telemetry: ProductTelemetryCapture;
  /** Current credentials for one Slack installation. */
  resolveInstallation(workspaceId: string): Promise<SlackInstallationExecutionContext>;
  /**
   * The coding Sandbox Durable Object of one thread, once per identity it may
   * run under; none when this deployment has no Sandbox binding.
   */
  sandboxes(sandboxKey: string): Array<() => SandboxTurnReader>;
  runTurn: typeof runTurn;
}

/** What a turn's recovery reads from its thread's coding Sandbox. */
export interface SandboxTurnReader {
  getTurnId(): Promise<string | undefined>;
  getTurnProgress(): Promise<TurnProgress>;
}

export interface TurnExecutionOptions {
  /** Which lane and executor the turn_latency record names. */
  latency: Pick<TurnLatencyContext, 'lane' | 'executor'>;
  /**
   * Recorded with the dispatch so the agent relays observed activity to the
   * executor that registered this turn's status (see status-relay.ts).
   */
  observationRoute?: Pick<FlueTurnObservationV1, 'executor' | 'runnerKey'>;
  /** Present when the caller can stop observation (a yield, not a failure). */
  control?: AlarmTurnJobControl;
  /** The public URL the caller already resolved (null: none); see RunTurnOptions. */
  publicUrl?: string | null;
  /**
   * The job stays pending and should be driven again soon; `afterMs` is the
   * least delay an unavailable installation asked for.
   */
  onRetry(afterMs?: number, reason?: 'state_store_unavailable'): void;
}

/**
 * Run one pending turn job to a settled outcome. Returns `false` when the
 * job stays pending (a retry, a yield, a durable reattachment, or a row now
 * held for operator recovery), which ends its thread for this drain; `true`
 * when the thread may continue with its next job.
 */
export async function executeTurnJob(
  job: PendingTurnJob,
  ports: TurnExecutionPorts,
  options: TurnExecutionOptions,
): Promise<boolean> {
  if (!job.turn.interactionIntent && job.progress.interactionIntent) {
    job.turn.interactionIntent = job.progress.interactionIntent;
  }
  let installationContext: SlackInstallationExecutionContext;
  try {
    installationContext = await ports.resolveInstallation(effectiveTurnSlackInstallationId(job.turn));
    await verifySlackInstallationTurnAccess(installationContext, job.turn);
  } catch (error) {
    const unavailable = normalizeSlackInstallationExecutionError(
      error,
      effectiveTurnSlackInstallationId(job.turn),
    );
    recordSlackInstallationUnavailable(unavailable);
    if (unavailable.retryable) {
      // Bounded like every other hint: an hour-long Retry-After must not park
      // the whole drain's re-arm.
      options.onRetry(Math.min(unavailable.retryAfterMs ?? 0, MAX_DEPENDENCY_RETRY_AFTER_MS));
      console.warn(
        `[chickpea] Slack installation preflight will retry (${unavailable.reasonCode})`,
      );
      return false;
    }
    await ports.turnJobs.markRecoveryRequired(job.id, 'slack_installation_unavailable');
    if (job.turn.interactionIntent?.disposition === 'work') {
      await ports.slack.setActiveWork(
        slackAgentThreadKey(job.turn, job.assignment),
        job.id,
        false,
      );
    }
    return false;
  }
  const client = installationContext.client;
  const attempt = job.attempts + 1;
  let delivered = false;
  let deferredTerminal = false;
  let activeWorkKey = job.turn.interactionIntent?.disposition === 'work'
    ? slackAgentThreadKey(job.turn, job.assignment)
    : undefined;
  // Advance the attempt count before running the turn: a crash mid-turn
  // then re-fires with the count already committed, bounding retries.
  await ports.turnJobs.recordAttempt(job.id, attempt);
  const flueDispatch = {
    ...(job.dispatchEnvelope ? { dispatchEnvelope: job.dispatchEnvelope } : {}),
    ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {}),
    ...(job.flueSettlement ? { flueSettlement: job.flueSettlement } : {}),
    prepare: (
      message: string,
      observation: FlueTurnObservationV1,
      threadImages?: readonly ThreadImageRecord[],
      admittedListIds?: readonly string[],
      turnEnvelope?: TurnEnvelopeV1,
    ) => ports.turnJobs.prepareFlueDispatch(
      job.id,
      message,
      options.observationRoute ? { ...observation, ...options.observationRoute } : observation,
      threadImages,
      admittedListIds,
      turnEnvelope,
    ),
    reconcileExistingInstance: (uid: string) =>
      ports.turnJobs.reconcileFlueExistingInstance(job.id, uid),
    recordReceipt: (receipt: FlueDispatchReceiptV1) =>
      ports.turnJobs.recordFlueReceipt(job.id, receipt),
    recordSettlement: (settlement: FlueSettlementCheckpointV1) =>
      ports.turnJobs.recordFlueSettlement(job.id, settlement),
    markRecoveryRequired: (reason: string) =>
      ports.turnJobs.markRecoveryRequired(job.id, reason),
  };
  const presentationState = ports.presentationState;
  const turnLatency = {
    ...(job.enqueuedAt === undefined ? {} : { admittedAt: job.enqueuedAt }),
    ...(job.receivedAt === undefined ? {} : { receivedAt: job.receivedAt }),
    ...options.latency,
  };
  const deliverRecoveryFailure = async (reasonCode: string): Promise<boolean> => {
    try {
      await ports.runTurn(job.turn, job.assignment, ports.env, {
        client,
        installationContext,
        turnId: job.id,
        ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
        turnLatency,
        ...(ports.settingsStore ? { settingsStore: ports.settingsStore } : {}),
        ...(options.publicUrl !== undefined ? { publicUrl: options.publicUrl } : {}),
        ...(ports.statusRegistry ? { statusRegistry: ports.statusRegistry } : {}),
        presentationState,
        replayText: DURABLE_RECOVERY_FAILURE_TEXT,
        replayTerminalResult: 'failure',
        onPublicMessageDelivered: (delivery) =>
          recordDeliveredSlackAgentMessage(
            ports.config, job.turn, job.assignment, delivery,
          ),
        onDelivered: async () => {
          delivered = true;
          await ports.turnJobs.markError(job.id);
          if (activeWorkKey) await ports.slack.setActiveWork(activeWorkKey, job.id, false);
        },
      });
      return true;
    } catch {
      // The recovery notice shares the run's V3 presentation. When that
      // presentation already holds an unresolved terminal (the reason the
      // preceding attempts threw), this replay throws the same way, so
      // abandon it: that is the only transition which lets durable repair
      // suspend the Agent Session and clear the visible activity status.
      console.error('[chickpea] durable recovery final failed:', { reasonCode });
      if (job.runId) {
        await abandonTerminalSlackPresentationBestEffort({
          runId: job.runId,
          state: presentationState,
          client,
          requireUnresolvedDelivery: true,
        });
      }
      // The thread must not end on a truncated prefix with no word.
      await postRecoveryNoticeBestEffort({
        client,
        state: presentationState,
        ...(job.runId ? { runId: job.runId } : {}),
        turnId: job.id,
        channelId: job.turn.channelId,
        threadTs: job.turn.threadTs,
      });
      await ports.turnJobs.markRecoveryRequired(job.id, reasonCode);
      if (activeWorkKey) await ports.slack.setActiveWork(activeWorkKey, job.id, false);
      return false;
    }
  };
  try {
    // The plan this job froze, kept current as runTurn freezes it.
    let frozenPlan = job.runtimePlan;
    const persistSandboxProgress = async (
      use?: { codingWorkspaceOpened?: boolean },
    ): Promise<string | undefined> => {
      // Only a turn that could have opened a coding workspace has
      // progress there. A turn whose own reply says it opened none skips
      // the Sandbox Durable Object entirely; an unknown one still checks.
      if (!frozenPlan || !runtimePlanHasCodingWorkspace(frozenPlan)) return undefined;
      if (frozenPlan.sandbox.mode !== 'cloudflare' && use?.codingWorkspaceOpened === false) {
        return undefined;
      }
      // The same Durable Object the workspace uses: the thread key, not
      // the owner-bound agent key, which names no workspace.
      const sandboxKey = sandboxThreadKey(slackAgentThreadKey(job.turn, job.assignment));
      for (const openSandbox of ports.sandboxes(sandboxKey)) {
        try {
          const sandbox = openSandbox();
          if ((await sandbox.getTurnId()) !== job.id) continue;
          const progress = await sandbox.getTurnProgress();
          if (progress.pullRequest) {
            await ports.turnJobs.recordPullRequest(job.id, progress.pullRequest);
          }
          const replayText = replayTextForTurnProgress(progress);
          if (replayText !== undefined) return replayText;
        } catch {
          // One identity can be unavailable during a rolling deploy. Keep
          // checking the bridge identity before degrading recovery.
        }
      }
      // Retry protection is best-effort on the read path. Either Sandbox
      // identity retains its marker, so a later alarm can try again.
      return undefined;
    };
    // A dispatched, unsettled turn reattaches to its own reply, which is
    // the answer; a PR it opened mid-run must not replace that answer
    // with a replayed notice while the submission is still running.
    const reattaching = job.dispatchReceipt !== undefined && job.flueSettlement === undefined;
    const replayText = reattaching
      ? undefined
      : replayTextForTurnProgress(job.progress) ?? (await persistSandboxProgress());
    const runtimePlanDecision = job.runtimePlan && job.agentInstanceId
      ? {
          runtimePlan: job.runtimePlan,
          instanceId: job.agentInstanceId,
        }
      : undefined;
    // A reattached coding turn keeps the coding backoff it already earned.
    const codingTaskStarted = reattaching && activeWorkKey !== undefined &&
      await ports.slack.isCodingActiveWork(activeWorkKey, job.id);
    await ports.runTurn(job.turn, job.assignment, ports.env, {
      client,
      installationContext,
      turnId: job.id,
      usageExecutionId: `exec:${job.id}:flue`,
      ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
      ...(options.control
        ? { observationSignal: options.control.signal, onObservationStarted: options.control.observing }
        : {}),
      turnLatency,
      ...(ports.workStore ? { workStore: ports.workStore } : {}),
      ...(ports.settingsStore ? { settingsStore: ports.settingsStore } : {}),
      ...(options.publicUrl !== undefined ? { publicUrl: options.publicUrl } : {}),
      ...(ports.usageStore ? { usageStore: ports.usageStore } : {}),
      ...(ports.appStores ? { appStores: ports.appStores } : {}),
      ...(ports.managementApproval ? { managementApproval: ports.managementApproval } : {}),
      ...(ports.invokeManagementApproval
        ? { invokeManagementApproval: ports.invokeManagementApproval }
        : {}),
      ...(ports.statusRegistry ? { statusRegistry: ports.statusRegistry } : {}),
      ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
      onRuntimePlan: async (candidate) => {
        const decision = await ports.turnJobs.freezeRuntimePlan(job.id, candidate);
        frozenPlan = decision.runtimePlan;
        return decision;
      },
      getBoundRuntimePlan: (...args) => ports.turnJobs.getBoundRuntimePlan(...args),
      flueDispatch,
      presentationState,
      progressiveAttributionProven: true,
      onUsagePersistence: (event) => {
        // A local store records synchronously, exactly as before. Over RPC it
        // is coverage bookkeeping only: it never fails or delays the turn.
        const recorded = ports.turnJobs.recordUsagePersistence(job.id, event);
        if (recorded instanceof Promise) {
          void recorded.catch(() => console.warn('[chickpea] usage persistence record failed'));
        }
      },
      onInteractionIntent: async (intent) => {
        await ports.turnJobs.recordInteractionIntent(job.id, intent);
        if (intent.disposition !== 'work') return;
        activeWorkKey = slackAgentThreadKey(job.turn, job.assignment);
        await ports.slack.setActiveWork(activeWorkKey, job.id, true);
      },
      onCodingTaskStarted: async () => {
        if (activeWorkKey) await ports.slack.markCodingActiveWork(activeWorkKey, job.id);
      },
      ...(codingTaskStarted ? { codingTaskStarted: true } : {}),
      ...(job.progress.slackInteraction
        ? { interactionProgress: job.progress.slackInteraction }
        : {}),
      onInteractionProgress: async (patch) => {
        await ports.turnJobs.recordSlackInteractionProgress(job.id, patch);
      },
      onPublicMessageDelivered: (delivery) =>
        recordDeliveredSlackAgentMessage(ports.config, job.turn, job.assignment, delivery),
      ...(replayText === undefined ? {} : { replayText }),
      beforeDelivery: persistSandboxProgress,
      // Record terminal delivery before runTurn's post-delivery Sandbox
      // turn close. A hung control-plane call must never leave an
      // already-posted Slack final eligible for relay retry.
      onDelivered: async (outcome) => {
        // The Slack final is posted: nothing may re-run the turn from here,
        // even when recording it below fails.
        delivered = true;
        await ports.turnJobs.markDelivered(job.id);
        if (activeWorkKey) await ports.slack.setActiveWork(activeWorkKey, job.id, false);
        if (outcome) {
          ports.telemetry.capture({
            event: 'run_completed',
            workspaceId: job.turn.workspaceId,
            agentId: job.assignment.agentId,
            triggerKind: 'interactive',
            outcome,
          });
        }
      },
      onDeferredTerminal: async () => {
        deferredTerminal = true;
        if (activeWorkKey) await ports.slack.setActiveWork(activeWorkKey, job.id, false);
      },
    });
    if (deferredTerminal) return true;
    // Delivery was tombstoned at the exact presentation boundary above.
    // Claims stay held — a completed turn never re-runs.
    return true;
  } catch (err) {
    // Any failure after the terminal presentation boundary is cleanup, not a
    // failed turn. The durable tombstone prevents a duplicate final; keep the
    // claims held and let a later thread turn start normally. Checked first:
    // nothing below may post a second final once one is out.
    if (delivered) {
      console.warn('[chickpea] post-delivery cleanup did not complete');
      return true;
    }
    // A disconnect that escaped the turn unmapped (thrown before it began)
    // is the same outage.
    if (err instanceof StateStoreUnavailable ||
        (!(err instanceof AgentPromptFailure) && isStateStoreDisconnect(err))) {
      const since = flueDispatch.dispatchReceipt?.acceptedAt ??
        (job.enqueuedAt === undefined ? undefined : new Date(job.enqueuedAt).toISOString());
      if (alarmYieldIsFree(since, Date.now())) {
        // A runner's state store is being replaced. Retry without spending
        // an attempt; a dispatched turn reattaches to its submission.
        options.onRetry(undefined, 'state_store_unavailable');
        await Promise.resolve(ports.turnJobs.recordAttempt(job.id, job.attempts)).catch(() => undefined);
        console.warn('[chickpea] state store unavailable; the turn will be retried');
        return false;
      }
      // Past the submission's durability, retries spend attempts, so the
      // existing caps end the turn with the recovery notice.
      console.warn('[chickpea] state store still unavailable past the turn durability');
    }
    if (err instanceof AgentObservationYield ||
        interruptedAfterYield(err, options.control?.signal, flueDispatch.dispatchReceipt)) {
      if (alarmYieldIsFree(flueDispatch.dispatchReceipt?.acceptedAt, Date.now())) {
        // The alarm stopped observing on purpose; nothing failed. Restore
        // the attempt count so a long turn never spends its reattachment
        // budget on yields, and keep its receipt, active work, and claims.
        await ports.turnJobs.recordAttempt(job.id, job.attempts);
        const interruption = err instanceof AgentObservationYield ? err.cause : err;
        if (interruption === undefined) {
          console.info('[chickpea] Flue turn yielded for reattachment by the next alarm');
        } else {
          // A code update resets this runner and what it reads together, so
          // the platform's reset can surface before the yield does. Name it.
          console.info('[chickpea] Flue turn yielded for reattachment by the next alarm', {
            interruptedBy: settlementFailureFacts(interruption),
          });
        }
        return false;
      }
      // Past its durability the submission should have settled. Spend
      // attempts from here so the bounded reattachment policy below ends
      // it with the durable recovery notice.
      console.warn('[chickpea] Flue turn outlived its submission durability');
    }
    if (err instanceof AgentPromptFailure && err.recoveryRequired) {
      console.error('[chickpea] Flue turn requires operator reconciliation');
      return deliverRecoveryFailure('flue_dispatch_reconciliation_required');
    }
    if (flueDispatch.dispatchEnvelope) {
      console.error('[chickpea] durable reattachment failed:', {
        causes: settlementFailureFacts(err),
      });
      // A dispatched turn is never discarded or replaced. A later alarm
      // replays its admission key, receipt read, or terminal settlement.
      if (attempt >= MAX_POST_DISPATCH_ATTEMPTS) {
        console.error('[chickpea] Flue turn exhausted durable reattachment attempts');
        return deliverRecoveryFailure('post_dispatch_attempts_exhausted');
      } else {
        // A rate-limited Slack/gateway call carries its own Retry-After.
        options.onRetry(retryableDependencyRetryAfterMs(err));
      }
      if (activeWorkKey) await ports.slack.setActiveWork(activeWorkKey, job.id, false);
      console.warn('[chickpea] Flue turn retained for durable reattachment');
      return false;
    }
    console.error(
      `[chickpea] relay turn attempt ${attempt} failed:`,
      sanitizeError(err),
    );
    if (attempt >= MAX_TURN_ATTEMPTS) {
      // Terminal: best-effort sanitized final so the thread is not left
      // silent, then release the claims (parity with the node .catch's
      // "failed delivery frees the claim") and tombstone so no further
      // attempt runs.
      await deliverAgentFailureFinal(
        job.turn,
        job.assignment,
        client,
        ports.env,
        (delivery) =>
          recordDeliveredSlackAgentMessage(
            ports.config,
            job.turn,
            job.assignment,
            delivery,
          ),
      ).catch((finalErr) => {
        console.error('[chickpea] relay terminal final failed:', sanitizeError(finalErr));
      });
      // The failure final may be posted: settle the row first, so a failed
      // release below can never let a later attempt post a second final.
      await ports.turnJobs.markError(job.id);
      if (activeWorkKey) await ports.slack.setActiveWork(activeWorkKey, job.id, false);
      // The turn is settled; a claim that cannot be released now only keeps
      // deduplicating until the terminal row ages out.
      for (const key of [job.evtKey, job.msgKey, `decision:${job.msgKey}`]) {
        try {
          await ports.slack.release(key);
        } catch {
          console.warn('[chickpea] a settled turn kept one of its claims');
        }
      }
      return true;
    } else {
      options.onRetry(retryableDependencyRetryAfterMs(err));
      return false;
    }
  }
}

/**
 * A dispatched turn whose observation was already stopped on purpose (the
 * alarm budget, or a code update that superseded this runner) and then failed
 * with an interruption rather than a decided outcome: the platform resets this
 * runner and the objects it reads together, so the reset often surfaces before
 * the yield does. Nothing settled; it is the same yield. Only a recognised
 * interruption qualifies: the platform's reset, a state store disconnect, or a
 * retryable transport failure. Any other error (a bug in this code, a settled
 * failure, a reconciliation requirement) keeps its meaning.
 */
function interruptedAfterYield(
  err: unknown,
  signal: AbortSignal | undefined,
  receipt: FlueDispatchReceiptV1 | undefined,
): boolean {
  if (!signal?.aborted || !receipt) return false;
  if (isPlatformReset(err) || isStateStoreDisconnect(err)) return true;
  return err instanceof AgentPromptFailure && err.retryable && !err.recoveryRequired;
}
