import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { CfManagementStore } from '../src/config/cf-state-proxies.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type { ManagementRpcRequest, PutManagementChangeSetProposalInput } from '../src/management/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'proposal-status-test-token';
const principal: AuthPrincipal = {
  userId: 'user_test_owner', membershipId: 'membership_test_owner', organizationId: 'org_oss',
  role: 'owner', authenticatorKind: 'test_slack_session', credentialId: 'session_test_owner',
  correlationId: 'request_test_owner', machine: false,
};
const scope = 'slack:T_TEST:C_UPDATE:1800000000.000100:agent:agent_update';
function proposal(id = 'proposal_one'): PutManagementChangeSetProposalInput {
  return {
    proposalId: id, organizationId: principal.organizationId,
    actorUserId: principal.userId, actorMembershipId: principal.membershipId,
    originKey: scope, approvalScopeKey: scope, idempotencyKey: id,
    guideVersion: 'test', authoringReason: 'agent_edit', digest: 'd'.repeat(64),
    operations: [{ itemId: 'update', kind: 'update_agent', agentId: 'agent_update', expectedRevision: 7,
      patch: { instructions: '<script>Full frozen instructions</script>', description: 'Frozen description' } }],
    preview: { summary: 'Private preview', changes: [], missingSetup: [] },
    targetRevisions: { 'agent:agent_update': 7 }, at: 1,
  };
}

test('Agent proposal query scopes before limiting, includes completed records, and survives Cloudflare RPC', async () => {
  const direct = new SqliteManagementStore(':memory:');
  const proxy = new CfManagementStore({
    managementExecute: async (request: ManagementRpcRequest) => ({ ok: true, value: await direct.execute(request) }),
  } as TagStateRpc);
  const query = { kind: 'list_agent_update_proposals', organizationId: principal.organizationId,
    actorUserId: principal.userId, actorMembershipId: principal.membershipId,
    workspaceId: 'T_TEST', agentId: 'agent_update' } as const;
  try {
    assert.deepEqual(await proxy.execute(query), { kind: 'change_set_proposals', proposals: [] });
    for (const id of ['one', 'two', 'three']) await direct.putChangeSetProposal(proposal(id));
    await direct.claimChangeSetProposal({ ...proposal('three'), at: 2 });
    await direct.completeChangeSetProposal('three', {
      operationId: 'result', idempotencyKey: 'result', status: 'completed', effectiveRevision: 'revision',
      activation: 'next_turn', outcomes: [],
    }, 3);
    const base = proposal();
    for (const [id, patch] of Object.entries({
      org: { organizationId: 'other' }, user: { actorUserId: 'other' }, member: { actorMembershipId: 'other' },
      workspace: { originKey: scope.replace('T_TEST:', 'T_TEST_OTHER:'), approvalScopeKey: 'other' },
      agent: { operations: [{ itemId: 'update', kind: 'update_agent' as const, agentId: 'other', expectedRevision: 7, patch: { instructions: 'foreign' } }] },
      kind: { operations: [{ itemId: 'archive', kind: 'archive_agent' as const, agentId: 'agent_update', expectedRevision: 7 }] },
    })) await direct.putChangeSetProposal({ ...base, proposalId: id, idempotencyKey: id, at: 10, ...patch });
    const before = await direct.getChangeSetProposal('three');
    const result = await proxy.execute(query);
    assert.equal(result.kind, 'change_set_proposals');
    if (result.kind !== 'change_set_proposals') throw new Error('wrong RPC response');
    assert.deepEqual(result.proposals.map((row) => row.proposalId), ['three', 'two']);
    assert.equal(result.proposals[0]?.status, 'completed');
    assert.deepEqual(await direct.getChangeSetProposal('three'), before);
    // Creation time wins over insertion order; equal times use the row ID.
    await direct.putChangeSetProposal({ ...proposal('newer'), at: 20 });
    await direct.putChangeSetProposal({ ...proposal('older-inserted-last'), at: 0 });
    const reordered = await proxy.execute(query);
    assert.equal(reordered.kind, 'change_set_proposals');
    if (reordered.kind !== 'change_set_proposals') throw new Error('wrong RPC response');
    assert.deepEqual(reordered.proposals.map((row) => row.proposalId), ['newer', 'three']);
  } finally { direct.close(); }
});

