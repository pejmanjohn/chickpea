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
