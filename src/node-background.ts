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

export function acquireNodeProcessOwnership() {
  return acquireNodeStateOwnership();
}

export async function startNodeBackground(): Promise<void> {
  await startNodeRoutineScheduler();
  startNodeTurnRelay();
  await startNodeGatewayRuntime();
}

export async function stopNodeBackground(): Promise<void> {
  await stopNodeGatewayRuntime();
  await stopNodeTurnRelay();
  await stopNodeRoutineScheduler();
}
