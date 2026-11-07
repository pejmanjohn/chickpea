import type { PlatformFundingPort } from '../../src/config/platform-funding.ts';
import { PROVIDER_KEY_IDS } from '../../src/config/provider-key-ids.ts';

export const EVERY_PROVIDER_FUNDED = {
  fundedProviders: new Set(PROVIDER_KEY_IDS),
} satisfies Pick<PlatformFundingPort, 'fundedProviders'>;

export const NO_RUN_FEES = {
  postFee: async () => ({ kind: 'not_applicable' }),
  creditBack: async () => ({ kind: 'nothing' }),
  admitTask: async () => 'admitted',
} satisfies Pick<PlatformFundingPort, 'postFee' | 'creditBack' | 'admitTask'>;
