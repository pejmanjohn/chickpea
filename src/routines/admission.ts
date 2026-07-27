import { ROUTINE_LIMITS } from './limits.ts';
import { RoutineStateError, type RoutineRun, type RoutineStore } from './types.ts';

export const ROUTINE_WORKFLOW_NAME = 'routine-occurrence';
export const ADMISSION_RECONCILE_AFTER_MS = Math.max(
  ROUTINE_LIMITS.admissionLeaseMs,
  60_000,
);
export const ADMISSION_SCAN_WINDOW_MS = 30 * 60 * 1_000;
export const ADMISSION_SCAN_LIMIT = 100;

export interface RoutineWorkflowCandidate {
  runId: string;
  workflowName: string;
  startedAt: number;
  input: unknown;
}

export interface RoutineWorkflowScan {
  available: boolean;
  complete: boolean;
  candidates: RoutineWorkflowCandidate[];
}

export interface RoutineAdmissionAdapter {
  invoke(run: RoutineRun): Promise<{ runId: string }>;
  scan(input: {
    workflowName: string;
    since: number;
    limit: number;
  }): Promise<RoutineWorkflowScan>;
}

export interface RoutineAdmissionSummary {
  attempted: number;
  attached: number;
  reconciled: number;
  unknown: number;
  deferred: number;
}

/** A proven pre-submission failure. All other invoke errors are ambiguous. */
export class RoutineNotSubmittedError extends Error {}

export class RoutineAdmissionController {
  constructor(
    private readonly store: RoutineStore,
    private readonly adapter: RoutineAdmissionAdapter,
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
      statuses: ['queued', 'admitting'],
      limit: ADMISSION_SCAN_LIMIT,
    });
    pending.sort((left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id));
    for (const run of pending) {
      if (run.status === 'admitting') {
        if (run.flueRunId || (run.admissionLeaseUntil ?? 0) > now) {
          summary.deferred += 1;
          continue;
        }
        const admission = (await this.store.listAdmissions(run.id)).at(-1);
        if (!admission || now - admission.invokeStartedAt < ADMISSION_RECONCILE_AFTER_MS) {
          summary.deferred += 1;
          continue;
        }
        const outcome = await this.reconcile(run, admission.attempt, now);
        if (outcome === 'attached') {
          summary.attached += 1;
          summary.reconciled += 1;
          continue;
        }
        if (outcome === 'unknown') {
          summary.unknown += 1;
          continue;
        }
        summary.reconciled += 1;
      }
      const current = await this.store.getRun(run.id);
      if (!current || current.status !== 'queued') continue;
      if (current.deadlineAt < now) {
        await this.store.transitionRun({
          occurrenceId: current.id,
          from: ['queued'],
          to: 'skipped',
          at: now,
          failureClass: 'capacity_limited',
          publicError: 'Routine admission window expired before capacity became available.',
        });
        continue;
      }
      let attempt;
      try {
        attempt = await this.store.startAdmissionAttempt({
          occurrenceId: current.id,
          owner,
          invokeStartedAt: now,
          leaseUntil: now + ROUTINE_LIMITS.admissionLeaseMs,
        });
      } catch (error) {
        if (error instanceof RoutineStateError && error.code === 'routine_admission_leased') {
          summary.deferred += 1;
          continue;
        }
        throw error;
      }
      summary.attempted += 1;
      try {
        const receipt = await this.adapter.invoke(current);
        await this.store.recordAdmissionReceipt(current.id, attempt.attempt, receipt.runId, now);
        summary.attached += 1;
      } catch (error) {
        if (error instanceof RoutineNotSubmittedError) {
          await this.store.resolveAdmission({
            occurrenceId: current.id,
            attempt: attempt.attempt,
            outcome: 'absent',
            at: now,
            safeError: 'Workflow admission was not submitted.',
          });
        }
        // Every other error may have happened after submission. Keep the lease
        // and reconcile by persisted Workflow input before any reinvocation.
      }
    }
    return summary;
  }

  private async reconcile(
    run: RoutineRun,
    attempt: number,
    now: number,
  ): Promise<'attached' | 'absent' | 'unknown'> {
    let scan: RoutineWorkflowScan;
    try {
      scan = await this.adapter.scan({
        workflowName: ROUTINE_WORKFLOW_NAME,
        since: now - ADMISSION_SCAN_WINDOW_MS,
        limit: ADMISSION_SCAN_LIMIT,
      });
    } catch {
      scan = { available: false, complete: false, candidates: [] };
    }
    if (!scan.available || !scan.complete || scan.candidates.length > ADMISSION_SCAN_LIMIT) {
      await this.store.resolveAdmission({
        occurrenceId: run.id,
        attempt,
        outcome: 'unknown',
        at: now,
        safeError: 'Workflow admission could not be reconciled safely.',
      });
      return 'unknown';
    }
    const matches = scan.candidates
      .filter(
        (candidate) =>
          candidate.workflowName === ROUTINE_WORKFLOW_NAME &&
          candidate.startedAt >= now - ADMISSION_SCAN_WINDOW_MS &&
          occurrenceId(candidate.input) === run.id,
      )
      .sort((left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId));
    const winner = matches[0];
    if (winner) {
      await this.store.recordAdmissionReceipt(run.id, attempt, winner.runId, now);
      return 'attached';
    }
    await this.store.resolveAdmission({
      occurrenceId: run.id,
      attempt,
      outcome: 'absent',
      at: now,
      safeError: 'No submitted Workflow run was found.',
    });
    return 'absent';
  }
}

function occurrenceId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).occurrenceId;
  return typeof value === 'string' ? value : undefined;
}
