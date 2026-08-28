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
      targetRevisions: {}, at: NOW,
    });
    assert.equal(changeSet.proposalId, 'changeset_rpc');
    assert.equal((await proxy.getChangeSetProposal(changeSet.proposalId))?.digest, 'c'.repeat(64));
    assert.equal((await proxy.getActiveChangeSetProposal({
      organizationId: 'org_rpc',
      actorUserId: 'user_rpc',
      actorMembershipId: 'member_rpc',
      approvalScopeKey: 'mcp:client_rpc',
    }))?.proposalId, changeSet.proposalId);
    assert.deepEqual(calls.slice(-3).map(({ kind }) => kind), [
      'put_change_set_proposal',
      'get_change_set_proposal',
      'get_active_change_set_proposal',
    ]);

    const introduction = await proxy.claimIntroduction({
      organizationId: 'org_rpc',
      userId: 'user_rpc',
      workspaceId: 'T_RPC',
      slackUserId: 'U_RPC',
      trigger: 'first_interaction',
      at: NOW,
    });
    assert.equal(introduction.created, true);
    assert.equal(introduction.outbox?.destination.kind, 'slack_dm');
    const replay = await proxy.claimIntroduction({
      organizationId: 'org_rpc',
      userId: 'user_rpc',
      workspaceId: 'T_RPC',
      slackUserId: 'U_RPC',
      trigger: 'first_owner',
      at: NOW + 1,
    });
    assert.equal(replay.created, false);
    assert.deepEqual(calls.slice(-2).map(({ kind }) => kind), [
      'claim_introduction',
      'claim_introduction',
    ]);
  } finally {
    direct.close();
  }
});
