import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import {
  deliverPersistedSlackPayload,
  WebClientPresenter,
} from '../src/slack/web-client-presenter.ts';

function presenterWith(client: unknown): WebClientPresenter {
  return new WebClientPresenter(client as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Test agent',
    agentId: 'agent_test',
  });
}

test('postArtifact sends bytes to files.uploadV2 in the requested thread', async () => {
  const calls: unknown[] = [];
  const presenter = presenterWith({
    files: {
      async uploadV2(input: unknown) {
        calls.push(input);
        return { ok: true };
      },
    },
  });

  const result = await presenter.postArtifact({
    channel: 'C_ARTIFACT',
    threadTs: '1782770400.000200',
    bytes: new Uint8Array([137, 80, 78, 71]),
    filename: 'proof.png',
    title: 'Browser proof',
  });

  assert.deepEqual(result, { uploaded: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    channel_id: 'C_ARTIFACT',
    thread_ts: '1782770400.000200',
    file: Buffer.from([137, 80, 78, 71]),
    filename: 'proof.png',
    title: 'Browser proof',
  });
});

test('postArtifact degrades missing Slack file-upload scope errors', async () => {
  for (const error of ['missing_scope', 'not_allowed_token_type']) {
    const presenter = presenterWith({
      files: {
        async uploadV2() {
          throw { data: { error } };
        },
      },
    });

    assert.deepEqual(
      await presenter.postArtifact({
        channel: 'C_ARTIFACT',
        threadTs: '1782770400.000200',
        bytes: new Uint8Array([1]),
        filename: 'proof.txt',
      }),
      { uploaded: false, reason: 'missing-scope' },
    );
  }
});

test('postArtifact rethrows unrelated Slack upload failures', async () => {
  const failure = { data: { error: 'invalid_channel' } };
  const presenter = presenterWith({
    files: {
      async uploadV2() {
        throw failure;
      },
    },
  });

  await assert.rejects(
    presenter.postArtifact({
      channel: 'C_ARTIFACT',
      threadTs: '1782770400.000200',
      bytes: new Uint8Array([1]),
      filename: 'proof.txt',
    }),
    (err) => err === failure,
  );
});

test('deliverFinal sanitizes emphasized URLs before streaming them to Slack', async () => {
  const calls: unknown[] = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream(input: unknown) {
          calls.push(input);
          return { ok: true, ts: '1782770400.000300' };
        },
        async stopStream() {
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
  );

  await presenter.deliverFinal(
    'Done: **https://github.com/octo-org/example-site/pull/4**',
    'markdown',
  );

  assert.equal(
    (calls[0] as { markdown_text?: string }).markdown_text,
    'Done: https://github.com/octo-org/example-site/pull/4',
  );
});

test('deliverRequesterOnly posts an ephemeral response to the requesting member', async () => {
  const calls: unknown[] = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async postEphemeral(input: unknown) {
          calls.push(input);
          return { ok: true, message_ts: '1782770400.000400' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_INVOKING',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
  );

  await presenter.deliverRequesterOnly(
    'Routines for **https://example.com/private-project**',
    'markdown',
  );

  assert.equal(calls.length, 1);
  const call = calls[0] as {
    channel?: string;
    user?: string;
    thread_ts?: string;
    text?: string;
  };
  assert.equal(call.channel, 'C_INVOKING');
  assert.equal(call.user, 'U_REQUESTER');
  assert.equal(call.thread_ts, undefined);
  assert.doesNotMatch(call.text ?? '', /\*\*https:\/\//);
});

test('stream rejection records confirmed non-delivery before the exact fallback render', async () => {
  const events: Array<Record<string, unknown>> = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          throw new Error('confirmed start rejection');
        },
        async postMessage() {
          return { ok: true, ts: '1782770400.000500' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
    {
      async beforeDelivery(input) {
        events.push({ phase: 'before', ...input });
        return `attempt-${events.length}`;
      },
      async afterDelivery(input) {
        events.push({ phase: 'after', ...input });
      },
    },
  );

  await presenter.deliverFinal('approved answer', 'markdown');
  assert.deepEqual(events.map((event) => [event.phase, event.method, event.outcome]), [
    ['before', 'slack_chat_stream', undefined],
    ['after', undefined, 'failed'],
    ['before', 'slack_chat_post_message', undefined],
    ['after', undefined, 'delivered'],
  ]);
  assert.match(String(events[0]?.renderedPayload), /slack_chat_stream/);
  assert.match(String(events[2]?.renderedPayload), /slack_chat_post_message/);
});

test('stream finalization ambiguity records unknown and never falls back', async () => {
  const outcomes: string[] = [];
  let fallbackPosts = 0;
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          return { ok: true, ts: '1782770400.000600' };
        },
        async stopStream() {
          throw new Error('finalization receipt unavailable');
        },
        async postMessage() {
          fallbackPosts += 1;
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
    {
      async beforeDelivery() {
        return 'attempt-stream';
      },
      async afterDelivery(input) {
        outcomes.push(input.outcome);
      },
    },
  );

  await presenter.deliverFinal('approved answer', 'markdown');
  assert.deepEqual(outcomes, ['unknown']);
  assert.equal(fallbackPosts, 0);
});

test('ledger delivery treats a transport-level stream start failure as unknown', async () => {
  const outcomes: string[] = [];
  let fallbackPosts = 0;
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          throw new Error('socket closed after send');
        },
        async postMessage() {
          fallbackPosts += 1;
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      userId: 'U_REQUESTER', workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    {
      async beforeDelivery() { return 'attempt-stream'; },
      async afterDelivery(input) { outcomes.push(input.outcome); },
    },
    { deliverySafety: 'ledger' },
  );

  await assert.rejects(() => presenter.deliverFinal('approved answer', 'markdown'));
  assert.deepEqual(outcomes, ['unknown']);
  assert.equal(fallbackPosts, 0);
});

