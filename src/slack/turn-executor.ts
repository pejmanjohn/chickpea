import { runtimePlanHasCodingWorkspace } from '../agents/runtime-plan.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { AppStores, PlatformEnv } from '../config/state-backend.ts';
import type { TurnProgress } from '../config/state-rpc.ts';
import type { TurnLatencyContext } from '../observability/runtime-latency.ts';
import { sandboxThreadKey } from '../sandbox/thread-key.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import type { UsageStore } from '../usage/types.ts';
import type { WorkStore } from '../work/types.ts';
import { settlementFailureFacts } from './agent-failure-diagnostics.ts';
import type { SlackPresentationStatePort } from './agent-view-presentation.ts';
import { alarmYieldIsFree, type AlarmTurnJobControl } from './alarm-turn-drain.ts';
import type { SlackStateLogic } from './claim-store.ts';
import { AgentObservationYield, AgentPromptFailure } from './flue-dispatch.ts';
import {
  effectiveTurnSlackInstallationId,
  normalizeSlackInstallationExecutionError,
  verifySlackInstallationTurnAccess,
  type SlackInstallationExecutionContext,
} from './installation-execution.ts';
import { recordSlackInstallationUnavailable } from './installation-observability.ts';
import { abandonTerminalSlackPresentationBestEffort } from './presentation-repair.ts';
import { recordDeliveredSlackAgentMessage } from './public-context.ts';
import {
  deliverAgentFailureFinal,
  sanitizeError,
  type runTurn,
  type RunTurnOptions,
} from './run-turn.ts';
import type { ThreadImageRecord } from './thread-images.ts';
import { slackAgentThreadKey } from './thread-key.ts';
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

/**
 * Everything one durable turn job touches while it runs, as ports. The
 * shared state owner's alarm passes its own stores today; a per-thread runner
 * can pass its own presentation state and forward the rest to the owner.
 */
