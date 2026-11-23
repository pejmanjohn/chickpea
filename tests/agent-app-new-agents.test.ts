import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { runtimeIdentityInstruction } from '../src/config/effective-config.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { AWAITING_OWN_APP, type AgentSlackPresence, type CustomAgentConfig } from '../src/config/types.ts';
import { agentAppBots, listAgentAppBots } from '../src/slack/agent-app-bots.ts';
import { configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { agentSlackState } from '../src/slack/agent-apps/lifecycle.ts';
import { readAgentSlackAppsSetting, writeAgentSlackAppsSetting } from '../src/slack/agent-apps/setting.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { SlackTransportError, type SlackChannel, type SlackTransport, type SlackUserGroup } from '../src/slack/transport/types.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const AVATAR = { kind: 'generated' as const, revision: 1, seed: 'seed' };

/** Refuses what Slack refuses: a second group with a taken handle or name, and an unknown group. */
class SlackGroups implements SlackTransport {
  readonly mode = 'direct';
  groups: SlackUserGroup[] = [];
  created: string[] = [];
  joined: string[] = [];
  lookedUp: string[] = [];
  channel: SlackChannel = { id: 'C_SALES', name: 'sales', private: false, member: false, archived: false };

  async lookupMember(): Promise<never> { throw new Error('unused'); }
  async lookupChannel(channelId: string) { this.lookedUp.push(channelId); return { ...this.channel, id: channelId }; }
  async listChannels() { return { channels: [{ ...this.channel }], truncated: false }; }
  async listMemberChannels(): Promise<ReadonlySet<string>> { return new Set([this.channel.id]); }
  async channelHasMember() { return true; }
  async openDirectConversation(userId: string) { return { id: `D_${userId}`, private: true, member: true, archived: false }; }
  async joinPublicChannel(channelId: string) { this.joined.push(channelId); return { ...this.channel, id: channelId, member: true }; }
  async lookupUserGroup(id: string) { return this.groups.find((group) => group.id === id); }
  async listUserGroups() { return this.groups.map((group) => ({ ...group })); }
  async createUserGroup(input: { name: string; handle: string; description?: string }) {
    if (this.groups.some((group) => group.handle === input.handle)) throw new SlackTransportError('usergroups.create', 'name_already_exists');
    const group: SlackUserGroup = { id: `S${this.groups.length + 1}`, name: input.name, handle: input.handle, disabled: false, updatedAt: NOW / 1_000 };
    this.groups.push(group);
    this.created.push(input.handle);
    return { ...group };
  }
  async updateUserGroup(id: string, patch: Partial<SlackUserGroup>) { return Object.assign(this.required(id), patch); }
  async disableUserGroup(id: string) { const group = this.required(id); group.disabled = true; return { ...group }; }
  async enableUserGroup(id: string) {
    const group = this.required(id);
    if (!group.disabled) throw new SlackTransportError('usergroups.enable', 'already_enabled');
    group.disabled = false;
    return { ...group };
  }
  async publishAppHome(): Promise<never> { throw new Error('unused'); }
  async postMessage(input: { channelId: string }) { return { channelId: input.channelId, ts: '1.0' }; }

  private required(id: string): SlackUserGroup {
    const group = this.groups.find((candidate) => candidate.id === id);
    if (!group) throw new SlackTransportError('usergroups.update', 'no_such_subteam');
    return group;
  }
}

function unpublished(handle: string): AgentSlackPresence {
  return { requestedHandle: handle, normalizedHandle: handle, desiredState: 'unpublished', health: 'unpublished', avatar: AVATAR };
}

function newAgent(id: string, name: string, presence: AgentSlackPresence = unpublished(name.toLowerCase())): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, instructions: `You are ${name}.`, enabled: true, lifecycle: 'draft',
    editPolicy: 'creator_and_admins', creatorMembershipId: 'membership_ada', configurationGeneration: 1, slackPresence: presence,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

async function fixture(t: TestContext, mode: 'shared' | 'own_app') {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  if (mode === 'own_app') await writeAgentSlackAppsSetting(settings, { mode, changedBy: 'UOWNER', changedAt: NOW });
  const slack = new SlackGroups();
  const reconciler = new AgentPresenceReconciler({
    config, transport: slack, announce: null, now: () => NOW,
    agentApps: {
      retire: async (agent) => agent,
      bringBotIn: async () => undefined,
      ownAppMode: async () => (await readAgentSlackAppsSetting(settings)).mode === 'own_app',
    },
  });
  return { config, settings, slack, reconciler };
}

const publishInput = { workspaceId: TEAM, agentId: 'agent_support', channelId: 'C_SALES', actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA' };

test('with the setting on, a new Agent gets no user group and is not in Slack yet', async (t) => {
  const f = await fixture(t, 'own_app');
  await f.config.createAgent(newAgent('agent_support', 'Support'));

  const agent = await f.reconciler.retry('agent_support');

  assert.deepEqual(f.slack.created, [], 'no user group was created');
  assert.equal(agent.lifecycle, 'active', 'it answers its creator in Chickpea\'s DM meanwhile');
  assert.equal(agent.slackPresence?.errorCode, AWAITING_OWN_APP);
  assert.equal(agent.slackPresence?.userGroupId, undefined);
  assert.deepEqual(agentSlackState(agent.slackPresence!), { state: 'not_in_slack' });
  const again = await f.reconciler.retry('agent_support');
  assert.deepEqual(f.slack.created, [], 'a retry, as when the Agent is turned back on, creates none either');
  assert.equal(again.slackPresence?.errorCode, AWAITING_OWN_APP);
});

test('with the setting off, a new Agent gets its user group as before', async (t) => {
  const f = await fixture(t, 'shared');
  await f.config.createAgent(newAgent('agent_support', 'Support'));

  const agent = await f.reconciler.retry('agent_support');

  assert.deepEqual(f.slack.created, ['support']);
  assert.equal(agent.slackPresence?.userGroupId, 'S1');
  assert.equal(agent.slackPresence?.errorCode, undefined);
  assert.equal(agent.slackPresence?.health, 'healthy');
});

test('a handle another group already holds is still refused when the setting is on', async (t) => {
  const f = await fixture(t, 'own_app');
  f.slack.groups.push({ id: 'S_PEOPLE', name: 'Support team', handle: 'support', disabled: false });
  await f.config.createAgent(newAgent('agent_support', 'Support'));

  await assert.rejects(f.reconciler.retry('agent_support'), { code: 'handle_collision' });
  assert.deepEqual(f.slack.created, []);
});

test('adding an Agent that is not in Slack yet to a Channel is refused before any grant is written', async (t) => {
  const f = await fixture(t, 'own_app');
  await f.config.createAgent(newAgent('agent_support', 'Support'));
  await f.reconciler.retry('agent_support');

  await assert.rejects(f.reconciler.publish(publishInput), (error: unknown) =>
    error instanceof AgentPresenceError && error.code === 'not_in_slack_yet' &&
    error.message === "Support isn't in Slack yet. A workspace Owner needs to add it first.");

  assert.deepEqual(await f.config.listAgentChannelGrants(), [], 'no pending grant');
  assert.equal(await f.config.getChannel(TEAM, 'C_SALES'), undefined, 'the Channel is not imported');
  assert.deepEqual([f.slack.lookedUp, f.slack.joined, f.slack.created], [[], [], []], 'Slack is not asked');
  assert.equal((await f.config.getAgent('agent_support')).slackPresence?.errorCode, AWAITING_OWN_APP, 'still not in Slack yet');
});

test('adding an unpublished Agent to a Channel with the setting on leaves it not in Slack yet, and refused', async (t) => {
  const f = await fixture(t, 'own_app');
  await f.config.createAgent(newAgent('agent_support', 'Support'));

  await assert.rejects(f.reconciler.publish(publishInput), { code: 'not_in_slack_yet' });

  assert.deepEqual(f.slack.created, []);
  assert.deepEqual(await f.config.listAgentChannelGrants(), []);
  assert.equal((await f.config.getAgent('agent_support')).slackPresence?.errorCode, AWAITING_OWN_APP);
});

test('the Channel asked for at creation waits as a pending grant', async (t) => {
  const f = await fixture(t, 'own_app');
  await f.config.createAgent(newAgent('agent_support', 'Support'));

  const published = await f.reconciler.publish({ ...publishInput, keepPendingUntilInSlack: true });

  assert.equal(published.grant.status, 'pending');
  assert.equal(published.grant.createdByMembershipId, 'membership_ada');
  assert.equal(published.agent.slackPresence?.errorCode, AWAITING_OWN_APP);
  assert.deepEqual([f.slack.joined, f.slack.created], [[], []], 'Chickpea neither joins nor makes a group');
});

test('a user-group Agent is added to a Channel as before when the setting is on', async (t) => {
  const f = await fixture(t, 'own_app');
  f.slack.groups.push({ id: 'S_SUPPORT', name: 'Support', handle: 'support', disabled: false });
  await f.config.createAgent(newAgent('agent_support', 'Support', {
    requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: AVATAR, userGroupId: 'S_SUPPORT',
  }));

  const published = await f.reconciler.publish(publishInput);

  assert.equal(published.grant.status, 'active');
  assert.equal(published.agent.slackPresence?.userGroupId, 'S_SUPPORT');
  assert.deepEqual(f.slack.created, []);
});

test('restoring a handle-less Agent with the setting on leaves it not in Slack yet', async (t) => {
  const f = await fixture(t, 'own_app');
  await f.config.createAgent(newAgent('agent_support', 'Support'));
  await f.reconciler.archive('agent_support');

  const restored = await f.reconciler.restore('agent_support');

  assert.equal(restored.slackPresence?.errorCode, AWAITING_OWN_APP);
  assert.deepEqual(f.slack.created, []);
});

test('turning the setting back off gives a waiting Agent its user group', async (t) => {
  const f = await fixture(t, 'own_app');
  await f.config.createAgent(newAgent('agent_support', 'Support'));
  await f.reconciler.retry('agent_support');
  await writeAgentSlackAppsSetting(f.settings, { mode: 'shared', changedBy: 'UOWNER', changedAt: NOW });

  const agent = await f.reconciler.retry('agent_support');

  assert.deepEqual(f.slack.created, ['support']);
  assert.equal(agent.slackPresence?.errorCode, undefined, 'no longer waiting');
  assert.deepEqual(agentSlackState(agent.slackPresence!), { state: 'user_group' });
});

test('an Agent not in Slack yet is told its name and no handle', () => {
  const waiting: AgentSlackPresence = {
    requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'unpublished', avatar: AVATAR, errorCode: AWAITING_OWN_APP,
  };
  const instruction = (presence: AgentSlackPresence) => runtimeIdentityInstruction({
    workspaceId: TEAM, channelId: 'D1', agent: { ...newAgent('agent_support', 'Support'), slackPresence: presence },
  });

  assert.match(instruction(waiting), /your name is Support\./);
  assert.doesNotMatch(instruction(waiting), /handle is/);
  const { errorCode: _waiting, ...inSlack } = waiting;
  assert.match(instruction({ ...inSlack, userGroupId: 'S1' }), /Your Slack handle is @support/);
});

test('a workspace where no Agent has an app record reads no app bots on a Slack event or turn', async (t) => {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  t.after(() => { config.close(); configureAgentSlackApps(undefined); });
  configureAgentSlackApps({ requestUrls: () => ({ events: 'e', interactions: 'i' }), redirectUri: 'r', allowUrl: () => 'a' });
  const support = await config.createAgent({ ...newAgent('agent_support', 'Support'), lifecycle: 'active' });
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, transportMode: 'direct', defaultAgentId: support.id });
  let reads = 0;
  const counted = { listAgentAppBots: async () => { reads += 1; return agentAppBots(await config.listAgents()); } };

  const off = await config.getWorkspaceInstallation(TEAM);
  assert.equal(off?.agentApps, false);
  assert.deepEqual(await listAgentAppBots(counted, off), []);
  assert.equal(reads, 0, 'the installation record the event already read answers it');

  await config.updateAgent(support.id, {
    slackPresence: { ...support.slackPresence!, app: { state: 'creating', at: NOW, startedBy: 'UOWNER', manifestFingerprint: 'f' } },
  }, support.revision);
  const on = await config.getWorkspaceInstallation(TEAM);
  assert.equal(on?.agentApps, true, 'an app record of any state turns the read back on');
  await listAgentAppBots(counted, on);
  assert.equal(reads, 1);
  const older: { agentApps?: boolean } = {};
  await listAgentAppBots(counted, older);
  assert.equal(reads, 2, 'a record from a store on older code, which leaves the fact out, still reads');
});
