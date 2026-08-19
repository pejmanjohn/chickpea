import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditStoreLogic } from '../src/audit/store.ts';
import { ManagementStoreLogic, SqliteManagementStore } from '../src/management/store.ts';
import { ManagementError, type ManagementApplyResult } from '../src/management/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const NOW = 1_800_000_000_000;
const operation = {
  itemId: 'create',
  kind: 'create_agent' as const,
  agent: {
    id: 'agent_test',
    name: 'Test',
    instructions: 'Help with tests.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

test('management request reservations are retry-stable and digest-bound', async () => {
  const store = new SqliteManagementStore(':memory:');
  try {
    const input = {
      operationId: 'operation_1',
      organizationId: 'org_1',
      actorUserId: 'user_1',
      actorMembershipId: 'member_1',
      originKey: 'mcp:client_1',
      idempotencyKey: 'idem_1',
      digest: 'a'.repeat(64),
      operations: [operation],
      at: NOW,
    };
    assert.equal((await store.reserveRequest(input)).created, true);
    const replay = await store.reserveRequest({ ...input, operationId: 'operation_other' });
    assert.equal(replay.created, false);
    assert.equal(replay.request.operationId, 'operation_1');
    await assert.rejects(
      () => store.reserveRequest({ ...input, operationId: 'operation_2', digest: 'b'.repeat(64) }),
      (error: unknown) => error instanceof ManagementError && error.code === 'idempotency_conflict',
    );

    await store.markRequestApplying('operation_1', NOW + 1);
    const result: ManagementApplyResult = {
      operationId: 'operation_1',
      idempotencyKey: 'idem_1',
      status: 'completed',
      outcomes: [{
        itemId: 'create',
        operationKind: 'create_agent',
        disposition: 'applied',
        changed: [{ kind: 'agent', id: 'agent_test', revision: 1 }],
      }],
      effectiveRevision: 'c'.repeat(32),
      activation: 'next_turn',
    };
    await store.completeRequest('operation_1', result, NOW + 2);
    assert.deepEqual((await store.completeRequest('operation_1', result, NOW + 3)).result, result);
  } finally {
    store.close();
  }
});

test('confirmation proposals are actor, origin, expiry, and single-use bound', async () => {
  const store = new SqliteManagementStore(':memory:');
  try {
    const proposal = await store.putProposal({
      proposalId: 'proposal_1',
      organizationId: 'org_1',
      actorUserId: 'user_1',
      actorMembershipId: 'member_1',
      originKey: 'slack:T1:C1:1.0',
      operation: {
        itemId: 'delete',
        kind: 'delete_agent',
        agentId: 'agent_test',
        expectedRevision: 1,
      },
      summary: 'agent_deletion:delete_agent:agent_test',
      targetRevisions: { 'agent:agent_test': 1 },
      expiresAt: NOW + 1_000,
      at: NOW,
    });
    assert.equal(proposal.status, 'pending');
    await assert.rejects(
      () => store.claimProposal({
        proposalId: proposal.proposalId,
        organizationId: 'org_1',
        actorUserId: 'user_1',
        actorMembershipId: 'member_1',
        originKey: 'slack:T1:C2:1.0',
        at: NOW + 1,
      }),
      (error: unknown) => error instanceof ManagementError &&
        error.code === 'proposal_binding_mismatch',
    );
    assert.equal((await store.getProposal('proposal_1'))?.status, 'pending');
    assert.equal((await store.claimProposal({
      proposalId: proposal.proposalId,
      organizationId: 'org_1',
      actorUserId: 'user_1',
      actorMembershipId: 'member_1',
      originKey: 'slack:T1:C1:1.0',
      at: NOW + 1,
    })).status, 'applying');

    await store.putProposal({
      proposalId: 'proposal_expired',
      organizationId: 'org_1',
      actorUserId: 'user_1',
      actorMembershipId: 'member_1',
      originKey: 'mcp:client_1',
      operation: operation,
      summary: 'test',
      targetRevisions: {},
      expiresAt: NOW,
      at: NOW - 1,
    });
    await assert.rejects(
      () => store.claimProposal({
        proposalId: 'proposal_expired',
        organizationId: 'org_1',
        actorUserId: 'user_1',
        actorMembershipId: 'member_1',
        originKey: 'mcp:client_1',
        at: NOW,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'proposal_expired',
    );
  } finally {
    store.close();
  }
});

test('terminal management writes append one allowlisted, secret-free audit receipt', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ManagementStoreLogic(db);
    store.reserveRequest({
      operationId: 'operation_audit',
      organizationId: 'org_audit',
      actorUserId: 'user_audit',
      actorMembershipId: 'member_audit',
      originKey: 'mcp:client_audit',
      idempotencyKey: 'idem_audit',
      digest: 'a'.repeat(64),
      operations: [operation],
      at: NOW,
    });
    store.markRequestApplying('operation_audit', NOW + 1);
    const result: ManagementApplyResult = {
      operationId: 'operation_audit',
      idempotencyKey: 'idem_audit',
      status: 'completed',
      outcomes: [{
        itemId: 'create',
        operationKind: 'create_agent',
        disposition: 'applied',
        changed: [{ kind: 'agent', id: 'agent_test', revision: 1 }],
      }],
      effectiveRevision: 'c'.repeat(32),
      activation: 'next_turn',
    };
    store.completeRequest('operation_audit', result, NOW + 2);
    store.completeRequest('operation_audit', result, NOW + 3);
    const events = new AuditStoreLogic(db).list({ domain: 'management' });
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0]!.metadataJson), {
      operationId: 'operation_audit',
      outcomeCount: '1',
      status: 'completed',
    });
    assert.doesNotMatch(events[0]!.metadataJson, /instruction|credential|token|secret/i);
  } finally {
    db.close();
  }
});
