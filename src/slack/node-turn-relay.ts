import type { WebClient } from '@slack/web-api';
import { settlementFailureFacts } from './agent-failure-diagnostics.ts';

import {
  getSlackStateStore,
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getSettingsStore,
  getWorkStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  completeAgentWelcomeDelivery,
  completeSettledAgentWelcomeHandoff,
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
  failAgentWelcomeTurn,
  isAgentCreatedWelcome,
} from '../management/receipts.ts';
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
import { AgentPromptFailure } from './flue-dispatch.ts';
import { DURABLE_RECOVERY_FAILURE_TEXT } from './web-client-presenter.ts';
import { slackAgentThreadKey } from './thread-key.ts';
import {
  cacheSlackInstallationExecutionContexts,
  effectiveTurnSlackInstallationId,
  normalizeSlackInstallationExecutionError,
  resolveSlackInstallationExecutionContext,
  verifySlackInstallationTurnAccess,
  type SlackInstallationAccessVerifier,
  type SlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from './installation-execution.ts';
import { recordSlackInstallationUnavailable } from './installation-observability.ts';
import { MAX_POST_DISPATCH_ATTEMPTS } from './turn-jobs.ts';
import { slackPresentationStatePort } from './presentation-state-port.ts';
import { recordDeliveredSlackAgentMessage } from './public-context.ts';
import {
  abandonTerminalSlackPresentationBestEffort,
  postRecoveryNoticeBestEffort,
  drainSlackPresentationRepairs,
} from './presentation-repair.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import { createPlatformProductTelemetry } from '../telemetry/platform.ts';

const NODE_RECONCILE_INTERVAL_MS = 30_000;
const NODE_RETRY_BACKOFF_MS = 2_000;

type NodePendingTurn = Awaited<
  ReturnType<NonNullable<SlackStateStore['listPendingTurns']>>
>[number];

let started = false;
// One ordered loop per Slack Agent thread (`slackAgentThreadKey`). A slow turn
// holds only its own thread; unrelated threads start their own loops.
const threadLoops = new Map<string, Promise<void>>();
// Threads whose active loop must list pending turns again before it exits.
const threadRelistRequested = new Set<string>();
// Ledger runs, cleanups, repairs, and receipts run in one single-flight
// wake-level pass that never waits on thread loops.
let wakePass: Promise<void> | undefined;
let wakePassRequested = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let autoWakeSuspended = false;
let shuttingDown = false;

export { slackPresentationStatePort } from './presentation-state-port.ts';

function scheduleNodeTurnRelayRetry(
  env: PlatformEnv | undefined,
  delayMs = NODE_RETRY_BACKOFF_MS,
): void {
  if (retryTimer || shuttingDown) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void wakeNodeTurnRelay(env);
  }, Math.max(NODE_RETRY_BACKOFF_MS, delayMs));
  retryTimer.unref();
}

/** A store failure must never reject a wake: every caller wakes the relay with
 * `void wakeNodeTurnRelay(...)`, so a rejection would take the Node process
 * down as an unhandled rejection. Log it and hand production drains to the
 * bounded retry timer; injected test/store drains stay caller-owned. */
function reportNodeTurnRelayFailure(
  error: unknown,
  options: NodeTurnRelayDrainOptions,
): void {
  console.error('[chickpea] node turn relay drain failed:', sanitizeError(error));
  if (!options.state) scheduleNodeTurnRelayRetry(options.env);
}

/** Start the independent, unref'ed recovery heartbeat for compatibility jobs
 * and the channel-neutral ledger driver. Ledger execution remains default-off
 * until an exact workspace/channel canary assigns future admissions. */
