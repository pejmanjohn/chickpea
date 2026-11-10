const SLACK_ACTION_RESPONSE_ORIGINS = new Set([
  'https://hooks.slack.com',
  'https://hooks.slack-gov.com',
]);
const SLACK_ACTION_RESPONSE_PATH =
  /^\/actions\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,256}$/;

/** A click's `response_url`, kept only when it is Slack's own action endpoint, as the gateway checks it. */
export function slackActionResponseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (!SLACK_ACTION_RESPONSE_ORIGINS.has(url.origin)) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (!SLACK_ACTION_RESPONSE_PATH.test(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
