import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStateDb } from '../src/state/node-state-db.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { CfSlackStateStore } from '../src/config/cf-state-proxies.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { SlackStateLogic } from '../src/slack/claim-store.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
import { localSlackStateStore } from '../src/slack/local-state-store.ts';

test('approval readback scopes before limiting, includes delivered turns, and never returns message text', async () => {
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => 100);
  const query = { proposalId: 'proposal_test', workspaceId: 'T_TEST', channelId: 'C_TEST',
    threadTs: '1800000000.000100', requesterUserId: 'U_OWNER', requesterMembershipId: 'member_owner',
    actingAgentId: 'agent_chickpea' };
  const insert = (id: string, patch: Record<string, unknown> = {}, agentId = query.actingAgentId, at = 1) => {
    db.run(`INSERT INTO turn_jobs (id, evt_key, msg_key, turn_json, assignment_json, run_id, delivered, status, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'done', ?)`, id, id, id, JSON.stringify({
      workspaceId: query.workspaceId, channelId: query.channelId, threadTs: query.threadTs,
      userId: query.requesterUserId, actorMembershipId: query.requesterMembershipId,
      managementApprovalProposalId: query.proposalId, messageTs: '1800000001.000200', text: 'PRIVATE_APPROVAL_TEXT', ...patch,
    }), JSON.stringify({ agent: { id: agentId }, secret: 'PRIVATE_ASSIGNMENT' }), `run_${id}`, at);
  };
  try {
    assert.deepEqual(turns.listProposalApprovalTurns(query), []);
    for (const id of ['one', 'two', 'three']) insert(id);
    for (const key of ['workspaceId', 'channelId', 'threadTs', 'userId', 'actorMembershipId', 'managementApprovalProposalId']) {
      insert(key, { [key]: 'other' }, query.actingAgentId, 10);
    }
    insert('wrong_agent', {}, 'other', 10);
    const before = db.all('SELECT * FROM turn_jobs ORDER BY id');
    const rows = turns.listProposalApprovalTurns(query);
    assert.deepEqual(rows.map((row) => row.turnJobId), ['three', 'two']);
    assert.deepEqual(rows[0], { ...query, turnJobId: 'three', runId: 'run_three',
      messageTs: '1800000001.000200', status: 'done', delivered: true });
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_/);
    const local = localSlackStateStore({ turnJobs: turns, slack: new SlackStateLogic(db),
      work: new WorkStoreLogic(db), presentations: new SlackRunPresentationStoreLogic(db) });
    const proxy = new CfSlackStateStore({ slackProposalApprovalTurns: async (input) => ({ ok: true,
      value: await local.listProposalApprovalTurns!(input) }) } as TagStateRpc);
    assert.deepEqual(await proxy.listProposalApprovalTurns(query), rows);
    assert.deepEqual(db.all('SELECT * FROM turn_jobs ORDER BY id'), before);
    insert('newer', {}, query.actingAgentId, 20);
    insert('older_inserted_last', {}, query.actingAgentId, 0);
    assert.deepEqual(turns.listProposalApprovalTurns(query).map((row) => row.turnJobId), ['newer', 'three']);
    assert.throws(() => turns.listProposalApprovalTurns({ ...query, proposalId: '' }));
  } finally { db.close(); }
});

