import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AlarmTurnBudgetYield,
  drainAlarmTurnJobs,
  type AlarmTurnJobControl,
} from '../src/slack/alarm-turn-drain.ts';

interface Job { id: string; thread: string }

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Resolves when observation is aborted, the way the bounded reader yields. */
function observeUntilAborted(control: AlarmTurnJobControl): Promise<boolean> {
  control.observing();
  return new Promise((resolve) => {
    control.signal.addEventListener('abort', () => resolve(false), { once: true });
  });
}

function baseOptions(pending: Job[]) {
  return {
    jobId: (job: Job) => job.id,
    threadKey: (job: Job) => job.thread,
    refresh: async () => [...pending],
    startConcurrency: 4,
    maxActiveThreads: 16,
    budgetMs: 60_000,
    hardCapMs: 120_000,
    recheckMs: 60_000,
  };
}

test('a message admitted mid-alarm starts at once while a long turn keeps observing', async () => {
  const pending: Job[] = [{ id: 'long', thread: 'a' }];
  const events: string[] = [];
  const longObserving = deferred();
  const releaseLong = deferred();
  let wake!: () => void;
  const drain = drainAlarmTurnJobs({
    ...baseOptions(pending),
    initial: [...pending],
    onWake: (callback) => { wake = callback; return () => {}; },
    runJob: async (job, control) => {
      events.push(`start:${job.id}`);
      if (job.id === 'long') {
        control.observing();
        longObserving.resolve();
        await releaseLong.promise;
        pending.splice(pending.findIndex((entry) => entry.id === 'long'), 1);
      }
      events.push(`done:${job.id}`);
      if (job.id === 'new') {
        pending.splice(pending.findIndex((entry) => entry.id === 'new'), 1);
        releaseLong.resolve();
      }
      return true;
    },
  });
  await longObserving.promise;
  // Admission writes the job, then arms the alarm, which wakes the drain.
  pending.push({ id: 'new', thread: 'b' });
  wake();
  const result = await drain;
  assert.deepEqual(events, ['start:long', 'start:new', 'done:new', 'done:long']);
  assert.equal(result.budgetExhausted, false);
});

test('without an in-object wake the fallback re-check still admits new work', async () => {
  const pending: Job[] = [{ id: 'long', thread: 'a' }];
  const started: string[] = [];
  const newStarted = deferred();
  await drainAlarmTurnJobs({
    ...baseOptions(pending),
    recheckMs: 5,
    initial: [...pending],
    runJob: async (job, control) => {
      started.push(job.id);
      if (job.id === 'long') {
        control.observing();
        pending.push({ id: 'new', thread: 'b' });
        await newStarted.promise;
        pending.splice(0, pending.length);
      } else {
        newStarted.resolve();
      }
      return true;
    },
  });
  assert.deepEqual(started, ['long', 'new']);
});

test('a thread never starts its next job while its current one runs, and resumes after', async () => {
  const pending: Job[] = [{ id: 'first', thread: 'a' }];
  const events: string[] = [];
  const firstObserving = deferred();
  const releaseFirst = deferred();
  let wake!: () => void;
  const drain = drainAlarmTurnJobs({
    ...baseOptions(pending),
    recheckMs: 5,
    initial: [...pending],
    onWake: (callback) => { wake = callback; return () => {}; },
    runJob: async (job, control) => {
      events.push(`start:${job.id}`);
      if (job.id === 'first') {
        control.observing();
        firstObserving.resolve();
        await releaseFirst.promise;
      }
      pending.splice(pending.findIndex((entry) => entry.id === job.id), 1);
      events.push(`done:${job.id}`);
      return true;
    },
  });
  await firstObserving.promise;
  pending.push({ id: 'second', thread: 'a' });
  wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['start:first'], 'the same thread waits behind its running job');
  releaseFirst.resolve();
  await drain;
  assert.deepEqual(events, ['start:first', 'done:first', 'start:second', 'done:second']);
});

test('a thread whose job stops it keeps its later jobs for a later alarm', async () => {
  const pending: Job[] = [{ id: 'first', thread: 'a' }, { id: 'second', thread: 'a' }];
  const started: string[] = [];
  await drainAlarmTurnJobs({
    ...baseOptions(pending),
    recheckMs: 1,
    initial: [...pending],
    runJob: async (job) => { started.push(job.id); return false; },
  });
  assert.deepEqual(started, ['first']);
});

test('the start limit counts only jobs that are not yet observing', async () => {
  const pending: Job[] = [{ id: 'long', thread: 'a' }];
  const started: string[] = [];
  const longObserving = deferred();
  const releaseLong = deferred();
  let wake!: () => void;
  const drain = drainAlarmTurnJobs({
    ...baseOptions(pending),
    startConcurrency: 1,
    initial: [...pending],
    onWake: (callback) => { wake = callback; return () => {}; },
    runJob: async (job, control) => {
      started.push(job.id);
      if (job.id === 'long') {
        control.observing();
        longObserving.resolve();
        await releaseLong.promise;
      } else {
        releaseLong.resolve();
      }
      pending.splice(pending.findIndex((entry) => entry.id === job.id), 1);
      return true;
    },
  });
  await longObserving.promise;
  pending.push({ id: 'new', thread: 'b' });
  wake();
  await drain;
  assert.deepEqual(started, ['long', 'new']);
});

