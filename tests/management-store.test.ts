import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditStoreLogic } from '../src/audit/store.ts';
import { ManagementStoreLogic, SqliteManagementStore } from '../src/management/store.ts';
import {
  ManagementError,
  type ManagementApplyResult,
  type PutManagementChangeSetProposalInput,
} from '../src/management/types.ts';
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

test('change-set proposal schema migration preserves legacy rows and adds provenance columns', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec(`CREATE TABLE management_change_set_proposals (
      proposal_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_membership_id TEXT NOT NULL,
      origin_key TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      target_revisions_json TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.run(
      `INSERT INTO management_change_set_proposals (
        proposal_id, organization_id, actor_user_id, actor_membership_id, origin_key,
        operations_json, digest, preview_json, target_revisions_json, status,
        result_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      'changeset_legacy', 'org_1', 'user_1', 'member_1', 'mcp:client_1',
      JSON.stringify([operation]), 'f'.repeat(64),
      JSON.stringify({ summary: 'Legacy change set', changes: [], missingSetup: [] }),
      '{}', NOW + 1_000, NOW, NOW,
    );

    const store = new ManagementStoreLogic(db);
    const columns = new Set((db.all(
      'PRAGMA table_info(management_change_set_proposals)',
    ) as Array<{ name: string }>).map(({ name }) => name));
    assert.ok(columns.has('idempotency_key'));
    assert.ok(columns.has('guide_version'));
    assert.ok(columns.has('authoring_reason'));
    assert.deepEqual(store.getChangeSetProposal('changeset_legacy'), {
      proposalId: 'changeset_legacy',
      organizationId: 'org_1',
      actorUserId: 'user_1',
      actorMembershipId: 'member_1',
      originKey: 'mcp:client_1',
      idempotencyKey: 'legacy:changeset_legacy',
      guideVersion: 'unknown',
      authoringReason: 'agent_edit',
      operations: [operation],
      digest: 'f'.repeat(64),
      preview: { summary: 'Legacy change set', changes: [], missingSetup: [] },
      targetRevisions: {},
      status: 'pending',
      expiresAt: NOW + 1_000,
      createdAt: NOW,
      updatedAt: NOW,
    });
  } finally {
    db.close();
  }
});

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

