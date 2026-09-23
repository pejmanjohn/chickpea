import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserAction, getBrowserAction } from '../src/browser/actions.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { admitSlackBrowserActionReply } from '../src/slack/browser-action-admission.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const THREAD_TS = '1800000000.000100';
const NOW = Date.UTC(2026, 8, 22, 14, 0);

function turn(text: string, patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T_TEST',
    channelId: 'C_TEST',
    userId: 'U_ASKER',
    text,
    eventId: 'Ev_reply',
    messageTs: '1800000005.000100',
    threadTs: THREAD_TS,
    source: 'thread_reply',
    contextMode: 'thread',
    ...patch,
  } as NormalizedSlackTurn;
}

const assignment = { agent: { id: 'agent_ops' }, runtimeContract: 'chickpea-v1' } as never;

async function held(settings: SqliteSettingsStore, threadTs = THREAD_TS) {
  return createBrowserAction(settings, {
    workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs, agentId: 'agent_ops',
    actorSlackUserId: 'U_ASKER', actorMembershipId: 'membership_asker',
    loginId: `wl_${'a'.repeat(32)}`, host: 'billing.example.com', url: 'https://billing.example.com/plan',
    title: 'Plan', ref: 'e3', role: 'button', name: 'Confirm change', occurrence: 0, action: 'click',
    description: 'click "Confirm change"', now: NOW,
  });
}

test('an exact approve from the asker stamps the approved action onto the turn and reaches the Agent', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const record = await held(settings);
  const reply = turn('<@UBOT> Approve.');
  assert.equal(await admitSlackBrowserActionReply({
    turn: reply, assignment, settings, actorMembershipId: 'membership_asker', now: NOW + 1,
  }), true);
  assert.equal(reply.approvedBrowserActionId, record.id);
  assert.deepEqual(reply.interactionIntent, { disposition: 'reply', reason: 'substantive_request' });
  const stored = await getBrowserAction(settings, record.id);
  assert.equal(stored?.status, 'approved');
  assert.equal(stored?.approvedMessageTs, '1800000005.000100');
  settings.close();
});

test('stop spends the action without stamping an approval; the Agent still reads the reply', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const record = await held(settings);
  const reply = turn('stop');
  assert.equal(await admitSlackBrowserActionReply({
    turn: reply, assignment, settings, actorMembershipId: 'membership_asker', now: NOW + 1,
  }), true);
  assert.equal(reply.approvedBrowserActionId, undefined);
  assert.deepEqual(reply.interactionIntent, { disposition: 'reply', reason: 'substantive_request' });
  assert.equal((await getBrowserAction(settings, record.id))?.status, 'consumed');
  settings.close();
});

test('other people, other threads, other Agents, and other words leave the action pending', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const record = await held(settings);
  const cases: Array<[NormalizedSlackTurn, string | undefined, typeof assignment]> = [
    [turn('approve', { userId: 'U_OTHER' }), 'membership_asker', assignment],
    [turn('approve'), 'membership_other', assignment],
    [turn('approve', { threadTs: '1800000000.000999' }), 'membership_asker', assignment],
    [turn('approve'), 'membership_asker', { agent: { id: 'agent_other' }, runtimeContract: 'chickpea-v1' } as never],
    [turn('approve it'), 'membership_asker', assignment],
    [turn('yes'), 'membership_asker', assignment],
  ];
  for (const [reply, actorMembershipId, routed] of cases) {
    assert.equal(await admitSlackBrowserActionReply({ turn: reply, assignment: routed, settings, actorMembershipId, now: NOW + 1 }), false);
    assert.equal(reply.approvedBrowserActionId, undefined);
    assert.equal(reply.interactionIntent, undefined);
  }
  assert.equal((await getBrowserAction(settings, record.id))?.status, 'pending');
  settings.close();
});

test('a legacy-contract Agent matches the session thread its signal carries', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const record = await held(settings, '1700000000.000100');
  const reply = turn('approve', { sessionThreadTs: '1700000000.000100' });
  assert.equal(await admitSlackBrowserActionReply({
    turn: reply,
    assignment: { agent: { id: 'agent_ops' }, runtimeContract: 'legacy' } as never,
    settings,
    actorMembershipId: 'membership_asker',
    now: NOW + 1,
  }), true);
  assert.equal(reply.approvedBrowserActionId, record.id);
  settings.close();
});
