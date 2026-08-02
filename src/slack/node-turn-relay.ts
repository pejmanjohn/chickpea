import type { WebClient } from '@slack/web-api';

import {
  getSlackStateStore,
  getWorkStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { SlackStateStore } from './claim-store.ts';
import type { WorkStore } from '../work/types.ts';
import { DurableRunDriver } from '../work/driver.ts';
import {
  createLedgerSlackRunHandler,
  type LedgerSlackTurnExecutor,
} from './ledger-turn-driver.ts';
import {
  getClient,
  repairSlackInteractionProgress,
  runTurn,
  sanitizeError,
} from './run-turn.ts';
import { ContinuityNoticeDeliveryError } from './continuity-notice.ts';
import { AgentPromptFailure } from './flue-dispatch.ts';
import { slackThreadKey } from './thread-key.ts';
import {
  cacheSlackIdentityExecutionContexts,
  effectiveTurnSlackIdentityId,
  normalizeSlackIdentityExecutionError,
  resolveSlackIdentityExecutionContext,
  verifySlackIdentityTurnAccess,
  type SlackIdentityAccessVerifier,
  type SlackIdentityExecutionContext,
  type SlackIdentityExecutionResolver,
} from './identity-execution.ts';
import { MAX_POST_DISPATCH_ATTEMPTS } from './turn-jobs.ts';
import type { SlackPresentationStatePort } from './agent-view-presentation.ts';

const NODE_RECONCILE_INTERVAL_MS = 30_000;
const NODE_RETRY_BACKOFF_MS = 2_000;

let started = false;
let draining: Promise<void> | undefined;
let wakeRequested = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleNodeTurnRelayRetry(
  env: PlatformEnv | undefined,
  delayMs = NODE_RETRY_BACKOFF_MS,
): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void wakeNodeTurnRelay(env);
  }, Math.max(NODE_RETRY_BACKOFF_MS, delayMs));
  retryTimer.unref();
}

/** Start the independent, unref'ed recovery heartbeat for compatibility jobs
 * and the channel-neutral ledger driver. Ledger execution remains default-off
 * until an exact workspace/channel canary assigns future admissions. */
export function startNodeTurnRelay(): void {
  if (started || isCloudflareTarget()) return;
  started = true;
  queueMicrotask(() => {
    void wakeNodeTurnRelay();
  });
  const timer = setInterval(() => {
    void wakeNodeTurnRelay();
  }, NODE_RECONCILE_INTERVAL_MS);
  timer.unref();
}

/** Wake once after admission; concurrent wakes join the same bounded drain. */
export async function wakeNodeTurnRelay(
  env?: PlatformEnv,
  overrides: Omit<NodeTurnRelayDrainOptions, 'env'> = {},
): Promise<void> {
  if (isCloudflareTarget()) return;
  if (draining) {
    wakeRequested = true;
    return draining;
  }
  draining = (async () => {
    do {
      wakeRequested = false;
      await drainNodeTurnRelayOnce({ ...overrides, ...(env ? { env } : {}) });
    } while (wakeRequested);
  })().finally(async () => {
    draining = undefined;
    // A wake can arrive after the loop reads wakeRequested=false but before
    // this completion callback clears `draining`. Do not lose that edge wake.
    if (wakeRequested) await wakeNodeTurnRelay(env, overrides);
  });
  return draining;
}

export interface NodeTurnRelayDrainOptions {
  env?: PlatformEnv;
  /** Test seam for proving the real Node relay wiring without global stores. */
  state?: SlackStateStore;
  work?: WorkStore;
  client?: WebClient;
  /** Focused seam for proving identity isolation and rotation. */
  resolveIdentity?: SlackIdentityExecutionResolver;
  verifyIdentityAccess?: SlackIdentityAccessVerifier;
  executeTurn?: LedgerSlackTurnExecutor;
}

