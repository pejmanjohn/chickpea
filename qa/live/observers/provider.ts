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
    // Provider APIs may diagnose setup, but cannot satisfy a scored product
    // assertion that the user must see through Computer Use.
    return blockedObservation('provider.read');
  } catch {
    return closedObservation({
      observerId: 'provider.read',
      status: 'unavailable',
      tokens: [],
      metadata: { attempts: 1 },
    });
  }
}
