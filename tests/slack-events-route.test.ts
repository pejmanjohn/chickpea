import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { createSlackEventsApp } from '../src/slack/events-app.ts';
import {
  appHomeMessage,
  appMention,
  assistantThreadStarted,
  channelThreadMessage,
  dmMessage,
  topLevelChannelMessage,
} from './helpers/slack-fixtures.ts';

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

function decodeSlackApiBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (!body) {
    return {};
  }

  const raw = String(body);
  if (raw.trim().startsWith('{')) {
    return JSON.parse(raw) as Record<string, unknown>;
  }

  return Object.fromEntries(
    Array.from(new URLSearchParams(raw).entries()).map(([key, value]) => [
      key,
      coerceFormValue(value),
    ]),
  );
}

function coerceFormValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

test('Slack URL verification challenge returns the challenge without running the agent', async () => {
  const calls: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(decodeSlackApiBody(init?.body));
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
  assert.equal(calls.length, 0);
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
    botUserId: 'U_BOT',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, 'POST');
      const authorization = (init?.headers as Record<string, string>).authorization;
      assert.equal(typeof authorization, 'string');
      const authorizationHeader = authorization ?? '';
      assert.equal(authorizationHeader.startsWith('Bearer '), true);
      assert.match(authorizationHeader, /test-bot-token$/);
      const method = String(url).replace('https://slack.com/api/', '');
      const body = decodeSlackApiBody(init?.body);
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
      'conversations.history',
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
  assert.equal(calls[1]?.body.channel, 'C_EXEC');
  assert.equal(calls[1]?.body.latest, '1782770400.000100');
  assert.equal(calls[1]?.body.oldest, '1782684000.000100');
  assert.equal(calls[1]?.body.limit, 50);
  assert.equal(calls[1]?.body.inclusive, false);
  assert.equal(calls[2]?.body.status, 'is gathering channel context');
  assert.deepEqual(calls[2]?.body.loading_messages, [
    'Gathering channel context',
    'Reading the configured channel brief',
    'Checking allowed Slack context tools',
  ]);
  assert.equal(calls[3]?.body.status, 'has channel context ready');
  assert.equal(calls[4]?.body.status, 'is composing an answer');
  assert.equal(calls[5]?.body.recipient_user_id, 'U_ALICE');
  assert.equal(calls[5]?.body.recipient_team_id, 'T_DEMO');
  assert.match(String(calls[5]?.body.markdown_text), /non-Claude Cloudflare Workers AI lane/);
  assert.match(String(calls[5]?.body.markdown_text), /exec leadership channel/);
  assert.match(String(calls[5]?.body.markdown_text), /Slack context \(default_24h\)/);
  assert.equal('chunks' in (calls[5]?.body ?? {}), false);
  assert.equal(calls[7]?.body.status, '');
});

test('async dispatch acknowledges Slack events before downstream Slack API calls finish', async () => {
  let releaseFirstSlackCall: (() => void) | undefined;
  const firstSlackCall = new Promise<void>((resolve) => {
    releaseFirstSlackCall = resolve;
  });
  let calls = 0;
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    providerId: 'workers-ai',
    dispatchMode: 'async',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        await firstSlackCall;
      }
      const method = String(url).replace('https://slack.com/api/', '');
      const body = decodeSlackApiBody(init?.body);
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: body.channel, ts: '1782770400.000300' });
      }
      return Response.json({ ok: true, ts: '1782770400.000400' });
    },
  });

  const response = await app.request(signedRequest(appMention({ event_id: 'Ev_ASYNC_001' })));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'accepted',
    event_id: 'Ev_ASYNC_001',
  });
  assert.equal(calls, 1);
  releaseFirstSlackCall?.();
});