export async function drainNodeTurnRelayOnce(
  options: NodeTurnRelayDrainOptions = {},
): Promise<void> {
  const env = options.env;
  const state = options.state ?? getSlackStateStore(env);
  const executeTurn = options.executeTurn ?? runTurn;
  const shouldResolveIdentity = Boolean(options.resolveIdentity) ||
    (!options.client && !options.executeTurn);
  const resolveIdentity = options.resolveIdentity ??
    ((identityId: string) => resolveSlackIdentityExecutionContext(identityId, env));
  const verifyIdentityAccess = options.verifyIdentityAccess ?? verifySlackIdentityTurnAccess;
  const identityFor = cacheSlackIdentityExecutionContexts(resolveIdentity);
  if (
    state.listPendingTurns &&
    state.freezeRuntimePlan &&
    state.prepareFlueDispatch &&
    state.reconcileFlueExistingInstance &&
    state.recordFlueReceipt &&
    state.recordFlueSettlement &&
    state.recordContinuityNotice &&
    state.matchFlueObservation &&
    state.markTurnRecoveryRequired &&
    state.recordTurnAttempt &&
    state.recordInteractionIntent &&
    state.recordSlackInteractionProgress &&
    state.markTurnDelivered &&
    state.discardTurn
  ) {
    const listPendingTurns = state.listPendingTurns.bind(state);
    const freezeRuntimePlan = state.freezeRuntimePlan.bind(state);
    const prepareFlueDispatch = state.prepareFlueDispatch.bind(state);
    const reconcileFlueExistingInstance = state.reconcileFlueExistingInstance.bind(state);
    const recordFlueReceipt = state.recordFlueReceipt.bind(state);
    const recordFlueSettlement = state.recordFlueSettlement.bind(state);
    const recordContinuityNotice = state.recordContinuityNotice.bind(state);
    const markTurnRecoveryRequired = state.markTurnRecoveryRequired.bind(state);
    const recordTurnAttempt = state.recordTurnAttempt.bind(state);
    const recordInteractionIntent = state.recordInteractionIntent.bind(state);
    const recordSlackInteractionProgress = state.recordSlackInteractionProgress.bind(state);
    const markTurnDelivered = state.markTurnDelivered.bind(state);
    const discardTurn = state.discardTurn.bind(state);
    const presentationState = slackPresentationStatePort(state);
    const pending = await listPendingTurns();
    const runJob = async (job: (typeof pending)[number]): Promise<boolean> => {
      if (!job.turn.interactionIntent && job.progress.interactionIntent) {
        job.turn.interactionIntent = job.progress.interactionIntent;
      }
      let identityContext: SlackIdentityExecutionContext | undefined;
      if (shouldResolveIdentity) {
        try {
          identityContext = await identityFor(effectiveTurnSlackIdentityId(job.turn));
          await verifyIdentityAccess(identityContext, job.turn);
        } catch (error) {
          const unavailable = normalizeSlackIdentityExecutionError(
            error,
            effectiveTurnSlackIdentityId(job.turn),
          );
          if (unavailable.retryable) {
            if (!options.state) {
              scheduleNodeTurnRelayRetry(env, unavailable.retryAfterMs);
            }
            console.warn(
              `[chickpea] Slack identity preflight will retry (${unavailable.reasonCode})`,
            );
            return false;
          }
          await markTurnRecoveryRequired(job.id, 'slack_identity_unavailable');
          if (job.turn.interactionIntent?.disposition === 'work') {
            await state.setActiveWork(slackThreadKey(job.turn), job.id, false);
          }
          return false;
        }
      }
      const attempt = job.attempts + 1;
      let activeWorkKey = job.turn.interactionIntent?.disposition === 'work'
        ? slackThreadKey(job.turn)
        : undefined;
      await recordTurnAttempt(job.id, attempt);
      const flueDispatch = {
        ...(job.dispatchEnvelope ? { dispatchEnvelope: job.dispatchEnvelope } : {}),
        ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {}),
        ...(job.flueSettlement ? { flueSettlement: job.flueSettlement } : {}),
        prepare: (message: string, observation: Parameters<typeof prepareFlueDispatch>[2]) =>
          prepareFlueDispatch(job.id, message, observation),
        reconcileExistingInstance: (uid: string) =>
          reconcileFlueExistingInstance(job.id, uid),
        recordReceipt: (receipt: Parameters<typeof recordFlueReceipt>[1]) =>
          recordFlueReceipt(job.id, receipt),
        recordSettlement: (settlement: Parameters<typeof recordFlueSettlement>[1]) =>
          recordFlueSettlement(job.id, settlement),
        markRecoveryRequired: (reason: string) =>
          markTurnRecoveryRequired(job.id, reason),
      };
      try {
        const runtimePlanDecision = job.runtimePlan && job.agentInstanceId &&
            job.continuityNoticeRequired !== undefined
          ? {
              runtimePlan: job.runtimePlan,
              instanceId: job.agentInstanceId,
              continuityNoticeRequired: job.continuityNoticeRequired,
            }
          : undefined;
        await executeTurn(job.turn, job.assignment, env, {
          ...(identityContext
            ? { client: identityContext.client, identityContext }
            : options.client
              ? { client: options.client }
              : {}),
          turnId: job.id,
          usageExecutionId: `exec:${job.id}:flue`,
          ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
          ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
          onRuntimePlan: (candidate) => freezeRuntimePlan(job.id, candidate),
          flueDispatch,
          ...(presentationState
            ? { presentationState, progressiveAttributionProven: true }
            : {}),
          ...(job.progress.continuityNotice
            ? { continuityNoticeProgress: job.progress.continuityNotice }
            : {}),
          onContinuityNoticeProgress: (notice) =>
            recordContinuityNotice(job.id, notice),
          onInteractionIntent: async (intent) => {
            await recordInteractionIntent(job.id, intent);
            if (intent.disposition !== 'work') return;
            activeWorkKey = slackThreadKey(job.turn);
            await state.setActiveWork(activeWorkKey, job.id, true);
          },
          ...(job.progress.slackInteraction
            ? { interactionProgress: job.progress.slackInteraction }
            : {}),
          onInteractionProgress: (patch) =>
            recordSlackInteractionProgress(job.id, patch),
        });
        await markTurnDelivered(job.id);
        if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
        return true;
      } catch (error) {
        if (error instanceof ContinuityNoticeDeliveryError) {
          if (error.recoveryRequired) {
            await markTurnRecoveryRequired(job.id, 'continuity_notice_delivery_unknown');
          }
          if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
          return false;
        }
        if (flueDispatch.dispatchEnvelope) {
          // The row now owns the only legal redrive: replay the same keyed
          // admission, re-read its receipt, or replay its saved settlement.
          if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
          if (error instanceof AgentPromptFailure && error.recoveryRequired) {
            console.error('[chickpea] node Flue turn requires operator reconciliation');
          } else if (attempt >= MAX_POST_DISPATCH_ATTEMPTS) {
            await markTurnRecoveryRequired(job.id, 'post_dispatch_attempts_exhausted');
            console.error('[chickpea] node Flue turn exhausted durable reattachment attempts');
          } else {
            // Production drains receive an automatic, bounded retry like the
            // Cloudflare alarm. Injected test/store drains stay caller-owned.
            if (!options.state) scheduleNodeTurnRelayRetry(env);
            console.warn('[chickpea] node Flue turn retained for durable reattachment');
          }
          return false;
        }
        // Preserve the established Node contract: a genuine delivery failure
        // releases claims so Slack can redrive; the durable row is terminal.
        await state.release(job.evtKey);
        await state.release(job.msgKey);
        await state.release(`decision:${job.msgKey}`);
        if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
        await discardTurn(job.id);
        console.error('[chickpea] node turn relay failed:', sanitizeError(error));
        return true;
      }
    };
    const groups = new Map<string, typeof pending>();
    for (const job of pending) {
      const key = slackThreadKey(job.turn);
      const jobs = groups.get(key);
      if (jobs) jobs.push(job);
      else groups.set(key, [job]);
    }
    // Preserve ordering within one conversation while allowing unrelated
    // conversations to make progress independently, matching the CF relay.
    await Promise.all([...groups.values()].map(async (jobs) => {
      for (const job of jobs) {
        if (!(await runJob(job))) break;
      }
    }));
  }
  await drainLedgerRuns({
    state,
    work: options.work ?? getWorkStore(env),
    executeTurn,
    ...(options.client ? { client: options.client } : {}),
    ...(shouldResolveIdentity ? { resolveIdentity: identityFor, verifyIdentityAccess } : {}),
    ...(env ? { env } : {}),
  });
  await drainSlackInteractionCleanups(
    state,
    options.client,
    env,
    shouldResolveIdentity ? identityFor : undefined,
    verifyIdentityAccess,
  );
  await state.maintainRunPresentations?.(100);
}

