import type { ActivityStatus } from '../activity/status.ts';
import { currentFlueObservationContext } from '../work/model-invocation.ts';
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
  if (queue.active?.text === status.text) {
    // The in-flight value is already the newest requested state.
    queue.pending = undefined;
    return;
  }
  if (queue.pending?.text === status.text) {
    return;
  }
  queue.pending = { text: status.text, ...(env ? { env } : {}) };
  startNextRelay(instanceId, submissionId, queue);
}

function startNextRelay(instanceId: string, submissionId: string, queue: RelayQueue): void {
  if (queue.active || !queue.pending) return;

  const next = queue.pending;
  queue.pending = undefined;
  const result = relayObservedStatus(instanceId, submissionId, next.text, next.env).catch(
    () => undefined,
  );
  const active = { text: next.text };
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
