import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  FlueExecutionContext,
  FlueExecutionInterceptor,
} from '@flue/runtime';

import type { ActivityStatus } from '../activity/status.ts';
import { setObservedSlackStatus } from './status-registry.ts';
import { relayObservedStatus } from './status-relay.ts';

interface PendingRelay {
  text: string;
  env?: Record<string, unknown>;
}

interface RelayQueue {
  active: { text: string } | undefined;
  pending: PendingRelay | undefined;
}

// The agent DO can emit several observations before the preceding state-DO RPC
// returns. Keep one active relay and only the newest pending safe status so the
// cross-isolate path cannot replay an arbitrarily long stale queue.
const relayQueues = new Map<string, Map<string, RelayQueue>>();
const activityStatusGeneration = new AsyncLocalStorage<string>();

const ACTIVITY_STATUS_TRACESTATE_KEY = 'chickpea-status';
const WORK_RUN_TRACESTATE_KEY = 'chickpea-run';
const WORK_EXECUTION_TRACESTATE_KEY = 'chickpea-exec';

/**
 * Encode the application-owned turn generation into Flue's persisted trace
 * carrier. Flue replaces the original HTTP request with a synthetic request
 * while executing a durable submission, but preserves traceparent/tracestate.
 */
export function activityStatusTraceHeaders(
  generation: string,
  correlation: { runId: string; runExecutionId: string } | undefined = undefined,
): {
  traceparent: string;
  tracestate: string;
} {
  const traceId = crypto.randomUUID().replaceAll('-', '');
  const spanId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    tracestate: [
      `${ACTIVITY_STATUS_TRACESTATE_KEY}=${encodeURIComponent(generation)}`,
      ...(correlation
        ? [
            `${WORK_RUN_TRACESTATE_KEY}=${encodeURIComponent(correlation.runId)}`,
            `${WORK_EXECUTION_TRACESTATE_KEY}=${encodeURIComponent(correlation.runExecutionId)}`,
          ]
        : []),
    ].join(','),
  };
}

/** Restore the persisted generation around Flue's complete agent execution. */
export const activityStatusGenerationInterceptor: FlueExecutionInterceptor =
  async (_operation, context, next) => {
    const generation = generationFromExecutionContext(context);
    return generation
      ? activityStatusGeneration.run(generation, next)
      : next();
  };

/**
 * Publish one already-sanitized activity update to the live Slack turn. Node
 * reaches the in-isolate registry directly; Cloudflare relays the same safe
 * text from the agent DO to the state DO that owns the turn presenter.
 */
export function publishActivityStatus(
  instanceId: string,
  status: ActivityStatus,
  env?: Record<string, unknown>,
): void {
  const generation = activityStatusGeneration.getStore();
  if (!generation) {
    return;
  }
  if (setObservedSlackStatus(instanceId, generation, status)) {
    return;
  }

  const instanceQueues = relayQueues.get(instanceId) ?? new Map<string, RelayQueue>();
  relayQueues.set(instanceId, instanceQueues);
  const queue = instanceQueues.get(generation) ?? {
    active: undefined,
    pending: undefined,
  };
  instanceQueues.set(generation, queue);
  if (queue.active?.text === status.text) {
    // The in-flight value is already the newest requested state.
    queue.pending = undefined;
    return;
  }
  if (queue.pending?.text === status.text) {
    return;
  }
  queue.pending = { text: status.text, ...(env ? { env } : {}) };
  startNextRelay(instanceId, generation, queue);
}

function startNextRelay(instanceId: string, generation: string, queue: RelayQueue): void {
  if (queue.active || !queue.pending) return;

  const next = queue.pending;
  queue.pending = undefined;
  const result = relayObservedStatus(instanceId, generation, next.text, next.env).catch(
    () => undefined,
  );
  const active = { text: next.text };
  queue.active = active;
  void result.then(() => {
    if (queue.active === active) {
      queue.active = undefined;
    }
    if (queue.pending) {
      startNextRelay(instanceId, generation, queue);
    } else if (!queue.active) {
      const instanceQueues = relayQueues.get(instanceId);
      if (instanceQueues?.get(generation) === queue) {
        instanceQueues.delete(generation);
        if (instanceQueues.size === 0) {
          relayQueues.delete(instanceId);
        }
      }
    }
  });
}

function generationFromExecutionContext(
  context: FlueExecutionContext,
): string | undefined {
  const tracestate = context.traceCarrier?.tracestate;
  if (!tracestate) return undefined;
  for (const entry of tracestate.split(',')) {
    const [key, encoded] = entry.trim().split('=', 2);
    if (key !== ACTIVITY_STATUS_TRACESTATE_KEY || !encoded) continue;
    try {
      const generation = decodeURIComponent(encoded);
      return generation || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
