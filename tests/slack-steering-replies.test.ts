import assert from 'node:assert/strict';
import test from 'node:test';

import { postSteeringReply, steeringReplyTarget } from '../src/slack/steering-replies.ts';

function fakeClient() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push({ method: 'postMessage', args });
        return { ok: true };
      },
      postEphemeral: async (args: Record<string, unknown>) => {
        calls.push({ method: 'postEphemeral', args });
        return { ok: true };
      },
    },
  };
  return { client: client as never, calls };
}

test('a channel steering reply is ephemeral to the asker inside the thread', async () => {
  const { client, calls } = fakeClient();
  await postSteeringReply(client, steeringReplyTarget({
    channelId: 'C1', threadTs: '1700000000.000100', userId: 'U1', source: 'implicit_thread_reply', channelType: 'channel',
  }), 'Still working.');
  assert.deepEqual(calls, [{
    method: 'postEphemeral',
    args: { channel: 'C1', user: 'U1', thread_ts: '1700000000.000100', text: 'Still working.' },
  }]);
});

test('a group DM steering reply stays private', async () => {
  const { client, calls } = fakeClient();
  await postSteeringReply(client, steeringReplyTarget({
    channelId: 'G1', threadTs: '1700000000.000100', userId: 'U1', source: 'implicit_thread_reply', channelType: 'mpim',
  }), 'Still working.');
  assert.equal(calls[0]?.method, 'postEphemeral');
});

test('a DM steering reply is a threaded reply', async () => {
  const { client, calls } = fakeClient();
  await postSteeringReply(client, steeringReplyTarget({
    channelId: 'D1', threadTs: '1700000000.000100', userId: 'U1', source: 'dm_message', channelType: 'im',
  }), 'Still working.');
  assert.deepEqual(calls, [{
    method: 'postMessage',
    args: { channel: 'D1', thread_ts: '1700000000.000100', text: 'Still working.' },
  }]);
});
