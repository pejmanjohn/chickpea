import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementApplyResult,
} from '../src/management/types.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import {
  applyThroughAdapter,
  createManagementAdapterFixture,
  ownerMcpContext,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';
import { slackTurnSignal } from './helpers/slack-turn-signal.ts';

const CHANNEL = 'C_SUPPORT';

async function workspace(t: TestContext, suffix: string) {
  const f = await createManagementAdapterFixture(suffix);
  t.after(() => f.close());
  const teamId = f.owner.binding.slackTeamId;
  await f.config.putChannel({ workspaceId: teamId, channelId: CHANNEL, label: 'support', lifecycle: 'active' });
  return { f, teamId };
}

/** The fixture's second person, asking from an MCP client. */
function secondPersonMcp(f: ManagementAdapterFixture): ManagementActorContext {
  return {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'channel-authority' },
  };
}

async function demoteToMember(f: ManagementAdapterFixture): Promise<void> {
  await f.identity.updateMembershipAuthority({
    membershipId: f.admin.membership.id,
    role: 'member',
    actorMembershipId: f.owner.membership.id,
    correlationId: 'demote-channel-authority',
    authenticationSurface: 'better_auth',
    reasonCode: 'channel_authority_test',
  });
}

async function lifecycle(f: ManagementAdapterFixture, teamId: string) {
  return (await f.config.getChannel(teamId, CHANNEL))?.lifecycle;
}

async function putChannel(
  f: ManagementAdapterFixture,
  context: ManagementActorContext,
  teamId: string,
  key: string,
  channel: { lifecycle: 'active' | 'archived'; label?: string; channelId?: string },
): Promise<ManagementApplyResult> {
  const channelId = channel.channelId ?? CHANNEL;
  return await applyThroughAdapter(f, context, key, [{
    itemId: 'channel',
    kind: 'put_channel',
    channel: { workspaceId: teamId, channelId, label: channel.label ?? 'support', lifecycle: channel.lifecycle },
    expectedRevision: (await f.config.getChannel(teamId, channelId))?.revision ?? 0,
  }]);
}

async function turnOffAsOwner(f: ManagementAdapterFixture, teamId: string, key: string): Promise<void> {
  const off = await putChannel(f, ownerMcpContext(f), teamId, key, { lifecycle: 'archived' });
  assert.equal(off.outcomes[0]?.disposition, 'applied', JSON.stringify(off));
  assert.equal(await lifecycle(f, teamId), 'archived');
}

const BACK_ON_REFUSED = 'Chickpea is off in this Channel, and only a workspace Owner or Admin can turn it back on or change it. Ask one of them to do it.';
const OFF_REFUSED = 'Only a workspace Owner or Admin can turn Chickpea off in a Channel or change one where it is off. Ask one of them to do it.';

function assertRefusedToMember(result: ManagementApplyResult, teamId: string, instruction = BACK_ON_REFUSED): void {
  const [outcome] = result.outcomes;
  assert.equal(outcome?.disposition, 'failed', JSON.stringify(result));
  assert.equal(outcome?.code, 'operational_access_required');
  assert.equal(outcome?.instruction, instruction);
  assert.equal(outcome?.links?.admin, undefined, `${teamId}: Admin has no on/off control for a Channel, so no link`);
}

