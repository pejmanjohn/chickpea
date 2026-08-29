import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode, WebClient } from '@slack/web-api';

import {
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
  formatManagementSetupReceipt,
  reconcileScheduleActionReceipts,
} from '../src/management/receipts.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import {
  RoutineStateError,
  type RoutineScheduleAction,
} from '../src/routines/types.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import type { ManagementReceiptOutboxRecord } from '../src/management/types.ts';

const ACKNOWLEDGEMENT: ManagementReceiptOutboxRecord = {
  outboxId: 'routine_ack_test',
  operationId: 'management_test',
  destination: {
    kind: 'reaction',
    workspaceId: 'T_ACK',
    channelId: 'D_ACK',
    messageTs: '1800000000.000100',
  },
  receipt: { kind: 'routine_saved_reaction', emojiName: 'white_check_mark' },
  status: 'delivering',
  attempts: 1,
  nextAttemptAt: 1_800_000_000_000,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
};

test('private schedule receipts add a content-free reaction to the requesting message', async () => {
  const calls: unknown[] = [];
  const result = await deliverManagementReceiptToSlack(ACKNOWLEDGEMENT, {
    identity: { async listExternalIdentities() { return []; } },
    resolveInstallation: async (workspaceId) => ({
      workspaceId,
      transportMode: 'direct',
      botUserId: 'U_BOT',
      client: {
        reactions: {
          async add(input: unknown) {
            calls.push(input);
            return { ok: true };
          },
        },
      } as unknown as WebClient,
    }),
  });

  assert.deepEqual(calls, [{
    channel: 'D_ACK',
    timestamp: '1800000000.000100',
    name: 'white_check_mark',
  }]);
  assert.equal(result.deliveryRef, 'slack:D_ACK:1800000000.000100:reaction');
});

test('a gateway-shaped existing-reaction rejection is an idempotent delivery success', async () => {
  const result = await deliverManagementReceiptToSlack(ACKNOWLEDGEMENT, {
    identity: { async listExternalIdentities() { return []; } },
    resolveInstallation: async (workspaceId) => ({
      workspaceId,
      transportMode: 'gateway',
      botUserId: 'U_BOT',
      client: {
        reactions: {
          async add() {
            throw new SlackTransportError('reactions.add', 'already_reacted');
          },
        },
      } as unknown as WebClient,
    }),
  });

  assert.equal(result.deliveryRef, 'slack:D_ACK:1800000000.000100:reaction');
});

test('the outbox drain records the real Slack failure code and settles permanent rejections terminally', async () => {
  const management = new SqliteManagementStore(':memory:');
  try {
    await management.putOutbox({ ...ACKNOWLEDGEMENT, status: 'pending', attempts: 0 });
    const at = ACKNOWLEDGEMENT.nextAttemptAt;
    const terminalFailures: Array<{ outboxId: string; failureCode: string }> = [];

    const retried = await drainManagementReceiptOutbox({
      management,
      now: () => at,
      deliver: async () => {
        throw new SlackTransportError('reactions.add', 'ratelimited', { retryable: true });
      },
      onTerminalFailure: async (record, failureCode) => {
        terminalFailures.push({ outboxId: record.outboxId, failureCode });
      },
    });
    assert.deepEqual(retried, { delivered: 0, retried: 1, failed: 0 });
    let record = await management.getOutboxForOperation(ACKNOWLEDGEMENT.operationId);
    assert.equal(record?.status, 'pending');
    assert.equal(record?.failureCode, 'ratelimited');
    assert.equal(record?.nextAttemptAt, at + 5_000);

    const rejected = await drainManagementReceiptOutbox({
      management,
      now: () => record!.nextAttemptAt,
      deliver: async () => {
        throw new SlackTransportError('reactions.add', 'missing_scope');
      },
      onTerminalFailure: async (failedRecord, failureCode) => {
        terminalFailures.push({ outboxId: failedRecord.outboxId, failureCode });
      },
    });
    assert.deepEqual(rejected, { delivered: 0, retried: 0, failed: 1 });
    record = await management.getOutboxForOperation(ACKNOWLEDGEMENT.operationId);
    assert.equal(record?.status, 'failed');
    assert.equal(record?.failureCode, 'missing_scope');
    assert.deepEqual(terminalFailures, [{
      outboxId: ACKNOWLEDGEMENT.outboxId,
      failureCode: 'missing_scope',
    }]);
  } finally {
    management.close();
  }
});

