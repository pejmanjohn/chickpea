import { getSlackStateStore, isCloudflareTarget, type PlatformEnv } from '../config/state-backend.ts';
import { runTurn, sanitizeError } from './run-turn.ts';

const NODE_RECONCILE_INTERVAL_MS = 30_000;

let started = false;
let draining: Promise<void> | undefined;

/** Start the independent, unref'ed recovery heartbeat for committed Node jobs. */
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
  draining = drain(env).finally(() => {
    draining = undefined;
  });
  return draining;
}

async function drain(env?: PlatformEnv): Promise<void> {
  const state = getSlackStateStore(env);
  if (
    !state.listPendingTurns ||
    !state.recordTurnAttempt ||
    !state.markTurnDelivered ||
    !state.discardTurn
  ) {
    return;
  }
  const listPendingTurns = state.listPendingTurns.bind(state);
  const recordTurnAttempt = state.recordTurnAttempt.bind(state);
  const markTurnDelivered = state.markTurnDelivered.bind(state);
  const discardTurn = state.discardTurn.bind(state);
  const pending = await listPendingTurns();
  await Promise.all(pending.map(async (job) => {
    const attempt = job.attempts + 1;
    await recordTurnAttempt(job.id, attempt);
    try {
      await runTurn(job.turn, job.assignment, env, {
        turnId: job.id,
        usageExecutionId: `exec:${job.id}:${attempt}`,
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