test('a Member cannot turn Chickpea back on in a Channel an Owner or Admin turned off, over MCP or in Slack', async (t) => {
  const { f, teamId } = await workspace(t, 'channel_reenable_member');
  await turnOffAsOwner(f, teamId, 'owner-off');
  await demoteToMember(f);
  const member = secondPersonMcp(f);

  assertRefusedToMember(await putChannel(f, member, teamId, 'member-on', { lifecycle: 'active' }), teamId);
  assert.equal(await lifecycle(f, teamId), 'archived', 'MCP leaves it off');

  assertRefusedToMember(
    await putChannel(f, member, teamId, 'member-relabel-off', { lifecycle: 'archived', label: 'renamed' }),
    teamId,
    OFF_REFUSED,
  );
  assert.equal((await f.config.getChannel(teamId, CHANNEL))?.label, 'support', 'a Channel that is off keeps its settings');
  assertRefusedToMember(
    await putChannel(f, member, teamId, 'member-new-off', { lifecycle: 'archived', channelId: 'C_NEW', label: 'new' }),
    teamId,
    OFF_REFUSED,
  );
  assert.equal(await f.config.getChannel(teamId, 'C_NEW'), undefined, 'a Member cannot record a new Channel as off');

  const offRevision = (await f.config.getChannel(teamId, CHANNEL))!.revision!;
  await assert.rejects(
    () => f.service.proposeWorkspaceChanges({
      context: member,
      ...authoringProposalMetadata('member-propose-on'),
      operations: [{
        itemId: 'channel',
        kind: 'put_channel',
        channel: { workspaceId: teamId, channelId: CHANNEL, label: 'support', lifecycle: 'active' },
        expectedRevision: offRevision,
      }],
    }),
    (error: unknown) => error instanceof ManagementError && error.code === 'forbidden',
  );

  const slack = await invokeSlackWorkspaceManagementTool({
    signal: slackTurnSignal({
      turn: { text: 'Turn Chickpea back on in #support.', eventId: 'Ev_MEMBER_ON', messageTs: '800.2' },
      agentId: CHICKPEA_AGENT_ID,
      conversation: { workspaceId: teamId, channelId: 'D_MEMBER', threadTs: '800.1' },
      conversationKind: 'im',
      slackUserId: f.admin.binding.slackUserId,
    }),
    identity: f.identity,
    service: f.service,
    name: 'apply_workspace_changes',
    args: {
      idempotencyKey: 'slack-member-on',
      operations: [{
        itemId: 'channel',
        kind: 'put_channel',
        channel: { workspaceId: teamId, channelId: CHANNEL, label: 'support', lifecycle: 'active' },
        expectedRevision: offRevision,
      }],
    },
  });
  assert.ok(slack.ok, JSON.stringify(slack));
  assertRefusedToMember(slack.result as ManagementApplyResult, teamId);
  assert.equal(await lifecycle(f, teamId), 'archived', 'the Slack door leaves it off');
});

test('an Owner or Admin turns Chickpea back on in a Channel that is off', async (t) => {
  const { f, teamId } = await workspace(t, 'channel_reenable_admin');
  await turnOffAsOwner(f, teamId, 'owner-off');
  const admin = await putChannel(f, secondPersonMcp(f), teamId, 'admin-on', { lifecycle: 'active' });
  assert.equal(admin.outcomes[0]?.disposition, 'applied', JSON.stringify(admin));
  assert.equal(await lifecycle(f, teamId), 'active');

  await turnOffAsOwner(f, teamId, 'owner-off-again');
  const owner = await putChannel(f, ownerMcpContext(f), teamId, 'owner-on', { lifecycle: 'active' });
  assert.equal(owner.outcomes[0]?.disposition, 'applied', JSON.stringify(owner));
  assert.equal(await lifecycle(f, teamId), 'active');
});

test('a Member still renames a Channel where Chickpea is on and records a new one', async (t) => {
  const { f, teamId } = await workspace(t, 'channel_member_active');
  await demoteToMember(f);
  const member = secondPersonMcp(f);
  assertRefusedToMember(
    await putChannel(f, member, teamId, 'member-off', { lifecycle: 'archived' }),
    teamId,
    OFF_REFUSED,
  );
  assert.equal(await lifecycle(f, teamId), 'active', 'a Member cannot turn Chickpea off');

  const renamed = await putChannel(f, member, teamId, 'member-rename', { lifecycle: 'active', label: 'help' });
  assert.equal(renamed.outcomes[0]?.disposition, 'applied', JSON.stringify(renamed));
  assert.equal((await f.config.getChannel(teamId, CHANNEL))?.label, 'help');

  const recorded = await putChannel(f, member, teamId, 'member-new', { lifecycle: 'active', channelId: 'C_NEW', label: 'new' });
  assert.equal(recorded.outcomes[0]?.disposition, 'applied', JSON.stringify(recorded));
  assert.equal((await f.config.getChannel(teamId, 'C_NEW'))?.lifecycle, 'active');
});

