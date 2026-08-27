import {
  isSafeTypedActivityStatus,
  type ActivityStatus,
  type TypedActivityStatus,
} from '../activity/status.ts';
import { emitSemanticActivityTelemetry } from '../activity/telemetry.ts';
import { currentFlueObservationContext } from '../work/model-invocation.ts';
import { setObservedSlackStatus } from './status-registry.ts';
import { relayObservedStatus } from './status-relay.ts';

interface PendingRelay {
  status: TypedActivityStatus;
  env?: Record<string, unknown>;
}

interface RelayQueue {
  active: { status: TypedActivityStatus } | undefined;
  pending: PendingRelay | undefined;
}

// The agent DO can emit several observations before the preceding state-DO RPC
// returns. Keep one active relay and only the newest pending safe status so the
// cross-isolate path cannot replay an arbitrarily long stale queue.
const relayQueues = new Map<string, Map<string, RelayQueue>>();
/**
 * Publish one already-sanitized activity update to the live Slack turn. Node
 * reaches the in-isolate registry directly; Cloudflare relays the same safe
 * text from the agent DO to the state DO that owns the turn presenter.
 */
export function publishActivityStatus(
  instanceId: string,
  status: ActivityStatus,
  env?: Record<string, unknown>,
  observedSubmissionId?: string,
): void {
  // Production activity is canonicalized by activityStatus(). Preserve its
  // structured fact over the Cloudflare RPC, and reject legacy/raw text before
  // it can cross an isolate boundary.
  if (!isSafeTypedActivityStatus(status)) return;
  const context = currentFlueObservationContext();
  const matchingContext = context?.instanceId === instanceId ? context : undefined;
  const submissionId = observedSubmissionId ?? matchingContext?.submissionId;
  if (!submissionId) return;
  const generation = matchingContext?.submissionId === submissionId
    ? matchingContext.target?.generation
    : undefined;
  if (generation && setObservedSlackStatus(instanceId, generation, status)) {
    return;
  }

  const instanceQueues = relayQueues.get(instanceId) ?? new Map<string, RelayQueue>();
  relayQueues.set(instanceId, instanceQueues);
  const queue = instanceQueues.get(submissionId) ?? {
    active: undefined,
    pending: undefined,
  };
  instanceQueues.set(submissionId, queue);
  if (sameActivityStatus(queue.active?.status, status)) {
    // The in-flight value is already the newest requested state.
    if (queue.pending) {
      emitRelayQueue('superseded');
    }
    queue.pending = undefined;
    emitRelayQueue('coalesced');
    return;
  }
  if (sameActivityStatus(queue.pending?.status, status)) {
    emitRelayQueue('coalesced');
    return;
  }
  if (queue.pending) emitRelayQueue('superseded');
  queue.pending = { status, ...(env ? { env } : {}) };
  emitRelayQueue('enqueued');
  startNextRelay(instanceId, submissionId, queue);
}

function startNextRelay(instanceId: string, submissionId: string, queue: RelayQueue): void {
  if (queue.active || !queue.pending) return;

  const next = queue.pending;
  queue.pending = undefined;
  const result = relayObservedStatus(instanceId, submissionId, next.status, next.env).catch(() => {
    emitRelayQueue('relay_failed');
  });
  const active = { status: next.status };
  queue.active = active;
  void result.then(() => {
    if (queue.active === active) {
      queue.active = undefined;
    }
    if (queue.pending) {
      startNextRelay(instanceId, submissionId, queue);
    } else if (!queue.active) {
      const instanceQueues = relayQueues.get(instanceId);
      if (instanceQueues?.get(submissionId) === queue) {
        instanceQueues.delete(submissionId);
        if (instanceQueues.size === 0) {
          relayQueues.delete(instanceId);
        }
      }
    }
  });
}

function emitRelayQueue(
  disposition: 'enqueued' | 'coalesced' | 'superseded' | 'relay_failed',
): void {
  emitSemanticActivityTelemetry({
    event: 'activity.queue',
    layer: 'relay',
    disposition,
    observed: true,
  });
}

function sameActivityStatus(
  left: TypedActivityStatus | undefined,
  right: TypedActivityStatus,
): boolean {
  return left?.kind === right.kind && left.action === right.action &&
    left.object === right.object && left.text === right.text;
}
