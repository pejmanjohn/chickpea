import type { PlatformEnv } from '../config/state-backend.ts';
import { isOpaqueRoutineId } from '../routines/ids.ts';
import type { RoutineDefinition } from '../routines/types.ts';
import { authorizedSeed } from './environment-seed.ts';

/**
 * Operator-only "due now" for one routine on a QA lane, so a scripted smoke
 * fires a routine through the real scheduled path (the minute cron's
 * heartbeat claims it) without waiting for its schedule. Like the seed route,
 * it exists only on QA targets and answers only the lane's seed token; every
 * other request gets the same empty 404. It changes nothing but the routine's
 * next run time, and only for an active routine that has one.
 */
export const ENVIRONMENT_ROUTINE_DUE_PATH = '/internal/environment/routine-due';

export async function environmentRoutineDueResponse(input: {
  authorization: string | undefined;
  env: PlatformEnv;
  readBody: () => Promise<string>;
  markDueNow: (routineId: string, now: number) => Promise<RoutineDefinition | undefined>;
  now?: () => number;
}): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  if (!authorizedSeed(input.authorization, input.env)) {
    return new Response('{}', { status: 404, headers });
  }
  let routineId: unknown;
  try {
    routineId = (JSON.parse(await input.readBody()) as { routineId?: unknown }).routineId;
  } catch {
    routineId = undefined;
  }
  if (!isOpaqueRoutineId(routineId)) {
    return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  }
  const now = (input.now ?? Date.now)();
  const routine = await input.markDueNow(routineId, now);
  if (!routine) return Response.json({ error: 'unknown_routine' }, { status: 404, headers });
  if (routine.nextRunAt !== now) {
    return Response.json({ error: 'routine_not_due', state: routine.state }, { status: 409, headers });
  }
  return Response.json({ routineId, state: routine.state, nextRunAt: routine.nextRunAt }, { headers });
}
