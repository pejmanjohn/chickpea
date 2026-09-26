import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserAction } from '../src/browser/actions.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { authorizeUiResponse, type SlackUiAdmission } from '../src/slack/ui/authorize.ts';
import {
  deliverHostApprovalSurfaces,
  retireApprovalSurfacesForTypedAnswer,
  type UiSurfaceMessenger,
} from '../src/slack/ui/host-surfaces.ts';
import type { RenderedUiSurface } from '../src/slack/ui/render.ts';
import type { UiSurfaceRecord } from '../src/slack/ui/surface.ts';

const THREAD_TS = '1800000000.000100';
const TURN_TS = '1800000005.000100';
const TURN_MS = 1_800_000_005_000;

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', userId: 'U1', text: 'change my plan', eventId: 'Ev1',
    messageTs: TURN_TS, threadTs: THREAD_TS, source: 'implicit_thread_reply', channelType: 'channel',
    contextMode: 'thread', actorMembershipId: 'membership_u1', ...patch,
  };
}

const assignment = { agent: { id: 'agent_ops' }, agentId: 'agent_ops', runtimeContract: 'chickpea-v1' } as unknown as ResolvedAssignment;

function messenger() {
  const posts: RenderedUiSurface[] = [];
  const updates: Array<{ messageTs: string; rendered: RenderedUiSurface }> = [];
  let next = 1;
  const value: UiSurfaceMessenger = {
    async post(rendered) { posts.push(rendered); return `1800000010.00000${next++}`; },
    async update(messageTs, rendered) { updates.push({ messageTs, rendered }); },
  };
  return { value, posts, updates };
}

async function hold(settings: SqliteSettingsStore, now: number, actor = 'U1') {
  return createBrowserAction(settings, {
    workspaceId: 'T1', channelId: 'C1', threadTs: THREAD_TS, agentId: 'agent_ops',
    actorSlackUserId: actor, actorMembershipId: 'membership_u1',
    loginId: `wl_${'a'.repeat(32)}`, host: 'billing.example.com', url: 'https://billing.example.com/plan',
    title: 'Plan', ref: 'e3', role: 'button', name: 'Confirm change', occurrence: 0, action: 'click',
    description: 'click "Confirm change"', now,
  });
}

async function surfaces(state: SqliteSlackStateStore): Promise<UiSurfaceRecord[]> {
  const response = await state.executeUiSurface!({
    kind: 'list_open_surfaces',
    scope: { workspaceId: 'T1', channelId: 'C1', threadTs: THREAD_TS, agentId: 'agent_ops' },
  });
  return response.kind === 'surfaces' ? response.surfaces : [];
}

test('a step held by this turn gets one host card; a replayed delivery never posts twice', async () => {
  const state = new SqliteSlackStateStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const held = await hold(settings, TURN_MS + 1_000);
  const out = messenger();
  const deliver = () => deliverHostApprovalSurfaces({
    turn: turn(), assignment, turnJobId: 'msg:C1:1800000005.000100', state, settings,
    messenger: out.value, now: TURN_MS + 2_000,
  });
  await deliver();
  await deliver();
  assert.equal(out.posts.length, 1);
  assert.match(out.posts[0]!.text, /Approve this step/);
  const [card] = await surfaces(state);
  assert.equal(card?.status, 'open');
  assert.equal(card?.messageTs, '1800000010.000001');
  assert.equal(card?.namespace, 'host');
  assert.deepEqual(card?.spec, {
    kind: 'approval', approval: 'browser_step', browserActionId: held.id,
    description: 'click "Confirm change"', host: 'billing.example.com',
  });
  state.close();
  settings.close();
});

test('no card for a step from an earlier turn, another person, or a group DM', async () => {
  for (const [label, heldAt, actor, patch] of [
    ['earlier turn', TURN_MS - 1_000, 'U1', {}],
    ['another person', TURN_MS + 1_000, 'U2', {}],
    ['group DM', TURN_MS + 1_000, 'U1', { channelType: 'mpim', channelId: 'C1' }],
  ] as const) {
    const state = new SqliteSlackStateStore(':memory:');
    const settings = new SqliteSettingsStore(':memory:');
    await hold(settings, heldAt, actor);
    const out = messenger();
    await deliverHostApprovalSurfaces({
      turn: turn(patch), assignment, turnJobId: 'job', state, settings, messenger: out.value,
      now: TURN_MS + 2_000,
    });
    assert.equal(out.posts.length, 0, label);
    state.close();
    settings.close();
  }
});