test('the latest Agent turn is read per Channel thread, or across a whole DM, and per Agent', async () => {
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => 100);
  const insert = (id: string, threadKey: string, messageTs: string, agentId: string, at: number) => {
    db.run(`INSERT INTO turn_jobs (id, evt_key, msg_key, turn_json, assignment_json, delivered, status, enqueued_at, thread_key, message_ts)
      VALUES (?, ?, ?, ?, ?, 1, 'done', ?, ?, ?)`, id, id, id, JSON.stringify({ messageTs, text: 'PRIVATE' }),
    JSON.stringify({ agent: { id: agentId } }), at, threadKey, messageTs);
  };
  try {
    const thread = { workspaceId: 'T1', channelId: 'C1', threadTs: '100.1', agentId: 'agent_desk' };
    assert.equal(turns.latestAgentTurnMessageTs(thread), undefined);
    insert('proposing', 'T1:C1:100.1', '100.2', 'agent_desk', 1);
    insert('other_thread', 'T1:C1:200.1', '200.2', 'agent_desk', 5);
    insert('other_agent', 'T1:C1:100.1', '100.3', 'agent_other', 6);
    insert('other_channel', 'T1:C2:100.1', '100.4', 'agent_desk', 7);
    assert.equal(turns.latestAgentTurnMessageTs(thread), '100.2', 'other threads, Agents and Channels do not count');
    insert('later', 'T1:C1:100.1', '100.5', 'agent_desk', 8);
    assert.equal(turns.latestAgentTurnMessageTs(thread), '100.5');

    insert('dm_first', 'T1:D1:300.1', '300.1', 'agent_desk', 9);
    insert('dm_second', 'T1:D1:400.1', '400.1', 'agent_desk', 10);
    insert('dm_neighbor', 'T1:D10:500.1', '500.1', 'agent_desk', 11);
    assert.equal(turns.latestAgentTurnMessageTs({ workspaceId: 'T1', channelId: 'D1', agentId: 'agent_desk' }), '400.1',
      'a DM is one conversation across its threads, and D10 is another DM');

    const proxy = new CfSlackStateStore({ slackLatestAgentTurn: async (input) => ({ ok: true,
      value: turns.latestAgentTurnMessageTs(input) ?? null }) } as TagStateRpc);
    assert.equal(await proxy.latestAgentTurnMessageTs(thread), '100.5', 'Cloudflare reads the same answer over RPC');
    assert.equal(await proxy.latestAgentTurnMessageTs({ ...thread, threadTs: '999.1' }), undefined);
  } finally {
    db.close();
  }
});

test('a message is read back only as its person typed it, from the host\'s own turn row', async () => {
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => 100);
  const insert = (id: string, messageTs: string, turn: Record<string, unknown>) => {
    db.run(`INSERT INTO turn_jobs (id, evt_key, msg_key, turn_json, assignment_json, delivered, status, enqueued_at, message_ts)
      VALUES (?, ?, ?, ?, ?, 1, 'done', 1, ?)`, id, id, id, JSON.stringify({
      workspaceId: 'T1', channelId: 'D1', userId: 'U_PERSON', messageTs, source: 'dm_message', ...turn,
    }), JSON.stringify({ agent: { id: 'agent_desk' } }), messageTs);
  };
  const query = (messageTs: string, fields: Partial<{ workspaceId: string; channelId: string }> = {}) =>
    turns.typedSlackMessage({ workspaceId: 'T1', channelId: 'D1', messageTs, ...fields });
  try {
    insert('typed', '100.1', { text: 'connect Statusboard, key sb_live_typed' });
    insert('click', '100.2', { text: 'Approved.', uiResponse: { surfaceId: 's', namespace: 'host', kind: 'approval', choice: 0 } });
    insert('reaction', '100.3', { text: 'Reacted :sb_live_emoji: to the Slack message at 100.1.', source: 'reaction_added' });
    insert('ask', '100.4', { text: 'Desk, use sb_live_asked', agentAsk: { fromAgentId: 'agent_other', fromAgentName: 'Other', originMessageTs: '100.1' } });
    insert('first_agent', '100.5', { text: 'hi both, key sb_live_both' });
    insert('second_agent', '100.5', { text: 'hi both, key sb_live_both' });
    assert.deepEqual(query('100.1'), { userId: 'U_PERSON', text: 'connect Statusboard, key sb_live_typed' });
    for (const ts of ['100.2', '100.3', '100.4']) assert.equal(query(ts), undefined, `${ts}: the host or another Agent wrote this text`);
    assert.deepEqual(query('100.5'), { userId: 'U_PERSON', text: 'hi both, key sb_live_both' }, 'one message to two Agents reads once');
    assert.equal(query('100.1', { channelId: 'D2' }), undefined, 'another conversation');
    assert.equal(query('100.1', { workspaceId: 'T2' }), undefined, 'another workspace');
    assert.equal(query('100.9'), undefined, 'a message no turn row holds');
    assert.throws(() => query('not-a-ts'));

    const local = localSlackStateStore({ turnJobs: turns, slack: new SlackStateLogic(db),
      work: new WorkStoreLogic(db), presentations: new SlackRunPresentationStoreLogic(db) });
    const proxy = new CfSlackStateStore({ slackTypedMessage: async (input) => ({ ok: true,
      value: (await local.typedSlackMessage!(input)) ?? null }) } as TagStateRpc);
    assert.deepEqual(await proxy.typedSlackMessage({ workspaceId: 'T1', channelId: 'D1', messageTs: '100.1' }), query('100.1'));
    assert.equal(await proxy.typedSlackMessage({ workspaceId: 'T1', channelId: 'D1', messageTs: '100.2' }), undefined);
  } finally {
    db.close();
  }
});