test('Agent proposal details are own-requester, read-only, and project only this Agent instruction changes', async () => {
  const store = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const management = new SqliteManagementStore(':memory:');
  let linked = true;
  const sourceIdentity = {
    recordAuthAudit: async () => undefined,
    getUser: async () => ({ id: principal.userId, slackTeamId: 'T_TEST', slackUserId: 'U_OWNER' }),
    resolveSlackIdentity: async (teamId: string, userId: string, organizationId: string) => {
      assert.deepEqual([teamId, userId, organizationId], ['T_TEST', 'U_OWNER', principal.organizationId]);
      return linked ? {
        user: { id: principal.userId },
        membership: { id: principal.membershipId, organizationId: principal.organizationId, status: 'active' },
        binding: { slackTeamId: 'T_TEST', slackUserId: 'U_OWNER' },
      } : undefined;
    },
  } as unknown as IdentityStore;
  const makeApp = (actor = principal) => createAdminRoutes({
    store, settings, management, ...testAdminAuthority(TOKEN, undefined, sourceIdentity, actor),
  });
  const path = '/admin/api/runtime/agents/agent_update/proposal-status';
  const headers = testAdminHeaders(TOKEN);
  try {
    await store.createAgent({ id: 'agent_update', name: 'Update', instructions: 'Saved instructions', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [] });
    const input = proposal();
    input.operations.push({ itemId: 'foreign', kind: 'update_agent', agentId: 'other', expectedRevision: 1,
      patch: { instructions: 'NEVER_DISCLOSE_OTHER_AGENT' } });
    input.targetRevisions['agent:other'] = 1;
    await management.putChangeSetProposal(input);
    await management.claimChangeSetProposal({ ...input, at: 2 });
    await management.completeChangeSetProposal(input.proposalId, {
      operationId: 'result', idempotencyKey: 'private-key', status: 'completed', effectiveRevision: 'revision',
      activation: 'next_turn', outcomes: [{ itemId: 'update', operationKind: 'update_agent', disposition: 'applied',
        changed: [{ kind: 'agent', id: 'agent_update', revision: 8 }, { kind: 'agent', id: 'other', revision: 2 }],
        setupUrl: 'https://example.test/SECRET_SETUP_TOKEN', warning: 'PRIVATE_WARNING' }],
    }, 3);
    const before = await management.getChangeSetProposal(input.proposalId);
    const app = makeApp();
    assert.notEqual((await app.request(path)).status, 200);
    for (const actor of [{ ...principal, role: 'member' as const }, { ...principal, machine: true }]) {
      assert.equal((await makeApp(actor).request(path, { headers })).status, 403);
    }
    const response = await app.request(path, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { agentId: 'agent_update', requester: { userId: principal.userId,
      membershipId: principal.membershipId, slackUserId: 'U_OWNER' }, proposals: [{
      proposalId: input.proposalId, actorUserId: principal.userId, actorMembershipId: principal.membershipId,
      originKey: scope, approvalScopeKey: scope, status: 'completed', digest: input.digest,
      targetRevision: 7, operationCount: 2, createdAt: 1, updatedAt: 3,
      approval: { proposalId: input.proposalId, workspaceId: 'T_TEST', channelId: 'C_UPDATE',
        threadTs: '1800000000.000100', actingAgentId: 'agent_update', requesterUserId: 'U_OWNER',
        requesterMembershipId: principal.membershipId, turns: [] },
      updates: [{ itemId: 'update', kind: 'update_agent', agentId: 'agent_update', expectedRevision: 7, fields: ['description', 'instructions'],
        instructions: '<script>Full frozen instructions</script>', description: 'Frozen description' }],
      result: { status: 'completed', outcomes: [{ itemId: 'update', disposition: 'applied',
        changed: [{ kind: 'agent', id: 'agent_update', revision: 8 }] }] },
    }] });
    assert.doesNotMatch(JSON.stringify(body), /NEVER_DISCLOSE|SECRET_SETUP_TOKEN|PRIVATE_WARNING|Private preview|private-key/);
    assert.deepEqual(await management.getChangeSetProposal(input.proposalId), before);
    const foreign = await makeApp({ ...principal, userId: 'other', membershipId: 'other' }).request(path, { headers });
    assert.deepEqual((await foreign.json()).proposals, []);
    linked = false;
    assert.equal((await (await app.request(path, { headers })).json()).requester.slackUserId, null);
    assert.equal((await app.request(path.replace('agent_update', 'missing'), { headers })).status, 404);
  } finally { management.close(); settings.close(); store.close(); }
});
