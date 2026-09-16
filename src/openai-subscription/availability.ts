import { isCloudflareTarget } from '../config/runtime-target.ts';
import { OpenAiSubscriptionError } from './errors.ts';

/** Subscription auth runs only in the Node target; Cloudflare remains API-key only. */
export function openAiSubscriptionAvailable(): boolean {
  return !isCloudflareTarget();
}

export function requireOpenAiSubscriptionAvailable(): void {
  if (!openAiSubscriptionAvailable()) {
    throw new OpenAiSubscriptionError('unsupported_runtime');
  }
}
