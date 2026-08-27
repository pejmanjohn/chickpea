import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SlackStatusUpdate } from '../src/slack/replies.ts';
import { THREAD_TTL_MS } from '../src/slack/state-limits.ts';
import {
  registerSlackStatusTurn,
  setObservedSlackStatus,
} from '../src/slack/status-registry.ts';

function recordingPresenter() {
  const statuses: string[] = [];
  return {
    statuses,
    setStatus(update: SlackStatusUpdate): Promise<boolean> {
      statuses.push(update.text);
      return Promise.resolve(true);
    },
  };
}

const KEY = 'T_WS:C_CHAN:1782770400.000100';
const GENERATION_A = 'turn-a';
const GENERATION_B = 'turn-b';

test('two same-thread turns: an earlier turn closing does not evict the later live turn', async () => {
  const first = recordingPresenter();
  const second = recordingPresenter();

  const turnA = registerSlackStatusTurn(KEY, first, { generation: GENERATION_A });
  // A second mention in the same thread registers under the identical key.
  const turnB = registerSlackStatusTurn(KEY, second, { generation: GENERATION_B });

  // Turn A finishes first and closes; its close must NOT remove turn B's entry.
  turnA.close();

  // An observed tool_start for the thread must still route to the live turn B.
  setObservedSlackStatus(KEY, GENERATION_B, { text: 'is running mcp__search__query' });
  await turnB.drain();

  assert.deepEqual(second.statuses, ['is running mcp__search__query']);
  assert.deepEqual(first.statuses, []);

  turnB.close();
});

test('an earlier same-thread turn finishing does not clear the later turn status', () => {
  const first = recordingPresenter();
  const second = recordingPresenter();
  const turnA = registerSlackStatusTurn(KEY, first, { generation: GENERATION_A });
  const turnB = registerSlackStatusTurn(KEY, second, { generation: GENERATION_B });
  let firstClearCount = 0;
  let secondClearCount = 0;

  turnA.finish(async () => {
    firstClearCount += 1;
  });
  assert.equal(firstClearCount, 0);

  turnB.finish(async () => {
    secondClearCount += 1;
  });
  assert.equal(secondClearCount, 1);
});

test('two concurrent open turns route observations by generation', async () => {
  const first = recordingPresenter();
  const second = recordingPresenter();
  const turnA = registerSlackStatusTurn(KEY, first, { generation: GENERATION_A });
  const turnB = registerSlackStatusTurn(KEY, second, { generation: GENERATION_B });

  assert.equal(
    setObservedSlackStatus(KEY, GENERATION_A, { text: 'is calling context7: query-docs' }),
    true,
  );
  assert.equal(
    setObservedSlackStatus(KEY, GENERATION_B, { text: 'is running mcp__search__query' }),
    true,
  );
  await Promise.all([turnA.drain(), turnB.drain()]);

  assert.deepEqual(first.statuses, ['is calling context7: query-docs']);
  assert.deepEqual(second.statuses, ['is running mcp__search__query']);
  turnA.close();
  turnB.close();
});

test('observed status after close is a no-op (no status lands after the turn ends)', () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn(KEY, presenter, { generation: GENERATION_A });

  turn.close();
  setObservedSlackStatus(KEY, GENERATION_A, { text: 'is running mcp__search__query' });

  assert.deepEqual(presenter.statuses, [], 'a closed turn must not accept further statuses');
});

test('a still-current phase refreshes and final preparation cancels the refresh', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn('refresh-thread', presenter, {
    generation: 'refresh-generation',
    observedMinIntervalMs: 1,
    refreshIntervalMs: 20,
  });

  assert.equal(await turn.setStatus({ text: 'Checking Gmail…' }), true);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(presenter.statuses.length >= 2);
  assert.ok(presenter.statuses.every((status) => status === 'Checking Gmail…'));

  await turn.prepareFinal();
  const settledCount = presenter.statuses.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(presenter.statuses.length, settledCount);
  await turn.finish(async () => {});
});