test('an existing schedule acknowledgement reaction is an idempotent delivery success', async () => {
  const result = await deliverManagementReceiptToSlack(ACKNOWLEDGEMENT, {
    identity: { async listExternalIdentities() { return []; } },
    resolveInstallation: async (workspaceId) => ({
      workspaceId,
      transportMode: 'direct',
      botUserId: 'U_BOT',
      client: {
        reactions: {
          async add() {
            throw { code: ErrorCode.PlatformError, data: { error: 'already_reacted' } };
          },
        },
      } as unknown as WebClient,
    }),
  });

  assert.equal(result.deliveryRef, 'slack:D_ACK:1800000000.000100:reaction');
});

test('Agent welcome uses its persona and falls back to Chickpea when customize scope is missing', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const record: ManagementReceiptOutboxRecord = {
    outboxId: 'agent_welcome_test',
    operationId: 'management_agent_welcome',
    destination: {
      kind: 'thread',
      workspaceId: 'T_WELCOME',
      channelId: 'C_WELCOME',
      threadTs: '1800000000.000100',
    },
    receipt: {
      kind: 'agent_created_welcome',
      proposalId: 'proposal_welcome',
      agentId: 'agent_paid_marketing',
      agentName: 'Paid Marketing',
      agentDescription: 'Helps optimize Google Ads.',
      requesterMembershipId: 'membership_welcome',
      surface: 'channel',
      persona: { name: 'Paid Marketing', avatarUrl: 'https://example.test/avatar.png' },
      suggestedConnector: 'Google Ads',
      setupUrl: 'https://example.test/admin/agents/agent_paid_marketing',
    },
    status: 'delivering',
    attempts: 1,
    nextAttemptAt: 1_800_000_000_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
  const delivered: unknown[] = [];
  const result = await deliverManagementReceiptToSlack(record, {
    identity: { async listExternalIdentities() { return []; } },
    resolveInstallation: async (workspaceId) => ({
      workspaceId,
      transportMode: 'direct',
      botUserId: 'U_BOT',
      client: {
        chat: {
          async postMessage(input: Record<string, unknown>) {
            calls.push(input);
            if (calls.length === 1) {
              throw new SlackTransportError('chat.postMessage', 'missing_scope');
            }
            return { ok: true, ts: '1800000000.000300' };
          },
        },
      } as unknown as WebClient,
    }),
    onDelivered: async (_record, delivery) => { delivered.push(delivery); },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.username, 'Paid Marketing');
  assert.equal(calls[0]?.icon_url, 'https://example.test/avatar.png');
  assert.equal(
    calls[0]?.text,
    [
      'Hi — I’m *Paid Marketing*. Helps optimize Google Ads.',
      'A sensible next step is to connect *Google Ads* so I can work with live account data.',
      '<https://example.test/admin/agents/agent_paid_marketing|View Agent>',
    ].join('\n\n'),
  );
  assert.equal(calls[1]?.username, undefined);
  assert.match(String(calls[1]?.text), /would not let me post its welcome/);
  assert.doesNotMatch(String(calls[1]?.text), /Hi — I’m/);
  assert.match(
    String(calls[1]?.text),
    /<https:\/\/example\.test\/admin\/agents\/agent_paid_marketing\|View Agent>/,
  );
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0] as { persona: string }).persona, 'chickpea');
  assert.equal(result.deliveryRef, 'slack:C_WELCOME:1800000000.000300');
});

