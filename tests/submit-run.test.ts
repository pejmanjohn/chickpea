import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { opaqueId } from '../src/work/admission.ts';
import {
  prepareSubmitRun,
  submitRun,
  type SubmitRunInput,
} from '../src/work/submit-run.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { WorkStateError } from '../src/work/types.ts';

const NOW = 1_910_000_000_000;

function input(overrides: Partial<SubmitRunInput> = {}): SubmitRunInput {
  const scope = overrides.binding?.id ?? opaqueId('binding', 'conformance:account:conversation');
  return {
    work: {
      id: opaqueId('work', 'conformance:account:conversation'),
      kind: 'conversation',
      createdAt: NOW,
    },
    binding: {
      id: scope,
      adapterKind: 'conformance',
      externalAccountId: opaqueId('account', 'conformance:account'),
      externalConversationId: opaqueId('conversation', 'conformance:conversation'),
      generation: 1,
      sourceVisibility: 'public',
      configMode: 'resolve_each_run',
      orderingKey: opaqueId('ordering', 'conformance:conversation'),
      createdAt: NOW,
    },
    trigger: {
      runId: opaqueId('run', 'conformance:message:1'),
      runKind: 'interactive',
      kind: 'conformance_message',
      ref: opaqueId('trigger', 'conformance:message:1'),
      dedupeKey: opaqueId('dedupe', 'conformance:message:1'),
      body: 'Prepare a launch brief.',
      createdAt: NOW,
    },
    actor: {
      ref: opaqueId('actor', 'conformance:member'),
      trustTier: 'member',
    },
    sourceContextWatermark: opaqueId('watermark', 'conformance:message:1'),
    safeConfig: {
      schemaVersion: 1,
      profileId: 'agent_default',
      configuredModel: 'anthropic/claude-sonnet-4-6',
      snapshotDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
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
    ...overrides,
  };
}

test('SubmitRun prepares only target-neutral Work ledger input', () => {
  const prepared = prepareSubmitRun(input());

  assert.equal(prepared.work.maximumSensitivity, 'public');
  assert.equal(prepared.binding.adapterKind, 'conformance');
  assert.equal(prepared.binding.workId, prepared.work.id);
  assert.equal(prepared.run.executionAuthority, 'legacy');
  assert.equal(prepared.run.actorTrustTier, 'member');
  assert.equal(prepared.triggerContent?.sensitivity, 'public');
  assert.equal(prepared.triggerContent?.body, 'Prepare a launch brief.');
  assert.equal('workspaceId' in prepared, false);
  assert.equal('channelId' in prepared, false);
  assert.equal('threadTs' in prepared, false);

  const source = readFileSync(new URL('../src/work/submit-run.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from|import\()[^\n]*slack/i);
});

test('SubmitRun derives private ceilings and rejects content with unresolved visibility', () => {
  const privatePrepared = prepareSubmitRun(input({
    binding: {
      ...input().binding,
      id: opaqueId('binding', 'conformance:private'),
      sourceVisibility: 'private',
    },
    safeConfig: { ...input().safeConfig, memoryMode: 'private' },
  }));
  assert.equal(privatePrepared.work.maximumSensitivity, 'private');
  assert.equal(privatePrepared.triggerContent?.sensitivity, 'private');

  assert.throws(
    () => prepareSubmitRun(input({
      binding: {
        ...input().binding,
        id: opaqueId('binding', 'conformance:unknown'),
        sourceVisibility: 'unknown',
      },
    })),
    (error: unknown) =>
      error instanceof WorkStateError && error.code === 'work_visibility_unresolved',
  );

  const unknownPrepared = prepareSubmitRun(input({
    binding: {
      ...input().binding,
      id: opaqueId('binding', 'conformance:unknown-empty'),
      sourceVisibility: 'unknown',
    },
    trigger: { ...input().trigger, body: null },
    safeConfig: { ...input().safeConfig, memoryMode: 'private' },
  }));
  assert.equal(unknownPrepared.work.maximumSensitivity, 'private');
  assert.equal(unknownPrepared.triggerContent, null);
});

test('SubmitRun explicitly rejects unsupported adapters before persistence', async (t) => {
  const store = new SqliteWorkStore(':memory:', { now: () => NOW });
  t.after(() => store.close());

  await assert.rejects(
    () => submitRun(store, input({
      binding: { ...input().binding, adapterKind: 'future_magic_channel' },
    })),
    (error: unknown) =>
      error instanceof WorkStateError && error.code === 'work_adapter_unsupported',
  );
  assert.equal((await store.listRuns({})).items.length, 0);
});

test('SubmitRun is idempotent and never upgrades legacy execution authority', async (t) => {
  const store = new SqliteWorkStore(':memory:', { now: () => NOW });
  t.after(() => store.close());
  const submission = input();

  const first = await submitRun(store, submission);
  const replay = await submitRun(store, submission);

  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.run.executionAuthority, 'legacy');
  assert.equal(replay.run.coordinatorKind, 'interactive');
});
