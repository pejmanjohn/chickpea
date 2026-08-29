import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfManagementStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import {
  ManagementError,
  type ManagementRpcRequest,
  type ManagementRpcResponse,
} from '../src/management/types.ts';

const NOW = 1_800_000_000_000;

test('Cloudflare management proxy preserves the canonical ledger contract and typed errors', async () => {
  const direct = new SqliteManagementStore(':memory:');
  const calls: ManagementRpcRequest[] = [];
  const stub = {
    async managementExecute(request: ManagementRpcRequest): Promise<StateRpcResult<ManagementRpcResponse>> {
      calls.push(request);
      try {
        return { ok: true, value: await direct.execute(request) };
      } catch (error) {
        if (error instanceof ManagementError) {
          return {
            ok: false,
            error: {
              code: 'management',
              message: error.message,
              details: { managementCode: error.code },
            },
          };
        }
        throw error;
      }
    },
  } as TagStateRpc;
  const proxy = new CfManagementStore(stub);
  const input = {
    operationId: 'operation_rpc',
    organizationId: 'org_rpc',
    actorUserId: 'user_rpc',
    actorMembershipId: 'member_rpc',
    originKey: 'mcp:client_rpc',
    idempotencyKey: 'idem_rpc',
    digest: 'a'.repeat(64),
    operations: [{
      itemId: 'create',
      kind: 'create_agent' as const,
      agent: {
        id: 'agent_rpc',
        name: 'RPC Agent',
        instructions: 'Exercise the management RPC.',
        enabled: true,
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      },
    }],
    at: NOW,
  };
  try {
    const reserved = await proxy.reserveRequest(input);
    assert.equal(reserved.created, true);
    assert.equal((await proxy.getRequest('operation_rpc'))?.idempotencyKey, 'idem_rpc');
    await assert.rejects(
      () => proxy.reserveRequest({ ...input, digest: 'b'.repeat(64) }),
      (error: unknown) => error instanceof ManagementError &&
        error.code === 'idempotency_conflict',
    );
    assert.equal((await proxy.failRequest('operation_rpc', NOW + 1)).status, 'failed');
    assert.equal((await proxy.failRequest('operation_rpc', NOW + 2)).updatedAt, NOW + 1);
    assert.deepEqual(calls.map(({ kind }) => kind), [
      'reserve_request',
      'get_request',
      'reserve_request',
      'fail_request',
      'fail_request',
    ]);

    const changeSet = await proxy.putChangeSetProposal({
      proposalId: 'changeset_rpc',
      organizationId: 'org_rpc', actorUserId: 'user_rpc', actorMembershipId: 'member_rpc',
      originKey: 'mcp:client_rpc', idempotencyKey: 'changeset-rpc', guideVersion: '1.0.0',
      authoringReason: 'agent_creation', operations: input.operations, digest: 'c'.repeat(64),
      preview: { summary: 'RPC change set', changes: [], missingSetup: [] },
      targetRevisions: {}, expiresAt: NOW + 1_000, at: NOW,
    });
    assert.equal(changeSet.proposalId, 'changeset_rpc');
    assert.equal((await proxy.getChangeSetProposal(changeSet.proposalId))?.digest, 'c'.repeat(64));
    assert.equal(await proxy.hasPendingChangeSetProposal({
      organizationId: changeSet.organizationId,
      actorUserId: changeSet.actorUserId,
      actorMembershipId: changeSet.actorMembershipId,
      originKey: changeSet.originKey,
      at: NOW,
    }), true);
    assert.deepEqual(calls.slice(-3).map(({ kind }) => kind), [
      'put_change_set_proposal',
      'get_change_set_proposal',
      'has_pending_change_set_proposal',
    ]);

    const setupRecord = {
      setupOperationId: 'setup_rpc_reusable',
      organizationId: 'org_rpc',
      actorUserId: 'user_rpc',
      actorMembershipId: 'member_rpc',
      origin: {
        kind: 'slack' as const,
        workspaceId: 'T_RPC',
        channelId: 'D_RPC',
        threadTs: '1800000000.000100',
        agentId: 'agent_rpc',
      },
      action: 'managed_connection' as const,
      target: {
        kind: 'managed_connection' as const,
        provider: 'hubspot',
        targetId: 'agent:agent_rpc:managed:hubspot:member',
        targetLabel: 'HubSpot',
        expectedRevision: 1,
        agentId: 'agent_rpc',
        agentName: 'RPC Agent',
        replacement: false,
        ownerKind: 'member' as const,
        accessLane: 'read' as const,
      },
      scopes: ['hubspot.objects.search'],
      tokenDigest: 'd'.repeat(64),
      status: 'pending' as const,
      expiresAt: NOW + 60_000,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await proxy.putSetup({ record: setupRecord });
    assert.equal((await proxy.getSetup(setupRecord.setupOperationId))?.status, 'pending');
    const receipt = {
      kind: 'connector_connected' as const,
      setupOperationId: setupRecord.setupOperationId,
      connector: 'HubSpot',
      toolkit: 'hubspot',
      agentId: 'agent_rpc',
      agentName: 'RPC Agent',
      ownerKind: 'member' as const,
      accessLane: 'read' as const,
      completedAt: NOW + 1,
    };
    const completed = await proxy.completeSetup({
      setupOperationId: setupRecord.setupOperationId,
      browserSessionDigest: setupRecord.tokenDigest,
      completedByUserId: 'user_completer',
      completedByMembershipId: 'member_completer',
      connectionAccountId: 'account_rpc',
      receipt,
      outbox: {
        outboxId: `receipt_${setupRecord.setupOperationId}`,
        operationId: setupRecord.setupOperationId,
        destination: {
          kind: 'thread',
          workspaceId: 'T_RPC',
          channelId: 'D_RPC',
          threadTs: '1800000000.000100',
        },
        receipt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: NOW + 1,
        createdAt: NOW + 1,
        updatedAt: NOW + 1,
      },
      at: NOW + 1,
    });
    assert.equal(completed.completedByMembershipId, 'member_completer');
    assert.equal(completed.connectionAccountId, 'account_rpc');
  } finally {
    direct.close();
  }
});
