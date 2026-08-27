import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import type { SlackPresentationStatePort } from '../src/slack/agent-view-presentation.ts';
import {
  drainSlackPresentationRepairs,
  hasRetryableTerminalRepair,
} from '../src/slack/presentation-repair.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationMutation,
  type SlackPresentationRoot,
  type SlackRunPresentationV3,
} from '../src/slack/run-presentations.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';

const BASE_NOW = 1_800_000_000_000;

function root(suffix: string): SlackPresentationRoot {
  return {
    workspaceId: `T_${suffix}`,
    channelId: `C_${suffix}`,
    threadTs: '1788000000.000100',
    requesterUserId: `U_${suffix}`,
  };
}

function createV3(
  store: SlackRunPresentationStoreLogic,
  runId: string,
  presentationRoot: SlackPresentationRoot,
  sessionGeneration: number,
): SlackRunPresentationV3 {
  const created = store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: {
      kind: 'selected_agent',
      persona: {
        name: 'Frozen Repair Agent',
        avatarUrl: 'https://chickpea.example/assets/agents/repair/avatar/1',
        avatarRevision: 1,
      },
    },
    sessionGeneration,
    currentActivity: {
      kind: 'checking',
      action: 'Checking',
      object: 'the repair state',
      generation: sessionGeneration,
      sequence: 1,
      operation: {
        operationId: `activity_${runId}_1`,
        certainty: 'pending',
      },
    },
    root: presentationRoot,
  });
  assert.equal(created.schemaVersion, 3);
  if (created.schemaVersion !== 3) throw new Error('expected V3 fixture');
  return created;
}

function advance(
  store: SlackRunPresentationStoreLogic,
  current: SlackRunPresentationV3,
  mutation: SlackPresentationMutation,
): SlackRunPresentationV3 {
  const result = store.transition({
    runId: current.runId,
    workBindingGeneration: current.workBindingGeneration,
    runFencingToken: current.runFencingToken,
    expectedProjectionVersion: current.projectionVersion,
    expectedStreamState: current.stream.state,
    mutation,
  });
  assert.equal(result.outcome, 'applied');
  if (result.outcome !== 'applied' || result.presentation.schemaVersion !== 3) {
    throw new Error('fixture transition did not produce V3 state');
  }
  return result.presentation;
}

function terminalRepair(
  store: SlackRunPresentationStoreLogic,
  input: {
    runId: string;
    root: SlackPresentationRoot;
    sessionGeneration: number;
    sessionCertainty: 'failed' | 'unknown';
    activitySurface?: 'assistant_status' | 'message';
    cleanupFailed?: boolean;
    lifecycleSettled?: boolean;
  },
): SlackRunPresentationV3 {
  let current = createV3(store, input.runId, input.root, input.sessionGeneration);
  const surface = input.activitySurface ?? 'assistant_status';
  current = advance(store, current, { kind: 'select_activity_projection', surface });
  current = advance(store, current, {
    kind: 'record_activity_receipt',
    operationId: `activity_${input.runId}_1`,
    certainty: input.activitySurface ? 'acknowledged' : 'failed',
    ...(surface === 'message' && input.activitySurface
      ? { messageTs: '1788000000.000200' }
      : {}),
  });
  current = advance(store, current, {
    kind: 'record_terminal_delivery_intent',
    operationId: `terminal_${input.runId}_1`,
    result: 'answer',
  });
  current = advance(store, current, {
    kind: 'record_terminal_delivery_receipt',
    operationId: `terminal_${input.runId}_1`,
    certainty: 'acknowledged',
  });
  current = advance(store, current, {
    kind: 'set_agent_session_desired',
    desired: 'active',
    operationId: `session_${input.runId}_1`,
  });
  current = advance(store, current, {
    kind: 'record_agent_session_receipt',
    operationId: `session_${input.runId}_1`,
    certainty: input.sessionCertainty,
  });
  if (input.cleanupFailed) {
    current = advance(store, current, {
      kind: 'record_cleanup_intent',
      operationId: `cleanup_${input.runId}_1`,
      target: 'activity',
    });
    current = advance(store, current, {
      kind: 'record_cleanup_receipt',
      operationId: `cleanup_${input.runId}_1`,
      certainty: 'failed',
    });
  }
  if (input.lifecycleSettled) {
    current = advance(store, current, { kind: 'set_lifecycle_phase', phase: 'settled' });
  }
  return current;
}

