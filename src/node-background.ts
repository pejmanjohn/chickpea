import { acquireNodeStateOwnership } from './routines/node-runtime.ts';
import {
  startNodeRoutineScheduler,
  stopNodeRoutineScheduler,
} from './routines/node-runtime.ts';

export function acquireNodeProcessOwnership() {
  return acquireNodeStateOwnership();
}

export async function startNodeBackground(): Promise<void> {
  await startNodeRoutineScheduler();
}

export async function stopNodeBackground(): Promise<void> {
  await stopNodeRoutineScheduler();
}
