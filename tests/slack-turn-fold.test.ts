import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { EffectiveConnectionAccount } from '../src/connections/types.ts';
import {
  foldActivityStatus,
  foldableTurn,
  foldedRequestText,
  MAX_FOLD_CYCLES,
  MAX_FOLDED_MESSAGES,
  MAX_FOLDED_TEXT_CHARS,
  MAX_TURN_FOLD_CYCLES,
  readFoldClaim,
} from '../src/slack/follow-ups.ts';
import type { FlueSettlementCheckpointV1, TurnJob } from '../src/slack/turn-job-types.ts';
import {
  isTurnJobStopRefusal,
  TurnJobStoreLogic,
  turnJobGate,
} from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { StateDb } from '../src/state/state-db.ts';
import { SlackStateLogic, slackSessionGenerationFromTimestamp } from '../src/slack/claim-store.ts';
import { localSlackStateStore } from '../src/slack/local-state-store.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationOwner,
  type SlackRunPresentationV3,
} from '../src/slack/run-presentations.ts';
import { editTurnJobId, type SlackMessageEdit } from '../src/slack/edits.ts';
import { turnRequestTs } from '../src/slack/thread-context.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
import { opaqueTurnRef } from '../src/observability/runtime-latency.ts';
import type { RunId } from '../src/work/types.ts';

/**
 * Follow-ups (steering A): the same person's plain messages queued behind a
 * turn become part of that turn's request. The state store's turn rows own
 * which rows a run took (`fold_json`); every executor learns it from the row.
 */

const NOW = 1_800_000_000_000;
const THREAD_TS = '1800000000.000100';
const THREAD = `T_FOLD:C_FOLD:${THREAD_TS}`;
const UID = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function turn(messageTs: string, overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T_FOLD', channelId: 'C_FOLD', eventId: `Ev_${messageTs}`,
    text: `Message ${messageTs}`, userId: 'U_PERSON', messageTs, threadTs: THREAD_TS,
    source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
    ...overrides,
  };
}

function assignment(overrides: Partial<ResolvedAssignment> = {}): ResolvedAssignment {
  const agentId = overrides.agentId ?? 'agent_fold';
  return {
    workspaceId: 'T_FOLD', channelId: 'C_FOLD', agentId, model: 'local-stub/fold',
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: agentId, kind: 'user', revision: 1, name: 'Fold', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
    ...overrides,
  };
}

/** A turn in the thread posted at `.000<suffix>`. */
function job(
  id: string,
  suffix: string,
  overrides: Partial<NormalizedSlackTurn> = {},
  assigned: Partial<ResolvedAssignment> = {},
): TurnJob {
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, runId: `run_${id}`,
    turn: turn(`1800000000.000${suffix}`, overrides), assignment: assignment(assigned),
  };
}

function store(clock = { now: NOW }) {
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => clock.now);
  return { db, turns, clock };
}

/** Enqueue each row a millisecond apart, as admissions are. */
function enqueueAll(s: ReturnType<typeof store>, jobs: TurnJob[]): void {
  for (const queued of jobs) {
    s.turns.enqueue(queued);
    s.clock.now += 1;
  }
}

/** The requester's own CRM account, bound to the Agent: a run granted it uses personal access. */
const PERSONAL_CONNECTION: EffectiveConnectionAccount = {
  account: {
    id: 'crm_mine', workspaceId: 'T_FOLD', revision: 1, ownerKind: 'member', ownerMembershipId: 'mem_person',
    createdByMembershipId: 'mem_person', providerId: 'crm', label: 'CRM',
    policy: {
      kind: 'api', allowedHosts: ['api.example.com'], pathPrefixes: ['/v1'], headerName: 'authorization',
      headerValuePrefix: 'Bearer ', allowedMethods: ['GET'], authMode: 'credential',
    },
    secretRefId: 'secret_crm', lifecycle: 'ready', createdAt: 1, updatedAt: 1,
  },
  binding: {
    agentId: 'agent_fold', connectionAccountId: 'crm_mine', providerId: 'crm',
    allowedCapabilities: ['GET'], enabled: true, createdAt: 1, updatedAt: 1,
  },
  policy: {
    kind: 'api', allowedHosts: ['api.example.com'], pathPrefixes: ['/v1'], headerName: 'authorization',
    headerValuePrefix: 'Bearer ', allowedMethods: ['GET'], authMode: 'credential',
  },
  scope: 'personal',
};

function freeze(turns: TurnJobStoreLogic, queued: TurnJob, access: 'shared' | 'personal' = 'shared'): void {
  turns.freezeRuntimePlan(queued.id, compileRuntimePlanV2({
    turn: queued.turn, assignment: queued.assignment, instructions: 'Help.', memoryEpoch: 1,
    ...(access === 'personal' ? { effectiveConnections: [PERSONAL_CONNECTION] } : {}),
  }));
}

function dispatch(turns: TurnJobStoreLogic, queued: TurnJob, access: 'shared' | 'personal' = 'shared'): void {
  freeze(turns, queued, access);
  turns.prepareFlueDispatch(queued.id, 'Do the work', { generation: queued.id });
  turns.recordFlueReceipt(queued.id, {
    submissionId: `sub_${queued.id}`, acceptedAt: '2026-10-30T12:00:00.000Z', uid: UID,
  });
}

const COMPLETED: FlueSettlementCheckpointV1 = {
  outcome: 'completed', settledAt: NOW,
  result: {
    text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null,
    usageCompleteness: 'not_reported',
  },
};

const FAILED: FlueSettlementCheckpointV1 = { outcome: 'failed', settledAt: NOW, failureKind: 'provider' };

function claimed(turns: TurnJobStoreLogic, headId: string): string[] {
  return turns.fold({ phase: 'start', headId }).messages.map((message) => message.turnJobId);
}

function view(turns: TurnJobStoreLogic, id: string) {
  return turns.runnerView(id);
}

// ── claiming at turn start ─────────────────────────────────────────────

test('a turn start takes the same person\'s queued messages, oldest first, and holds them', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), job('second', '102'), job('third', '103')]);
    const claim = s.turns.fold({ phase: 'start', headId: 'head' });
    assert.deepEqual(claim.messages, [
      { turnJobId: 'second', userId: 'U_PERSON', messageTs: '1800000000.000102', text: 'Message 1800000000.000102' },
      { turnJobId: 'third', userId: 'U_PERSON', messageTs: '1800000000.000103', text: 'Message 1800000000.000103' },
    ]);
    assert.equal(claim.requesterText, [
      'Message 1800000000.000101', 'Message 1800000000.000102', 'Message 1800000000.000103',
    ].join('\n\n'));
    for (const id of ['second', 'third']) {
      const member = view(s.turns, id).job!;
      assert.deepEqual(member.fold, {
        schemaVersion: 1, role: 'absorbed', headId: 'head', cycle: 0, received: true, at: NOW + 3,
      });
      assert.equal(turnJobGate(member), 'hold', `${id} waits for its head`);
    }
    assert.equal(view(s.turns, 'head').job!.fold, undefined);
    assert.equal(turnJobGate(view(s.turns, 'head').job!), 'run');
  } finally {
    s.db.close();
  }
});

test('a repeated start claim returns the same members and takes nothing newer once the head dispatched', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), job('second', '102')]);
    assert.deepEqual(claimed(s.turns, 'head'), ['second']);
    enqueueAll(s, [job('third', '103')]);
    // Before dispatch the stamped members are the claim: a retry rebuilds the same prompt.
    assert.deepEqual(claimed(s.turns, 'head'), ['second']);
    dispatch(s.turns, job('head', '101'));
    assert.deepEqual(claimed(s.turns, 'head'), ['second']);
    assert.equal(view(s.turns, 'third').job!.fold, undefined);
    assert.equal(turnJobGate(view(s.turns, 'third').job!), 'run');
  } finally {
    s.db.close();
  }
});

test('a head that dispatched before any claim takes nothing at its start', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101')]);
    dispatch(s.turns, job('head', '101'));
    enqueueAll(s, [job('second', '102')]);
    assert.deepEqual(claimed(s.turns, 'head'), []);
    assert.equal(view(s.turns, 'second').job!.fold, undefined);
  } finally {
    s.db.close();
  }
});

test('the run of follow-ups ends at a command or a message with files', () => {
  for (const [label, breaker] of [
    ['a memory command', { text: '!memory list' }],
    ['a routine command', { text: '!routines' }],
    ['files', { attachments: [{ fileId: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 3 }] }],
    ['an approval', { managementApprovalProposalId: 'prop_1' }],
    ['a click', { uiResponse: { surfaceId: 's', namespace: 'ui', kind: 'choice', choice: 0 } }],
    ['a reaction', { source: 'reaction_added', reaction: 'eyes', reactionTargetTs: THREAD_TS }],
    ['a reaction-only intent', { interactionIntent: { disposition: 'react_only', reason: 'acknowledgment', reaction: 'ack', target: 'trigger' } }],
  ] as Array<[string, Partial<NormalizedSlackTurn>]>) {
    const s = store();
    try {
      enqueueAll(s, [job('head', '101'), job('second', '102'), job('breaker', '103', breaker), job('after', '104')]);
      assert.deepEqual(claimed(s.turns, 'head'), ['second'], label);
      assert.equal(view(s.turns, 'breaker').job!.fold, undefined, label);
      assert.equal(view(s.turns, 'after').job!.fold, undefined, label);
    } finally {
      s.db.close();
    }
  }
});

// ── teammates' messages ───────────────────────────────────────────────

