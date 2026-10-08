import type { PlatformFundingPort } from '../../src/config/platform-funding.ts';
import type { UsageMicros } from '../../src/usage/usage-display.ts';

export const NO_RUN_FEES = {
  postFee: async () => ({ kind: 'not_applicable' }),
  creditBack: async () => ({ kind: 'nothing' }),
  runCost: async () => ({ usageMicros: 0 as UsageMicros, shown: false }),
} satisfies Pick<PlatformFundingPort, 'postFee' | 'creditBack' | 'runCost'>;