async function drainSlackInteractionCleanups(
  state: SlackStateStore,
  client: WebClient | undefined,
  env: PlatformEnv | undefined,
  resolveIdentity?: SlackIdentityExecutionResolver,
  verifyIdentityAccess: SlackIdentityAccessVerifier = verifySlackIdentityTurnAccess,
): Promise<void> {
  if (!state.listPendingSlackInteractionCleanups || !state.recordSlackInteractionProgress) {
    return;
  }
  const jobs = await state.listPendingSlackInteractionCleanups();
  if (jobs.length === 0) return;
  for (const job of jobs) {
    if (!job.progress.slackInteraction) continue;
    try {
      const identityContext = client || !resolveIdentity
        ? undefined
        : await resolveIdentity(effectiveTurnSlackIdentityId(job.turn));
      if (identityContext) await verifyIdentityAccess(identityContext, job.turn);
      const slack = client ?? identityContext?.client ?? await getClient(env);
      await repairSlackInteractionProgress(
        job.turn,
        job.assignment,
        job.progress.slackInteraction,
        slack,
        (patch) => state.recordSlackInteractionProgress?.(job.id, patch),
      );
    } catch (error) {
      console.warn('[chickpea] Slack interaction cleanup retry failed:', sanitizeError(error));
    }
  }
}

