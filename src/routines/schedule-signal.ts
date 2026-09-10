/**
 * The host-owned shape of a due routine occurrence as the runtime sees it.
 *
 * A scheduled occurrence has no Slack message of its own. When Chickpea
 * assembles its prompt it stamps the saved due time as a synthetic Slack
 * message coordinate, and the same due time travels on the schedule signal as
 * a host-owned attribute. Admission code compares the two so the terminal
 * current-request envelope inside the signal body provably belongs to this
 * occurrence, mirroring the actor/message cross-check on Slack signals.
 *
 * Keep this module dependency-free: it is imported by both the routine prompt
 * and the current-request admission policy.
 */

export const ROUTINE_SCHEDULE_SIGNAL_TYPE = 'schedule';

/** Host signal attributes every schedule occurrence must carry to be admitted. */
export const ROUTINE_SCHEDULE_SIGNAL_IDENTITY_ATTRIBUTES = [
  'routineId',
  'occurrenceId',
  'workspaceId',
  'conversationId',
  'ownerAgentId',
] as const;

/** The synthetic Slack message timestamp for an occurrence due at `scheduledFor` (ms). */
export function scheduleSignalMessageTs(scheduledFor: number): string {
  return `${Math.floor(scheduledFor / 1_000)}.${String(scheduledFor % 1_000).padStart(3, '0')}000`;
}

/**
 * Recover the synthetic message timestamp from the signal's `scheduledFor`
 * attribute, which the host serializes as a decimal millisecond string.
 */
export function scheduleSignalMessageTsFromAttribute(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined;
  const scheduledFor = Number(value);
  if (!Number.isSafeInteger(scheduledFor) || scheduledFor < 0) return undefined;
  return scheduleSignalMessageTs(scheduledFor);
}
