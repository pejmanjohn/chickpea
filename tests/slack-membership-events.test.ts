import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import {
  applyGatewaySlackUserChange,
  applySlackUserChange,
} from '../src/auth/slack-membership-events.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_786_100_000_000;

test('revision-bound user_change suspends the exact active member and is replay safe', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  const active = await identity.stageSlackCredentialRevision({
    expectedRotationEpoch: (await identity.ensureSlackCredentialControl({ currentKeyId: 'key_v1' })).rotationEpoch,
    expectedActiveRevision: null,
    revision: 'revision_connected',
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation',
    purpose: 'connected_credentials',
    appId: 'A12345678',
    teamId: 'T12345678',
    botUserId: 'U99999999',
    grantedScopes: ['users:read'],
    validatedAt: NOW,
    manifestFingerprint: 'manifest_v1',
    envelope: {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: 'key_v1',
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'A'.repeat(22),
    },
  });
  await identity.promoteSlackCredentialRevision({
    identityId: active.identityId,
    candidateRevision: active.revision,
    expectedActiveRevision: null,
    expectedRotationEpoch: 1,
  });
  const deletedUsers: string[] = [];
  const input = {
    identity,
    betterAuth: { async deleteSessionsForUser(userId: string) { deletedUsers.push(userId); return 1; } },
    credentialRevision: active.revision,
    payloadTeamId: 'T12345678',
    apiAppId: 'A12345678',
    eventId: 'Ev_USER_CHANGE_1',
    event: {
      type: 'user_change' as const,
      event_ts: '1786100000.000100',
      user: {
        id: 'U12345678',
        team_id: 'T12345678',
        deleted: true,
        is_bot: false,
        is_app_user: false,
      },
    },
  };
  assert.equal((await applySlackUserChange(input)).outcome, 'suspended');
  assert.equal((await applySlackUserChange(input)).outcome, 'duplicate');
  assert.deepEqual(deletedUsers, [owner.binding.betterAuthUserId]);
  assert.equal((await identity.getMembershipAccessOverlay(owner.membership.id))?.accessStatus, 'suspended');

  assert.equal((await applySlackUserChange({
    ...input,
    payloadTeamId: 'TOTHER',
    eventId: 'Ev_WRONG_TEAM',
  })).outcome, 'ignored');
});

test('user_change never reactivates from an active or out-of-order payload', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  await createSlackOwner(identity, { now: NOW });
  assert.equal((await applySlackUserChange({
    identity,
    credentialRevision: 'missing_revision',
    payloadTeamId: 'T12345678',
    apiAppId: 'A12345678',
    eventId: 'Ev_ACTIVE',
    event: {
      type: 'user_change', event_ts: '1786100000.000200',
      user: { id: 'U12345678', team_id: 'T12345678', deleted: false, is_bot: false, is_app_user: false },
    },
  })).outcome, 'ignored');
});

test('gateway-bound user_change suspends the exact provisioned member without local Slack credentials', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  const deletedUsers: string[] = [];
  const input = {
    identity,
    betterAuth: { async deleteSessionsForUser(userId: string) { deletedUsers.push(userId); return 1; } },
    payloadTeamId: 'T12345678',
    apiAppId: 'A12345678',
    eventId: 'Ev_GATEWAY_USER_CHANGE_1',
    event: {
      type: 'user_change' as const,
      event_ts: '1786100000.000300',
      user: {
        id: 'U12345678', team_id: 'T12345678', deleted: true,
        is_bot: false, is_app_user: false,
      },
    },
  };
  assert.equal((await applyGatewaySlackUserChange(input)).outcome, 'suspended');
  assert.equal((await applyGatewaySlackUserChange(input)).outcome, 'duplicate');
  assert.deepEqual(deletedUsers, [owner.binding.betterAuthUserId]);
  assert.equal((await identity.getMembershipAccessOverlay(owner.membership.id))?.accessStatus, 'suspended');
});
