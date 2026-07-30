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
import { runTurn, sanitizeError } from './run-turn.ts';

const NODE_RECONCILE_INTERVAL_MS = 30_000;

let started = false;
let draining: Promise<void> | undefined;

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
export async function wakeNodeTurnRelay(env?: PlatformEnv): Promise<void> {
  if (isCloudflareTarget()) return;
  if (draining) return draining;
  draining = drainNodeTurnRelayOnce({ ...(env ? { env } : {}) }).finally(() => {
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
    state.recordTurnAttempt &&
    state.markTurnDelivered &&
    state.discardTurn
  ) {
    const listPendingTurns = state.listPendingTurns.bind(state);
    const recordTurnAttempt = state.recordTurnAttempt.bind(state);
    const markTurnDelivered = state.markTurnDelivered.bind(state);
    const discardTurn = state.discardTurn.bind(state);
    const pending = await listPendingTurns();
    await Promise.all(pending.map(async (job) => {
      const attempt = job.attempts + 1;
      await recordTurnAttempt(job.id, attempt);
      try {
        await executeTurn(job.turn, job.assignment, env, {
          turnId: job.id,
          usageExecutionId: `exec:${job.id}:${attempt}`,
          ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
        });
        await markTurnDelivered(job.id);
      } catch (error) {
        // Preserve the established Node contract: a genuine delivery failure
        // releases claims so Slack can redrive; the durable row is terminal.
        await state.release(job.evtKey);
        await state.release(job.msgKey);
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
    !state.recordTurnAttempt ||
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
        putAgentExecutionContext: state.putAgentExecutionContext.bind(state),
        recordAttempt: state.recordTurnAttempt.bind(state),
        markDelivered: state.markTurnDelivered.bind(state),
        markError: state.markTurnError.bind(state),
      },
      executeTurn: input.executeTurn,
      ...(input.client ? { client: input.client } : {}),
      ...(input.env ? { platformEnv: input.env } : {}),
    }),
  });
  await driver.drain();
}
