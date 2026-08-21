import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  provisionSlackInteractionMember,
  slackInteractionMayUseGrantedChannel,
} from '../src/auth/slack-admission.ts';
import { resolveAgentRoutingActor } from '../src/channels/slack.ts';
import type { AppStores } from '../src/config/state-backend.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { SlackTransport } from '../src/slack/transport/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_787_000_000_000;

test('every Channel turn rechecks the invoking Slack member against the Channel', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  let membershipChecks = 0;
  try {
    const actor = await resolveAgentRoutingActor({
      workspaceId: owner.binding.slackTeamId,
      userId: owner.user.slackUserId,
      channelId: 'C_RESTRICTED',
      includeDiscoverableAgents: false,
      botUserId: 'UBOT',
      transport: {
        async lookupMember() {
          return {
            id: owner.user.slackUserId,
            teamId: owner.binding.slackTeamId,
            displayName: owner.user.displayName,
            email: owner.user.contactEmail ?? undefined,
            deleted: false,
            bot: false,
            appUser: false,
            restricted: false,
            ultraRestricted: false,
            stranger: false,
          };
        },
        async channelHasMember(channelId: string, userId: string) {
          membershipChecks += 1;
          assert.equal(channelId, 'C_RESTRICTED');
          assert.equal(userId, owner.user.slackUserId);
          return false;
        },
      } as unknown as SlackTransport,
      stores: { identity } as unknown as AppStores,
    });

    assert.equal(membershipChecks, 1);
    assert.equal(actor.routing.fullMember, true);
    assert.equal(actor.routing.channelMember, false);
  } finally {
    identity.close();
  }
});

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

test('deleted, bot, app, installation-bot, and unverified actors receive no membership', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  try {
    const base = {
      teamId: owner.binding.slackTeamId,
      deleted: false,
      bot: false,
      appUser: false,
      restricted: false,
      ultraRestricted: false,
      stranger: false,
    };
    for (const user of [
      { ...base, id: 'UDELETED', deleted: true },
      { ...base, id: 'UBOTACTOR', bot: true },
      { ...base, id: 'UAPPACTOR', appUser: true },
      { ...base, id: 'UBOT', bot: true },
      { ...base, id: 'UNVERIFIED', teamId: undefined },
    ]) {
      const result = await provisionSlackInteractionMember({
        identity,
        slackTeamId: owner.binding.slackTeamId,
        botUserId: 'UBOT',
        user,
      });
      assert.equal(result.outcome, 'denied');
      assert.equal(result.resolution, undefined);
      assert.equal(slackInteractionMayUseGrantedChannel(result), false);
    }
    assert.equal((await identity.listMemberships()).length, 1);
  } finally {
    identity.close();
  }
});
