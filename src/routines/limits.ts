export const ROUTINE_LIMITS = {
  activeDeployment: 100,
  activeChannel: 20,
  scheduledStartsPerDay: 240,
  runNowStartsPerDay: 10,
  totalStartsRollingDay: 250,
  startsPerRollingFifteenMinutes: 4,
  reservationLookaheadMs: 48 * 60 * 60 * 1_000,
  dueClaimsPerHeartbeat: 25,
  concurrentDeploymentRuns: 4,
  concurrentRunsPerRoutine: 1,
  minimumIntervalMs: 60 * 60 * 1_000,
  admissionGraceMs: 15 * 60 * 1_000,
  admissionLeaseMs: 2 * 60 * 1_000,
  deliveryLeaseMs: 2 * 60 * 1_000,
  confirmationTtlMs: 15 * 60 * 1_000,
  confirmationPurgeDelayMs: 24 * 60 * 60 * 1_000,
  occurrenceDeadlineMs: 15 * 60 * 1_000,
  metadataRetentionMs: 365 * 24 * 60 * 60 * 1_000,
  maxNameCodePoints: 80,
  maxNameBytes: 320,
  maxDescriptionCodePoints: 280,
  maxDescriptionBytes: 1_120,
  maxTaskBytes: 8_192,
  maxSourceRequestBytes: 8_192,
  maxChangeKeyBytes: 1_024,
  maxPublicErrorBytes: 512,
} as const;

export type RoutineLimits = typeof ROUTINE_LIMITS;

/** Body-free operator contract shared by Admin and documentation. */
export function routineOperatorLimits(): Record<string, number> {
  return {
    activeDeployment: ROUTINE_LIMITS.activeDeployment,
    activeChannel: ROUTINE_LIMITS.activeChannel,
    scheduledStartsPerDay: ROUTINE_LIMITS.scheduledStartsPerDay,
    runNowStartsPerDay: ROUTINE_LIMITS.runNowStartsPerDay,
    totalStartsRollingDay: ROUTINE_LIMITS.totalStartsRollingDay,
    startsPerRollingFifteenMinutes: ROUTINE_LIMITS.startsPerRollingFifteenMinutes,
    reservationLookaheadHours: ROUTINE_LIMITS.reservationLookaheadMs / (60 * 60 * 1_000),
    concurrentDeploymentRuns: ROUTINE_LIMITS.concurrentDeploymentRuns,
    concurrentRunsPerRoutine: ROUTINE_LIMITS.concurrentRunsPerRoutine,
    minimumIntervalMinutes: ROUTINE_LIMITS.minimumIntervalMs / 60_000,
    admissionGraceMinutes: ROUTINE_LIMITS.admissionGraceMs / 60_000,
    occurrenceDeadlineMinutes: ROUTINE_LIMITS.occurrenceDeadlineMs / 60_000,
    retentionDays: ROUTINE_LIMITS.metadataRetentionMs / (24 * 60 * 60 * 1_000),
  };
}
