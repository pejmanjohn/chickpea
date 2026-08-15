import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IdentityStateError } from '../src/identity/errors.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';

const NOW = 1_786_000_000_000;
const TEAM = 'T12345678';
const OWNER = 'U12345678';
const CAPABILITY = 'a'.repeat(64);

test('first-owner claim activates exactly one canonical Slack tuple', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const resolution = await claimFirstOwner(store);

  assert.equal(resolution.user.slackTeamId, TEAM);
  assert.equal(resolution.user.slackUserId, OWNER);
  assert.equal(resolution.membership.role, 'owner');
  assert.equal(resolution.binding.betterAuthUserId, 'ba_user_owner');
  assert.deepEqual(await store.resolveSlackIdentity(TEAM, OWNER), resolution);
  assert.equal((await store.getAuthControl())?.authMode, 'slack_active');
  assert.equal((await store.getAuthControl())?.healthGate, 'normal');

  await assert.rejects(
    () => store.createAuthOperation({
      id: 'another_first_owner', kind: 'first_owner_claim',
      expectedSlackTeamId: TEAM, expectedSlackUserId: 'U22222222',
      capabilityHash: 'b'.repeat(64), expiresAt: NOW + 60_000,
    }),
    (error: unknown) => error instanceof IdentityStateError && error.code === 'auth_operation_conflict',
  );
});

test('first-owner activation requires the exact completed Better Auth reconciliation', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const operation = await store.createAuthOperation({
    id: 'incomplete_first_owner',
    kind: 'first_owner_claim',
    expectedSlackTeamId: TEAM,
    expectedSlackUserId: OWNER,
    chickpeaRole: 'owner',
    capabilityHash: CAPABILITY,
    expiresAt: NOW + 60_000,
  });
  await store.createOwnerClaim({
    operationId: operation.id,
    slackTeamId: TEAM,
    slackUserId: OWNER,
  });
  await store.advanceAuthOperation({
    operationId: operation.id,
    capabilityHash: CAPABILITY,
    step: 1,
    betterAuthUserId: 'ba_user_owner',
    betterAuthMembershipId: 'ba_member_owner',
  });

  await assert.rejects(
    () => store.claimOwner({
      operationId: operation.id,
      organizationId: 'org_oss',
      slackTeamId: TEAM,
      slackUserId: OWNER,
      betterAuthUserId: 'ba_user_owner',
      betterAuthMembershipId: 'ba_member_owner',
    }),
    (error: unknown) => error instanceof IdentityStateError && error.code === 'owner_claim_conflict',
  );
  assert.equal((await store.getOwnerClaim())?.status, 'reserved');
  assert.equal((await store.getAuthControl())?.authMode, undefined);
  assert.equal((await store.listMemberships()).length, 0);
});

test('Slack tuple and Better Auth mapping uniqueness are storage-backed', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await claimFirstOwner(store);
  const invitation = await store.createInvitation({
    organizationId: owner.membership.organizationId,
    slackTeamId: TEAM,
    slackUserId: 'U87654321',
    displayName: 'Same display name',
    role: 'admin',
    locatorHash: 'c'.repeat(64),
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 60_000,
  });
  const admin = await store.consumeInvitation({
    invitationId: invitation.id,
    locatorHash: 'c'.repeat(64),
    slackTeamId: TEAM,
    slackUserId: 'U87654321',
    displayName: 'Same display name',
    betterAuthUserId: 'ba_user_admin',
    betterAuthMembershipId: 'ba_member_admin',
  });
  assert.equal(admin.membership.role, 'admin');
  assert.equal((await store.listExternalIdentities()).length, 2);

  const duplicate = await store.createInvitation({
    organizationId: owner.membership.organizationId,
    slackTeamId: TEAM,
    slackUserId: 'U11111111',
    role: 'admin',
    locatorHash: 'd'.repeat(64),
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 60_000,
  });
  await assert.rejects(
    () => store.consumeInvitation({
      invitationId: duplicate.id,
      locatorHash: 'd'.repeat(64),
      slackTeamId: TEAM,
      slackUserId: 'U11111111',
      betterAuthUserId: 'ba_user_admin',
      betterAuthMembershipId: 'ba_member_admin_2',
    }),
    /Slack identity is already bound|UNIQUE constraint failed/,
  );
});