function statePort(store: SlackRunPresentationStoreLogic): SlackPresentationStatePort {
  return {
    getRunPresentation: (runId) => store.get(runId),
    getLatestThreadSessionGeneration: (presentationRoot) =>
      store.getLatestThreadSessionGeneration(presentationRoot),
    transitionRunPresentation: (input) => store.transition(input),
    reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
}

function repairClient(input: {
  onSession?(): Promise<unknown>;
  calls?: string[];
} = {}): WebClient {
  const calls = input.calls ?? [];
  return {
    apiCall: async () => {
      calls.push('agent_session');
      return await (input.onSession?.() ?? Promise.resolve({ ok: true }));
    },
    assistant: {
      threads: {
        setStatus: async () => {
          calls.push('assistant_status_clear');
          return { ok: true };
        },
      },
    },
    chat: {
      delete: async () => {
        calls.push('message_delete');
        return { ok: true };
      },
    },
  } as unknown as WebClient;
}

test('repair drain attempts failed effects, quarantines unknown effects, and retains resolver failures', async () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => BASE_NOW);
    const confirmed = terminalRepair(store, {
      runId: 'run_repair_confirmed', root: root('REPAIR_CONFIRMED'),
      sessionGeneration: 100, sessionCertainty: 'failed', lifecycleSettled: true,
    });
    const unknown = terminalRepair(store, {
      runId: 'run_repair_unknown', root: root('REPAIR_UNKNOWN'),
      sessionGeneration: 200, sessionCertainty: 'unknown', lifecycleSettled: true,
    });
    const unresolved = terminalRepair(store, {
      runId: 'run_repair_resolver', root: root('REPAIR_RESOLVER'),
      sessionGeneration: 300, sessionCertainty: 'failed', lifecycleSettled: true,
    });
    const calls: string[] = [];
    const failures: Array<{ runId: string; error: unknown }> = [];

    const result = await drainSlackPresentationRepairs({
      presentations: [confirmed, unknown, unresolved],
      state: statePort(store),
      now: () => BASE_NOW,
      resolveClient: async (workspaceId) => {
        if (workspaceId === unresolved.root.workspaceId) {
          throw new Error('resolver unavailable');
        }
        return repairClient({ calls });
      },
      onFailure: (presentation, error) => failures.push({ runId: presentation.runId, error }),
    });

    assert.deepEqual(calls, ['agent_session']);
    assert.deepEqual(failures.map(({ runId }) => runId), [unresolved.runId]);
    assert.match(String(failures[0]?.error), /resolver unavailable/);
    assert.equal(result.attempted, 2);
    assert.equal(result.retryableRemaining, 1);
    assert.equal(result.nextRetryAt, BASE_NOW + 30_000);
    assert.equal(hasRetryableTerminalRepair(unknown), false);
  } finally {
    db.close();
  }
});

test('newer thread generation supersedes shared repair but preserves exact message cleanup', async () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => BASE_NOW);
    const sharedRoot = root('REPAIR_GENERATION');
    const assistantRepair = terminalRepair(store, {
      runId: 'run_repair_old_assistant', root: sharedRoot,
      sessionGeneration: 100, sessionCertainty: 'failed',
      activitySurface: 'assistant_status',
    });
    const messageRepair = terminalRepair(store, {
      runId: 'run_repair_old_message', root: sharedRoot,
      sessionGeneration: 150, sessionCertainty: 'failed',
      activitySurface: 'message', cleanupFailed: true,
    });
    createV3(store, 'run_repair_new_owner', sharedRoot, 200);
    const calls: string[] = [];

    const result = await drainSlackPresentationRepairs({
      presentations: [assistantRepair, messageRepair],
      state: statePort(store),
      now: () => BASE_NOW,
      resolveClient: async () => repairClient({ calls }),
    });

    assert.deepEqual(calls, ['message_delete']);
    assert.deepEqual(result, { attempted: 2, retryableRemaining: 0 });
    const persistedAssistant = store.get(assistantRepair.runId);
    const persistedMessage = store.get(messageRepair.runId);
    assert.equal(persistedAssistant?.schemaVersion, 3);
    assert.equal(persistedMessage?.schemaVersion, 3);
    if (persistedAssistant?.schemaVersion === 3) {
      assert.equal(persistedAssistant.agentSession.disposition, 'superseded');
      assert.deepEqual(persistedAssistant.cleanup, {
        state: 'not_required', disposition: 'superseded',
      });
      assert.equal(persistedAssistant.repairRequired, false);
    }
    if (persistedMessage?.schemaVersion === 3) {
      assert.equal(persistedMessage.agentSession.disposition, 'superseded');
      assert.equal(persistedMessage.activityProjection.state, 'cleared');
      assert.equal(persistedMessage.repairRequired, false);
    }
  } finally {
    db.close();
  }
});