test('a teammate\'s message folds in when the head\'s run uses only the Agent\'s shared connections', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head, job('teammate', '102', { userId: 'U_TEAMMATE' }), job('own', '103')]);
    const claim = s.turns.fold({ phase: 'start', headId: 'head' });
    assert.deepEqual(claim.messages.map((message) => message.turnJobId), ['teammate', 'own']);
    assert.equal(claim.requesterText, 'Message 1800000000.000101\n\nMessage 1800000000.000103', 'only the requester\'s words');
    // Until the head's plan says otherwise, a teammate's message is information only.
    assert.equal(view(s.turns, 'teammate').job!.fold?.role, 'informed');
    assert.equal(view(s.turns, 'own').job!.fold?.role, 'absorbed');
    dispatch(s.turns, head);
    assert.equal(view(s.turns, 'teammate').job!.fold?.role, 'absorbed');
    assert.deepEqual(
      s.turns.fold({ phase: 'start', headId: 'head' }).messages.map((message) => message.informationOnly),
      [undefined, undefined],
    );
    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');
    assert.deepEqual(s.turns.settledFoldMembers('head').map((row) => row.id), ['teammate', 'own']);
  } finally {
    s.db.close();
  }
});

test('in a run with the requester\'s own connections a teammate\'s message is information only, then runs as its own turn', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [
      head,
      {
        ...job('teammate', '102', { userId: 'U_TEAMMATE' }),
        midRunReceipt: { channelId: 'C_FOLD', messageTs: '1800000000.000102', name: 'eyes' },
      },
      job('own', '103'),
    ]);
    claimed(s.turns, 'head');
    dispatch(s.turns, head, 'personal');
    assert.deepEqual(s.turns.fold({ phase: 'start', headId: 'head' }).messages.map((message) => message.informationOnly), [true, undefined]);
    const held = view(s.turns, 'teammate').job!;
    assert.deepEqual(held.fold, {
      schemaVersion: 1, role: 'informed', headId: 'head', cycle: 0, received: true, at: NOW + 3,
    });
    assert.equal(turnJobGate(held), 'hold', 'it waits while the head runs');
    assert.throws(() => s.turns.prepareFlueDispatch('teammate', 'x', { generation: 'teammate' }), isTurnJobStopRefusal);

    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');
    assert.deepEqual(s.turns.settledFoldMembers('head').map((row) => row.id), ['own']);
    const released = view(s.turns, 'teammate');
    assert.equal(released.status, 'pending');
    assert.equal(released.cleanupPending, undefined, 'its 👀 stays for its own turn');
    assert.equal(released.job!.fold?.role, 'released');
    assert.equal(turnJobGate(released.job!), 'run');
    // Its own turn takes nothing of the head's and dispatches like any turn.
    assert.deepEqual(claimed(s.turns, 'teammate'), []);
    dispatch(s.turns, job('teammate', '102', { userId: 'U_TEAMMATE' }));
  } finally {
    s.db.close();
  }
});

test('a late fold decides a teammate\'s message from the head\'s frozen plan', () => {
  for (const access of ['shared', 'personal'] as const) {
    const s = store();
    try {
      const head = job('head', '101');
      enqueueAll(s, [head]);
      dispatch(s.turns, head, access);
      const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
      enqueueAll(s, [job('teammate', '102', { userId: 'U_TEAMMATE' })]);
      const late = s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true });
      assert.deepEqual(late.messages.map((message) => message.informationOnly), [access === 'personal' || undefined], access);
      assert.equal(late.requesterText, 'Message 1800000000.000101', access);
      s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: false });
      s.turns.recordFlueSettlement('head', COMPLETED);
      s.turns.markDelivered('head');
      assert.equal(view(s.turns, 'teammate').status, access === 'personal' ? 'pending' : 'done', access);
    } finally {
      s.db.close();
    }
  }
});

test('turn_fold counts the confirmed late messages that were information only, content-free', (t) => {
  const records: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'info', (record: Record<string, unknown>) => {
    if (record.event === 'turn_fold') records.push(record);
  });
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head]);
    dispatch(s.turns, head, 'personal');
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    enqueueAll(s, [job('own', '102'), job('teammate', '103', { userId: 'U_TEAMMATE' })]);
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true });
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: false });
    assert.deepEqual(records, [{ component: 'runtime', event: 'turn_fold', turnRef: opaqueTurnRef('head'), late: 2, informed: 1 }]);
  } finally {
    s.db.close();
  }
});

test('a stop drops a teammate\'s information-only message with the rest, counting it read once the run had it', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head, job('teammate', '102', { userId: 'U_TEAMMATE' })]);
    claimed(s.turns, 'head');
    dispatch(s.turns, head, 'personal');
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    enqueueAll(s, [job('late', '103', { userId: 'U_TEAMMATE' })]);
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true });
    s.turns.steer({
      kind: 'stop', threadKey: THREAD, source: 'typed', stopperUserId: 'U_PERSON', cutoffTs: '1800000000.000110',
    });
    const finished = s.turns.finishStop('head', 'dropped');
    assert.equal(finished?.count, 2);
    assert.equal(finished?.read, 1, 'the late message was never confirmed read');
  } finally {
    s.db.close();
  }
});

test('another Agent\'s turn queued in the thread ends the run, so its reply keeps its place', () => {
  const s = store();
  try {
    enqueueAll(s, [
      job('head', '101'),
      job('second', '102'),
      job('other_agent', '103', {}, { agentId: 'agent_other' }),
      job('third', '104'),
    ]);
    assert.deepEqual(claimed(s.turns, 'head'), ['second']);
    assert.equal(view(s.turns, 'other_agent').job!.fold, undefined);
    assert.equal(view(s.turns, 'third').job!.fold, undefined);
  } finally {
    s.db.close();
  }
});

test('a head that is not a plain typed message takes no follow-ups', () => {
  for (const [label, overrides] of [
    ['files', { attachments: [{ fileId: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 3 }] }],
    ['an ask', {
      source: 'agent_mention',
      agentAsk: { fromAgentId: 'agent_x', fromAgentName: 'X', originMessageTs: THREAD_TS },
    }],
  ] as Array<[string, Partial<NormalizedSlackTurn>]>) {
    const s = store();
    try {
      enqueueAll(s, [job('head', '101', overrides), job('second', '102')]);
      assert.deepEqual(claimed(s.turns, 'head'), [], label);
    } finally {
      s.db.close();
    }
  }
});

test('one claim takes at most eight messages and 40,000 characters, its first message whole', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '100')]);
    enqueueAll(s, Array.from({ length: MAX_FOLDED_MESSAGES + 2 }, (_, index) =>
      job(`m${index}`, String(101 + index))));
    assert.equal(claimed(s.turns, 'head').length, MAX_FOLDED_MESSAGES);
  } finally {
    s.db.close();
  }
  const big = store();
  try {
    const long = 'x'.repeat(MAX_FOLDED_TEXT_CHARS - 10);
    enqueueAll(big, [
      job('head', '101'),
      job('long', '102', { text: long }),
      job('next', '103', { text: 'and this too, please' }),
    ]);
    assert.deepEqual(claimed(big.turns, 'head'), ['long']);
    const me = 'U_PERSON';
    assert.equal(
      foldedRequestText({ userId: me, text: 'head' }, [{ userId: me, text: long }, { userId: me, text: 'more text' }]).length,
      MAX_FOLDED_TEXT_CHARS,
    );
  } finally {
    big.db.close();
  }
});

test('a message delivered out of order ends the run rather than reorder the request', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '105'), job('earlier', '103'), job('later', '106')]);
    assert.deepEqual(claimed(s.turns, 'head'), []);
  } finally {
    s.db.close();
  }
});

test('plain typed messages are foldable; asks, co-addressed turns and commands are not', () => {
  assert.equal(foldableTurn(turn('1800000000.000101')), true);
  assert.equal(foldableTurn(turn('1800000000.000101', { source: 'dm_message', channelType: 'im' })), true);
  assert.equal(foldableTurn(turn('1800000000.000101', { source: 'agent_mention' })), true, 'a turn addressed to an Agent by its handle folds');
  assert.equal(foldableTurn(turn('1800000000.000101', { source: 'reaction_added' })), false);
  assert.equal(foldableTurn(turn('1800000000.000101', {
    coAddressed: { agents: [{ agentId: 'a', name: 'A', handle: 'a' }], position: 0 },
  })), false);
  assert.equal(foldableTurn(turn('1800000000.000101', { text: '<@UBOT> !routines' })), false);
  assert.equal(foldableTurn(turn('1800000000.000101', { text: '   ' })), false);
});

// ── how members end ────────────────────────────────────────────────────

test('the head\'s delivery after a completed run settles its members with it, 👀 still owed for the sweep', () => {
  const s = store();
  try {
    enqueueAll(s, [
      job('head', '101'),
      { ...job('second', '102'), midRunReceipt: { channelId: 'C_FOLD', messageTs: '1800000000.000102', name: 'eyes' } },
    ]);
    claimed(s.turns, 'head');
    dispatch(s.turns, job('head', '101'));
    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');

    const member = view(s.turns, 'second');
    assert.equal(member.status, 'done');
    assert.equal(member.cleanupPending, true, 'the cleanup sweep removes its 👀');
    assert.equal(member.job?.fold?.role, 'settled');
    assert.deepEqual(s.turns.settledFoldMembers('head'), [{
      id: 'second', runId: 'run_second', messageTs: '1800000000.000102',
      receipt: { channelId: 'C_FOLD', messageTs: '1800000000.000102', name: 'eyes', read: 'owed' },
    }]);
    assert.equal(s.turns.listPending().length, 0);
    s.turns.markDelivered('head');
    assert.deepEqual(s.turns.settledFoldMembers('head').map((row) => row.id), ['second'], 'idempotent');
  } finally {
    s.db.close();
  }
});

test('a member whose stored turn is unreadable is skipped, so its head still settles', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), job('second', '102'), job('third', '103')]);
    claimed(s.turns, 'head');
    dispatch(s.turns, job('head', '101'));
    s.db.run("UPDATE turn_jobs SET turn_json = 'not json' WHERE id = 'third'");
    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');

    assert.equal(view(s.turns, 'head').status, 'done');
    assert.equal(view(s.turns, 'second').status, 'done');
    assert.equal(view(s.turns, 'third').status, 'recovery_required', 'the unreadable row reads as it did');
    assert.deepEqual(s.turns.settledFoldMembers('head').map((row) => row.id), ['second']);
  } finally {
    s.db.close();
  }
});

