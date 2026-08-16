import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfIdentityStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import type {
  IdentityResolution,
  IdentityRpcRequest,
  IdentityRpcResponse,
  MembershipAuthorityMutationResult,
  SlackCredentialRevision,
  SlackOAuthAttempt,
  SlackOidcAttempt,
  SlackRecoverySession,
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

test('Cloudflare proxy forwards the atomic membership authority mutation', async () => {
  const calls: IdentityRpcRequest[] = [];
  const input = {
    membershipId: resolution.membership.id,
    status: 'suspended' as const,
    authenticationSurface: 'slack_event' as const,
    correlationId: 'Ev_RPC_DEACTIVATE',
    reasonCode: 'slack_user_deactivated',
    idempotencyKey: 'slack-user-change:Ev_RPC_DEACTIVATE',
    slackTeamId: 'T_ACME',
    slackUserId: 'U_OWNER',
    credentialRevision: 'revision_connected',
  };
  const result: MembershipAuthorityMutationResult = {
    membership: { ...resolution.membership, status: 'suspended', updatedAt: 11 },
    changed: true,
    revokedPersonalTokenCount: 1,
    revokedBrowserSessionCount: 1,
  };
  const stub = rpcStub(calls, { kind: 'membership_authority_mutation', result });
  const store = new CfIdentityStore(stub);
  assert.deepEqual(await store.updateMembershipAuthority(input), result);
  assert.deepEqual(calls, [{ kind: 'update_membership_authority', input }]);
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

test('Cloudflare proxy forwards encrypted credential revisions without projection changes', async () => {
  const calls: IdentityRpcRequest[] = [];
  const input = {
    expectedRotationEpoch: 1,
    expectedActiveRevision: null,
    revision: 'revision_rpc_1',
    identityId: 'slack_workspace_default',
    identityClass: 'workspace_default' as const,
    purpose: 'connected_credentials' as const,
    appId: 'AAPP',
    teamId: 'TACME',
    botUserId: 'UBOT',
    grantedScopes: ['chat:write'],
    validatedAt: 10,
    manifestFingerprint: 'manifest-v1',
    envelope: {
      version: 1 as const,
      algorithm: 'AES-GCM-256' as const,
      keyId: 'key_v1',
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'A'.repeat(22),
    },
  };
  const revision: SlackCredentialRevision = {
    ...input,
    baseRevision: null,
    status: 'candidate',
    rotationEpoch: 1,
    envelope: input.envelope,
    createdAt: 10,
    updatedAt: 10,
    tombstonedAt: null,
  };
  const stub = rpcStub(calls, { kind: 'slack_credential_revision', revision });
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.stageSlackCredentialRevision(input), revision);
  assert.deepEqual(calls, [{ kind: 'stage_slack_credential_revision', input }]);
});

test('Cloudflare proxy forwards durable Slack setup transaction reads', async () => {
  const calls: IdentityRpcRequest[] = [];
  const transaction = {
    id: 'setup_default', locatorHash: 'a'.repeat(64),
    state: 'awaiting_app_creation' as const, revision: 1, destination: '/admin',
    manifestFingerprint: null, appId: null, credentialRevision: null,
    botCredentialRevision: null, slackTeamId: null, installerSlackUserId: null, botUserId: null,
    lastErrorCode: null, expiresAt: 20, consumedAt: null, createdAt: 10, updatedAt: 10,
  };
  const stub = rpcStub(calls, { kind: 'slack_setup_transaction', transaction });
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.getSlackSetupTransaction(transaction.id), transaction);
  assert.deepEqual(calls, [{ kind: 'get_slack_setup_transaction', setupId: transaction.id }]);
});

test('Cloudflare proxy forwards the fresh-only Slack OAuth attempt projection', async () => {
  const calls: IdentityRpcRequest[] = [];
  const attempt: SlackOAuthAttempt = {
    id: 'slackoauth_rpc', kind: 'slack_bot_install', purpose: 'setup_bot_install',
    setupId: 'setup_default', setupRevision: 2,
    stateHash: 'a'.repeat(64), browserHash: 'b'.repeat(64),
    appId: 'AAPP', clientId: '123.456', credentialRevision: 'rev_app', baseRevision: 'rev_app',
    redirectUri: 'https://chickpea.example/auth/slack/install/callback',
    destination: '/admin/channels', expectedTeamId: null,
    expectedInstallerSlackUserId: null, status: 'pending', leaseGeneration: 0,
    leaseExpiresAt: null, resultCode: null, expiresAt: 20, createdAt: 10, updatedAt: 10,
  };
  const stub = rpcStub(calls, { kind: 'slack_oauth_attempt', attempt });
  const store = new CfIdentityStore(stub);

  assert.deepEqual(await store.getSlackOAuthAttempt(attempt.id), attempt);
  assert.deepEqual(calls, [{ kind: 'get_slack_oauth_attempt', attemptId: attempt.id }]);
});

test('Cloudflare proxy forwards hashed Slack OIDC callback authority', async () => {
  const calls: IdentityRpcRequest[] = [];
  const attempt: SlackOidcAttempt = {
    id: 'slackoidc_rpc', purpose: 'login', operationId: null, invitationId: null,
    setupId: null, setupRevision: null,
    stateHash: 'a'.repeat(64), nonceHash: 'b'.repeat(64), browserHash: 'c'.repeat(64),
    appId: 'AAPP', clientId: '123.456', credentialRevision: 'rev_connected',
    redirectUri: 'https://chickpea.example/auth/slack/oidc/callback', destination: '/admin',
    expectedTeamId: 'TACME', expectedSlackUserId: null,
    admittedTeamId: null, admittedSlackUserId: null,
    status: 'pending', leaseGeneration: 0, leaseExpiresAt: null, resultCode: null,
    expiresAt: 20, createdAt: 10, updatedAt: 10,
  };
  const stub = rpcStub(calls, { kind: 'slack_oidc_attempt', attempt });
  const store = new CfIdentityStore(stub);
  assert.deepEqual(await store.getSlackOidcAttempt(attempt.id), attempt);
  assert.deepEqual(calls, [{ kind: 'get_slack_oidc_attempt', attemptId: attempt.id }]);
});

test('Cloudflare proxy forwards recovery authority without projecting raw grants or sessions', async () => {
  const calls: IdentityRpcRequest[] = [];
  const session: SlackRecoverySession = {
    id: 'recovery_rpc_authority', deploymentId: 'deployment_rpc',
    grantHash: 'a'.repeat(64), sessionHash: 'b'.repeat(64), browserHash: 'c'.repeat(64),
    allowedActions: ['credential_repair', 'url_repair'], status: 'active',
    expectedAppId: 'AAPP', expectedTeamId: 'TACME', baseRevision: 'revision_connected',
    manifestFingerprint: 'sha256:manifest', appCredentialRevision: null,
    appCredentialClientId: null, appCredentialEnvelope: null, connectedCandidateRevision: null,
    oauthStateHash: null, oauthRedirectUri: null, leaseGeneration: 0, leaseExpiresAt: null,
    resultCode: null, expiresAt: 20, consumedAt: null, createdAt: 10, updatedAt: 10,
  };
  const stub = rpcStub(calls, { kind: 'slack_recovery_session', session });
  const store = new CfIdentityStore(stub);
  assert.deepEqual(await store.getSlackRecoverySession(session.id), session);
  assert.deepEqual(calls, [{ kind: 'get_slack_recovery_session', recoveryId: session.id }]);
});

test('Cloudflare proxy forwards digest-only invitation lookup', async () => {
  const calls: IdentityRpcRequest[] = [];
  const invitation = {
    id: 'invite_rpc', organizationId: 'org_oss', slackTeamId: 'T_ACME',
    slackUserId: 'U_INVITED', displayName: 'Invited', role: 'admin' as const,
    locatorHash: 'a'.repeat(64), status: 'pending' as const,
    inviterMembershipId: 'membership_owner', acceptedMembershipId: null,
    expiresAt: 20, createdAt: 10, updatedAt: 10,
  };
  const stub = rpcStub(calls, { kind: 'invitation', invitation });
  const store = new CfIdentityStore(stub);
  assert.deepEqual(await store.findInvitation('b'.repeat(64)), invitation);
  assert.deepEqual(calls, [{ kind: 'find_invitation', locatorHash: 'b'.repeat(64) }]);
});

test('Cloudflare proxy forwards atomic invitation activation', async () => {
  const calls: IdentityRpcRequest[] = [];
  const input = {
    operationId: 'invite_operation_rpc', invitationId: 'invite_rpc',
    oidcAttemptId: 'slackoidc_invite_rpc', expectedOidcLeaseGeneration: 1,
    capabilityHash: 'a'.repeat(64), slackTeamId: 'T_ACME', slackUserId: 'U_INVITED',
    displayName: 'Invited', betterAuthUserId: 'ba_user_invited',
    betterAuthMembershipId: 'ba_member_invited',
  };
  const stub = rpcStub(calls, { kind: 'identity_resolution', resolution });
  const store = new CfIdentityStore(stub);
  assert.deepEqual(await store.activateInvitation(input), resolution);
  assert.deepEqual(calls, [{ kind: 'activate_invitation', input }]);
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
