import { AsyncLocalStorage } from 'node:async_hooks';

import type { FlueExecutionInterceptor } from '@flue/runtime';

import {
  getWorkStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { RunExecutionId, WorkStore } from './types.ts';
import {
  workTraceCorrelationFromState,
  type WorkTraceCorrelation,
} from './trace-correlation.ts';

interface InvocationState {
  correlation: WorkTraceCorrelation;
  marked: boolean;
  marking?: Promise<void>;
}

type MarkInvocation = (correlation: WorkTraceCorrelation) => Promise<void>;

const invocationState = new AsyncLocalStorage<InvocationState>();

/**
 * Restore canonical Work correlation at Flue's durable Agent boundary, then
 * persist invocation immediately before the first model operation. Agent
 * initialization, live policy, sandbox preparation, and provider selection all
 * happen before this seam, so their failures remain provably not submitted.
 */
export function createWorkModelInvocationInterceptor(
  markInvocation: MarkInvocation = markPersistedInvocation,
): FlueExecutionInterceptor {
  return async (operation, context, next) => {
    if (operation.type === 'agent') {
      const correlation = workTraceCorrelationFromState(
        context.traceCarrier?.tracestate,
      );
      return correlation
        ? invocationState.run({ correlation, marked: false }, next)
        : next();
    }
    if (operation.type !== 'model') return next();
    const active = invocationState.getStore();
    if (!active) return next();
    try {
      await ensureInvocationMarked(active, markInvocation);
    } catch (error) {
      if (active.correlation.mode === 'enforce') throw error;
      console.warn('[work] model invocation marker unavailable; legacy execution will continue');
    }
    return next();
  };
}

export const workModelInvocationInterceptor = createWorkModelInvocationInterceptor();

async function ensureInvocationMarked(
  state: InvocationState,
  markInvocation: MarkInvocation,
): Promise<void> {
  if (state.marked) return;
  state.marking ??= markInvocation(state.correlation).then(() => {
    state.marked = true;
  });
  try {
    await state.marking;
  } finally {
    if (!state.marked) delete state.marking;
  }
}

async function markPersistedInvocation(
  correlation: WorkTraceCorrelation,
): Promise<void> {
  const store = getWorkStore(await currentPlatformEnv());
  await markWorkModelInvocation(store, correlation);
}

export async function markWorkModelInvocation(
  store: WorkStore,
  correlation: WorkTraceCorrelation,
  invokedAt = Date.now(),
): Promise<void> {
  const execution = await store.getRunExecution(
    correlation.runExecutionId as RunExecutionId,
  );
  if (!execution || execution.runId !== correlation.runId) {
    throw new Error('Canonical RunExecution correlation is unavailable.');
  }
  await store.markRunExecutionInvoked({
    executionId: execution.id,
    fencingToken: execution.fencingToken,
    invokedAt,
  });
}

async function currentPlatformEnv(): Promise<PlatformEnv | undefined> {
  if (!isCloudflareTarget()) return undefined;
  const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
  return getCloudflareContext().env as PlatformEnv;
}
