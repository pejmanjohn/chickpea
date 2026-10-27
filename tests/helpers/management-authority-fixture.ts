import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHICKPEA_AGENT_ID } from '../../src/config/agent-id.ts';
import { SqliteConfigStore } from '../../src/config/store.ts';
import type { CustomAgentConfig } from '../../src/config/types.ts';
import { SqliteIdentityStore } from '../../src/identity/store.ts';
import {
  WorkspaceManagementService,
  type WorkspaceManagementServiceInput,
} from '../../src/management/service.ts';
import { SqliteManagementStore } from '../../src/management/store.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
} from '../../src/management/types.ts';
import { agentRoutineDeletion, SqliteRoutineStore } from '../../src/routines/store.ts';
import type { SlackChannel } from '../../src/slack/transport/types.ts';
import { SqliteWorkStore } from '../../src/work/store.ts';
import { createSlackOwner } from './slack-owner.ts';

export const NOW = 1_800_000_000_000;
export const MEMBER_SLACK_USER = 'U87654321';

export type SlackFacts = NonNullable<WorkspaceManagementServiceInput['slackFacts']>;

/** Slack's view of Channels: the bot's lookup and each person's own Channels. */
export function slackFacts(
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

export async function authorityFixture(
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
  const config = new SqliteConfigStore(statePath, agentRoutineDeletion, { agents: [] });
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

export type Fixture = Awaited<ReturnType<typeof authorityFixture>>;
export type Person = Fixture['owner'] | Fixture['member'];

export async function withFixture(
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

export function mcp(person: Person, clientId = 'authority-gaps'): ManagementActorContext {
  return {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    origin: { kind: 'mcp', clientId },
  };
}

let turn = 0;

/** One Slack turn: a fresh requester message in the person's DM with Chickpea. */
export function chickpeaDm(f: Fixture, person: Person): ManagementActorContext {
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

/** One Slack turn: a fresh requester message in a Channel, where the answer reaches everyone in it. */
export function chickpeaChannel(f: Fixture, person: Person, channelId: string): ManagementActorContext {
  turn += 1;
  return {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    origin: {
      kind: 'slack',
      workspaceId: f.workspaceId,
      channelId,
      threadTs: `${turn}.1`,
      messageTs: `${turn}.1`,
      eventId: `Ev_AUTHORITY_${turn}`,
      requestText: 'Please make that change.',
      conversationKind: 'channel',
      agentId: CHICKPEA_AGENT_ID,
    },
  };
}

export async function apply(
  f: Fixture,
  context: ManagementActorContext,
  idempotencyKey: string,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  const result = await f.service.applyWorkspaceChanges({ context, idempotencyKey, operations });
  assert.ok('outcomes' in result, JSON.stringify(result));
  return result;
}

export function disposition(result: ManagementApplyResult): string | undefined {
  return result.outcomes[0]?.disposition;
}

export async function createAgent(
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

export async function grant(f: Fixture, agentId: string, channelId: string): Promise<void> {
  await f.config.putAgentChannelGrant({
    workspaceId: f.workspaceId,
    channelId,
    agentId,
    status: 'active',
    createdByMembershipId: f.owner.membership.id,
    channelLabel: channelId.toLowerCase(),
  });
}

export function dmRoutine(f: Fixture, agentId: string, itemId = 'dm-routine'): ManagementOperation {
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

export function channelRoutine(
  f: Fixture,
  agentId: string,
  channelId: string,
): Extract<ManagementOperation, { kind: 'save_routine' }> {
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