test('the alarm budget yields every observing turn and reports a prompt re-arm', async () => {
  let clock = 0;
  const pending: Job[] = [{ id: 'a', thread: 'a' }, { id: 'b', thread: 'b' }];
  const reasons: unknown[] = [];
  let refreshes = 0;
  const result = await drainAlarmTurnJobs({
    ...baseOptions(pending),
    now: () => clock,
    budgetMs: 100,
    recheckMs: 1,
    refresh: async () => {
      refreshes += 1;
      clock += 40;
      return [...pending];
    },
    initial: [...pending],
    runJob: async (_job, control) => {
      const keepGoing = await observeUntilAborted(control);
      reasons.push(control.signal.reason);
      return keepGoing;
    },
  });
  assert.equal(result.budgetExhausted, true);
  assert.equal(reasons.length, 2);
  assert.ok(reasons.every((reason) => reason instanceof AlarmTurnBudgetYield));
  assert.ok(refreshes >= 2, 'the drain kept admitting until the cut work unwound');
});

test('a store failure yields in-flight observations and then surfaces', async () => {
  const pending: Job[] = [{ id: 'long', thread: 'a' }];
  let yielded = false;
  await assert.rejects(drainAlarmTurnJobs({
    ...baseOptions(pending),
    recheckMs: 1,
    refresh: async () => { throw new Error('store unavailable'); },
    initial: [...pending],
    runJob: async (_job, control) => {
      const keepGoing = await observeUntilAborted(control);
      yielded = true;
      return keepGoing;
    },
  }), /store unavailable/);
  assert.equal(yielded, true);
});

test('other due work runs on each re-check while a turn observes, never overlapping itself', async () => {
  const pending: Job[] = [{ id: 'long', thread: 'a' }];
  let ticks = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const seenRunning: string[][] = [];
  const releaseLong = deferred();
  await drainAlarmTurnJobs({
    ...baseOptions(pending),
    recheckMs: 1,
    initial: [...pending],
    tick: async (runningJobIds) => {
      ticks += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      seenRunning.push([...runningJobIds]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      if (ticks === 3) releaseLong.resolve();
    },
    runJob: async (_job, control) => {
      control.observing();
      await releaseLong.promise;
      pending.splice(0, pending.length);
      return true;
    },
  });
  assert.ok(ticks >= 3, 'receipts and schedule actions do not wait for the long turn');
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(seenRunning[0], ['long'], 'records owned by a running job are identifiable');
  assert.equal(concurrent, 0, 'the drain returns only after its last tick settled');
});

test('after the budget, new messages still start while a delivery ignores the abort, and the cap returns', async () => {
  const pending: Job[] = [{ id: 'delivering', thread: 'a' }];
  const started: string[] = [];
  const lateReasons: unknown[] = [];
  const releaseDelivery = deferred();
  const begin = Date.now();
  const result = await drainAlarmTurnJobs({
    ...baseOptions(pending),
    startedAt: begin,
    budgetMs: 30,
    hardCapMs: 150,
    recheckMs: 2,
    initial: [...pending],
    refresh: async () => {
      // A DM lands after the budget ended, while the upload is still going.
      if (Date.now() - begin > 40 && !pending.some((job) => job.id === 'dm')) {
        pending.push({ id: 'dm', thread: 'b' });
      }
      return [...pending];
    },
    runJob: async (job, control) => {
      started.push(job.id);
      if (job.id === 'delivering') {
        // Already past observation: a large upload does not react to aborts.
        await releaseDelivery.promise;
        return true;
      }
      control.observing();
      await new Promise((resolve) => control.signal.addEventListener('abort', resolve, { once: true }));
      lateReasons.push(control.signal.reason);
      return false;
    },
  });
  const elapsed = Date.now() - begin;
  assert.deepEqual(started, ['delivering', 'dm'], 'the DM was admitted during the post-budget wait');
  assert.equal(result.budgetExhausted, true);
  assert.deepEqual(result.carried.map((job) => [job.id, job.threadKey]), [['delivering', 'a']]);
  assert.ok(lateReasons[0] instanceof AlarmTurnBudgetYield, 'the late turn yields at the cap');
  assert.ok(elapsed < 1_000, `the drain returned at its cap (${elapsed} ms)`);
  releaseDelivery.resolve();
  await result.carried[0]!.settled;
});

test('a carried job keeps its thread closed until it settles', async () => {
  const pending: Job[] = [{ id: 'next', thread: 'a' }, { id: 'other', thread: 'b' }];
  const carriedThreads = new Set(['a']);
  const started: string[] = [];
  await drainAlarmTurnJobs({
    ...baseOptions(pending),
    recheckMs: 1,
    initial: [...pending],
    carried: { threadKeys: () => carriedThreads, jobIds: () => new Set(['earlier']) },
    runJob: async (job) => {
      started.push(job.id);
      pending.splice(pending.findIndex((entry) => entry.id === job.id), 1);
      return true;
    },
  });
  assert.deepEqual(started, ['other'], 'a delivery in flight is never started twice');
});

test('a slow inbox refresh cannot hold the budget or a thread successor', async () => {
  const pending: Job[] = [
    { id: 'first', thread: 'a' }, { id: 'second', thread: 'a' }, { id: 'long', thread: 'b' },
  ];
  const events: string[] = [];
  const begin = Date.now();
  const result = await drainAlarmTurnJobs({
    ...baseOptions(pending),
    startedAt: begin,
    budgetMs: 40,
    hardCapMs: 150,
    recheckMs: 2,
    initial: [...pending],
    // One inbox item waits on a gateway that never answers.
    refresh: () => new Promise<Job[]>(() => {}),
    runJob: async (job, control) => {
      events.push(`start:${job.id}`);
      if (job.id === 'first') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      }
      if (job.id === 'long') {
        control.observing();
        await new Promise((resolve) => control.signal.addEventListener('abort', resolve, { once: true }));
        events.push('yield:long');
        return false;
      }
      return true;
    },
  });
  const elapsed = Date.now() - begin;
  assert.ok(events.indexOf('start:second') > events.indexOf('start:first'),
    'a finished job starts its successor without waiting for the refresh');
  assert.ok(events.includes('yield:long'));
  assert.equal(result.budgetExhausted, true);
  assert.ok(elapsed < 1_000, `the hung refresh did not hold the alarm (${elapsed} ms)`);
});

