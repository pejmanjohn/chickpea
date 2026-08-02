import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SlackInteractionProgressPatch } from '../src/config/state-rpc.ts';
import { CfSlackStateStore } from '../src/config/cf-state-proxies.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { publishSlackAdmissionProgress } from '../src/slack/work-admission-progress.ts';

test('work admission reacts, persists, posts one checklist, and persists before execution is armed', async () => {
  const events: string[] = [];
  const patches: SlackInteractionProgressPatch[] = [];

  const progress = await publishSlackAdmissionProgress({
    turn: {
      channelId: 'C_WORK',
      threadTs: '1785514949.001000',
      messageTs: '1785514949.001000',
    },
    checklist: ['Execution result', 'Supporting evidence'],
    presenter: {
      async addSemanticReaction(reaction, coordinate) {
        events.push(`react:${reaction}:${coordinate.messageTs}`);
        return { name: 'eyes', created: true };
      },
      async postWorkChecklist(checklist) {
        events.push(`checklist:${checklist.join('|')}`);
        return '1785514950.002000';
      },
    },
    async record(patch) {
      patches.push(patch);
      events.push(patch.acknowledgment ? 'persist:ack' : 'persist:checklist');
    },
  });

  assert.deepEqual(events, [
    'react:work_ack:1785514949.001000',
    'persist:ack',
    'checklist:Execution result|Supporting evidence',
    'persist:checklist',
  ]);
  assert.deepEqual(progress, {
    acknowledgment: {
      channelId: 'C_WORK',
      messageTs: '1785514949.001000',
      name: 'eyes',
      created: true,
      cleanup: 'pending',
    },
    checklist: {
      channelId: 'C_WORK',
      threadTs: '1785514949.001000',
      messageTs: '1785514950.002000',
      cleanup: 'pending',
    },
  });
  assert.deepEqual(patches, [
    { acknowledgment: progress.acknowledgment },
    { checklist: progress.checklist },
  ]);
});

test('work admission targets a reacted-to message and degrades independently per Slack artifact', async () => {
  const recorded: SlackInteractionProgressPatch[] = [];
  const progress = await publishSlackAdmissionProgress({
    turn: {
      channelId: 'C_WORK',
      threadTs: '1785514900.000100',
      messageTs: '1785514950.000200',
      reactionTargetTs: '1785514940.000150',
    },
    checklist: ['Observation result'],
    presenter: {
      async addSemanticReaction(_reaction, coordinate) {
        assert.equal(coordinate.messageTs, '1785514940.000150');
        throw new Error('reaction unavailable');
      },
      async postWorkChecklist() {
        return '1785514951.000300';
      },
    },
    async record(patch) {
      recorded.push(patch);
    },
  });

  assert.equal(progress.acknowledgment, undefined);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], { checklist: progress.checklist });
});

test('unknown explicit admission acknowledges immediately without inventing a checklist', async () => {
  const events: string[] = [];
  const progress = await publishSlackAdmissionProgress({
    turn: {
      channelId: 'C_EXPLICIT',
      threadTs: '1785521730.418959',
      messageTs: '1785521730.418959',
    },
    presenter: {
      async addSemanticReaction(reaction) {
        events.push(`react:${reaction}`);
        return { name: 'eyes', created: true };
      },
      async postWorkChecklist() {
        events.push('unexpected-checklist');
        return '1785521731.000100';
      },
    },
    async record(patch) {
      events.push(patch.acknowledgment ? 'persist:ack' : 'persist:checklist');
    },
  });

  assert.deepEqual(events, ['react:work_ack', 'persist:ack']);
  assert.equal(progress.checklist, undefined);
  assert.equal(progress.acknowledgment?.name, 'eyes');
});

test('Cloudflare Slack state persists admission progress through the durable RPC seam', async () => {
  const calls: Array<{ id: string; patch: SlackInteractionProgressPatch }> = [];
  const stub = {
    async slackInteractionProgressRecord(id: string, patch: SlackInteractionProgressPatch) {
      calls.push(structuredClone({ id, patch }));
      return { ok: true as const, value: null };
    },
  } as unknown as TagStateRpc;
  const store = new CfSlackStateStore(stub);
  const patch: SlackInteractionProgressPatch = {
    acknowledgment: {
      channelId: 'C_WORK',
      messageTs: '1785514949.001000',
      name: 'eyes',
      created: true,
      cleanup: 'pending',
    },
  };

  await store.recordSlackInteractionProgress('msg:C_WORK:1785514949.001000', patch);

  assert.deepEqual(calls, [{ id: 'msg:C_WORK:1785514949.001000', patch }]);
});

test('Cloudflare Slack state proxy exposes only the turn-related drain counts', async () => {
  const stub = {
    async runtimeDrainStatus() {
      return {
        ok: true as const,
        value: {
          drained: false,
          categories: {
            pendingLegacyTurnJobs: 1,
            pendingLedgerTurnJobs: 2,
            pendingSlackInteractionCleanups: 3,
            recoveryRequiredTurnJobs: 6,
            executingRuns: 4,
            admittingOrRunningRoutineOccurrences: 5,
          },
        },
      };
    },
  } as unknown as TagStateRpc;

  const store = new CfSlackStateStore(stub);
  assert.deepEqual(await store.runtimeDrainCounts(), {
    pendingLegacyTurnJobs: 1,
    pendingLedgerTurnJobs: 2,
    pendingSlackInteractionCleanups: 3,
    recoveryRequiredTurnJobs: 6,
  });
});
