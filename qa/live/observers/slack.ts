import type { AssertionToken, ObserverId } from '../schema.ts';
import {
  blockedObservation,
  boundedObserverString,
  closedObservation,
  hasOnlyObserverKeys,
  nonNegativeObserverInteger,
  observerRecord,
  validObserverDeadline,
  type ClosedObservation,
  type ObserverMetadata,
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
  read(): Promise<unknown>;
  sleep(milliseconds: number): Promise<void>;
}): Promise<ClosedObservation> {
  if (!validObserverDeadline(input.deadlineMs, 120_000)) return blockedObservation(input.observerId);
  let remainingMs = input.deadlineMs;
  let attempts = 0;
  while (attempts < 6) {
    attempts += 1;
    let value: unknown;
    try {
      value = await input.read();
    } catch {
      return closedObservation({
        observerId: input.observerId,
        status: 'unavailable',
        tokens: [],
        metadata: { attempts },
      });
    }
    if (!observerRecord(value)) return blockedObservation(input.observerId);
    if (value.status === 429) {
      if (!hasOnlyObserverKeys(value, ['status', 'retryAfter']) || typeof value.retryAfter !== 'string') {
        return blockedObservation(input.observerId);
      }
      const retryAfterSeconds = parseRetryAfter(value.retryAfter);
      const waitMs = retryAfterSeconds * 1_000;
      if (retryAfterSeconds <= 0 || waitMs > remainingMs) {
        return closedObservation({
          observerId: input.observerId,
          status: 'rate_limited',
          tokens: [],
          metadata: { attempts, retryAfterSeconds },
        });
      }
      await input.sleep(waitMs);
      remainingMs -= waitMs;
      continue;
    }
    if (!hasOnlyObserverKeys(value, ['status', 'tokens', 'count', 'state'])
      || value.status !== 200
      || !Array.isArray(value.tokens)
      || (value.count !== undefined && !nonNegativeObserverInteger(value.count))
      || (value.state !== undefined && !boundedObserverString(value.state))) {
      return blockedObservation(input.observerId);
    }
    const metadata: ObserverMetadata = {
      attempts,
      ...(value.count === undefined ? {} : { count: value.count as number }),
      ...(value.state === undefined ? {} : { state: value.state as string }),
    };
    return closedObservation({
      observerId: input.observerId,
      status: 'observed',
      tokens: value.tokens as AssertionToken[],
      metadata,
    });
  }
  return closedObservation({
    observerId: input.observerId,
    status: 'rate_limited',
    tokens: [],
    metadata: { attempts },
  });
}

function parseRetryAfter(value: string): number {
  if (!/^[1-9][0-9]{0,2}$/.test(value)) return 0;
  return Number(value);
}
