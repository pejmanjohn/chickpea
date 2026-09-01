import { ROUTINE_LIMITS } from './limits.ts';
import type {
  RoutineAdmissionAttempt,
  RoutineRun,
  RoutineStore,
} from './types.ts';
import type { RoutineExecutionOutcome } from './execution.ts';

const ADMISSION_SCAN_LIMIT = 100;

export interface RoutineExecutionAdapter {
  execute(run: RoutineRun, attempt: RoutineAdmissionAttempt): Promise<RoutineExecutionOutcome>;
}

export interface RoutineAdmissionSummary {
  attempted: number;
  attached: number;
  reconciled: number;
  unknown: number;
  deferred: number;
}

/**
 * App-owned admission controller. A stable occurrence-attempt row is created
 * before any Flue call; the adapter freezes the exact envelope, persists the
 * v2 receipt, and can reattach the same read from any later heartbeat.
 */
export class RoutineAdmissionController {
  constructor(
    private readonly store: RoutineStore,
    private readonly adapter: RoutineExecutionAdapter,
  ) {}

  async process(now: number, owner: string): Promise<RoutineAdmissionSummary> {
    const summary: RoutineAdmissionSummary = {
      attempted: 0,
      attached: 0,
      reconciled: 0,
      unknown: 0,
      deferred: 0,
    };
    const pending = await this.store.listRuns({
      statuses: ['queued', 'admitting', 'running'],
      limit: ADMISSION_SCAN_LIMIT,
    });
    pending.sort((left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id));
    for (const candidate of pending) {
      let run = candidate;
      let attempt = (await this.store.listAdmissions(run.id)).at(-1);
      if (run.status === 'queued') {
        if (run.deadlineAt < now) {
          await this.store.transitionRun({
            occurrenceId: run.id,
            from: ['queued'],
            to: 'skipped',
            at: now,
            failureClass: 'capacity_limited',
            publicError: 'Routine admission window expired before capacity became available.',
          });
          continue;
        }
        attempt = await this.store.startAdmissionAttempt({
          occurrenceId: run.id,
          owner,
          invokeStartedAt: now,
          leaseUntil: now + ROUTINE_LIMITS.admissionLeaseMs,
        });
        run = (await this.store.getRun(run.id)) ?? run;
        summary.attempted += 1;
      } else if (run.status === 'admitting' && !attempt) {
        summary.unknown += 1;
        continue;
      } else if (
        run.status === 'admitting' &&
        !run.flueAgentEnvelope &&
        (run.admissionLeaseUntil ?? 0) > now
      ) {
        summary.deferred += 1;
        continue;
      } else {
        summary.reconciled += 1;
      }
      if (!attempt) continue;
      try {
        const outcome = await this.adapter.execute(run, attempt);
        const latest = (await this.store.listAdmissions(run.id))
          .find((entry) => entry.attempt === attempt!.attempt);
        if (latest?.flueAgentReceipt) summary.attached += 1;
        if (outcome === 'resumable') summary.deferred += 1;
      } catch {
        // Dispatch acknowledgement and local reads can both end ambiguously.
        // The frozen envelope and stable attempt remain the only retry path.
        summary.unknown += 1;
        summary.deferred += 1;
      }
    }
    return summary;
  }
}
