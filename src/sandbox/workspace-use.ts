/**
 * Reply data an Agent writes once it binds a coding workspace to its turn.
 * The Slack relay reads it back so a turn that never opened a workspace skips
 * the Sandbox Durable Object entirely. Not persisted with the settlement.
 */
export const CODING_WORKSPACE_USE_DATA_NAME = 'codingWorkspaceUse';

/** Whether a Flue reply's data says the turn opened a coding workspace. */
export function codingWorkspaceOpenedFromReplyData(value: unknown): boolean {
  const entries = Array.isArray(value) ? value : [value];
  return entries.some((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { opened?: unknown }).opened === true);
}
