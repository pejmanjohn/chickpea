import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditStoreLogic } from '../src/audit/store.ts';
import {
  completeManagementSetupReceipt,
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
  formatManagementSetupReceipt,
} from '../src/management/receipts.ts';
import { ManagementStoreLogic, SqliteManagementStore } from '../src/management/store.ts';
import type {
  ManagementReceiptOutboxRecord,
  ManagementSetupRecord,
} from '../src/management/types.ts';
import type { SlackIdentityExecutionResolver } from '../src/slack/identity-execution.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const NOW = 1_800_200_000_000;

function claimedSetup(overrides: Partial<ManagementSetupRecord> = {}): ManagementSetupRecord {
  return {
    setupOperationId: 'setup_receipt',
    organizationId: 'org_1',
    actorUserId: 'user_1',
    actorMembershipId: 'membership_1',
    origin: {
      kind: 'slack',
      workspaceId: 'T1',
      channelId: 'C1',
      threadTs: '1800200000.000100',
    },
    action: 'api_oauth',
    target: {
      kind: 'api_connection',
      provider: 'google',
      targetId: 'agent:research:api:gmail',
      targetLabel: 'Gmail',
      expectedRevision: 3,
      agentId: 'research',
      agentName: 'Customer Research',
      connectionId: 'gmail',
      replacement: false,
    },
    scopes: ['gmail.readonly'],
    browserSessionDigest: 'b'.repeat(43),
    status: 'authorizing',
    expiresAt: NOW + 86_400_000,
    claimedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test('completion and notification are separate durable outcomes', async () => {
  const store = new SqliteManagementStore(':memory:');
  try {
    const setup = claimedSetup();
    await store.putSetup({ record: setup });
    await completeManagementSetupReceipt(store, {
      setup,
      browserSessionDigest: setup.browserSessionDigest!,
      connector: 'Gmail',
      accountLabel: 'pejman@magoosh.com',
      initiator: 'Pejman',
      at: NOW + 1,
    });
    assert.equal((await store.getSetup(setup.setupOperationId))?.status, 'completed');
    assert.equal((await store.getOutboxForOperation(setup.setupOperationId))?.status, 'pending');

    let calls = 0;
    const first = await drainManagementReceiptOutbox({
      management: store,
      now: () => NOW + 2,
      deliver: async () => {
        calls += 1;
        throw new Error('timeout');
      },
    });
    assert.deepEqual(first, { delivered: 0, retried: 1, failed: 0 });
    assert.equal((await store.getSetup(setup.setupOperationId))?.status, 'completed');
    assert.equal((await store.getOutboxForOperation(setup.setupOperationId))?.status, 'pending');

    const retryAt = (await store.getOutboxForOperation(setup.setupOperationId))!.nextAttemptAt;
    const second = await drainManagementReceiptOutbox({
      management: store,
      now: () => retryAt,
      deliver: async (record) => {
        calls += 1;
        assert.equal(record.outboxId, `receipt_${setup.setupOperationId}`);
        return { deliveryRef: 'slack:C1:1800200001.000100' };
      },
    });
    assert.deepEqual(second, { delivered: 1, retried: 0, failed: 0 });
    assert.equal(calls, 2);
    assert.deepEqual(await drainManagementReceiptOutbox({
      management: store,
      now: () => retryAt + 1,
      deliver: async () => {
        throw new Error('must not redeliver');
      },
    }), { delivered: 0, retried: 0, failed: 0 });
    assert.equal((await store.getOutboxForOperation(setup.setupOperationId))?.status, 'delivered');
  } finally {
    store.close();
  }
});

test('receipt copy contains the approved non-secret details and audit metadata is allowlisted', () => {
  const receipt = {
    setupOperationId: 'setup_receipt',
    connector: 'Gmail',
    target: 'Customer Research',
    scopes: ['gmail.readonly'],
    initiator: 'Pejman',
    accountLabel: 'pejman@magoosh.com',
    completedAt: NOW,
  };
  const text = formatManagementSetupReceipt(receipt);
  assert.match(text, /^pejman@magoosh\.com has been connected to Gmail connector\./);
  assert.match(text, /Target: Customer Research/);
  assert.match(text, /Scopes: gmail\.readonly/);
  assert.match(text, /Initiated by: Pejman/);

  const db = openStateDb(':memory:');
  try {
    const store = new ManagementStoreLogic(db);
    const setup = claimedSetup();
    store.putSetup({ record: setup });
    store.completeSetup({
      setupOperationId: setup.setupOperationId,
      browserSessionDigest: setup.browserSessionDigest!,
      receipt,
      outbox: {
        outboxId: `receipt_${setup.setupOperationId}`,
        operationId: setup.setupOperationId,
        destination: {
          kind: 'thread', workspaceId: 'T1', channelId: 'C1', threadTs: '1.0',
        },
        receipt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      at: NOW,
    });
    const events = new AuditStoreLogic(db).list({ domain: 'management' });
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0]!.metadataJson), {
      action: 'api_oauth',
      setupOperationId: 'setup_receipt',
      scopeCount: '1',
    });
    assert.doesNotMatch(events[0]!.metadataJson, /pejman|gmail\.readonly|magoosh/i);
  } finally {
    db.close();
  }
});

