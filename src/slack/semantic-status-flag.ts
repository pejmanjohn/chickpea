import type { PlatformEnv } from '../config/state-backend.ts';

export const SLACK_SEMANTIC_ACTIVITY_STATUS_ENV_KEY =
  'SLACK_TAG_SEMANTIC_ACTIVITY_STATUS';

const EXPLICIT_FALSE_VALUES = new Set(['false', '0', 'off', 'no']);

/** Emergency capability gate. Unset and unfamiliar values preserve default-on behavior. */
export function slackSemanticActivityStatusEnabled(
  platformEnv?: PlatformEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const platformValue = platformEnv?.[SLACK_SEMANTIC_ACTIVITY_STATUS_ENV_KEY];
  const raw = typeof platformValue === 'string'
    ? platformValue
    : processEnv[SLACK_SEMANTIC_ACTIVITY_STATUS_ENV_KEY];
  return !EXPLICIT_FALSE_VALUES.has((raw ?? '').trim().toLowerCase());
}