test('a head that fails, or delivers without a completed run, releases its members to run once as one turn', () => {
  for (const end of ['error', 'failed settlement', 'recovery'] as const) {
    const s = store();
    try {
      enqueueAll(s, [job('head', '101'), job('second', '102'), job('third', '103')]);
      claimed(s.turns, 'head');
      if (end === 'error') {
        s.turns.markError('head');
      } else if (end === 'recovery') {
        s.turns.markRecoveryRequired('head', 'flue_receipt_conflict');
      } else {
        dispatch(s.turns, job('head', '101'));
        s.turns.recordFlueSettlement('head', FAILED);
        s.turns.markDelivered('head');
      }
      for (const id of ['second', 'third']) {
        const member = view(s.turns, id).job!;
        assert.equal(member.fold?.role, 'released', `${end}: ${id}`);
        assert.equal(turnJobGate(member), 'run', `${end}: ${id}`);
      }
      assert.deepEqual(s.turns.settledFoldMembers('head'), [], end);
      // The first released message becomes the next head and takes the rest.
      assert.deepEqual(claimed(s.turns, 'second'), ['third'], end);
    } finally {
      s.db.close();
    }
  }
});

test('a member whose head is gone reads as released', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), job('second', '102')]);
    claimed(s.turns, 'head');
    assert.equal(s.turns.discard('head'), true);
    assert.equal(turnJobGate(view(s.turns, 'second').job!), 'run');
  } finally {
    s.db.close();
  }
});

test('dispatch preparation refuses a row another run took', () => {
  const s = store();
  try {
    const second = job('second', '102');
    enqueueAll(s, [job('head', '101'), second]);
    claimed(s.turns, 'head');
    s.turns.freezeRuntimePlan('second', compileRuntimePlanV2({
      turn: second.turn, assignment: second.assignment, instructions: 'Help.', memoryEpoch: 1,
    }));
    assert.throws(
      () => s.turns.prepareFlueDispatch('second', 'Do the work', { generation: 'second' }),
      (error: unknown) => isTurnJobStopRefusal(error),
    );
  } finally {
    s.db.close();
  }
});

test('the head\'s dispatch carries every message it took as the person\'s typed text', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), job('second', '102')]);
    claimed(s.turns, 'head');
    dispatch(s.turns, job('head', '101'));
    const envelope = s.turns.getDispatchEnvelope('head');
    assert.equal(envelope?.schemaVersion, 2);
    assert.equal(
      envelope?.schemaVersion === 2 ? envelope.message.attributes.requesterText : undefined,
      'Message 1800000000.000101\n\nMessage 1800000000.000102',
    );
  } finally {
    s.db.close();
  }
});

test('the next turn continues the transcript after the newest message the previous run read', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head, job('second', '102'), job('third', '103')]);
    claimed(s.turns, 'head');
    dispatch(s.turns, head);
    const plan = s.turns.getFrozenRuntimePlan('head')!;
    s.turns.pinAgentBinding({
      continuityKey: plan.runtimePlan.conversation.continuityKey, instanceId: plan.instanceId, uid: UID, updatedAt: NOW,
    });
    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');
    const continuation = s.turns.getThreadContinuation(
      plan.runtimePlan.conversation.continuityKey, plan.instanceId, '1800000000.000110',
    );
    assert.equal(continuation?.messageTs, '1800000000.000103');
  } finally {
    s.db.close();
  }
});

test('a head reads through the newest follow-up its model holds, a late fold\'s once a later call confirms it', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head]);
    assert.equal(s.turns.readThrough('head'), '1800000000.000101', 'no follow-ups: the head itself');
    enqueueAll(s, [job('second', '102'), job('third', '103')]);
    claimed(s.turns, 'head');
    dispatch(s.turns, head);
    assert.equal(s.turns.readThrough('head'), '1800000000.000103');
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    enqueueAll(s, [job('late', '104')]);
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true });
    assert.equal(s.turns.readThrough('head'), '1800000000.000103', 'claimed, not yet confirmed');
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: false });
    assert.equal(s.turns.readThrough('head'), '1800000000.000104');
    assert.equal(s.turns.readThrough('unknown'), undefined);
  } finally {
    s.db.close();
  }
});

// ── stops ─────────────────────────────────────────────────────────────

test('a head with a stop, or a thread with an unfinished stop, takes no follow-ups', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), job('second', '102')]);
    s.turns.steer({
      kind: 'stop', threadKey: THREAD, source: 'typed', stopperUserId: 'U_PERSON', cutoffTs: '1800000000.000110',
    });
    assert.deepEqual(claimed(s.turns, 'head'), []);
    assert.equal(view(s.turns, 'second').job!.fold, undefined);
  } finally {
    s.db.close();
  }
});

test('a stop after the claim holds the members and its ending drops them, counting what the run read', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head, job('second', '102'), job('third', '103')]);
    claimed(s.turns, 'head');
    dispatch(s.turns, head);
    s.turns.steer({
      kind: 'stop', threadKey: THREAD, source: 'typed', stopperUserId: 'U_PERSON', cutoffTs: '1800000000.000110',
    });
    for (const id of ['second', 'third']) assert.equal(turnJobGate(view(s.turns, id).job!), 'hold');
    const finished = s.turns.finishStop('head', 'dropped');
    assert.equal(finished?.count, 2);
    assert.equal(finished?.read, 2, 'the stopped run had both in its prompt');
    for (const id of ['second', 'third']) assert.equal(view(s.turns, id).status, 'done');
    assert.equal(s.turns.finishStop('head', 'dropped')?.read, 2, 'a replayed ending counts the same');
  } finally {
    s.db.close();
  }
});

test('a stop before the head dispatched drops the members as unread', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), job('second', '102')]);
    claimed(s.turns, 'head');
    s.turns.steer({
      kind: 'stop', threadKey: THREAD, source: 'typed', stopperUserId: 'U_PERSON', cutoffTs: '1800000000.000110',
    });
    assert.equal(turnJobGate(view(s.turns, 'head').job!), 'stopped_before_dispatch');
    const finished = s.turns.finishStop('head', 'dropped');
    assert.equal(finished?.count, 1);
    assert.equal(finished?.read, 0);
  } finally {
    s.db.close();
  }
});

test('a run that finished before its stop took effect still settles the members it read', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head, job('second', '102')]);
    claimed(s.turns, 'head');
    dispatch(s.turns, head);
    s.turns.steer({
      kind: 'stop', threadKey: THREAD, source: 'typed', stopperUserId: 'U_PERSON', cutoffTs: '1800000000.000110',
    });
    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');
    assert.equal(view(s.turns, 'second').status, 'done');
    assert.deepEqual(s.turns.settledFoldMembers('head').map((row) => row.id), ['second']);
  } finally {
    s.db.close();
  }
});

// ── late folds (the store half of steering B) ─────────────────────────

test('a late fold claims its cycle once, replays it until confirmed, and releases what was never confirmed', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head]);
    dispatch(s.turns, head);
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    enqueueAll(s, [job('late_1', '102')]);
    const first = s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true });
    assert.deepEqual(first.messages.map((message) => message.turnJobId), ['late_1']);
    assert.equal(view(s.turns, 'late_1').job!.fold?.received, false);
    // A lost reply: the same call returns the same rows.
    assert.deepEqual(
      s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true }).messages
        .map((message) => message.turnJobId),
      ['late_1'],
    );
    enqueueAll(s, [job('late_2', '103')]);
    // The next cycle confirms cycle 1 and takes cycle 2.
    const second = s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: true });
    assert.deepEqual(second.messages.map((message) => message.turnJobId), ['late_2']);
    assert.equal(second.requesterText, 'Message 1800000000.000101\n\nMessage 1800000000.000102\n\nMessage 1800000000.000103');
    assert.equal(view(s.turns, 'late_1').job!.fold?.received, true);
    // A shut gate confirms nothing more and takes nothing.
    assert.deepEqual(s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: false }).messages, []);
    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');
    assert.equal(view(s.turns, 'late_1').status, 'done');
    assert.equal(turnJobGate(view(s.turns, 'late_2').job!), 'run', 'never confirmed: it runs as its own turn');
  } finally {
    s.db.close();
  }
});

test('a confirmation that rolls back counts nothing', (t) => {
  const db = openStateDb(':memory:');
  let failCommit = false;
  const failing: StateDb = Object.assign(Object.create(db) as StateDb, {
    transaction: <T>(fn: () => T): T => db.transaction(() => {
      const result = fn();
      if (failCommit) throw new Error('commit failed');
      return result;
    }),
  });
  const clock = { now: NOW };
  const s = { db, turns: new TurnJobStoreLogic(failing, () => clock.now), clock };
  const records: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'info', (record: Record<string, unknown>) => {
    if (record.event === 'turn_fold') records.push(record);
  });
  try {
    const head = job('head', '101');
    enqueueAll(s, [head]);
    dispatch(s.turns, head);
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    enqueueAll(s, [job('late', '102')]);
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true });
    failCommit = true;
    assert.throws(() => s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: true }));
    assert.equal(view(s.turns, 'late').job!.fold?.received, false);
    assert.deepEqual(records, []);
    failCommit = false;
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: true });
    assert.deepEqual(records.map(({ late }) => late), [1]);
  } finally {
    db.close();
  }
});

