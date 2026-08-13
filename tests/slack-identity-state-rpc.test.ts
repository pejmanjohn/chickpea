import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfConfigStore } from '../src/config/cf-state-proxies.ts';
import {
  AgentStillReferencedError,
  AgentStillSlackDmHandlerError,
  SlackIdentityStillReferencedError,
} from '../src/config/errors.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import type {
  CustomAgentConfig,
  SlackIdentity,
  SlackIdentityReferenceSummary,
} from '../src/config/types.ts';
import type { AuditEvent } from '../src/audit/types.ts';

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

const attachedProfile: CustomAgentConfig = {
  id: 'agent_finance',
  revision: 1,
  name: 'Finance',
  instructions: 'Review finance work.',
  enabled: true,
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
  slackIdentityId: identity.id,
};

const auditEvent: AuditEvent = {
  eventId: 'evt-1',
  domain: 'slack_identity',
  eventType: 'slack_identity.profile_attached',
  outcome: 'success',
  actorClass: 'admin',
  actorId: 'admin-1',
  workspaceId: null,
  channelId: null,
  storeId: null,
  subjectId: identity.id,
  subjectVersion: identity.connectionRevision,
  createdAt: 1,
  reasonCode: null,
  beforeHash: null,
  afterHash: null,
  metadataJson: '{}',
  idempotencyKey: 'request-1',
};

test('Cloudflare config proxy preserves Slack identity records and reference operations', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const references: SlackIdentityReferenceSummary = {
    identityId: identity.id,
    agentIds: ['agent_finance'],
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
    async configGetSlackIdentityByIngressKey(
      ingressKey: string,
    ): Promise<StateRpcResult<SlackIdentity | null>> {
      calls.push({ method: 'getByIngressKey', args: [ingressKey] });
      return {
        ok: true,
        value: ingressKey === identity.ingressKey ? identity : null,
      };
    },
    async configGetSlackIdentityReferences(
      identityId: string,
    ): Promise<StateRpcResult<SlackIdentityReferenceSummary>> {
      calls.push({ method: 'references', args: [identityId] });
      return { ok: true, value: references };
    },
    async configCompleteSlackIdentitySetup(
      identityId: string,
      expectedRevision: number,
      agentId?: string,
      expectedAgentIdentityId?: string | null,
    ): Promise<StateRpcResult<SlackIdentity>> {
      calls.push({
        method: 'completeSetup',
        args: [identityId, expectedRevision, agentId, expectedAgentIdentityId],
      });
      return { ok: true, value: identity };
    },
    async configAttachAgentToSlackIdentity(
      agentId: string,
      identityId: string,
      expectedRevision: number,
      expectedAgentIdentityId: string | null,
    ): Promise<StateRpcResult<CustomAgentConfig>> {
      calls.push({
        method: 'attachProfile',
        args: [agentId, identityId, expectedRevision, expectedAgentIdentityId],
      });
      return { ok: true, value: attachedProfile };
    },
    async configAppendSlackIdentityAudit(): Promise<StateRpcResult<AuditEvent>> {
      calls.push({ method: 'appendAudit', args: [] });
      return { ok: true, value: auditEvent };
    },
    async configListSlackIdentityAuditEvents(): Promise<StateRpcResult<AuditEvent[]>> {
      calls.push({ method: 'listAudit', args: [] });
      return { ok: true, value: [auditEvent] };
    },
  } as unknown as TagStateRpc;
  const store = new CfConfigStore(stub);

  assert.deepEqual(await store.listSlackIdentities(), [identity]);
  assert.deepEqual(await store.getSlackIdentity(identity.id), identity);
  assert.deepEqual(await store.getSlackIdentityByIngressKey(identity.ingressKey), identity);
  assert.equal(
    await store.getSlackIdentityByIngressKey('unknown_ingress_0123456789abcdef'),
    undefined,
  );
  assert.deepEqual(await store.getSlackIdentityReferences(identity.id), references);
  assert.deepEqual(
    await store.completeSlackIdentitySetup(identity.id, 3, attachedProfile.id, null),
    identity,
  );
  assert.deepEqual(
    await store.attachAgentToSlackIdentity(attachedProfile.id, identity.id, 3, null),
    attachedProfile,
  );
  assert.deepEqual(await store.appendSlackIdentityAudit({
    eventId: auditEvent.eventId,
    domain: auditEvent.domain,
    eventType: auditEvent.eventType,
    outcome: auditEvent.outcome,
    actorClass: auditEvent.actorClass,
    createdAt: auditEvent.createdAt,
  }), auditEvent);
  assert.deepEqual(await store.listSlackIdentityAuditEvents(), [auditEvent]);
  assert.deepEqual(calls, [
    { method: 'list', args: [] },
    { method: 'get', args: [identity.id] },
    { method: 'getByIngressKey', args: [identity.ingressKey] },
    { method: 'getByIngressKey', args: ['unknown_ingress_0123456789abcdef'] },
    { method: 'references', args: [identity.id] },
    { method: 'completeSetup', args: [identity.id, 3, attachedProfile.id, null] },
    { method: 'attachProfile', args: [attachedProfile.id, identity.id, 3, null] },
    { method: 'appendAudit', args: [] },
    { method: 'listAudit', args: [] },
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
            agentIds: 'agent_finance',
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
      error.agentIds === 'agent_finance',
  );
});

test('Cloudflare config proxy reconstructs composite Agent deletion blocker errors', async () => {
  const stub = {
    async configDeleteAgentWithMemory(): Promise<StateRpcResult<boolean>> {
      return {
        ok: false,
        error: {
          code: 'agent_still_referenced',
          message: 'Agent agent_finance is still referenced',
          details: {
            agentId: 'agent_finance',
            references: 'T_TEST/C_FINANCE, DM:slack_identity_finance',
          },
        },
      };
    },
  } as unknown as TagStateRpc;

  await assert.rejects(
    () => new CfConfigStore(stub).deleteAgentWithMemory('agent_finance', 'delete-1'),
    (error: unknown) =>
      error instanceof AgentStillReferencedError &&
      error.agentId === 'agent_finance' &&
      error.references === 'T_TEST/C_FINANCE, DM:slack_identity_finance',
  );
});

test('Cloudflare config proxy reconstructs a stale Profile identity selection conflict', async () => {
  const stub = {
    async configAttachAgentToSlackIdentity(): Promise<StateRpcResult<CustomAgentConfig>> {
      return {
        ok: false,
        error: {
          code: 'agent_slack_identity_conflict',
          message: 'Profile identity changed',
          details: {
            agentId: attachedProfile.id,
            expectedIdentityId: '',
            actualIdentityId: 'slack_identity_legal',
          },
        },
      };
    },
  } as unknown as TagStateRpc;

  await assert.rejects(
    () => new CfConfigStore(stub).attachAgentToSlackIdentity(
      attachedProfile.id,
      identity.id,
      3,
      null,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'AgentSlackIdentityConflictError' &&
      'expectedIdentityId' in error && error.expectedIdentityId === null &&
      'actualIdentityId' in error && error.actualIdentityId === 'slack_identity_legal',
  );
});
