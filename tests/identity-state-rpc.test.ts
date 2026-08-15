import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfIdentityStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import type {
  IdentityResolution,
  IdentityRpcRequest,
  IdentityRpcResponse,
} from '../src/identity/types.ts';

const resolution: IdentityResolution = {
  user: {
    id: 'user_owner', slackTeamId: 'T_ACME', slackUserId: 'U_OWNER',
    displayName: 'Owner', createdAt: 10, updatedAt: 10,
  },
  membership: {
    id: 'membership_owner', organizationId: 'org_oss', userId: 'user_owner',
    role: 'owner', status: 'active', createdAt: 10, updatedAt: 10,
  },
  binding: {
    id: 'binding_owner', provider: 'slack', slackTeamId: 'T_ACME', slackUserId: 'U_OWNER',
    userId: 'user_owner', organizationId: 'org_oss', membershipId: 'membership_owner',
    betterAuthUserId: 'ba_user_owner', betterAuthMembershipId: 'ba_member_owner',
    revision: 1, createdAt: 10, updatedAt: 10,
  },
};

test('Cloudflare identity proxy forwards the canonical Slack tuple operation', async () => {
  const calls: IdentityRpcRequest[] = [];
  const stub = rpcStub(calls, { kind: 'identity_resolution', resolution });
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.resolveSlackIdentity('T_ACME', 'U_OWNER', 'org_oss'), resolution);
  assert.deepEqual(calls, [{
    kind: 'resolve_slack_identity',
    slackTeamId: 'T_ACME',
    slackUserId: 'U_OWNER',
    organizationId: 'org_oss',
  }]);
});

test('actor lookup aliases the same exact Slack tuple and no parallel binding RPC', async () => {
  const calls: IdentityRpcRequest[] = [];
  const stub = rpcStub(calls, { kind: 'identity_resolution', resolution });
  const store = new CfIdentityStore(stub);

  assert.deepEqual(
    await store.resolveActorExternalIdentity('slack', 'T_ACME', 'U_OWNER'),
    resolution.binding,
  );
  assert.deepEqual(calls, [{
    kind: 'resolve_slack_identity', slackTeamId: 'T_ACME', slackUserId: 'U_OWNER',
  }]);
});

test('Cloudflare proxy forwards Slack-keyed operation reservations', async () => {
  const calls: IdentityRpcRequest[] = [];
  const input = {
    id: 'login_1', kind: 'login' as const, organizationId: 'org_oss',
    expectedSlackTeamId: 'T_ACME', expectedSlackUserId: 'U_OWNER',
    capabilityHash: 'a'.repeat(64), expiresAt: 20,
  };
  const operation = {
    id: 'login_1', kind: 'login' as const, organizationId: 'org_oss',
    expectedSlackTeamId: 'T_ACME', expectedSlackUserId: 'U_OWNER', chickpeaRole: null,
    capabilityHash: 'a'.repeat(64), status: 'reserved' as const, step: 0,
    betterAuthUserId: null, betterAuthOrganizationId: null, betterAuthMembershipId: null,
    chickpeaMembershipId: null, expiresAt: 20, activatedAt: null, tombstonedAt: null,
    createdAt: 10, updatedAt: 10,
  };
  const stub = rpcStub(calls, {
    kind: 'auth_operation_reservation', operation, created: true,
  });
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.reservePendingAuthOperation(input), { operation, created: true });
  assert.deepEqual(calls, [{ kind: 'reserve_pending_auth_operation', input }]);
});

function rpcStub(
  calls: IdentityRpcRequest[],
  response: IdentityRpcResponse,
): TagStateRpc {
  return {
    async identityExecute(request: IdentityRpcRequest): Promise<StateRpcResult<IdentityRpcResponse>> {
      calls.push(request);
      return { ok: true, value: response };
    },
  } as unknown as TagStateRpc;
}