test('a late fold needs the head\'s own dispatched instance', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head, job('early', '102')]);
    const elsewhere = job('elsewhere', '101', { threadTs: '1800000001.000100' });
    enqueueAll(s, [elsewhere]);
    dispatch(s.turns, elsewhere);
    const otherInstance = s.turns.getFrozenRuntimePlan('elsewhere')!.instanceId;
    assert.deepEqual(
      s.turns.fold({ phase: 'finish', headId: 'head', instanceId: otherInstance, received: 0, take: true }).messages,
      [],
      'not dispatched yet',
    );
    dispatch(s.turns, head);
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    assert.notEqual(instanceId, otherInstance);
    assert.deepEqual(
      s.turns.fold({ phase: 'finish', headId: 'head', instanceId: otherInstance, received: 0, take: true }).messages,
      [],
      'another instance',
    );
  } finally {
    s.db.close();
  }
});

// ── tool-boundary folds (steering C) ──────────────────────────────────

test('tool-boundary folds and the would-stop fold share one cycle sequence, each confirmed by the next call', () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head]);
    dispatch(s.turns, head);
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    const taken = (request: Parameters<TurnJobStoreLogic['fold']>[0]) =>
      s.turns.fold(request).messages.map((message) => message.turnJobId);

    enqueueAll(s, [job('tool_1', '102')]);
    assert.deepEqual(taken({ phase: 'turn', headId: 'head', instanceId, received: 0, take: true }), ['tool_1']);
    assert.deepEqual(taken({ phase: 'turn', headId: 'head', instanceId, received: 0, take: true }), ['tool_1'],
      'a lost reply: the same call returns the same rows');
    assert.equal(view(s.turns, 'tool_1').job!.fold?.received, false);
    assert.equal(turnJobGate(view(s.turns, 'tool_1').job!), 'hold');

    enqueueAll(s, [job('tool_2', '103')]);
    assert.deepEqual(taken({ phase: 'turn', headId: 'head', instanceId, received: 1, take: true }), ['tool_2']);
    assert.equal(view(s.turns, 'tool_1').job!.fold?.received, true, 'the next boundary confirms the first');

    enqueueAll(s, [job('would_stop', '104')]);
    const late = s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 2, take: true });
    assert.deepEqual(late.messages.map((message) => message.turnJobId), ['would_stop'], 'the would-stop fold continues the count');
    assert.equal(late.requesterText, [101, 102, 103, 104].map((n) => `Message 1800000000.000${n}`).join('\n\n'));
    assert.deepEqual(['tool_1', 'tool_2', 'would_stop'].map((id) => view(s.turns, id).job!.fold?.cycle), [1, 2, 3]);
    assert.equal(view(s.turns, 'tool_2').job!.fold?.received, true);

    assert.deepEqual(taken({ phase: 'finish', headId: 'head', instanceId, received: 3, take: false }), []);
    assert.equal(s.turns.readThrough('head'), '1800000000.000104');
    s.turns.recordFlueSettlement('head', COMPLETED);
    s.turns.markDelivered('head');
    assert.deepEqual(['tool_1', 'tool_2', 'would_stop'].map((id) => view(s.turns, id).status), ['done', 'done', 'done']);
  } finally {
    s.db.close();
  }
});

test('a tool-boundary fold takes what a would-stop fold would: the head\'s own instance, a teammate as information only', () => {
  const s = store();
  try {
    const head = job('head', '101');
    const elsewhere = job('elsewhere', '101', { threadTs: '1800000001.000100' });
    enqueueAll(s, [head, elsewhere]);
    dispatch(s.turns, elsewhere);
    const otherInstance = s.turns.getFrozenRuntimePlan('elsewhere')!.instanceId;
    enqueueAll(s, [job('teammate', '102', { userId: 'U_TEAMMATE' })]);
    assert.deepEqual(
      s.turns.fold({ phase: 'turn', headId: 'head', instanceId: otherInstance, received: 0, take: true }).messages,
      [],
      'not dispatched yet',
    );
    dispatch(s.turns, head, 'personal');
    assert.deepEqual(
      s.turns.fold({ phase: 'turn', headId: 'head', instanceId: otherInstance, received: 0, take: true }).messages,
      [],
      'another instance',
    );
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    const claim = s.turns.fold({ phase: 'turn', headId: 'head', instanceId, received: 0, take: true });
    assert.deepEqual(claim.messages.map(({ turnJobId, informationOnly }) => ({ turnJobId, informationOnly })), [
      { turnJobId: 'teammate', informationOnly: true },
    ]);
    assert.equal(claim.requesterText, 'Message 1800000000.000101', 'a teammate\'s words never choose connections');
    assert.equal(view(s.turns, 'teammate').job!.fold?.role, 'informed');
  } finally {
    s.db.close();
  }
});

test(`tool-boundary folds stop at ${MAX_TURN_FOLD_CYCLES} cycles; the would-stop phase keeps its own ${MAX_FOLD_CYCLES} after them`, () => {
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head]);
    dispatch(s.turns, head);
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    enqueueAll(s, [job('late', '102')]);
    const ids = (claim: { messages: { turnJobId: string }[] }) => claim.messages.map((message) => message.turnJobId);
    const sequenceEnd = MAX_TURN_FOLD_CYCLES + MAX_FOLD_CYCLES;
    assert.deepEqual(
      ids(s.turns.fold({ phase: 'turn', headId: 'head', instanceId, received: MAX_TURN_FOLD_CYCLES, take: true })),
      [],
      'past the tool-boundary cap',
    );
    assert.deepEqual(
      ids(s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: sequenceEnd, take: true })),
      [],
      'past the whole sequence',
    );
    assert.deepEqual(
      ids(s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: sequenceEnd - 1, take: true })),
      ['late'],
      'a would-stop fold still has room after every tool-boundary fold',
    );
    for (const phase of ['turn', 'finish'] as const) {
      assert.throws(
        () => s.turns.fold({ phase, headId: 'head', instanceId, received: sequenceEnd + 1, take: true }),
        /Fold cycle count is invalid/,
        phase,
      );
    }
    assert.throws(
      () => s.turns.fold({ phase: 'later', headId: 'head', instanceId, received: 0, take: true } as never),
      /Fold phase is invalid/,
    );
  } finally {
    s.db.close();
  }
});

test('turn_fold counts how many of the confirmed messages a tool boundary took', (t) => {
  const records: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'info', (record: Record<string, unknown>) => {
    if (record.event === 'turn_fold') records.push(record);
  });
  const s = store();
  try {
    const head = job('head', '101');
    enqueueAll(s, [head]);
    dispatch(s.turns, head);
    const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
    enqueueAll(s, [job('tool_1', '102'), job('tool_2', '103')]);
    s.turns.fold({ phase: 'turn', headId: 'head', instanceId, received: 0, take: true });
    enqueueAll(s, [job('would_stop', '104')]);
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: true });
    s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 2, take: false });
    assert.deepEqual(records, [
      { component: 'runtime', event: 'turn_fold', turnRef: opaqueTurnRef('head'), late: 2, turn: 2 },
      { component: 'runtime', event: 'turn_fold', turnRef: opaqueTurnRef('head'), late: 1 },
    ]);
  } finally {
    s.db.close();
  }
});

// ── 👍 on read ─────────────────────────────────────────────────────────

/** A row whose message arrived mid-run, so it carries Chickpea's 👀. */
function seen(id: string, suffix: string, overrides: Partial<NormalizedSlackTurn> = {}): TurnJob {
  return {
    ...job(id, suffix, overrides),
    midRunReceipt: { channelId: 'C_FOLD', messageTs: `1800000000.000${suffix}`, name: 'eyes' },
  };
}

function receiptOf(turns: TurnJobStoreLogic, id: string) {
  return view(turns, id).job!.progress.slackInteraction?.acknowledgment;
}

test('a turn start owes 👍 for its own 👀 and its members\', and lists them for the turn to swap', () => {
  const s = store();
  try {
    enqueueAll(s, [seen('head', '101'), seen('second', '102'), job('third', '103')]);
    const claim = s.turns.fold({ phase: 'start', headId: 'head' });
    assert.deepEqual(claim.receipts, [
      { turnJobId: 'head', receipt: { channelId: 'C_FOLD', messageTs: '1800000000.000101', name: 'eyes' } },
      { turnJobId: 'second', receipt: { channelId: 'C_FOLD', messageTs: '1800000000.000102', name: 'eyes' } },
    ]);
    for (const id of ['head', 'second']) assert.equal(receiptOf(s.turns, id)?.read, 'owed', id);
    assert.equal(receiptOf(s.turns, 'third'), undefined, 'a message posted while idle has no 👀');
    // A retry gets the same list and owes nothing new.
    const before = s.db.all('SELECT id, progress_json FROM turn_jobs ORDER BY id');
    assert.deepEqual(s.turns.fold({ phase: 'start', headId: 'head' }).receipts, claim.receipts);
    assert.deepEqual(s.db.all('SELECT id, progress_json FROM turn_jobs ORDER BY id'), before);
    // Once a member's 👍 replaced its 👀, a retry neither lists nor owes it again.
    s.turns.recordSlackInteractionProgress('second', {
      acknowledgment: {
        channelId: 'C_FOLD', messageTs: '1800000000.000102', name: '+1', created: true, cleanup: 'pending',
        reaction: 'read', read: 'done',
      },
    });
    assert.deepEqual(s.turns.fold({ phase: 'start', headId: 'head' }).receipts?.map((row) => row.turnJobId), ['head']);
    assert.equal(receiptOf(s.turns, 'second')?.read, 'done');
  } finally {
    s.db.close();
  }
});

test('an information-only member keeps its 👀 for its own turn; one the frozen plan folds in is owed 👍', () => {
  for (const access of ['shared', 'personal'] as const) {
    const s = store();
    try {
      const head = job('head', '101');
      enqueueAll(s, [head, seen('teammate', '102', { userId: 'U_TEAMMATE' })]);
      const claim = s.turns.fold({ phase: 'start', headId: 'head' });
      // Before the plan freezes the store cannot tell, so it owes nothing yet;
      // the turn decides from the frozen plan which receipts it swaps.
      assert.deepEqual(claim.receipts?.map((row) => row.turnJobId), ['teammate'], access);
      assert.equal(receiptOf(s.turns, 'teammate')?.read, undefined, access);
      freeze(s.turns, head, access);
      assert.equal(receiptOf(s.turns, 'teammate')?.read, access === 'shared' ? 'owed' : undefined, access);
    } finally {
      s.db.close();
    }
  }
});

