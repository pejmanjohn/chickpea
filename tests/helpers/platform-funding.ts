import type { PlatformFundingPort, UsageMicros } from '../../src/config/platform-funding.ts';

/** The port's run-fee methods for a test about requests: no fee applies and no run used anything. */
export const NO_RUN_FEES = {
  postFee: async () => ({ kind: 'not_applicable' }),
  creditBack: async () => ({ kind: 'nothing' }),
  runCost: async () => ({ usageMicros: 0 as UsageMicros, shown: false }),
} satisfies Pick<PlatformFundingPort, 'postFee' | 'creditBack' | 'runCost'>;