test('an acknowledged Agent welcome is not retried when post-delivery bookkeeping fails', async () => {
  const posts: unknown[] = [];
  const record: ManagementReceiptOutboxRecord = {
    outboxId: 'agent_welcome_bookkeeping_failure',
    operationId: 'management_agent_welcome_bookkeeping_failure',
    destination: {
      kind: 'thread',
      workspaceId: 'T_WELCOME',
      channelId: 'C_WELCOME',
      threadTs: '1800000000.000100',
    },
    receipt: {
      kind: 'agent_created_welcome',
      proposalId: 'proposal_welcome_bookkeeping_failure',
      agentId: 'agent_paid_marketing',
      agentName: 'Paid Marketing',
      agentDescription: 'Helps optimize Google Ads.',
      requesterMembershipId: 'membership_welcome',
      surface: 'channel',
      persona: { name: 'Paid Marketing' },
      setupUrl: 'https://example.test/admin/agents/agent_paid_marketing',
    },
    status: 'delivering',
    attempts: 1,
    nextAttemptAt: 1_800_000_000_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };

  const result = await deliverManagementReceiptToSlack(record, {
    identity: { async listExternalIdentities() { return []; } },
    resolveInstallation: async (workspaceId) => ({
      workspaceId,
      transportMode: 'direct',
      botUserId: 'U_BOT',
      client: {
        chat: {
          async postMessage(input: unknown) {
            posts.push(input);
            return { ok: true, ts: '1800000000.000500' };
          },
        },
      } as unknown as WebClient,
    }),
    async onDelivered() {
      throw new Error('route write failed after Slack acknowledgement');
    },
  });

  assert.equal(posts.length, 1);
  assert.match(
    String((posts[0] as { text?: string }).text),
    /<https:\/\/example\.test\/admin\/agents\/agent_paid_marketing\|View Agent>/,
  );
  assert.equal(result.deliveryRef, 'slack:C_WELCOME:1800000000.000500');
});

test('Chickpea introduction opens one Slack DM and posts bounded capability guidance', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const record: ManagementReceiptOutboxRecord = {
    outboxId: 'chickpea_intro_org_user',
    operationId: 'chickpea_intro_org_user',
    destination: { kind: 'slack_dm', workspaceId: 'T_INTRO', slackUserId: 'U_INTRO' },
    receipt: { kind: 'chickpea_introduction', trigger: 'first_interaction' },
    status: 'delivering',
    attempts: 1,
    nextAttemptAt: 1_800_000_000_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
  const result = await deliverManagementReceiptToSlack(record, {
    identity: {
      async listExternalIdentities() { return []; },
      async resolveSlackIdentity() {
        return {
          user: { id: 'user_intro' },
          membership: { id: 'membership_intro', organizationId: 'org_intro', status: 'active' },
          binding: { slackTeamId: 'T_INTRO', slackUserId: 'U_INTRO' },
        } as Awaited<ReturnType<import('../src/identity/types.ts').IdentityStore['resolveSlackIdentity']>>;
      },
    },
    resolveInstallation: async (workspaceId) => ({
      workspaceId,
      transportMode: 'direct',
      botUserId: 'U_BOT',
      client: {
        conversations: {
          async open(input: Record<string, unknown>) {
            calls.push(input);
            return { ok: true, channel: { id: 'D_INTRO' } };
          },
        },
        chat: {
          async postMessage(input: Record<string, unknown>) {
            calls.push(input);
            return { ok: true, ts: '1800000000.000400' };
          },
        },
      } as unknown as WebClient,
    }),
  });
  assert.deepEqual(calls[0], { users: 'U_INTRO' });
  assert.equal(calls[1]?.channel, 'D_INTRO');
  assert.match(String(calls[1]?.text), /create and manage specialized Agents/);
  assert.match(String(calls[1]?.text), /approve it once/);
  assert.equal(result.deliveryRef, 'slack:D_INTRO:1800000000.000400');
});

