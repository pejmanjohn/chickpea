import type { PlatformFundingPort } from '../../src/config/platform-funding.ts';

export const NO_RUN_FEES = {
  postFee: async () => ({ kind: 'not_applicable' }),
  creditBack: async () => ({ kind: 'nothing' }),
  admitTask: async () => 'admitted',
} satisfies Pick<PlatformFundingPort, 'postFee' | 'creditBack' | 'admitTask'>;
