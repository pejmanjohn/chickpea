import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import {
  DEFAULT_SLACK_APPEND_BUDGET,
  SLACK_PRESENTATION_FINALIZED_TTL_MS,
  SLACK_PRESENTATION_RETENTION_MS,
  SlackRunPresentationStoreLogic,
  SlackPresentationStateError,
  presentationAllowsProgressive,
  presentationUsesNativeTasks,
  slackPresentationFinalizationRecord,
  upgradeSlackRunPresentation,
  type SlackPresentationMutation,
  type SlackRunPresentation,
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

function createV3Input(runId = 'run_presentation_v3') {
  const { persona, ...legacyInput } = createInput(runId);
  return {
    ...legacyInput,
    schemaVersion: 3 as const,
    owner: {
      kind: 'selected_agent' as const,
      persona,
    },
    sessionGeneration: 11,
    currentActivity: {
      kind: 'checking' as const,
      action: 'Checking',
      object: 'the support record',
      generation: 11,
      sequence: 1,
      operation: {
        operationId: `activity_${runId}_1`,
        certainty: 'pending' as const,
      },
    },
  };
}

function advance(
  store: SlackRunPresentationStoreLogic,
  current: SlackRunPresentation,
  mutation: SlackPresentationMutation,
): SlackRunPresentation {
  const result = store.transition({
    runId: current.runId,
    workBindingGeneration: current.workBindingGeneration,
    runFencingToken: current.runFencingToken,
    expectedProjectionVersion: current.projectionVersion,
    expectedStreamState: current.stream.state,
    mutation,
  });
  assert.equal(result.outcome, 'applied');
  if (result.outcome !== 'applied') throw new Error('synthetic transition was not applied');
  return result.presentation;
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
    assert.equal(presentationAllowsProgressive(created), true);
    assert.equal(presentationUsesNativeTasks(created), true);
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

test('V3 creation freezes one complete visible owner and session generation exactly once', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    const created = store.create(createV3Input());

    assert.equal(created.schemaVersion, 3);
    if (created.schemaVersion !== 3) return;
    assert.deepEqual(created.owner, {
      kind: 'selected_agent',
      persona: createInput().persona,
    });
    assert.equal(created.sessionGeneration, 11);
    assert.deepEqual(created.currentActivity, createV3Input().currentActivity);
    assert.deepEqual(created.activityProjection, { surface: 'unselected', state: 'absent' });
    assert.deepEqual(created.progressiveIntent, { status: 'unresolved' });
    assert.equal(created.lifecyclePhase, 'admitted');
    assert.deepEqual(created.agentSession, {
      desired: 'processing',
      acknowledged: 'none',
    });
    assert.deepEqual(created.terminalDelivery, { state: 'none' });
    assert.deepEqual(created.cleanup, { state: 'not_required' });

    assert.deepEqual(store.create(createV3Input()), created);
    assert.throws(
      () => store.create({ ...createV3Input(), sessionGeneration: 12 }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'identity_conflict',
    );
    assert.throws(
      () => store.create({
        ...createV3Input(),
        owner: { kind: 'chickpea' as const },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'identity_conflict',
    );

    const chickpea = store.create({
      ...createV3Input('run_chickpea_owner'),
      owner: { kind: 'chickpea' as const },
    });
    assert.equal(chickpea.schemaVersion, 3);
    if (chickpea.schemaVersion === 3) {
      assert.deepEqual(chickpea.owner, { kind: 'chickpea' });
      assert.equal('persona' in chickpea.owner, false);
    }
  } finally {
    db.close();
  }
});

test('V1 and V2 upgrade deterministically without inventing selected-Agent capability or rewriting coordinates', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    let legacyV1 = store.create({
      ...createInput('run_upgrade_v1'),
      schemaVersion: 1,
      features: { progressiveStreaming: true, nativeTasks: true },
    });
    legacyV1 = advance(store, legacyV1, { kind: 'mark_non_stream_finalized' });
    const legacyV2 = store.create(createInput('run_upgrade_v2'));
    const rawBefore = db.all(
      'SELECT run_id, presentation_json FROM slack_run_presentations ORDER BY run_id',
    );

    const upgradedV1 = store.getV3(legacyV1.runId);
    const upgradedV2 = store.getV3(legacyV2.runId);
    assert.deepEqual(store.getV3(legacyV1.runId), upgradedV1);
    assert.deepEqual(store.getV3(legacyV2.runId), upgradedV2);
    assert.deepEqual(db.all(
      'SELECT run_id, presentation_json FROM slack_run_presentations ORDER BY run_id',
    ), rawBefore, 'read-time upgrade must not persist or rewrite the stored row');

    for (const [legacy, upgraded] of [
      [legacyV1, upgradedV1],
      [legacyV2, upgradedV2],
    ] as const) {
      assert.equal(upgraded?.schemaVersion, 3);
      assert.deepEqual(upgraded?.owner, { kind: 'chickpea' });
      assert.equal(upgraded?.sessionGeneration, legacy.workBindingGeneration);
      assert.deepEqual(upgraded?.root, legacy.root);
      assert.deepEqual(upgraded?.stream, legacy.stream);
      assert.deepEqual(
        upgraded?.plan?.tasks.map(({ id, title }) => ({ id, title })),
        legacy.plan?.tasks.map(({ id, title }) => ({ id, title })),
      );
      assert.deepEqual(upgraded?.compatibility.legacyPersona, legacy.persona);
    }
    assert.equal(legacyV1.schemaVersion, 1);
    assert.equal(legacyV2.schemaVersion, 2);
    if (legacyV1.schemaVersion !== 1 || legacyV2.schemaVersion !== 2) return;
    assert.deepEqual(upgradedV1?.compatibility.legacyFeatures, legacyV1.features);
    assert.deepEqual(upgradedV2?.compatibility.legacyProgressiveIntent,
      legacyV2.progressiveIntent);
    assert.deepEqual(upgradedV1?.progressiveIntent, {
      status: 'not_requested',
      decidedAt: legacyV1.createdAt,
    });
    assert.deepEqual(upgradedV2?.progressiveIntent, legacyV2.progressiveIntent);
    assert.deepEqual(upgradedV1?.agentSession, {
      desired: 'active',
      acknowledged: 'none',
    });

    const pureUpgrade = upgradeSlackRunPresentation(legacyV2);
    assert.deepEqual(pureUpgrade, upgradedV2);
    assert.notStrictEqual(pureUpgrade, legacyV2);

    const persisted = store.transition({
      runId: legacyV2.runId,
      workBindingGeneration: legacyV2.workBindingGeneration,
      runFencingToken: legacyV2.runFencingToken,
      expectedProjectionVersion: legacyV2.projectionVersion,
      expectedStreamState: legacyV2.stream.state,
      mutation: { kind: 'upgrade_to_v3' },
    });
    assert.equal(persisted.outcome, 'applied');
    assert.equal(store.get(legacyV2.runId)?.schemaVersion, 3);
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

test('V2 model intent is fenced, durable, and rejects mismatched or legacy transitions', () => {
  let clock = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => clock++);
    const { taskLabels: _intentTaskLabels, ...intentInput } = createInput('run_intent');
    let current = store.create(intentInput);
    const apply = (mutation: Parameters<typeof store.transition>[0]['mutation']) => {
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
    };
    apply({
      kind: 'freeze_progressive_eligibility',
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    apply({ kind: 'progressive_intent_candidate', toolCallId: 'stream_call_1' });
    assert.equal(current.schemaVersion, 2);
    if (current.schemaVersion !== 2) return;
    assert.deepEqual(current.progressiveIntent, {
      status: 'pending',
      toolCallId: 'stream_call_1',
    });

    assert.throws(
      () => store.transition({
        runId: current.runId,
        workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken,
        expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state,
        mutation: { kind: 'progressive_intent_requested', toolCallId: 'stream_call_other' },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'identity_conflict',
    );
    apply({ kind: 'progressive_intent_requested', toolCallId: 'stream_call_1' });
    assert.equal(current.schemaVersion, 2);
    if (current.schemaVersion !== 2) return;
    assert.deepEqual(current.progressiveIntent, {
      status: 'requested',
      toolCallId: 'stream_call_1',
      requestedAt: 1_800_000_000_004,
    });

    const { taskLabels: _legacyIntentTaskLabels, ...legacyIntentInput } = createInput(
      'run_legacy_intent',
    );
    const legacy = store.create({
      ...legacyIntentInput,
      schemaVersion: 1,
      features: { progressiveStreaming: true, nativeTasks: false },
    });
    const legacyEligible = store.transition({
      runId: legacy.runId,
      workBindingGeneration: legacy.workBindingGeneration,
      runFencingToken: legacy.runFencingToken,
      expectedProjectionVersion: legacy.projectionVersion,
      expectedStreamState: legacy.stream.state,
      mutation: {
        kind: 'freeze_progressive_eligibility',
        eligibility: { allowed: true, reason: 'safe_early_release' },
      },
    });
    assert.equal(legacyEligible.outcome, 'applied');
    if (legacyEligible.outcome !== 'applied') return;
    assert.throws(
      () => store.transition({
        runId: legacy.runId,
        workBindingGeneration: legacy.workBindingGeneration,
        runFencingToken: legacy.runFencingToken,
        expectedProjectionVersion: legacyEligible.presentation.projectionVersion,
        expectedStreamState: legacyEligible.presentation.stream.state,
        mutation: { kind: 'progressive_intent_not_requested' },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
  } finally {
    db.close();
  }
});

test('V3 preserves the progressive-intent state machine through reload', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    let current: SlackRunPresentation = store.create(createV3Input('run_v3_intent'));
    current = advance(store, current, {
      kind: 'freeze_progressive_eligibility',
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    current = advance(store, current, {
      kind: 'progressive_intent_candidate',
      toolCallId: 'stream_v3_intent',
    });
    current = advance(store, current, {
      kind: 'progressive_intent_requested',
      toolCallId: 'stream_v3_intent',
    });

    const reloaded = store.get(current.runId);
    assert.equal(reloaded?.schemaVersion, 3);
    if (reloaded?.schemaVersion === 3) {
      assert.deepEqual(reloaded.progressiveIntent, {
        status: 'requested',
        toolCallId: 'stream_v3_intent',
        requestedAt: 1_800_000_000_000,
      });
    }
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
      offers: { pending: 1 },
      intents: { unresolved: 1 },
      policyOutcomes: { pending: 1 },
      acceptedBytes: { total: 0, max: 0 },
      latencyMs: {
        offerToRequest: { count: 0, min: null, p50: null, p90: null, max: null },
        requestToFirstEffect: { count: 0, min: null, p50: null, p90: null, max: null },
        total: { count: 0, min: null, p50: null, p90: null, max: null },
      },
    });
  } finally {
    db.close();
  }
});

test('presentation evidence separates offer, intent, delivery, bytes, and latency without content', () => {
  let clock = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => (clock += 10));
    const withoutTasks = (runId: string, threadTs: string) => {
      const { taskLabels: _taskLabels, ...input } = createInput(runId);
      return store.create({ ...input, root: { ...ROOT, threadTs } });
    };

    let progressive = withoutTasks('run_evidence_progressive', '1785700010.000100');
    progressive = advance(store, progressive, {
      kind: 'freeze_progressive_eligibility',
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    progressive = advance(store, progressive, {
      kind: 'progressive_intent_candidate', toolCallId: 'stream_evidence',
    });
    progressive = advance(store, progressive, {
      kind: 'progressive_intent_requested', toolCallId: 'stream_evidence',
    });
    progressive = advance(store, progressive, { kind: 'stream_start_intent' });
    progressive = advance(store, progressive, {
      kind: 'stream_started',
      messageTs: '1785700010.000200',
      flue: {
        instanceId: 'instance_evidence',
        submissionId: 'submission_evidence',
        messageId: 'message_evidence',
      },
    });
    assert.equal(progressive.telemetry?.firstProgressiveEffectAt, undefined);
    progressive = advance(store, progressive, {
      kind: 'append_intent',
      position: { batch: 5, index: 0 },
      from: 0,
      to: 5,
      hash: 'a'.repeat(64),
    });
    progressive = advance(store, progressive, {
      kind: 'append_acknowledged',
      cursor: 1,
      acknowledgedPrefixHash: 'a'.repeat(64),
    });
    assert.equal(typeof progressive.telemetry?.firstProgressiveEffectAt, 'number');
    progressive = advance(store, progressive, {
      kind: 'close_stream', outcome: 'progressive',
    });
    progressive = advance(store, progressive, { kind: 'mark_finalizing' });
    progressive = advance(store, progressive, {
      kind: 'mark_artifact_delivered', outcome: 'progressive',
    });
    progressive = advance(store, progressive, { kind: 'mark_finalized' });

    let declined = withoutTasks('run_evidence_declined', '1785700011.000100');
    declined = advance(store, declined, {
      kind: 'freeze_progressive_eligibility',
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    declined = advance(store, declined, { kind: 'progressive_intent_not_requested' });
    declined = advance(store, declined, { kind: 'mark_non_stream_finalized' });

    let disabled = withoutTasks('run_evidence_disabled', '1785700012.000100');
    disabled = advance(store, disabled, {
      kind: 'freeze_progressive_eligibility',
      eligibility: { allowed: false, reason: 'operations_disabled' },
    });
    disabled = advance(store, disabled, { kind: 'mark_non_stream_finalized' });

    let denied = withoutTasks('run_evidence_denied', '1785700013.000100');
    denied = advance(store, denied, {
      kind: 'freeze_progressive_eligibility',
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    denied = advance(store, denied, {
      kind: 'progressive_intent_candidate', toolCallId: 'stream_denied',
    });
    denied = advance(store, denied, {
      kind: 'progressive_intent_denied', reason: 'non_presentation_tool',
    });
    denied = advance(store, denied, { kind: 'mark_non_stream_finalized' });

    const summary = store.summarize(ROOT.workspaceId);
    assert.deepEqual(summary.offers, { offered: 3, 'denied:operations_disabled': 1 });
    assert.deepEqual(summary.intents, {
      requested: 1,
      not_requested: 1,
      unresolved: 1,
      'denied:non_presentation_tool': 1,
    });
    assert.deepEqual(summary.policyOutcomes, {
      requested_progressive: 1,
      offered_not_requested: 1,
      operationally_disabled: 1,
      'requested_denied:non_presentation_tool': 1,
    });
    assert.deepEqual(summary.acceptedBytes, { total: 5, max: 5 });
    assert.equal(summary.latencyMs.offerToRequest.count, 1);
    assert.equal(summary.latencyMs.requestToFirstEffect.count, 1);
    assert.equal(summary.latencyMs.total.count, 4);

    const record = slackPresentationFinalizationRecord(progressive);
    assert.match(record.runRef, /^run_[a-f0-9]{24}$/);
    assert.equal(record.policyOutcome, 'requested_progressive');
    assert.equal(record.acceptedBytes, 5);
    const serialized = JSON.stringify(record);
    for (const privateValue of [
      progressive.runId,
      progressive.root.workspaceId,
      progressive.root.channelId,
      progressive.root.threadTs,
      progressive.root.requesterUserId,
      'instance_evidence',
      'submission_evidence',
      'message_evidence',
    ]) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
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

test('legacy native task truth advances all frozen items together and never rewrites labels', () => {
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

test('V3 tasks transition independently through semantic outcomes and survive reload', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    let current = store.create({
      ...createV3Input('run_v3_tasks'),
      taskLabels: ['Inspect', 'Revise', 'Optional check', 'Publish'],
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3 || !current.plan) return;
    const [inspectId, reviseId, optionalId, publishId] = current.plan.tasks.map((task) => task.id);

    const transitionTask = (
      taskId: string,
      to: 'in_progress' | 'completed' | 'changed' | 'skipped' | 'failed' | 'not_run',
      detail?: string,
    ) => {
      current = advance(store, current, {
        kind: 'transition_task',
        taskId,
        to,
        ...(detail ? { detail } : {}),
      });
      assert.equal(current.schemaVersion, 3);
    };

    transitionTask(inspectId!, 'in_progress');
    transitionTask(inspectId!, 'completed', 'Completed: record inspected.');
    transitionTask(reviseId!, 'in_progress');
    transitionTask(reviseId!, 'changed', 'Changed: recommendation revised.');
    transitionTask(optionalId!, 'skipped', 'Skipped: check was unnecessary.');
    transitionTask(publishId!, 'not_run', 'Not run: publishing was not requested.');

    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3) return;
    assert.deepEqual(current.plan?.tasks, [
      { id: inspectId, title: 'Inspect', status: 'complete', outcome: 'completed',
        detail: 'Completed: record inspected.' },
      { id: reviseId, title: 'Revise', status: 'complete', outcome: 'changed',
        detail: 'Changed: recommendation revised.' },
      { id: optionalId, title: 'Optional check', status: 'complete', outcome: 'skipped',
        detail: 'Skipped: check was unnecessary.' },
      { id: publishId, title: 'Publish', status: 'error', outcome: 'not_run',
        detail: 'Not run: publishing was not requested.' },
    ]);

    const reloaded = new SlackRunPresentationStoreLogic(db).get(current.runId);
    assert.deepEqual(reloaded, current);
  } finally {
    db.close();
  }
});

test('V3 task transitions reject reversed, invalid, and aggregate changes', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    let current = store.create({
      ...createV3Input('run_v3_task_guards'),
      taskLabels: ['Attempt', 'Later'],
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3 || !current.plan) return;
    const [attemptId, laterId] = current.plan.tasks.map((task) => task.id);

    assert.throws(
      () => advance(store, current, {
        kind: 'transition_task',
        taskId: attemptId!,
        to: 'failed',
        detail: 'Failed: no attempt began.',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
    current = advance(store, current, {
      kind: 'transition_task', taskId: attemptId!, to: 'in_progress',
    });
    current = advance(store, current, {
      kind: 'transition_task', taskId: attemptId!, to: 'failed',
      detail: 'Failed: source access was denied.',
    });
    const failedReload = store.get(current.runId);
    assert.equal(failedReload?.schemaVersion, 3);
    if (failedReload?.schemaVersion === 3) {
      assert.deepEqual(failedReload.plan?.tasks[0], {
        id: attemptId,
        title: 'Attempt',
        status: 'error',
        outcome: 'failed',
        detail: 'Failed: source access was denied.',
      });
    }
    assert.throws(
      () => advance(store, current, {
        kind: 'transition_task', taskId: attemptId!, to: 'in_progress',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'terminal_rewrite',
    );
    assert.throws(
      () => advance(store, current, {
        kind: 'transition_task', taskId: laterId!, to: 'completed',
        detail: 'Completed: later step.',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
    assert.throws(
      () => advance(store, current, { kind: 'set_task_status', status: 'complete' }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
  } finally {
    db.close();
  }
});

test('new V3 task plans require multiple committed milestones and one ordered active row', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    const single = store.create({
      ...createV3Input('run_v3_single_step'),
      taskLabels: ['Answer the question'],
    });
    assert.equal(single.schemaVersion, 3);
    assert.equal(single.schemaVersion === 3 ? single.plan : undefined, undefined);

    let current = store.create({
      ...createV3Input('run_v3_ordered_tasks'),
      taskLabels: ['Inspect', 'Revise', 'Publish'],
    });
    if (current.schemaVersion !== 3 || !current.plan) return;
    const [inspectId, reviseId] = current.plan.tasks.map((task) => task.id);
    assert.throws(
      () => advance(store, current, {
        kind: 'transition_task', taskId: reviseId!, to: 'in_progress',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
    current = advance(store, current, {
      kind: 'transition_task', taskId: inspectId!, to: 'in_progress',
    });
    assert.throws(
      () => advance(store, current, {
        kind: 'transition_task', taskId: reviseId!, to: 'in_progress',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
    assert.throws(
      () => advance(store, current, {
        kind: 'transition_task', taskId: inspectId!, to: 'completed',
        detail: 'Done without a semantic outcome prefix.',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_input',
    );
  } finally {
    db.close();
  }
});

test('V3 activity sequence and operation receipt identity are durable and guarded', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    let current: SlackRunPresentation = store.create(createV3Input('run_v3_activity'));
    current = advance(store, current, {
      kind: 'select_activity_projection', surface: 'assistant_status',
    });
    current = advance(store, current, {
      kind: 'record_activity_receipt',
      operationId: 'activity_run_v3_activity_1',
      certainty: 'acknowledged',
    });
    assert.equal(current.repairRequired, false);
    current = advance(store, current, {
      kind: 'set_current_activity',
      activity: {
        kind: 'updating',
        action: 'Updating',
        object: 'the support recommendation',
        generation: 11,
        sequence: 2,
        operation: { operationId: 'activity_run_v3_activity_2', certainty: 'pending' },
      },
    });
    assert.equal(current.repairRequired, true);
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3) return;
    assert.equal(current.currentActivity?.sequence, 2);
    const activity = current.currentActivity!;

    assert.throws(
      () => advance(store, current, {
        kind: 'record_activity_receipt',
        operationId: 'activity_run_v3_activity_retry',
        certainty: 'acknowledged',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'identity_conflict',
    );
    assert.throws(
      () => advance(store, current, {
        kind: 'set_current_activity',
        activity: {
          ...activity,
          action: 'Raw\ntrace',
          operation: { operationId: 'activity_run_v3_activity_3', certainty: 'pending' },
        },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_input',
    );
    assert.throws(
      () => advance(store, current, {
        kind: 'set_current_activity',
        activity: {
          ...activity,
          operation: { operationId: 'activity_run_v3_activity_3', certainty: 'pending' },
        },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
    current = advance(store, current, {
      kind: 'record_activity_receipt',
      operationId: 'activity_run_v3_activity_2',
      certainty: 'unknown',
    });
    assert.equal(current.repairRequired, true);
    assert.throws(
      () => advance(store, current, {
        kind: 'set_current_activity',
        activity: {
          ...activity,
          sequence: 3,
          operation: { operationId: 'activity_run_v3_activity_3', certainty: 'pending' },
        },
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'invalid_transition',
    );
  } finally {
    db.close();
  }
});

test('native activity status budget is shared per installation and honors retry cooldown', () => {
  const db = openStateDb(':memory:');
  let now = 1_800_000_000_000;
  try {
    const firstIsolate = new SlackRunPresentationStoreLogic(db, () => now);
    const secondIsolate = new SlackRunPresentationStoreLogic(db, () => now);

    assert.equal(firstIsolate.reserveActivityStatus('T_SHARED').outcome, 'reserved');
    assert.equal(secondIsolate.reserveActivityStatus('T_SHARED').outcome, 'reserved');
    assert.equal(firstIsolate.reserveActivityStatus('T_SHARED').outcome, 'exhausted');
    now += 1_000;
    assert.equal(secondIsolate.reserveActivityStatus('T_SHARED').outcome, 'reserved');

    secondIsolate.applyActivityStatusCooldown('T_SHARED', 5_000);
    now += 1_000;
    assert.equal(firstIsolate.reserveActivityStatus('T_SHARED').outcome, 'cooldown');
    now += 4_000;
    assert.equal(firstIsolate.reserveActivityStatus('T_SHARED').outcome, 'reserved');
  } finally {
    db.close();
  }
});

test('V3 activity coordinate, terminal delivery, and cleanup retries remain separate', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    let current: SlackRunPresentation = store.create(createV3Input('run_v3_terminal_order'));
    current = advance(store, current, {
      kind: 'select_activity_projection', surface: 'message',
    });
    current = advance(store, current, {
      kind: 'record_activity_receipt',
      operationId: 'activity_run_v3_terminal_order_1',
      certainty: 'acknowledged',
      messageTs: '1787776000.000100',
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3) return;
    assert.deepEqual(current.activityProjection, {
      surface: 'message', state: 'visible', messageTs: '1787776000.000100',
    });

    current = advance(store, current, {
      kind: 'record_terminal_delivery_intent',
      operationId: 'terminal_run_v3_terminal_order_1',
      result: 'answer',
    });
    assert.throws(
      () => advance(store, current, {
        kind: 'record_cleanup_intent',
        operationId: 'cleanup_run_v3_terminal_order_early',
        target: 'activity',
      }),
      (error: unknown) => error instanceof SlackPresentationStateError &&
        error.code === 'invalid_transition',
    );
    current = advance(store, current, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_run_v3_terminal_order_1',
      certainty: 'failed',
    });
    current = advance(store, current, {
      kind: 'retry_terminal_delivery',
      operationId: 'terminal_run_v3_terminal_order_2',
    });
    current = advance(store, current, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_run_v3_terminal_order_2',
      certainty: 'acknowledged',
    });
    current = advance(store, current, {
      kind: 'record_cleanup_intent',
      operationId: 'cleanup_run_v3_terminal_order_1',
      target: 'activity',
    });
    current = advance(store, current, {
      kind: 'record_cleanup_receipt',
      operationId: 'cleanup_run_v3_terminal_order_1',
      certainty: 'failed',
    });
    current = advance(store, current, {
      kind: 'retry_cleanup',
      operationId: 'cleanup_run_v3_terminal_order_2',
    });
    current = advance(store, current, {
      kind: 'record_cleanup_receipt',
      operationId: 'cleanup_run_v3_terminal_order_2',
      certainty: 'acknowledged',
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3) return;
    assert.deepEqual(current.activityProjection, {
      surface: 'message', state: 'cleared', messageTs: '1787776000.000100',
    });
    assert.equal(current.terminalDelivery.state, 'intended');
    assert.equal(current.terminalDelivery.state === 'intended'
      ? current.terminalDelivery.operation.certainty
      : undefined, 'acknowledged');
    assert.equal(current.cleanup.state === 'required'
      ? current.cleanup.operation.certainty
      : undefined, 'acknowledged');
  } finally {
    db.close();
  }
});

test('V3 can supersede an answer terminal intent only after its receipt conclusively failed', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    for (const certainty of ['pending', 'unknown', 'acknowledged'] as const) {
      let current: SlackRunPresentation = store.create(createV3Input(`run_v3_terminal_${certainty}`));
      current = advance(store, current, {
        kind: 'record_terminal_delivery_intent',
        operationId: `terminal_answer_${certainty}`,
        result: 'answer',
      });
      if (certainty !== 'pending') {
        current = advance(store, current, {
          kind: 'record_terminal_delivery_receipt',
          operationId: `terminal_answer_${certainty}`,
          certainty,
        });
      }
      assert.throws(
        () => advance(store, current, {
          kind: 'supersede_failed_answer_delivery',
          operationId: `terminal_failure_${certainty}`,
        }),
        (error: unknown) => error instanceof SlackPresentationStateError &&
          error.code === 'invalid_transition',
      );
    }

    let failed: SlackRunPresentation = store.create(createV3Input('run_v3_terminal_failed'));
    failed = advance(store, failed, {
      kind: 'record_terminal_delivery_intent',
      operationId: 'terminal_answer_failed',
      result: 'answer',
    });
    failed = advance(store, failed, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_answer_failed',
      certainty: 'failed',
    });
    failed = advance(store, failed, {
      kind: 'supersede_failed_answer_delivery',
      operationId: 'terminal_failure_failed',
    });
    assert.equal(failed.schemaVersion, 3);
    if (failed.schemaVersion === 3) {
      assert.deepEqual(failed.terminalDelivery, {
        state: 'intended',
        result: 'failure',
        operation: { operationId: 'terminal_failure_failed', certainty: 'pending' },
      });
    }
  } finally {
    db.close();
  }
});

test('V3 retries only confirmed failed activity on the frozen surface', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    let current: SlackRunPresentation = store.create(createV3Input('run_v3_activity_retry'));
    current = advance(store, current, {
      kind: 'select_activity_projection', surface: 'message',
    });
    current = advance(store, current, {
      kind: 'record_activity_receipt',
      operationId: 'activity_run_v3_activity_retry_1',
      certainty: 'failed',
    });
    current = advance(store, current, {
      kind: 'retry_activity', operationId: 'activity_run_v3_activity_retry_2',
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3) return;
    assert.deepEqual(current.activityProjection, { surface: 'message', state: 'selected' });
    assert.deepEqual(current.currentActivity?.operation, {
      operationId: 'activity_run_v3_activity_retry_2', certainty: 'pending',
    });
    current = advance(store, current, {
      kind: 'record_activity_receipt',
      operationId: 'activity_run_v3_activity_retry_2',
      certainty: 'unknown',
    });
    assert.throws(
      () => advance(store, current, {
        kind: 'retry_activity', operationId: 'activity_run_v3_activity_retry_3',
      }),
      (error: unknown) => error instanceof SlackPresentationStateError &&
        error.code === 'invalid_transition',
    );
  } finally {
    db.close();
  }
});

test('V3 may replace a confirmed failed processing status with its terminal status', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    let current: SlackRunPresentation = store.create(createV3Input('run_v3_session_failed'));
    current = advance(store, current, {
      kind: 'set_agent_session_desired', desired: 'processing', operationId: 'session_processing_1',
    });
    current = advance(store, current, {
      kind: 'record_agent_session_receipt',
      operationId: 'session_processing_1', certainty: 'failed',
    });
    current = advance(store, current, {
      kind: 'set_agent_session_desired', desired: 'active', operationId: 'session_active_1',
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion === 3) {
      assert.deepEqual(current.agentSession, {
        desired: 'active',
        acknowledged: 'none',
        operation: { operationId: 'session_active_1', certainty: 'pending' },
      });
    }
  } finally {
    db.close();
  }
});

test('a confirmed absent activity remains repair-required until its acknowledged terminal settles', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    let current: SlackRunPresentation = store.create(createV3Input('run_v3_absent_activity'));
    current = advance(store, current, {
      kind: 'select_activity_projection', surface: 'message',
    });
    current = advance(store, current, {
      kind: 'record_activity_receipt',
      operationId: 'activity_run_v3_absent_activity_1',
      certainty: 'failed',
    });
    assert.equal(current.repairRequired, true);
    current = advance(store, current, {
      kind: 'record_terminal_delivery_intent',
      operationId: 'terminal_run_v3_absent_activity_1',
      result: 'answer',
    });
    current = advance(store, current, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_run_v3_absent_activity_1',
      certainty: 'acknowledged',
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3) return;
    assert.equal(current.repairRequired, true);
    assert.equal(current.lifecyclePhase, 'terminal_intended');
  } finally {
    db.close();
  }
});

test('V3 unknown delivery receipts remain repair-required without changing task truth', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    let current: SlackRunPresentation = store.create({
      ...createV3Input('run_v3_receipts'),
      taskLabels: ['Prepare answer', 'Record follow-up'],
    });
    assert.equal(current.schemaVersion, 3);
    if (current.schemaVersion !== 3 || !current.plan) return;
    const taskId = current.plan.tasks[0]!.id;
    current = advance(store, current, {
      kind: 'select_activity_projection', surface: 'assistant_status',
    });
    current = advance(store, current, {
      kind: 'record_activity_receipt',
      operationId: 'activity_run_v3_receipts_1',
      certainty: 'acknowledged',
    });
    assert.equal(current.repairRequired, false);
    current = advance(store, current, {
      kind: 'transition_task', taskId, to: 'in_progress',
    });
    current = advance(store, current, {
      kind: 'transition_task', taskId, to: 'completed',
      detail: 'Completed: answer prepared.',
    });
    const frozenTask = structuredClone(current.plan?.tasks[0]);

    current = advance(store, current, {
      kind: 'record_terminal_delivery_intent',
      operationId: 'terminal_delivery_1',
      result: 'answer',
    });
    current = advance(store, current, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_delivery_1',
      certainty: 'unknown',
    });
    assert.equal(current.repairRequired, true);
    assert.deepEqual(current.plan?.tasks[0], frozenTask);
    assert.deepEqual(store.listRepairRequired().map((row) => row.runId), [current.runId]);

    assert.throws(
      () => advance(store, current, {
        kind: 'record_terminal_delivery_intent',
        operationId: 'terminal_delivery_retry',
        result: 'answer',
      }),
      (error: unknown) =>
        error instanceof SlackPresentationStateError && error.code === 'terminal_rewrite',
    );

    assert.throws(
      () => advance(store, current, {
        kind: 'record_cleanup_intent',
        operationId: 'cleanup_activity_1',
        target: 'activity',
      }),
      (error: unknown) => error instanceof SlackPresentationStateError &&
        error.code === 'invalid_transition',
    );
    assert.equal(current.repairRequired, true);
    assert.deepEqual(current.plan?.tasks[0], frozenTask,
      'unknown delivery truth must not rewrite execution truth');
    assert.match(JSON.stringify(current), /"outcome":"completed"/);
    assert.match(JSON.stringify(current), /"certainty":"unknown"/);
  } finally {
    db.close();
  }
});

test('auto-repair selection skips early quarantined rows without starving a later V3 terminal', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db);
    for (const runId of ['run_quarantined_v1_a', 'run_quarantined_v1_b']) {
      const row = store.create({
        ...createInput(runId), schemaVersion: 1,
        features: { progressiveStreaming: true, nativeTasks: true },
      });
      advance(store, row, { kind: 'mark_unknown', degradationReason: 'unknown_effect' });
    }
    let quarantinedV3: SlackRunPresentation = store.create(createV3Input('run_quarantined_v3'));
    for (const mutation of [
      { kind: 'select_activity_projection', surface: 'assistant_status' as const } as const,
      {
        kind: 'record_activity_receipt', operationId: 'activity_run_quarantined_v3_1',
        certainty: 'acknowledged' as const,
      } as const,
      {
        kind: 'record_terminal_delivery_intent', operationId: 'terminal_run_quarantined_v3_1',
        result: 'answer' as const,
      } as const,
      {
        kind: 'record_terminal_delivery_receipt', operationId: 'terminal_run_quarantined_v3_1',
        certainty: 'acknowledged' as const,
      } as const,
      {
        kind: 'set_agent_session_desired', desired: 'active' as const,
        operationId: 'session_run_quarantined_v3_1',
      } as const,
      {
        kind: 'record_agent_session_receipt', operationId: 'session_run_quarantined_v3_1',
        certainty: 'unknown' as const,
      } as const,
      {
        kind: 'record_cleanup_intent', operationId: 'cleanup_run_quarantined_v3_1',
        target: 'activity' as const,
      } as const,
      {
        kind: 'record_cleanup_receipt', operationId: 'cleanup_run_quarantined_v3_1',
        certainty: 'acknowledged' as const,
      } as const,
      { kind: 'set_lifecycle_phase', phase: 'settled' as const } as const,
    ]) {
      quarantinedV3 = advance(store, quarantinedV3, mutation);
    }
    assert.equal(quarantinedV3.repairRequired, true);
    let repairable: SlackRunPresentation = store.create(createV3Input('run_auto_repairable_v3'));
    repairable = advance(store, repairable, {
      kind: 'record_terminal_delivery_intent', operationId: 'terminal_auto_repairable_v3_1',
      result: 'answer',
    });
    repairable = advance(store, repairable, {
      kind: 'record_terminal_delivery_receipt', operationId: 'terminal_auto_repairable_v3_1',
      certainty: 'acknowledged',
    });

    assert.deepEqual(store.listAutoRepairableV3(1).map((row) => row.runId), [repairable.runId]);
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