test('a late fold, at a tool boundary or before the reply, owes 👍 once a later claim confirms it, never for information only', () => {
  for (const phase of ['turn', 'finish'] as const) {
    for (const access of ['shared', 'personal'] as const) {
      const label = `${phase} ${access}`;
      const s = store();
      try {
        const head = job('head', '101');
        enqueueAll(s, [head]);
        dispatch(s.turns, head, access);
        const instanceId = s.turns.getFrozenRuntimePlan('head')!.instanceId;
        enqueueAll(s, [seen('own', '102'), seen('teammate', '103', { userId: 'U_TEAMMATE' })]);
        const late = s.turns.fold({ phase, headId: 'head', instanceId, received: 0, take: true });
        assert.deepEqual(late.messages.map((message) => message.turnJobId), ['own', 'teammate'], label);
        assert.equal(late.receipts, undefined, 'a late fold lists none');
        for (const id of ['own', 'teammate']) assert.equal(receiptOf(s.turns, id)?.read, undefined, `${label} ${id} unconfirmed`);
        s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 1, take: false });
        assert.equal(receiptOf(s.turns, 'own')?.read, 'owed', label);
        assert.equal(receiptOf(s.turns, 'teammate')?.read, access === 'shared' ? 'owed' : undefined, label);
      } finally {
        s.db.close();
      }
    }
  }
});

test('a stop that drops members reports each receipt with whether its 👍 was owed', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101'), seen('second', '102')]);
    claimed(s.turns, 'head');
    dispatch(s.turns, job('head', '101'));
    s.turns.steer({
      kind: 'stop', threadKey: THREAD, source: 'typed', stopperUserId: 'U_PERSON', cutoffTs: '1800000000.000110',
    });
    const finished = s.turns.finishStop('head', 'dropped');
    assert.deepEqual(finished?.rows.find((row) => row.id === 'second')?.receipt, {
      channelId: 'C_FOLD', messageTs: '1800000000.000102', name: 'eyes', read: 'owed',
    });
  } finally {
    s.db.close();
  }
});

// ── the follow-ups' canonical records ────────────────────────────────

/** One state store with every owner of a canonical Slack admission. */
function canonicalStore() {
  const s = store();
  const now = () => s.clock.now;
  return {
    ...s,
    slack: new SlackStateLogic(s.db, now),
    work: new WorkStoreLogic(s.db, { now }),
    presentations: new SlackRunPresentationStoreLogic(s.db, now),
  };
}

type CanonicalStore = ReturnType<typeof canonicalStore>;

/** Admit a turn as Slack admission does: claims, Work Run, TurnJob and an admitted V3 presentation. */
function admitCanonical(
  c: CanonicalStore,
  queued: TurnJob,
  owner: SlackPresentationOwner = { kind: 'chickpea' },
): RunId {
  const admission = prepareSlackShadowAdmission({
    turn: queued.turn, assignment: queued.assignment, sourceVisibility: 'public', admittedAt: c.clock.now,
  });
  const sessionGeneration = slackSessionGenerationFromTimestamp(queued.turn.messageTs);
  const result = c.slack.admitCanonical({
    evtKey: queued.evtKey,
    msgKey: queued.msgKey,
    threadKey: THREAD,
    admission,
    turnJob: { ...queued, runId: admission.run.id, executionAuthority: admission.run.executionAuthority },
    presentation: {
      schemaVersion: 3,
      root: { workspaceId: 'T_FOLD', channelId: 'C_FOLD', threadTs: THREAD_TS, requesterUserId: queued.turn.userId },
      owner,
      sessionGeneration,
      currentActivity: {
        kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration, sequence: 1,
        operation: { operationId: `activity_${queued.id}`, certainty: 'pending' },
      },
    },
  }, c.work, c.turns, c.presentations);
  assert.equal(result.claimed, true);
  c.clock.now += 1;
  return admission.run.id;
}

function canonicalBurst() {
  const c = canonicalStore();
  const head = job('head', '101');
  const runs = {
    head: admitCanonical(c, head),
    second: admitCanonical(c, job('second', '102')),
    third: admitCanonical(c, job('third', '103')),
  };
  claimed(c.turns, 'head');
  dispatch(c.turns, head);
  return { ...c, runs };
}

test('a delivered turn settles its follow-ups\' Runs superseded and closes their presentations, once', () => {
  const c = canonicalBurst();
  try {
    c.turns.recordFlueSettlement('head', COMPLETED);
    c.slack.endTurn('head', c.turns, c.work, c.presentations);
    for (const id of ['second', 'third'] as const) {
      const run = c.work.getRun(c.runs[id]);
      assert.equal(run?.status, 'settled', id);
      assert.equal(run?.terminalDisposition, 'superseded', `${id} was answered by the head's run`);
      assert.equal(c.work.listRunExecutions(c.runs[id]).length, 0, `${id} never executed`);
      const presentation = c.presentations.get(c.runs[id]) as SlackRunPresentationV3;
      assert.equal(presentation.lifecyclePhase, 'settled');
      assert.equal(presentation.repairRequired, false);
    }
    assert.equal(c.work.getRun(c.runs.head)?.status, 'admitted', 'the head\'s own lifecycle settles its Run');
    const settled = (['second', 'third'] as const).map((id) => c.work.getRun(c.runs[id]));
    c.clock.now += 60_000;
    c.slack.endTurn('head', c.turns, c.work, c.presentations);
    assert.deepEqual((['second', 'third'] as const).map((id) => c.work.getRun(c.runs[id])), settled);
    assert.equal(c.work.listAuditEvents(c.runs.second, 50)
      .filter((event) => event.eventType === 'work.run_settled_without_delivery').length, 1);
  } finally {
    c.db.close();
  }
});

test('the Node state store settles the follow-ups\' records when it marks their head delivered', async () => {
  const c = canonicalBurst();
  try {
    c.turns.recordFlueSettlement('head', COMPLETED);
    const state = localSlackStateStore({
      slack: c.slack, work: c.work, turnJobs: c.turns, presentations: c.presentations,
    });
    await state.markTurnDelivered!('head');
    for (const id of ['second', 'third'] as const) {
      assert.equal(c.work.getRun(c.runs[id])?.terminalDisposition, 'superseded', id);
    }
  } finally {
    c.db.close();
  }
});

test('a late fold through the Node store ends with the reply: confirmed members settle, the rest run on their own', async (t) => {
  const c = canonicalStore();
  const records: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'info', (record: Record<string, unknown>) => {
    if (record.event === 'turn_fold') records.push(record);
  });
  try {
    const head = job('head', '101');
    const runs = { head: admitCanonical(c, head) };
    dispatch(c.turns, head);
    const instanceId = c.turns.getFrozenRuntimePlan('head')!.instanceId;
    const late = (id: string, suffix: string) => admitCanonical(c, {
      ...job(id, suffix),
      midRunReceipt: { channelId: 'C_FOLD', messageTs: `1800000000.000${suffix}`, name: 'eyes' },
    });
    const state = localSlackStateStore({
      slack: c.slack, work: c.work, turnJobs: c.turns, presentations: c.presentations,
    });
    const lateRuns = { read: late('read', '102') };
    const first = await state.foldTurn!({ phase: 'finish', headId: 'head', instanceId, received: 0, take: true });
    assert.deepEqual(first.messages.map((message) => message.turnJobId), ['read']);
    const unread = late('unread', '103');
    // The Agent appended the first fold; this would-stop confirms it and takes the next.
    const second = await state.foldTurn!({ phase: 'finish', headId: 'head', instanceId, received: 1, take: true });
    assert.deepEqual(second.messages.map((message) => message.turnJobId), ['unread']);
    // A lost reply: the Agent never appended the second fold, so nothing confirms it.
    assert.deepEqual(records.map(({ late: count, turnRef }) => ({ late: count, turnRef })), [
      { late: 1, turnRef: opaqueTurnRef('head') },
    ]);
    c.turns.recordFlueSettlement('head', COMPLETED);
    await state.markTurnDelivered!('head');

    const read = view(c.turns, 'read');
    assert.equal(read.status, 'done');
    assert.equal(read.cleanupPending, true, 'the cleanup sweep removes its 👀');
    assert.equal(read.job?.fold?.role, 'settled');
    assert.equal(c.work.getRun(lateRuns.read)?.terminalDisposition, 'superseded');
    assert.equal((c.presentations.get(lateRuns.read) as SlackRunPresentationV3).lifecyclePhase, 'settled');

    assert.equal(view(c.turns, 'unread').status, 'pending');
    assert.equal(turnJobGate(view(c.turns, 'unread').job!), 'run', 'never confirmed: it runs as its own turn');
    assert.equal(c.work.getRun(unread)?.status, 'admitted');
    assert.equal(c.work.getRun(runs.head)?.status, 'admitted', 'the head\'s own lifecycle settles its Run');
    assert.equal(records.length, 1, 'each late member counts once');
  } finally {
    c.db.close();
  }
});

