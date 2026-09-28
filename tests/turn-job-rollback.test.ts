import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { parseRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { TurnJobStoreLogic, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import legacyFixture from './fixtures/runtime-plan/v0.1.26-attached-container.json' with { type: 'json' };

// After a rollback, rows a newer release wrote stay in the state store. One
// this release cannot read must not fail a sweep, which would stall every
// conversation until the next update. The newer plan is a real plan with a
// field this release does not know, the way v0.1.29 met v0.1.30's
// OpenRouter route.

const NOW = 1_950_000_000_000;
const NEWER_PLAN = {
  ...legacyFixture.slackTurnPlan,
  actorMembershipId: 'mem_rollback',
  voiceCapability: { available: true },
};
const THREAD_A = '1788000000.000100';
const THREAD_B = '1788000000.000200';
const THREAD_C = '1788000000.000300';
const threadKey = (job: PendingTurnJob) => job.turn.threadTs;

function fixture(t: TestContext) {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.join(' ')); });
  let now = NOW;
  let messages = 0;
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  const jobs = new TurnJobStoreLogic(db, () => now++);
  const enqueue = (id: string, threadTs: string, plan?: object) => {
    messages += 1;
    jobs.enqueue({ id, evtKey: `evt_${id}`, msgKey: `msg_${id}`, turn: turn(id, threadTs, messages), assignment: assignment() });
    if (plan) {
      db.run(
        'UPDATE turn_jobs SET runtime_plan_json = ?, agent_instance_id = ? WHERE id = ?',
        JSON.stringify(plan), `agent_${'c'.repeat(40)}`, id,
      );
    }
  };
  const status = (id: string) => ({ ...db.get('SELECT status, recovery_reason FROM turn_jobs WHERE id = ?', id) });
  return { db, jobs, enqueue, status, errors };
}

function turn(id: string, threadTs: string, message: number): NormalizedSlackTurn {
  return {
    workspaceId: 'T_ROLLBACK', channelId: 'C_ROLLBACK', eventId: `Ev_${id}`, text: 'Summarize the thread',
    userId: 'U_ROLLBACK', messageTs: `1788000001.${String(message).padStart(6, '0')}`, threadTs,
    source: 'app_mention', contextMode: 'thread',
  };
}

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_ROLLBACK', channelId: 'C_ROLLBACK', agentId: legacyFixture.agent.id,
    agent: legacyFixture.agent as ResolvedAssignment['agent'], model: legacyFixture.agent.model,
    ownerIncarnation: 1,
    modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 },
  };
}

const PARKED = { status: 'recovery_required', recovery_reason: 'stored_turn_unreadable' };

test('the newer plan is one this release rejects', () => {
  assert.throws(() => parseRuntimePlanV2(NEWER_PLAN), /unknown field voiceCapability/);
});

test('every turn sweep parks a row this release cannot read and keeps serving the rest', async (t) => {
  const sweeps: Record<string, (jobs: TurnJobStoreLogic) => PendingTurnJob[]> = {
    'Node alarm (listPending)': (jobs) => jobs.listPending(100),
    'Cloudflare alarm (listPendingByThread)': (jobs) =>
      jobs.listPendingByThread({ maxThreads: 10, perThread: 5, threadKey }),
    'runner hand-off (listDispatchable)': (jobs) => jobs.listDispatchable({ limit: 10, threadKey }),
    'hand-off re-admission (listHandoffs)': (jobs) => {
      jobs.assignRunner('newer');
      jobs.assignRunner('present');
      return jobs.listHandoffs(10);
    },
  };
  for (const [name, sweep] of Object.entries(sweeps)) {
    await t.test(name, (t) => {
      const f = fixture(t);
      // Oldest first, so every sweep meets it before the readable turn.
      f.enqueue('newer', THREAD_A, NEWER_PLAN);
      f.enqueue('present', THREAD_B);

      assert.deepEqual(sweep(f.jobs).map((job) => job.id), ['present']);
      assert.deepEqual(f.status('newer'), PARKED);
      assert.deepEqual(f.jobs.listRecoveryRequired().map(({ id, reason }) => ({ id, reason })), [
        { id: 'newer', reason: 'stored_turn_unreadable' },
      ]);
      assert.equal(f.jobs.runtimeDrainCounts().recoveryRequiredTurnJobs, 1);
      assert.deepEqual(f.errors, [
        '[chickpea] TurnJob requires operator reconciliation {"reason":"stored_turn_unreadable"}',
      ]);
      // Parked once: the next sweep no longer reads it.
      assert.deepEqual(sweep(f.jobs).map((job) => job.id), ['present']);
      assert.equal(f.errors.length, 1);
    });
  }
});

test('parking a row mid-scan never lists a later turn of a thread ahead of an earlier one', (t) => {
  const f = fixture(t);
  // The scan reads 100 rows a page: the unreadable row and 99 of thread B
  // fill the first, and thread C's two turns start the second.
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  for (let index = 0; index < 99; index += 1) f.enqueue(`b${index}`, THREAD_B);
  f.enqueue('c1', THREAD_C);
  f.enqueue('c2', THREAD_C);

  const heads = f.jobs.listPendingByThread({ maxThreads: 10, perThread: 1, threadKey });
  assert.deepEqual(heads.map((job) => job.id), ['b0', 'c1']);
  assert.deepEqual(f.status('newer'), PARKED);
});

