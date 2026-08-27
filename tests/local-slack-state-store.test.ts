import assert from 'node:assert/strict';
import test from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import {
  SlackStateLogic,
  selectSlackPresentationOwner,
  slackSessionGenerationFromTimestamp,
} from '../src/slack/claim-store.ts';
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

test('canonical Slack admission creates V3 owner and activity state in the same transaction', () => {
  const db = openStateDb(':memory:');
  try {
    const slack = new SlackStateLogic(db, () => 1_800_000_000_000);
    const canonical = {
      binding: { id: 'binding_v3_admission', generation: 1 },
      run: { id: 'run_v3_admission', fencingToken: 0, executionAuthority: 'legacy' },
    };
    let presentationInput: unknown;
    const input = {
      evtKey: 'evt:v3-admission',
      msgKey: 'msg:v3-admission',
      threadKey: 'T_V3:D_V3:1785700000.000100',
      admission: { scope: 'captured by fake work store' },
      turnJob: {
        id: 'turn_v3_admission',
        runId: canonical.run.id,
        executionAuthority: canonical.run.executionAuthority,
      },
      presentation: {
        schemaVersion: 3 as const,
        root: {
          workspaceId: 'T_V3',
          channelId: 'D_V3',
          threadTs: '1785700000.000100',
          requesterUserId: 'U_V3',
        },
        owner: {
          kind: 'selected_agent' as const,
          persona: {
            name: 'Frozen Agent',
            avatarUrl: 'https://chickpea.example/assets/agents/frozen/avatar/4',
            avatarRevision: 4,
          },
        },
        sessionGeneration: 1785700000000100,
        currentActivity: {
          kind: 'preparing' as const,
          action: 'Preparing',
          object: 'your request',
          generation: 1785700000000100,
          sequence: 1,
          operation: { operationId: 'activity_run_v3_admission_1', certainty: 'pending' as const },
        },
        taskLabels: ['Prepare the answer'],
      },
    };

    const result = slack.admitCanonical(
      input as never,
      { admitShadowRunInTransaction: () => canonical } as never,
      { enqueue: () => true } as never,
      {
        createInTransaction(value: unknown) {
          presentationInput = structuredClone(value);
        },
      } as never,
    );

    assert.equal(result.claimed, true);
    assert.deepEqual(presentationInput, {
      runId: canonical.run.id,
      turnJobId: input.turnJob.id,
      bindingId: canonical.binding.id,
      workBindingGeneration: canonical.binding.generation,
      runFencingToken: canonical.run.fencingToken,
      ...input.presentation,
    });
  } finally {
    db.close();
  }
});

test('Slack admission derives a safe monotonic generation from the admitted message timestamp', () => {
  assert.equal(
    slackSessionGenerationFromTimestamp('1785700000.000100'),
    1785700000000100,
  );
  assert.ok(
    slackSessionGenerationFromTimestamp('1785700000.000101') >
      slackSessionGenerationFromTimestamp('1785700000.000100'),
  );
  assert.throws(() => slackSessionGenerationFromTimestamp('1785700000.1'));
  assert.throws(() => slackSessionGenerationFromTimestamp('99999999999.999999'));
});

test('Slack admission freezes selected ownership only from a healthy complete persona', () => {
  const complete = {
    installationHealth: 'healthy' as const,
    agentId: 'agent_support',
    agentName: 'Support',
    avatarUrl: 'https://chickpea.example/assets/agents/support/avatar/2',
    slackPresence: {
      desiredState: 'active' as const,
      health: 'healthy' as const,
      avatar: { revision: 2 },
    },
  };
  assert.deepEqual(selectSlackPresentationOwner(complete), {
    kind: 'selected_agent',
    persona: {
      name: 'Support',
      avatarUrl: complete.avatarUrl,
      avatarRevision: 2,
    },
  });
  assert.deepEqual(selectSlackPresentationOwner({
    ...complete,
    installationHealth: 'needs_attention',
  }), { kind: 'chickpea' });
  assert.deepEqual(selectSlackPresentationOwner({
    ...complete,
    slackPresence: { ...complete.slackPresence, health: 'pending' },
  }), { kind: 'chickpea' });
  const { avatarUrl: _avatarUrl, ...withoutAvatar } = complete;
  assert.deepEqual(selectSlackPresentationOwner(withoutAvatar), { kind: 'chickpea' });
  assert.deepEqual(selectSlackPresentationOwner({
    ...complete,
    agentId: 'agent_chickpea',
  }), { kind: 'chickpea' });
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
