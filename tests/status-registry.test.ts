import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SlackStatusUpdate } from '../src/slack/replies.ts';
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

test('setStatus on a closed turn resolves false without calling the presenter', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn(KEY, presenter, { generation: GENERATION_A });
  turn.close();

  assert.equal(await turn.setStatus({ text: 'is reading the thread' }), false);
  assert.deepEqual(presenter.statuses, []);
});

test('generic-liveness turns consume observed detail without replacing the native status', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn('generic-liveness-thread', presenter, {
    generation: GENERATION_A,
    allowObservedStatuses: false,
  });
  await turn.setStatus({ text: 'is thinking...' });
  assert.equal(
    setObservedSlackStatus(
      'generic-liveness-thread',
      GENERATION_A,
      { text: 'is searching the workspace' },
    ),
    true,
  );
  await turn.drain();
  assert.deepEqual(presenter.statuses, ['is thinking...']);
  turn.close();
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
