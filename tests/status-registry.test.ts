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

test('two same-thread turns: an earlier turn closing does not evict the later live turn', () => {
  const first = recordingPresenter();
  const second = recordingPresenter();

  const turnA = registerSlackStatusTurn(KEY, first);
  // A second mention in the same thread registers under the identical key.
  const turnB = registerSlackStatusTurn(KEY, second);

  // Turn A finishes first and closes; its close must NOT remove turn B's entry.
  turnA.close();

  // An observed tool_start for the thread must still route to the live turn B.
  setObservedSlackStatus(KEY, { text: 'is running mcp__search__query' });

  assert.deepEqual(second.statuses, ['is running mcp__search__query']);
  assert.deepEqual(first.statuses, []);

  turnB.close();
});

test('two concurrent open turns BOTH receive observed statuses (broadcast, not last-writer-wins)', () => {
  const first = recordingPresenter();
  const second = recordingPresenter();
  const turnA = registerSlackStatusTurn(KEY, first);
  const turnB = registerSlackStatusTurn(KEY, second);

  // Flue's tool events carry only the conversation key, so with two live turns
  // we cannot know whose tool fired — both presenters must get the update (the
  // right thread always included), instead of only the newest registration.
  setObservedSlackStatus(KEY, { text: 'is calling context7: query-docs' });

  assert.deepEqual(first.statuses, ['is calling context7: query-docs']);
  assert.deepEqual(second.statuses, ['is calling context7: query-docs']);

  turnA.close();
  turnB.close();
});

test('observed status after close is a no-op (no status lands after the turn ends)', () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn(KEY, presenter);

  turn.close();
  setObservedSlackStatus(KEY, { text: 'is running mcp__search__query' });

  assert.deepEqual(presenter.statuses, [], 'a closed turn must not accept further statuses');
});

test('setStatus on a closed turn resolves false without calling the presenter', async () => {
  const presenter = recordingPresenter();
  const turn = registerSlackStatusTurn(KEY, presenter);
  turn.close();

  assert.equal(await turn.setStatus({ text: 'is reading the thread' }), false);
  assert.deepEqual(presenter.statuses, []);
});
