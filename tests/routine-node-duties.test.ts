import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runNodeScheduledDuties } from '../src/routines/node-duties.ts';

test('Node scheduled duties retry due Slack actions and run routine and retention work independently', async () => {
  const calls: string[] = [];
  let retryInput: any;
  const routines = {
    nextScheduleActionDueAt: async () => 500,
  };
  await assert.rejects(() => runNodeScheduledDuties({
    scheduledTime: 1_000,
    owner: 'node:test',
  }, {
    routines: routines as any,
    management: {} as any,
    service: {} as any,
    settings: {} as any,
    config: {} as any,
    work: {
      purgeContent: async (at: number, limit: number) => {
        calls.push(`work:${at}:${limit}`);
        return {} as any;
      },
    } as any,
    retryScheduleActions: async (input: any) => {
      calls.push('retry');
      retryInput = input;
      return { attempted: 1 };
    },
    reconcileReceipts: async () => {
      calls.push('reconcile');
      return 0;
    },
    runHeartbeat: async ({ scheduledTime, owner }) => {
      calls.push(`routine:${scheduledTime}:${owner}`);
      throw new Error('routine failed');
    },
    purgeImages: async (_settings, at) => {
      calls.push(`images:${at}`);
    },
    keepAliveSchedule: {},
    keepCredentialsAlive: async () => {
      calls.push('keepalive');
      return {} as any;
    },
  }), /routine failed/);

  assert.deepEqual(calls.sort(), [
    'images:1000',
    'keepalive',
    'retry',
    'routine:1000:node:test',
    'work:1000:100',
  ]);
  assert.equal(retryInput.dependencies.owner, 'node:test:schedule-actions');
  assert.equal(retryInput.dependencies.now(), 1_000);
  const context = await retryInput.resolveContext({
    actorUserId: 'user', actorMembershipId: 'member', agentId: 'agent',
    workspaceId: 'workspace', channelId: 'channel', threadTs: 'thread',
    messageTs: 'message', conversationKind: 'im',
  }, { organizationId: 'organization' });
  assert.equal(context.organizationId, 'organization');
  assert.equal(context.origin.workspaceId, 'workspace');
});

test('Node scheduled duties reconcile receipts while no Slack action is due', async () => {
  let reconciledAt = 0;
  await runNodeScheduledDuties({ scheduledTime: 2_000, owner: 'node:test' }, {
    routines: { nextScheduleActionDueAt: async () => 2_001 } as any,
    management: {} as any,
    service: {} as any,
    settings: {} as any,
    config: {} as any,
    work: { purgeContent: async () => ({} as any) } as any,
    retryScheduleActions: async () => { throw new Error('retry should not run'); },
    reconcileReceipts: async ({ at }) => { reconciledAt = at; return 0; },
    runHeartbeat: async () => {},
    purgeImages: async () => {},
    keepAliveSchedule: {},
    keepCredentialsAlive: async () => ({} as any),
  });
  assert.equal(reconciledAt, 2_000);
});

test('Node scheduled duties keep OAuth credentials alive every ten elapsed minutes', async () => {
  const sweeps: number[] = [];
  const keepAliveSchedule = {};
  const start = Date.UTC(2026, 8, 30, 6, 7, 30);
  // A slow scheduler drifts off minute boundaries; the sweep still runs every ten minutes.
  for (const offset of [0, 1, 9, 10, 13, 20.5]) {
    const scheduledTime = start + offset * 60_000;
    await runNodeScheduledDuties({ scheduledTime, owner: 'node:test' }, {
      routines: { nextScheduleActionDueAt: async () => scheduledTime + 1 } as any,
      management: {} as any,
      service: {} as any,
      settings: {} as any,
      config: {} as any,
      work: { purgeContent: async () => ({} as any) } as any,
      reconcileReceipts: async () => 0,
      runHeartbeat: async () => {},
      purgeImages: async () => {},
      keepAliveSchedule,
      keepCredentialsAlive: async () => {
        sweeps.push(offset);
        return {} as any;
      },
    });
  }
  assert.deepEqual(sweeps, [0, 10, 20.5]);
});
