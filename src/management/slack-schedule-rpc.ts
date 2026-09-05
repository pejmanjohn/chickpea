import { ManagementError } from './types.ts';
import type { SlackScheduleActionOutcome } from './slack-schedule-actions.ts';

// Only fixed pre-admission validation messages may cross the RPC boundary.
// Never serialize arbitrary exception messages, request text, or provider errors.
const REQUEST_VALIDATION_MESSAGES = new Set([
  'A Channel schedule must use the current Channel.',
  'A DM schedule must use the current DM thread.',
  'An edit that reuses the previous task needs an explicit cadence or output change in the current Slack request.',
  'Posting only on change must be explicit in the current Slack request.',
  'Recurring and wall-clock schedules require an explicit timezone in the current Slack request.',
  'Scheduled work requires the trusted current Slack request.',
  'Scheduling in group DMs is not supported.',
  'The current Slack request contains conflicting output instructions.',
  'The current Slack request must name the scheduled work being changed.',
  'The requested output policy does not match the current Slack request.',
  'The requested schedule timezone does not match the current Slack request.',
  'The schedule cadence must be explicit in the current Slack request.',
  'The schedule destination must match this conversation.',
  'The schedule workspace must match this conversation.',
  'The scheduled task must be explicitly present in the current Slack request.',
  'The scheduled work name is ambiguous. Name its exact ID in the current Slack request.',
  'The scheduled work was not found.',
  'The current Slack request must explicitly run the scheduled work.',
  'The current Slack request must explicitly pause the scheduled work.',
  'The current Slack request must explicitly resume the scheduled work.',
  'The current Slack request must explicitly delete the scheduled work.',
]);

export async function scheduleActionRpcResult(
  invoke: () => Promise<SlackScheduleActionOutcome>,
): Promise<SlackScheduleActionOutcome> {
  try {
    return await invoke();
  } catch (error) {
    if (error instanceof ManagementError && error.code === 'invalid_request' &&
        REQUEST_VALIDATION_MESSAGES.has(error.message)) {
      return { outcome: 'failed', code: error.code, message: error.message };
    }
    // Transport failures and unknown outcomes keep the existing retry/recovery path.
    throw error;
  }
}
