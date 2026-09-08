import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProposalApprovalStatus } from '../src/admin/proposal-status.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SlackRunPresentationStoreLogic, type SlackRunPresentation } from '../src/slack/run-presentations.ts';
import { slackSessionGenerationFromTimestamp } from '../src/slack/claim-store.ts';
import type { ManagementChangeSetProposalRecord } from '../src/management/types.ts';
import type { SlackProposalApprovalTurn } from '../src/slack/turn-jobs.ts';

const scope = 'slack:T_TEST:C_TEST:1800000000.000100:agent:agent_chickpea';
const proposal: ManagementChangeSetProposalRecord = { proposalId: 'proposal_test', organizationId: 'org_test',
  actorUserId: 'user_owner', actorMembershipId: 'member_owner', originKey: scope, approvalScopeKey: scope,
  idempotencyKey: 'private-key', guideVersion: 'test', authoringReason: 'agent_edit', operations: [], digest: 'digest',
  preview: { summary: 'PRIVATE_PREVIEW', changes: [], missingSetup: [] }, targetRevisions: {}, status: 'completed', createdAt: 1, updatedAt: 2 };
const turn: SlackProposalApprovalTurn = { proposalId: proposal.proposalId, workspaceId: 'T_TEST', channelId: 'C_TEST',
  threadTs: '1800000000.000100', requesterUserId: 'U_OWNER', requesterMembershipId: 'member_owner',
  actingAgentId: 'agent_chickpea', turnJobId: 'turn_test', runId: 'run_test', messageTs: '1800000001.000200',
  status: 'done', delivered: true };

test('approval status uses exact turn and presentation identity without exposing run content', async () => {
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db, () => 100);
  const created = store.create({ schemaVersion: 3, runId: 'run_test', turnJobId: 'turn_test',
    bindingId: 'binding_test', workBindingGeneration: 1, runFencingToken: 0, owner: { kind: 'chickpea' },
    sessionGeneration: slackSessionGenerationFromTimestamp(turn.messageTs),
    root: { workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, requesterUserId: turn.requesterUserId } });
  assert.equal(created.schemaVersion, 3);
  if (created.schemaVersion !== 3) throw new Error('wrong presentation version');
  let presentation: SlackRunPresentation | undefined = { ...created, lifecyclePhase: 'settled',
    activityProjection: { surface: 'assistant_status', state: 'cleared' }, title: { valueHash: 'PRIVATE_RUN_TITLE', outcome: 'set' } };
  let rows = [turn];
  const state = {
    listProposalApprovalTurns: async (query: Parameters<NonNullable<Parameters<typeof readProposalApprovalStatus>[0]['listProposalApprovalTurns']>>[0]) => {
      const { turnJobId, runId, messageTs, status, delivered, ...expected } = turn;
      assert.deepEqual(query, expected);
      return rows;
    },
    getRunPresentation: async (id: string) => { assert.equal(id, 'run_test'); return presentation; },
  };
  try {
    const actual = await readProposalApprovalStatus(state, proposal, 'U_OWNER');
    assert.equal(actual?.turns[0]?.activity?.state, 'cleared');
    assert.equal(actual?.turns[0]?.messageTs, turn.messageTs);
    assert.equal(actual?.requesterUserId, 'U_OWNER');
    assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_|private-key/);
    assert.deepEqual(store.get('run_test'), created, 'readback must not mutate the stored presentation');
    const valid = presentation;
    for (const patch of [{ runId: 'other' }, { turnJobId: 'other' }, { sessionGeneration: 1 },
      ...(['workspaceId', 'channelId', 'threadTs', 'requesterUserId'] as const).map((key) => ({ root: { ...created.root, [key]: 'other' } }))]) {
      presentation = { ...valid, ...patch };
      assert.equal((await readProposalApprovalStatus(state, proposal, 'U_OWNER'))?.turns[0]?.activity, null);
    }
    presentation = undefined;
    assert.equal((await readProposalApprovalStatus(state, proposal, 'U_OWNER'))?.turns[0]?.activity, null);
    assert.equal(await readProposalApprovalStatus(state, proposal, null), null);
    assert.equal(await readProposalApprovalStatus({}, proposal, 'U_OWNER'), null);
    assert.equal(await readProposalApprovalStatus(state, { ...proposal, originKey: 'mcp:other' }, 'U_OWNER'), null);
    for (const key of ['proposalId', 'workspaceId', 'channelId', 'threadTs', 'requesterUserId', 'requesterMembershipId', 'actingAgentId'] as const) {
      rows = [{ ...turn, [key]: 'other' }];
      await assert.rejects(readProposalApprovalStatus(state, proposal, 'U_OWNER'), /Unexpected approval turn scope/);
    }
    rows = [turn, turn, turn];
    await assert.rejects(readProposalApprovalStatus(state, proposal, 'U_OWNER'), /Unexpected approval turn scope/);
    rows = [];
    assert.deepEqual((await readProposalApprovalStatus(state, proposal, 'U_OWNER'))?.turns, []);
  } finally { db.close(); }
});
