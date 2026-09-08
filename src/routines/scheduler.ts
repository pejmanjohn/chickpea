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
    let claimError: unknown;
    let claims: RoutineDueClaimBatch = { runs: [], scannedCount: 0, deferredCount: 0 };
    try {
      claims = await this.store.claimDueSchedules({
        now,
        owner,
        limit: ROUTINE_LIMITS.dueClaimsPerHeartbeat,
      });
    } catch (error) {
      claimError = error;
    }
    const admissions = await this.admissions.process(now, owner);
    const result = { claims, admissions, maintenance };
    emitRoutineHeartbeatTelemetry(result, this.clock() - startedAt, this.telemetry);
    if (claimError !== undefined) throw claimError;
    return result;
  }
}
