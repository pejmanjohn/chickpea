import type { PlatformEnv } from '../config/state-backend.ts';
import type { TurnJobExecutor } from './turn-jobs.ts';

/**
 * Deployment-only switch for who executes Cloudflare Slack turns: `runner`
 * hands each admitted turn to its thread's SlackThreadRunner; unset or any
 * other value keeps the shared state store's alarm. A lane enables it with
 * `npm run deploy -- --var SLACK_TAG_TURN_EXECUTOR:runner`. Not a setting.
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
  return (raw ?? '').trim().toLowerCase() === 'runner' ? 'runner' : 'alarm';
}
