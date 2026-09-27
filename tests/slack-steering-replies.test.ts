import assert from 'node:assert/strict';
import test from 'node:test';

import {
  postSteeringReply,
  readSteeringRunFacts,
  slackCheckInReply,
  steeringReplyTarget,
} from '../src/slack/steering-replies.ts';

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

test('a check-in answer gives the step, the bucketed quiet time and the run time', () => {
  const at = 1_800_000_000_000;
  assert.equal(slackCheckInReply({
    facts: {
      startedAt: at - 42 * 60_000, step: 'Running the test suite…', progressAt: at - 12 * 60_000,
      quietFor: '10+', at,
    },
    dispatched: true,
  }), [
    'Still working on this.',
    '• Current step: Running the test suite…',
    '• No new progress for 10+ minutes',
    '• Running for 42 minutes',
  ].join('\n'));
  assert.equal(slackCheckInReply({
    facts: { startedAt: at - 30_000, progressAt: at - 30_000, at },
    dispatched: true,
  }), [
    'Still working on this.',
    '• Last progress under 5 minutes ago',
    '• Running for less than a minute',
  ].join('\n'));
  assert.match(slackCheckInReply({
    facts: { startedAt: at - 120 * 60_000, progressAt: at - 61 * 60_000, quietFor: '60+', at },
    dispatched: true,
  }), /No new progress for 60\+ minutes\n• Running for 2 hours$/);
  assert.match(slackCheckInReply({
    facts: { startedAt: at - 61 * 60_000, progressAt: at, at },
    dispatched: true,
  }), /Running for 1 hour 1 minute$/);
  assert.equal(slackCheckInReply({ dispatched: false }), "Queued. This hasn't started yet.");
  assert.equal(
    slackCheckInReply({ dispatched: true }),
    'Still working on this. Progress details are not available right now.',
  );
});

test('a check-in reads a runner turn\'s facts from its runner, others from the state store', async () => {
  const view = { startedAt: 1, progressAt: 2, at: 3 };
  const asked: string[] = [];
  const env = {
    SLACK_THREAD_RUNNER: {
      getByName(key: string) {
        asked.push(key);
        return { runFacts: async (id: string) => ({ ok: true, value: id === 'turn_1' ? view : null }) };
      },
    },
  };
  const state = { runFacts: async (id: string) => (id === 'turn_2' ? view : undefined) };
  assert.deepEqual(
    await readSteeringRunFacts({ turnJobId: 'turn_1', runnerKey: 'T1:C1:1.000100:owner-i1', executor: 'runner' }, { env, state }),
    view,
  );
  assert.deepEqual(asked, ['T1:C1:1.000100:owner-i1']);
  assert.equal(
    await readSteeringRunFacts({ turnJobId: 'turn_9', runnerKey: 'k', executor: 'runner' }, { env, state }),
    undefined,
  );
  assert.deepEqual(
    await readSteeringRunFacts({ turnJobId: 'turn_2', runnerKey: 'k', executor: 'alarm' }, { env, state }),
    view,
  );
  // No runner binding, or a failing read: no facts, and no throw.
  assert.equal(
    await readSteeringRunFacts({ turnJobId: 'turn_1', runnerKey: 'k', executor: 'runner' }, { state }),
    undefined,
  );
  assert.equal(await readSteeringRunFacts(
    { turnJobId: 'turn_2', runnerKey: 'k', executor: 'alarm' },
    { state: { runFacts: async () => { throw new Error('state store unavailable'); } } },
  ), undefined);
});
