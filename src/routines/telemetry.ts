import type { RoutineHeartbeatResult } from './scheduler.ts';

export interface RoutineTelemetrySink {
  info(message: string): void;
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
    deliveryLeasesReconciled: result.maintenance.deliveryLeasesReconciled,
    deadlineRunsReconciled: result.maintenance.deadlineRunsReconciled,
    runsDeleted: result.maintenance.runsDeleted,
    auditEventsDeleted: result.maintenance.auditEventsDeleted,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
  try {
    sink.info(`[chickpea:routines] ${JSON.stringify(record)}`);
  } catch {
    // Observability is best effort and must never change scheduling behavior.
  }
}