test('ledger delivery never calls Slack before its durable start receipt', async () => {
  let externalCalls = 0;
  const presenter = new WebClientPresenter(
    {
      chat: {
        async postMessage() {
          externalCalls += 1;
          return { ok: true, ts: '1782770400.000700' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    {
      async beforeDelivery() { throw new Error('ledger unavailable'); },
      async afterDelivery() {},
    },
    { deliverySafety: 'ledger' },
  );

  await assert.rejects(() => presenter.deliverFinal('approved answer', 'markdown'));
  assert.equal(externalCalls, 0);
});

test('semantic reactions fall back by name and preserve pre-existing reactions', async () => {
  const calls: string[] = [];
  const presenter = presenterWith({
    reactions: {
      async add(input: { name: string }) {
        calls.push(input.name);
        if (input.name === 'merged') {
          throw { code: ErrorCode.PlatformError, data: { error: 'invalid_name' } };
        }
        throw { code: ErrorCode.PlatformError, data: { error: 'already_reacted' } };
      },
    },
  });
  assert.deepEqual(
    await presenter.addSemanticReaction('merged', {
      channelId: 'C_BOUND', messageTs: '1782770400.000100',
    }),
    { name: 'ship', created: false },
  );
  assert.deepEqual(calls, ['merged', 'ship']);
});

test('reaction-only delivery persists the semantic chain and text-falls back on confirmed scope failure', async () => {
  const events: Array<Record<string, unknown>> = [];
  const posts: unknown[] = [];
  const presenter = new WebClientPresenter(
    {
      reactions: {
        async add() {
          throw { code: ErrorCode.PlatformError, data: { error: 'missing_scope' } };
        },
      },
      chat: {
        async postMessage(input: unknown) {
          posts.push(input);
          return { ok: true, ts: '1782770400.000900' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    {
      async beforeDelivery(input) { events.push(input); return 'attempt-reaction'; },
      async afterDelivery(input) { events.push(input); },
    },
    { deliverySafety: 'ledger' },
  );
  const receipt = await presenter.deliverReaction('agreement', {
    channelId: 'C_BOUND', messageTs: '1782770400.000100',
  });
  assert.deepEqual(receipt, { name: 'text_fallback', created: false });
  assert.equal(posts.length, 1);
  assert.equal((posts[0] as { text: string }).text, 'Sounds good.');
  assert.match(String(events[0]?.renderedPayload), /slack_reaction_add/);
  assert.equal(events[1]?.outcome, 'delivered');
});

test('persisted reaction delivery replays without reclassification', async () => {
  const calls: unknown[] = [];
  const result = await deliverPersistedSlackPayload(
    {
      reactions: {
        async add(input: unknown) { calls.push(input); return { ok: true }; },
      },
    } as unknown as WebClient,
    JSON.stringify({
      method: 'slack_reaction_add', semantic: 'done', names: ['white_check_mark'],
      channel: 'C_BOUND', timestamp: '1782770400.000100',
      threadTs: '1782770400.000100', fallbackText: 'Done.',
    }),
  );
  assert.equal(result.method, 'slack_reaction_add');
  assert.equal(calls.length, 1);
});

test('persisted reaction text fallback stays in the original thread', async () => {
  const posts: Array<{ thread_ts?: string }> = [];
  const result = await deliverPersistedSlackPayload(
    {
      reactions: {
        async add() {
          throw { code: ErrorCode.PlatformError, data: { error: 'missing_scope' } };
        },
      },
      chat: {
        async postMessage(input: { thread_ts?: string }) {
          posts.push(input);
          return { ok: true, ts: '1782770400.000901' };
        },
      },
    } as unknown as WebClient,
    JSON.stringify({
      method: 'slack_reaction_add', semantic: 'seen', names: ['eyes'],
      channel: 'C_BOUND', timestamp: '1782770400.000700',
      threadTs: '1782770400.000100', fallbackText: 'Seen.',
    }),
  );
  assert.equal(result.method, 'slack_chat_post_message');
  assert.equal(posts[0]?.thread_ts, '1782770400.000100');
});

test('work checklist posts once and updates the same message coordinate', async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const presenter = presenterWith({
    chat: {
      async postMessage(input: unknown) {
        calls.push({ method: 'post', input });
        return { ok: true, ts: '1782770400.001000' };
      },
      async update(input: unknown) {
        calls.push({ method: 'update', input });
        return { ok: true };
      },
    },
  });
  const ts = await presenter.postWorkChecklist(['PR link', 'Verification result']);
  assert.equal(ts, '1782770400.001000');
  await presenter.updateWorkChecklist(ts!, ['PR link', 'Verification result'], true);
  assert.deepEqual(calls.map((call) => call.method), ['post', 'update']);
  assert.equal((calls[1]?.input as { ts: string }).ts, ts);
});
