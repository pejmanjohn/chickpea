import assert from 'node:assert/strict';
import { test } from 'node:test';

import { postAgentRoutingFeedback } from '../src/channels/slack.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1',
    channelId: 'C1',
    eventId: 'Ev1',
    text: '<!subteam^SAGENT|@agent> help',
    userId: 'U1',
    messageTs: '100.1',
    threadTs: '100.1',
    source: 'agent_mention',
    channelType: 'channel',
    contextMode: 'channel_history',
    ...patch,
  };
}

test('an explicit Channel denial always informs only the requester', async () => {
  const ephemeral: unknown[] = [];
  const publicMessages: unknown[] = [];

  await postAgentRoutingFeedback({
    turn: turn(),
    surface: 'channel',
    result: { kind: 'denied', reason: 'not_available', alternatives: [] },
    client: {
      chat: {
        async postEphemeral(input: unknown) {
          ephemeral.push(input);
          return { ok: true };
        },
        async postMessage(input: unknown) {
          publicMessages.push(input);
          return { ok: true };
        },
      },
    } as never,
  });

  assert.deepEqual(ephemeral, [{
    channel: 'C1',
    user: 'U1',
    text: 'That Agent is not available here.',
  }]);
  assert.deepEqual(publicMessages, []);
});

test('an ambient Channel denial remains silent', async () => {
  const calls: unknown[] = [];

  await postAgentRoutingFeedback({
    turn: turn({ text: 'hello', source: 'implicit_thread_reply' }),
    surface: 'channel',
    result: { kind: 'denied', reason: 'not_available', alternatives: [] },
    client: {
      chat: {
        async postEphemeral(input: unknown) {
          calls.push(input);
          return { ok: true };
        },
      },
    } as never,
  });

  assert.deepEqual(calls, []);
});

test('a direct message that named several Agents is told to name one', async () => {
  const posts: unknown[] = [];
  await postAgentRoutingFeedback({
    turn: turn({ channelId: 'D1', source: 'dm_message', channelType: 'im', contextMode: 'dm_history' }),
    surface: 'direct',
    result: { kind: 'denied', reason: 'several_agents', alternatives: [] },
    client: {
      chat: {
        async postMessage(input: unknown) {
          posts.push(input);
          return { ok: true };
        },
      },
    } as never,
  });
  assert.deepEqual(posts, [{ channel: 'D1', thread_ts: '100.1', text: 'Mention one Agent at a time here.' }]);
});

test('a thread reply that names an Agent does not need an existing Agent thread', async () => {
  const { turnRequiresOwnedThread } = await import('../src/channels/slack.ts');
  // "@oncall what is this?" under an alert nobody has answered.
  assert.equal(turnRequiresOwnedThread(turn({ source: 'implicit_thread_reply', text: '<!subteam^SAGENT> what is this?' })), false);
  assert.equal(turnRequiresOwnedThread(turn({ source: 'implicit_thread_reply', text: '<!subteam^SAGENT|@oncall> what is this?' })), false);
  // A plain reply or a reaction still continues only an owned thread.
  assert.equal(turnRequiresOwnedThread(turn({ source: 'implicit_thread_reply', text: 'thanks!' })), true);
  assert.equal(turnRequiresOwnedThread(turn({ source: 'reaction_added', text: 'Reacted :eyes:' })), true);
  assert.equal(turnRequiresOwnedThread(turn()), false);
});
