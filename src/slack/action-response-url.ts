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

/**
 * Replace the clicked message through its `response_url`, the only way Slack
 * edits an ephemeral message. True only when Slack took it. The URL is a
 * bearer capability for that message, so it is never logged.
 */
export async function replaceSlackActionMessage(
  responseUrl: string,
  message: { text: string; blocks: Array<Record<string, unknown>> },
): Promise<boolean> {
  try {
    const response = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ replace_original: true, text: message.text, blocks: message.blocks }),
      // workerd throws on `redirect: 'error'`; a redirect is not 2xx, so it fails below all the same.
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    const answer = await response.text()
      .then((text) => JSON.parse(text) as { ok?: unknown; error?: unknown } | null)
      .catch(() => undefined);
    const refused = answer?.ok === false;
    if (response.ok && !refused) return true;
    console.warn('[chickpea] Slack did not replace the clicked message:', response.status,
      refused && typeof answer.error === 'string' ? answer.error : '');
  } catch (error) {
    console.warn('[chickpea] Slack did not replace the clicked message:', error instanceof Error ? error.name : 'error');
  }
  return false;
}
