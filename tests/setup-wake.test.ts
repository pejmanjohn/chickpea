import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  drainManagementReceiptOutbox,
  formatManagementSetupReceipt,
  type SetupWakeRequest,
} from '../src/management/receipts.ts';
import { setupWakeAgent, setupWakeNote } from '../src/management/setup-wake.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type {
  ManagementReceiptOutboxRecord,
  ManagementSetupRecord,
  ManagementSetupWake,
} from '../src/management/types.ts';

const AT = 1_800_000_000_000;
const SLACK_ORIGIN = {
  kind: 'slack', workspaceId: 'T1', channelId: 'D1', threadTs: '100.000100', conversationKind: 'im', agentId: 'agent_support',
} as const;

function setup(patch: Partial<Pick<ManagementSetupRecord, 'action' | 'origin' | 'target'>> = {}) {
  return {
    actorUserId: 'user_asker',
    action: 'api_credential' as ManagementSetupRecord['action'],
    origin: SLACK_ORIGIN as ManagementSetupRecord['origin'],
    target: {
      kind: 'api_connection', provider: 'api', targetId: 'agent_support:tasks', targetLabel: 'Tasks',
      expectedRevision: 1, agentId: 'agent_support', agentName: 'Support', connectionId: 'tasks', replacement: false,
    } as ManagementSetupRecord['target'],
    ...patch,
  };
}

test('a connection setup the Agent asked for from a Slack thread wakes it; everything else keeps its notice', () => {
  for (const action of ['api_credential', 'api_oauth', 'mcp_credentials', 'mcp_oauth', 'catalog_connection', 'managed_connection'] as const) {
    assert.deepEqual(setupWakeAgent(setup({ action })), { agentId: 'agent_support', agentName: 'Support' }, action);
  }
  for (const action of ['repository_access', 'provider_credential'] as const) {
    assert.equal(setupWakeAgent(setup({ action })), undefined, action);
  }
  assert.equal(setupWakeAgent(setup({ origin: { kind: 'admin', sessionId: 'session' } })), undefined, 'started in Admin');
  assert.equal(setupWakeAgent(setup({ origin: { kind: 'mcp', clientId: 'codex' } })), undefined, 'started over MCP');
  assert.equal(setupWakeAgent(setup({ origin: { ...SLACK_ORIGIN, agentId: 'agent_chickpea' } })), undefined,
    'another Agent asked for it, so this one has no turn to continue');
  const { agentId: _agentId, ...noAgentOrigin } = SLACK_ORIGIN;
  assert.equal(setupWakeAgent(setup({ origin: noAgentOrigin })), undefined, 'an origin with no routed Agent');
  assert.deepEqual(setupWakeAgent(setup({ action: 'managed_connection' }), 'user_asker'), { agentId: 'agent_support', agentName: 'Support' });
  assert.equal(setupWakeAgent(setup({ action: 'managed_connection' }), 'user_teammate'), undefined,
    'a teammate who finished the link with their own account is not woken as in the asker\'s thread');
});

