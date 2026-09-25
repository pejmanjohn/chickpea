import type { PlatformEnv } from '../config/state-backend.ts';
import type { TurnJobExecutor } from './turn-jobs.ts';

/**
 * Who executes Cloudflare Slack turns. Each admitted turn goes to its thread's
 * SlackThreadRunner by default, so threads never wait on each other.
 *
 * Deployment-only emergency gate: `SLACK_TAG_TURN_EXECUTOR=alarm` keeps new
 * turns on the shared state store's alarm (the pre-runner executor), set with
 * `npm run deploy -- --var SLACK_TAG_TURN_EXECUTOR:alarm`. Unset and
 * unfamiliar values preserve the default. Rows already handed to a runner
 * finish there either way. Not a setting.
 */
export const SLACK_TURN_EXECUTOR_ENV_KEY = 'SLACK_TAG_TURN_EXECUTOR';

export function slackTurnExecutor(
  platformEnv?: PlatformEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): TurnJobExecutor {
  const platformValue = platformEnv?.[SLACK_TURN_EXECUTOR_ENV_KEY];
  const raw = typeof platformValue === 'string'
    ? platformValue
    : processEnv[SLACK_TURN_EXECUTOR_ENV_KEY];
  return (raw ?? '').trim().toLowerCase() === 'alarm' ? 'alarm' : 'runner';
}