test('a tool-boundary fold through the Node store ends with the reply once the would-stop call confirms it', async () => {
  const c = canonicalStore();
  try {
    const head = job('head', '101');
    admitCanonical(c, head);
    dispatch(c.turns, head);
    const instanceId = c.turns.getFrozenRuntimePlan('head')!.instanceId;
    const run = admitCanonical(c, job('during_tools', '102'));
    const state = localSlackStateStore({
      slack: c.slack, work: c.work, turnJobs: c.turns, presentations: c.presentations,
    });
    const claim = await state.foldTurn!({ phase: 'turn', headId: 'head', instanceId, received: 0, take: true });
    assert.deepEqual(claim.messages.map((message) => message.turnJobId), ['during_tools']);
    assert.equal(await state.turnReadThrough!('head'), '1800000000.000101', 'claimed, not yet confirmed');
    // A streamed answer shut the gate; the would-stop call still confirms.
    await state.foldTurn!({ phase: 'finish', headId: 'head', instanceId, received: 1, take: false });
    assert.equal(await state.turnReadThrough!('head'), '1800000000.000102');
    c.turns.recordFlueSettlement('head', COMPLETED);
    await state.markTurnDelivered!('head');
    assert.equal(view(c.turns, 'during_tools').status, 'done');
    assert.deepEqual(c.turns.settledFoldMembers('head').map((row) => row.id), ['during_tools']);
    assert.equal(c.work.getRun(run)?.terminalDisposition, 'superseded');
  } finally {
    c.db.close();
  }
});

test('follow-ups a failed run released keep their Runs and presentations, to run as ordinary turns', () => {
  const c = canonicalBurst();
  try {
    c.turns.recordFlueSettlement('head', FAILED);
    c.slack.endTurn('head', c.turns, c.work, c.presentations);
    for (const id of ['second', 'third'] as const) {
      assert.equal(c.work.getRun(c.runs[id])?.status, 'admitted', id);
      assert.equal((c.presentations.get(c.runs[id]) as SlackRunPresentationV3).lifecyclePhase, 'admitted', id);
    }
  } finally {
    c.db.close();
  }
});

// ── edits: admission ──────────────────────────────────────────────────

/** A message's own row, keyed as Slack admission keys it. */
function posted(
  suffix: string,
  overrides: Partial<NormalizedSlackTurn> = {},
  assigned: Partial<ResolvedAssignment> = {},
): TurnJob {
  const id = `msg:C_FOLD:1800000000.000${suffix}`;
  return { ...job(id, suffix, overrides, assigned), evtKey: `evt:Ev_${suffix}`, msgKey: id };
}

/** The author's edit of `target`, saved at `.000<saved>`. */
function editOf(target: TurnJob, saved: string, text: string, overrides: Partial<SlackMessageEdit> = {}): SlackMessageEdit {
  return {
    workspaceId: 'T_FOLD', channelId: 'C_FOLD', messageTs: target.turn.messageTs,
    editedTs: `1800000000.000${saved}`, userId: target.turn.userId, text, eventId: `EvEdit${saved}`,
    ...overrides,
  };
}

function admitEdit(c: CanonicalStore, edit: SlackMessageEdit) {
  const admitted = c.slack.admitEdit(edit, c.work, c.turns, c.presentations);
  c.clock.now += 1;
  return admitted;
}

/** What an admission wrote: rows, claims and Runs, so a refusal can be shown to write none. */
function written(c: CanonicalStore) {
  return {
    rows: c.db.all('SELECT id FROM turn_jobs ORDER BY id').map((row) => String(row.id)),
    claims: c.db.all('SELECT key FROM slack_claims ORDER BY key').map((row) => String(row.key)),
    runs: Number(c.db.get('SELECT COUNT(*) AS count FROM runs')?.count),
  };
}

test('an edit of a message with no queued or running turn steers nothing and writes nothing', () => {
  const c = canonicalStore();
  try {
    const answered = posted('101');
    admitCanonical(c, answered);
    dispatch(c.turns, answered);
    c.turns.recordFlueSettlement(answered.id, COMPLETED);
    c.slack.endTurn(answered.id, c.turns, c.work, c.presentations);
    const before = written(c);
    assert.deepEqual(admitEdit(c, editOf(answered, '201', 'deploy to staging')),
      { outcome: 'refused', reason: 'no_live_turn' }, 'its answer is done');
    assert.deepEqual(admitEdit(c, editOf(posted('102'), '202', 'deploy to staging')),
      { outcome: 'refused', reason: 'no_live_turn' }, 'never addressed to the Agent');
    assert.deepEqual(written(c), before);
  } finally {
    c.db.close();
  }
});

test('an edit never re-decides a turn admission judged from the old text', () => {
  const head = posted('101');
  for (const [label, target] of [
    ['files', posted('102', { attachments: [{ fileId: 'F1' }] })],
    ['a memory command', posted('102', { text: '!memory list' })],
    ['a co-addressed message', posted('102', {
      coAddressed: { agents: [{ agentId: 'agent_fold', name: 'Fold', handle: 'fold' }], position: 0 },
    })],
    ['an approval', posted('102', { managementApprovalProposalId: 'prop_1', text: 'approve' })],
    ['a ledger turn', { ...posted('102'), executionAuthority: 'ledger' as const }],
  ] as Array<[string, TurnJob]>) {
    const c = canonicalStore();
    try {
      enqueueAll(c, [head, target]);
      assert.deepEqual(admitEdit(c, editOf(target, '201', 'no, cancel it')),
        { outcome: 'refused', reason: 'not_foldable' }, label);
    } finally {
      c.db.close();
    }
  }
  for (const [label, text] of [['a command', '!memory forget everything'], ['blank text', '   ']] as const) {
    const c = canonicalStore();
    try {
      admitCanonical(c, head);
      assert.deepEqual(admitEdit(c, editOf(head, '201', text)), { outcome: 'refused', reason: 'not_foldable' }, label);
    } finally {
      c.db.close();
    }
  }
});

test('an edit is the author\'s alone', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    admitCanonical(c, head);
    assert.deepEqual(admitEdit(c, editOf(head, '201', 'deploy to staging', { userId: 'U_TEAMMATE' })),
      { outcome: 'refused', reason: 'not_author' });
  } finally {
    c.db.close();
  }
});

test('an admitted edit is a row of its own: the message\'s turn and Agent, the new text, its own Run, the same sender', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'deploy to prod' });
    const owner: SlackPresentationOwner = { kind: 'agent_app', agentName: 'Fold' };
    const headRun = admitCanonical(c, head, owner);
    const admitted = admitEdit(c, editOf(head, '201', 'deploy to staging, <@U_OTHER_AGENT> stop'));
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') return;
    const id = editTurnJobId('C_FOLD', head.turn.messageTs, '1800000000.000201');
    assert.equal(admitted.job.id, id);
    const row = view(c.turns, id).job!;
    assert.deepEqual(row.turn, {
      ...head.turn, text: 'deploy to staging, <@U_OTHER_AGENT> stop', eventId: 'EvEdit201',
      edit: { editedTs: '1800000000.000201', previousText: 'deploy to prod' },
    });
    assert.equal(row.assignment.agentId, 'agent_fold', 'an edit never routes to another Agent');
    assert.equal(row.stop, undefined, 'an edit is never a stop');
    assert.equal(view(c.turns, head.id).job!.stop, undefined);
    assert.equal(row.progress.slackInteraction, undefined, 'no reaction of its own');
    assert.ok(row.runId && row.runId !== headRun, 'a Run of its own');
    const presentation = c.presentations.get(row.runId!) as SlackRunPresentationV3;
    const original = c.presentations.get(headRun) as SlackRunPresentationV3;
    assert.deepEqual(presentation.owner, owner, 'it replies as its message\'s sender');
    assert.deepEqual(presentation.root, original.root);
    assert.equal(presentation.turnJobId, id);
  } finally {
    c.db.close();
  }
});

test('a channel root\'s edit reads the thread its reply went to when it runs on its own', () => {
  const c = canonicalStore();
  try {
    const root = posted('101', { contextMode: 'channel_history', threadTs: '1800000000.000101', source: 'app_mention' });
    admitCanonical(c, root);
    const admitted = admitEdit(c, editOf(root, '201', 'deploy to staging'));
    assert.equal(admitted.outcome === 'admitted' && admitted.job.turn.contextMode, 'thread');
  } finally {
    c.db.close();
  }
});

test('an edit is admitted once, however often Slack delivers it, and only a newer version steers', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'v1' });
    admitCanonical(c, head);
    const v2 = editOf(head, '200', 'v2');
    const first = admitEdit(c, v2);
    assert.equal(first.outcome, 'admitted');
    const once = written(c);
    for (const [label, delivery] of [
      ['a redelivery', v2],
      ['another app\'s delivery of the same edit', { ...v2, eventId: 'EvEditOtherApp' }],
    ] as const) {
      const again = admitEdit(c, delivery);
      assert.equal(again.outcome, 'already_admitted', label);
      assert.equal(again.outcome === 'already_admitted' && again.job.id, first.outcome === 'admitted' && first.job.id, label);
      assert.deepEqual(written(c), once, `${label}: one row, one Run`);
    }
    assert.deepEqual(admitEdit(c, editOf(head, '150', 'v1.5')), { outcome: 'refused', reason: 'stale' },
      'an older edit delivered late never puts older text back');
    assert.deepEqual(admitEdit(c, editOf(head, '300', 'v2')), { outcome: 'refused', reason: 'unchanged' },
      'saving without a change steers nothing');
    const v3 = admitEdit(c, editOf(head, '300', 'v3'));
    assert.equal(v3.outcome === 'admitted' && v3.job.turn.edit?.previousText, 'v2', 'the newest version came before it');
  } finally {
    c.db.close();
  }
});

// ── edits: what the run reads ─────────────────────────────────────────

function editRowId(target: TurnJob, saved: string): string {
  return editTurnJobId('C_FOLD', target.turn.messageTs, `1800000000.000${saved}`);
}

function late(c: CanonicalStore, head: TurnJob, received: number, phase: 'turn' | 'finish' = 'turn', take = true) {
  const instanceId = c.turns.getFrozenRuntimePlan(head.id)!.instanceId;
  return c.turns.fold({ phase, headId: head.id, instanceId, received, take });
}