test('identity export contains Slack authority and no credential locators', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  await claimFirstOwner(store);
  const exported = await store.exportSummary();
  const serialized = JSON.stringify(exported);
  assert.match(serialized, /T12345678/);
  assert.match(serialized, /U12345678/);
  assert.doesNotMatch(serialized, /@/);
  assert.doesNotMatch(serialized, new RegExp(CAPABILITY));
  assert.equal(exported.authOperations[0]?.chickpeaRole, 'owner');
});

test('credential realm metadata stays immutable across promotion and tombstone recovery', async () => {
  let now = NOW;
  const store = new SqliteIdentityStore(':memory:', { now: () => now });
  try {
    const control = await store.ensureSlackCredentialControl({ currentKeyId: 'key_v1' });
    const app = await store.stageSlackCredentialRevision(credentialRevisionInput({
      revision: 'revision_app',
      expectedRotationEpoch: control.rotationEpoch,
      expectedActiveRevision: null,
      purpose: 'app_credentials',
      teamId: null,
    }));
    await store.promoteSlackCredentialRevision({
      identityId: app.identityId,
      candidateRevision: app.revision,
      expectedActiveRevision: null,
      expectedRotationEpoch: control.rotationEpoch,
    });
    now += 1;
    const connected = await store.stageSlackCredentialRevision(credentialRevisionInput({
      revision: 'revision_connected',
      expectedRotationEpoch: control.rotationEpoch,
      expectedActiveRevision: app.revision,
      purpose: 'connected_credentials',
      teamId: 'TACME',
      botUserId: 'UBOT',
    }));
    await store.promoteSlackCredentialRevision({
      identityId: connected.identityId,
      candidateRevision: connected.revision,
      expectedActiveRevision: app.revision,
      expectedRotationEpoch: control.rotationEpoch,
    });
    await assert.rejects(
      () => store.stageSlackCredentialRevision(credentialRevisionInput({
        revision: 'revision_wrong_app',
        expectedRotationEpoch: control.rotationEpoch,
        expectedActiveRevision: connected.revision,
        purpose: 'connected_credentials',
        appId: 'AOTHER',
        teamId: 'TACME',
      })),
      /app identity is immutable/,
    );
    await assert.rejects(
      () => store.stageSlackCredentialRevision(credentialRevisionInput({
        revision: 'revision_wrong_manifest',
        expectedRotationEpoch: control.rotationEpoch,
        expectedActiveRevision: connected.revision,
        purpose: 'connected_credentials',
        teamId: 'TACME',
        manifestFingerprint: 'manifest-v2',
      })),
      /manifest is immutable/,
    );
    const lateCandidate = await store.stageSlackCredentialRevision(credentialRevisionInput({
      revision: 'revision_late_callback',
      expectedRotationEpoch: control.rotationEpoch,
      expectedActiveRevision: connected.revision,
      purpose: 'connected_credentials',
      teamId: 'TACME',
    }));
    await store.tombstoneSlackCredentialRevision({
      identityId: connected.identityId,
      revision: connected.revision,
      expectedRotationEpoch: control.rotationEpoch,
    });
    await assert.rejects(
      () => store.promoteSlackCredentialRevision({
        identityId: lateCandidate.identityId,
        candidateRevision: lateCandidate.revision,
        expectedActiveRevision: null,
        expectedRotationEpoch: control.rotationEpoch,
      }),
      /candidate is not promotable/,
    );
    await store.tombstoneSlackCredentialRevision({
      identityId: lateCandidate.identityId,
      revision: lateCandidate.revision,
      expectedRotationEpoch: control.rotationEpoch,
    });
    await assert.rejects(
      () => store.stageSlackCredentialRevision(credentialRevisionInput({
        revision: 'revision_wrong_team_after_tombstone',
        expectedRotationEpoch: control.rotationEpoch,
        expectedActiveRevision: null,
        purpose: 'connected_credentials',
        teamId: 'TOTHER',
      })),
      /workspace identity is immutable/,
    );
  } finally {
    store.close();
  }
});

