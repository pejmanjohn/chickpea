import assert from 'node:assert/strict';
import test from 'node:test';

import { localSlackStateStore } from '../src/slack/local-state-store.ts';

test('local Slack admission injects every transactional state owner', async () => {
  const work = { owner: 'work' };
  const turnJobs = { owner: 'turn-jobs' };
  const presentations = { owner: 'presentations' };
  const admission = { evtKey: 'evt' };
  let received: unknown[] | undefined;
  const slack = {
    admitCanonical(...args: unknown[]) {
      received = args;
      return { claimed: false as const };
    },
  };

  const store = localSlackStateStore({
    slack: slack as never,
    work: work as never,
    turnJobs: turnJobs as never,
    presentations: presentations as never,
  });

  assert.deepEqual(await store.admitCanonical(admission as never), { claimed: false });
  assert.deepEqual(received, [admission, work, turnJobs, presentations]);
});

test('local Slack adapter exposes Promise-shaped turn-job delegation', async () => {
  const expected = { continuityKey: 'thread', agentId: 'sprout' };
  const turnJobs = {
    pinAgentBinding(binding: unknown, expectation: unknown) {
      assert.equal(binding, expected);
      assert.deepEqual(expectation, { instanceId: 'instance-1', uid: 'uid-1' });
      return expected;
    },
  };
  const store = localSlackStateStore({
    slack: {} as never,
    work: {} as never,
    turnJobs: turnJobs as never,
    presentations: {} as never,
  });

  const pending = store.pinAgentBinding(expected as never, {
    instanceId: 'instance-1',
    uid: 'uid-1',
  });
  assert.equal(typeof pending.then, 'function');
  assert.equal(await pending, expected);
});