const read = (claim: { messages: Array<{ turnJobId: string; text: string; edit?: unknown; informationOnly?: true }> }) =>
  claim.messages.map(({ turnJobId, text, edit, informationOnly }) => ({
    turnJobId, text, ...(edit ? { edit } : {}), ...(informationOnly ? { informationOnly } : {}),
  }));

test('the status names what a late fold reads: new messages, edited ones, or both', () => {
  const edit = { previousText: 'before' };
  assert.equal(foldActivityStatus([{}, {}], 'start').text, 'Reading 3 messages…', 'the head counts at start');
  assert.equal(foldActivityStatus([{}], 'turn').text, 'Reading 1 new message…');
  assert.equal(foldActivityStatus([{ edit }], 'turn').text, 'Reading 1 edited message…');
  assert.equal(foldActivityStatus([{}, {}, { edit }, { edit }], 'finish').text, 'Reading 2 new messages and 2 edited messages…');
});

test('a claim reads its messages and edit notes in the order people sent them, each message once', () => {
  const row = (messageTs: string, text: string, edit?: { editedTs: string; previousText: string }) => ({
    turnJobId: `${messageTs}:${edit?.editedTs ?? ''}`, userId: 'U_PERSON', messageTs, text, ...(edit ? { edit } : {}),
  });
  const rows = [
    row('1800000000.000105', 'new message'),
    row('1800000000.000102', 'v3', { editedTs: '1800000000.000106', previousText: 'v2' }),
    row('1800000000.000102', 'v2', { editedTs: '1800000000.000104', previousText: 'v1' }),
    row('1800000000.000101', 'head v2', { editedTs: '1800000000.000103', previousText: 'head v1' }),
  ];
  assert.deepEqual(readFoldClaim({ headTs: '1800000000.000101', phase: 'turn', rows }).messages.map(({ text, edit }) => [text, edit]), [
    ['head v2', { previousText: 'head v1' }],
    ['new message', undefined],
    ['v3', { previousText: 'v1' }],
  ]);
  const start = readFoldClaim({ headTs: '1800000000.000101', phase: 'start', rows });
  assert.equal(start.headText, 'head v2');
  assert.deepEqual(start.messages.map(({ text }) => text), ['new message', 'v3'], 'at start the head is read whole, never as a note');
});

test('an edit of the head joins its start claim wherever it sits, and the members behind it still join', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'deploy to prod' });
    const first = posted('102', { text: 'and tag it' });
    enqueueAll(c, [head, first]);
    admitEdit(c, editOf(head, '150', 'deploy to staging'));
    const second = posted('103', { text: 'then tell me' });
    enqueueAll(c, [second]);

    const claim = c.turns.fold({ phase: 'start', headId: head.id });
    assert.equal(claim.headText, 'deploy to staging', 'the run reads the head\'s newest text');
    assert.deepEqual(read(claim), [
      { turnJobId: first.id, text: 'and tag it' },
      { turnJobId: second.id, text: 'then tell me' },
    ], 'the edit row neither breaks the run of members nor shows as a message');
    const editRow = view(c.turns, editRowId(head, '150')).job!;
    assert.equal(editRow.fold?.headId, head.id);
    assert.equal(turnJobGate(editRow), 'hold', 'the head answers it');
    assert.deepEqual(c.turns.fold({ phase: 'start', headId: head.id }), claim, 'a replay reads the same');
  } finally {
    c.db.close();
  }
});

test('the scan never steps over a message that cannot join, though an edit of the head behind it still joins', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'deploy to prod' });
    const files = posted('102', { attachments: [{ fileId: 'F1' }] });
    enqueueAll(c, [head, files]);
    admitEdit(c, editOf(head, '150', 'deploy to staging'));
    const after = posted('103');
    enqueueAll(c, [after]);

    const claim = c.turns.fold({ phase: 'start', headId: head.id });
    assert.equal(claim.headText, 'deploy to staging');
    assert.deepEqual(claim.messages, []);
    assert.equal(view(c.turns, files.id).job!.fold, undefined);
    assert.equal(view(c.turns, after.id).job!.fold, undefined, 'the message after the file keeps its place');
  } finally {
    c.db.close();
  }
});

test('an edit row of a message outside the group ends the scan like any row that cannot join', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    const first = posted('102');
    const elsewhere = posted('099');
    const elsewhereEdit: TurnJob = {
      ...elsewhere,
      id: editRowId(elsewhere, '150'), msgKey: editRowId(elsewhere, '150'), evtKey: 'evt:EvEdit150',
      turn: { ...elsewhere.turn, text: 'edited', edit: { editedTs: '1800000000.000150', previousText: elsewhere.turn.text } },
    };
    const second = posted('103');
    enqueueAll(c, [head, first, elsewhereEdit, second]);
    const claim = c.turns.fold({ phase: 'start', headId: head.id });
    assert.deepEqual(claim.messages.map((message) => message.turnJobId), [first.id]);
    assert.equal(claim.headText, undefined);
    assert.equal(view(c.turns, second.id).job!.fold, undefined);
    assert.equal(view(c.turns, elsewhereEdit.id).job!.fold, undefined);
  } finally {
    c.db.close();
  }
});

test('an edit taken with a late member never moves the point the scan reads from', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    enqueueAll(c, [head]);
    dispatch(c.turns, head);
    const first = posted('102', { text: 'v1' });
    const second = posted('104', { text: 'and this' });
    enqueueAll(c, [first, second]);
    admitEdit(c, editOf(first, '150', 'v2'));

    assert.deepEqual(read(late(c, head, 0)), [
      { turnJobId: first.id, text: 'v2' },
      { turnJobId: second.id, text: 'and this' },
    ], 'a member the run has not read yet is read once, with its newest text');
    // Slack delivers an older message late: it is older than one the run read.
    const older = posted('103');
    enqueueAll(c, [older]);
    assert.deepEqual(late(c, head, 1).messages, []);
    assert.equal(view(c.turns, older.id).job!.fold, undefined, 'it runs as its own turn rather than reorder the request');
  } finally {
    c.db.close();
  }
});

test('an edit of the head after its prompt froze reaches the run as an edit note, never as the head\'s text', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'deploy to prod' });
    enqueueAll(c, [head]);
    assert.equal(c.turns.fold({ phase: 'start', headId: head.id }).headText, undefined);
    dispatch(c.turns, head);
    admitEdit(c, editOf(head, '150', 'deploy to staging'));
    assert.equal(c.turns.fold({ phase: 'start', headId: head.id }).headText, undefined, 'a start replay never changes the dispatched prompt');
    assert.deepEqual(read(late(c, head, 0)), [{
      turnJobId: editRowId(head, '150'), text: 'deploy to staging', edit: { previousText: 'deploy to prod' },
    }]);
  } finally {
    c.db.close();
  }
});

test('an edit of the head before its dispatch is read by the start claim\'s replay', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'deploy to prod' });
    enqueueAll(c, [head]);
    assert.equal(c.turns.fold({ phase: 'start', headId: head.id }).headText, undefined);
    // The attempt failed before its dispatch; the person edits; the retry claims again.
    admitEdit(c, editOf(head, '150', 'deploy to staging'));
    assert.equal(c.turns.fold({ phase: 'start', headId: head.id }).headText, 'deploy to staging');
    dispatch(c.turns, head);
    assert.equal(c.turns.fold({ phase: 'start', headId: head.id }).headText, 'deploy to staging', 'the frozen prompt\'s text, again');
    assert.deepEqual(late(c, head, 0).messages, [], 'never a note for what the run read');
  } finally {
    c.db.close();
  }
});

test('a member taken but not yet confirmed is read with its newest text when its cycle is replayed', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    enqueueAll(c, [head]);
    dispatch(c.turns, head);
    const member = posted('102', { text: 'v1' });
    enqueueAll(c, [member]);
    assert.deepEqual(read(late(c, head, 0)), [{ turnJobId: member.id, text: 'v1' }]);
    admitEdit(c, editOf(member, '150', 'v2'));
    assert.deepEqual(read(late(c, head, 0)), [{ turnJobId: member.id, text: 'v2' }], 'the lost cycle is read again, newest text, no note');
    assert.deepEqual(late(c, head, 1).messages, []);
    assert.equal(view(c.turns, editRowId(member, '150')).job!.fold?.received, true);
    assert.deepEqual(late(c, head, 1).messages, [], 'never offered again');
  } finally {
    c.db.close();
  }
});

test('an edit of a member whose cycle was dispatched is a note at the next cycle, against the text the run read', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    enqueueAll(c, [head]);
    dispatch(c.turns, head);
    const member = posted('102', { text: 'v1' });
    enqueueAll(c, [member]);
    late(c, head, 0);
    admitEdit(c, editOf(member, '150', 'v2'));
    assert.deepEqual(read(late(c, head, 1)), [{ turnJobId: editRowId(member, '150'), text: 'v2', edit: { previousText: 'v1' } }]);
    assert.equal(view(c.turns, member.id).job!.fold?.received, true);
  } finally {
    c.db.close();
  }
});

test('successive edits taken at one point read as one note with the newest text; later ones diff against what the run read', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'v1' });
    enqueueAll(c, [head]);
    dispatch(c.turns, head);
    const v2 = editOf(head, '150', 'v2');
    assert.equal(admitEdit(c, v2).outcome, 'admitted');
    admitEdit(c, editOf(head, '160', 'v3'));
    assert.equal(admitEdit(c, v2).outcome, 'already_admitted', 'a redelivery adds no row');
    assert.deepEqual(read(late(c, head, 0)), [{ turnJobId: editRowId(head, '160'), text: 'v3', edit: { previousText: 'v1' } }]);
    admitEdit(c, editOf(head, '170', 'v4'));
    assert.deepEqual(read(late(c, head, 1)), [{ turnJobId: editRowId(head, '170'), text: 'v4', edit: { previousText: 'v3' } }]);
    assert.deepEqual(late(c, head, 2, 'finish', false).messages, []);
    for (const saved of ['150', '160', '170']) {
      assert.equal(view(c.turns, editRowId(head, saved)).job!.fold?.received, true, `${saved} read once`);
    }
    c.turns.recordFlueSettlement(head.id, COMPLETED);
    c.slack.endTurn(head.id, c.turns, c.work, c.presentations);
    assert.deepEqual(['150', '160', '170'].map((saved) => view(c.turns, editRowId(head, saved)).status), ['done', 'done', 'done'],
      'each edit ends with the reply');
  } finally {
    c.db.close();
  }
});