test('durable action state repairs one DM reaction and keeps Channel success reply-owned', async () => {
  const management = new SqliteManagementStore(':memory:');
  const routines = new SqliteRoutineStore(':memory:', () => 1_800_000_000_000);
  const reserve = async (actionId: string, conversationKind: 'im' | 'channel') => {
    await routines.reserveScheduleAction({
      actionId,
      actionDigest: actionId.endsWith('dm') ? 'a'.repeat(64) : 'b'.repeat(64),
      requestOperationId: `management_${actionId}`,
      workspaceId: 'T_ACK',
      actorUserId: 'U_MEMBER',
      actorMembershipId: 'membership_ack',
      agentId: 'agent_sprout',
      conversationKind,
      channelId: conversationKind === 'im' ? 'D_ACK' : 'C_ACK',
      threadTs: '1800000000.000100',
      messageTs: '1800000000.000200',
      at: 1_800_000_000_000,
    });
    const claim = await routines.claimScheduleAction({
      actionId,
      owner: 'foreground',
      at: 1_800_000_000_000,
      leaseUntil: 1_800_000_030_000,
    });
    assert.equal(claim.outcome, 'claimed');
    await routines.settleScheduleAction({
      actionId,
      owner: 'foreground',
      expectedAttempt: 1,
      result: {
        outcome: 'applied',
        effect: 'saved',
        routineId: `routine_${conversationKind}`,
        routineVersion: 1,
      },
      at: 1_800_000_000_001,
    });
  };
  try {
    await reserve('rsaction_receipt_dm', 'im');
    await reserve('rsaction_receipt_channel', 'channel');
    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_002,
    }), 2);

    const dm = await management.getOutboxForOperation('rsaction_receipt_dm');
    assert.equal(dm?.destination.kind, 'reaction');
    assert.deepEqual(dm?.receipt, {
      kind: 'schedule_action',
      transition: 'applied',
      emojiName: 'white_check_mark',
    });
    assert.equal(await management.getOutboxForOperation('rsaction_receipt_channel'), undefined);
    assert.deepEqual(await routines.listScheduleActionsNeedingReceipts(10), []);
    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_003,
    }), 0);
  } finally {
    management.close();
    routines.close();
  }
});

test('recovered DM and Channel actions post one terminal thread outcome after a pending receipt', async () => {
  const management = new SqliteManagementStore(':memory:');
  const routines = new SqliteRoutineStore(':memory:', () => 1_800_000_000_000);
  const reservePending = async (
    actionId: string,
    conversationKind: 'im' | 'channel',
    digestCharacter: string,
  ) => {
    await routines.reserveScheduleAction({
      actionId,
      actionDigest: digestCharacter.repeat(64),
      requestOperationId: `management_${actionId}`,
      workspaceId: 'T_ACK',
      actorUserId: 'U_MEMBER',
      actorMembershipId: 'membership_ack',
      agentId: 'agent_sprout',
      conversationKind,
      channelId: conversationKind === 'im' ? 'D_ACK' : 'C_ACK',
      threadTs: '1800000000.000100',
      messageTs: '1800000000.000200',
      at: 1_800_000_000_000,
    });
    const claim = await routines.claimScheduleAction({
      actionId,
      owner: 'foreground',
      at: 1_800_000_000_000,
      leaseUntil: 1_800_000_030_000,
    });
    assert.equal(claim.outcome, 'claimed');
  };
  try {
    await reservePending('rsaction_recovered_dm', 'im', 'c');
    await reservePending('rsaction_recovered_channel', 'channel', 'd');

    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_001,
    }), 2);
    for (const actionId of ['rsaction_recovered_dm', 'rsaction_recovered_channel']) {
      const pending = await management.getOutboxForOperation(actionId);
      assert.equal(pending?.destination.kind, 'thread');
      assert.deepEqual(pending?.receipt, {
        kind: 'schedule_action',
        transition: 'pending',
      });
      await routines.settleScheduleAction({
        actionId,
        owner: 'foreground',
        expectedAttempt: 1,
        result: {
          outcome: 'applied',
          effect: 'saved',
          routineId: `routine_${actionId}`,
          routineVersion: 1,
        },
        at: 1_800_000_000_002,
      });
    }

    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_003,
    }), 2);
    for (const actionId of ['rsaction_recovered_dm', 'rsaction_recovered_channel']) {
      const terminal = await management.getOutboxForOperation(actionId);
      assert.equal(terminal?.destination.kind, 'thread');
      assert.deepEqual(terminal?.receipt, {
        kind: 'schedule_action',
        transition: 'applied',
      });
      assert.equal(
        formatManagementSetupReceipt(terminal!.receipt),
        '✅ That scheduled-work action completed.',
      );
    }
    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_004,
    }), 0);
    assert.deepEqual(await routines.listScheduleActionsNeedingReceipts(10), []);
  } finally {
    management.close();
    routines.close();
  }
});

