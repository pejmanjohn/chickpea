import { RoutineAdmissionController, type RoutineAdmissionSummary } from './admission.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import type { RoutineDueClaimBatch, RoutineStore } from './types.ts';

export interface RoutineHeartbeatResult {
  claims: RoutineDueClaimBatch;
  admissions: RoutineAdmissionSummary;
}

/** Fixed-heartbeat controller; timing remains a deployment adapter concern. */
export class RoutineScheduler {
  constructor(
    private readonly store: RoutineStore,
    private readonly admissions: RoutineAdmissionController,
  ) {}

  async heartbeat(now: number, owner: string): Promise<RoutineHeartbeatResult> {
    const claims = await this.store.claimDueSchedules({
      now,
      owner,
      limit: ROUTINE_LIMITS.dueClaimsPerHeartbeat,
    });
    const admissions = await this.admissions.process(now, owner);
    return { claims, admissions };
  }
}