test('assistant_thread_started is acknowledged without running the agent', async () => {
  const calls: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(decodeSlackApiBody(init?.body));
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
      calls.push(decodeSlackApiBody(init?.body));
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

test('signed message.channels thread replies continue an existing session and read thread context', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    providerId: 'workers-ai',
    botUserId: 'U_BOT',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).replace('https://slack.com/api/', '');
      const body = decodeSlackApiBody(init?.body);
      calls.push({ method, body });
      if (method === 'conversations.history') {
        return Response.json({
          ok: true,
          messages: [
            { user: 'U_BOB', text: 'recent channel context', ts: '1782770300.000100' },
            { bot_id: 'B_OTHER', text: 'bot channel context', ts: '1782770301.000100' },
          ],
        });
      }
      if (method === 'conversations.replies') {
        if (!body.cursor) {
          return Response.json({
            ok: true,
            messages: [
              { user: 'U_ALICE', text: 'root thread topic', ts: '1782770400.000100' },
              { bot_id: 'B_OTHER', text: 'bot prior reply', ts: '1782770405.000100' },
            ],
            response_metadata: { next_cursor: 'cursor_2' },
          });
        }
        return Response.json({
          ok: true,
          messages: [
            { user: 'U_BOB', text: 'prior thread detail', ts: '1782770406.000100' },
            { user: 'U_ALICE', text: 'continue from the prior answer', ts: '1782770410.000200' },
          ],
        });
      }
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: body.channel, ts: `1782770400.00030${calls.length}` });
      }
      return Response.json({ ok: true, ts: `1782770400.00030${calls.length}` });
    },
  });

  const start = await app.request(signedRequest(appMention()));
  const followUp = await app.request(signedRequest(channelThreadMessage()));

  assert.equal(start.status, 200);
  assert.equal(followUp.status, 200);
  assert.deepEqual(await followUp.json(), {
    ok: true,
    status: 'handled',
    event_id: 'Ev_MSG_THREAD_001',
  });

  const historyCalls = calls.filter((call) => call.method === 'conversations.history');
  const replyCalls = calls.filter((call) => call.method === 'conversations.replies');
  const streams = calls.filter((call) => call.method === 'chat.startStream');

  assert.equal(historyCalls.length, 1);
  assert.equal(replyCalls.length, 2);
  assert.equal(replyCalls[0]?.body.channel, 'C_EXEC');
  assert.equal(replyCalls[0]?.body.ts, '1782770400.000100');
  assert.equal(replyCalls[0]?.body.limit, 50);
  assert.equal(replyCalls[1]?.body.cursor, 'cursor_2');
  assert.equal(replyCalls[1]?.body.limit, 49);
  assert.equal(streams.length, 2);
  assert.equal(streams[1]?.body.thread_ts, '1782770400.000100');
  assert.match(String(streams[1]?.body.markdown_text), /prior thread detail/);
  assert.doesNotMatch(String(streams[1]?.body.markdown_text), /bot prior reply/);
});

test('explicit top-level mentions use clear natural-language channel history windows', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    providerId: 'workers-ai',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).replace('https://slack.com/api/', '');
      const body = decodeSlackApiBody(init?.body);
      calls.push({ method, body });
      if (method === 'conversations.history') {
        return Response.json({
          ok: true,
          messages: [{ user: 'U_BOB', text: 'two-day channel context', ts: '1782760000.000100' }],
        });
      }
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: body.channel, ts: '1782770400.000300' });
      }
      return Response.json({ ok: true, ts: '1782770400.000400' });
    },
  });

  const response = await app.request(
    signedRequest(
      appMention({
        event_id: 'Ev_WINDOW_001',
        event: {
          text: '<@U_BOT> what changed in the last 2 days?',
        },
      }),
    ),
  );

  assert.equal(response.status, 200);
  const historyCall = calls.find((call) => call.method === 'conversations.history');
  assert.equal(historyCall?.body.latest, '1782770400.000100');
  assert.equal(historyCall?.body.oldest, '1782597600.000100');
  assert.equal(historyCall?.body.limit, 50);
  const stream = calls.find((call) => call.method === 'chat.startStream');
  assert.match(String(stream?.body.markdown_text), /Slack context \(last_2_days\)/);
  assert.match(String(stream?.body.markdown_text), /two-day channel context/);
});

test('signed message.im DMs create sessions and read bounded DM conversation history', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    providerId: 'workers-ai',
    botUserId: 'U_BOT',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).replace('https://slack.com/api/', '');
      const body = decodeSlackApiBody(init?.body);
      calls.push({ method, body });
      if (method === 'conversations.history') {
        return Response.json({
          ok: true,
          messages: [
            { user: 'U_ALICE', text: 'earlier DM context', ts: '1782770410.000300' },
            { user: 'U_ALICE', text: 'please help in DM', ts: '1782770420.000300' },
          ],
        });
      }
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: body.channel, ts: '1782770420.000500' });
      }
      return Response.json({ ok: true, ts: '1782770420.000600' });
    },
  });

  const response = await app.request(signedRequest(dmMessage()));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'handled',
    event_id: 'Ev_MSG_DM_001',
  });
  assert.equal(calls.some((call) => call.method === 'conversations.replies'), false);
  const historyCall = calls.find((call) => call.method === 'conversations.history');
  assert.equal(historyCall?.body.channel, 'D_DEMO_DM');
  assert.equal(historyCall?.body.latest, '1782770420.000300');
  assert.equal(historyCall?.body.limit, 50);
  const stream = calls.find((call) => call.method === 'chat.startStream');
  assert.equal(stream?.body.channel, 'D_DEMO_DM');
  assert.equal(stream?.body.thread_ts, '1782770420.000300');
  assert.match(String(stream?.body.markdown_text), /Slack context \(default_24h\)/);
  assert.match(String(stream?.body.markdown_text), /earlier DM context/);
});

