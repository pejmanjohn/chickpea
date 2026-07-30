import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createWorkExecutionBoundary,
  type WorkExecutionDescriptor,
} from '../src/work/executor.ts';
import { opaqueId } from '../src/work/admission.ts';
import { submitRun, type SubmitRunInput } from '../src/work/submit-run.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

const NOW = 1_920_000_000_000;

test('a non-Slack adapter completes admission, render, delivery ambiguity, and recovery', async (t) => {
  let tick = 0;
  const store = new SqliteWorkStore(':memory:', { now: () => NOW + (++tick) });
  t.after(() => store.close());
  const submission = conformanceSubmission();
  const admission = await submitRun(store, submission);
  const descriptor: WorkExecutionDescriptor = {
    runId: admission.run.id,
    attemptNumber: 1,
    executorKind: 'agent',
    agentName: 'agent_company_work',
    canonicalModel: 'anthropic/claude-sonnet-4-6',
    flueInstanceRef: opaqueId('flueinstance', `conformance:${admission.binding.id}:1`),
    routeEvidence: {},
  };
  const boundary = await createWorkExecutionBoundary(store, descriptor, {
    now: () => NOW + (++tick),
  });

  assert.equal(await boundary.lifecycle.prepareExecution('Prepared company-work prompt'),
    'Prepared company-work prompt');
  await boundary.lifecycle.markInvoked();
  await boundary.lifecycle.settleExecution({
    outcome: 'succeeded',
    rawStatus: 'flue_succeeded',
  });
  const rendered = JSON.stringify({ kind: 'web_card', text: 'Launch brief ready.' });
  const deliveryAttemptId = await boundary.lifecycle.beforeDelivery({
    method: 'conformance_memory',
    approvedOutput: 'Launch brief ready.',
    renderedPayload: rendered,
  });
  await boundary.lifecycle.afterDelivery({
    attemptId: deliveryAttemptId,
    outcome: 'unknown',
    safeFailureCode: 'conformance_delivery_unknown',
  });

  const ambiguous = await store.getRun(admission.run.id);
  assert.equal(ambiguous?.status, 'recovery_required');
  assert.equal(ambiguous?.deliveryStatus, 'unknown');
  assert.equal(
    (await store.getContent(ambiguous!.policyApprovedOutputRef!))?.body,
    'Launch brief ready.',
  );
  assert.equal((await store.getContent(ambiguous!.renderedPayloadRef!))?.body, rendered);

  const quarantined = await store.quarantineRun({
    runId: admission.run.id,
    adminCredentialId: 'admin_credential_test',
    operatorLabel: 'Conformance operator',
    authOrigin: 'local_admin',
    safeReasonCode: 'accepted_unknown',
    requestId: 'request_conformance_recovery',
    idempotencyKey: 'quarantine_conformance_recovery',
    resolvedAt: NOW + (++tick),
  });
  assert.equal(quarantined.terminalDisposition, 'quarantined');
  assert.equal(quarantined.deliveryStatus, 'unknown');

  assert.equal(boundary.actions.executionId, boundary.lifecycle.executionId);
  assert.deepEqual(Object.keys(boundary.actions).sort(), ['executionId', 'recordOutcome', 'recordStart']);

  const workflowSubmission = conformanceSubmission();
  workflowSubmission.trigger = {
    ...workflowSubmission.trigger,
    runId: opaqueId('run', 'conformance:scheduled:1'),
    runKind: 'routine',
    kind: 'conformance_scheduled',
    ref: opaqueId('trigger', 'conformance:scheduled:1'),
    dedupeKey: opaqueId('dedupe', 'conformance:scheduled:1'),
    body: null,
  };
  workflowSubmission.execution = {
    authority: 'legacy',
    coordinatorKind: 'flue_workflow',
    authorityEpoch: 1,
  };
  workflowSubmission.audit = {
    eventId: opaqueId('audit', 'conformance:scheduled:1'),
    idempotencyKey: opaqueId('auditkey', 'conformance:scheduled:1'),
  };
  const workflowAdmission = await submitRun(store, workflowSubmission);
  const workflowBoundary = await createWorkExecutionBoundary(
    store,
    {
      ...descriptor,
      runId: workflowAdmission.run.id,
      executorKind: 'workflow',
      flueInstanceRef: opaqueId('flueinstance', 'conformance:scheduled:1'),
    },
    { now: () => NOW + (++tick) },
  );
  await workflowBoundary.lifecycle.prepareExecution('Prepared scheduled prompt');
  assert.equal(
    (await store.getRunExecution(workflowBoundary.lifecycle.executionId))?.executorKind,
    'workflow',
  );
  assert.deepEqual(
    Object.keys(workflowBoundary.actions).sort(),
    Object.keys(boundary.actions).sort(),
  );

  for (const path of ['../src/work/submit-run.ts', '../src/work/executor.ts']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from|import\()[^\n]*slack/i);
    assert.doesNotMatch(source, /workspaceId|channelId|threadTs/);
  }
});

function conformanceSubmission(): SubmitRunInput {
  const scope = 'conformance:account:conversation';
  return {
    work: {
      id: opaqueId('work', scope),
      kind: 'conversation',
      createdAt: NOW,
    },
    binding: {
      id: opaqueId('binding', scope),
      adapterKind: 'conformance',
      externalAccountId: opaqueId('account', 'conformance:account'),
      externalConversationId: opaqueId('conversation', scope),
      generation: 1,
      sourceVisibility: 'public',
      configMode: 'resolve_each_run',
      orderingKey: opaqueId('ordering', scope),
      createdAt: NOW,
    },
    trigger: {
      runId: opaqueId('run', 'conformance:message:1'),
      runKind: 'interactive',
      kind: 'conformance_message',
      ref: opaqueId('trigger', 'conformance:message:1'),
      dedupeKey: opaqueId('dedupe', 'conformance:message:1'),
      body: 'Create a launch brief.',
      createdAt: NOW,
    },
    actor: {
      ref: opaqueId('actor', 'conformance:member'),
      trustTier: 'member',
    },
    sourceContextWatermark: opaqueId('watermark', 'conformance:message:1'),
    safeConfig: {
      schemaVersion: 1,
      profileId: 'agent_company_work',
      configuredModel: 'anthropic/claude-sonnet-4-6',
      snapshotDigest: 'c'.repeat(64),
      capabilityDigest: 'd'.repeat(64),
      skillNames: [],
      connectionIds: [],
      repositoryIds: [],
      memoryMode: 'public',
      ceilings: {
        maxModelAttempts: 20,
        maxToolCalls: 1_000,
        maxActionAttempts: 0,
        timeoutMs: 900_000,
      },
    },
    execution: {
      authority: 'legacy',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
    },
    audit: {
      eventId: opaqueId('audit', 'conformance:message:1'),
      idempotencyKey: opaqueId('auditkey', 'conformance:message:1'),
    },
  };
}
