import { preloadAllConnectorDetails } from './connections/catalog/index.ts';
import { acquireNodeStateOwnership } from './routines/node-runtime.ts';
import {
  startNodeRoutineScheduler,
  stopNodeRoutineScheduler,
} from './routines/node-runtime.ts';
import {
  startNodeGatewayRuntime,
  stopNodeGatewayRuntime,
} from './slack/gateway/node-runtime.ts';
import { startNodeTurnRelay, stopNodeTurnRelay } from './slack/node-turn-relay.ts';

/**
 * Node renders every Agent in this process, and a restart resumes Flue
 * submissions and routine runs that no turn staging precedes, so the process
 * loads every connector's detail before it serves. Started with ownership,
 * ahead of the Flue server; a failure leaves a render to fail its turn.
 */
let connectorDetails: Promise<void> | undefined;

export function acquireNodeProcessOwnership() {
  const ownership = acquireNodeStateOwnership();
  connectorDetails ??= preloadAllConnectorDetails().catch(() => undefined);
  return ownership;
}

export async function startNodeBackground(): Promise<void> {
  await connectorDetails;
  await startNodeRoutineScheduler();
  startNodeTurnRelay();
  await startNodeGatewayRuntime();
}

export async function stopNodeBackground(): Promise<void> {
  await stopNodeGatewayRuntime();
  await stopNodeTurnRelay();
  await stopNodeRoutineScheduler();
}