test('the Slack receipt adapter preserves thread routing and stable delivery identity', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const resolveIdentity: SlackIdentityExecutionResolver = async (identityId) => ({
    identityId,
    transportMode: 'direct',
    botToken: 'not-observable',
    botUserId: 'B1',
    teamId: 'T1',
    client: {
      chat: {
        postMessage: async (input: Record<string, unknown>) => {
          calls.push(input);
          return { ok: true, ts: '1800200001.000100' };
        },
      },
    } as never,
  });
  const record: ManagementReceiptOutboxRecord = {
    outboxId: 'receipt_setup_thread',
    operationId: 'setup_thread',
    destination: {
      kind: 'thread',
      workspaceId: 'T1',
      channelId: 'C1',
      threadTs: '1800200000.000100',
    },
    receipt: {
      setupOperationId: 'setup_thread',
      connector: 'Gmail',
      target: 'Customer Research',
      scopes: ['gmail.readonly'],
      initiator: 'Pejman',
      completedAt: NOW,
    },
    status: 'delivering',
    attempts: 1,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const delivered = await deliverManagementReceiptToSlack(record, {
    identity: { listExternalIdentities: async () => [] },
    resolveIdentity,
  });

  assert.deepEqual(delivered, { deliveryRef: 'slack:C1:1800200001.000100' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    channel: 'C1',
    thread_ts: '1800200000.000100',
    text: formatManagementSetupReceipt(record.receipt),
    client_msg_id: record.outboxId,
  });
  assert.doesNotMatch(JSON.stringify(calls), /not-observable/);
});

test('the Slack receipt adapter resolves an external MCP initiator to a DM', async () => {
  let postedChannel = '';
  const record: ManagementReceiptOutboxRecord = {
    outboxId: 'receipt_setup_dm',
    operationId: 'setup_dm',
    destination: { kind: 'initiator_dm', organizationId: 'org_1', userId: 'user_1' },
    receipt: {
      setupOperationId: 'setup_dm',
      connector: 'OpenAI',
      target: 'Workspace',
      scopes: [],
      initiator: 'Pejman',
      completedAt: NOW,
    },
    status: 'delivering',
    attempts: 1,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const delivered = await deliverManagementReceiptToSlack(record, {
    identity: {
      listExternalIdentities: async () => [{
        id: 'external_1',
        provider: 'slack',
        slackTeamId: 'T1',
        slackUserId: 'U1',
        userId: 'user_1',
        organizationId: 'org_1',
        membershipId: 'membership_1',
        betterAuthUserId: 'better_user_1',
        betterAuthMembershipId: 'better_membership_1',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    },
    resolveIdentity: async (identityId) => ({
      identityId,
      transportMode: 'direct',
      botToken: 'not-observable',
      botUserId: 'B1',
      teamId: 'T1',
      client: {
        chat: {
          postMessage: async (input: { channel: string }) => {
            postedChannel = input.channel;
            return { ok: true, ts: '1800200002.000100' };
          },
        },
      } as never,
    }),
  });

  assert.equal(postedChannel, 'U1');
  assert.deepEqual(delivered, { deliveryRef: 'slack:U1:1800200002.000100' });
});