test('a later turn in the same thread runs once the unreadable earlier one is parked', (t) => {
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  f.enqueue('next', THREAD_A);

  // The parked turn will never run on this release, so its thread moves on.
  const heads = f.jobs.listPendingByThread({ maxThreads: 10, perThread: 1, threadKey });
  assert.deepEqual(heads.map((job) => job.id), ['next']);
  assert.deepEqual(f.status('newer'), PARKED);
});

test('a stop notice owed by a row this release cannot read is dropped as the row is parked', (t) => {
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  f.db.run('UPDATE turn_jobs SET stop_notice_at = ? WHERE id = ?', NOW, 'newer');

  assert.deepEqual(f.jobs.listDueStopNotices(NOW + 60_000), []);
  assert.equal(f.jobs.nextStopNoticeDueAt(), undefined);
  assert.deepEqual(f.status('newer'), PARKED);
});

test('a row already held for recovery keeps its reason when a sweep finds it unreadable', (t) => {
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  f.jobs.markRecoveryRequired('newer', 'flue_receipt_conflict');
  // A held head's stop notice stays owed, so the notice sweep still reads it.
  f.db.run('UPDATE turn_jobs SET stop_notice_at = ? WHERE id = ?', NOW, 'newer');

  assert.deepEqual(f.jobs.listDueStopNotices(NOW + 60_000), []);
  assert.equal(f.jobs.nextStopNoticeDueAt(), undefined);
  assert.deepEqual(f.status('newer'), { status: 'recovery_required', recovery_reason: 'flue_receipt_conflict' });
  assert.deepEqual(f.errors, [
    '[chickpea] TurnJob requires operator reconciliation {"reason":"flue_receipt_conflict"}',
  ]);
});

test('a thread runner reading its own unreadable row parks it and sees it held for recovery', (t) => {
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  assert.equal(f.jobs.assignRunner('newer'), true);
  f.jobs.confirmRunner('newer');

  assert.deepEqual(f.jobs.runnerView('newer'), { status: 'recovery_required', executor: 'runner' });
  assert.deepEqual(f.status('newer'), PARKED);
  assert.deepEqual(f.jobs.runnerView('newer'), { status: 'recovery_required', executor: 'runner' });
  assert.equal(f.errors.length, 1);
});

test('a thread runner still repairs Slack cleanup on its delivered row a newer release wrote', (t) => {
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  assert.equal(f.jobs.assignRunner('newer'), true);
  f.jobs.confirmRunner('newer');
  const acknowledgment = {
    channelId: 'C_ROLLBACK', messageTs: '1788000001.000001', name: 'eyes', created: true, cleanup: 'pending' as const,
  };
  f.db.run(
    "UPDATE turn_jobs SET delivered = 1, status = 'done', progress_json = ? WHERE id = ?",
    JSON.stringify({ slackInteraction: { acknowledgment } }), 'newer',
  );

  const view = f.jobs.runnerView('newer');
  assert.equal(view.status, 'done');
  assert.equal(view.cleanupPending, true);
  assert.deepEqual(view.job?.progress.slackInteraction?.acknowledgment, acknowledgment);
});

test('an OAuth continuation resumes from an original turn a newer release wrote', (t) => {
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);

  assert.equal(f.jobs.resumeAfterOAuth('newer', 'continuation-1'), true);
  const [resumed] = f.jobs.listPending(100).filter((job) => job.id !== 'newer');
  assert.equal(resumed?.turn.threadTs, THREAD_A);
  assert.equal(resumed?.assignment.agentId, legacyFixture.agent.id);
});

test('a thread\'s previous plan this release cannot read is skipped instead of failing the next turn', (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  f.db.run(
    "UPDATE turn_jobs SET delivered = 1, status = 'done', dispatch_receipt_json = '{}' WHERE id = ?",
    'newer',
  );
  const { continuityKey } = NEWER_PLAN.conversation;
  f.jobs.pinAgentBinding({
    continuityKey, instanceId: `agent_${'c'.repeat(40)}`,
    uid: 'inst_00000000000000000000000009', updatedAt: NOW,
  });

  assert.equal(
    f.jobs.getBoundRuntimePlan(continuityKey, '1788000002.000000', 'mem_rollback', NEWER_PLAN.agentId),
    undefined,
  );
  assert.deepEqual(warnings, [
    ['[chickpea] a thread\'s previous runtime plan is unreadable; continuing without it'],
  ]);
});

test('a delivered row this release cannot fully read still gets its Slack cleanup', (t) => {
  const f = fixture(t);
  f.enqueue('newer', THREAD_A, NEWER_PLAN);
  const acknowledgment = {
    channelId: 'C_ROLLBACK', messageTs: '1788000001.000001', name: 'eyes', created: true, cleanup: 'pending' as const,
  };
  f.db.run(
    "UPDATE turn_jobs SET delivered = 1, status = 'done', progress_json = ? WHERE id = ?",
    JSON.stringify({ slackInteraction: { acknowledgment } }), 'newer',
  );

  const cleanups = f.jobs.listPendingSlackInteractionCleanups(10);
  assert.deepEqual(cleanups.map((job) => job.id), ['newer']);
  assert.deepEqual(cleanups[0]?.progress.slackInteraction?.acknowledgment, acknowledgment);
  f.jobs.recordSlackInteractionProgress('newer', { acknowledgment: { ...acknowledgment, cleanup: 'done' } });
  assert.deepEqual(f.jobs.listPendingSlackInteractionCleanups(10), []);
  assert.deepEqual(f.errors, []);
});
