import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import {
  WorkStateError,
  type BindingId,
  type RunId,
  type WorkId,
} from '../src/work/types.ts';

const NOW = 1_900_000_000_000;

test('shadow lifecycle keeps prepared input, approved output, render, and delivery distinct', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    const lifecycle = fixture.lifecycle;
    assert.equal(await lifecycle.prepareExecution('prepared prompt'), 'prepared prompt');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'accepted answer',
      renderedPayload: '{"blocks":["rendered answer"]}',
    });
    await lifecycle.afterDelivery({
      attemptId,
      outcome: 'delivered',
      deliveryRef: 'slack:C123:1900000000.000001',
    });

    const run = await fixture.store.getRun(fixture.runId);
    assert.ok(run);
    assert.equal(run.status, 'settled');
    assert.equal(run.terminalDisposition, 'succeeded');
    assert.equal(run.deliveryStatus, 'delivered');
    assert.notEqual(run.triggerContentRef, run.preparedInputRef);
    assert.notEqual(run.preparedInputRef, run.policyApprovedOutputRef);
    assert.notEqual(run.policyApprovedOutputRef, run.renderedPayloadRef);
    assert.equal((await fixture.store.getContent(run.preparedInputRef!))?.body, 'prepared prompt');
    assert.equal(
      (await fixture.store.getContent(run.policyApprovedOutputRef!))?.body,
      'accepted answer',
    );
    assert.equal(
      (await fixture.store.getContent(run.renderedPayloadRef!))?.body,
      '{"blocks":["rendered answer"]}',
    );
    const execution = await fixture.store.getRunExecution(lifecycle.executionId);
    assert.equal(execution?.outcome, 'succeeded');
    assert.equal(execution?.modelInvocationStatus, 'settled');
    assert.equal(execution?.providerAuthRoute, 'openai_api_key');
    assert.deepEqual(
      (await fixture.store.listAuditEvents(fixture.runId))
        .reverse()
        .map((event) => event.eventType),
      [
        'work.run_admitted',
        'work.input_prepared',
        'work.execution_created',
        'work.execution_route_recorded',
        'work.execution_invoked',
        'work.execution_settled',
        'work.response_recorded',
        'work.delivery_started',
        'work.delivery_delivered',
      ],
    );
  } finally {
    fixture.close();
  }
});

test('confirmed non-delivery can replace only the adapter render before fallback', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('prepared prompt');
    await fixture.lifecycle.markInvoked();
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const streamAttempt = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_stream',
      approvedOutput: 'same answer',
      renderedPayload: '{"method":"stream"}',
    });
    await fixture.lifecycle.afterDelivery({
      attemptId: streamAttempt,
      outcome: 'failed',
      safeFailureCode: 'slack_stream_not_started',
    });
    const failed = await fixture.store.getRun(fixture.runId);
    const approvedRef = failed?.policyApprovedOutputRef;
    const streamRenderRef = failed?.renderedPayloadRef;
    assert.equal(failed?.deliveryStatus, 'failed');

    const postAttempt = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'same answer',
      renderedPayload: '{"method":"post"}',
    });
    await fixture.lifecycle.afterDelivery({
      attemptId: postAttempt,
      outcome: 'delivered',
      deliveryRef: 'slack:C123:1900000000.000002',
    });
    const delivered = await fixture.store.getRun(fixture.runId);
    assert.equal(delivered?.policyApprovedOutputRef, approvedRef);
    assert.notEqual(delivered?.renderedPayloadRef, streamRenderRef);
    assert.equal(delivered?.deliveryMethod, 'slack_chat_post_message');
  } finally {
    fixture.close();
  }
});

