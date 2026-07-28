import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebClient } from '@slack/web-api';
import type { ChatPostMessageArguments } from '@slack/web-api';

type ChatPostMessageHasClientMessageId =
  'client_msg_id' extends keyof ChatPostMessageArguments ? true : false;

const CHAT_POST_MESSAGE_HAS_CLIENT_MESSAGE_ID: ChatPostMessageHasClientMessageId = false;

function slackResponse(body: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

test('the installed Slack client returns a delivery receipt but has no request idempotency key', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const client = new WebClient('xoxb-routine-spike', {
    slackApiUrl: 'https://slack.invalid/api/',
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body ?? '') });
      return slackResponse({
        ok: true,
        channel: 'C_ROUTINES',
        ts: '1785184800.000100',
        message: { ts: '1785184800.000100' },
      });
    },
  });

  const receipt = await client.chat.postMessage({
    channel: 'C_ROUTINES',
    text: 'routine result',
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://slack.invalid/api/chat.postMessage');
  assert.equal(new URLSearchParams(requests[0]?.body).get('client_msg_id'), null);
  assert.equal(receipt.channel, 'C_ROUTINES');
  assert.equal(receipt.ts, '1785184800.000100');
  assert.equal(CHAT_POST_MESSAGE_HAS_CLIENT_MESSAGE_ID, false);
});

test('a Slack transport timeout after request acceptance is delivery-unknown and is not retried', async () => {
  let requests = 0;
  let requestAccepted = false;
  let transportSignal: AbortSignal | undefined;
  const client = new WebClient('xoxb-routine-spike', {
    slackApiUrl: 'https://slack.invalid/api/',
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: 20,
    fetch: async (_url, init) => {
      requests += 1;
      requestAccepted = true;
      transportSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  });

  await assert.rejects(
    () => client.chat.postMessage({ channel: 'C_ROUTINES', text: 'ambiguous result' }),
    /request|timeout|abort/i,
  );

  assert.equal(requestAccepted, true);
  assert.equal(transportSignal?.aborted, true);
  assert.equal(requests, 1);
});

test('a Slack rate limit is terminal to one routine delivery attempt', async () => {
  let requests = 0;
  const client = new WebClient('xoxb-routine-spike', {
    slackApiUrl: 'https://slack.invalid/api/',
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    fetch: async () => {
      requests += 1;
      return slackResponse(
        { ok: false, error: 'ratelimited' },
        { status: 429, headers: { 'retry-after': '60' } },
      );
    },
  });

  await assert.rejects(
    () => client.chat.postMessage({ channel: 'C_ROUTINES', text: 'rate limited result' }),
    /rate.?limit/i,
  );
  assert.equal(requests, 1);
});
