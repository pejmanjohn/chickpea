import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfConfigStore } from '../src/config/cf-state-proxies.ts';
import {
  AgentStillSlackDmHandlerError,
  SlackIdentityStillReferencedError,
} from '../src/config/errors.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import type { SlackIdentity, SlackIdentityReferenceSummary } from '../src/config/types.ts';

const identity: SlackIdentity = {
  id: 'slack_identity_finance',
  ingressKey: 'ingress_finance_0123456789abcdef',
  kind: 'dedicated',
  lifecycle: 'connected',
  teamId: 'T_TEST',
  appId: 'A_FINANCE',
  botUserId: 'U_FINANCE_BOT',
  dmState: 'off',
  credentialProvenance: 'stored',
  connectionRevision: 3,
  health: 'healthy',
  createdAt: 1,
  updatedAt: 2,
};

test('Cloudflare config proxy preserves Slack identity records and reference operations', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const references: SlackIdentityReferenceSummary = {
    identityId: identity.id,
    profileIds: ['agent_finance'],
  };
  const stub = {
    async configListSlackIdentities(): Promise<StateRpcResult<SlackIdentity[]>> {
      calls.push({ method: 'list', args: [] });
      return { ok: true, value: [identity] };
    },
    async configGetSlackIdentity(identityId: string): Promise<StateRpcResult<SlackIdentity>> {
      calls.push({ method: 'get', args: [identityId] });
      return { ok: true, value: identity };
    },
    async configGetSlackIdentityReferences(
      identityId: string,
    ): Promise<StateRpcResult<SlackIdentityReferenceSummary>> {
      calls.push({ method: 'references', args: [identityId] });
      return { ok: true, value: references };
    },
  } as unknown as TagStateRpc;
  const store = new CfConfigStore(stub);

  assert.deepEqual(await store.listSlackIdentities(), [identity]);
  assert.deepEqual(await store.getSlackIdentity(identity.id), identity);
  assert.deepEqual(await store.getSlackIdentityReferences(identity.id), references);
  assert.deepEqual(calls, [
    { method: 'list', args: [] },
    { method: 'get', args: [identity.id] },
    { method: 'references', args: [identity.id] },
  ]);
});

test('Cloudflare config proxy reconstructs active-DM and referenced-identity domain errors', async () => {
  const dmStub = {
    async configDeleteAgent(): Promise<StateRpcResult<boolean>> {
      return {
        ok: false,
        error: {
          code: 'agent_slack_dm_handler',
          message: 'Agent agent_finance handles DMs for slack_identity_finance',
          details: { agentId: 'agent_finance', identityIds: 'slack_identity_finance' },
        },
      };
    },
  } as unknown as TagStateRpc;
  const referenceStub = {
    async configRetireSlackIdentity(): Promise<StateRpcResult<SlackIdentity>> {
      return {
        ok: false,
        error: {
          code: 'slack_identity_still_referenced',
          message: 'Slack identity slack_identity_finance is still referenced',
          details: {
            identityId: 'slack_identity_finance',
            profileIds: 'agent_finance',
            dmAgentId: '',
          },
        },
      };
    },
  } as unknown as TagStateRpc;

  await assert.rejects(
    () => new CfConfigStore(dmStub).deleteAgent('agent_finance'),
    (error: unknown) =>
      error instanceof AgentStillSlackDmHandlerError &&
      error.agentId === 'agent_finance' &&
      error.identityIds === 'slack_identity_finance',
  );
  await assert.rejects(
    () => new CfConfigStore(referenceStub).retireSlackIdentity('slack_identity_finance', 3),
    (error: unknown) =>
      error instanceof SlackIdentityStillReferencedError &&
      error.identityId === 'slack_identity_finance' &&
      error.profileIds === 'agent_finance',
  );
});
