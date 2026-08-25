import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import {
  DEFAULT_SLACK_APPEND_BUDGET,
  SLACK_PRESENTATION_FINALIZED_TTL_MS,
  SLACK_PRESENTATION_RETENTION_MS,
  SlackRunPresentationStoreLogic,
  SlackPresentationStateError,
} from '../src/slack/run-presentations.ts';
import { TURN_JOB_TTL_MS, TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';

const ROOT = {
  workspaceId: 'T_PRESENTATION',
  channelId: 'D_PRESENTATION',
  threadTs: '1785700000.000100',
  requesterUserId: 'U_PRESENTATION',
};

function createInput(runId = 'run_presentation_1') {
  return {
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: 'binding_presentation',
    workBindingGeneration: 7,
    runFencingToken: 0,
    persona: {
      name: 'Support Triage',
      avatarUrl: 'https://chickpea.example/assets/agents/support/avatar/3',
      avatarRevision: 3,
    },
    root: ROOT,
    taskLabels: ['Inspect the record', 'Prepare the recommendation'],
  } as const;
}

test('presentation creation writes V2 with stable native tasks and feature-free identity', () => {
  let clock = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => clock++);
    const created = store.create(createInput());

    assert.equal(created.schemaVersion, 2);
    assert.equal(created.projectionVersion, 1);
    assert.deepEqual(created.progressiveEligibility, { status: 'pending' });
    assert.deepEqual(created.progressiveIntent, { status: 'unresolved' });
    assert.equal('features' in created, false);
    assert.equal(created.stream.state, 'absent');
    assert.deepEqual(created.persona, createInput().persona);
    assert.equal(created.plan?.displayMode, 'plan');
    assert.deepEqual(created.plan?.tasks.map(({ title, status }) => ({ title, status })), [
      { title: 'Inspect the record', status: 'pending' },
      { title: 'Prepare the recommendation', status: 'pending' },
    ]);
    assert.notEqual(created.plan?.tasks[0]?.id, created.plan?.tasks[1]?.id);

    const replay = store.create({
      ...createInput(),
      features: { progressiveStreaming: false, nativeTasks: false },
    });
    assert.deepEqual(replay, created, 'idempotent admission must not replace frozen state');

    assert.throws(
      () => store.create({ ...createInput(), root: { ...ROOT, threadTs: '1785700001.000100' } }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'identity_conflict',
    );
    assert.throws(
      () => store.create({
        ...createInput(),
        persona: { ...createInput().persona, avatarRevision: 4 },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'identity_conflict',
    );
  } finally {
    db.close();
  }
});

test('V1 rows retain frozen features and adopt under V1 identity after the default changes', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    const { taskLabels: _legacyTaskLabels, ...legacyBase } = createInput(
      'run_v1_deploy_boundary',
    );
    const legacyInput = {
      ...legacyBase,
      schemaVersion: 1 as const,
      features: { progressiveStreaming: true, nativeTasks: false },
    };
    const legacy = store.create(legacyInput);
    assert.equal(legacy.schemaVersion, 1);
    assert.deepEqual(legacy.features, {
      progressiveStreaming: true,
      nativeTasks: false,
    });

    const adopted = store.create({
      ...legacyBase,
    });
    assert.deepEqual(adopted, legacy);
  } finally {
    db.close();
  }
});

test('presentation diagnostics aggregate only content-free workspace outcomes', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    store.create({
      ...createInput('run_summary'),
      features: { progressiveStreaming: true, nativeTasks: true },
    });
    const other = store.create({
      ...createInput('run_other_workspace'),
      root: { ...ROOT, workspaceId: 'T_OTHER', threadTs: '1785700001.000100' },
    });
    assert.ok(other);
    assert.deepEqual(store.summarize(ROOT.workspaceId), {
      workspaceId: ROOT.workspaceId,
      total: 1,
      truncated: false,
      streamStates: { absent: 1 },
      eligibility: { pending: 1 },
      outcomes: { pending: 1 },
      degradations: { none: 1 },
    });
  } finally {
    db.close();
  }
});

