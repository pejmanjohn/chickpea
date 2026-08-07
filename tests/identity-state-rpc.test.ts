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
    id: 'personal_token_new', userId: 'user_owner', tokenHash: 'a'.repeat(64),
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