test('an edit no claim takes runs as its own turn after the reply, and its start claim takes the later edits', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'v1' });
    admitCanonical(c, head);
    dispatch(c.turns, head);
    // The answer is already streaming: the gate is shut, so the would-stop call takes nothing.
    admitEdit(c, editOf(head, '150', 'v2'));
    admitEdit(c, editOf(head, '160', 'v3'));
    assert.deepEqual(late(c, head, 0, 'finish', false).messages, []);
    c.turns.recordFlueSettlement(head.id, COMPLETED);
    c.slack.endTurn(head.id, c.turns, c.work, c.presentations);

    const own = view(c.turns, editRowId(head, '150')).job!;
    assert.equal(turnJobGate(own), 'run', 'answered after the reply, never lost');
    const claim = c.turns.fold({ phase: 'start', headId: own.id });
    assert.equal(claim.headText, 'v3');
    assert.deepEqual(claim.messages, []);
    dispatch(c.turns, { ...posted('101'), id: own.id, turn: own.turn });
    c.turns.recordFlueSettlement(own.id, COMPLETED);
    c.slack.endTurn(own.id, c.turns, c.work, c.presentations);
    assert.equal(view(c.turns, editRowId(head, '160')).status, 'done', 'one reply answers both edits');
  } finally {
    c.db.close();
  }
});

test('past the cycle caps an edit waits for its own turn', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    enqueueAll(c, [head]);
    dispatch(c.turns, head);
    admitEdit(c, editOf(head, '150', 'v2'));
    assert.deepEqual(late(c, head, MAX_TURN_FOLD_CYCLES).messages, []);
    assert.deepEqual(late(c, head, MAX_TURN_FOLD_CYCLES + MAX_FOLD_CYCLES, 'finish').messages, []);
    assert.equal(view(c.turns, editRowId(head, '150')).job!.fold, undefined);
  } finally {
    c.db.close();
  }
});

test('a teammate\'s edit under the requester\'s own connections is information only, and runs with the teammate\'s turn', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    enqueueAll(c, [head]);
    dispatch(c.turns, head, 'personal');
    const teammate = posted('102', { userId: 'U_TEAMMATE', text: 'v1' });
    enqueueAll(c, [teammate]);
    assert.deepEqual(read(late(c, head, 0)), [{ turnJobId: teammate.id, text: 'v1', informationOnly: true }]);
    admitEdit(c, editOf(teammate, '150', 'v2'));
    const claim = late(c, head, 1);
    assert.deepEqual(read(claim), [{
      turnJobId: editRowId(teammate, '150'), text: 'v2', edit: { previousText: 'v1' }, informationOnly: true,
    }]);
    assert.equal(claim.requesterText, head.turn.text, 'a teammate\'s words never choose the requester\'s connections');
    late(c, head, 2, 'finish', false);
    c.turns.recordFlueSettlement(head.id, COMPLETED);
    c.slack.endTurn(head.id, c.turns, c.work, c.presentations);
    assert.equal(view(c.turns, editRowId(teammate, '150')).status, 'pending', 'never settled with the requester\'s reply');
    const own = c.turns.fold({ phase: 'start', headId: teammate.id });
    assert.equal(own.headText, 'v2', 'the teammate\'s own turn reads the newest text');
  } finally {
    c.db.close();
  }
});

test('a plan freeze that decides start roles again moves an edit row with its message', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    const teammate = posted('102', { userId: 'U_TEAMMATE', text: 'v1' });
    enqueueAll(c, [head, teammate]);
    admitEdit(c, editOf(teammate, '150', 'v2'));
    assert.deepEqual(read(c.turns.fold({ phase: 'start', headId: head.id })), [
      { turnJobId: teammate.id, text: 'v2', informationOnly: true },
    ]);
    freeze(c.turns, head, 'shared');
    assert.deepEqual([teammate.id, editRowId(teammate, '150')].map((id) => view(c.turns, id).job!.fold?.role),
      ['absorbed', 'absorbed']);
  } finally {
    c.db.close();
  }
});

// ── edits: identity and counts ────────────────────────────────────────

test('an edit running on its own reads through its edit, so the Agent\'s earlier reply is in reach', () => {
  const c = canonicalStore();
  try {
    const head = posted('101');
    enqueueAll(c, [head]);
    dispatch(c.turns, head);
    const plan = c.turns.getFrozenRuntimePlan(head.id)!;
    c.turns.pinAgentBinding({
      continuityKey: plan.runtimePlan.conversation.continuityKey, instanceId: plan.instanceId, uid: UID, updatedAt: NOW,
    });
    admitEdit(c, editOf(head, '150', 'v2'));
    c.turns.recordFlueSettlement(head.id, COMPLETED);
    c.slack.endTurn(head.id, c.turns, c.work, c.presentations);
    const edit = view(c.turns, editRowId(head, '150')).job!;
    assert.equal(c.turns.readThrough(edit.id), '1800000000.000150', 'not the message\'s own ts, before the reply');
    assert.equal(
      c.turns.getThreadContinuation(plan.runtimePlan.conversation.continuityKey, plan.instanceId, turnRequestTs(edit.turn))?.messageTs,
      head.turn.messageTs,
      'the edit continues the transcript of the turn that answered its message',
    );
    assert.equal(
      c.turns.getThreadContinuation(plan.runtimePlan.conversation.continuityKey, plan.instanceId, edit.turn.messageTs),
      undefined,
      'looked up by the message\'s ts, that turn is not found',
    );
  } finally {
    c.db.close();
  }
});

test('a stop drops a waiting edit with the held messages, and its note counts only messages', () => {
  const c = canonicalStore();
  try {
    const head = posted('101', { text: 'v1' });
    const member = posted('102');
    admitCanonical(c, head);
    admitCanonical(c, member);
    claimed(c.turns, head.id);
    dispatch(c.turns, head);
    // The answer is streaming: nothing takes the edit.
    admitEdit(c, editOf(head, '150', 'v2'));
    const stopped = c.turns.steer({
      kind: 'stop', threadKey: THREAD, source: 'typed', stopperUserId: 'U_PERSON', cutoffTs: '1800000000.000160',
    });
    assert.equal(stopped.outcome === 'stopped' && stopped.stop.held, 1, 'the edit is no held message');
    const finished = c.slack.finishTurnStop(head.id, 'dropped', c.turns, c.work, c.presentations)!;
    assert.deepEqual({ count: finished.count, read: finished.read }, { count: 1, read: 1 },
      'the stop note never asks the person to send an edit again');
    assert.equal(view(c.turns, editRowId(head, '150')).status, 'done', 'a stopped run\'s edit never runs');
    const editRun = finished.rows.find((row) => row.id === editRowId(head, '150'))?.runId;
    assert.ok(editRun);
    assert.equal(c.work.getRun(editRun as RunId)?.terminalDisposition, 'cancelled');
  } finally {
    c.db.close();
  }
});

// ── storage ────────────────────────────────────────────────────────────

test('a receipt written before 👍 existed decodes as it was, and a turn start owes its 👍', () => {
  const s = store();
  try {
    enqueueAll(s, [job('head', '101')]);
    const before = {
      channelId: 'C_FOLD', messageTs: '1800000000.000101', name: 'eyes', created: true, cleanup: 'pending',
      reaction: 'seen_mid_run',
    };
    s.db.run('UPDATE turn_jobs SET progress_json = ? WHERE id = ?',
      JSON.stringify({ slackInteraction: { acknowledgment: before } }), 'head');
    assert.deepEqual(receiptOf(s.turns, 'head'), before);
    claimed(s.turns, 'head');
    assert.deepEqual(receiptOf(s.turns, 'head'), { ...before, read: 'owed' });
    s.db.run('UPDATE turn_jobs SET progress_json = ? WHERE id = ?',
      JSON.stringify({ slackInteraction: { acknowledgment: { ...before, read: 'later' } } }), 'head');
    assert.equal(receiptOf(s.turns, 'head'), undefined, 'a receipt this release cannot read is none');
  } finally {
    s.db.close();
  }
});

test('rows written before the fold column existed decode with no fold record', () => {
  const db = openStateDb(':memory:');
  try {
    new TurnJobStoreLogic(db, () => NOW).enqueue(job('old', '101'));
    // An older release's table: no fold_json column at all.
    db.exec('ALTER TABLE turn_jobs DROP COLUMN fold_json');
    const reopened = new TurnJobStoreLogic(db, () => NOW);
    const old = reopened.runnerView('old').job!;
    assert.equal(old.fold, undefined);
    assert.equal(turnJobGate(old), 'run');
    const before = { schemaVersion: 1, role: 'absorbed', headId: 'gone', cycle: 0, received: true, at: NOW };
    db.run('UPDATE turn_jobs SET fold_json = ? WHERE id = ?', JSON.stringify(before), 'old');
    assert.deepEqual(reopened.runnerView('old').job!.fold, { ...before, role: 'released' }, 'a record from before C1 reads as it did');
    db.run('UPDATE turn_jobs SET fold_json = ? WHERE id = ?', '{"schemaVersion":2,"role":"absorbed"}', 'old');
    assert.equal(reopened.runnerView('old').job!.fold, undefined, 'a record this release cannot read is none');
  } finally {
    db.close();
  }
});
