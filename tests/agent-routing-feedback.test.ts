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
    channelHintEnabled: false,
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
    channelHintEnabled: true,
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

test('the unassigned hint setting controls ambiguous mention guidance', async () => {
  for (const [channelHintEnabled, expectedCalls] of [[false, 0], [true, 1]] as const) {
    const calls: unknown[] = [];
    await postAgentRoutingFeedback({
      turn: turn(),
      surface: 'channel',
      result: {
        kind: 'ambiguous',
        reason: 'multiple_agents',
        alternatives: [{ id: 'a', name: 'Agent A', handle: 'agent-a' }],
      },
      channelHintEnabled,
      client: {
        chat: {
          async postEphemeral(input: unknown) {
            calls.push(input);
            return { ok: true };
          },
        },
      } as never,
    });
    assert.equal(calls.length, expectedCalls);
  }
});
