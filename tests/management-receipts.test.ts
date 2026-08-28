import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode, WebClient } from '@slack/web-api';

import {
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
} from '../src/management/receipts.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
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

    const retried = await drainManagementReceiptOutbox({
      management,
      now: () => at,
      deliver: async () => {
        throw new SlackTransportError('reactions.add', 'ratelimited', { retryable: true });
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
    });
    assert.deepEqual(rejected, { delivered: 0, retried: 0, failed: 1 });
    record = await management.getOutboxForOperation(ACKNOWLEDGEMENT.operationId);
    assert.equal(record?.status, 'failed');
    assert.equal(record?.failureCode, 'missing_scope');
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
