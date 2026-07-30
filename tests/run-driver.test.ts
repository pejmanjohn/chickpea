import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DurableRunDriver } from '../src/work/driver.ts';
import { opaqueId } from '../src/work/admission.ts';
import { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';
import { submitRun, type SubmitRunInput } from '../src/work/submit-run.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

const NOW = 1_930_000_000_000;

test('the dark driver refuses legacy, wrong-epoch, and Workflow authority while draining ledger fixtures', async (t) => {
  const store = new SqliteWorkStore(':memory:', { now: () => NOW });
  t.after(() => store.close());
  const legacy = await submitRun(store, submission('legacy', {
    execution: { authority: 'legacy', coordinatorKind: 'interactive', authorityEpoch: 1 },
  }));
  const workflow = await submitRun(store, submission('workflow', {
    execution: { authority: 'ledger', coordinatorKind: 'flue_workflow', authorityEpoch: 1 },
    trigger: { runKind: 'routine', kind: 'scheduled_fixture', body: null },
  }));
  const wrongEpoch = await submitRun(store, submission('wrong-epoch', {
    execution: { authority: 'ledger', coordinatorKind: 'interactive', authorityEpoch: 2 },
  }));
  const ledger = await submitRun(store, submission('ledger'));
  const handled: string[] = [];
  const driver = new DurableRunDriver(store, {
    ownerId: 'driver_test_owner',
    authorityEpoch: 1,
    leaseDurationMs: 30_000,
    maxClaims: 4,
    concurrency: 2,
    now: () => NOW + 1,
    handle: async (claim) => {
      handled.push(claim.run.id);
      return { kind: 'requeue', reasonCode: 'dark_driver_observed' };
    },
  });

  const result = await driver.drain();
  assert.deepEqual(handled, [ledger.run.id]);
  assert.deepEqual(result, { claimed: 1, completed: 0, requeued: 1, recoveryRequired: 0 });
  assert.equal((await store.getRun(legacy.run.id))?.status, 'admitted');
  assert.equal((await store.getRun(workflow.run.id))?.status, 'admitted');
  assert.equal((await store.getRun(wrongEpoch.run.id))?.status, 'admitted');
  assert.equal((await store.getRun(ledger.run.id))?.status, 'queued');
  assert.equal((await store.getRun(ledger.run.id))?.executionAuthority, 'ledger');
});

test('lease expiry is safe before submit, ambiguous after submit, and stale fencing loses', async (t) => {
  let clock = NOW;
  const store = new SqliteWorkStore(':memory:', { now: () => clock });
  t.after(() => store.close());
  const admission = await submitRun(store, submission('lease'));

  const first = await store.claimNextInteractiveRun({
    ownerId: 'driver_first', authorityEpoch: 1, leaseDurationMs: 100, claimedAt: clock,
  });
  assert.equal(first?.fencingToken, 1);
  const renewed = await store.renewRunLease({
    runId: admission.run.id,
    ownerId: 'driver_first',
    fencingToken: first!.fencingToken,
    leaseDurationMs: 100,
    renewedAt: clock,
  });
  assert.equal(renewed.leaseUntil, NOW + 100);
  clock += 101;
  const second = await store.claimNextInteractiveRun({
    ownerId: 'driver_second', authorityEpoch: 1, leaseDurationMs: 100, claimedAt: clock,
  });
  assert.equal(second?.run.id, admission.run.id);
  assert.equal(second?.fencingToken, 2);

  await store.prepareRunInput({
    runId: admission.run.id,
    sensitivity: 'public',
    body: 'Prepared input',
    preparedAt: clock + 1,
  });
  await assert.rejects(
    () => store.createRunExecution({
      id: opaqueId('execution', 'stale-worker') as never,
      runId: admission.run.id,
      attemptNumber: 1,
      fencingToken: 1,
      executorKind: 'agent',
      agentName: 'agent_driver',
      canonicalModel: 'anthropic/claude-sonnet-4-6',
      flueInstanceRef: opaqueId('flueinstance', 'stale-worker'),
      startedAt: clock + 2,
    }),
    /fencing token is stale/i,
  );
  const lifecycle = new ShadowWorkLifecycle({
    store,
    runId: admission.run.id,
    attemptNumber: second!.fencingToken,
    fencingToken: second!.fencingToken,
    agentName: 'agent_driver',
    canonicalModel: 'anthropic/claude-sonnet-4-6',
    sensitivity: 'public',
    routeEvidence: {},
    now: () => ++clock,
  });
  assert.equal(await lifecycle.prepareExecution('Prepared input'), 'Prepared input');
  await lifecycle.markInvoked();
  clock += 101;
  assert.equal(
    await store.claimNextInteractiveRun({
      ownerId: 'driver_third', authorityEpoch: 1, leaseDurationMs: 100, claimedAt: clock,
    }),
    undefined,
  );
  const recovered = await store.getRun(admission.run.id);
  assert.equal(recovered?.status, 'recovery_required');
  assert.equal(recovered?.safeFailureCode, 'execution_lease_expired_after_submit');
  await store.quarantineRun({
    runId: admission.run.id,
    adminCredentialId: 'admin_driver_test',
    operatorLabel: 'Driver test operator',
    authOrigin: 'local_admin',
    safeReasonCode: 'accepted_unknown',
    requestId: 'request_driver_quarantine',
    idempotencyKey: 'quarantine_driver_test',
    resolvedAt: ++clock,
  });
  assert.equal(
    await store.claimNextInteractiveRun({
      ownerId: 'driver_fourth', authorityEpoch: 1, leaseDurationMs: 100, claimedAt: ++clock,
    }),
    undefined,
  );
});

test('a response-ready Run enters delivery-only handling and never calls execute', async (t) => {
  let clock = NOW;
  const store = new SqliteWorkStore(':memory:', { now: () => clock });
  t.after(() => store.close());
  const admission = await submitRun(store, submission('delivery'));
  const executionClaim = await store.claimNextInteractiveRun({
    ownerId: 'driver_delivery_execution',
    authorityEpoch: 1,
    leaseDurationMs: 30_000,
    claimedAt: ++clock,
  });
  const lifecycle = new ShadowWorkLifecycle({
    store,
    runId: admission.run.id,
    attemptNumber: executionClaim!.fencingToken,
    fencingToken: executionClaim!.fencingToken,
    agentName: 'agent_driver',
    canonicalModel: 'anthropic/claude-sonnet-4-6',
    sensitivity: 'public',
    routeEvidence: {},
    now: () => ++clock,
  });
  await lifecycle.prepareExecution('Prepared input');
  await lifecycle.markInvoked();
  await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
  const attemptId = await lifecycle.beforeDelivery({
    method: 'fixture_delivery',
    approvedOutput: 'Approved output',
    renderedPayload: '{"text":"Approved output"}',
  });
  await lifecycle.afterDelivery({
    attemptId,
    outcome: 'failed',
    safeFailureCode: 'fixture_delivery_failed',
  });
  await store.releaseRunLease({
    runId: admission.run.id,
    ownerId: executionClaim!.leaseOwner,
    fencingToken: executionClaim!.fencingToken,
    outcome: 'requeue',
    reasonCode: 'fixture_delivery_retry',
    releasedAt: ++clock,
  });

  let executions = 0;
  let deliveries = 0;
  const driver = new DurableRunDriver(store, {
    ownerId: 'driver_delivery',
    authorityEpoch: 1,
    leaseDurationMs: 30_000,
    maxClaims: 1,
    concurrency: 1,
    now: () => ++clock,
    handle: async (claim) => {
      if (claim.phase === 'execute') executions += 1;
      if (claim.phase === 'delivery') deliveries += 1;
      return { kind: 'requeue', reasonCode: 'delivery_fixture_observed' };
    },
  });
  await driver.drain();
  assert.equal(executions, 0);
  assert.equal(deliveries, 1);
});

test('a file-backed driver recovers a queued Run after a Node restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-driver-'));
  const path = join(directory, 'state.sqlite');
  try {
    const firstStore = new SqliteWorkStore(path, { now: () => NOW });
    const admission = await submitRun(firstStore, submission('restart'));
    await firstStore.claimNextInteractiveRun({
      ownerId: 'driver_before_restart', authorityEpoch: 1,
      leaseDurationMs: 100, claimedAt: NOW,
    });
    firstStore.close();

    const restarted = new SqliteWorkStore(path, { now: () => NOW + 101 });
    const claim = await restarted.claimNextInteractiveRun({
      ownerId: 'driver_after_restart', authorityEpoch: 1,
      leaseDurationMs: 100, claimedAt: NOW + 101,
    });
    assert.equal(claim?.run.id, admission.run.id);
    assert.equal(claim?.fencingToken, 2);
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the active driver renews its lease while a handler is still running', async (t) => {
  const store = new SqliteWorkStore(':memory:');
  t.after(() => store.close());
  const admission = await submitRun(store, submission('heartbeat'));
  const driver = new DurableRunDriver(store, {
    ownerId: 'driver_heartbeat',
    authorityEpoch: 1,
    leaseDurationMs: 1_000,
    leaseRenewalIntervalMs: 5,
    maxClaims: 1,
    concurrency: 1,
    handle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { kind: 'requeue', reasonCode: 'heartbeat_observed' };
    },
  });

  assert.deepEqual(await driver.drain(), {
    claimed: 1, completed: 0, requeued: 1, recoveryRequired: 0,
  });
  const renewals = (await store.listAuditEvents(admission.run.id, 100))
    .filter((event) => event.eventType === 'work.run_lease_renewed');
  assert.ok(renewals.length >= 1);
});