test('the wake\'s note says who finished which setup, how, and what to do, and never holds a key or an ID', () => {
  const key = setupWakeNote({
    person: 'Nicole', connector: 'Knowledge Base', completion: { kind: 'key', check: 'path_not_found' }, connectorTools: false,
  });
  assert.equal(key, [
    'Chickpea note, not typed by Nicole: Nicole saved the key for Knowledge Base on its setup page. Chickpea\'s check got a 404 at the address it tried, which says nothing about the key.',
    'Test it now with one real read through the connection, then reply here with what you found and what you will do next for their request. Do not write to the service to test it.',
  ].join('\n\n'));
  const signIn = setupWakeNote({
    person: 'Nicole', connector: 'Notion', completion: { kind: 'sign_in', access: 'write' }, connectorTools: true,
  });
  assert.match(signIn, /^Chickpea note, not typed by Nicole: Nicole signed in to Notion, granting read and write access\./);
  assert.match(signIn, /one real read with Notion's tools/);
  assert.match(setupWakeNote({ person: 'N', connector: 'X', completion: { kind: 'sign_in', access: 'read' }, connectorTools: true }),
    /granting read-only access/);
  for (const note of [key, signIn]) assert.doesNotMatch(note, /setup_|agent_|acct_|U[0-9A-Z]{6,}/);
});

test('a setup\'s notice is one plain line, with no receipt ID, raw scope or initiator', () => {
  const receipt = {
    setupOperationId: 'setup_88c88cd3', connector: 'Knowledge Base', target: 'Product Support',
    scopes: ['header:Authorization'], initiator: 'Nicole', completedAt: AT,
  };
  assert.equal(formatManagementSetupReceipt(receipt), '✅ Knowledge Base is now connected to Product Support.');
  assert.equal(formatManagementSetupReceipt({ ...receipt, accountLabel: 'Acme <!channel>' }),
    '✅ Knowledge Base (Acme &lt;!channel&gt;) is now connected to Product Support.');
  assert.equal(formatManagementSetupReceipt({ ...receipt, target: 'Anthropic', connector: 'Anthropic' }),
    '✅ Anthropic is now connected.');
});

const WAKE: ManagementSetupWake = {
  agentId: 'agent_support', slackUserId: 'U1', conversationKind: 'im', note: 'Chickpea note, not typed by Nicole: ...',
};

function receiptRecord(operationId: string, wake?: ManagementSetupWake): ManagementReceiptOutboxRecord {
  return {
    outboxId: `receipt_${operationId}`,
    operationId,
    destination: { kind: 'thread', workspaceId: 'T1', channelId: 'D1', threadTs: '100.000100', ...(wake ? { wake } : {}) },
    receipt: {
      setupOperationId: operationId, connector: 'Tasks', target: 'Support', scopes: [], initiator: 'Nicole', completedAt: AT,
    },
    status: 'pending', attempts: 0, nextAttemptAt: AT, createdAt: AT, updatedAt: AT,
  };
}

async function drain(
  management: SqliteManagementStore,
  wake: ((request: SetupWakeRequest) => Promise<'queued' | 'refused'>) | undefined,
  posted: string[],
) {
  return drainManagementReceiptOutbox({
    management,
    now: () => AT,
    ...(wake ? { wake } : {}),
    deliver: async (record) => {
      posted.push(formatManagementSetupReceipt(record.receipt));
      return { deliveryRef: `slack:D1:${posted.length}` };
    },
  });
}

test('a queued wake posts no notice and is never queued again; a refused or failed wake posts the notice instead', async () => {
  const management = new SqliteManagementStore(':memory:');
  try {
    const requests: SetupWakeRequest[] = [];
    const posted: string[] = [];
    await management.putOutbox(receiptRecord('setup_woken', WAKE));
    await drain(management, async (request) => { requests.push(request); return 'queued'; }, posted);
    assert.deepEqual(requests, [{
      setupOperationId: 'setup_woken', workspaceId: 'T1', channelId: 'D1', threadTs: '100.000100',
      wake: WAKE, notice: '✅ Tasks is now connected to Support.',
    }]);
    assert.deepEqual(posted, [], 'the Agent\'s reply is the message');
    const settled = await management.getOutboxForOperation('setup_woken');
    assert.equal(settled?.status, 'delivered');
    assert.equal(settled?.deliveryRef, 'wake:setup_woken');
    await drain(management, async (request) => { requests.push(request); return 'queued'; }, posted);
    assert.equal(requests.length, 1, 'a settled wake is never queued again');

    await management.putOutbox(receiptRecord('setup_refused', WAKE));
    await drain(management, async () => 'refused', posted);
    assert.deepEqual(posted, ['✅ Tasks is now connected to Support.'], 'a wake that cannot run leaves the plain notice');
    assert.match((await management.getOutboxForOperation('setup_refused'))?.deliveryRef ?? '', /^slack:/);

    await management.putOutbox(receiptRecord('setup_threw', WAKE));
    await drain(management, async () => { throw new Error('installation unavailable'); }, posted);
    assert.equal(posted.length, 2, 'a wake that throws leaves the notice too');

    await management.putOutbox(receiptRecord('setup_no_hook', WAKE));
    await drain(management, undefined, posted);
    assert.equal(posted.length, 3, 'a drain that cannot wake posts the notice');

    const plain: SetupWakeRequest[] = [];
    await management.putOutbox(receiptRecord('setup_repository'));
    await drain(management, async (request) => { plain.push(request); return 'queued'; }, posted);
    assert.deepEqual(plain, [], 'a receipt with no wake never wakes anyone');
    assert.equal(posted.length, 4);
  } finally {
    management.close();
  }
});
