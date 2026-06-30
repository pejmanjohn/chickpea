import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slackLoadingMessages, type SlackPresentationContext } from '../src/slack/replies.ts';
import { SlackWebApiReplySink } from '../src/slack/web-api-replies.ts';

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

const baseContext: SlackPresentationContext = {
  channelId: 'C_EXEC',
  threadTs: '1782770400.000100',
  workspaceId: 'T_DEMO',
  userId: 'U_ALICE',
  postedAt: 1782770400000,
};

test('Slack Web API sink sets transient status, streams the final answer, and clears status', async () => {
  const calls: SlackCall[] = [];
  const sink = new SlackWebApiReplySink({
    botToken: 'test-bot-token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(captureCall(url, init));
      const method = String(url).replace('https://slack.com/api/', '');
      if (method === 'chat.startStream') {
        return Response.json({ ok: true, channel: 'C_EXEC', ts: '1782770400.000300' });
      }
      return Response.json({ ok: true, ts: '1782770400.000301' });
    },
  });

  const status = await sink.setStatus(baseContext, 'checking_context');
  const gathered = await sink.setStatus(baseContext, 'gathering_channel_context');
  const delivery = await sink.deliverFinal(
    {
      ...baseContext,
      postedAt: 1782770400500,
    },
    'Final answer',
  );
  const cleared = await sink.clearStatus({
    ...baseContext,
    postedAt: 1782770400600,
  });

  assert.equal(status.ok, true);
  assert.equal(gathered.ok, true);
  assert.equal(cleared.ok, true);
  assert.equal(delivery.deliveryMode, 'stream');
  assert.deepEqual(delivery.degradations, []);
  assert.equal(delivery.finalReply.text, 'Final answer');
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'assistant.threads.setStatus',
      'assistant.threads.setStatus',
      'chat.startStream',
      'chat.stopStream',
      'assistant.threads.setStatus',
    ],
  );

  assert.deepEqual(calls[0]?.body, {
    channel_id: 'C_EXEC',
    thread_ts: '1782770400.000100',
    status: 'is checking context',
    loading_messages: [
      'Checking the Slack thread context',
      'Reviewing the channel assignment',
      'Preparing a concise answer',
    ],
  });
  assert.equal(calls[1]?.body.status, 'is gathering channel context');
  assert.deepEqual(calls[1]?.body.loading_messages, [
    'Gathering channel context',
    'Reading the configured channel brief',
    'Checking allowed Slack context tools',
  ]);
  assert.equal(calls[2]?.body.channel, 'C_EXEC');
  assert.equal(calls[2]?.body.thread_ts, '1782770400.000100');
  assert.equal(calls[2]?.body.recipient_user_id, 'U_ALICE');
  assert.equal(calls[2]?.body.recipient_team_id, 'T_DEMO');
  assert.equal(calls[2]?.body.markdown_text, 'Final answer');
  assert.equal('chunks' in (calls[2]?.body ?? {}), false);
  assert.equal(calls[3]?.body.ts, '1782770400.000300');
  assert.equal(calls[4]?.body.status, '');
});

test('Slack Web API sink falls back to a final thread post when streaming cannot start', async () => {
  const calls: SlackCall[] = [];
  const sink = new SlackWebApiReplySink({
    botToken: 'test-bot-token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const call = captureCall(url, init);
      calls.push(call);
      if (call.method === 'chat.postMessage') {
        return Response.json({ ok: true, ts: '1782770400.000500' });
      }
      return Response.json({ ok: false, error: 'missing_scope' });
    },
  });

  const status = await sink.setStatus(baseContext, 'checking_context');
  const delivery = await sink.deliverFinal(baseContext, 'Fallback answer');

  assert.equal(status.ok, false);
  assert.equal(status.error, 'missing_scope');
  assert.equal(delivery.deliveryMode, 'fallback_post');
  assert.deepEqual(delivery.degradations, ['chat.startStream:missing_scope']);
  assert.equal(delivery.finalReply.kind, 'final');
  assert.equal(delivery.finalReply.text, 'Fallback answer');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['assistant.threads.setStatus', 'chat.startStream', 'chat.postMessage'],
  );
});

