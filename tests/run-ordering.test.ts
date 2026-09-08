import assert from 'node:assert/strict';
import { test } from 'node:test';

import { opaqueId } from '../src/work/admission.ts';
import { submitRun, type SubmitRunInput } from '../src/work/submit-run.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

const NOW = 1_940_000_000_000;

test('same ordering key claims in admission order while unrelated bindings remain claimable', async (t) => {
  const store = new SqliteWorkStore(':memory:', { now: () => NOW });
  t.after(() => store.close());
  const first = await submitRun(store, submission('first', 'shared', NOW));
  const second = await submitRun(store, submission('second', 'shared', NOW + 1));
  const unrelated = await submitRun(store, submission('unrelated', 'other', NOW + 2));

  const claimA = await store.claimNextInteractiveRun({
    ownerId: 'driver_a', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: NOW + 3,
  });
  const claimB = await store.claimNextInteractiveRun({
    ownerId: 'driver_b', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: NOW + 3,
  });
  const blocked = await store.claimNextInteractiveRun({
    ownerId: 'driver_c', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: NOW + 3,
  });

  assert.equal(claimA?.run.id, first.run.id);
  assert.equal(claimB?.run.id, unrelated.run.id);
  assert.equal(blocked, undefined);
  await store.releaseRunLease({
    runId: first.run.id, ownerId: 'driver_a', fencingToken: claimA!.fencingToken,
    outcome: 'settled', terminalDisposition: 'skipped', reasonCode: 'ordering_fixture_done',
    releasedAt: NOW + 4,
  });
  const claimSecond = await store.claimNextInteractiveRun({
    ownerId: 'driver_c', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: NOW + 5,
  });
  assert.equal(claimSecond?.run.id, second.run.id);
});

test('two Bindings on one Work block only when their ordering keys match', async (t) => {
  const store = new SqliteWorkStore(':memory:', { now: () => NOW });
  t.after(() => store.close());
  const workId = opaqueId('work', 'shared-work');
  const first = await submitRun(store, submission('binding-a', 'ordering-a', NOW, workId));
  const second = await submitRun(store, submission('binding-b', 'ordering-b', NOW + 1, workId));
  const claimA = await store.claimNextInteractiveRun({
    ownerId: 'driver_a', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: NOW + 2,
  });
  const claimB = await store.claimNextInteractiveRun({
    ownerId: 'driver_b', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: NOW + 2,
  });
  assert.deepEqual(new Set([claimA?.run.id, claimB?.run.id]), new Set([first.run.id, second.run.id]));
});

test('an unfinished legacy Run cannot block a later ledger Run on the same ordering key', async (t) => {
  const store = new SqliteWorkStore(':memory:', { now: () => NOW });
  t.after(() => store.close());
  const legacyInput = submission('legacy', 'promoted-channel', NOW);
  legacyInput.execution.authority = 'legacy';
  const legacy = await submitRun(store, legacyInput);
  const ledger = await submitRun(store, submission('ledger', 'promoted-channel', NOW + 1));

  const claim = await store.claimNextInteractiveRun({
    ownerId: 'driver_promoted', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: NOW + 2,
  });

  assert.equal((await store.getRun(legacy.run.id))?.status, 'admitted');
  assert.equal(claim?.run.id, ledger.run.id);
});

function submission(
  suffix: string,
  ordering: string,
  createdAt: number,
  workId = opaqueId('work', `ordering:${suffix}`),
): SubmitRunInput {
  return {
    work: { id: workId, kind: 'conversation', createdAt: NOW },
    binding: {
      id: opaqueId('binding', `ordering:${suffix}`), adapterKind: 'conformance',
      externalAccountId: opaqueId('account', 'ordering'),
      externalConversationId: opaqueId('conversation', `ordering:${suffix}`), generation: 1,
      sourceVisibility: 'public', configMode: 'resolve_each_run',
      orderingKey: opaqueId('ordering', ordering), createdAt: NOW,
    },
    trigger: {
      runId: opaqueId('run', `ordering:${suffix}`), runKind: 'interactive',
      kind: 'ordering_fixture', ref: opaqueId('trigger', `ordering:${suffix}`),
      dedupeKey: opaqueId('dedupe', `ordering:${suffix}`), body: suffix, createdAt,
    },
    actor: { ref: opaqueId('actor', 'ordering'), trustTier: 'system' },
    safeConfig: {
      schemaVersion: 1, profileId: 'agent_ordering',
      configuredModel: 'anthropic/claude-sonnet-4-6',
      snapshotDigest: '1'.repeat(64), capabilityDigest: '2'.repeat(64),
      skillNames: [], connectionIds: [], repositoryIds: [], memoryMode: 'public',
      ceilings: { maxModelAttempts: 20, maxToolCalls: 1_000, maxActionAttempts: 0, timeoutMs: 900_000 },
    },
    execution: { authority: 'ledger', coordinatorKind: 'interactive', authorityEpoch: 1 },
    audit: {
      eventId: opaqueId('audit', `ordering:${suffix}`),
      idempotencyKey: opaqueId('auditkey', `ordering:${suffix}`),
    },
  };
}
