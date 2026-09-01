import { performance } from 'node:perf_hooks';

import type { ObserverId } from '../schema.ts';
import {
  blockedObservation,
  boundedObserverString,
  closedObservation,
  hasOnlyObserverKeys,
  nonNegativeObserverInteger,
  observerRecord,
  validObserverDeadline,
  type ClosedObservation,
} from './capabilities.ts';

type SlackObserverId = Extract<ObserverId, 'slack.messages.read' | 'app_home.read'>;

export const SLACK_KNOWN_BAD_FIXTURE: unknown = Object.freeze({
  status: 200,
  tokens: ['slack.message_matches'],
  rawBody: 'secret upstream Slack content',
});

export async function observeSlack(input: {
  observerId: SlackObserverId;
  deadlineMs: number;
  read(options: { signal: AbortSignal }): Promise<unknown>;
  sleep(milliseconds: number): Promise<void>;
  now?: () => number;
}): Promise<ClosedObservation> {
  if (!validObserverDeadline(input.deadlineMs, 120_000)) return blockedObservation(input.observerId);
  const now = input.now ?? (() => performance.now());
  const deadlineAt = now() + input.deadlineMs;
  let attempts = 0;
  while (attempts < 6) {
    const readBudget = Math.floor(deadlineAt - now());
    if (readBudget <= 0) return unavailable(input.observerId, attempts);
    attempts += 1;
    let value: unknown;
    try {
      value = await withinDeadline(readBudget, (signal) => input.read({ signal }));
    } catch {
      return unavailable(input.observerId, attempts);
    }
    if (!observerRecord(value)) return blockedObservation(input.observerId);
    if (value.status === 429) {
      if (!hasOnlyObserverKeys(value, ['status', 'retryAfter']) || typeof value.retryAfter !== 'string') {
        return blockedObservation(input.observerId);
      }
      const retryAfterSeconds = parseRetryAfter(value.retryAfter);
      const waitMs = retryAfterSeconds * 1_000;
      const remainingMs = Math.floor(deadlineAt - now());
      if (retryAfterSeconds <= 0 || waitMs >= remainingMs) {
        return closedObservation({
          observerId: input.observerId,
          status: 'rate_limited',
          tokens: [],
          metadata: { attempts, retryAfterSeconds },
        });
      }
      try {
        await withinDeadline(remainingMs, async () => input.sleep(waitMs));
      } catch {
        return unavailable(input.observerId, attempts);
      }
      continue;
    }
    if (!hasOnlyObserverKeys(value, ['status', 'tokens', 'count', 'state'])
      || value.status !== 200
      || !Array.isArray(value.tokens)
      || (value.count !== undefined && !nonNegativeObserverInteger(value.count))
      || (value.state !== undefined && !boundedObserverString(value.state))) {
      return blockedObservation(input.observerId);
    }
    // Slack Web API reads are diagnostic context only; a visible Slack
    // Computer Use observation is required for scored proof.
    return blockedObservation(input.observerId);
  }
  return closedObservation({
    observerId: input.observerId,
    status: 'rate_limited',
    tokens: [],
    metadata: { attempts },
  });
}

function unavailable(observerId: SlackObserverId, attempts: number): ClosedObservation {
  return closedObservation({ observerId, status: 'unavailable', tokens: [], metadata: { attempts } });
}

async function withinDeadline<Value>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('OBSERVER_DEADLINE')), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfter(value: string): number {
  if (!/^[1-9][0-9]{0,2}$/.test(value)) return 0;
  return Number(value);
}