test('a newer approval card closes the older one in the thread and redraws it', async () => {
  const state = new SqliteSlackStateStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const out = messenger();
  await hold(settings, TURN_MS + 1_000);
  await deliverHostApprovalSurfaces({
    turn: turn(), assignment, turnJobId: 'job1', state, settings, messenger: out.value, now: TURN_MS + 2_000,
  });
  const later = turn({ messageTs: '1800000100.000100', eventId: 'Ev2' });
  await hold(settings, 1_800_000_100_000 + 1_000);
  await deliverHostApprovalSurfaces({
    turn: later, assignment, turnJobId: 'job2', state, settings, messenger: out.value,
    now: 1_800_000_100_000 + 2_000,
  });
  assert.equal(out.posts.length, 2);
  assert.equal(out.updates.length, 1);
  assert.equal(out.updates[0]!.messageTs, '1800000010.000001');
  assert.ok(!out.updates[0]!.rendered.blocks.some((block) => block.type === 'actions'));
  assert.equal((await surfaces(state)).length, 1);
  state.close();
  settings.close();
});

test('a workspace-change proposal created by this turn gets Approve and Cancel', async () => {
  const state = new SqliteSlackStateStore(':memory:');
  const out = messenger();
  const identity = {
    resolveSlackIdentity: async () => ({
      user: { id: 'user_u1' },
      membership: { id: 'membership_u1', status: 'active', organizationId: 'org' },
      binding: { slackTeamId: 'T1', slackUserId: 'U1' },
    }),
  } as never;
  const management = {
    getActiveChangeSetProposal: async () => ({
      proposalId: 'proposal_1', status: 'pending', createdAt: TURN_MS + 500, originKey: 'x',
    }),
  } as never;
  await deliverHostApprovalSurfaces({
    turn: turn(), assignment, turnJobId: 'job1', state, identity, management, messenger: out.value,
  });
  assert.equal(out.posts.length, 1);
  assert.match(JSON.stringify(out.posts[0]!.blocks), /"Approve".*"Cancel"/);
  // A typed "approve" retires the same card.
  await retireApprovalSurfacesForTypedAnswer({
    state, messenger: out.value,
    scope: { workspaceId: 'T1', channelId: 'C1', threadTs: THREAD_TS, agentId: 'agent_ops' },
    match: { proposalId: 'proposal_1' },
    resolution: { byUserId: 'U1', at: TURN_MS + 5_000, choice: 0 },
  });
  assert.equal(out.updates.length, 1);
  assert.match(JSON.stringify(out.updates[0]!.rendered.blocks), /Approved by <@U1> \(typed reply\)/);
  assert.equal((await surfaces(state)).length, 0);
  state.close();
});

test('a click authorizes a workspace change only against the live proposal the card names', async () => {
  const identity = {
    resolveSlackIdentity: async () => ({
      user: { id: 'user_u1' },
      membership: { id: 'membership_u1', status: 'active', organizationId: 'org' },
      binding: { slackTeamId: 'T1', slackUserId: 'U1' },
    }),
  } as never;
  let active = 'proposal_1';
  const management = { getActiveChangeSetProposal: async () => ({ proposalId: active, status: 'pending', originKey: 'x' }) } as never;
  const settings = new SqliteSettingsStore(':memory:');
  const surface = {
    id: 'a'.repeat(32), namespace: 'host', agentId: 'agent_ops', requesterUserId: 'U1',
    spec: { kind: 'approval', approval: 'workspace_change', proposalId: 'proposal_1' },
  } as UiSurfaceRecord;
  const authorize = (choice: number, patch: Partial<NormalizedSlackTurn> = {}, record = surface) => {
    const clicked = turn({ text: 'Approved the proposed workspace changes with the Approve button.', ...patch });
    const admission: SlackUiAdmission = { surface: record, choice, outcome: 'pending' };
    return authorizeUiResponse({
      admission, turn: clicked, assignment, actorMembershipId: 'membership_u1',
      stores: { identity, management, settings },
    }).then((refusal) => ({ refusal, clicked }));
  };
  const approved = await authorize(0);
  assert.equal(approved.refusal, undefined);
  assert.equal(approved.clicked.managementApprovalProposalId, 'proposal_1');
  const cancelled = await authorize(1);
  assert.equal(cancelled.refusal, undefined);
  assert.equal(cancelled.clicked.managementApprovalProposalId, undefined);
  assert.equal((await authorize(0, { userId: 'U2' })).refusal, 'wrong_user');
  assert.equal((await authorize(7)).refusal, 'unavailable');
  assert.equal((await authorize(0, {}, { ...surface, agentId: 'agent_other' })).refusal, 'closed');
  assert.equal((await authorize(0, {}, { ...surface, namespace: 'ui' })).refusal, 'unavailable');
  active = 'proposal_2';
  const stale = await authorize(0);
  assert.equal(stale.refusal, 'not_current');
  assert.equal(stale.clicked.managementApprovalProposalId, undefined);
  settings.close();
});
