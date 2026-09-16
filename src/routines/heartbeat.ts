import type { PlatformEnv } from '../config/state-backend.ts';
import { getRoutineStore } from '../config/state-backend.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import { RoutineAdmissionController } from './admission.ts';
import { drainRoutinePauseNotices } from './delivery.ts';
import { executeRoutineOccurrence } from './execution.ts';
import { RoutineScheduler } from './scheduler.ts';
import type { RoutineStore } from './types.ts';

/** Shared Cloudflare/Node routine heartbeat with the same claim and missed-slot policy. */
export async function runRoutineHeartbeat(input: {
  scheduledTime: number;
  owner: string;
  env: PlatformEnv;
  productTelemetry?: ProductTelemetryCapture;
  store?: RoutineStore;
}): Promise<void> {
  const store = input.store ?? getRoutineStore(input.env);
  const admissions = new RoutineAdmissionController(store, {
    execute: (run, attempt) => executeRoutineOccurrence({
      env: input.env,
      store,
      occurrenceId: run.id,
      attempt: attempt.attempt,
    }, input.productTelemetry ? { productTelemetry: input.productTelemetry } : {}),
  });
  await new RoutineScheduler(store, admissions).heartbeat(input.scheduledTime, input.owner);
  await drainRoutinePauseNotices({ store, env: input.env });
}
