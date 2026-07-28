import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';

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
