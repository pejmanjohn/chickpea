import type { PlatformEnv } from '../config/state-backend.ts';

/**
 * Where a direct installation's Slack message is admitted on Cloudflare.
 * `store` sends a verified `message` or `app_mention` to the installation's
 * state store in one call (TagStateStore.admitSlackDelivery), which admits it
 * on its own stores. Unset, or any other value, keeps the Worker admitting it
 * over the store's RPCs. A deployment variable, read by the Worker only.
 */
export const SLACK_ADMISSION_VARIABLE = 'CHICKPEA_SLACK_ADMISSION';

export function slackAdmissionInStore(env: PlatformEnv | undefined): boolean {
  const value = env?.[SLACK_ADMISSION_VARIABLE];
  return typeof value === 'string' && value.trim().toLowerCase() === 'store';
}
