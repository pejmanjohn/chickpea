import type { ObserverId } from '../schema.ts';
import {
  blockedObservation,
  boundedObserverString,
  closedObservation,
  hasOnlyObserverKeys,
  nonNegativeObserverInteger,
  observerRecord,
  type ClosedObservation,
} from './capabilities.ts';

type ChickpeaObserverId = Extract<ObserverId, 'agent.read' | 'connection.read' | 'routine.read'>;

export const CHICKPEA_KNOWN_BAD_FIXTURE: unknown = Object.freeze({
  status: 200,
  tokens: ['agent.exists'],
  body: 'customer content must never cross the observer boundary',
});

export async function observeChickpea(input: {
  observerId: ChickpeaObserverId;
  read(): Promise<unknown>;
}): Promise<ClosedObservation> {
  try {
    const value = await input.read();
    if (!observerRecord(value)
      || !hasOnlyObserverKeys(value, ['status', 'tokens', 'revision', 'count', 'state'])
      || value.status !== 200
      || !Array.isArray(value.tokens)
      || (value.revision !== undefined && !boundedObserverString(value.revision))
      || (value.count !== undefined && !nonNegativeObserverInteger(value.count))
      || (value.state !== undefined && !boundedObserverString(value.state))) {
      return blockedObservation(input.observerId);
    }
    // Direct Admin APIs are diagnostic context only. V1's Computer Use
    // adapter will be the sole source allowed to emit scored visible tokens.
    return blockedObservation(input.observerId);
  } catch {
    return closedObservation({
      observerId: input.observerId,
      status: 'unavailable',
      tokens: [],
      metadata: { attempts: 1 },
    });
  }
}