test('signed message.app_home messages use the DM path', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    providerId: 'workers-ai',
    botUserId: 'U_BOT',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).replace('https://slack.com/api/', '');
      const body = decodeSlackApiBody(init?.body);
      calls.push({ method, body });
      if (method === 'conversations.history') {
        return Response.json({
          ok: true,
          messages: [
            { user: 'U_ALICE', text: 'earlier App Home context', ts: '1782770425.000300' },
            { user: 'U_ALICE', text: 'please help from App Home', ts: '1782770430.000300' },
          ],
        });
      }
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: body.channel, ts: '1782770430.000500' });
      }
      return Response.json({ ok: true, ts: '1782770430.000600' });
    },
  });

  const response = await app.request(signedRequest(appHomeMessage()));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'handled',
    event_id: 'Ev_MSG_APP_HOME_001',
  });
  assert.equal(calls.some((call) => call.method === 'conversations.replies'), false);
  const historyCall = calls.find((call) => call.method === 'conversations.history');
  assert.equal(historyCall?.body.channel, 'D_DEMO_APP_HOME');
  assert.equal(historyCall?.body.latest, '1782770430.000300');
  const stream = calls.find((call) => call.method === 'chat.startStream');
  assert.equal(stream?.body.channel, 'D_DEMO_APP_HOME');
  assert.equal(stream?.body.thread_ts, '1782770430.000300');
  assert.match(String(stream?.body.markdown_text), /Slack context \(default_24h\)/);
  assert.match(String(stream?.body.markdown_text), /earlier App Home context/);
});

test('top-level channel messages without mentions are acknowledged and ignored', async () => {
  const calls: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(decodeSlackApiBody(init?.body));
      return Response.json({ ok: true });
    },
  });

  const response = await app.request(signedRequest(topLevelChannelMessage()));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'ignored',
    event_id: 'Ev_MSG_TOP_001',
    reason: 'top_level_channel_message',
  });
  assert.equal(calls.length, 0);
});

test('bot, self, subtype, missing-user, and empty message events are filtered before Slack API calls', async () => {
  const calls: unknown[] = [];
  const missingUser = channelThreadMessage({ event_id: 'Ev_MSG_MISSING_USER' });
  delete missingUser.event.user;
  const cases = [
    {
      payload: channelThreadMessage({
        event_id: 'Ev_MSG_BOT',
        event: { bot_id: 'B_DEMO', user: 'U_BOT' },
      }),
      reason: 'bot_message',
    },
    {
      payload: channelThreadMessage({
        event_id: 'Ev_MSG_APP_AUTHORED',
        event: { app_id: 'A_DEMO', user: 'U_APP_MESSAGE' },
      }),
      reason: 'bot_message',
    },
    {
      payload: channelThreadMessage({
        event_id: 'Ev_MSG_SELF',
        event: { user: 'U_BOT' },
      }),
      reason: 'self_message',
    },
    {
      payload: channelThreadMessage({
        event_id: 'Ev_MSG_SUBTYPE',
        event: { subtype: 'message_changed' },
      }),
      reason: 'message_subtype',
    },
    {
      payload: missingUser,
      reason: 'missing_user',
    },
    {
      payload: channelThreadMessage({
        event_id: 'Ev_MSG_EMPTY',
        event: { text: '   ' },
      }),
      reason: 'empty_text',
    },
  ];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    botUserId: 'U_BOT',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(decodeSlackApiBody(init?.body));
      return Response.json({ ok: true });
    },
  });

  for (const testCase of cases) {
    const response = await app.request(signedRequest(testCase.payload));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      status: 'ignored',
      event_id: testCase.payload.event_id,
      reason: testCase.reason,
    });
  }
  assert.equal(calls.length, 0);
});

test('generic message events fail closed without bot user id', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    providerId: 'workers-ai',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).replace('https://slack.com/api/', '');
      const body = decodeSlackApiBody(init?.body);
      calls.push({ method, body });
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: body.channel, ts: '1782770400.000300' });
      }
      return Response.json({ ok: true, ts: '1782770400.000400' });
    },
  });

  const start = await app.request(signedRequest(appMention()));
  const followUp = await app.request(signedRequest(channelThreadMessage()));

  assert.equal(start.status, 200);
  assert.equal(followUp.status, 200);
  assert.deepEqual(await followUp.json(), {
    ok: true,
    status: 'ignored',
    event_id: 'Ev_MSG_THREAD_001',
    reason: 'missing_bot_user_id',
  });
  assert.equal(calls.filter((call) => call.method === 'chat.startStream').length, 1);
});

test('Slack retry with the same event id is acknowledged without reposting', async () => {
  const calls: unknown[] = [];
  const app = createSlackEventsApp({
    signingSecret,
    botToken: 'test-bot-token',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(decodeSlackApiBody(init?.body));
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
  assert.equal(calls.length, 8);
});
