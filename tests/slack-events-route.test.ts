import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createSlackEventsApp } from '../src/slack/events-app.ts';
import type { SlackAppMentionEvent, SlackEventFixture } from '../src/slack/types.ts';

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

type AppMentionFixture = SlackEventFixture & { event: SlackAppMentionEvent };
type AppMentionFixtureOverrides = Omit<Partial<SlackEventFixture>, 'event'> & {
  event?: Partial<SlackAppMentionEvent>;
};

function appMention(overrides: AppMentionFixtureOverrides = {}): AppMentionFixture {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/slack/app-mention.json', import.meta.url), 'utf8'),
  ) as AppMentionFixture;

  return {
    ...base,
    ...overrides,
    event: {
      ...base.event,
      ...overrides.event,
      type: 'app_mention',
    },
  };
}

function assistantThreadStarted(): SlackEventFixture {
  return JSON.parse(
    readFileSync(new URL('../fixtures/slack/assistant-thread-started.json', import.meta.url), 'utf8'),
  ) as SlackEventFixture;
}

test('Slack URL verification challenge returns the challenge without running the agent', async () => {
  const posts: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
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
    botToken: 'test-bot-token',
  });
  const request = signedRequest({ type: 'url_verification', challenge: 'nope' });
  request.headers.set('x-slack-signature', 'v0=bad');

  const response = await app.request(request);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_slack_signature' });
});

test('signed app_mention sets Assistant status and streams the final reply into the Slack thread', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    providerId: 'workers-ai',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, 'POST');
      const authorization = (init?.headers as Record<string, string>).authorization;
      assert.equal(typeof authorization, 'string');
      const authorizationHeader = authorization ?? '';
      assert.equal(authorizationHeader.startsWith('Bearer '), true);
      assert.match(authorizationHeader, /test-bot-token$/);
      const method = String(url).replace('https://slack.com/api/', '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: 'C_EXEC', ts: '1782770400.000300' });
      }
      return Response.json({ ok: true, ts: `1782770400.00030${calls.length}` });
    },
  });

  const response = await app.request(signedRequest(appMention()));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'handled',
    event_id: 'Ev_DEMO_001',
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'assistant.threads.setStatus',
      'assistant.threads.setStatus',
      'assistant.threads.setStatus',
      'assistant.threads.setStatus',
      'chat.startStream',
      'chat.stopStream',
      'assistant.threads.setStatus',
    ],
  );
  assert.equal(calls[0]?.body.channel_id, 'C_EXEC');
  assert.equal(calls[0]?.body.thread_ts, '1782770400.000100');
  assert.equal(calls[0]?.body.status, 'is checking context');
  assert.deepEqual(calls[0]?.body.loading_messages, [
    'Checking the Slack thread context',
    'Reviewing the channel assignment',
    'Preparing a concise answer',
  ]);
  assert.equal(calls[1]?.body.status, 'is gathering channel context');
  assert.deepEqual(calls[1]?.body.loading_messages, [
    'Gathering channel context',
    'Reading the configured channel brief',
    'Checking allowed Slack context tools',
  ]);
  assert.equal(calls[2]?.body.status, 'has channel context ready');
  assert.equal(calls[3]?.body.status, 'is composing an answer');
  assert.equal(calls[4]?.body.recipient_user_id, 'U_ALICE');
  assert.equal(calls[4]?.body.recipient_team_id, 'T_DEMO');
  assert.match(String(calls[4]?.body.markdown_text), /non-Claude Cloudflare Workers AI lane/);
  assert.match(String(calls[4]?.body.markdown_text), /exec leadership channel/);
  assert.equal('chunks' in (calls[4]?.body ?? {}), false);
  assert.equal(calls[6]?.body.status, '');
});

test('assistant_thread_started is acknowledged without running the agent', async () => {
  const calls: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, ts: '1782770400.000300' });
    },
  });

  const response = await app.request(signedRequest(assistantThreadStarted()));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'assistant_event_acknowledged',
    event_id: 'Ev_ASSISTANT_001',
  });
  assert.equal(calls.length, 0);
});

test('assistant_thread_context_changed is acknowledged without running the agent', async () => {
  const calls: unknown[] = [];
  const started = assistantThreadStarted();
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, ts: '1782770400.000300' });
    },
  });

  const response = await app.request(
    signedRequest({
      ...started,
      event_id: 'Ev_ASSISTANT_002',
      event: {
        ...started.event,
        type: 'assistant_thread_context_changed',
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'assistant_event_acknowledged',
    event_id: 'Ev_ASSISTANT_002',
  });
  assert.equal(calls.length, 0);
});

test('Slack retry with the same event id is acknowledged without reposting', async () => {
  const posts: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
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
  assert.equal(posts.length, 7);
});
