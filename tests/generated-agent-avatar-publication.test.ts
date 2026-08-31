import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultAgentAvatarPng } from '../src/slack/agent-presence/default-avatar-pool.ts';
import { publishGeneratedAgentAvatar } from '../src/slack/agent-presence/gateway-avatar.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';

test('generated Agent publication uploads the exact selected gallery PNG', async () => {
  const seed = 'chickpea-avatar-v1:09:calendar-agent';
  const calls: Array<{
    agentId: string;
    revision: number;
    contentType: string;
    bytes: Uint8Array;
  }> = [];

  const result = await publishGeneratedAgentAvatar({
    agentId: 'calendar-agent',
    revision: 1,
    seed,
    publish: async (input) => {
      calls.push(input);
      return `https://gateway.chickpea.test/avatars/binding/calendar-agent/rev_${input.revision}.png`;
    },
  });

  assert.deepEqual(result, {
    url: 'https://gateway.chickpea.test/avatars/binding/calendar-agent/rev_1.png',
    revision: 1,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.contentType, 'image/png');
  assert.deepEqual(calls[0]?.bytes, defaultAgentAvatarPng(seed));
});

test('generated Agent publication advances past an incompatible immutable revision', async () => {
  const revisions: number[] = [];

  const result = await publishGeneratedAgentAvatar({
    agentId: 'calendar-agent',
    revision: 1,
    seed: 'chickpea-avatar-v1:09:calendar-agent',
    publish: async (input) => {
      revisions.push(input.revision);
      if (input.revision === 1) {
        throw new SlackTransportError('avatar.publish', 'avatar_revision_exists', {
          effectOutcome: 'failed',
        });
      }
      return `https://gateway.chickpea.test/avatars/binding/calendar-agent/rev_${input.revision}.png`;
    },
  });

  assert.deepEqual(revisions, [1, 2]);
  assert.deepEqual(result, {
    url: 'https://gateway.chickpea.test/avatars/binding/calendar-agent/rev_2.png',
    revision: 2,
  });
});

test('generated Agent publication does not retry unrelated gateway failures', async () => {
  let calls = 0;
  await assert.rejects(
    publishGeneratedAgentAvatar({
      agentId: 'calendar-agent',
      revision: 1,
      seed: 'chickpea-avatar-v1:09:calendar-agent',
      publish: async () => {
        calls += 1;
        throw new SlackTransportError('avatar.publish', 'gateway_unreachable', {
          retryable: true,
        });
      },
    }),
    (error: unknown) => error instanceof SlackTransportError &&
      error.code === 'gateway_unreachable',
  );
  assert.equal(calls, 1);
});

test('generated Agent publication bounds immutable revision collisions', async () => {
  const revisions: number[] = [];
  await assert.rejects(
    publishGeneratedAgentAvatar({
      agentId: 'calendar-agent',
      revision: 4,
      seed: 'chickpea-avatar-v1:09:calendar-agent',
      publish: async ({ revision }) => {
        revisions.push(revision);
        throw new SlackTransportError('avatar.publish', 'avatar_revision_exists', {
          effectOutcome: 'failed',
        });
      },
    }),
    (error: unknown) => error instanceof SlackTransportError &&
      error.code === 'avatar_revision_exists',
  );
  assert.deepEqual(revisions, [4, 5, 6]);
});
