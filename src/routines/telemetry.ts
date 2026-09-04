import type { RoutineHeartbeatResult } from './scheduler.ts';

export interface RoutineTelemetrySink {
  info(record: Record<string, unknown>): void;
}

export interface RoutinePersistenceTelemetrySink extends RoutineTelemetrySink {
  error(record: Record<string, unknown>): void;
}

export interface RoutinePersistenceSummary {
  phase: 'terminal' | 'repair' | 'work';
  outcome: 'recorded' | 'repaired' | 'unrepaired';
  usage: 'recorded' | 'repaired' | 'unrepaired' | 'disabled';
  work: 'recorded' | 'unrepaired' | 'not_linked';
  durationMs: number;
}

/**
 * Emit one deliberately body-free routine heartbeat record. Only stable event
 * names, counts, and durations cross this boundary: no task text, prompts,
 * Slack content, credentials, model output, errors, or actor identifiers.
 */
export function emitRoutineHeartbeatTelemetry(
  result: RoutineHeartbeatResult,
  durationMs: number,
  sink: RoutineTelemetrySink = console,
): void {
  const record = {
    component: 'routines',
    event: 'routine.heartbeat',
    scanned: result.claims.scannedCount,
    claimed: result.claims.runs.length,
    deferred: result.claims.deferredCount + result.admissions.deferred,
    admissionAttempted: result.admissions.attempted,
    admissionAttached: result.admissions.attached,
    admissionReconciled: result.admissions.reconciled,
    admissionUnknown: result.admissions.unknown,
    confirmationsPurged: result.maintenance.confirmationsPurged,
    reservationsPurged: result.maintenance.reservationsPurged,
    scheduleActionsDeleted: result.maintenance.scheduleActionsDeleted,
    recoveryNoticesReconciled: result.maintenance.recoveryNoticesReconciled,
    deliveryLeasesReconciled: result.maintenance.deliveryLeasesReconciled,
    deadlineRunsReconciled: result.maintenance.deadlineRunsReconciled,
    runsDeleted: result.maintenance.runsDeleted,
    auditEventsDeleted: result.maintenance.auditEventsDeleted,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
  try {
    sink.info(record);
  } catch {
    // Observability is best effort and must never change scheduling behavior.
  }
}

/** Emit one body-free terminal summary for the routine's observational writes. */
export function emitRoutinePersistenceTelemetry(
  summary: RoutinePersistenceSummary,
  sink: RoutinePersistenceTelemetrySink = console,
): void {
  const record = {
    component: 'routines',
    event: 'routine.persistence',
    phase: summary.phase,
    outcome: summary.outcome,
    usage: summary.usage,
    work: summary.work,
    durationMs: Math.max(0, Math.round(summary.durationMs)),
  };
  try {
    if (summary.outcome === 'unrepaired') sink.error(record);
    else sink.info(record);
  } catch {
    // Observability is best effort and must never change scheduling behavior.
  }
}
