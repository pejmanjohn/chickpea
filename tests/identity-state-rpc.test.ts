import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfIdentityStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { IdentityStateError } from '../src/identity/errors.ts';
import type { IdentityRpcRequest, IdentityRpcResponse } from '../src/identity/types.ts';

test('Cloudflare identity proxy forwards lifecycle requests and typed values', async () => {
  const calls: IdentityRpcRequest[] = [];
  const organization = {
    id: 'org_oss', displayName: 'Chickpea', authMode: 'unconfigured' as const,
    canonicalAdminOrigin: null, createdAt: 10, updatedAt: 10,
  };
  const stub = {
    async identityExecute(request: IdentityRpcRequest): Promise<StateRpcResult<IdentityRpcResponse>> {
      calls.push(request);
      return { ok: true, value: { kind: 'organization', organization } };
    },
  } as unknown as TagStateRpc;

  const store = new CfIdentityStore(stub);
  assert.deepEqual(await store.ensureOrganization({ displayName: 'Chickpea' }), organization);
  assert.deepEqual(calls, [{ kind: 'ensure_organization', input: { displayName: 'Chickpea' } }]);
});

test('Cloudflare identity proxy forwards resumable operation state without provider types', async () => {
  const calls: IdentityRpcRequest[] = [];
  const operation = {
    id: 'operation_setup_1', kind: 'owner_setup' as const,
    organizationId: null, expectedNormalizedEmail: 'owner@example.com',
    capabilityHash: 'a'.repeat(64), status: 'pending' as const, step: 1,
    betterAuthUserId: 'opaque-user', betterAuthOrganizationId: null,
    betterAuthMembershipId: null, betterAuthInvitationId: null,
    targetCredentialVersion: null, expiresAt: 20, consumedAt: null,
    revokedAt: null, createdAt: 10, updatedAt: 10,
  };
  const stub = {
    async identityExecute(request: IdentityRpcRequest): Promise<StateRpcResult<IdentityRpcResponse>> {
      calls.push(request);
      return { ok: true, value: { kind: 'auth_operation', operation } };
    },
  } as unknown as TagStateRpc;
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.advanceAuthOperation({
    operationId: operation.id,
    capabilityHash: operation.capabilityHash,
    step: 1,
    betterAuthUserId: 'opaque-user',
  }), operation);
  assert.deepEqual(calls, [{
    kind: 'advance_auth_operation',
    input: {
      operationId: operation.id,
      capabilityHash: operation.capabilityHash,
      step: 1,
      betterAuthUserId: 'opaque-user',
    },
  }]);
});

test('Cloudflare identity proxy forwards pending operation reservations', async () => {
  const calls: IdentityRpcRequest[] = [];
  const input = {
    id: 'operation_invite_1',
    kind: 'invitation_enrollment' as const,
    organizationId: 'better-org',
    expectedEmail: 'invitee@example.com',
    capabilityHash: 'a'.repeat(64),
    expiresAt: 20,
  };
  const operation = {
    id: input.id, kind: input.kind, organizationId: input.organizationId,
    expectedNormalizedEmail: input.expectedEmail, capabilityHash: input.capabilityHash,
    status: 'pending' as const, step: 0, betterAuthUserId: null,
    betterAuthOrganizationId: null, betterAuthMembershipId: null,
    betterAuthInvitationId: null, targetCredentialVersion: null,
    expiresAt: input.expiresAt, consumedAt: null, revokedAt: null,
    createdAt: 10, updatedAt: 10,
  };
  const stub = {
    async identityExecute(request: IdentityRpcRequest): Promise<StateRpcResult<IdentityRpcResponse>> {
      calls.push(request);
      return {
        ok: true,
        value: { kind: 'auth_operation_reservation', operation, created: false },
      };
    },
  } as unknown as TagStateRpc;
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.reservePendingAuthOperation(input), { operation, created: false });
  assert.deepEqual(calls, [{ kind: 'reserve_pending_auth_operation', input }]);
});