test('a recovered applied receipt states that non-active scheduled work will not run', async () => {
  const management = new SqliteManagementStore(':memory:');
  const routines = new SqliteRoutineStore(':memory:', () => 1_800_000_000_000);
  const actionId = 'rsaction_recovered_paused';
  try {
    await routines.reserveScheduleAction({
      actionId,
      actionDigest: 'f'.repeat(64),
      requestOperationId: `management_${actionId}`,
      workspaceId: 'T_ACK',
      actorUserId: 'U_MEMBER',
      actorMembershipId: 'membership_ack',
      agentId: 'agent_sprout',
      conversationKind: 'im',
      channelId: 'D_ACK',
      threadTs: '1800000000.000100',
      messageTs: '1800000000.000200',
      at: 1_800_000_000_000,
    });
    const claim = await routines.claimScheduleAction({
      actionId,
      owner: 'foreground',
      at: 1_800_000_000_000,
      leaseUntil: 1_800_000_030_000,
    });
    assert.equal(claim.outcome, 'claimed');
    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_001,
    }), 1);
    await routines.settleScheduleAction({
      actionId,
      owner: 'foreground',
      expectedAttempt: 1,
      result: {
        outcome: 'applied',
        effect: 'saved',
        routineId: 'routine_recovered_paused',
        routineVersion: 1,
        safeState: 'paused',
      },
      at: 1_800_000_000_002,
    });

    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_003,
    }), 1);
    const terminal = await management.getOutboxForOperation(actionId);
    assert.deepEqual(terminal?.receipt, {
      kind: 'schedule_action',
      transition: 'applied',
      safeState: 'paused',
    });
    assert.equal(
      formatManagementSetupReceipt(terminal!.receipt),
      '✅ That scheduled-work action completed. The affected schedule is paused, so it will not run.',
    );
  } finally {
    management.close();
    routines.close();
  }
});

test('one receipt marker conflict does not block the next schedule action', async () => {
  const action = (actionId: string): RoutineScheduleAction => ({
    actionId,
    actionDigest: actionId === 'rsaction_conflict_first' ? 'a'.repeat(64) : 'b'.repeat(64),
    requestOperationId: `management_${actionId}`,
    workspaceId: 'T_ACK',
    actorUserId: 'U_MEMBER',
    actorMembershipId: 'membership_ack',
    agentId: 'agent_sprout',
    conversationKind: 'im',
    channelId: 'D_ACK',
    threadTs: '1800000000.000100',
    messageTs: '1800000000.000200',
    status: 'pending',
    leaseOwner: 'foreground',
    leaseUntil: 1_800_000_030_000,
    attempts: 1,
    nextAttemptAt: 1_800_000_000_000,
    result: null,
    pendingReceiptQueuedAt: null,
    terminalReceiptQueuedAt: null,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  });
  const actions = [action('rsaction_conflict_first'), action('rsaction_conflict_second')];
  const marked: string[] = [];
  const outboxes: ManagementReceiptOutboxRecord[] = [];

  assert.equal(await reconcileScheduleActionReceipts({
    routines: {
      async listScheduleActionsNeedingReceipts() { return actions; },
      async markScheduleActionReceiptQueued(input) {
        marked.push(input.actionId);
        if (input.actionId === actions[0]!.actionId) {
          throw new RoutineStateError(
            'routine_schedule_action_conflict',
            'The action transitioned before its receipt marker was saved.',
          );
        }
        return actions[1]!;
      },
    },
    management: {
      async putOutbox(record) {
        outboxes.push(record);
        return record;
      },
    },
    at: 1_800_000_000_001,
  }), 1);
  assert.deepEqual(marked, ['rsaction_conflict_first', 'rsaction_conflict_second']);
  assert.deepEqual(outboxes.map(({ operationId }) => operationId), [
    'rsaction_conflict_first',
    'rsaction_conflict_second',
  ]);
});

