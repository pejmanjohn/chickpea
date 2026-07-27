import { RoutineAdmissionController, type RoutineAdmissionSummary } from './admission.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import { emitRoutineHeartbeatTelemetry, type RoutineTelemetrySink } from './telemetry.ts';
import type { RoutineDueClaimBatch, RoutineMaintenanceResult, RoutineStore } from './types.ts';

export interface RoutineHeartbeatResult {
  claims: RoutineDueClaimBatch;
  admissions: RoutineAdmissionSummary;
  maintenance: RoutineMaintenanceResult;
}

/** Fixed-heartbeat controller; timing remains a deployment adapter concern. */
export class RoutineScheduler {
  constructor(
    private readonly store: RoutineStore,
    private readonly admissions: RoutineAdmissionController,
    private readonly telemetry: RoutineTelemetrySink = console,
    private readonly clock: () => number = Date.now,
  ) {}

  async heartbeat(now: number, owner: string): Promise<RoutineHeartbeatResult> {
    const startedAt = this.clock();
    const maintenance = await this.store.cleanupRetention();
    const claims = await this.store.claimDueSchedules({
      now,
      owner,
      limit: ROUTINE_LIMITS.dueClaimsPerHeartbeat,
    });
    const admissions = await this.admissions.process(now, owner);
    const result = { claims, admissions, maintenance };
    emitRoutineHeartbeatTelemetry(result, this.clock() - startedAt, this.telemetry);
    return result;
  }
}
