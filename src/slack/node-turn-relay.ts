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
import { slackThreadKey } from './thread-key.ts';

const NODE_RECONCILE_INTERVAL_MS = 30_000;

let started = false;
let draining: Promise<void> | undefined;
let wakeRequested = false;

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
  })().finally(() => {
    draining = undefined;
  });
  return draining;
}

export interface NodeTurnRelayDrainOptions {
  env?: PlatformEnv;
  /** Test seam for proving the real Node relay wiring without global stores. */
  state?: SlackStateStore;
  work?: WorkStore;
  client?: WebClient;
  executeTurn?: LedgerSlackTurnExecutor;
}

export async function drainNodeTurnRelayOnce(
  options: NodeTurnRelayDrainOptions = {},
): Promise<void> {
  const env = options.env;
  const state = options.state ?? getSlackStateStore(env);
  const executeTurn = options.executeTurn ?? runTurn;
  if (
    state.listPendingTurns &&
    state.freezeRuntimePlan &&
    state.recordTurnAttempt &&
    state.recordInteractionIntent &&
    state.recordSlackInteractionProgress &&
    state.markTurnDelivered &&
    state.discardTurn
  ) {
    const listPendingTurns = state.listPendingTurns.bind(state);
    const freezeRuntimePlan = state.freezeRuntimePlan.bind(state);
    const recordTurnAttempt = state.recordTurnAttempt.bind(state);
    const recordInteractionIntent = state.recordInteractionIntent.bind(state);
    const recordSlackInteractionProgress = state.recordSlackInteractionProgress.bind(state);
    const markTurnDelivered = state.markTurnDelivered.bind(state);
    const discardTurn = state.discardTurn.bind(state);
    const pending = await listPendingTurns();
    await Promise.all(pending.map(async (job) => {
      if (!job.turn.interactionIntent && job.progress.interactionIntent) {
        job.turn.interactionIntent = job.progress.interactionIntent;
      }
      const attempt = job.attempts + 1;
      let activeWorkKey = job.turn.interactionIntent?.disposition === 'work'
        ? slackThreadKey(job.turn)
        : undefined;
      await recordTurnAttempt(job.id, attempt);
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
          turnId: job.id,
          usageExecutionId: `exec:${job.id}:${attempt}`,
          ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
          ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
          onRuntimePlan: (candidate) => freezeRuntimePlan(job.id, candidate),
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
      } catch (error) {
        // Preserve the established Node contract: a genuine delivery failure
        // releases claims so Slack can redrive; the durable row is terminal.
        await state.release(job.evtKey);
        await state.release(job.msgKey);
        await state.release(`decision:${job.msgKey}`);
        if (activeWorkKey) await state.setActiveWork(activeWorkKey, job.id, false);
        await discardTurn(job.id);
        console.error('[chickpea] node turn relay failed:', sanitizeError(error));
      }
    }));
  }
  await drainLedgerRuns({
    state,
    work: options.work ?? getWorkStore(env),
    executeTurn,
    ...(options.client ? { client: options.client } : {}),
    ...(env ? { env } : {}),
  });
  await drainSlackInteractionCleanups(state, options.client, env);
}

async function drainSlackInteractionCleanups(
  state: SlackStateStore,
  client: WebClient | undefined,
  env: PlatformEnv | undefined,
): Promise<void> {
  if (!state.listPendingSlackInteractionCleanups || !state.recordSlackInteractionProgress) {
    return;
  }
  const jobs = await state.listPendingSlackInteractionCleanups();
  if (jobs.length === 0) return;
  const slack = client ?? await getClient(env);
  for (const job of jobs) {
    if (!job.progress.slackInteraction) continue;
    try {
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
  env?: PlatformEnv;
}): Promise<void> {
  const { state, work } = input;
  if (
    !state.getPendingTurnByRunId ||
    !state.freezeRuntimePlan ||
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
        recordAttempt: state.recordTurnAttempt.bind(state),
        recordInteractionIntent: state.recordInteractionIntent.bind(state),
        recordSlackInteractionProgress: async (id, patch) => {
          await state.recordSlackInteractionProgress?.(id, patch);
        },
        markDelivered: state.markTurnDelivered.bind(state),
        markError: state.markTurnError.bind(state),
      },
      executeTurn: input.executeTurn,
      setActiveWork: (key, generation, active) =>
        state.setActiveWork(key, generation, active),
      ...(input.client ? { client: input.client } : {}),
      ...(input.env ? { platformEnv: input.env } : {}),
    }),
  });
  await driver.drain();
}
