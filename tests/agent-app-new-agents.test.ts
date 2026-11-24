import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { runtimeIdentityInstruction } from '../src/config/effective-config.ts';
import { deliverManagementReceiptToSlack, formatManagementSetupReceipt } from '../src/management/receipts.ts';
import type { ManagementActorContext, ManagementOperation, ManagementReceiptOutboxRecord } from '../src/management/types.ts';
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
import { createManagementAdapterFixture, ownerMcpContext, type ManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { asUserGroup } from './helpers/user-group-presence.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const AVATAR = { kind: 'generated' as const, revision: 1, seed: 'seed' };

/**
 * Refuses what Slack refuses: a second group with a taken handle or name, an unknown group, and a private Channel
 * Chickpea's bot is not in (`channel_not_found`); a member check is answered from who is in the Channel.
 */
class SlackGroups implements SlackTransport {
  readonly mode = 'direct';
  groups: SlackUserGroup[] = [];
  created: string[] = [];
  joined: string[] = [];
  lookedUp: string[] = [];
  channel: SlackChannel = { id: 'C_SALES', name: 'sales', private: false, member: false, archived: false };
  /** People in the Channel, by Slack user ID. */
  members = new Set(['UADA']);

  async lookupMember(): Promise<never> { throw new Error('unused'); }
  async lookupChannel(channelId: string) {
    this.lookedUp.push(channelId);
    if (this.channel.private && !this.channel.member) throw new SlackTransportError('conversations.info', 'channel_not_found');
    return { ...this.channel, id: channelId };
  }
  async listChannels() { return { channels: [{ ...this.channel }], truncated: false }; }
  async listMemberChannels(): Promise<ReadonlySet<string>> { return new Set([this.channel.id]); }
  async channelHasMember(_channelId: string, userId: string) {
    if (this.channel.private && !this.channel.member) throw new SlackTransportError('conversations.members', 'channel_not_found');
    return this.members.has(userId);
  }
  async openDirectConversation(userId: string) { return { id: `D_${userId}`, private: true, member: true, archived: false }; }
  async joinPublicChannel(channelId: string) { this.joined.push(channelId); return { ...this.channel, id: channelId, member: true }; }
  async lookupUserGroup(id: string) { return this.groups.find((group) => group.id === id); }
  /** Slack's answer to the next list of groups, when it refuses one. */
  listRefusal: string | undefined;
  async listUserGroups() {
    if (this.listRefusal) throw new SlackTransportError('usergroups.list', this.listRefusal);
    return this.groups.map((group) => ({ ...group }));
  }
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

test('a private Channel Chickpea is not in writes no pending grant for an Agent not in Slack yet', async (t) => {
  const f = await fixture(t, 'own_app');
  f.slack.channel = { ...f.slack.channel, private: true, member: false };
  await f.config.createAgent(newAgent('agent_support', 'Support'));

  // As in Slack, the bot cannot even see a private Channel it is not in.
  await assert.rejects(f.reconciler.publish({ ...publishInput, keepPendingUntilInSlack: true }), AgentPresenceError);

  assert.deepEqual(await f.config.listAgentChannelGrants(), [], 'nothing the switch could later turn on without a membership check');
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

// Defects caught: a failed Retry erasing the not-in-Slack-yet marker, so the Agent's instructions name a handle that
// reaches no one, the read says it answers through a group it does not have, and back to shared skips it.
test('a Retry that fails leaves an Agent not in Slack yet exactly that', async (t) => {
  const f = await fixture(t, 'own_app');
  await f.config.createAgent(newAgent('agent_support', 'Support'));
  await f.reconciler.retry('agent_support');
  for (const refusal of ['ratelimited', 'name_already_exists']) {
    f.slack.listRefusal = refusal;
    await assert.rejects(f.reconciler.retry('agent_support'), AgentPresenceError);
    const agent = await f.config.getAgent('agent_support');
    assert.equal(agent.slackPresence?.errorCode, AWAITING_OWN_APP, refusal);
    assert.deepEqual(agentSlackState(agent.slackPresence!), { state: 'not_in_slack' });
    assert.doesNotMatch(runtimeIdentityInstruction({ workspaceId: TEAM, channelId: 'D1', agent }), /handle is/);
  }
  f.slack.listRefusal = undefined;
  await writeAgentSlackAppsSetting(f.settings, { mode: 'shared', changedBy: 'UOWNER', changedAt: NOW });
  assert.equal((await f.reconciler.retry('agent_support')).slackPresence?.userGroupId, 'S1', 'back to shared still finds it');
});

// Defects caught: the read saying an Agent answers through its user group when it has none, because a failed create
// left another code where the marker would be.
test('an Agent with no user group, no app and no app record reads as not in Slack, whatever code it carries', () => {
  for (const errorCode of [AWAITING_OWN_APP, 'rate_limited', 'user_group_create_ambiguous', undefined]) {
    const presence: AgentSlackPresence = {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'needs_attention', avatar: AVATAR,
      ...(errorCode ? { errorCode } : {}),
    };
    assert.deepEqual(agentSlackState(presence), { state: 'not_in_slack' }, String(errorCode));
  }
  const grouped: AgentSlackPresence = {
    requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: AVATAR, userGroupId: 'S1',
  };
  assert.deepEqual(agentSlackState(grouped), { state: 'user_group' });
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

/** Management with a creation that leaves its Agent waiting for its own app, as the reconciler does with the setting on. */
async function waitingCreation(suffix: string) {
  const f: ManagementAdapterFixture = await createManagementAdapterFixture(suffix, {
    publishAgentPresence: async ({ agentId }) => {
      const current = await f.config.getAgent(agentId);
      return {
        agent: await f.config.updateAgent(agentId, {
          lifecycle: 'active',
          slackPresence: { ...asUserGroup(current.slackPresence), desiredState: 'active', health: 'unpublished', errorCode: AWAITING_OWN_APP },
        }, current.revision),
      };
    },
  });
  return f;
}

function creation(agentId: string): ManagementOperation {
  return {
    itemId: 'create', kind: 'create_agent',
    agent: {
      id: agentId, name: 'Support', description: 'Answers support questions.', requestedHandle: 'support',
      editPolicy: 'creator_and_admins', instructions: 'Answer support questions.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  } as ManagementOperation;
}

const welcomeOf = (record: ManagementReceiptOutboxRecord | undefined) => {
  assert.ok(record && 'kind' in record.receipt && record.receipt.kind === 'agent_created_welcome');
  return record.receipt;
};

test('an Owner who creates an Agent not in Slack yet is welcomed by it, with no handle and the button to add it', async (t) => {
  const f = await waitingCreation('own-app-owner');
  t.after(() => f.close());
  const applied = await f.service.applyWorkspaceChanges({ context: ownerMcpContext(f), idempotencyKey: 'own-app-owner', operations: [creation('agent_support')] });
  if (!('operationId' in applied)) assert.fail('expected an applied creation');

  const welcome = welcomeOf(await f.management.getOutboxForOperation(applied.operationId));
  assert.equal(welcome.notInSlackYet, 'creator_adds');
  assert.equal(welcome.agentHandle, undefined, 'no handle is offered that reaches no one');
  assert.deepEqual(welcome.publication, { status: 'complete', incomplete: [] }, 'waiting is not a failure');
  const text = formatManagementSetupReceipt(welcome);
  assert.match(text, /^Hi — I’m \*Support\*\. Answers support questions\./);
  assert.match(text, /I’m not in Slack yet, so people can’t mention me\. Choose Add to Slack to give me my own Slack app\./);
  const queued = await f.management.claimDueOutbox(NOW * 2, 25, NOW * 2 + 1);
  assert.deepEqual(queued.map(({ receipt }) => 'kind' in receipt && receipt.kind), ['agent_created_welcome'], 'no Owner is asked: the creator is one');

  // Delivered, the welcome carries the button under its words, posted as the Agent.
  const posted: Array<Record<string, unknown>> = [];
  const client = {
    conversations: { open: async () => ({ ok: true, channel: { id: 'D_OWNER' } }) },
    chat: { postMessage: async (message: Record<string, unknown>) => { posted.push(message); return { ok: true, ts: '1.0' }; } },
  };
  await deliverManagementReceiptToSlack(queued[0]!, {
    identity: f.identity,
    resolveInstallation: async (workspaceId) => ({ workspaceId, transportMode: 'direct', sharedAppReads: false, botUserId: 'UBOT', client: client as never }),
  });
  assert.equal(posted[0]?.username, 'Support');
  assert.deepEqual((posted[0]?.blocks as unknown[]).at(-1), {
    type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: 'agent_app_start', value: 'agent_support', text: { type: 'plain_text', text: 'Add to Slack' } }],
  });
  assert.equal((posted[0]?.blocks as Array<{ text?: { text: string } }>).slice(0, -1).map((block) => block.text?.text).join('\n\n'), posted[0]?.text);
});

// Defects caught: the welcome saying Owners were asked when asking failed or found nobody to ask.
test('a creator who is not an Owner is never told the Owners were asked when none could be', async (t) => {
  const f = await waitingCreation('own-app-nobody');
  t.after(() => f.close());
  const put = f.management.putOutbox.bind(f.management);
  f.management.putOutbox = async (record) => {
    if (record.outboxId.startsWith('agent_app_add:')) throw new Error('outbox unavailable');
    return put(record);
  };
  const warn = t.mock.method(console, 'warn', () => undefined);
  const admin: ManagementActorContext = {
    userId: f.admin.user.id, membershipId: f.admin.membership.id, organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'adapter-test' },
  };
  const applied = await f.service.applyWorkspaceChanges({ context: admin, idempotencyKey: 'own-app-nobody', operations: [creation('agent_support')] });
  if (!('operationId' in applied)) assert.fail('expected an applied creation');

  const welcome = welcomeOf(await f.management.getOutboxForOperation(applied.operationId));
  assert.equal(welcome.notInSlackYet, 'owner_needed');
  const text = formatManagementSetupReceipt(welcome);
  assert.match(text, /I’m not in Slack yet\. A workspace Owner needs to add me to Slack before people can mention me\./);
  assert.equal(text.includes('asked'), false);
  const fallback = formatManagementSetupReceipt({ ...welcome, publication: { status: 'partial', incomplete: ['slack_presence'] } });
  assert.match(fallback, /^I created \*Support\*\. A workspace Owner needs to add it to Slack before people can mention it\.\n/);
  assert.equal(fallback.includes('asked'), false);
  assert.ok(warn.mock.calls.length > 0, 'the operator sees that the Owners were not asked');
});

test('a creator who is not an Owner is told an Owner adds it, and each Owner gets the button with the creator named', async (t) => {
  const f = await waitingCreation('own-app-admin');
  t.after(() => f.close());
  const admin: ManagementActorContext = {
    userId: f.admin.user.id, membershipId: f.admin.membership.id, organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'adapter-test' },
  };
  const applied = await f.service.applyWorkspaceChanges({ context: admin, idempotencyKey: 'own-app-admin', operations: [creation('agent_support')] });
  if (!('operationId' in applied)) assert.fail('expected an applied creation');

  const welcome = welcomeOf(await f.management.getOutboxForOperation(applied.operationId));
  assert.equal(welcome.notInSlackYet, 'owners_asked');
  assert.match(formatManagementSetupReceipt(welcome),
    /I’m not in Slack yet\. A workspace Owner needs to add me to Slack before people can mention me\. I’ve asked them\./);
  const fallback = { ...welcome, publication: { status: 'partial' as const, incomplete: ['slack_presence' as const] } };
  assert.match(formatManagementSetupReceipt(fallback), /^I created \*Support\*\. A workspace Owner needs to add it to Slack before people can mention it\. I’ve asked them\./,
    'where Slack will not take the Agent\'s name, Chickpea says it in its own words');

  const owner = f.owner.binding.slackUserId;
  const asked = await f.management.getOutboxForOperation(`agent_app_add:agent_support:${owner}`);
  assert.deepEqual(asked?.destination, { kind: 'slack_dm', workspaceId: f.owner.binding.slackTeamId, slackUserId: owner });
  assert.deepEqual(asked?.receipt, { kind: 'agent_app_add_request', agentId: 'agent_support', agentName: 'Support', creatorSlackUserId: 'U87654321' });
  assert.equal(formatManagementSetupReceipt(asked!.receipt),
    '<@U87654321> created *Support*, and it isn’t in Slack yet, so people can’t mention it. Choose Add to Slack to give it its own Slack app.');
  const owners = (await f.management.claimDueOutbox(NOW * 2, 25, NOW * 2 + 1)).filter(({ receipt }) => 'kind' in receipt && receipt.kind === 'agent_app_add_request');
  assert.equal(owners.length, 1, 'only the Owner is asked, not the Admin who created it');

  const posted: Array<Record<string, unknown>> = [];
  const client = {
    conversations: { open: async () => ({ ok: true, channel: { id: 'D_OWNER' } }) },
    chat: { postMessage: async (message: Record<string, unknown>) => { posted.push(message); return { ok: true, ts: '1.0' }; } },
  };
  await deliverManagementReceiptToSlack(asked!, {
    identity: f.identity,
    resolveInstallation: async (workspaceId) => ({ workspaceId, transportMode: 'direct', sharedAppReads: false, botUserId: 'UBOT', client: client as never }),
  });
  assert.deepEqual(posted[0]?.blocks, [
    { type: 'section', text: { type: 'mrkdwn', text: formatManagementSetupReceipt(asked!.receipt) } },
    { type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: 'agent_app_start', value: 'agent_support', text: { type: 'plain_text', text: 'Add to Slack' } }] },
  ]);
});