async function drainLedgerRuns(input: {
  state: SlackStateStore;
  work: WorkStore;
  executeTurn: LedgerSlackTurnExecutor;
  client?: WebClient;
  resolveIdentity?: SlackIdentityExecutionResolver;
  verifyIdentityAccess?: SlackIdentityAccessVerifier;
  env?: PlatformEnv;
}): Promise<void> {
  const { state, work } = input;
  if (
    !state.getPendingTurnByRunId ||
    !state.freezeRuntimePlan ||
    !state.prepareFlueDispatch ||
    !state.reconcileFlueExistingInstance ||
    !state.recordFlueReceipt ||
    !state.recordFlueSettlement ||
    !state.recordContinuityNotice ||
    !state.markTurnRecoveryRequired ||
    !state.recordTurnAttempt ||
    !state.recordInteractionIntent ||
    !state.recordSlackInteractionProgress ||
    !state.markTurnDelivered ||
    !state.markTurnError
  ) return;
  const driver = new DurableRunDriver(work, {
    ownerId: 'node_ledger_run_driver',
    authorityEpoch: 1,
    leaseDurationMs: 30_000,
    maxClaims: 4,
    concurrency: 4,
    handle: createLedgerSlackRunHandler({
      work,
      turns: {
        getPendingByRunId: state.getPendingTurnByRunId.bind(state),
        freezeRuntimePlan: state.freezeRuntimePlan.bind(state),
        prepareFlueDispatch: state.prepareFlueDispatch.bind(state),
        reconcileFlueExistingInstance: state.reconcileFlueExistingInstance.bind(state),
        recordFlueReceipt: state.recordFlueReceipt.bind(state),
        recordFlueSettlement: state.recordFlueSettlement.bind(state),
        recordContinuityNotice: state.recordContinuityNotice.bind(state),
        markRecoveryRequired: state.markTurnRecoveryRequired.bind(state),
        recordAttempt: state.recordTurnAttempt.bind(state),
        recordInteractionIntent: state.recordInteractionIntent.bind(state),
        recordSlackInteractionProgress: async (id, patch) => {
          await state.recordSlackInteractionProgress?.(id, patch);
        },
        markDelivered: state.markTurnDelivered.bind(state),
        markError: state.markTurnError.bind(state),
      },
      executeTurn: input.executeTurn,
      ...(slackPresentationStatePort(state)
        ? { presentationState: slackPresentationStatePort(state)! }
        : {}),
      setActiveWork: (key, generation, active) =>
        state.setActiveWork(key, generation, active),
      ...(input.client ? { client: input.client } : {}),
      ...(input.resolveIdentity ? { resolveIdentity: input.resolveIdentity } : {}),
      ...(input.verifyIdentityAccess
        ? { verifyIdentityAccess: input.verifyIdentityAccess }
        : {}),
      ...(input.env ? { platformEnv: input.env } : {}),
    }),
  });
  await driver.drain();
}

function slackPresentationStatePort(
  state: SlackStateStore,
): SlackPresentationStatePort | undefined {
  if (
    !state.getRunPresentation ||
    !state.transitionRunPresentation ||
    !state.reserveSlackAppend ||
    !state.applySlackAppendCooldown ||
    !state.matchFlueObservation
  ) return undefined;
  return {
    getRunPresentation: state.getRunPresentation.bind(state),
    transitionRunPresentation: state.transitionRunPresentation.bind(state),
    reserveSlackAppend: state.reserveSlackAppend.bind(state),
    applySlackAppendCooldown: state.applySlackAppendCooldown.bind(state),
    matchFlueObservation: state.matchFlueObservation.bind(state),
  };
}
