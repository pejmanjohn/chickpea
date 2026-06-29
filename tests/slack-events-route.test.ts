import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createSlackEventsApp } from '../src/slack/events-app.ts';
import type { SlackEventFixture } from '../src/slack/types.ts';

const signingSecret = 'test-slack-signing-secret';

function signedRequest(body: unknown, timestamp = Math.floor(Date.now() / 1000)): Request {
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');

  return new Request('http://localhost/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': `v0=${signature}`,
    },
    body: rawBody,
  });
}

function appMention(overrides: Partial<SlackEventFixture> = {}): SlackEventFixture {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/slack/app-mention.json', import.meta.url), 'utf8'),
  ) as SlackEventFixture;

  return {
    ...base,
    ...overrides,
    event: {
      ...base.event,
      ...overrides.event,
    },
  };
}

test('Slack URL verification challenge returns the challenge without running the agent', async () => {
  const posts: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'xoxb-test-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, ts: '1782770400.000300' });
    },
  });

  const response = await app.request(
    signedRequest({
      type: 'url_verification',
      challenge: 'challenge-value',
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: 'challenge-value' });
  assert.equal(posts.length, 0);
});

test('Slack Events route rejects requests with an invalid signature', async () => {
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'xoxb-test-token',
  });
  const request = signedRequest({ type: 'url_verification', challenge: 'nope' });
  request.headers.set('x-slack-signature', 'v0=bad');

  const response = await app.request(request);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_slack_signature' });
});

test('signed app_mention posts progress and final replies into the Slack thread', async () => {
  const posts: Array<{ channel: string; thread_ts: string; text: string }> = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'xoxb-test-token',
    providerId: 'workers-ai',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), 'https://slack.com/api/chat.postMessage');
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer xoxb-test-token');
      const body = JSON.parse(String(init?.body)) as {
        channel: string;
        thread_ts: string;
        text: string;
      };
      posts.push(body);
      return Response.json({ ok: true, ts: `1782770400.00030${posts.length}` });
    },
  });

  const response = await app.request(signedRequest(appMention()));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'handled',
    event_id: 'Ev_DEMO_001',
  });
  assert.equal(posts.length, 2);
  assert.equal(posts[0]?.channel, 'C_EXEC');
  assert.equal(posts[0]?.thread_ts, '1782770400.000100');
  assert.match(posts[0]?.text ?? '', /checking the Slack thread context/);
  assert.match(posts[1]?.text ?? '', /non-Claude Cloudflare Workers AI lane/);
});

test('Slack retry with the same event id is acknowledged without reposting', async () => {
  const posts: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'xoxb-test-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, ts: '1782770400.000300' });
    },
  });
  const incoming = appMention();

  const first = await app.request(signedRequest(incoming));
  const retry = await app.request(signedRequest(incoming));

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    ok: true,
    status: 'duplicate',
    event_id: 'Ev_DEMO_001',
  });
  assert.equal(posts.length, 2);
});