test('transient repair failures use durable bounded exponential backoff', async () => {
  const db = openStateDb(':memory:');
  try {
    let now = BASE_NOW;
    const store = new SlackRunPresentationStoreLogic(db, () => now);
    const repair = terminalRepair(store, {
      runId: 'run_repair_backoff', root: root('REPAIR_BACKOFF'),
      sessionGeneration: 100, sessionCertainty: 'failed', lifecycleSettled: true,
    });
    let sessionCalls = 0;
    const client = repairClient({
      onSession: async () => {
        sessionCalls += 1;
        throw new SlackTransportError('agents.sessions.setStatus', 'gateway_http_429', {
          retryable: true,
          effectOutcome: 'failed',
        });
      },
    });
    const drain = () => drainSlackPresentationRepairs({
      presentations: [store.get(repair.runId) as SlackRunPresentationV3],
      state: statePort(store),
      now: () => now,
      resolveClient: async () => client,
    });

    const first = await drain();
    assert.deepEqual(first, {
      attempted: 1, retryableRemaining: 1, nextRetryAt: BASE_NOW + 30_000,
    });
    assert.equal(sessionCalls, 1);
    assert.deepEqual((store.get(repair.runId) as SlackRunPresentationV3).repair, {
      attempts: 1,
      nextRetryAt: BASE_NOW + 30_000,
    });

    now += 29_999;
    const early = await drain();
    assert.deepEqual(early, {
      attempted: 0, retryableRemaining: 1, nextRetryAt: BASE_NOW + 30_000,
    });
    assert.equal(sessionCalls, 1);

    now += 1;
    const second = await drain();
    assert.deepEqual(second, {
      attempted: 1, retryableRemaining: 1, nextRetryAt: BASE_NOW + 90_000,
    });
    assert.equal(sessionCalls, 2);
    assert.deepEqual((store.get(repair.runId) as SlackRunPresentationV3).repair, {
      attempts: 2,
      nextRetryAt: BASE_NOW + 90_000,
    });
  } finally {
    db.close();
  }
});

test('permanent unsupported Agent Session rejection becomes durably unavailable', async () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => BASE_NOW);
    const repair = terminalRepair(store, {
      runId: 'run_repair_unsupported', root: root('REPAIR_UNSUPPORTED'),
      sessionGeneration: 100, sessionCertainty: 'failed', lifecycleSettled: true,
    });
    let sessionCalls = 0;
    const client = repairClient({
      onSession: async () => {
        sessionCalls += 1;
        throw new SlackTransportError('agents.sessions.setStatus', 'gateway_http_403', {
          retryable: false,
          effectOutcome: 'failed',
        });
      },
    });
    const drain = () => drainSlackPresentationRepairs({
      presentations: [store.get(repair.runId) as SlackRunPresentationV3],
      state: statePort(store),
      now: () => BASE_NOW,
      resolveClient: async () => client,
    });

    assert.deepEqual(await drain(), { attempted: 1, retryableRemaining: 0 });
    const persisted = store.get(repair.runId);
    assert.equal(persisted?.schemaVersion, 3);
    if (persisted?.schemaVersion === 3) {
      assert.equal(persisted.agentSession.disposition, 'unavailable');
      assert.equal(persisted.repairRequired, false);
    }
    assert.deepEqual(store.listAutoRepairableV3().map(({ runId }) => runId), []);
    assert.deepEqual(await drain(), { attempted: 0, retryableRemaining: 0 });
    assert.equal(sessionCalls, 1);
  } finally {
    db.close();
  }
});