test('the budget counts from the alarm start, not the drain start', async () => {
  const pending: Job[] = [{ id: 'long', thread: 'a' }];
  let reason: unknown;
  const result = await drainAlarmTurnJobs({
    ...baseOptions(pending),
    // The alarm already spent its budget draining the inbox before this.
    startedAt: Date.now() - 1_000,
    budgetMs: 500,
    hardCapMs: 2_000,
    recheckMs: 2,
    initial: [...pending],
    runJob: async (_job, control) => {
      control.observing();
      if (!control.signal.aborted) {
        await new Promise((resolve) => control.signal.addEventListener('abort', resolve, { once: true }));
      }
      reason = control.signal.reason;
      return false;
    },
  });
  assert.equal(result.budgetExhausted, true);
  assert.ok(reason instanceof AlarmTurnBudgetYield);
});

test('a refresh that admits after the last job finishes is awaited, never orphaned', async () => {
  // Round-2 review repro: the refresh fired as the last job ends lists a new
  // job (a fifth queued follow-up, or a message landing just then).
  const events: string[] = [];
  let refreshes = 0;
  const result = await drainAlarmTurnJobs<Job>({
    ...baseOptions([]),
    recheckMs: 2_000,
    initial: [{ id: 'a', thread: 'T1' }],
    refresh: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return refreshes === 1 ? [{ id: 'b', thread: 'T2' }] : [];
    },
    tick: async () => {},
    runJob: async (job) => {
      events.push(`start:${job.id}`);
      if (job.id === 'a') {
        // Let the loop start a refresh while this job still runs.
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      events.push(`end:${job.id}`);
      return true;
    },
    onWake: (wake) => {
      // Admission lands right away, so a refresh is in flight when `a` ends.
      queueMicrotask(wake);
      return () => {};
    },
  });
  events.push('returned');
  assert.equal(result.carried.length, 0);
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b', 'returned'],
    'the job the late refresh started finished before the drain returned');
});

test('nothing starts once the drain has decided to return', async () => {
  let started = 0;
  let resolveRefresh!: (jobs: Job[]) => void;
  const result = await drainAlarmTurnJobs<Job>({
    ...baseOptions([]),
    startedAt: Date.now(),
    budgetMs: 10,
    hardCapMs: 40,
    recheckMs: 1,
    initial: [{ id: 'a', thread: 'T1' }],
    // This refresh only answers after the cap.
    refresh: () => new Promise<Job[]>((resolve) => { resolveRefresh = resolve; }),
    runJob: async (job, control) => {
      started += 1;
      if (job.id === 'a') {
        control.observing();
        await new Promise((resolve) => control.signal.addEventListener('abort', resolve, { once: true }));
        return false;
      }
      return true;
    },
  });
  resolveRefresh([{ id: 'late', thread: 'T2' }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 1, 'a refresh answering after the return starts nothing');
  assert.equal(result.carried.length, 0);
});