function submission(
  suffix: string,
  overrides: {
    execution?: SubmitRunInput['execution'];
    trigger?: Partial<SubmitRunInput['trigger']>;
  } = {},
): SubmitRunInput {
  const scope = `driver:${suffix}`;
  return {
    work: { id: opaqueId('work', scope), kind: 'conversation', createdAt: NOW },
    binding: {
      id: opaqueId('binding', scope), adapterKind: 'conformance',
      externalAccountId: opaqueId('account', 'driver'),
      externalConversationId: opaqueId('conversation', scope), generation: 1,
      sourceVisibility: 'public', configMode: 'resolve_each_run',
      orderingKey: opaqueId('ordering', scope), createdAt: NOW,
    },
    trigger: {
      runId: opaqueId('run', scope), runKind: 'interactive', kind: 'driver_fixture',
      ref: opaqueId('trigger', scope), dedupeKey: opaqueId('dedupe', scope),
      body: 'Driver fixture', createdAt: NOW,
      ...overrides.trigger,
    },
    actor: { ref: opaqueId('actor', 'driver'), trustTier: 'system' },
    safeConfig: {
      schemaVersion: 1, profileId: 'agent_driver',
      configuredModel: 'anthropic/claude-sonnet-4-6',
      snapshotDigest: 'e'.repeat(64), capabilityDigest: 'f'.repeat(64),
      skillNames: [], connectionIds: [], repositoryIds: [], memoryMode: 'public',
      ceilings: { maxModelAttempts: 20, maxToolCalls: 1_000, maxActionAttempts: 0, timeoutMs: 900_000 },
    },
    execution: overrides.execution ?? {
      authority: 'ledger', coordinatorKind: 'interactive', authorityEpoch: 1,
    },
    audit: {
      eventId: opaqueId('audit', scope), idempotencyKey: opaqueId('auditkey', scope),
    },
  };
}