test('retention scrubs inactive ciphertext while preserving active bindings and body-free audit facts', async () => {
  let now = NOW;
  const store = new SqliteIdentityStore(':memory:', { now: () => now });
  try {
    const control = await store.ensureSlackCredentialControl({ currentKeyId: 'key_v1' });
    const active = await store.stageSlackCredentialRevision(credentialRevisionInput({
      revision: 'revision_active',
      expectedRotationEpoch: control.rotationEpoch,
      expectedActiveRevision: null,
      purpose: 'connected_credentials',
      teamId: 'TACME',
    }));
    await store.promoteSlackCredentialRevision({
      identityId: active.identityId,
      candidateRevision: active.revision,
      expectedActiveRevision: null,
      expectedRotationEpoch: control.rotationEpoch,
    });
    const candidate = await store.stageSlackCredentialRevision(credentialRevisionInput({
      revision: 'revision_inactive',
      expectedRotationEpoch: control.rotationEpoch,
      expectedActiveRevision: active.revision,
      purpose: 'connected_credentials',
      teamId: 'TACME',
    }));
    await store.recordAuthAudit({
      event: 'authorization', outcome: 'success', action: 'credential.candidate_staged',
      correlationId: 'retention_fact_1', authenticatorKind: 'deployment_token',
    });
    now += 60_000;
    const swept = await store.sweepSlackIdentityRetention(now, 30_000);
    assert.equal(swept.scrubbedCredentialCandidates, 1);
    assert.equal((await store.getActiveSlackCredentialRevision(active.identityId))?.revision, active.revision);
    const scrubbed = await store.getSlackCredentialRevision(candidate.identityId, candidate.revision);
    assert.equal(scrubbed?.status, 'tombstoned');
    assert.equal(scrubbed?.envelope, null);
    assert.equal((await store.listAuditEvents()).length, 1);
  } finally {
    store.close();
  }
});

function credentialRevisionInput(overrides: {
  revision: string;
  expectedRotationEpoch: number;
  expectedActiveRevision: string | null;
  purpose: 'app_credentials' | 'connected_credentials';
  appId?: string;
  teamId: string | null;
  botUserId?: string;
  manifestFingerprint?: string;
}) {
  return {
    identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    identityClass: 'workspace_default' as const,
    purpose: overrides.purpose,
    revision: overrides.revision,
    expectedRotationEpoch: overrides.expectedRotationEpoch,
    expectedActiveRevision: overrides.expectedActiveRevision,
    appId: overrides.appId ?? 'AAPP',
    teamId: overrides.teamId,
    botUserId: overrides.purpose === 'connected_credentials'
      ? overrides.botUserId ?? 'UBOT'
      : null,
    grantedScopes: overrides.purpose === 'connected_credentials' ? ['chat:write'] : [],
    validatedAt: overrides.purpose === 'connected_credentials' ? NOW : null,
    manifestFingerprint: overrides.manifestFingerprint ?? 'manifest-v1',
    envelope: {
      version: 1 as const,
      algorithm: 'AES-GCM-256' as const,
      keyId: 'key_v1',
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'A'.repeat(22),
    },
  };
}

async function claimFirstOwner(store: SqliteIdentityStore) {
  const operation = await store.createAuthOperation({
    id: 'first_owner',
    kind: 'first_owner_claim',
    expectedSlackTeamId: TEAM,
    expectedSlackUserId: OWNER,
    chickpeaRole: 'owner',
    capabilityHash: CAPABILITY,
    expiresAt: NOW + 60_000,
  });
  await store.createOwnerClaim({
    operationId: operation.id,
    slackTeamId: TEAM,
    slackUserId: OWNER,
  });
  await store.advanceAuthOperation({
    operationId: operation.id,
    capabilityHash: CAPABILITY,
    step: 1,
    betterAuthUserId: 'ba_user_owner',
    betterAuthOrganizationId: 'ba_org_acme',
    betterAuthMembershipId: 'ba_member_owner',
  });
  return store.claimOwner({
    operationId: operation.id,
    organizationId: 'org_oss',
    slackTeamId: TEAM,
    slackUserId: OWNER,
    displayName: 'Same display name',
    betterAuthUserId: 'ba_user_owner',
    betterAuthMembershipId: 'ba_member_owner',
  });
}
