import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  foldableTurn,
  foldedRequestText,
  MAX_FOLDED_MESSAGES,
  MAX_FOLDED_TEXT_CHARS,
} from '../src/slack/follow-ups.ts';
import type { FlueSettlementCheckpointV1, TurnJob } from '../src/slack/turn-job-types.ts';
import {
  isTurnJobStopRefusal,
  TurnJobStoreLogic,
  turnJobGate,
} from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SlackStateLogic, slackSessionGenerationFromTimestamp } from '../src/slack/claim-store.ts';
import { localSlackStateStore } from '../src/slack/local-state-store.ts';
import { SlackRunPresentationStoreLogic, type SlackRunPresentationV3 } from '../src/slack/run-presentations.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
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

function dispatch(turns: TurnJobStoreLogic, queued: TurnJob): void {
  turns.freezeRuntimePlan(queued.id, compileRuntimePlanV2({
    turn: queued.turn, assignment: queued.assignment, instructions: 'Help.', memoryEpoch: 1,
  }));
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

test('the run of follow-ups ends at another person\'s message, a command, or a message with files', () => {
  for (const [label, breaker] of [
    ['another person', { userId: 'U_OTHER' }],
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
    assert.equal(foldedRequestText('head', [{ text: long }, { text: 'more text' }]).length, MAX_FOLDED_TEXT_CHARS);
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
      receipt: { channelId: 'C_FOLD', messageTs: '1800000000.000102', name: 'eyes' },
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

test('a late fold needs the head\'s own dispatched instance and stops after three cycles', () => {
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
    assert.deepEqual(
      s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 3, take: true }).messages,
      [],
      'past the cycle cap',
    );
    assert.throws(() => s.turns.fold({ phase: 'finish', headId: 'head', instanceId, received: 4, take: true }));
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
function admitCanonical(c: CanonicalStore, queued: TurnJob): RunId {
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
      owner: { kind: 'chickpea' },
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

// ── storage ────────────────────────────────────────────────────────────

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
    db.run('UPDATE turn_jobs SET fold_json = ? WHERE id = ?', '{"schemaVersion":2,"role":"absorbed"}', 'old');
    assert.equal(reopened.runnerView('old').job!.fold, undefined, 'a record this release cannot read is none');
  } finally {
    db.close();
  }
});