test('Slack Web API sink skips streaming and falls back when recipient fields are missing', async () => {
  const calls: SlackCall[] = [];
  const sink = new SlackWebApiReplySink({
    botToken: 'test-bot-token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(captureCall(url, init));
      return Response.json({ ok: true, ts: '1782770400.000500' });
    },
  });

  const delivery = await sink.deliverFinal(
    {
      channelId: 'C_EXEC',
      threadTs: '1782770400.000100',
      postedAt: 1782770400000,
    },
    'Fallback answer',
  );

  assert.equal(delivery.deliveryMode, 'fallback_post');
  assert.deepEqual(delivery.degradations, ['chat.startStream:missing_recipient']);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['chat.postMessage'],
  );
});

test('Slack Web API sink surfaces final delivery failure with sanitized Slack error text', async () => {
  const sink = new SlackWebApiReplySink({
    botToken: 'test-bot-token',
    fetch: async () => Response.json({ ok: false, error: 'invalid auth: token_like_marker' }),
  });

  await assert.rejects(
    () =>
      sink.deliverFinal(
        {
          channelId: 'C_EXEC',
          threadTs: '1782770400.000100',
          postedAt: 1782770400000,
        },
        'Fallback answer',
      ),
    /Slack chat\.postMessage failed: invalid_auth__token_like_marker/,
  );
});

test('Slack Web API sink bounds malformed final fallback responses', async () => {
  const sink = new SlackWebApiReplySink({
    botToken: 'test-bot-token',
    fetch: async () => new Response('not json', { status: 503 }),
  });

  await assert.rejects(
    () =>
      sink.deliverFinal(
        {
          channelId: 'C_EXEC',
          threadTs: '1782770400.000100',
          postedAt: 1782770400000,
        },
        'Fallback answer',
      ),
    /Slack chat\.postMessage failed: http_503/,
  );
});

test('Slack Web API sink does not duplicate the final answer after stopStream degradation', async () => {
  const calls: SlackCall[] = [];
  let stopCalls = 0;
  let streamCount = 0;
  const sink = new SlackWebApiReplySink({
    botToken: 'test-bot-token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const call = captureCall(url, init);
      calls.push(call);
      if (call.method === 'chat.startStream') {
        streamCount += 1;
        return Response.json({ ok: true, channel: 'C_EXEC', ts: `1782770400.00030${streamCount}` });
      }
      if (call.method === 'chat.stopStream') {
        stopCalls += 1;
        if (stopCalls === 1) {
          return Response.json({ ok: false, error: 'timeout' });
        }
      }
      return Response.json({ ok: true, ts: '1782770400.000500' });
    },
  });

  const first = await sink.deliverFinal(baseContext, 'Fallback after stop failure');
  const second = await sink.deliverFinal(baseContext, 'Fresh streamed answer');

  assert.equal(first.deliveryMode, 'stream');
  assert.deepEqual(first.degradations, ['chat.stopStream:timeout']);
  assert.equal(first.finalReply.text, 'Fallback after stop failure');
  assert.equal(second.deliveryMode, 'stream');
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'chat.startStream',
      'chat.stopStream',
      'chat.startStream',
      'chat.stopStream',
    ],
  );
});

test('Slack loading messages are fixed allowlist values', () => {
  assert.deepEqual(slackLoadingMessages('gathering_channel_context'), [
    'Gathering channel context',
    'Reading the configured channel brief',
    'Checking allowed Slack context tools',
  ]);
  assert.equal(
    slackLoadingMessages('token_like_marker raw prompt payload' as never).join(' '),
    'Working on the request',
  );
});

function captureCall(url: string | URL | Request, init?: RequestInit): SlackCall {
  return {
    method: String(url).replace('https://slack.com/api/', ''),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
}
