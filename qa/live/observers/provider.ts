import type { AssertionToken } from '../schema.ts';
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

export const PROVIDER_KNOWN_BAD_FIXTURE: unknown = Object.freeze({
  status: 200,
  tokens: ['forbidden.no_duplicate'],
  body: 'upstream customer content',
});

export async function observeProvider(input: {
  deadlineMs: number;
  read(options: { signal: AbortSignal }): Promise<unknown>;
}): Promise<ClosedObservation> {
  if (!validObserverDeadline(input.deadlineMs, 60_000)) return blockedObservation('provider.read');
  try {
    const value = await input.read({ signal: AbortSignal.timeout(input.deadlineMs) });
    if (!observerRecord(value)
      || !hasOnlyObserverKeys(value, ['status', 'tokens', 'count', 'state', 'identityMatch'])
      || value.status !== 200
      || !Array.isArray(value.tokens)
      || (value.count !== undefined && !nonNegativeObserverInteger(value.count))
      || (value.state !== undefined && !boundedObserverString(value.state))
      || (value.identityMatch !== undefined && typeof value.identityMatch !== 'boolean')) {
      return blockedObservation('provider.read');
    }
    const metadata: ObserverMetadata = {
      attempts: 1,
      deadlineMs: input.deadlineMs,
      ...(value.count === undefined ? {} : { count: value.count as number }),
      ...(value.state === undefined ? {} : { state: value.state as string }),
      ...(value.identityMatch === undefined ? {} : { identityMatch: value.identityMatch as boolean }),
    };
    return closedObservation({
      observerId: 'provider.read',
      status: 'observed',
      tokens: value.tokens as AssertionToken[],
      metadata,
    });
  } catch {
    return closedObservation({
      observerId: 'provider.read',
      status: 'unavailable',
      tokens: [],
      metadata: { attempts: 1 },
    });
  }
}