test('one fenced transition writer rejects stale versions, cursor gaps, and coordinate reuse', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    const first = store.create(createInput());
    const eligibility = store.transition({
      runId: first.runId,
      workBindingGeneration: first.workBindingGeneration,
      runFencingToken: first.runFencingToken,
      expectedProjectionVersion: first.projectionVersion,
      expectedStreamState: 'absent',
      mutation: {
        kind: 'freeze_progressive_eligibility',
        eligibility: { allowed: true, reason: 'safe_early_release' },
      },
    });
    assert.equal(eligibility.outcome, 'applied');
    if (eligibility.outcome !== 'applied') return;

    const stale = store.transition({
      runId: first.runId,
      workBindingGeneration: first.workBindingGeneration,
      runFencingToken: first.runFencingToken,
      expectedProjectionVersion: first.projectionVersion,
      expectedStreamState: 'absent',
      mutation: { kind: 'stream_start_intent' },
    });
    assert.deepEqual(stale, { outcome: 'stale' });

    const starting = store.transition({
      runId: first.runId,
      workBindingGeneration: first.workBindingGeneration,
      runFencingToken: first.runFencingToken,
      expectedProjectionVersion: eligibility.presentation.projectionVersion,
      expectedStreamState: 'absent',
      mutation: { kind: 'stream_start_intent' },
    });
    assert.equal(starting.outcome, 'applied');
    if (starting.outcome !== 'applied') return;
    assert.equal(starting.presentation.repairRequired, true);

    const streaming = store.transition({
      runId: first.runId,
      workBindingGeneration: first.workBindingGeneration,
      runFencingToken: first.runFencingToken,
      expectedProjectionVersion: starting.presentation.projectionVersion,
      expectedStreamState: 'starting',
      mutation: {
        kind: 'stream_started',
        messageTs: '1785700000.000200',
        flue: {
          instanceId: 'instance_presentation',
          submissionId: 'submission_presentation',
          messageId: 'message_presentation',
        },
      },
    });
    assert.equal(streaming.outcome, 'applied');
    if (streaming.outcome !== 'applied') return;
    assert.equal(streaming.presentation.repairRequired, false);

    const intent = store.transition({
      runId: first.runId,
      workBindingGeneration: first.workBindingGeneration,
      runFencingToken: first.runFencingToken,
      expectedProjectionVersion: streaming.presentation.projectionVersion,
      expectedStreamState: 'streaming',
      mutation: {
        kind: 'append_intent',
        position: { batch: 1, index: 1 },
        from: 0,
        to: 12,
        hash: 'a'.repeat(64),
      },
    });
    assert.equal(intent.outcome, 'applied');
    if (intent.outcome !== 'applied') return;
    assert.deepEqual(intent.presentation.stream.pendingAppend, {
      cursor: 1,
      from: 0,
      to: 12,
      hash: 'a'.repeat(64),
    });
    assert.equal(intent.presentation.repairRequired, true);

    assert.throws(
      () => store.transition({
        runId: first.runId,
        workBindingGeneration: first.workBindingGeneration,
        runFencingToken: first.runFencingToken,
        expectedProjectionVersion: intent.presentation.projectionVersion,
        expectedStreamState: 'streaming',
        mutation: {
          kind: 'append_acknowledged',
          cursor: 2,
          acknowledgedPrefixHash: 'b'.repeat(64),
        },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'cursor_gap',
    );

    const acknowledged = store.transition({
      runId: first.runId,
      workBindingGeneration: first.workBindingGeneration,
      runFencingToken: first.runFencingToken,
      expectedProjectionVersion: intent.presentation.projectionVersion,
      expectedStreamState: 'streaming',
      mutation: {
        kind: 'append_acknowledged',
        cursor: 1,
        acknowledgedPrefixHash: 'a'.repeat(64),
      },
    });
    assert.equal(acknowledged.outcome, 'applied');
    if (acknowledged.outcome !== 'applied') return;
    assert.equal(acknowledged.presentation.stream.acknowledgedByteLength, 12);
    assert.equal(acknowledged.presentation.stream.pendingAppend, undefined);
    assert.equal(acknowledged.presentation.repairRequired, false);

    store.create({
      ...createInput('run_presentation_2'),
      turnJobId: 'turn_run_presentation_2',
      root: { ...ROOT, threadTs: '1785700001.000100' },
    });
    const secondStarting = store.transition({
      runId: 'run_presentation_2',
      workBindingGeneration: 7,
      runFencingToken: 0,
      expectedProjectionVersion: 1,
      expectedStreamState: 'absent',
      mutation: { kind: 'stream_start_intent' },
    });
    assert.equal(secondStarting.outcome, 'applied');
    if (secondStarting.outcome !== 'applied') return;
    assert.throws(
      () => store.transition({
        runId: 'run_presentation_2',
        workBindingGeneration: 7,
        runFencingToken: 0,
        expectedProjectionVersion: secondStarting.presentation.projectionVersion,
        expectedStreamState: 'starting',
        mutation: {
          kind: 'stream_started',
          messageTs: '1785700000.000200',
          flue: {
            instanceId: 'instance_presentation_2',
            submissionId: 'submission_presentation_2',
          },
        },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'coordinate_conflict',
    );
  } finally {
    db.close();
  }
});

test('native task truth advances all frozen items together and never rewrites labels', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    const created = store.create(createInput());
    const running = store.transition({
      runId: created.runId,
      workBindingGeneration: created.workBindingGeneration,
      runFencingToken: created.runFencingToken,
      expectedProjectionVersion: created.projectionVersion,
      expectedStreamState: 'absent',
      mutation: { kind: 'set_task_status', status: 'in_progress' },
    });
    assert.equal(running.outcome, 'applied');
    if (running.outcome !== 'applied') return;
    assert.deepEqual(running.presentation.plan?.tasks.map((task) => task.status), [
      'in_progress',
      'in_progress',
    ]);
    assert.deepEqual(
      running.presentation.plan?.tasks.map((task) => task.title),
      created.plan?.tasks.map((task) => task.title),
    );

    const complete = store.transition({
      runId: created.runId,
      workBindingGeneration: created.workBindingGeneration,
      runFencingToken: created.runFencingToken,
      expectedProjectionVersion: running.presentation.projectionVersion,
      expectedStreamState: 'absent',
      mutation: { kind: 'set_task_status', status: 'complete' },
    });
    assert.equal(complete.outcome, 'applied');

    assert.throws(
      () => store.transition({
        runId: created.runId,
        workBindingGeneration: created.workBindingGeneration,
        runFencingToken: created.runFencingToken,
        expectedProjectionVersion:
          complete.outcome === 'applied' ? complete.presentation.projectionVersion : 0,
        expectedStreamState: 'absent',
        mutation: { kind: 'set_task_status', status: 'error' },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'terminal_rewrite',
    );
  } finally {
    db.close();
  }
});

test('adopt_plan attaches a late plan only when absent, native, and plan-free', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    // A late-classified mention is frozen WITHOUT task labels but WITH native
    // tasks on, so it has no plan at create time.
    const created = store.create({
      runId: 'run_late_plan',
      turnJobId: 'turn_run_late_plan',
      bindingId: 'binding_presentation',
      workBindingGeneration: 7,
      runFencingToken: 0,
      schemaVersion: 1,
      root: ROOT,
      features: { progressiveStreaming: false, nativeTasks: true },
    });
    assert.equal(created.plan, undefined);

    const adopted = store.transition({
      runId: created.runId,
      workBindingGeneration: created.workBindingGeneration,
      runFencingToken: created.runFencingToken,
      expectedProjectionVersion: created.projectionVersion,
      expectedStreamState: 'absent',
      mutation: { kind: 'adopt_plan', taskLabels: ['Mention result artifact'] },
    });
    assert.equal(adopted.outcome, 'applied');
    if (adopted.outcome !== 'applied') return;
    assert.equal(adopted.presentation.plan?.displayMode, 'timeline');
    assert.deepEqual(
      adopted.presentation.plan?.tasks.map(({ title, status }) => ({ title, status })),
      [{ title: 'Mention result artifact', status: 'pending' }],
    );

    // A second attach is refused: ambient/obvious-work turns already carry a
    // plan and must never be re-attached or reordered.
    assert.throws(
      () => store.transition({
        runId: created.runId,
        workBindingGeneration: created.workBindingGeneration,
        runFencingToken: created.runFencingToken,
        expectedProjectionVersion: adopted.presentation.projectionVersion,
        expectedStreamState: 'absent',
        mutation: { kind: 'adopt_plan', taskLabels: ['Second artifact'] },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'terminal_rewrite',
    );
  } finally {
    db.close();
  }
});

test('adopt_plan is refused when native tasks are disabled', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    const created = store.create({
      runId: 'run_no_native',
      turnJobId: 'turn_run_no_native',
      bindingId: 'binding_presentation',
      workBindingGeneration: 7,
      runFencingToken: 0,
      schemaVersion: 1,
      root: ROOT,
      features: { progressiveStreaming: false, nativeTasks: false },
    });
    assert.throws(
      () => store.transition({
        runId: created.runId,
        workBindingGeneration: created.workBindingGeneration,
        runFencingToken: created.runFencingToken,
        expectedProjectionVersion: created.projectionVersion,
        expectedStreamState: 'absent',
        mutation: { kind: 'adopt_plan', taskLabels: ['Mention result artifact'] },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
  } finally {
    db.close();
  }
});

test('workspace append reservations use one server-clock budget and shared cooldown', () => {
  let clock = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => clock);
    assert.deepEqual(store.reserveAppend(ROOT.workspaceId), {
      outcome: 'reserved',
      budgetVersion: 1,
    });
    assert.deepEqual(store.reserveAppend(ROOT.workspaceId), {
      outcome: 'exhausted',
      retryAt: clock + DEFAULT_SLACK_APPEND_BUDGET.refillWindowMs,
      budgetVersion: 1,
    });

    clock += DEFAULT_SLACK_APPEND_BUDGET.refillWindowMs;
    assert.deepEqual(store.reserveAppend(ROOT.workspaceId), {
      outcome: 'reserved',
      budgetVersion: 2,
    });
    const cooldown = store.applyAppendCooldown(ROOT.workspaceId, 2_000);
    assert.equal(cooldown.cooldownUntil, clock + 2_000);
    assert.deepEqual(store.reserveAppend(ROOT.workspaceId), {
      outcome: 'cooldown',
      retryAt: clock + 2_000,
      budgetVersion: cooldown.budgetVersion,
    });
  } finally {
    db.close();
  }
});

test('maintenance purges finalized rows early and tombstones unresolved rows without identifiers', () => {
  let clock = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => clock);
    const finalized = store.create(createInput('run_finalized'));
    let current = finalized;
    for (const mutation of [
      { kind: 'stream_start_intent' } as const,
      { kind: 'mark_fallback', outcome: 'fallback' as const } as const,
      { kind: 'mark_artifact_delivered', outcome: 'fallback' as const } as const,
      { kind: 'mark_finalized' } as const,
    ]) {
      const result = store.transition({
        runId: current.runId,
        workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken,
        expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state,
        mutation,
      });
      assert.equal(result.outcome, 'applied');
      if (result.outcome === 'applied') current = result.presentation;
    }

    for (const unresolved of [
      store.create(createInput('run_unresolved_v2')),
      store.create({
        ...createInput('run_unresolved_v1'),
        schemaVersion: 1,
        features: { progressiveStreaming: true, nativeTasks: true },
      }),
    ]) {
      const unknown = store.transition({
        runId: unresolved.runId,
        workBindingGeneration: unresolved.workBindingGeneration,
        runFencingToken: unresolved.runFencingToken,
        expectedProjectionVersion: unresolved.projectionVersion,
        expectedStreamState: 'absent',
        mutation: { kind: 'mark_unknown', degradationReason: 'unknown_effect' },
      });
      assert.equal(unknown.outcome, 'applied');
      if (unknown.outcome === 'applied') {
        assert.equal(unknown.presentation.schemaVersion, unresolved.schemaVersion);
      }
    }
    assert.deepEqual(
      store.listRepairRequired(10).map((row) => row.runId),
      ['run_unresolved_v1', 'run_unresolved_v2'],
    );

    clock += SLACK_PRESENTATION_FINALIZED_TTL_MS + 1;
    assert.deepEqual(store.maintain(10), { finalizedPurged: 1, expiredTombstoned: 0 });
    assert.equal(store.get('run_finalized'), undefined);
    assert.ok(store.get('run_unresolved_v1'), 'V1 repair state must outlive normal terminal TTL');
    assert.ok(store.get('run_unresolved_v2'), 'V2 repair state must outlive normal terminal TTL');

    clock = 1_800_000_000_000 + SLACK_PRESENTATION_RETENTION_MS + 1;
    assert.deepEqual(store.maintain(10), { finalizedPurged: 0, expiredTombstoned: 2 });
    assert.equal(store.get('run_unresolved_v1'), undefined);
    assert.equal(store.get('run_unresolved_v2'), undefined);
    assert.deepEqual(store.listRetentionTombstones(10), Array.from({ length: 2 }, () => ({
      streamState: 'unknown',
      repairRequired: true,
      expiredAt: 1_800_000_000_000 + SLACK_PRESENTATION_RETENTION_MS,
      tombstonedAt: clock,
    })));
    const serialized = JSON.stringify(store.listRetentionTombstones(10));
    for (const identifier of [
      'run_unresolved_v1',
      'run_unresolved_v2',
      ROOT.workspaceId,
      ROOT.channelId,
      ROOT.requesterUserId,
      ROOT.threadTs,
    ]) {
      assert.equal(serialized.includes(identifier), false);
    }
  } finally {
    db.close();
  }
});