test('a superseded phase never refreshes after the newer fact is applied', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn('refresh-superseded-thread', presenter, {
    generation: 'refresh-superseded-generation',
    observedMinIntervalMs: 1,
    refreshIntervalMs: 30,
  });

  await turn.setStatus({ text: 'Thinking…' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await turn.setStatus({ text: 'Checking Gmail…' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(presenter.statuses, ['Thinking…', 'Checking Gmail…']);
  turn.close();
});

test('a delayed observation from turn A cannot land after turn B registers', async () => {
  const first = recordingPresenter();
  const second = recordingPresenter();
  const turnA = registerSlackStatusTurn(KEY, first, { generation: GENERATION_A });

  turnA.close();
  const turnB = registerSlackStatusTurn(KEY, second, { generation: GENERATION_B });

  assert.equal(
    setObservedSlackStatus(KEY, GENERATION_A, { text: 'is cloning the old repository' }),
    true,
  );
  await turnB.drain();
  assert.deepEqual(second.statuses, []);

  assert.equal(
    setObservedSlackStatus(KEY, GENERATION_B, { text: 'is inspecting the new workspace' }),
    true,
  );
  await turnB.drain();
  assert.deepEqual(second.statuses, ['is inspecting the new workspace']);
  turnB.close();
});

test('a delayed old-generation write cannot land after or clear the newer owner', async () => {
  const oldWrite = Promise.withResolvers<boolean>();
  const calls: string[] = [];
  const turnA = registerSlackStatusTurn('generation-fenced-thread', {
    setStatus(update: SlackStatusUpdate): Promise<boolean> {
      calls.push(`old:${update.text}`);
      return oldWrite.promise;
    },
  }, { generation: GENERATION_A, sessionGeneration: 1785700000000100 });

  const oldStatus = turnA.setStatus({ text: 'is writing the old answer' });
  const turnB = registerSlackStatusTurn('generation-fenced-thread', {
    setStatus(update: SlackStatusUpdate): Promise<boolean> {
      calls.push(`new:${update.text}`);
      return Promise.resolve(true);
    },
  }, { generation: GENERATION_B, sessionGeneration: 1785700000000200 });

  const newStatus = turnB.setStatus({ text: 'is writing the new answer' });
  assert.equal(
    await turnA.setStatus({ text: 'is replaying stale work' }),
    false,
    'the prior generation must be fenced as soon as the newer executor registers',
  );
  assert.deepEqual(calls, ['old:is writing the old answer']);

  let oldClearCount = 0;
  await turnA.finish(async () => { oldClearCount += 1; });
  assert.equal(oldClearCount, 0, 'the older generation cannot clear the newer owner');

  oldWrite.resolve(true);
  assert.equal(await oldStatus, true);
  assert.equal(await newStatus, true);
  assert.deepEqual(calls, [
    'old:is writing the old answer',
    'new:is writing the new answer',
  ]);

  let newClearCount = 0;
  await turnB.finish(async () => { newClearCount += 1; });
  assert.equal(newClearCount, 1);
});

test('a queued older generation stays silent when the newer executor already owns the thread', async () => {
  const current = recordingPresenter();
  const queued = recordingPresenter();
  const active = registerSlackStatusTurn('queued-generation-thread', current, {
    generation: GENERATION_B,
    sessionGeneration: 1785700000000200,
  });
  const older = registerSlackStatusTurn('queued-generation-thread', queued, {
    generation: GENERATION_A,
    sessionGeneration: 1785700000000100,
  });

  assert.equal(await older.setStatus({ text: 'is preparing queued work' }), false);
  assert.equal(await active.setStatus({ text: 'is running active work' }), true);
  assert.deepEqual(queued.statuses, []);
  assert.deepEqual(current.statuses, ['is running active work']);
  older.close();
  active.close();
});

test('thread ownership fences an older Agent instance after a handoff', async () => {
  const ownershipKey = 'T_HANDOFF:C_HANDOFF:1785700000.000100';
  const priorAgent = recordingPresenter();
  const nextAgent = recordingPresenter();
  const prior = registerSlackStatusTurn('agent-instance-prior', priorAgent, {
    generation: GENERATION_A,
    sessionGeneration: 1785700000000100,
    ownershipKey,
  });
  const next = registerSlackStatusTurn('agent-instance-next', nextAgent, {
    generation: GENERATION_B,
    sessionGeneration: 1785700000000200,
    ownershipKey,
  });

  assert.equal(await prior.setStatus({ text: 'is writing stale handoff work' }), false);
  assert.equal(await next.setStatus({ text: 'is writing current handoff work' }), true);
  assert.deepEqual(priorAgent.statuses, []);
  assert.deepEqual(nextAgent.statuses, ['is writing current handoff work']);
  prior.close();
  next.close();
});

test('a completed newer generation keeps a later stale registration silent', async () => {
  const ownershipKey = 'T_HISTORY:C_HISTORY:1785700000.000100';
  let now = 1_800_000_000_000;
  const currentPresenter = recordingPresenter();
  const current = registerSlackStatusTurn('history-instance-current', currentPresenter, {
    generation: GENERATION_B,
    sessionGeneration: 1785700000000200,
    ownershipKey,
    now: () => now,
  });
  assert.equal(await current.setStatus({ text: 'is handling the current request' }), true);
  current.close();

  now += THREAD_TTL_MS;
  const stalePresenter = recordingPresenter();
  const stale = registerSlackStatusTurn('history-instance-stale', stalePresenter, {
    generation: GENERATION_A,
    sessionGeneration: 1785700000000100,
    ownershipKey,
    now: () => now,
  });
  assert.equal(await stale.setStatus({ text: 'is replaying an older request' }), false);
  assert.deepEqual(stalePresenter.statuses, []);
  stale.close();
});

test('an inactive generation fence expires after durable thread retention', async () => {
  const ownershipKey = 'T_EXPIRED_HISTORY:C_EXPIRED_HISTORY:1785700000.000100';
  let now = 1_800_000_000_000;
  const current = registerSlackStatusTurn('expired-history-current', recordingPresenter(), {
    generation: GENERATION_B,
    sessionGeneration: 1785700000000200,
    ownershipKey,
    now: () => now,
  });
  current.close();

  now += THREAD_TTL_MS + 1;
  const resumedPresenter = recordingPresenter();
  const resumed = registerSlackStatusTurn('expired-history-resumed', resumedPresenter, {
    generation: GENERATION_A,
    sessionGeneration: 1785700000000100,
    ownershipKey,
    now: () => now,
  });

  assert.equal(await resumed.setStatus({ text: 'is handling retained-history expiry' }), true);
  assert.deepEqual(resumedPresenter.statuses, ['is handling retained-history expiry']);
  resumed.close();
});

test('an active generation fence is not pruned after durable thread retention', async () => {
  const ownershipKey = 'T_ACTIVE_HISTORY:C_ACTIVE_HISTORY:1785700000.000100';
  let now = 1_800_000_000_000;
  const current = registerSlackStatusTurn('active-history-current', recordingPresenter(), {
    generation: GENERATION_B,
    sessionGeneration: 1785700000000200,
    ownershipKey,
    now: () => now,
  });

  now += THREAD_TTL_MS + 1;
  const stalePresenter = recordingPresenter();
  const stale = registerSlackStatusTurn('active-history-stale', stalePresenter, {
    generation: GENERATION_A,
    sessionGeneration: 1785700000000100,
    ownershipKey,
    now: () => now,
  });

  assert.equal(await stale.setStatus({ text: 'is replaying while the owner is active' }), false);
  assert.deepEqual(stalePresenter.statuses, []);
  stale.close();
  current.close();
});

test('the same persisted generation may resume after its prior owner closes', async () => {
  const ownershipKey = 'T_RETRY:C_RETRY:1785700000.000100';
  const firstPresenter = recordingPresenter();
  const first = registerSlackStatusTurn('retry-instance', firstPresenter, {
    generation: GENERATION_A,
    sessionGeneration: 1785700000000100,
    ownershipKey,
  });
  assert.equal(await first.setStatus({ text: 'is preparing the durable answer' }), true);
  first.close();

  const retryPresenter = recordingPresenter();
  const retry = registerSlackStatusTurn('retry-instance', retryPresenter, {
    generation: GENERATION_A,
    sessionGeneration: 1785700000000100,
    ownershipKey,
  });
  assert.equal(await retry.setStatus({ text: 'is resuming the durable answer' }), true);
  assert.deepEqual(retryPresenter.statuses, ['is resuming the durable answer']);
  retry.close();
});

test('setStatus on a closed turn resolves false without calling the presenter', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn(KEY, presenter, { generation: GENERATION_A });
  turn.close();

  assert.equal(await turn.setStatus({ text: 'is reading the thread' }), false);
  assert.deepEqual(presenter.statuses, []);
});

test('rapid distinct updates coalesce to the newest status behind an in-flight write', async () => {
  const calls: string[] = [];
  const firstWrite = Promise.withResolvers<boolean>();
  const turn = registerSlackStatusTurn('serialized-thread', {
    setStatus(update: SlackStatusUpdate): Promise<boolean> {
      calls.push(update.text);
      return calls.length === 1 ? firstWrite.promise : Promise.resolve(true);
    },
  }, { generation: GENERATION_A });

  const first = turn.setStatus({ text: 'is thinking through the request' });
  const stale = turn.setStatus({ text: 'is loading a skill' });
  const newest = turn.setStatus({ text: 'is using Cloudflare Docs' });
  await Promise.resolve();
  assert.deepEqual(calls, ['is thinking through the request']);
  assert.equal(await stale, false, 'a superseded status is never replayed');

  firstWrite.resolve(true);
  assert.equal(await first, true);
  assert.equal(await newest, true);
  await turn.drain();
  assert.deepEqual(calls, [
    'is thinking through the request',
    'is using Cloudflare Docs',
  ]);
  turn.close();
});

test('observed statuses are rate-bounded and preserve the newest pending detail', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn('rate-bounded-thread', presenter, {
    generation: GENERATION_A,
    observedMinIntervalMs: 25,
  });

  await turn.setStatus({ text: 'is using a model' });
  setObservedSlackStatus('rate-bounded-thread', GENERATION_A, { text: 'is loading a skill' });
  await Promise.resolve();
  setObservedSlackStatus('rate-bounded-thread', GENERATION_A, { text: 'is using Cloudflare Docs' });
  setObservedSlackStatus('rate-bounded-thread', GENERATION_A, { text: 'is running the test suite' });

  assert.deepEqual(presenter.statuses, ['is using a model', 'is loading a skill']);
  await new Promise((resolve) => setTimeout(resolve, 35));
  await turn.drain();
  assert.deepEqual(presenter.statuses, [
    'is using a model',
    'is loading a skill',
    'is running the test suite',
  ]);
  turn.close();
});

test('close fences late observed work and drain waits only for the active write', async () => {
  const calls: string[] = [];
  const activeWrite = Promise.withResolvers<boolean>();
  const turn = registerSlackStatusTurn('close-fence-thread', {
    setStatus(update: SlackStatusUpdate): Promise<boolean> {
      calls.push(update.text);
      return activeWrite.promise;
    },
  }, { generation: GENERATION_A });

  const active = turn.setStatus({ text: 'is thinking through the request' });
  const pending = setObservedSlackStatus('close-fence-thread', GENERATION_A, {
    text: 'is using Cloudflare Docs',
  });
  assert.equal(pending, true);
  turn.close();

  activeWrite.resolve(true);
  assert.equal(await active, true);
  await turn.drain();
  assert.deepEqual(calls, ['is thinking through the request']);
});

test('finish does not trap final delivery and clears again after a late status settles', async () => {
  const calls: string[] = [];
  const activeWrite = Promise.withResolvers<boolean>();
  const lateClear = Promise.withResolvers<void>();
  let clearCount = 0;
  const turn = registerSlackStatusTurn('non-blocking-final-thread', {
    setStatus(update: SlackStatusUpdate): Promise<boolean> {
      calls.push(`status:${update.text}`);
      return activeWrite.promise;
    },
  }, { generation: GENERATION_A });

  const active = turn.setStatus({ text: 'is using Cloudflare Docs' });
  await turn.prepareFinal();
  turn.finish(async () => {
    clearCount += 1;
    calls.push(`clear:${clearCount}`);
    if (clearCount === 2) lateClear.resolve();
  });
  calls.push('final');

  assert.deepEqual(calls, [
    'status:is using Cloudflare Docs',
    'clear:1',
    'final',
  ]);

  activeWrite.resolve(true);
  assert.equal(await active, true);
  await lateClear.promise;
  assert.deepEqual(calls, [
    'status:is using Cloudflare Docs',
    'clear:1',
    'final',
    'clear:2',
  ]);
  assert.equal(
    setObservedSlackStatus('non-blocking-final-thread', GENERATION_A, {
      text: 'is running the old test suite',
    }),
    false,
    'finish must retain the close fence for late observations',
  );
});

test('consecutive identical statuses share one Slack write', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn('deduplicated-thread', presenter, {
    generation: GENERATION_A,
  });

  const first = turn.setStatus({ text: 'is thinking through the request' });
  const duplicate = turn.setStatus({ text: 'is thinking through the request' });

  assert.equal(duplicate, first);
  assert.equal(await first, true);
  assert.equal(await turn.setStatus({ text: 'is thinking through the request' }), true);
  await turn.drain();
  assert.deepEqual(presenter.statuses, ['is thinking through the request']);
  turn.close();
});

test('a rejected status write can retry the same text', async () => {
  let calls = 0;
  const turn = registerSlackStatusTurn('retry-thread', {
    setStatus(): Promise<boolean> {
      calls += 1;
      return Promise.resolve(calls > 1);
    },
  }, { generation: GENERATION_A });

  assert.equal(await turn.setStatus({ text: 'is using a connection' }), false);
  assert.equal(await turn.setStatus({ text: 'is using a connection' }), true);
  assert.equal(calls, 2);
  turn.close();
});
