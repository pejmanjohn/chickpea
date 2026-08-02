import { AsyncLocalStorage } from 'node:async_hooks';

import type { FlueExecutionInterceptor } from '@flue/runtime';

import {
  getSlackStateStore,
  getWorkStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { FlueObservationTarget } from '../slack/turn-job-types.ts';
import type { RunExecutionId, WorkStore } from './types.ts';
import type { WorkTraceCorrelation } from './trace-correlation.ts';

interface InvocationState {
  instanceId: string;
  submissionId: string;
  target?: FlueObservationTarget;
  marked: boolean;
  marking?: Promise<void>;
}

export interface ActiveFlueObservationContext {
  instanceId: string;
  submissionId: string;
  target?: FlueObservationTarget;
}

type MarkInvocation = (correlation: WorkTraceCorrelation) => Promise<void>;
type ResolveTarget = (
  instanceId: string,
  submissionId: string,
) => Promise<FlueObservationTarget | undefined>;

const invocationState = new AsyncLocalStorage<InvocationState>();

/** Current model-invisible framework coordinates for safe status observation. */
export function currentFlueObservationContext(): ActiveFlueObservationContext | undefined {
  const active = invocationState.getStore();
  return active
    ? {
        instanceId: active.instanceId,
        submissionId: active.submissionId,
        ...(active.target ? { target: active.target } : {}),
      }
    : undefined;
}

/**
 * Resolve app-owned TurnJob correlation from Flue's instance/submission facts,
 * then persist invocation immediately before the first model operation. No
 * trace header, delivered attribute, or prompt-visible identifier is used.
 */
export function createWorkModelInvocationInterceptor(options: {
  resolveTarget?: ResolveTarget;
  markInvocation?: MarkInvocation;
} = {}): FlueExecutionInterceptor {
  const resolveTarget = options.resolveTarget ?? resolvePersistedObservationTarget;
  const markInvocation = options.markInvocation ?? markPersistedInvocation;
  return async (operation, context, next) => {
    if (operation.type === 'agent') {
      const instanceId = context.instanceId;
      const submissionId = context.submissionId;
      if (!instanceId || !submissionId) return next();
      const target = await resolveTarget(instanceId, submissionId);
      if (context.agentName === 'chickpea-slack-v2' && !target) {
        throw new Error('Slack TurnJob observation correlation is unavailable.');
      }
      return invocationState.run({
        instanceId,
        submissionId,
        ...(target ? { target } : {}),
        marked: false,
      }, next);
    }
    if (operation.type !== 'model') return next();
    const active = invocationState.getStore();
    const correlation = active?.target?.workCorrelation;
    if (!active || !correlation) return next();
    try {
      await ensureInvocationMarked(active, correlation, markInvocation);
    } catch (error) {
      if (correlation.mode === 'enforce') throw error;
      console.warn('[work] model invocation marker unavailable; legacy execution will continue');
    }
    return next();
  };
}

export const workModelInvocationInterceptor = createWorkModelInvocationInterceptor();

async function ensureInvocationMarked(
  state: InvocationState,
  correlation: WorkTraceCorrelation,
  markInvocation: MarkInvocation,
): Promise<void> {
  if (state.marked) return;
  state.marking ??= markInvocation(correlation).then(() => {
    state.marked = true;
  });
  try {
    await state.marking;
  } finally {
    if (!state.marked) delete state.marking;
  }
}

async function resolvePersistedObservationTarget(
  instanceId: string,
  submissionId: string,
): Promise<FlueObservationTarget | undefined> {
  const store = getSlackStateStore(await currentPlatformEnv());
  if (!store.matchFlueObservation) return undefined;
  return store.matchFlueObservation(instanceId, submissionId);
}

async function markPersistedInvocation(correlation: WorkTraceCorrelation): Promise<void> {
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
