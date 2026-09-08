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
