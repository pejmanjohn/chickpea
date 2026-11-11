import { WebClient, WebClientEvent } from '@slack/web-api';

import { isCloudflareTarget } from '../config/runtime-target.ts';

/** `rejectRateLimitedCalls`: a rate-limited call fails at once instead of waiting out Retry-After. */
export interface SlackWebClientOptions { rejectRateLimitedCalls?: boolean; onRateLimited?(): void }

/** Build an identity-specific client shared by admission and execution. The
 * fetch wrapper avoids workerd's receiver check, and `manual` replaces the
 * SDK's unsupported `redirect: error` edge value. Slack calls never redirect.
 * Retries stay adapter-owned and every request has a fixed timeout. */
export function createSlackWebClient(botToken: string | undefined, options: SlackWebClientOptions = {}): WebClient {
  const slackApiUrl = process.env.SLACK_API_URL;
  const client = new WebClient(botToken, {
    retryConfig: { retries: 0 },
    timeout: 10_000,
    ...(options.rejectRateLimitedCalls ? { rejectRateLimitedCalls: true } : {}),
    fetch: (input, init) => {
      const patchedInit =
        isCloudflareTarget() && init?.redirect === 'error'
          ? { ...init, redirect: 'manual' as RequestRedirect }
          : init;
      return globalThis.fetch(input, patchedInit);
    },
    ...(slackApiUrl ? { slackApiUrl } : {}),
  });
  if (options.onRateLimited) client.on(WebClientEvent.RATE_LIMITED, options.onRateLimited);
  return client;
}