test('receipt reconciliation does not swallow unrelated routine errors', async () => {
  const action: RoutineScheduleAction = {
    actionId: 'rsaction_invalid_marker',
    actionDigest: 'c'.repeat(64),
    requestOperationId: 'management_rsaction_invalid_marker',
    workspaceId: 'T_ACK',
    actorUserId: 'U_MEMBER',
    actorMembershipId: 'membership_ack',
    agentId: 'agent_sprout',
    conversationKind: 'im',
    channelId: 'D_ACK',
    threadTs: '1800000000.000100',
    messageTs: '1800000000.000200',
    status: 'pending',
    leaseOwner: 'foreground',
    leaseUntil: 1_800_000_030_000,
    attempts: 1,
    nextAttemptAt: 1_800_000_000_000,
    result: null,
    pendingReceiptQueuedAt: null,
    terminalReceiptQueuedAt: null,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
  await assert.rejects(reconcileScheduleActionReceipts({
    routines: {
      async listScheduleActionsNeedingReceipts() { return [action]; },
      async markScheduleActionReceiptQueued() {
        throw new RoutineStateError('routine_schedule_action_invalid', 'Invalid receipt marker.');
      },
    },
    management: { async putOutbox(record) { return record; } },
    at: 1_800_000_000_001,
  }), (error: unknown) =>
    error instanceof RoutineStateError && error.code === 'routine_schedule_action_invalid');
});

test('failed action receipts retain the proven safe state and use action-neutral wording', async () => {
  const management = new SqliteManagementStore(':memory:');
  const routines = new SqliteRoutineStore(':memory:', () => 1_800_000_000_000);
  const actionId = 'rsaction_failed_safe_state';
  try {
    await routines.reserveScheduleAction({
      actionId,
      actionDigest: 'e'.repeat(64),
      requestOperationId: `management_${actionId}`,
      workspaceId: 'T_ACK',
      actorUserId: 'U_MEMBER',
      actorMembershipId: 'membership_ack',
      agentId: 'agent_sprout',
      conversationKind: 'im',
      channelId: 'D_ACK',
      threadTs: '1800000000.000100',
      messageTs: '1800000000.000200',
      at: 1_800_000_000_000,
    });
    const claim = await routines.claimScheduleAction({
      actionId,
      owner: 'foreground',
      at: 1_800_000_000_000,
      leaseUntil: 1_800_000_030_000,
    });
    assert.equal(claim.outcome, 'claimed');
    await routines.settleScheduleAction({
      actionId,
      owner: 'foreground',
      expectedAttempt: 1,
      result: {
        outcome: 'failed',
        code: 'schedule_authority_missing',
        routineId: 'routine_safe_state',
        safeState: 'paused',
      },
      at: 1_800_000_000_001,
    });

    assert.equal(await reconcileScheduleActionReceipts({
      routines,
      management,
      at: 1_800_000_000_002,
    }), 1);
    const failed = await management.getOutboxForOperation(actionId);
    assert.deepEqual(failed?.receipt, {
      kind: 'schedule_action',
      transition: 'failed',
      code: 'schedule_authority_missing',
      safeState: 'paused',
    });
    assert.equal(
      formatManagementSetupReceipt(failed!.receipt),
      'I couldn’t complete that scheduled-work action because its Agent authority is unavailable. The affected schedule is paused, so it will not run.',
    );
    assert.equal(
      formatManagementSetupReceipt({
        kind: 'schedule_action',
        transition: 'failed',
        code: 'schedule_internal_failure',
      }),
      'I couldn’t complete that scheduled-work action.',
    );
  } finally {
    management.close();
    routines.close();
  }
});
