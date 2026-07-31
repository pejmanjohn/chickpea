import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import type { ResolvedAssignment } from '../src/config/types.ts';
import type { SlackInteractionProgressPatch } from '../src/config/state-rpc.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const assignment: ResolvedAssignment = {
  workspaceId: 'T_HEARTBEAT',
  channelId: 'D_HEARTBEAT',
  agentId: 'agent_heartbeat',
  model: 'local-stub/heartbeat',
  agent: {
    id: 'agent_heartbeat',
    name: 'Chickpea',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

function workTurn(eventId: string): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    eventId,
    text: 'Complete the verification.',
    userId: 'U_HEARTBEAT',
    messageTs: '1785509000.000100',
    threadTs: '1785509000.000100',
    source: 'dm_message',
    channelType: 'im',
    contextMode: 'dm_history',
    interactionIntent: {
      disposition: 'work',
      reason: 'substantive_request',
      checklist: ['Verification result'],
    },
  };
}

function heartbeatClient(options: { failFinal?: boolean } = {}): {
  client: WebClient;
  heartbeatStarted: Promise<void>;
  finalAttempted: Promise<void>;
  releaseHeartbeat(): void;
  updateCount(): number;
  removedCount(): number;
  trace(): readonly string[];
} {
  const heartbeat = deferred<void>();
  const heartbeatStarted = deferred<void>();
  const finalAttempted = deferred<void>();
  let updates = 0;
  let removals = 0;
  let posts = 0;
  const trace: string[] = [];
  const client = {
    assistant: {
      threads: {
        setStatus: async () => {
          trace.push('status');
          return { ok: true };
        },
      },
    },
    reactions: {
      add: async () => ({ ok: true }),
      remove: async () => {
        trace.push('reaction.remove');
        removals += 1;
        return { ok: true };
      },
    },
    conversations: {
      history: async () => {
        trace.push('history.start');
        await delay(1_100, undefined);
        trace.push('history.end');
        return { ok: true, messages: [] };
      },
    },
    chat: {
      postMessage: async () => {
        posts += 1;
        if (options.failFinal && posts > 1) {
          trace.push('final.fallback');
          throw new Error('simulated Slack post failure');
        }
        return { ok: true, channel: assignment.channelId, ts: 'checklist-ts' };
      },
      update: async () => {
        trace.push(`update.${updates + 1}`);
        updates += 1;
        if (updates === 1) {
          heartbeatStarted.resolve(undefined);
          await heartbeat.promise;
        }
        return { ok: true };
      },
      startStream: async () => {
        trace.push('final.start');
        finalAttempted.resolve(undefined);
        if (options.failFinal) throw new Error('simulated unknown Slack delivery outcome');
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  return {
    client,
    heartbeatStarted: heartbeatStarted.promise,
    finalAttempted: finalAttempted.promise,
    releaseHeartbeat: () => heartbeat.resolve(undefined),
    updateCount: () => updates,
    removedCount: () => removals,
    trace: () => trace,
  };
}

test('runTurn drains an in-flight heartbeat before terminal checklist finalization', async () => {
  const harness = heartbeatClient();
  let settled = false;
  const running = runTurn(workTurn('Ev_HEARTBEAT_SUCCESS'), assignment, undefined, {
    client: harness.client,
    replayText: 'Verification complete.',
    progressHeartbeatMs: 1_000,
    usageRecordingEnabled: false,
  }).finally(() => {
    settled = true;
  });

  await harness.heartbeatStarted;
  await harness.finalAttempted;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(harness.updateCount(), 1);

  harness.releaseHeartbeat();
  await running;
  assert.equal(harness.updateCount(), 2);
  assert.equal(harness.removedCount(), 1);
});

test('runTurn failure cleanup does not wait for an in-flight heartbeat', async () => {
  const harness = heartbeatClient({ failFinal: true });
  const outcome = runTurn(workTurn('Ev_HEARTBEAT_FAILURE'), assignment, undefined, {
    client: harness.client,
    replayText: 'Verification complete.',
    progressHeartbeatMs: 1_000,
    usageRecordingEnabled: false,
  }).then(() => 'resolved' as const, () => 'rejected' as const);

  await harness.heartbeatStarted;
  await harness.finalAttempted;
  assert.equal(
    await Promise.race([outcome, delay(250, 'timeout' as const)]),
    'rejected',
    harness.trace().join(', '),
  );
  assert.equal(harness.updateCount(), 1);
  assert.equal(harness.removedCount(), 1);

  harness.releaseHeartbeat();
});

test('runTurn bounds a never-settling heartbeat without racing a terminal update', async () => {
  const harness = heartbeatClient();
  const progress: SlackInteractionProgressPatch[] = [];
  const outcome = runTurn(workTurn('Ev_HEARTBEAT_TIMEOUT'), assignment, undefined, {
    client: harness.client,
    replayText: 'Verification complete.',
    progressHeartbeatMs: 1_000,
    progressHeartbeatDrainMs: 50,
    usageRecordingEnabled: false,
    onInteractionProgress(patch) {
      progress.push(patch);
    },
  }).then(() => 'resolved' as const, () => 'rejected' as const);

  await harness.heartbeatStarted;
  await harness.finalAttempted;
  assert.equal(await Promise.race([outcome, delay(250, 'timeout' as const)]), 'resolved');
  assert.equal(harness.updateCount(), 1, 'terminal update must not race the hung heartbeat');
  assert.equal(
    progress.some((patch) =>
      patch.checklist?.messageTs === 'checklist-ts' && patch.checklist.cleanup === 'pending'
    ),
    true,
    'the repair lane must receive the pending checklist coordinate',
  );
  assert.equal(
    progress.some((patch) => patch.checklist?.cleanup === 'done'),
    false,
    'durable repair must retain ownership of checklist finalization',
  );
  assert.equal(harness.removedCount(), 1);
});