test('a confirmed delivery retry reuses durable prepared input despite later context drift', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('original prepared prompt');
    await fixture.lifecycle.markInvoked();
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const firstAttempt = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'first answer',
      renderedPayload: '{"attempt":1}',
    });
    await fixture.lifecycle.afterDelivery({
      attemptId: firstAttempt,
      outcome: 'failed',
      safeFailureCode: 'slack_post_failed',
    });
    const firstRun = await fixture.store.getRun(fixture.runId);
    const preparedRef = firstRun?.preparedInputRef;

    const retry = new ShadowWorkLifecycle({
      store: fixture.store,
      runId: fixture.runId,
      attemptNumber: 2,
      agentName: 'profile_alpha',
      canonicalModel: 'openai/gpt-5.6-sol',
      sensitivity: 'public',
      routeEvidence: { providerAuthRoute: 'openai_api_key' },
      now: () => NOW + 100,
    });
    assert.equal(
      await retry.prepareExecution('edited or rehydrated prompt'),
      'original prepared prompt',
    );
    assert.equal((await fixture.store.getRun(fixture.runId))?.preparedInputRef, preparedRef);
    assert.equal((await fixture.store.getRunExecution(retry.executionId))?.attemptNumber, 2);
  } finally {
    fixture.close();
  }
});

test('private bodies never enter Work audit and stale fences cannot append lifecycle state', async () => {
  const fixture = await lifecycleFixture('private');
  const canary = 'PRIVATE_LIFECYCLE_CANARY_4b9a';
  try {
    await fixture.lifecycle.prepareExecution(canary);
    await fixture.lifecycle.markInvoked();
    await fixture.lifecycle.settleExecution({ outcome: 'failed', rawStatus: 'flue_failed', safeFailureCode: 'provider_failed' });
    const attemptId = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: canary,
      renderedPayload: JSON.stringify({ text: canary }),
    });
    assert.ok(attemptId);
    await assert.rejects(
      fixture.store.finalizeRunDelivery({
        runId: fixture.runId,
        fencingToken: 2,
        attemptId: attemptId!,
        outcome: 'delivered',
        deliveryRef: 'slack:C123:1900000000.000003',
        finalizedAt: NOW + 20,
      }),
      (error: unknown) => error instanceof WorkStateError && error.code === 'work_fence_stale',
    );
    assert.doesNotMatch(
      JSON.stringify(await fixture.store.listAuditEvents(fixture.runId)),
      new RegExp(canary),
    );
  } finally {
    fixture.close();
  }
});

test('action receipts are fenced, paired, body-free, and unknown outcomes require recovery', async () => {
  const fixture = await lifecycleFixture('private');
  try {
    await fixture.lifecycle.prepareExecution('private action prompt');
    await fixture.lifecycle.markInvoked();
    const common = {
      runId: fixture.runId,
      runExecutionId: fixture.lifecycle.executionId,
      fencingToken: fixture.lifecycle.fencingToken,
      actionAttemptId: 'action_lifecycle_alpha',
      actionClass: 'mcp_write',
      targetKind: 'asana_task',
      flueCorrelation: 'toolcall_lifecycle_alpha',
    } as const;
    await fixture.store.recordWorkAction({
      ...common,
      eventId: 'audit_action_started_alpha',
      idempotencyKey: 'auditkey_action_started_alpha',
      status: 'started',
      createdAt: NOW + 30,
    });
    await fixture.store.recordWorkAction({
      ...common,
      eventId: 'audit_action_unknown_alpha',
      idempotencyKey: 'auditkey_action_unknown_alpha',
      status: 'unknown',
      reasonCode: 'external_outcome_unknown',
      createdAt: NOW + 31,
    });
    const run = await fixture.store.getRun(fixture.runId);
    assert.equal(run?.status, 'recovery_required');
    assert.equal(run?.safeFailureCode, 'action_unknown');
    const serialized = JSON.stringify(await fixture.store.listAuditEvents(fixture.runId));
    assert.match(serialized, /mcp_write/);
    assert.doesNotMatch(serialized, /private action prompt/);
    assert.deepEqual(await fixture.store.verifyIntegrity(), {
      foreignKeysEnabled: true,
      foreignKeyViolationCount: 0,
      invariantViolationCount: 0,
    });
  } finally {
    fixture.close();
  }
});

