import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import type { ParsedSkillSource } from '../src/config/skill-import.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import {
  WorkspaceManagementService,
  type WorkspaceManagementServiceInput,
} from '../src/management/service.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type { WorkspaceManagementToolArguments } from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
} from '../src/management/types.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import type { SlackChannel } from '../src/slack/transport/types.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_800_000_000_000;
const MEMBER_SLACK_USER = 'U87654321';
const SKILL_SOURCE =
  'https://github.com/acme/skills/tree/3333333333333333333333333333333333333333/skills/unslop';

type SlackFacts = NonNullable<WorkspaceManagementServiceInput['slackFacts']>;

/** Slack's view of Channels: the bot's lookup and each person's own Channels. */
function slackFacts(
  channels: Record<string, Omit<SlackChannel, 'id'>>,
  memberChannels: Record<string, readonly string[]>,
): SlackFacts {
  return async () => ({
    async lookupChannel(channelId) {
      const channel = channels[channelId];
      if (!channel) throw new Error(`channel_not_found:${channelId}`);
      return { id: channelId, ...channel };
    },
    async listMemberChannels(userId) {
      return new Set(memberChannels[userId] ?? []);
    },
  });
}

async function authorityFixture(
  suffix: string,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), `chickpea-authority-${suffix}-`));
  const statePath = join(dir, 'state.db');
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix });
  const locatorHash = createHash('sha256').update(`locator:${suffix}`).digest('hex');
  const invitation = await identity.createInvitation({
    organizationId: owner.membership.organizationId,
    slackTeamId: owner.user.slackTeamId,
    slackUserId: MEMBER_SLACK_USER,
    displayName: 'Maya Member',
    role: 'admin',
    locatorHash,
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 60_000,
  });
  const member = await identity.consumeInvitation({
    invitationId: invitation.id,
    locatorHash,
    slackTeamId: owner.user.slackTeamId,
    slackUserId: MEMBER_SLACK_USER,
    displayName: 'Maya Member',
    betterAuthUserId: `ba_user_${suffix}_member`,
    betterAuthMembershipId: `ba_member_${suffix}_member`,
  });
  await identity.updateMembershipAuthority({
    membershipId: member.membership.id,
    role: 'member',
    actorMembershipId: owner.membership.id,
    correlationId: `${suffix}-member`,
    authenticationSurface: 'better_auth',
    reasonCode: 'authority_gaps_test',
  });
  const config = new SqliteConfigStore(statePath, { agents: [] });
  const routines = new SqliteRoutineStore(statePath, () => NOW);
  const work = new SqliteWorkStore(statePath);
  const management = new SqliteManagementStore(':memory:');
  const workspaceId = owner.user.slackTeamId;
  await config.ensureWorkspaceInstallation({
    workspaceId,
    transportMode: 'direct',
    teamId: workspaceId,
    appId: 'ACHICKPEA1',
    botUserId: 'UCHICKPEA1',
    runtimeContract: 'chickpea-v1',
  });
  let sequence = 0;
  const service = new WorkspaceManagementService({
    identity,
    config,
    management,
    routines,
    work,
    routineSchedulingAvailable: true,
    setupBaseUrl: 'http://localhost',
    randomCapability: () => 'c'.repeat(43),
    now: () => NOW,
    randomId: () => `${suffix}_${++sequence}`,
    ...overrides,
  });
  return {
    identity,
    owner,
    member,
    config,
    routines,
    management,
    service,
    workspaceId,
    close() {
      identity.close();
      config.close();
      routines.close();
      work.close();
      management.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof authorityFixture>>;
type Person = Fixture['owner'] | Fixture['member'];

async function withFixture(
  suffix: string,
  run: (f: Fixture) => Promise<void>,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
): Promise<void> {
  const f = await authorityFixture(suffix, overrides);
  try {
    await run(f);
  } finally {
    f.close();
  }
}

function mcp(person: Person, clientId = 'authority-gaps'): ManagementActorContext {
  return {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    origin: { kind: 'mcp', clientId },
  };
}

let turn = 0;

/** One Slack turn: a fresh requester message in the person's DM with Chickpea. */
function chickpeaDm(f: Fixture, person: Person): ManagementActorContext {
  turn += 1;
  return {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    origin: {
      kind: 'slack',
      workspaceId: f.workspaceId,
      channelId: `D_${person.user.slackUserId}`,
      threadTs: `${turn}.1`,
      messageTs: `${turn}.1`,
      eventId: `Ev_AUTHORITY_${turn}`,
      requestText: 'Please make that change.',
      conversationKind: 'im',
      agentId: CHICKPEA_AGENT_ID,
    },
  };
}

async function apply(
  f: Fixture,
  context: ManagementActorContext,
  idempotencyKey: string,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  const result = await f.service.applyWorkspaceChanges({ context, idempotencyKey, operations });
  assert.ok('outcomes' in result, JSON.stringify(result));
  return result;
}

function disposition(result: ManagementApplyResult): string | undefined {
  return result.outcomes[0]?.disposition;
}

async function createAgent(
  f: Fixture,
  creator: Person,
  id: string,
  extra: Partial<CustomAgentConfig> = {},
): Promise<CustomAgentConfig> {
  return f.config.createAgent({
    id,
    name: id.replace(/^agent_/, '').replace(/_/g, ' '),
    instructions: 'Help the team.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: creator.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...extra,
  });
}

async function grant(f: Fixture, agentId: string, channelId: string): Promise<void> {
  await f.config.putAgentChannelGrant({
    workspaceId: f.workspaceId,
    channelId,
    agentId,
    status: 'active',
    createdByMembershipId: f.owner.membership.id,
    channelLabel: channelId.toLowerCase(),
  });
}

function dmRoutine(f: Fixture, agentId: string, itemId = 'dm-routine'): ManagementOperation {
  return {
    itemId,
    kind: 'save_routine',
    requiredConnectionAccountIds: [],
    agentId,
    workspaceId: f.workspaceId,
    destination: { kind: 'current_dm_thread' },
    name: 'Morning check',
    description: 'Check in privately.',
    taskText: 'Summarize what changed overnight.',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
    timezone: 'UTC',
    outputPolicy: 'post',
  };
}

function channelRoutine(
  f: Fixture,
  agentId: string,
  channelId: string,
): ManagementOperation {
  return {
    itemId: `routine-${channelId}`,
    kind: 'save_routine',
    requiredConnectionAccountIds: [],
    agentId,
    workspaceId: f.workspaceId,
    channelId,
    name: `Pulse ${channelId}`,
    description: 'Post a pulse.',
    taskText: 'Summarize the Channel.',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
    timezone: 'UTC',
    outputPolicy: 'post',
  };
}

const ROOMS = slackFacts({
  C_LOBBY: { name: 'lobby', private: false, member: true, archived: false },
  G_ROOM: { name: 'room', private: true, member: true, archived: false },
  G_OTHER: { name: 'other', private: true, member: true, archived: false },
}, {
  [MEMBER_SLACK_USER]: ['G_ROOM'],
});

test('a DM routine needs the private use the person would need to DM its Agent', () =>
  withFixture('dm-owner-agent', async (f) => {
    const ownersOnly = await createAgent(f, f.owner, 'agent_owners_only');
    const lobby = await createAgent(f, f.owner, 'agent_lobby');
    await grant(f, lobby.id, 'C_LOBBY');
    const other = await createAgent(f, f.owner, 'agent_other');
    await grant(f, other.id, 'G_OTHER');
    const room = await createAgent(f, f.owner, 'agent_room');
    await grant(f, room.id, 'G_ROOM');
    const dmChannel = `D_${MEMBER_SLACK_USER}`;

    for (const agent of [ownersOnly, other]) {
      const refused = await apply(f, chickpeaDm(f, f.member), `dm-${agent.id}`, [dmRoutine(f, agent.id)]);
      assert.equal(disposition(refused), 'failed', `${agent.id}: ${JSON.stringify(refused.outcomes)}`);
      assert.equal(refused.outcomes[0]?.code, 'forbidden', agent.id);
    }
    assert.deepEqual(await f.routines.listRoutines(f.workspaceId, dmChannel), []);

    for (const agent of [lobby, room]) {
      const saved = await apply(f, chickpeaDm(f, f.member), `dm-${agent.id}`, [dmRoutine(f, agent.id)]);
      assert.equal(disposition(saved), 'applied', `${agent.id}: ${JSON.stringify(saved.outcomes)}`);
    }
    const [routine] = await f.routines.listRoutines(f.workspaceId, dmChannel);
    assert.ok(routine);

    const reassigned = await apply(f, chickpeaDm(f, f.member), 'reassign-to-owners-only', [{
      itemId: 'reassign',
      kind: 'reassign_routine_agent',
      workspaceId: f.workspaceId,
      routineId: routine.id,
      expectedVersion: routine.version,
      agentId: ownersOnly.id,
    }]);
    assert.equal(disposition(reassigned), 'failed', JSON.stringify(reassigned.outcomes));
    assert.notEqual((await f.config.getAgentScheduleReference(routine.id))?.agentId, ownersOnly.id);
  }, { slackFacts: ROOMS }));

test('a routine the member cannot read, or a disable, needs Admin authority', () =>
  withFixture('member-routine-control', async (f) => {
    const agent = await createAgent(f, f.member, 'agent_member_pulse');
    await grant(f, agent.id, 'G_ROOM');
    await grant(f, agent.id, 'G_OTHER');
    for (const channelId of ['G_ROOM', 'G_OTHER']) {
      const saved = await apply(f, mcp(f.owner), `save-${channelId}`, [channelRoutine(f, agent.id, channelId)]);
      assert.equal(disposition(saved), 'applied', JSON.stringify(saved.outcomes));
    }
    const routineIn = async (channelId: string) => {
      const [routine] = await f.routines.listRoutines(f.workspaceId, channelId);
      assert.ok(routine, channelId);
      return routine;
    };
    const control = (
      person: Person,
      key: string,
      channelId: string,
      action: 'pause' | 'disable',
      version: number,
      routineId: string,
    ) => apply(f, mcp(person), key, [{
      itemId: 'control',
      kind: 'control_routine',
      workspaceId: f.workspaceId,
      channelId,
      routineId,
      expectedVersion: version,
      action,
    }]);

    const readable = await routineIn('G_ROOM');
    const paused = await control(f.member, 'pause-readable', 'G_ROOM', 'pause', readable.version, readable.id);
    assert.equal(disposition(paused), 'applied', JSON.stringify(paused.outcomes));

    const unreadable = await routineIn('G_OTHER');
    const refusedPause = await control(
      f.member, 'pause-unreadable', 'G_OTHER', 'pause', unreadable.version, unreadable.id,
    );
    assert.equal(disposition(refusedPause), 'failed', JSON.stringify(refusedPause.outcomes));
    const refusedDelete = await apply(f, mcp(f.member), 'delete-unreadable', [{
      itemId: 'delete',
      kind: 'delete_routine',
      workspaceId: f.workspaceId,
      channelId: 'G_OTHER',
      routineId: unreadable.id,
      expectedVersion: unreadable.version,
    }]);
    assert.equal(disposition(refusedDelete), 'failed', JSON.stringify(refusedDelete.outcomes));
    assert.equal((await routineIn('G_OTHER')).state, 'active');

    const current = await routineIn('G_ROOM');
    const refusedDisable = await control(
      f.member, 'disable-readable', 'G_ROOM', 'disable', current.version, current.id,
    );
    assert.equal(disposition(refusedDisable), 'failed', JSON.stringify(refusedDisable.outcomes));
    assert.equal((await routineIn('G_ROOM')).state, 'paused');

    const ownerDisable = await control(
      f.owner, 'owner-disable', 'G_OTHER', 'disable', unreadable.version, unreadable.id,
    );
    assert.equal(disposition(ownerDisable), 'applied', JSON.stringify(ownerDisable.outcomes));
    assert.equal((await routineIn('G_OTHER')).state, 'disabled');
  }, { slackFacts: ROOMS }));

test('a member inspects a private Channel only when Slack shows them in it', () =>
  withFixture('member-channel-inspection', async (f) => {
    const agent = await createAgent(f, f.member, 'agent_member_reach');
    for (const channelId of ['C_LOBBY', 'G_ROOM', 'G_OTHER']) await grant(f, agent.id, channelId);

    const channelIds = async (person: Person) =>
      (await f.service.inspectWorkspace(mcp(person))).channels.map(({ channelId }) => channelId).sort();
    assert.deepEqual(await channelIds(f.member), ['C_LOBBY', 'G_ROOM']);
    assert.deepEqual(await channelIds(f.owner), ['C_LOBBY', 'G_OTHER', 'G_ROOM']);
  }, { slackFacts: ROOMS }));

test('MCP revokes Channel reach with editor rights; Slack still asks for Channel membership', () =>
  withFixture('mcp-channel-revoke', async (f) => {
    const agent = await createAgent(f, f.owner, 'agent_revoked');
    await grant(f, agent.id, 'C_LOBBY');
    const revoke = async (context: ManagementActorContext, key: string) => {
      const [current] = await f.config.listAgentChannelGrants(f.workspaceId, 'C_LOBBY');
      return apply(f, context, key, [{
        itemId: 'revoke',
        kind: 'revoke_agent_channel',
        workspaceId: f.workspaceId,
        channelId: 'C_LOBBY',
        agentId: agent.id,
        expectedRevision: current?.revision ?? 0,
      }]);
    };

    const fromSlack = await revoke(chickpeaDm(f, f.owner), 'slack-revoke');
    assert.equal(disposition(fromSlack), 'failed', JSON.stringify(fromSlack.outcomes));
    assert.equal((await f.config.listAgentChannelGrants(f.workspaceId, 'C_LOBBY')).length, 1);

    const fromMcp = await revoke(mcp(f.owner), 'mcp-revoke');
    assert.equal(disposition(fromMcp), 'applied', JSON.stringify(fromMcp.outcomes));
    assert.deepEqual(await f.config.listAgentChannelGrants(f.workspaceId, 'C_LOBBY'), []);
  }, {
    assertAgentChannelMembership: async () => {
      throw new AgentPresenceError(
        'channel_membership_required',
        'Join the Slack Channel before changing this Agent grant.',
      );
    },
  }));

test('a management status change ends Better Auth grants; a role change ends sessions only', async () => {
  const revoked: string[] = [];
  await withFixture('member-access-revoke', async (f) => {
    const update = (key: string, change: { role?: 'admin'; status?: 'suspended' }) =>
      apply(f, mcp(f.owner), key, [{
        itemId: 'member',
        kind: 'update_member',
        membershipId: f.member.membership.id,
        ...change,
      }]);

    const promoted = await update('promote', { role: 'admin' });
    assert.equal(disposition(promoted), 'applied', JSON.stringify(promoted.outcomes));
    assert.deepEqual(revoked, ['sessions:ba_user_member-access-revoke_member']);

    const suspension = await update('suspend', { status: 'suspended' });
    assert.equal(suspension.status, 'confirmation_required', JSON.stringify(suspension.outcomes));
    assert.equal(revoked.length, 1, 'nothing ends before the person confirms');
    const confirmed = await f.service.confirmWorkspaceChange({
      context: mcp(f.owner),
      proposalId: suspension.outcomes[0]!.proposalId!,
    });
    assert.equal(confirmed.outcomes[0]?.disposition, 'applied', JSON.stringify(confirmed.outcomes));
    assert.equal((await f.identity.getMembership(f.member.membership.id))?.status, 'suspended');
    assert.deepEqual(revoked, [
      'sessions:ba_user_member-access-revoke_member',
      'oauth-grants:ba_user_member-access-revoke_member',
      'sessions:ba_user_member-access-revoke_member',
    ]);
  }, {
    withBetterAuthAccessRevoker: (use) => use({
      async deleteSessionsForUser(userId: string) {
        revoked.push(`sessions:${userId}`);
        return 1;
      },
      async revokeOAuthGrantsForUser(userId: string) {
        revoked.push(`oauth-grants:${userId}`);
        return { consents: 1, accessTokens: 1, refreshTokens: 1 };
      },
    }),
  });
});

test('an idempotency key is scoped to the client that sent it', () =>
  withFixture('origin-idempotency', async (f) => {
    const agent = await createAgent(f, f.owner, 'agent_keyed');
    const describe = async (clientId: string, description: string) => apply(f, mcp(f.owner, clientId), 'describe-1', [{
      itemId: 'describe',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: (await f.config.getAgent(agent.id)).revision,
      patch: { description },
    }]);

    const first = await describe('claude-code', 'First client.');
    assert.equal(disposition(first), 'applied', JSON.stringify(first.outcomes));
    const second = await describe('codex', 'Second client.');
    assert.equal(disposition(second), 'applied', JSON.stringify(second.outcomes));
    assert.notEqual(second.operationId, first.operationId);
    assert.equal((await f.config.getAgent(agent.id)).description, 'Second client.');

    const fromSlack = await apply(f, chickpeaDm(f, f.owner), 'describe-1', [{
      itemId: 'describe',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: (await f.config.getAgent(agent.id)).revision,
      patch: { description: 'From Slack.' },
    }]);
    assert.equal(disposition(fromSlack), 'applied', JSON.stringify(fromSlack.outcomes));
    assert.equal((await f.config.getAgent(agent.id)).description, 'From Slack.');
  }));

test('a skill key the model reuses in a later turn applies again instead of replaying', () =>
  withFixture('skill-key-turns', async (f) => {
    const agent = await createAgent(f, f.owner, 'agent_sprout', {
      name: 'Sprout',
      skills: [{
        name: 'unslop',
        description: 'Rewrite plainly.',
        instructions: 'Preserve this local procedure.',
        enabled: true,
      }],
    });
    let sequence = 0;
    const say = <TName extends 'manage_agent_skill' | 'import_skill'>(
      requesterText: string,
      name: TName,
      args: WorkspaceManagementToolArguments[TName],
    ) => {
      sequence += 1;
      const signal: SlackManagementSignal = {
        agentId: agent.id,
        workspaceId: f.workspaceId,
        channelId: 'C_SKILLS',
        threadTs: '800.1',
        conversationKind: 'channel',
        slackUserId: f.owner.binding.slackUserId,
        eventId: `Ev_SKILL_TURN_${sequence}`,
        messageTs: `800.${sequence + 1}`,
        turnJobId: `turn_SKILL_TURN_${sequence}`,
        requesterText,
      };
      return invokeSlackWorkspaceManagementTool({ signal, identity: f.identity, service: f.service, name, args });
    };
    const unslop = async () => (await f.config.getAgent(agent.id)).skills.find(({ name }) => name === 'unslop');

    for (const [action, key, enabled] of [
      ['disable', 'disable-unslop', false],
      ['enable', 'enable-unslop', true],
      ['disable', 'disable-unslop', false],
    ] as const) {
      const result = await say(`${action} the unslop skill`, 'manage_agent_skill', {
        idempotencyKey: key,
        action,
        skillName: 'unslop',
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await unslop())?.enabled, enabled, `${action} with ${key}`);
    }

    const removed = await say('remove the unslop skill', 'manage_agent_skill', {
      idempotencyKey: 'remove-unslop',
      action: 'remove',
      skillName: 'unslop',
    });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    for (const _ of [1, 2]) {
      const imported = await say(`import <${SKILL_SOURCE}|unslop>`, 'import_skill', {
        idempotencyKey: 'import-unslop',
        source: SKILL_SOURCE,
        guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
      });
      assert.equal(imported.ok, true, JSON.stringify(imported));
      assert.equal((await unslop())?.instructions, 'Use the upstream procedure.');
      const removedAgain = await say('remove the unslop skill', 'manage_agent_skill', {
        idempotencyKey: 'remove-unslop',
        action: 'remove',
        skillName: 'unslop',
      });
      assert.equal(removedAgain.ok, true, JSON.stringify(removedAgain));
      assert.equal(await unslop(), undefined);
    }
  }, {
    resolveSkillImport: async (source: ParsedSkillSource) => ({
      owner: source.owner,
      repo: source.repo,
      ref: '3333333333333333333333333333333333333333',
      source: { visibility: 'public', access: 'anonymous' },
      skills: [{
        name: 'unslop',
        description: 'Upstream description.',
        instructions: 'Use the upstream procedure.',
        hasScripts: false,
        inspection: { complete: true, scriptPaths: [], auxiliaryPaths: [], unknownPaths: [], warnings: [] },
        path: 'skills/unslop',
        sourceUrl: SKILL_SOURCE,
      }],
      total: 1,
      capped: false,
      skipped: 0,
    }),
  }));