test('Cloudflare identity proxy reads Chickpea membership access overlays', async () => {
  const calls: IdentityRpcRequest[] = [];
  const overlay = {
    membershipId: 'better-member',
    organizationId: 'better-org',
    accessStatus: 'suspended' as const,
    membershipVersion: 3,
    createdAt: 10,
    updatedAt: 20,
  };
  const stub = {
    async identityExecute(request: IdentityRpcRequest): Promise<StateRpcResult<IdentityRpcResponse>> {
      calls.push(request);
      return { ok: true, value: { kind: 'membership_access_overlay', overlay } };
    },
  } as unknown as TagStateRpc;
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.getMembershipAccessOverlay(overlay.membershipId), overlay);
  assert.deepEqual(calls, [{
    kind: 'get_membership_access_overlay', membershipId: overlay.membershipId,
  }]);
});

test('Cloudflare identity proxy reconstructs typed identity errors', async () => {
  const stub = {
    async identityExecute(): Promise<StateRpcResult<IdentityRpcResponse>> {
      return {
        ok: false,
        error: {
          code: 'identity',
          message: 'At least one active owner is required.',
          details: { identityCode: 'last_owner_required', membershipId: 'membership_owner' },
        },
      };
    },
  } as unknown as TagStateRpc;
  const store = new CfIdentityStore(stub);

  await assert.rejects(
    () => store.updateMembership({ membershipId: 'membership_owner', role: 'admin' }),
    (error: unknown) =>
      error instanceof IdentityStateError &&
      error.code === 'last_owner_required' &&
      error.details.membershipId === 'membership_owner',
  );
});

test('Cloudflare identity proxy preserves bootstrap and rotation lifecycle results', async () => {
  const calls: IdentityRpcRequest[] = [];
  const resolution = {
    user: {
      id: 'user_owner', primaryEmail: 'owner@example.com', displayName: null,
      createdAt: 10, updatedAt: 10,
    },
    binding: {
      id: 'binding_owner', userId: 'user_owner', provider: 'operator_token',
      issuer: 'urn:chickpea:operator', subject: 'owner_subject',
      verifiedEmail: 'owner@example.com', createdAt: 10, updatedAt: 10,
    },
    membership: {
      id: 'membership_owner', organizationId: 'org_oss', userId: 'user_owner',
      role: 'owner' as const, status: 'active' as const, createdAt: 10, updatedAt: 10,
    },
  };
  const personalToken = {
    id: 'personal_token_new', organizationId: 'org_oss', userId: 'user_owner',
    membershipId: 'membership_owner', tokenHash: 'a'.repeat(64),
    prefix: 'abcdefghijkl', label: 'Recovery', status: 'active' as const,
    lastUsedAt: null, createdAt: 20, updatedAt: 20,
  };
  const stub = {
    async identityExecute(request: IdentityRpcRequest): Promise<StateRpcResult<IdentityRpcResponse>> {
      calls.push(request);
      if (request.kind === 'bootstrap_token_owner') {
        return { ok: true, value: { kind: 'identity_resolution', resolution } };
      }
      return {
        ok: true,
        value: {
          kind: 'personal_token_rotation',
          result: { personalToken, revokedCount: 2 },
        },
      };
    },
  } as unknown as TagStateRpc;
  const store = new CfIdentityStore(stub);
  const bootstrap = {
    organizationId: 'org_oss', displayName: 'Chickpea',
    canonicalAdminOrigin: 'https://chickpea.example.com', provider: 'operator_token',
    issuer: 'urn:chickpea:operator', subject: 'owner_subject',
    verifiedEmail: 'owner@example.com',
  };
  assert.deepEqual(await store.bootstrapTokenOwner(bootstrap), resolution);
  const rotation = {
    userId: 'user_owner', tokenHash: 'a'.repeat(64), prefix: 'abcdefghijkl', label: 'Recovery',
  };
  assert.deepEqual(await store.rotatePersonalToken(rotation), { personalToken, revokedCount: 2 });
  assert.deepEqual(calls, [
    { kind: 'bootstrap_token_owner', input: bootstrap },
    { kind: 'rotate_personal_token', input: rotation },
  ]);
});
