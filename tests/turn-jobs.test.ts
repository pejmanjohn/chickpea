import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TurnJob } from '../src/config/state-rpc.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import {
  MAX_TURN_ATTEMPTS,
  replayTextForTurnProgress,
  TURN_JOB_TTL_MS,
  TurnJobStoreLogic,
} from '../src/slack/turn-jobs.ts';

const AGENT: CustomAgentConfig = {
  id: 'agent_test',
  name: 'Test',
  instructions: 'do the thing',
  enabled: true,
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

function turn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1',
    channelId: 'C1',
    eventId: 'Ev1',
    text: 'hi',
    userId: 'U1',
    messageTs: '1000.0001',
    threadTs: '1000.0001',
    source: 'app_mention',
    contextMode: 'thread',
    ...overrides,
  };
}

function assignment(): ResolvedAssignment {
  return { workspaceId: 'T1', channelId: 'C1', agentId: 'agent_test', agent: AGENT, model: 'local-stub/x' };
}

function job(id: string): TurnJob {
  return { id, evtKey: `evt:${id}`, msgKey: id, turn: turn(), assignment: assignment() };
}

function newStore(now: () => number = Date.now) {
  const db = openStateDb(':memory:');
  return new TurnJobStoreLogic(db, now);
}

test('enqueue is idempotent by id and round-trips the job payload', () => {
  const store = newStore();
  assert.equal(store.enqueue(job('msg:C1:1')), true);
  // Duplicate enqueue (the app_mention + message fan-out) is ignored.
  assert.equal(store.enqueue(job('msg:C1:1')), false);

  const pending = store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, 'msg:C1:1');
  assert.equal(pending[0]?.evtKey, 'evt:msg:C1:1');
  assert.equal(pending[0]?.attempts, 0);
  assert.deepEqual(pending[0]?.progress, {});
  // Nested objects survive the JSON round-trip.
  assert.equal(pending[0]?.turn.channelId, 'C1');
  assert.equal(pending[0]?.assignment.agent.id, 'agent_test');
  assert.equal(pending[0]?.assignment.model, 'local-stub/x');
});

test('markDelivered and markError tombstone a job out of the pending scan', () => {
  const store = newStore();
  store.enqueue(job('a'));
  store.enqueue(job('b'));
  assert.equal(store.listPending().length, 2);

  store.markDelivered('a');
  store.markError('b');
  assert.deepEqual(store.listPending(), []);
});

test('recordAttempt advances the counter the alarm caps on', () => {
  const store = newStore();
  store.enqueue(job('a'));
  store.recordAttempt('a', 1);
  assert.equal(store.listPending()[0]?.attempts, 1);
  store.recordAttempt('a', MAX_TURN_ATTEMPTS);
  assert.equal(store.listPending()[0]?.attempts, MAX_TURN_ATTEMPTS);
});

test('recorded PR progress makes a retry replay instead of opening another PR', () => {
  const store = newStore();
  store.enqueue(job('msg:C1:1'));
  const recorded = store.recordPullRequest('msg:C1:1', {
    number: 42,
    url: 'https://github.com/Acme/Alpha/pull/42',
    repository: 'Acme/Alpha',
    branch: 'chickpea/fix-42',
  });
  // A duplicate response cannot replace the durable first marker.
  store.recordPullRequest('msg:C1:1', {
    number: 43,
    url: 'https://github.com/Acme/Alpha/pull/43',
    repository: 'Acme/Alpha',
  });

  const retry = store.listPending()[0];
  assert.deepEqual(retry?.progress, recorded);
  assert.equal(
    replayTextForTurnProgress(retry?.progress ?? {}),
    'Pull request #42 is already open: https://github.com/Acme/Alpha/pull/42',
  );

  let opened = 0;
  const replay = replayTextForTurnProgress(retry?.progress ?? {});
  if (replay === undefined) {
    opened += 1;
  }
  assert.equal(opened, 0, 'the second attempt must not execute the PR-opening path');
});

test('enqueue purges rows past the TTL horizon', () => {
  let clock = 1_000_000;
  const store = newStore(() => clock);
  store.enqueue(job('old'));
  assert.equal(store.listPending().length, 1);

  // Advance past the TTL and enqueue again: the purge on write drops the stale
  // row, leaving only the fresh one.
  clock += TURN_JOB_TTL_MS + 1;
  store.enqueue(job('fresh'));
  const ids = store.listPending().map((row) => row.id);
  assert.deepEqual(ids, ['fresh']);
});

test('pending jobs come back in enqueue order', () => {
  let clock = 1;
  const store = newStore(() => clock);
  store.enqueue(job('first'));
  clock += 5;
  store.enqueue(job('second'));
  clock += 5;
  store.enqueue(job('third'));
  assert.deepEqual(
    store.listPending().map((row) => row.id),
    ['first', 'second', 'third'],
  );
});

test('existing turn job tables gain progress storage without losing pending rows', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec(
      `CREATE TABLE turn_jobs (
        id TEXT PRIMARY KEY,
        evt_key TEXT NOT NULL,
        msg_key TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        assignment_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        enqueued_at INTEGER NOT NULL
      )`,
    );
    const legacy = job('before-migration');
    db.run(
      `INSERT INTO turn_jobs (
        id, evt_key, msg_key, turn_json, assignment_json, attempts, delivered, status, enqueued_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', ?)`,
      legacy.id,
      legacy.evtKey,
      legacy.msgKey,
      JSON.stringify(legacy.turn),
      JSON.stringify(legacy.assignment),
      Date.now(),
    );
    const store = new TurnJobStoreLogic(db);
    const pending = store.listPending();
    assert.equal(pending[0]?.id, 'before-migration');
    assert.deepEqual(pending[0]?.progress, {});
  } finally {
    db.close();
  }
});