test('change-set proposals coexist with legacy proposals and preserve exact typed operations', async () => {
  const store = new SqliteManagementStore(':memory:');
  try {
    await store.putProposal({
      proposalId: 'proposal_legacy',
      organizationId: 'org_1', actorUserId: 'user_1', actorMembershipId: 'member_1',
      originKey: 'mcp:client_1', operation, summary: 'legacy', targetRevisions: {},
      expiresAt: NOW + 1_000, at: NOW,
    });
    const changeSetInput: PutManagementChangeSetProposalInput = {
      proposalId: 'changeset_1',
      organizationId: 'org_1', actorUserId: 'user_1', actorMembershipId: 'member_1',
      originKey: 'mcp:client_1', idempotencyKey: 'change-set-1', guideVersion: '1.0.0',
      authoringReason: 'agent_creation' as const, operations: [operation], digest: 'd'.repeat(64),
      preview: {
        summary: 'Create Test',
        changes: [{ itemId: 'create', operationKind: 'create_agent', target: 'agent:agent_test' }],
        missingSetup: [],
      },
      targetRevisions: {}, expiresAt: NOW + 1_000, at: NOW,
    };
    const changeSet = await store.putChangeSetProposal(changeSetInput);
    assert.equal((await store.getProposal('proposal_legacy'))?.operation.kind, 'create_agent');
    assert.equal(await store.getProposal('changeset_1'), undefined);
    assert.equal(await store.getChangeSetProposal('proposal_legacy'), undefined);
    assert.deepEqual(changeSet.operations, [operation]);
    assert.equal(changeSet.digest, 'd'.repeat(64));
    assert.equal(changeSet.idempotencyKey, 'change-set-1');
    assert.equal(changeSet.guideVersion, '1.0.0');
    assert.equal(changeSet.authoringReason, 'agent_creation');
    assert.equal(changeSet.status, 'pending');
    const replay = await store.putChangeSetProposal({
      ...changeSetInput,
      proposalId: 'changeset_retry',
      at: NOW + 1,
    });
    assert.equal(replay.proposalId, changeSet.proposalId);
    await assert.rejects(
      () => store.putChangeSetProposal({
        ...changeSetInput,
        proposalId: 'changeset_conflict',
        digest: 'c'.repeat(64),
        at: NOW + 1,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'idempotency_conflict',
    );

    await assert.rejects(
      () => store.claimChangeSetProposal({
        proposalId: 'changeset_1', organizationId: 'org_1', actorUserId: 'user_1',
        actorMembershipId: 'member_1', originKey: 'slack:T1:C1:1.0', at: NOW + 1,
      }),
      (error: unknown) => error instanceof ManagementError &&
        error.code === 'proposal_binding_mismatch',
    );
    assert.equal((await store.getChangeSetProposal('changeset_1'))?.status, 'pending');
    const applying = await store.claimChangeSetProposal({
      proposalId: 'changeset_1', organizationId: 'org_1', actorUserId: 'user_1',
      actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: NOW + 1,
    });
    assert.equal(applying.status, 'applying');
    await assert.rejects(
      () => store.claimChangeSetProposal({
        proposalId: 'changeset_1', organizationId: 'org_1', actorUserId: 'user_1',
        actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: NOW + 2,
      }),
      (error: unknown) => error instanceof ManagementError &&
        error.code === 'operation_in_progress',
    );
    const reclaimed = await store.reclaimChangeSetProposal({
      proposalId: 'changeset_1', organizationId: 'org_1', actorUserId: 'user_1',
      actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: NOW + 2,
      expectedUpdatedAt: applying.updatedAt,
    });
    assert.ok(reclaimed.updatedAt > applying.updatedAt);
    await assert.rejects(
      () => store.reclaimChangeSetProposal({
        proposalId: 'changeset_1', organizationId: 'org_1', actorUserId: 'user_1',
        actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: NOW + 3,
        expectedUpdatedAt: applying.updatedAt,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'operation_in_progress',
    );
    await store.markChangeSetProposalStale('changeset_1', NOW + 4);
    await assert.rejects(
      () => store.putChangeSetProposal({
        ...changeSetInput,
        proposalId: 'changeset_stale_replay',
        at: NOW + 5,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'proposal_stale',
    );
  } finally {
    store.close();
  }
});

test('change-set proposals expire, stale, complete once, and are retained independently', async () => {
  const store = new SqliteManagementStore(':memory:');
  const put = (
    proposalId: string,
    expiresAt: number,
    at = NOW,
    idempotencyKey = proposalId,
  ) => store.putChangeSetProposal({
    proposalId,
    organizationId: 'org_1', actorUserId: 'user_1', actorMembershipId: 'member_1',
    originKey: 'mcp:client_1', idempotencyKey, guideVersion: '1.0.0',
    authoringReason: 'agent_creation', operations: [operation], digest: 'e'.repeat(64),
    preview: { summary: 'Change set', changes: [], missingSetup: [] },
    targetRevisions: {}, expiresAt, at,
  });
  try {
    await put('changeset_expired', NOW, NOW - 1);
    await assert.rejects(
      () => store.claimChangeSetProposal({
        proposalId: 'changeset_expired', organizationId: 'org_1', actorUserId: 'user_1',
        actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: NOW,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'proposal_expired',
    );
    assert.equal((await store.getChangeSetProposal('changeset_expired'))?.status, 'expired');

    await put('changeset_stale', NOW + 1_000);
    assert.equal((await store.markChangeSetProposalStale('changeset_stale', NOW + 1)).status, 'stale');
    await assert.rejects(
      () => store.claimChangeSetProposal({
        proposalId: 'changeset_stale', organizationId: 'org_1', actorUserId: 'user_1',
        actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: NOW + 2,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'proposal_stale',
    );

    await put('changeset_complete', NOW + 1_000);
    await store.claimChangeSetProposal({
      proposalId: 'changeset_complete', organizationId: 'org_1', actorUserId: 'user_1',
      actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: NOW + 1,
    });
    const result: ManagementApplyResult = {
      operationId: 'changeset_complete', idempotencyKey: 'confirmation:changeset_complete',
      status: 'completed', outcomes: [], effectiveRevision: 'f'.repeat(32), activation: 'next_turn',
    };
    assert.equal((await store.completeChangeSetProposal(
      'changeset_complete', result, NOW + 2,
    )).status, 'completed');
    assert.deepEqual((await store.completeChangeSetProposal(
      'changeset_complete', result, NOW + 3,
    )).result, result);
    await assert.rejects(
      () => put('changeset_complete_retry', NOW + 1_000, NOW + 4, 'changeset_complete'),
      (error: unknown) => error instanceof ManagementError && error.code === 'proposal_stale',
    );

    await put('changeset_expired_replay', NOW + 10, NOW);
    await assert.rejects(
      () => put(
        'changeset_expired_retry',
        NOW + 10,
        NOW + 11,
        'changeset_expired_replay',
      ),
      (error: unknown) => error instanceof ManagementError && error.code === 'proposal_expired',
    );
    assert.equal((await store.getChangeSetProposal('changeset_expired_replay'))?.status, 'expired');
  } finally {
    store.close();
  }
});

test('management retention removes terminal rows and abandoned expired change sets beyond 30 days', async () => {
  const store = new SqliteManagementStore(':memory:');
  const old = NOW - 31 * 24 * 60 * 60_000;
  try {
    await store.reserveRequest({
      operationId: 'old_terminal', organizationId: 'org_1', actorUserId: 'user_1',
      actorMembershipId: 'member_1', originKey: 'mcp:client_1', idempotencyKey: 'old',
      digest: 'a'.repeat(64), operations: [operation], at: old,
    });
    await store.completeRequest('old_terminal', {
      operationId: 'old_terminal', idempotencyKey: 'old', status: 'completed',
      outcomes: [], effectiveRevision: 'b'.repeat(64), activation: 'next_turn',
    }, old);
    await store.reserveRequest({
      operationId: 'old_pending', organizationId: 'org_1', actorUserId: 'user_1',
      actorMembershipId: 'member_1', originKey: 'mcp:client_1', idempotencyKey: 'pending',
      digest: 'c'.repeat(64), operations: [operation], at: old,
    });
    const putAbandoned = (proposalId: string) => store.putChangeSetProposal({
      proposalId,
      organizationId: 'org_1', actorUserId: 'user_1', actorMembershipId: 'member_1',
      originKey: 'mcp:client_1', idempotencyKey: proposalId, guideVersion: '1.0.0',
      authoringReason: 'agent_creation', operations: [operation], digest: 'd'.repeat(64),
      preview: { summary: 'Abandoned change set', changes: [], missingSetup: [] },
      targetRevisions: {}, expiresAt: old, at: old - 1,
    });
    await putAbandoned('old_pending_change_set');
    await putAbandoned('old_applying_change_set');
    await store.claimChangeSetProposal({
      proposalId: 'old_applying_change_set', organizationId: 'org_1', actorUserId: 'user_1',
      actorMembershipId: 'member_1', originKey: 'mcp:client_1', at: old - 1,
    });
    assert.equal(await store.cleanupRetention(NOW), 3);
    assert.equal(await store.getRequest('old_terminal'), undefined);
    assert.ok(await store.getRequest('old_pending'));
    assert.equal(await store.getChangeSetProposal('old_pending_change_set'), undefined);
    assert.equal(await store.getChangeSetProposal('old_applying_change_set'), undefined);
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
      originKey: 'slack:T1:C1:1.0:agent:agent_chickpea',
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
      actingAgentId: 'agent_chickpea',
      authorization: 'live_membership_and_acting_agent',
      operationCount: '1',
      operationId: 'operation_audit',
      operationKind: 'create_agent',
      outcomeCount: '1',
      status: 'completed',
      target: 'agent:agent_test',
      targetCount: '1',
    });
    assert.doesNotMatch(events[0]!.metadataJson, /instruction|credential|token|secret/i);
  } finally {
    db.close();
  }
});
