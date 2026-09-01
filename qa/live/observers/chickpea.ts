import type { AssertionToken, ObserverId } from '../schema.ts';
import {
  blockedObservation,
  boundedObserverString,
  closedObservation,
  hasOnlyObserverKeys,
  nonNegativeObserverInteger,
  observerRecord,
  type ClosedObservation,
  type ObserverMetadata,
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
    const metadata: ObserverMetadata = {
      ...(value.revision === undefined ? {} : { revision: value.revision as string }),
      ...(value.count === undefined ? {} : { count: value.count as number }),
      ...(value.state === undefined ? {} : { state: value.state as string }),
    };
    return closedObservation({
      observerId: input.observerId,
      status: 'observed',
      tokens: value.tokens as AssertionToken[],
      metadata,
    });
  } catch {
    return closedObservation({
      observerId: input.observerId,
      status: 'unavailable',
      tokens: [],
      metadata: { attempts: 1 },
    });
  }
}
