import { WebClient } from '@slack/web-api';

import { isCloudflareTarget } from '../config/runtime-target.ts';

/** Build an identity-specific client shared by admission and execution. The
 * fetch wrapper avoids workerd's receiver check, and `manual` replaces the
 * SDK's unsupported `redirect: error` edge value. Slack calls never redirect.
 * Retries stay adapter-owned and every request has a fixed timeout. */
export function createSlackWebClient(botToken: string | undefined): WebClient {
  const slackApiUrl = process.env.SLACK_API_URL;
  return new WebClient(botToken, {
    retryConfig: { retries: 0 },
    timeout: 10_000,
    fetch: (input, init) => {
      const patchedInit =
        isCloudflareTarget() && init?.redirect === 'error'
          ? { ...init, redirect: 'manual' as RequestRedirect }
          : init;
      return globalThis.fetch(input, patchedInit);
    },
    ...(slackApiUrl ? { slackApiUrl } : {}),
  });
}