export interface TurnExecutionPorts {
  env: PlatformEnv;
  turnJobs: Pick<
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
  >;
  /** Slack claims and the per-thread active-work flag. */
  slack: Pick<
    SlackStateLogic,
    'setActiveWork' | 'markCodingActiveWork' | 'isCodingActiveWork' | 'release'
  >;
  /** Thread context for every Agent message the turn delivers. */
  config: Parameters<typeof recordDeliveredSlackAgentMessage>[0];
  presentationState: SlackPresentationStatePort;
  settingsStore: SettingsStore;
  usageStore: UsageStore;
  workStore: WorkStore;
  appStores: AppStores;
  managementApproval: NonNullable<RunTurnOptions['managementApproval']>;
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
  /** Present when the caller can stop observation (a yield, not a failure). */
  control?: AlarmTurnJobControl;
  /**
   * The job stays pending and should be driven again soon; `afterMs` is the
   * least delay an unavailable installation asked for.
   */
  onRetry(afterMs?: number): void;
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
      options.onRetry(unavailable.retryAfterMs ?? 0);
      console.warn(
        `[chickpea] Slack installation preflight will retry (${unavailable.reasonCode})`,
      );
      return false;
    }
    ports.turnJobs.markRecoveryRequired(job.id, 'slack_installation_unavailable');
    if (job.turn.interactionIntent?.disposition === 'work') {
      ports.slack.setActiveWork(
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
  ports.turnJobs.recordAttempt(job.id, attempt);
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
      job.id, message, observation, threadImages, admittedListIds, turnEnvelope,
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
        settingsStore: ports.settingsStore,
        presentationState,
        replayText: DURABLE_RECOVERY_FAILURE_TEXT,
        replayTerminalResult: 'failure',
        onPublicMessageDelivered: (delivery) =>
          recordDeliveredSlackAgentMessage(
            ports.config, job.turn, job.assignment, delivery,
          ),
        onDelivered: () => {
          ports.turnJobs.markError(job.id);
          if (activeWorkKey) ports.slack.setActiveWork(activeWorkKey, job.id, false);
          delivered = true;
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
      ports.turnJobs.markRecoveryRequired(job.id, reasonCode);
      if (activeWorkKey) ports.slack.setActiveWork(activeWorkKey, job.id, false);
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
            ports.turnJobs.recordPullRequest(job.id, progress.pullRequest);
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
      workStore: ports.workStore,
      settingsStore: ports.settingsStore,
      usageStore: ports.usageStore,
      appStores: ports.appStores,
      managementApproval: ports.managementApproval,
      ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
      onRuntimePlan: (candidate) => {
        const decision = ports.turnJobs.freezeRuntimePlan(job.id, candidate);
        frozenPlan = decision.runtimePlan;
        return decision;
      },
      getBoundRuntimePlan: (...args) => ports.turnJobs.getBoundRuntimePlan(...args),
      flueDispatch,
      presentationState,
      progressiveAttributionProven: true,
      onUsagePersistence: (event) => {
        ports.turnJobs.recordUsagePersistence(job.id, event);
      },
      onInteractionIntent: (intent) => {
        ports.turnJobs.recordInteractionIntent(job.id, intent);
        if (intent.disposition !== 'work') return;
        activeWorkKey = slackAgentThreadKey(job.turn, job.assignment);
        ports.slack.setActiveWork(activeWorkKey, job.id, true);
      },
      onCodingTaskStarted: () => {
        if (activeWorkKey) ports.slack.markCodingActiveWork(activeWorkKey, job.id);
      },
      ...(reattaching && activeWorkKey && ports.slack.isCodingActiveWork(activeWorkKey, job.id)
        ? { codingTaskStarted: true }
        : {}),
      ...(job.progress.slackInteraction
        ? { interactionProgress: job.progress.slackInteraction }
        : {}),
      onInteractionProgress: (patch) => {
        ports.turnJobs.recordSlackInteractionProgress(job.id, patch);
      },
      onPublicMessageDelivered: (delivery) =>
        recordDeliveredSlackAgentMessage(ports.config, job.turn, job.assignment, delivery),
      ...(replayText === undefined ? {} : { replayText }),
      beforeDelivery: persistSandboxProgress,
      // Record terminal delivery before runTurn's post-delivery Sandbox
      // turn close. A hung control-plane call must never leave an
      // already-posted Slack final eligible for relay retry.
      onDelivered: (outcome) => {
        ports.turnJobs.markDelivered(job.id);
        if (activeWorkKey) ports.slack.setActiveWork(activeWorkKey, job.id, false);
        delivered = true;
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
      onDeferredTerminal: () => {
        deferredTerminal = true;
        if (activeWorkKey) ports.slack.setActiveWork(activeWorkKey, job.id, false);
      },
    });
    if (deferredTerminal) return true;
    // Delivery was tombstoned at the exact presentation boundary above.
    // Claims stay held — a completed turn never re-runs.
    return true;
  } catch (err) {
    if (err instanceof AgentObservationYield) {
      if (alarmYieldIsFree(flueDispatch.dispatchReceipt?.acceptedAt, Date.now())) {
        // The alarm stopped observing on purpose; nothing failed. Restore
        // the attempt count so a long turn never spends its reattachment
        // budget on yields, and keep its receipt, active work, and claims.
        ports.turnJobs.recordAttempt(job.id, job.attempts);
        console.info('[chickpea] Flue turn yielded for reattachment by the next alarm');
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
    // Any failure after the terminal presentation boundary is cleanup,
    // not a failed turn. The durable tombstone prevents a duplicate final;
    // keep the claims held and let a later thread turn start normally.
    if (delivered) {
      console.warn('[chickpea] post-delivery cleanup did not complete');
      return true;
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
        options.onRetry();
      }
      if (activeWorkKey) ports.slack.setActiveWork(activeWorkKey, job.id, false);
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
      ports.slack.release(job.evtKey);
      ports.slack.release(job.msgKey);
      ports.slack.release(`decision:${job.msgKey}`);
      if (activeWorkKey) ports.slack.setActiveWork(activeWorkKey, job.id, false);
      ports.turnJobs.markError(job.id);
      return true;
    } else {
      options.onRetry();
      return false;
    }
  }
}
