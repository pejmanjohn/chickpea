import type { PlatformEnv } from './state-backend.ts';

/** Default-on kill switch for restoring write-once Channel snapshots on new admissions. */
export function liveChannelConfigurationEnabled(
  platformEnv: PlatformEnv | undefined,
  nodeEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = platformEnv?.CHICKPEA_LIVE_CHANNEL_CONFIG ?? nodeEnv.CHICKPEA_LIVE_CHANNEL_CONFIG;
  return !['0', 'false', 'off'].includes(String(raw ?? '').trim().toLowerCase());
}