test('a confirmation resumed after its requester became a Member does not turn Chickpea back on', async (t) => {
  const { f, teamId } = await workspace(t, 'channel_reenable_resume');
  await turnOffAsOwner(f, teamId, 'owner-off');
  const admin = secondPersonMcp(f);
  const proposed = await f.service.proposeWorkspaceChanges({
    context: admin,
    ...authoringProposalMetadata('admin-propose-on'),
    operations: [{
      itemId: 'channel',
      kind: 'put_channel',
      channel: { workspaceId: teamId, channelId: CHANNEL, label: 'support', lifecycle: 'active' },
      expectedRevision: (await f.config.getChannel(teamId, CHANNEL))!.revision!,
    }],
  });
  // The first attempt died while applying, longer ago than its lease.
  await f.management.claimChangeSetProposal({
    proposalId: proposed.proposalId,
    organizationId: admin.organizationId,
    actorUserId: admin.userId,
    actorMembershipId: admin.membershipId,
    originKey: 'mcp:channel-authority',
    at: 0,
  });
  await demoteToMember(f);

  await assert.rejects(
    () => f.service.confirmWorkspaceChange({ context: admin, proposalId: proposed.proposalId }),
    (error: unknown) => error instanceof ManagementError && error.code === 'forbidden',
  );
  assert.equal(await lifecycle(f, teamId), 'archived', 'the Channel stays off');
  assert.equal((await f.management.getChangeSetProposal(proposed.proposalId))?.status, 'stale');
});

// Defect caught: an Admin's turn-off landing between the policy read and the write was undone by a Member's change.
test('a Member write the policy allowed cannot land on a turn-off made after the policy read', async (t) => {
  const { f, teamId } = await workspace(t, 'channel_reenable_race');
  await demoteToMember(f);
  const before = (await f.config.getChannel(teamId, CHANNEL))!;
  // f.config is the async facade: a Proxy whose methods run the synchronous store
  // logic with `this` bound to the raw store. Hook the raw prototype method so the
  // store's own `this.getChannel` reads stay synchronous, and run the Owner's
  // turn-off inside the Member's policy read, after that read saw the Channel on.
  const logic = Object.getPrototypeOf(f.config) as {
    getChannel(this: unknown, workspaceId: string, channelId: string): unknown;
    putChannel(this: unknown, channel: unknown, expectedRevision?: number): unknown;
  };
  const hooked = f.config as unknown as Record<string, unknown>;
  let fired = false;
  let firedInPolicy = false;
  hooked.getChannel = function (this: unknown, workspaceId: string, channelId: string) {
    const read = logic.getChannel.call(this, workspaceId, channelId);
    if (!fired && channelId === CHANNEL) {
      fired = true;
      firedInPolicy = new Error().stack?.includes('policyFacts') ?? false;
      logic.putChannel.call(
        this,
        { workspaceId: teamId, channelId: CHANNEL, label: 'support', lifecycle: 'archived' },
        before.revision,
      );
    }
    return read;
  };
  let result: ManagementApplyResult;
  try {
    // The Member names the revision the turn-off will produce.
    result = await applyThroughAdapter(f, secondPersonMcp(f), 'member-race', [{
      itemId: 'channel',
      kind: 'put_channel',
      channel: { workspaceId: teamId, channelId: CHANNEL, label: 'renamed', lifecycle: 'active' },
      expectedRevision: before.revision! + 1,
    }]);
  } finally {
    delete hooked.getChannel;
  }
  assert.ok(firedInPolicy, 'the turn-off ran inside the policy read, the first read of the Channel');
  assert.equal(result.outcomes[0]?.disposition, 'failed', JSON.stringify(result));
  assert.equal(result.outcomes[0]?.code, 'revision_conflict');
  const after = await f.config.getChannel(teamId, CHANNEL);
  assert.equal(after?.lifecycle, 'archived', 'the Channel stays off');
  assert.equal(after?.label, 'support');
  assert.equal(after?.revision, before.revision! + 1, 'only the turn-off wrote');
});
