import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { activityStatus, type TypedActivityStatus } from '../src/activity/status.ts';
import { SlackAgentViewPresentation } from '../src/slack/agent-view-presentation.ts';
import { localSlackPresentationStatePort } from '../src/slack/presentation-state-port.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import {
  SlackStatusRegistry,
  setObservedSlackStatus,
} from '../src/slack/status-registry.ts';
import { relayObservedStatus } from '../src/slack/status-relay.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const ROOT = {
  workspaceId: 'T_PORTS',
  channelId: 'C_PORTS',
  threadTs: '1785900100.000100',
  requesterUserId: 'U_PORTS',
};

test('status registries are isolated: an observed status reaches only the turn in its own registry', async () => {
  const first = new SlackStatusRegistry();
  const second = new SlackStatusRegistry();
  const writes: string[] = [];
  const presenter = (name: string) => ({
    setStatus: async (update: { text: string }) => {
      writes.push(`${name}:${update.text}`);
      return true;
    },
  });
  // Two runners present the same conversation key with the same generation.
  const firstTurn = first.registerTurn('thread-a', presenter('first'), {
    generation: 'generation-1',
    observedMinIntervalMs: 0,
  });
  const secondTurn = second.registerTurn('thread-a', presenter('second'), {
    generation: 'generation-1',
    observedMinIntervalMs: 0,
  });
  const reading = activityStatus('reading', 'Reviewing', 'the plan', 'unknown', 'reviewing');

  assert.equal(first.setObservedStatus('thread-a', 'generation-1', reading), true);
  await firstTurn.drain();
  await secondTurn.drain();
  assert.deepEqual(writes, [`first:${reading.text}`]);

  assert.equal(second.setObservedStatus('thread-b', 'generation-1', reading), false,
    'a miss lets the caller relay elsewhere');
  assert.equal(setObservedSlackStatus('thread-a', 'generation-1', reading), false,
    'the default registry holds neither turn');

  firstTurn.close();
  assert.equal(first.setObservedStatus('thread-a', 'generation-1', reading), false);
  assert.equal(second.setObservedStatus('thread-a', 'generation-1', reading), true,
    'closing a turn in one registry leaves the other registered');
  await secondTurn.drain();
  secondTurn.close();
});

test('presentation logic runs on an injected in-memory database through the local port', async () => {
  const db = openStateDb(':memory:');
  const other = openStateDb(':memory:');
  try {
    const presentations = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    const untouched = new SlackRunPresentationStoreLogic(other);
    const runId = 'run_ports';
    presentations.create({
      schemaVersion: 3,
      runId,
      turnJobId: `turn_${runId}`,
      bindingId: 'binding_ports',
      workBindingGeneration: 1,
      runFencingToken: 0,
      root: ROOT,
      owner: {
        kind: 'selected_agent',
        persona: { name: 'Ports Agent', avatarUrl: 'https://chickpea.example/a.png', avatarRevision: 1 },
      },
      sessionGeneration: 1,
    });
    const matched: string[] = [];
    const state = localSlackPresentationStatePort({
      presentations,
      matchFlueObservation: (instanceId) => {
        matched.push(instanceId);
        return undefined;
      },
    });
    const calls: string[] = [];
    const client = {
      chat: {
        async startStream() {
          calls.push('startStream');
          return { ok: true, ts: '1785900100.000200' };
        },
        async stopStream() {
          calls.push('stopStream');
          return { ok: true };
        },
      },
    } as unknown as WebClient;
    const presentation = new SlackAgentViewPresentation({
      client,
      state,
      runId,
      runFencingToken: 0,
      footer: { agentName: 'Ports Agent', agentId: 'agent_ports' },
      now: () => 1_800_000_000_000,
      onFinalized: () => undefined,
    });
    const result = await presentation.finalize(
      'Done.',
      'markdown',
      'complete',
      { async before() { return 'attempt'; }, async after() {} },
    );
    assert.equal(result.handled, true);
    assert.deepEqual(calls, ['startStream', 'stopStream']);
    const stored = presentations.get(runId);
    assert.equal(stored?.stream.state, 'artifact_delivered');
    assert.equal(stored?.stream.messageTs, '1785900100.000200');
    assert.equal(untouched.get(runId), undefined, 'only the injected database holds the run');
    assert.equal(await state.matchFlueObservation('instance_ports'), undefined);
    assert.deepEqual(matched, ['instance_ports']);
  } finally {
    db.close();
    other.close();
  }
});

test('an observed status relays to the target the resolver names', async () => {
  const prototype = Object.getPrototypeOf(globalThis.navigator) as object;
  const original = Object.getOwnPropertyDescriptor(prototype, 'userAgent');
  Object.defineProperty(prototype, 'userAgent', {
    configurable: true,
    enumerable: true,
    value: 'Cloudflare-Workers',
  });
  try {
    const relayed: Array<[string, string, string]> = [];
    const env = { THREAD_RUNNER: 'binding' };
    const status = activityStatus('reading', 'Reviewing', 'the plan', 'unknown', 'reviewing');
    await relayObservedStatus('instance_relay', 'submission_relay', status, env, (
      targetEnv,
      instanceId,
      submissionId,
    ) => {
      assert.equal(targetEnv, env);
      return {
        async observedStatus(id: string, submission: string, relayedStatus: TypedActivityStatus) {
          relayed.push([`${instanceId}/${submissionId}`, `${id}/${submission}`, relayedStatus.text]);
          return { ok: true, value: null };
        },
      };
    });
    assert.deepEqual(relayed, [[
      'instance_relay/submission_relay',
      'instance_relay/submission_relay',
      status.text,
    ]]);

    // Relaying stays best-effort when the resolver cannot name a target.
    await relayObservedStatus('instance_relay', 'submission_relay', status, env, () => {
      throw new Error('no runner');
    });
  } finally {
    if (original) Object.defineProperty(prototype, 'userAgent', original);
  }
});