test('pre-call resolver failure records not submitted without fabricating invocation evidence', async () => {
  const fixture = await lifecycleFixture('public', true);
  try {
    await fixture.lifecycle.prepareExecution('prepared resolver input');
    await fixture.lifecycle.settleExecution({
      outcome: 'not_submitted',
      rawStatus: 'model_not_invoked',
      safeFailureCode: 'subscription_reconnect',
    });
    const execution = await fixture.store.getRunExecution(fixture.lifecycle.executionId);
    assert.equal(execution?.outcome, 'not_submitted');
    assert.equal(execution?.modelInvocationStatus, 'not_invoked');
    assert.equal(execution?.providerAuthRoute, null);
    assert.equal(execution?.catalogRevision, null);
    assert.equal(execution?.modelCredentialRef, null);
    assert.equal(execution?.flueSubmissionRef, null);
  } finally {
    fixture.close();
  }
});

async function lifecycleFixture(
  sensitivity: 'public' | 'private',
  deferRoute = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-work-lifecycle-'));
  const store = new SqliteWorkStore(join(directory, 'state.sqlite'), { now: () => NOW });
  const workId = 'work_lifecycle_alpha' as WorkId;
  const bindingId = 'binding_lifecycle_alpha' as BindingId;
  const runId = 'run_lifecycle_alpha' as RunId;
  await store.admitShadowRun({
    work: {
      id: workId,
      kind: 'conversation',
      maximumSensitivity: sensitivity,
      createdAt: NOW,
    },
    binding: {
      id: bindingId,
      workId,
      adapterKind: 'slack',
      externalAccountId: 'account_lifecycle_alpha',
      externalConversationId: 'conversation_lifecycle_alpha',
      generation: 1,
      sourceVisibility: sensitivity,
      configMode: 'frozen_on_open',
      orderingKey: 'ordering_lifecycle_alpha',
      createdAt: NOW,
    },
    run: {
      id: runId,
      workId,
      bindingId,
      kind: 'interactive',
      triggerKind: 'slack_app_mention',
      triggerRef: 'trigger_lifecycle_alpha',
      dedupeKey: 'dedupe_lifecycle_alpha',
      actorRef: 'actor_lifecycle_alpha',
      actorTrustTier: 'member',
      sourceContextWatermark: 'watermark_lifecycle_alpha',
      effectiveCapabilityDigest: 'b'.repeat(64),
      executionAuthority: 'legacy',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
      createdAt: NOW,
    },
    safeConfig: {
      schemaVersion: 1,
      profileId: 'profile_lifecycle_alpha',
      configuredModel: 'openai/gpt-5.6-sol',
      snapshotDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
      skillNames: [],
      connectionIds: [],
      repositoryIds: [],
      memoryMode: sensitivity,
      ceilings: {
        maxModelAttempts: 3,
        maxToolCalls: 20,
        maxActionAttempts: 0,
        timeoutMs: 120_000,
      },
    },
    triggerContent: { sensitivity, body: 'trigger' },
    auditEventId: 'audit_lifecycle_alpha',
    auditIdempotencyKey: 'auditkey_lifecycle_alpha',
  });
  let tick = 0;
  const lifecycle = new ShadowWorkLifecycle({
    store,
    runId,
    attemptNumber: 1,
    agentName: 'profile_alpha',
    canonicalModel: 'openai/gpt-5.6-sol',
    sensitivity,
    routeEvidence: {
      providerAuthRoute: 'openai_api_key',
      catalogSource: 'bundled',
      catalogRevision: '0',
      catalogDigest: 'c'.repeat(64),
      compiledProfile: 'openai-platform-responses-sol-tier@1',
      modelCredentialRef: 'cred_openai_alpha',
      modelCredentialVersion: 1,
    },
    ...(deferRoute ? { deferRoute: true } : {}),
    now: () => NOW + (++tick),
  });
  return {
    store,
    runId,
    lifecycle,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
