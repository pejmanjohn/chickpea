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

test('a direct message refusal is posted in its thread and names no Agent', async () => {
  const posts: unknown[] = [];
  await postAgentRoutingFeedback({
    turn: turn({ channelId: 'D1', source: 'dm_message', channelType: 'im', contextMode: 'dm_history' }),
    surface: 'direct',
    result: { kind: 'denied', reason: 'not_available', alternatives: [] },
    client: {
      chat: {
        async postMessage(input: unknown) {
          posts.push(input);
          return { ok: true };
        },
      },
    } as never,
  });
  assert.deepEqual(posts, [{ channel: 'D1', thread_ts: '100.1', text: 'That Agent is not available here.' }]);
});

test('a group DM refusal is told only to the asker, in their thread, and names nobody', async () => {
  const onlyWorkspaceWide = 'Only Agents everyone in this workspace can use answer in group DMs.';
  for (const [patch, thread, reason, text] of [
    [{}, {}, 'not_workspace_wide', onlyWorkspaceWide],
    [
      { source: 'implicit_thread_reply' as const, messageTs: '100.2', text: 'and then?' },
      { thread_ts: '100.1' },
      'not_workspace_wide',
      onlyWorkspaceWide,
    ],
    // Every other refusal keeps its usual words: the group DM rule is not why.
    [{}, {}, 'not_available', 'That Agent is not available here.'],
    [{}, {}, 'member_required', 'That Agent is not available here.'],
    [{}, {}, 'temporarily_unavailable', 'That Agent address could not be verified right now. Try again.'],
  ] as const) {
    const ephemeral: unknown[] = [];
    const publicMessages: unknown[] = [];
    await postAgentRoutingFeedback({
      turn: turn({ channelId: 'C0GROUPDM', channelType: 'mpim', ...patch }),
      surface: 'direct',
      result: { kind: 'denied', reason, alternatives: [] },
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
    assert.deepEqual(ephemeral, [{ channel: 'C0GROUPDM', user: 'U1', ...thread, text }]);
    assert.deepEqual(publicMessages, [], 'the rest of the group sees nothing');
  }
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