export function startNodeTurnRelay(): void {
  if (started || isCloudflareTarget()) return;
  shuttingDown = false;
  started = true;
  queueMicrotask(() => {
    void wakeNodeTurnRelay();
  });
  reconcileTimer = setInterval(() => {
    void wakeNodeTurnRelay();
  }, NODE_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

/** Stop new wakes and wait for every thread loop and the wake-level pass
 * before ownership release. Loops finish the turns they already listed. */
export async function stopNodeTurnRelay(): Promise<void> {
  shuttingDown = true;
  started = false;
  wakePassRequested = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = undefined;
  await Promise.all([...threadLoops.values(), wakePass]);
}

/**
 * Wake after admission, on the reconcile heartbeat, and on bounded retry.
 * Lists pending turns, starts a loop for every thread that has none, and
 * requests the wake-level pass. The returned promise settles once the loops
 * this wake started (plus the pass each requests on exit) and the pass this
 * wake started or joined have finished. It never waits for a loop an earlier
 * wake started: that loop re-lists its thread before exiting, so a message
 * admitted mid-turn runs after it without holding other threads. Never rejects.
 */
export async function wakeNodeTurnRelay(
  env?: PlatformEnv,
  overrides: Omit<NodeTurnRelayDrainOptions, 'env'> = {},
): Promise<void> {
  if (isCloudflareTarget()) return;
  if (shuttingDown) return;
  // A test may suspend the admission-triggered wake to drive execution itself.
  // The durable turn is already admitted; it stays pending until the next drain.
  if (autoWakeSuspended) return;
  const options: NodeTurnRelayDrainOptions = { ...overrides, ...(env ? { env } : {}) };
  const loops = await startNodeThreadLoops(options);
  await Promise.all([...loops, requestNodeWakePass(options)]);
}

async function startNodeThreadLoops(
  options: NodeTurnRelayDrainOptions,
): Promise<Promise<void>[]> {
  let drain: NodeThreadDrain;
  let pending: NodePendingTurn[];
  try {
    // Opening the stores can throw on a failed SQLite open; that must reach
    // the retry timer, not reject a `void`-called wake.
    const created = createNodeThreadDrain(options);
    if (!created) return [];
    drain = created;
    pending = await drain.listPendingTurns();
  } catch (error) {
    reportNodeTurnRelayFailure(error, options);
    return [];
  }
  // stopNodeTurnRelay awaits only loops that exist when it runs.
  if (shuttingDown) return [];
  const groups = new Map<string, NodePendingTurn[]>();
  for (const job of pending) {
    const key = slackAgentThreadKey(job.turn, job.assignment);
    const jobs = groups.get(key);
    if (jobs) jobs.push(job);
    else groups.set(key, [job]);
  }
  const startedLoops: Promise<void>[] = [];
  for (const [key, jobs] of groups) {
    if (threadLoops.has(key)) {
      threadRelistRequested.add(key);
      continue;
    }
    const loop = runNodeThreadLoop(key, jobs, drain, options);
    threadLoops.set(key, loop);
    // The combined drain ran cleanups and repairs right after its turns; keep
    // that promptness without making the thread wait for them.
    startedLoops.push(loop.then(() => requestNodeWakePass(options)));
  }
  return startedLoops;
}

/** Run one thread's turns in admission order. A thread never has two loops,
 * and the loop re-lists its thread before exiting so a message admitted
 * during the last turn is not stranded until the reconcile heartbeat. */
async function runNodeThreadLoop(
  key: string,
  initialJobs: NodePendingTurn[],
  initialDrain: NodeThreadDrain,
  options: NodeTurnRelayDrainOptions,
): Promise<void> {
  // A turn that stays pending after running (a deferred terminal) is left to
  // the next wake rather than rerun by this loop.
  const attempted = new Set<string>();
  let drain = initialDrain;
  let jobs = initialJobs;
  try {
    for (;;) {
      for (const job of jobs) {
        attempted.add(job.id);
        // A retained turn holds its thread until a later wake redrives it.
        if (!(await drain.runJob(job))) return;
      }
      if (shuttingDown) return;
      threadRelistRequested.delete(key);
      // A fresh context per cycle, as each combined drain had: installation
      // resolutions are cached for the life of one context.
      const next = createNodeThreadDrain(options);
      if (!next) return;
      drain = next;
      jobs = (await drain.listPendingTurns()).filter((job) =>
        !attempted.has(job.id) && slackAgentThreadKey(job.turn, job.assignment) === key
      );
      if (shuttingDown) return;
      if (jobs.length === 0 && !threadRelistRequested.has(key)) return;
    }
  } catch (error) {
    reportNodeTurnRelayFailure(error, options);
  } finally {
    // Runs in the same tick as the exit decision, so a wake either sees this
    // loop (and requests a re-list) or sees none and starts a new one.
    threadLoops.delete(key);
    threadRelistRequested.delete(key);
  }
}

/** Single-flight wake-level pass; a wake arriving mid-pass joins it and
 * requests one more round, as the combined drain did. */
function requestNodeWakePass(options: NodeTurnRelayDrainOptions): Promise<void> {
  if (wakePass) {
    wakePassRequested = true;
    return wakePass;
  }
  if (shuttingDown) return Promise.resolve();
  wakePass = (async () => {
    try {
      do {
        wakePassRequested = false;
        try {
          await drainNodeWakePassOnce(options);
        } catch (error) {
          // Leave rather than spin on the same failure.
          reportNodeTurnRelayFailure(error, options);
          wakePassRequested = false;
          return;
        }
      } while (wakePassRequested && !shuttingDown);
    } finally {
      // Cleared in the same tick as the exit check, so no edge wake is lost.
      wakePass = undefined;
    }
  })();
  return wakePass;
}

interface NodeTurnRelayDrainOptions {
  env?: PlatformEnv;
  /** Test seam for proving the real Node relay wiring without global stores. */
  state?: SlackStateStore;
  work?: WorkStore;
  client?: WebClient;
  /** Focused seam for proving identity isolation and rotation. */
  resolveInstallation?: SlackInstallationExecutionResolver;
  verifyInstallationAccess?: SlackInstallationAccessVerifier;
  executeTurn?: LedgerSlackTurnExecutor;
  productTelemetry?: ProductTelemetryCapture;
}

function createNodeTurnRelayContext(options: NodeTurnRelayDrainOptions) {
  const env = options.env;
  const state = options.state ?? getSlackStateStore(env);
  const config = getConfigStore(env);
  const executeTurn = options.executeTurn ?? runTurn;
  const productTelemetry = options.productTelemetry ?? (!options.state
    ? createPlatformProductTelemetry({
        ...(env ? { env } : {}),
        settings: getSettingsStore(env),
        config,
      })
    : undefined);
  const shouldResolveIdentity = Boolean(options.resolveInstallation) ||
    (!options.client && !options.executeTurn);
  const resolveInstallation = options.resolveInstallation ??
    ((workspaceId: string) => resolveSlackInstallationExecutionContext(workspaceId, env));
  const verifyInstallationAccess = options.verifyInstallationAccess ?? verifySlackInstallationTurnAccess;
  const installationFor = cacheSlackInstallationExecutionContexts(resolveInstallation);
  return {
    env,
    state,
    config,
    executeTurn,
    productTelemetry,
    shouldResolveIdentity,
    verifyInstallationAccess,
    installationFor,
  };
}

interface NodeThreadDrain {
  listPendingTurns(): Promise<NodePendingTurn[]>;
  /** False when the turn stays pending and its thread must stop here. */
  runJob(job: NodePendingTurn): Promise<boolean>;
}

function createNodeThreadDrain(
  options: NodeTurnRelayDrainOptions,
): NodeThreadDrain | undefined {
  const {
    env,
    state,
    config,
    executeTurn,
    productTelemetry,
    shouldResolveIdentity,
    verifyInstallationAccess,
    installationFor,
  } = createNodeTurnRelayContext(options);
  if (
    state.listPendingTurns &&
    state.freezeRuntimePlan &&
    state.prepareFlueDispatch &&
    state.reconcileFlueExistingInstance &&
    state.recordFlueReceipt &&
    state.recordFlueSettlement &&
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
    const markTurnRecoveryRequired = state.markTurnRecoveryRequired.bind(state);
    const recordTurnAttempt = state.recordTurnAttempt.bind(state);
    const recordInteractionIntent = state.recordInteractionIntent.bind(state);
    const recordSlackInteractionProgress = state.recordSlackInteractionProgress.bind(state);
    const markTurnDelivered = state.markTurnDelivered.bind(state);
    const markTurnError = state.markTurnError?.bind(state);
    const discardTurn = state.discardTurn.bind(state);
    const presentationState = slackPresentationStatePort(state);
    const runJob = async (job: NodePendingTurn): Promise<boolean> => {
      if (!job.turn.interactionIntent && job.progress.interactionIntent) {
        job.turn.interactionIntent = job.progress.interactionIntent;
      }
      let installationContext: SlackInstallationExecutionContext | undefined;
      if (shouldResolveIdentity) {
        try {
          installationContext = await installationFor(effectiveTurnSlackInstallationId(job.turn));
          await verifyInstallationAccess(installationContext, job.turn);
        } catch (error) {
          const unavailable = normalizeSlackInstallationExecutionError(
            error,
            effectiveTurnSlackInstallationId(job.turn),
          );
          recordSlackInstallationUnavailable(unavailable);
          if (unavailable.retryable) {
            if (!options.state) {
              scheduleNodeTurnRelayRetry(env, unavailable.retryAfterMs);
            }
            console.warn(
              `[chickpea] Slack installation preflight will retry (${unavailable.reasonCode})`,
            );
            return false;
          }
          await markTurnRecoveryRequired(job.id, 'slack_installation_unavailable');
          if (job.turn.interactionIntent?.disposition === 'work') {
            await state.setActiveWork(slackAgentThreadKey(job.turn, job.assignment), job.id, false);
          }
          return false;
        }
      }
      const attempt = job.attempts + 1;
      let deferredTerminal = false;
      let terminalDelivered = false;
      let activeWorkKey = job.turn.interactionIntent?.disposition === 'work'
        ? slackAgentThreadKey(job.turn, job.assignment)
        : undefined;
      await recordTurnAttempt(job.id, attempt);
      const flueDispatch = {
        ...(job.dispatchEnvelope ? { dispatchEnvelope: job.dispatchEnvelope } : {}),
        ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {}),
        ...(job.flueSettlement ? { flueSettlement: job.flueSettlement } : {}),
        prepare: (
          message: string,
          observation: Parameters<typeof prepareFlueDispatch>[2],
          threadImages: Parameters<typeof prepareFlueDispatch>[3],
          admittedListIds: Parameters<typeof prepareFlueDispatch>[4],
          turnEnvelope: Parameters<typeof prepareFlueDispatch>[5],
        ) => prepareFlueDispatch(job.id, message, observation, threadImages, admittedListIds, turnEnvelope),
        reconcileExistingInstance: (uid: string) =>
          reconcileFlueExistingInstance(job.id, uid),
        recordReceipt: (receipt: Parameters<typeof recordFlueReceipt>[1]) =>
          recordFlueReceipt(job.id, receipt),
        recordSettlement: (settlement: Parameters<typeof recordFlueSettlement>[1]) =>
          recordFlueSettlement(job.id, settlement),
        markRecoveryRequired: (reason: string) =>
          markTurnRecoveryRequired(job.id, reason),
      };
      const turnLatency = {
        ...(job.enqueuedAt === undefined ? {} : { admittedAt: job.enqueuedAt }),
        ...(job.receivedAt === undefined ? {} : { receivedAt: job.receivedAt }),
        lane: 'node',
        executor: 'node',
      } as const;
      const deliverRecoveryFailure = async (reasonCode: string): Promise<boolean> => {
        try {
          await executeTurn(job.turn, job.assignment, env, {
            ...(installationContext
              ? { client: installationContext.client, installationContext }
              : options.client
                ? { client: options.client }
                : {}),
            turnId: job.id,
            ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
            turnLatency,
            ...(presentationState ? { presentationState } : {}),
            replayText: DURABLE_RECOVERY_FAILURE_TEXT,
            replayTerminalResult: 'failure',
            onPublicMessageDelivered: (delivery) =>
              recordDeliveredSlackAgentMessage(config, job.turn, job.assignment, delivery),
            onDelivered: async () => {
              if (markTurnError) await markTurnError(job.id);
              else await markTurnDelivered(job.id);
              if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
            },
          });
          return true;
        } catch {
          // Same contract as the Cloudflare relay: the recovery notice shares
          // the run's V3 presentation, so an unresolved terminal makes this
          // replay throw too. Abandon it so durable repair can suspend the
          // Agent Session and clear the visible activity status.
          console.error('[chickpea] node durable recovery final failed:', { reasonCode });
          const recoveryClient = installationContext?.client ?? options.client;
          if (job.runId && recoveryClient) {
            await abandonTerminalSlackPresentationBestEffort({
              runId: job.runId,
              state: presentationState,
              client: recoveryClient,
              requireUnresolvedDelivery: true,
            });
          }
          // The thread must not end on a truncated prefix with no word.
          if (recoveryClient) {
            await postRecoveryNoticeBestEffort({
              client: recoveryClient,
              state: presentationState,
              ...(job.runId ? { runId: job.runId } : {}),
              turnId: job.id,
              channelId: job.turn.channelId,
              threadTs: job.turn.threadTs,
            });
          }
          await markTurnRecoveryRequired(job.id, reasonCode);
          if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
          return false;
        }
      };
      try {
        const runtimePlanDecision = job.runtimePlan && job.agentInstanceId
          ? {
              runtimePlan: job.runtimePlan,
              instanceId: job.agentInstanceId,
            }
          : undefined;
        await executeTurn(job.turn, job.assignment, env, {
          ...(installationContext
            ? { client: installationContext.client, installationContext }
            : options.client
              ? { client: options.client }
              : {}),
          turnId: job.id,
          usageExecutionId: `exec:${job.id}:flue`,
          ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
          turnLatency,
          ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
          onRuntimePlan: (candidate) => freezeRuntimePlan(job.id, candidate),
          ...(state.getBoundRuntimePlan ? { getBoundRuntimePlan: state.getBoundRuntimePlan.bind(state) } : {}),
          flueDispatch,
          ...(presentationState
            ? { presentationState, progressiveAttributionProven: true }
            : {}),
          onInteractionIntent: async (intent) => {
            await recordInteractionIntent(job.id, intent);
            if (intent.disposition !== 'work') return;
            activeWorkKey = slackAgentThreadKey(job.turn, job.assignment);
            await state.setActiveWork(activeWorkKey, job.id, true);
          },
          ...(job.progress.slackInteraction
            ? { interactionProgress: job.progress.slackInteraction }
            : {}),
          onInteractionProgress: (patch) =>
            recordSlackInteractionProgress(job.id, patch),
          onPublicMessageDelivered: (delivery) =>
            recordDeliveredSlackAgentMessage(config, job.turn, job.assignment, delivery),
          onDeferredTerminal: async () => {
            deferredTerminal = true;
            if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
          },
          onDelivered: async (outcome) => {
            await markTurnDelivered(job.id);
            terminalDelivered = true;
            if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
            if (outcome) {
              productTelemetry?.capture({
                event: 'run_completed',
                workspaceId: job.turn.workspaceId,
                agentId: job.assignment.agentId,
                triggerKind: 'interactive',
                outcome,
              });
            }
          },
        });
        if (deferredTerminal) return true;
        if (!terminalDelivered) await markTurnDelivered(job.id);
        if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
        return true;
      } catch (error) {
        if (flueDispatch.dispatchEnvelope) {
          console.error('[chickpea] durable reattachment failed:', {
            causes: settlementFailureFacts(error),
          });
          // The row now owns the only legal redrive: replay the same keyed
          // admission, re-read its receipt, or replay its saved settlement.
          if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
          if (error instanceof AgentPromptFailure && error.recoveryRequired) {
            console.error('[chickpea] node Flue turn requires operator reconciliation');
            return deliverRecoveryFailure('flue_dispatch_reconciliation_required');
          } else if (attempt >= MAX_POST_DISPATCH_ATTEMPTS) {
            console.error('[chickpea] node Flue turn exhausted durable reattachment attempts');
            return deliverRecoveryFailure('post_dispatch_attempts_exhausted');
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
    return { listPendingTurns, runJob };
  }
  return undefined;
}

/** Ledger runs, interaction cleanups, presentation repairs, and management
 * receipts. Runs once per wake request and never waits on thread loops. */
async function drainNodeWakePassOnce(options: NodeTurnRelayDrainOptions): Promise<void> {
  const {
    env,
    state,
    executeTurn,
    productTelemetry,
    shouldResolveIdentity,
    verifyInstallationAccess,
    installationFor,
  } = createNodeTurnRelayContext(options);
  await drainLedgerRuns({
    state,
    work: options.work ?? getWorkStore(env),
    executeTurn,
    ...(options.client ? { client: options.client } : {}),
    ...(shouldResolveIdentity ? { resolveInstallation: installationFor, verifyInstallationAccess } : {}),
    ...(env ? { env } : {}),
    ...(productTelemetry ? { productTelemetry } : {}),
  });
  await drainSlackInteractionCleanups(
    state,
    options.client,
    env,
    shouldResolveIdentity ? installationFor : undefined,
    verifyInstallationAccess,
  );
  await drainPresentationRepairs(
    state,
    options.client,
    env,
    shouldResolveIdentity ? installationFor : undefined,
  );
  await state.maintainRunPresentations?.(100);
  if (!options.state) {
    const identity = getIdentityStore(env);
    const config = getConfigStore(env);
    const presentationState = slackPresentationStatePort(state);
    const presentation = presentationState
      ? {
          state: presentationState,
          resolveClient: async (workspaceId: string) =>
            (await installationFor(workspaceId)).client,
        }
      : undefined;
    await drainManagementReceiptOutbox({
      management: getManagementStore(env),
      onDeliveredSettled: (record) => completeSettledAgentWelcomeHandoff(
        record,
        config,
        getManagementStore(env),
      ),
      onTerminalFailure: (record) => failAgentWelcomeTurn(
        record,
        presentation,
        (turnJobId) => state.markTurnError
          ? state.markTurnError(turnJobId)
          : state.markTurnDelivered?.(turnJobId),
      ),
      deliver: (record) => deliverManagementReceiptToSlack(record, {
        identity,
        ...(env ? { env } : {}),
        onDelivered: async (deliveredRecord, delivery) => {
          try {
            await completeAgentWelcomeDelivery(
              deliveredRecord,
              delivery,
              config,
              presentation,
            );
          } finally {
            if (isAgentCreatedWelcome(deliveredRecord.receipt) &&
                deliveredRecord.receipt.turnJobId) {
              await state.markTurnDelivered?.(deliveredRecord.receipt.turnJobId);
            }
          }
        },
      }),
    }).catch(() => undefined);
  }
}

async function drainPresentationRepairs(
  state: SlackStateStore,
  client: WebClient | undefined,
  env: PlatformEnv | undefined,
  resolveInstallation?: SlackInstallationExecutionResolver,
): Promise<void> {
  const presentationState = slackPresentationStatePort(state);
  if (!state.listRunPresentationsForRepair || !presentationState) return;
  const presentations = (await state.listRunPresentationsForRepair())
    .filter((presentation) => presentation.schemaVersion === 3);
  await drainSlackPresentationRepairs({
    presentations,
    state: presentationState,
    resolveClient: async (workspaceId) => {
      if (client) return client;
      if (resolveInstallation) return (await resolveInstallation(workspaceId)).client;
      return getClient(env);
    },
    onFailure: (_presentation, error) => {
      console.warn('[chickpea] Slack presentation repair failed:', sanitizeError(error));
    },
  });
}

async function drainSlackInteractionCleanups(
  state: SlackStateStore,
  client: WebClient | undefined,
  env: PlatformEnv | undefined,
  resolveInstallation?: SlackInstallationExecutionResolver,
  verifyInstallationAccess: SlackInstallationAccessVerifier = verifySlackInstallationTurnAccess,
): Promise<void> {
  if (!state.listPendingSlackInteractionCleanups || !state.recordSlackInteractionProgress) {
    return;
  }
  const jobs = await state.listPendingSlackInteractionCleanups();
  if (jobs.length === 0) return;
  for (const job of jobs) {
    if (!job.progress.slackInteraction) continue;
    try {
      const installationContext = client || !resolveInstallation
        ? undefined
        : await resolveInstallation(effectiveTurnSlackInstallationId(job.turn));
      if (installationContext) await verifyInstallationAccess(installationContext, job.turn);
      const slack = client ?? installationContext?.client ?? await getClient(env);
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
  resolveInstallation?: SlackInstallationExecutionResolver;
  verifyInstallationAccess?: SlackInstallationAccessVerifier;
  env?: PlatformEnv;
  productTelemetry?: ProductTelemetryCapture;
}): Promise<void> {
  const { state, work } = input;
  if (
    !state.getPendingTurnByRunId ||
    !state.freezeRuntimePlan ||
    !state.prepareFlueDispatch ||
    !state.reconcileFlueExistingInstance ||
    !state.recordFlueReceipt ||
    !state.recordFlueSettlement ||
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
        ...(state.getBoundRuntimePlan ? { getBoundRuntimePlan: state.getBoundRuntimePlan.bind(state) } : {}),
        prepareFlueDispatch: state.prepareFlueDispatch.bind(state),
        reconcileFlueExistingInstance: state.reconcileFlueExistingInstance.bind(state),
        recordFlueReceipt: state.recordFlueReceipt.bind(state),
        recordFlueSettlement: state.recordFlueSettlement.bind(state),
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
      onPublicMessageDelivered: (turn, assignment, delivery) =>
        recordDeliveredSlackAgentMessage(
          getConfigStore(input.env),
          turn,
          assignment,
          delivery,
        ),
      ...(input.client ? { client: input.client } : {}),
      ...(input.resolveInstallation ? { resolveInstallation: input.resolveInstallation } : {}),
      ...(input.verifyInstallationAccess
        ? { verifyInstallationAccess: input.verifyInstallationAccess }
        : {}),
      ...(input.env ? { platformEnv: input.env } : {}),
      ...(input.productTelemetry ? { productTelemetry: input.productTelemetry } : {}),
    }),
  });
  await driver.drain();
}
