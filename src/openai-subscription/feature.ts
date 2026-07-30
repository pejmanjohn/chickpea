import type { PlatformEnv } from '../config/state-backend.ts';
import { OpenAiSubscriptionError } from './errors.ts';

export const OPENAI_SUBSCRIPTION_ENABLED_FLAG = 'TAG_OPENAI_SUBSCRIPTION_ENABLED';

export interface OpenAiSubscriptionCapability {
  /** Default-off preview gate. Exact string "1" is the only enabled value. */
  enabled: boolean;
}

/**
 * Resolve the preview gate at the request/Agent boundary. A Cloudflare binding
 * wins when present; Node reads the process environment. Missing, malformed,
 * and every value except the exact string "1" fail closed.
 */
export function openAiSubscriptionCapability(
  env?: PlatformEnv,
): OpenAiSubscriptionCapability {
  const hasBinding = env !== undefined && Object.hasOwn(env, OPENAI_SUBSCRIPTION_ENABLED_FLAG);
  const raw = hasBinding
    ? env[OPENAI_SUBSCRIPTION_ENABLED_FLAG]
    : process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG];
  return { enabled: raw === '1' };
}

export function requireOpenAiSubscriptionEnabled(env?: PlatformEnv): void {
  if (!openAiSubscriptionCapability(env).enabled) {
    throw new OpenAiSubscriptionError('preview_disabled');
  }
}