test('presentation recovery authority survives the independent TurnJob terminal TTL', () => {
  let clock = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => clock);
    const presentations = new SlackRunPresentationStoreLogic(db, () => clock);
    turns.enqueue({
      id: 'turn_independent_ttl',
      evtKey: 'evt:independent-ttl',
      msgKey: 'msg:independent-ttl',
      turn: {
        workspaceId: ROOT.workspaceId,
        channelId: ROOT.channelId,
        eventId: 'Ev_independent_ttl',
        text: 'Inspect the presentation',
        userId: ROOT.requesterUserId,
        messageTs: ROOT.threadTs,
        threadTs: ROOT.threadTs,
        source: 'dm_message',
        contextMode: 'dm_history',
        channelType: 'im',
      },
      assignment: {
        workspaceId: ROOT.workspaceId,
        channelId: ROOT.channelId,
        agentId: 'agent_default',
        agent: {
          id: 'agent_default',
          kind: 'user',
          revision: 1,
          name: 'Default',
          instructions: 'Help.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      },
      runId: 'run_independent_ttl',
    });
    presentations.create({
      ...createInput('run_independent_ttl'),
      turnJobId: 'turn_independent_ttl',
    });
    turns.markDelivered('turn_independent_ttl');

    clock += TURN_JOB_TTL_MS + 1;
    turns.enqueue({
      id: 'turn_purge_trigger',
      evtKey: 'evt:purge-trigger',
      msgKey: 'msg:purge-trigger',
      turn: {
        workspaceId: ROOT.workspaceId,
        channelId: ROOT.channelId,
        eventId: 'Ev_purge_trigger',
        text: 'Trigger retention',
        userId: ROOT.requesterUserId,
        messageTs: '1785700001.000100',
        threadTs: '1785700001.000100',
        source: 'dm_message',
        contextMode: 'dm_history',
        channelType: 'im',
      },
      assignment: {
        workspaceId: ROOT.workspaceId,
        channelId: ROOT.channelId,
        agentId: 'agent_default',
        agent: {
          id: 'agent_default', kind: 'user', revision: 1, name: 'Default', instructions: 'Help.', enabled: true,
          skills: [], mcpServers: [], apiConnections: [], repositories: [],
        },
      },
    });

    assert.equal(
      db.get("SELECT 1 AS present FROM turn_jobs WHERE id = 'turn_independent_ttl'"),
      undefined,
    );
    assert.equal(presentations.get('run_independent_ttl')?.turnJobId, 'turn_independent_ttl');
  } finally {
    db.close();
  }
});
