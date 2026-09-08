import type { PlatformEnv } from '../config/state-backend.ts';

const SLACK_PROGRESSIVE_STREAMING_ENV_KEY = 'SLACK_TAG_PROGRESSIVE_STREAMING';

const EXPLICIT_FALSE_VALUES = new Set(['false', '0', 'off', 'no']);

/** Deployment-only emergency gate. Unset and unfamiliar values preserve default-on behavior. */
export function slackProgressiveStreamingEnabled(
  platformEnv?: PlatformEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const platformValue = platformEnv?.[SLACK_PROGRESSIVE_STREAMING_ENV_KEY];
  const raw = typeof platformValue === 'string'
    ? platformValue
    : processEnv[SLACK_PROGRESSIVE_STREAMING_ENV_KEY];
  return !EXPLICIT_FALSE_VALUES.has((raw ?? '').trim().toLowerCase());
}
