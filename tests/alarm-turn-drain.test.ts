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
  assert.ok(refreshes >= 2 && refreshes <= 3, 'admission stops at the budget');
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
