import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  executeHostSlackManagementApproval,
  resolveHostSlackManagementApproval,
} from '../src/management/slack-approval.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import type {
  WorkspaceManagementToolArguments,
  WorkspaceManagementToolResult,
} from '../src/management/tool-adapter.ts';
import { SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import { shouldResolveSlackManagementApproval } from '../src/slack/interaction-intent.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { authorizeUiResponse } from '../src/slack/ui/authorize.ts';
import { deliverHostApprovalSurfaces, type UiSurfaceMessenger } from '../src/slack/ui/host-surfaces.ts';
import type { RenderedUiSurface } from '../src/slack/ui/render.ts';
import type { UiSurfaceRecord } from '../src/slack/ui/surface.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const BOT_USER_ID = 'UCHICKPEA1';
const SPROUT_GROUP_ID = 'SSPROUT1';
const PERSON_USER_ID = 'UPERSON1';
const CHANNEL_ID = 'C_CONFIRM_CARD';
const THREAD_TS = '1799999990.000100';
/** The fixture clock is 1_800_000_000_000 ms; a card belongs to a turn that started by then. */
const TURN_TS = '1800000000.000000';

const ORIGINAL_SKILLS = [
  { name: 'unslop', enabled: true },
  { name: 'keep-me', enabled: true },
];

async function confirmationFixture(
  suffix: string,
  overrides: Parameters<typeof createManagementAdapterFixture>[1] = {},
) {
  const f = await createManagementAdapterFixture(suffix, overrides);
  const createAgent = async (id: string, name: string, userGroupId: string) => {
    const created = await f.config.createAgent({
      id,
      name,
      creatorMembershipId: f.admin.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: `Help with ${name}.`,
      enabled: true,
      skills: [{
        name: 'unslop',
        description: 'Rewrite plainly.',
        instructions: 'Preserve this local procedure.',
        enabled: true,
      }, {
        name: 'keep-me',
        description: 'Keep this skill.',
        instructions: 'Remain installed.',
        enabled: true,
      }],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    return await f.config.updateAgent(created.id, {
      slackPresence: {
        ...created.slackPresence!,
        kind: 'user_group',
        desiredState: 'active',
        health: 'healthy',
        userGroupId,
      },
    }, created.revision);
  };
  const sprout = await createAgent('agent_confirm_sprout', 'Sprout', SPROUT_GROUP_ID);
  await f.config.ensureWorkspaceInstallation({
    workspaceId: f.admin.user.slackTeamId,
    transportMode: 'direct',
    teamId: f.admin.user.slackTeamId,
    appId: 'ACHICKPEA1',
    botUserId: BOT_USER_ID,
    runtimeContract: 'chickpea-v1',
  });
  const state = new SqliteSlackStateStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const posts: RenderedUiSurface[] = [];
  const messenger: UiSurfaceMessenger = {
    async post(rendered) {
      posts.push(rendered);
      return `1800000001.00000${posts.length}`;
    },
    async update() {},
  };
  const requester = {
    slackUserId: f.admin.binding.slackUserId,
    membershipId: f.admin.membership.id,
  };
  const otherPerson = {
    slackUserId: f.owner.binding.slackUserId,
    membershipId: f.owner.membership.id,
  };

  let sequence = 0;
  const send = <TName extends
    'manage_agent_skill' | 'undo_workspace_change' | 'apply_workspace_changes' | 'confirm_workspace_change'>(
    agentId: string,
    requesterText: string,
    name: TName,
    args: Omit<WorkspaceManagementToolArguments[TName], 'idempotencyKey'> & { idempotencyKey?: string },
  ): Promise<WorkspaceManagementToolResult> => {
    sequence += 1;
    const signal: SlackManagementSignal = {
      agentId,
      workspaceId: f.admin.user.slackTeamId,
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      conversationKind: 'channel',
      slackUserId: requester.slackUserId,
      eventId: `Ev_CONFIRM_${sequence}`,
      messageTs: `1799999991.00000${sequence}`,
      turnJobId: `turn_CONFIRM_${sequence}`,
      requesterText,
    };
    return invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name,
      args: {
        idempotencyKey: `confirm-card-${sequence}`,
        ...args,
      } as WorkspaceManagementToolArguments[TName],
    });
  };

  const assignment = (agentId: string) => ({
    agent: { id: agentId },
    agentId,
    runtimeContract: 'chickpea-v1',
  }) as unknown as ResolvedAssignment;
  const turn = (
    person: { slackUserId: string; membershipId: string },
    text: string,
    patch: Partial<NormalizedSlackTurn> = {},
  ): NormalizedSlackTurn => ({
    workspaceId: f.admin.user.slackTeamId,
    channelId: CHANNEL_ID,
    userId: person.slackUserId,
    text,
    eventId: `Ev_TURN_${++sequence}`,
    messageTs: TURN_TS,
    threadTs: THREAD_TS,
    source: 'implicit_thread_reply',
    channelType: 'channel',
    contextMode: 'thread',
    actorMembershipId: person.membershipId,
    ...patch,
  });
  /** The host's after-reply step: post the Approve card this turn's proposal needs. */
  const deliverCard = async (agentId: string, text: string): Promise<UiSurfaceRecord | undefined> => {
    await deliverHostApprovalSurfaces({
      turn: turn(requester, text),
      assignment: assignment(agentId),
      turnJobId: `job_card_${++sequence}`,
      state,
      identity: f.identity,
      management: f.management,
      messenger,
    });
    const open = await state.executeUiSurface!({
      kind: 'list_open_surfaces',
      scope: { workspaceId: f.admin.user.slackTeamId, channelId: CHANNEL_ID, threadTs: THREAD_TS, agentId },
    });
    return open.kind === 'surfaces' ? open.surfaces.at(-1) : undefined;
  };
  /** A click on the card, through the same authorization a real click passes. */
  const click = async (
    agentId: string,
    surface: UiSurfaceRecord,
    person: { slackUserId: string; membershipId: string },
    choice: 0 | 1,
  ) => {
    const clicked = turn(person, choice === 0
      ? 'Approved the proposed workspace changes with the Approve button.'
      : 'Cancelled the proposed workspace changes with the Cancel button. Do not apply them.');
    const refusal = await authorizeUiResponse({
      admission: { surface, choice, outcome: 'unavailable' },
      turn: clicked,
      assignment: assignment(agentId),
      actorMembershipId: person.membershipId,
      stores: { identity: f.identity, management: f.management, settings },
    });
    return { refusal, clicked };
  };
  /** The approval turn the host runs once a click or typed reply carries a proposal. */
  const approve = (agentId: string, approvalTurn: NormalizedSlackTurn, proposalId: string) =>
    executeHostSlackManagementApproval({
      turn: approvalTurn,
      assignment: assignment(agentId),
      turnJobId: `job_approve_${++sequence}`,
      proposalId,
      dependencies: { identity: f.identity, config: f.config, management: f.management, service: f.service },
    });
  const typedApproval = (agentId: string, person: { slackUserId: string; membershipId: string }) => {
    const typed = turn(person, 'approve');
    return resolveHostSlackManagementApproval({
      turn: typed,
      assignment: assignment(agentId),
      actorMembershipId: person.membershipId,
      identity: f.identity,
      management: f.management,
    }).then((proposalId) => ({ proposalId, typed }));
  };
  const skills = async (agentId = sprout.id) =>
    (await f.config.getAgent(agentId)).skills.map(({ name, enabled }) => ({ name, enabled }));

  return {
    f, sprout, send, posts, deliverCard, click, approve, typedApproval, skills, requester, otherPerson,
    createAgent,
    close() {
      state.close();
      settings.close();
      f.close();
    },
  };
}

function pendingConfirmation(result: WorkspaceManagementToolResult) {
  assert.equal(result.ok, true);
  const value = (result as { ok: true; result: Record<string, unknown> }).result;
  assert.equal(value.status, 'confirmation_required');
  const outcome = (value.outcomes as Array<{ disposition: string; proposalId?: string }>)
    .find(({ disposition }) => disposition === 'confirmation_required');
  assert.ok(outcome?.proposalId, 'the confirmation names its proposal');
  const presentation = value.presentation as { slack?: unknown } | undefined;
  assert.equal(typeof presentation?.slack, 'string', 'the person gets a preview to read before the card');
  assert.match(String(value.instruction), /Approve button/);
  return { proposalId: outcome.proposalId, preview: presentation!.slack as string };
}

test('"<@PERSON>, undo" in an Agent\'s thread gets an Approve card that applies the undo, and only the requester can approve it', async () => {
  const fixture = await confirmationFixture('confirm-card-undo');
  const { sprout, send, posts, deliverCard, click, approve, typedApproval, skills, requester, otherPerson } = fixture;
  try {
    const removed = await send(sprout.id, 'remove the unslop skill',
      'manage_agent_skill', { action: 'remove', skillName: 'unslop' });
    assert.equal(removed.ok, true);
    const operationId = (removed as { ok: true; result: { operationId: string } }).result.operationId;
    const removedSkills = await skills();
    assert.deepEqual(removedSkills, [{ name: 'keep-me', enabled: true }]);

    const undoText = `<@${PERSON_USER_ID}>, undo`;
    const undo = await send(sprout.id, undoText, 'undo_workspace_change', { operationId });
    const { proposalId, preview } = pendingConfirmation(undo);
    assert.match(preview, /unslop/);
    assert.deepEqual(await skills(), removedSkills);

    const card = await deliverCard(sprout.id, undoText);
    assert.equal(posts.length, 1, 'one Approve card is posted');
    assert.match(JSON.stringify(posts[0]!.blocks), /"Approve".*"Cancel"/);
    assert.deepEqual(card?.spec, { kind: 'approval', approval: 'workspace_change', proposalId });

    // Another person can neither press the requester's card nor approve by typing.
    assert.equal((await click(sprout.id, card!, otherPerson, 0)).refusal, 'wrong_user');
    assert.equal((await typedApproval(sprout.id, otherPerson)).proposalId, undefined);
    // Even a forged approval turn from them is refused by the service.
    const forged = await approve(sprout.id, (await typedApproval(sprout.id, otherPerson)).typed, proposalId);
    assert.deepEqual(forged, {
      kind: 'message',
      text: 'I couldn’t apply that proposal from this requester or conversation.',
    });
    assert.deepEqual(await skills(), removedSkills);

    const pressed = await click(sprout.id, card!, requester, 0);
    assert.equal(pressed.refusal, undefined);
    assert.equal(pressed.clicked.managementApprovalProposalId, proposalId);
    assert.deepEqual(await approve(sprout.id, pressed.clicked, proposalId),
      { kind: 'message', text: 'Applied the approved changes.' });
    assert.deepEqual(await skills(), ORIGINAL_SKILLS);
    // The applied card is no longer current, so nothing applies twice.
    assert.equal((await click(sprout.id, card!, requester, 0)).refusal, 'not_current');
  } finally {
    fixture.close();
  }
});

test('a typed "approve" from the requester finds the confirmation, and Cancel leaves it unapplied', async () => {
  const fixture = await confirmationFixture('confirm-card-typed');
  const { f, sprout, send, deliverCard, click, approve, typedApproval, skills, requester } = fixture;
  try {
    const removeAndAskUndo = async () => {
      const removed = await send(sprout.id, 'remove the unslop skill',
        'manage_agent_skill', { action: 'remove', skillName: 'unslop' });
      const operationId = (removed as { ok: true; result: { operationId: string } }).result.operationId;
      const undo = () => send(sprout.id, `<@${PERSON_USER_ID}>, undo`, 'undo_workspace_change', {
        operationId, idempotencyKey: `undo-${operationId}`,
      });
      return { proposalId: pendingConfirmation(await undo()).proposalId, undo };
    };

    const declined = await removeAndAskUndo();
    // A retried call shows the same preview while it is pending.
    assert.equal(pendingConfirmation(await declined.undo()).proposalId, declined.proposalId);
    const card = await deliverCard(sprout.id, `<@${PERSON_USER_ID}>, undo`);
    const cancelled = await click(sprout.id, card!, requester, 1);
    assert.equal(cancelled.refusal, undefined);
    assert.equal(cancelled.clicked.managementApprovalProposalId, undefined);
    // The Cancel click retires the proposal it names (channels/slack.ts does this on admission).
    await f.management.markChangeSetProposalStale(declined.proposalId, 1_800_000_000_000);
    assert.equal((await typedApproval(sprout.id, requester)).proposalId, undefined);
    assert.deepEqual(await skills(), [{ name: 'keep-me', enabled: true }]);
    const retried = await declined.undo();
    assert.equal((retried as { ok: true; result: { presentation?: unknown } }).result.presentation, undefined,
      'a cancelled change is not previewed again');

    const current = await f.config.getAgent(sprout.id);
    await f.config.updateAgent(sprout.id, {
      skills: [{
        name: 'unslop', description: 'Rewrite plainly.', instructions: 'Preserve this local procedure.', enabled: true,
      }, ...current.skills],
    }, current.revision);
    const { proposalId } = await removeAndAskUndo();
    assert.equal(shouldResolveSlackManagementApproval('approve'), true);
    const typed = await typedApproval(sprout.id, requester);
    assert.equal(typed.proposalId, proposalId);
    assert.deepEqual(await approve(sprout.id, typed.typed, proposalId),
      { kind: 'message', text: 'Applied the approved changes.' });
    assert.deepEqual(await skills(), ORIGINAL_SKILLS);
  } finally {
    fixture.close();
  }
});

test('an inline apply_workspace_changes confirmation in an Agent\'s thread gets an Approve card that applies exactly it', async () => {
  const fixture = await confirmationFixture('confirm-card-apply');
  const { f, sprout, send, posts, deliverCard, click, approve, typedApproval, requester, otherPerson } = fixture;
  try {
    const text = 'change your description to Rewrites drafts and your instructions to Rewrite drafts plainly.';
    const applied = await send(sprout.id, text, 'apply_workspace_changes', {
      operations: [{
        itemId: 'profile',
        kind: 'update_agent',
        agentId: sprout.id,
        expectedRevision: sprout.revision,
        patch: { description: 'Rewrites drafts', instructions: 'Rewrite drafts plainly.' },
      }],
    });
    const { proposalId, preview } = pendingConfirmation(applied);
    assert.match(preview, /Rewrites drafts/);
    const before = await f.config.getAgent(sprout.id);
    assert.equal(before.instructions, 'Help with Sprout.');

    const card = await deliverCard(sprout.id, text);
    assert.equal(posts.length, 1);
    assert.equal(card?.spec.kind === 'approval' && card.spec.approval === 'workspace_change'
      ? card.spec.proposalId
      : undefined, proposalId);
    assert.equal((await click(sprout.id, card!, otherPerson, 0)).refusal, 'wrong_user');
    assert.equal((await typedApproval(sprout.id, otherPerson)).proposalId, undefined);

    const pressed = await click(sprout.id, card!, requester, 0);
    assert.equal(pressed.clicked.managementApprovalProposalId, proposalId);
    assert.deepEqual(await approve(sprout.id, pressed.clicked, proposalId),
      { kind: 'message', text: 'Applied the approved changes.' });
    const after = await f.config.getAgent(sprout.id);
    assert.equal(after.description, 'Rewrites drafts');
    assert.equal(after.instructions, 'Rewrite drafts plainly.');
    assert.equal(after.revision, before.revision + 1, 'approval applies the frozen change once');
  } finally {
    fixture.close();
  }
});

test('a confirmation mid-call holds the rest of the call, and approval applies exactly what the preview lists', async () => {
  const fixture = await confirmationFixture('confirm-card-batch');
  const { f, send, deliverCard, click, approve, requester, createAgent } = fixture;
  try {
    const alpha = await createAgent('agent_confirm_alpha', 'Alpha', 'SALPHA1');
    const beta = await createAgent('agent_confirm_beta', 'Beta', 'SBETA1');
    const gamma = await createAgent('agent_confirm_gamma', 'Gamma', 'SGAMMA1');
    const text = `<@${BOT_USER_ID}> update Alpha, Beta and Gamma`;
    const applied = await send(CHICKPEA_AGENT_ID, text, 'apply_workspace_changes', {
      operations: [{
        itemId: 'alpha-description',
        kind: 'update_agent',
        agentId: alpha.id,
        expectedRevision: alpha.revision,
        patch: { description: 'Alpha, now described' },
      }, {
        itemId: 'beta-profile',
        kind: 'update_agent',
        agentId: beta.id,
        expectedRevision: beta.revision,
        patch: { description: 'Beta, now described', instructions: 'Help with Beta, carefully.' },
      }, {
        itemId: 'gamma-description',
        kind: 'update_agent',
        agentId: gamma.id,
        expectedRevision: gamma.revision,
        patch: { description: 'Gamma, now described' },
        dependsOn: ['alpha-description'],
      }],
    });
    const { proposalId, preview } = pendingConfirmation(applied);
    const outcomes = (applied as { ok: true; result: { outcomes: Array<{ itemId: string; disposition: string }> } })
      .result.outcomes.map(({ itemId, disposition }) => ({ itemId, disposition }));
    assert.deepEqual(outcomes, [
      { itemId: 'alpha-description', disposition: 'applied' },
      { itemId: 'beta-profile', disposition: 'confirmation_required' },
    ]);
    assert.match(preview, /Beta, now described/);
    assert.match(preview, /Gamma, now described/);
    assert.doesNotMatch(preview, /Alpha, now described/);
    assert.equal((await f.config.getAgent(gamma.id)).description, gamma.description);

    const card = await deliverCard(CHICKPEA_AGENT_ID, text);
    const pressed = await click(CHICKPEA_AGENT_ID, card!, requester, 0);
    assert.equal(pressed.clicked.managementApprovalProposalId, proposalId);
    assert.deepEqual(await approve(CHICKPEA_AGENT_ID, pressed.clicked, proposalId),
      { kind: 'message', text: 'Applied the approved changes.' });
    const [alphaAfter, betaAfter, gammaAfter] = await Promise.all([
      f.config.getAgent(alpha.id), f.config.getAgent(beta.id), f.config.getAgent(gamma.id),
    ]);
    assert.equal(alphaAfter.revision, alpha.revision + 1, 'the change applied before the confirmation is not applied again');
    assert.equal(betaAfter.instructions, 'Help with Beta, carefully.');
    assert.equal(gammaAfter.description, 'Gamma, now described');
  } finally {
    fixture.close();
  }
});

test('after approval, a held operation whose dependency failed earlier in the call is still skipped', async () => {
  const fixture = await confirmationFixture('confirm-card-failed-dependency');
  const { f, send, deliverCard, click, approve, requester, createAgent } = fixture;
  try {
    const alpha = await createAgent('agent_confirm_alpha', 'Alpha', 'SALPHA1');
    const beta = await createAgent('agent_confirm_beta', 'Beta', 'SBETA1');
    const gamma = await createAgent('agent_confirm_gamma', 'Gamma', 'SGAMMA1');
    const text = `<@${BOT_USER_ID}> update Alpha, Beta and Gamma`;
    const applied = await send(CHICKPEA_AGENT_ID, text, 'apply_workspace_changes', {
      operations: [{
        itemId: 'alpha-stale',
        kind: 'update_agent',
        agentId: alpha.id,
        expectedRevision: alpha.revision + 5,
        patch: { description: 'Alpha, now described' },
      }, {
        itemId: 'beta-profile',
        kind: 'update_agent',
        agentId: beta.id,
        expectedRevision: beta.revision,
        patch: { description: 'Beta, now described', instructions: 'Help with Beta, carefully.' },
      }, {
        itemId: 'gamma-after-alpha',
        kind: 'update_agent',
        agentId: gamma.id,
        expectedRevision: gamma.revision,
        patch: { description: 'Gamma, now described' },
        dependsOn: ['alpha-stale'],
      }],
    });
    assert.equal(applied.ok, true);
    const value = (applied as {
      ok: true;
      result: {
        status: string;
        outcomes: Array<{ disposition: string; proposalId?: string }>;
        presentation?: { slack: string };
        instruction?: string;
      };
    }).result;
    assert.equal(value.status, 'partial');
    assert.deepEqual(value.outcomes.map(({ disposition }) => disposition), ['failed', 'confirmation_required']);
    assert.match(value.presentation?.slack ?? '', /Beta, now described/);
    assert.match(value.instruction ?? '', /Approve button/);
    const proposalId = value.outcomes[1]!.proposalId!;

    const card = await deliverCard(CHICKPEA_AGENT_ID, text);
    const pressed = await click(CHICKPEA_AGENT_ID, card!, requester, 0);
    assert.deepEqual(await approve(CHICKPEA_AGENT_ID, pressed.clicked, proposalId), {
      kind: 'message',
      text: 'Applied some approved changes, but 1 item needs attention.\n\nIssue: dependency_not_applied',
    });
    assert.equal((await f.config.getAgent(beta.id)).instructions, 'Help with Beta, carefully.');
    assert.equal((await f.config.getAgent(gamma.id)).revision, gamma.revision);
  } finally {
    fixture.close();
  }
});

test('an Agent anyone may edit, created from a Channel, waits on one card for itself and its Channel', async () => {
  const fixture = await confirmationFixture('confirm-card-create');
  const { f, send, posts, deliverCard, click, approve, requester } = fixture;
  try {
    const workspaceId = f.admin.user.slackTeamId;
    await f.config.putChannel({ workspaceId, channelId: CHANNEL_ID, label: 'confirm-card', lifecycle: 'active' }, 0);
    const text = `<@${BOT_USER_ID}> create a Desk Agent that anyone here can edit`;
    const applied = await send(CHICKPEA_AGENT_ID, text, 'apply_workspace_changes', {
      operations: [{
        itemId: 'create-desk',
        kind: 'create_agent',
        agent: {
          id: 'agent_confirm_desk',
          name: 'Desk',
          instructions: 'Operate as Desk.',
          editPolicy: 'all_workspace_members',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      }],
    });
    const { proposalId } = pendingConfirmation(applied);
    assert.equal((await f.config.listUserAgents()).some(({ id }) => id === 'agent_confirm_desk'), false);

    const card = await deliverCard(CHICKPEA_AGENT_ID, text);
    assert.equal(posts.length, 1);
    const pressed = await click(CHICKPEA_AGENT_ID, card!, requester, 0);
    assert.equal(pressed.clicked.managementApprovalProposalId, proposalId);
    assert.equal((await approve(CHICKPEA_AGENT_ID, pressed.clicked, proposalId)).kind, 'message');
    assert.equal((await f.config.getAgent('agent_confirm_desk')).editPolicy, 'all_workspace_members');
    const grants = await f.config.listAgentChannelGrants(workspaceId, CHANNEL_ID);
    assert.deepEqual(grants.map(({ agentId, status }) => ({ agentId, status })),
      [{ agentId: 'agent_confirm_desk', status: 'active' }]);
  } finally {
    fixture.close();
  }
});

test('a setup request that replaces a stored key stays the Agent\'s to apply on a typed "approve"', async () => {
  const fixture = await confirmationFixture('confirm-card-setup', {
    providerCredentialSource: async () => 'stored',
  });
  const { send, posts, deliverCard, typedApproval, requester } = fixture;
  try {
    const text = `<@${BOT_USER_ID}> replace our Anthropic key`;
    const applied = await send(CHICKPEA_AGENT_ID, text, 'apply_workspace_changes', {
      operations: [{
        itemId: 'anthropic-key',
        kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'anthropic' },
      }],
    });
    assert.equal(applied.ok, true);
    const value = (applied as { ok: true; result: Record<string, unknown> }).result;
    assert.equal(value.status, 'confirmation_required');
    assert.match(String(value.instruction), /ask them to reply "approve"/);
    const proposalId = (value.outcomes as Array<{ proposalId?: string }>)[0]?.proposalId ?? '';
    assert.match(proposalId, /^proposal_/);

    await deliverCard(CHICKPEA_AGENT_ID, text);
    assert.equal(posts.length, 0, 'a host approval could not hand over the one-time setup link');
    assert.equal((await typedApproval(CHICKPEA_AGENT_ID, requester)).proposalId, undefined);
    const confirmed = await send(CHICKPEA_AGENT_ID, 'approve', 'confirm_workspace_change', { proposalId });
    assert.equal(confirmed.ok, true);
    const [outcome] = (confirmed as { ok: true; result: { outcomes: Array<Record<string, unknown>> } })
      .result.outcomes;
    assert.equal(outcome?.disposition, 'setup_required');
    assert.match(String(outcome?.setupUrl), /^http:\/\/localhost\//);
  } finally {
    fixture.close();
  }
});

test('a call a change set cannot hold keeps the proposal the Agent applies on a typed "approve"', async () => {
  const fixture = await confirmationFixture('confirm-card-chained');
  const { f, sprout, send, posts, deliverCard, typedApproval, requester } = fixture;
  try {
    // The second change to Sprout expects the revision the first one makes.
    const text = 'update your profile, then shorten your description';
    const applied = await send(sprout.id, text, 'apply_workspace_changes', {
      operations: [{
        itemId: 'profile',
        kind: 'update_agent',
        agentId: sprout.id,
        expectedRevision: sprout.revision,
        patch: { description: 'Rewrites drafts plainly', instructions: 'Rewrite drafts plainly.' },
      }, {
        itemId: 'shorter',
        kind: 'update_agent',
        agentId: sprout.id,
        expectedRevision: sprout.revision + 1,
        patch: { description: 'Rewrites drafts' },
        dependsOn: ['profile'],
      }],
    });
    assert.equal(applied.ok, true);
    const value = (applied as { ok: true; result: Record<string, unknown> }).result;
    assert.equal(value.status, 'confirmation_required');
    assert.equal(value.presentation, undefined);
    assert.match(String(value.instruction), /ask them to reply "approve".*call confirm_workspace_change/);
    const proposalId = (value.outcomes as Array<{ proposalId?: string }>)[0]?.proposalId ?? '';
    assert.match(proposalId, /^proposal_/);

    await deliverCard(sprout.id, text);
    assert.equal(posts.length, 0, 'no card the host could not resolve');
    assert.equal((await typedApproval(sprout.id, requester)).proposalId, undefined,
      'the typed "approve" reaches the Agent');
    const confirmed = await send(sprout.id, 'approve', 'confirm_workspace_change', { proposalId });
    assert.equal(confirmed.ok, true);
    assert.equal((confirmed as { ok: true; result: { status: string } }).result.status, 'completed');
    const after = await f.config.getAgent(sprout.id);
    assert.equal(after.instructions, 'Rewrite drafts plainly.');
    assert.equal(after.description, 'Rewrites drafts');
  } finally {
    fixture.close();
  }
});
