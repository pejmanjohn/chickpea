import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  provisionSlackInteractionMember,
  slackInteractionMayUseGrantedChannel,
} from '../src/auth/slack-admission.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_787_000_000_000;

test('first eligible Slack interaction provisions one exact active member and refreshes contact data', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  try {
    const first = await provisionSlackInteractionMember({
      identity,
      slackTeamId: owner.binding.slackTeamId,
      botUserId: 'UBOT',
      user: {
        id: 'UNEWMEMBER', teamId: owner.binding.slackTeamId,
        displayName: 'New Member', email: 'first@example.com',
        deleted: false, bot: false, appUser: false, restricted: false,
        ultraRestricted: false, stranger: false,
      },
    });
    assert.equal(first.outcome, 'provisioned');
    assert.equal(first.resolution?.membership.role, 'member');
    assert.equal(first.resolution?.membership.status, 'active');
    assert.equal(first.resolution?.binding.betterAuthUserId, null);
    assert.equal(first.resolution?.user.contactEmail, 'first@example.com');
    assert.equal(slackInteractionMayUseGrantedChannel(first), true);

    const replay = await provisionSlackInteractionMember({
      identity,
      slackTeamId: owner.binding.slackTeamId,
      botUserId: 'UBOT',
      user: {
        id: 'UNEWMEMBER', teamId: owner.binding.slackTeamId,
        displayName: 'Renamed Member', email: 'changed@example.com',
        deleted: false, bot: false, appUser: false, restricted: false,
        ultraRestricted: false, stranger: false,
      },
    });
    assert.equal(replay.outcome, 'active');
    assert.equal(replay.resolution?.binding.id, first.resolution?.binding.id);
    assert.equal(replay.resolution?.user.displayName, 'Renamed Member');
    assert.equal(replay.resolution?.user.contactEmail, 'changed@example.com');
    const withoutEmailScope = await provisionSlackInteractionMember({
      identity,
      slackTeamId: owner.binding.slackTeamId,
      botUserId: 'UBOT',
      user: {
        id: 'UNEWMEMBER', teamId: owner.binding.slackTeamId,
        deleted: false, bot: false, appUser: false, restricted: false,
        ultraRestricted: false, stranger: false,
      },
    });
    assert.equal(withoutEmailScope.resolution?.user.contactEmail, 'changed@example.com');
    assert.equal((await identity.listMemberships()).length, 2);
  } finally {
    identity.close();
  }
});

test('Slack activity never reactivates a deactivated member', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  try {
    const initial = await provisionSlackInteractionMember({
      identity,
      slackTeamId: owner.binding.slackTeamId,
      botUserId: 'UBOT',
      user: {
        id: 'UDEACTIVATED', teamId: owner.binding.slackTeamId,
        deleted: false, bot: false, appUser: false, restricted: false,
        ultraRestricted: false, stranger: false,
      },
    });
    await identity.updateMembershipAuthority({
      membershipId: initial.resolution!.membership.id,
      status: 'removed',
      actorMembershipId: owner.membership.id,
      authenticationSurface: 'better_auth',
      correlationId: 'remove_auto_member',
      reasonCode: 'admin_deactivated_member',
      slackTeamId: owner.binding.slackTeamId,
      slackUserId: 'UDEACTIVATED',
    });

    const replay = await provisionSlackInteractionMember({
      identity,
      slackTeamId: owner.binding.slackTeamId,
      botUserId: 'UBOT',
      user: {
        id: 'UDEACTIVATED', teamId: owner.binding.slackTeamId,
        deleted: false, bot: false, appUser: false, restricted: false,
        ultraRestricted: false, stranger: false,
      },
    });
    assert.equal(replay.outcome, 'deactivated');
    assert.equal(replay.resolution?.membership.status, 'removed');
    assert.equal(slackInteractionMayUseGrantedChannel(replay), false);
  } finally {
    identity.close();
  }
});

test('guests and Slack Connect actors stay conversational-only and receive no membership', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  try {
    for (const user of [
      { id: 'UGUEST', teamId: owner.binding.slackTeamId, restricted: true, stranger: false },
      { id: 'UCONNECT', teamId: 'TFOREIGN', restricted: false, stranger: true },
    ]) {
      const result = await provisionSlackInteractionMember({
        identity,
        slackTeamId: owner.binding.slackTeamId,
        botUserId: 'UBOT',
        user: {
          ...user,
          deleted: false, bot: false, appUser: false, ultraRestricted: false,
        },
      });
      assert.equal(result.outcome, 'conversational_only');
      assert.equal(result.resolution, undefined);
      assert.equal(slackInteractionMayUseGrantedChannel(result), true);
    }
    assert.equal((await identity.listMemberships()).length, 1);
  } finally {
    identity.close();
  }
});
