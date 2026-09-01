import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  JournalOperatorChallengeLedger,
  OperatorChallengeError,
  OperatorDriver,
} from '../qa/live/drivers/operator.ts';
import { aggregateRunReport, finalizeRunReport } from '../qa/live/report.ts';
import {
  CleanupSafetyError,
  PRODUCT_RESOURCE_KINDS,
  beginCleanup,
  deriveCleanupPlan,
  projectProductLedger,
  projectResourceLedger,
  recordAssertionTokens,
  recordBaselineFact,
  recordCleanupReceipt,
  recordCleanupReadback,
  recordMutationReceipt,
  recordUnresolvedOutcome,
  verifyPostflight,
  type CleanupTarget,
  type MutationReceiptInput,
} from '../qa/live/safety/cleanup.ts';
import {
  appendRunJournal,
  createRunJournal,
  readRunJournal,
} from '../qa/live/safety/journal.ts';

const HEADER = {
  runId: 'run-cleanup-001',
  manifestDigest: 'sha256:manifest',
  targetFingerprint: 'sha256:target',
  repositoryRevision: '0123456789abcdef',
  servingVersion: 'version-1',
  suite: 'case' as const,
  variantIds: ['LC01-V1-create-welcome'],
  createdAt: '2026-09-01T12:00:00.000Z',
};
const VARIANT_ID = 'LC01-V1-create-welcome';

function setup(context: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-live-cleanup-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'run.jsonl');
  createRunJournal(path, HEADER);
  return path;
}

type MutationReceiptOverrides = {
  [Key in keyof MutationReceiptInput]?: MutationReceiptInput[Key] | undefined;
};

function receipt(overrides: MutationReceiptOverrides = {}): MutationReceiptInput {
  return Object.fromEntries(Object.entries({
    receiptId: 'receipt-agent-001',
    caseId: 'LC01-V1-create-welcome',
    stepId: 'create-agent',
    attempt: 1,
    targetAlias: 'dedicated-qa',
    actionChallengeDigest: 'sha256:challenge-001',
    operatorReceiptDigest: 'sha256:operator-receipt-001',
    beforeStateDigest: 'sha256:absent',
    immutableId: 'agent_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    beforeRevision: 'absent',
    revision: 'revision-1',
    resourceKind: 'agent' as const,
    mutation: 'create' as const,
    fixtureClass: 'run_owned' as const,
    cleanupStrategy: 'exact_reversal' as const,
    reversalActionId: 'agent.archive' as const,
    direction: 'forward' as const,
    ...overrides,
  }).filter(([, value]) => value !== undefined)) as unknown as MutationReceiptInput;
}

function issueChallenge(
  path: string,
  input: {
    challengeDigest: string;
    caseId: string;
    stepId: string;
    attempt: number;
    expectedRevision: string;
    mutation: MutationReceiptInput['mutation'];
    targetAlias: string;
  },
): void {
  appendRunJournal(path, {
    type: 'operator_challenge_issued',
    ...input,
    actorAlias: 'qa-owner',
    expectedRole: 'owner',
    browserProfileAlias: 'qa-owner-profile',
    expiresAt: Date.parse('2026-09-01T12:05:00.000Z'),
  }, HEADER);
}

function completeChallenge(path: string, challengeDigest: string, operatorReceiptDigest: string): void {
  appendRunJournal(path, { type: 'operator_challenge_consumed', challengeDigest }, HEADER);
  appendRunJournal(path, {
    type: 'operator_challenge_completed', challengeDigest, operatorReceiptDigest,
  }, HEADER);
}

function recordBoundMutation(path: string, input: MutationReceiptInput) {
  issueChallenge(path, {
    challengeDigest: input.actionChallengeDigest,
    caseId: input.caseId,
    stepId: input.stepId,
    attempt: input.attempt,
    expectedRevision: input.beforeRevision,
    mutation: input.mutation,
    targetAlias: input.targetAlias,
  });
  completeChallenge(path, input.actionChallengeDigest, input.operatorReceiptDigest);
  return recordMutationReceipt(path, input, HEADER);
}

function issueCleanupChallenge(path: string, target: CleanupTarget, challengeDigest: string): void {
  issueChallenge(path, {
    challengeDigest,
    caseId: target.caseId,
    stepId: `${target.stepId}:cleanup`,
    attempt: target.attempt,
    expectedRevision: target.expectedRevision,
    mutation: target.mutation,
    targetAlias: target.targetAlias,
  });
}

test('the journal projects the closed product taxonomy and content-free proof records', (context) => {
  const path = setup(context);
  const kinds = [...PRODUCT_RESOURCE_KINDS];
  kinds.forEach((resourceKind, index) => {
    recordBoundMutation(path, {
      ...receipt({
        receiptId: `receipt-${index + 1}`,
        stepId: `step-${index + 1}`,
        immutableId: `resource_${index + 1}`,
        resourceKind,
        actionChallengeDigest: `sha256:challenge-${index + 1}`,
        operatorReceiptDigest: `sha256:operator-receipt-${index + 1}`,
      }),
    });
  });
  recordAssertionTokens(path, {
    caseId: VARIANT_ID,
    stepId: 'observe-agent',
    observerId: 'agent.read',
    expectedTokens: ['agent.exists'],
    observedTokens: ['agent.exists'],
    pollAttempt: 2,
    pollElapsedMs: 350,
  }, HEADER);

  const ledger = projectProductLedger(readRunJournal(path, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
  }));
  assert.deepEqual(new Set(ledger.mutations.map((entry) => entry.resourceKind)), new Set(kinds));
  const resources = projectResourceLedger(readRunJournal(path, {
    runId: HEADER.runId,
    manifestDigest: HEADER.manifestDigest,
  }));
  assert.deepEqual(new Set(resources.map((entry) => entry.resourceKind)), new Set(kinds));
  assert.equal(resources.every((entry) => entry.state === 'mutation_recorded'), true);
  assert.equal(ledger.assertions.length, 1);
  assert.equal(JSON.stringify(ledger).includes('Create the run-marked'), false);
});

test('cleanup accepts only an exact declared run-owned target and is idempotent across resume', (context) => {
  const path = setup(context);
  recordBoundMutation(path, receipt());
  const [target] = deriveCleanupPlan(path, HEADER);
  assert.ok(target);
  assert.equal(target?.operation, 'agent.archive');

  issueCleanupChallenge(path, target!, 'sha256:cleanup-challenge-001');
  const intent = beginCleanup(path, target!, {
    currentRevision: 'revision-1',
    actionChallengeDigest: 'sha256:cleanup-challenge-001',
  }, HEADER);
  const resumedIntent = beginCleanup(path, target!, {
    currentRevision: 'revision-1',
    actionChallengeDigest: 'sha256:cleanup-challenge-001',
  }, HEADER);
  assert.deepEqual(resumedIntent, intent);

  completeChallenge(path, 'sha256:cleanup-challenge-001', 'sha256:cleanup-operator-receipt-001');
  const completed = recordCleanupReceipt(path, {
    cleanupIntentId: intent.cleanupIntentId,
    receiptId: 'cleanup-receipt-001',
    actionChallengeDigest: 'sha256:cleanup-challenge-001',
    operatorReceiptDigest: 'sha256:cleanup-operator-receipt-001',
    immutableId: target!.immutableId,
    priorRevision: 'revision-1',
    resultingRevision: 'absent',
    resultingStateDigest: 'sha256:absent',
    outcome: 'absent',
  }, HEADER);
  assert.deepEqual(recordCleanupReceipt(path, {
    cleanupIntentId: intent.cleanupIntentId,
    receiptId: 'cleanup-receipt-001',
    actionChallengeDigest: 'sha256:cleanup-challenge-001',
    operatorReceiptDigest: 'sha256:cleanup-operator-receipt-001',
    immutableId: target!.immutableId,
    priorRevision: 'revision-1',
    resultingRevision: 'absent',
    resultingStateDigest: 'sha256:absent',
    outcome: 'absent',
  }, HEADER), completed);

  assert.deepEqual(deriveCleanupPlan(path, HEADER), []);
  assert.throws(() => beginCleanup(path, { ...target!, immutableId: '*' }, {
    currentRevision: 'revision-1', actionChallengeDigest: 'sha256:cleanup-challenge-002',
  }, HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'INVALID_EXACT_ID');
  assert.throws(() => beginCleanup(path, { ...target!, immutableId: 'Friendly Agent' }, {
    currentRevision: 'revision-1', actionChallengeDigest: 'sha256:cleanup-challenge-002',
  }, HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'INVALID_EXACT_ID');
  assert.throws(() => beginCleanup(path, { ...target!, immutableId: 'agent_foreign' }, {
    currentRevision: 'revision-1', actionChallengeDigest: 'sha256:cleanup-challenge-002',
  }, HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'UNDECLARED_CLEANUP');
});

test('ambiguous cleanup keeps its exact ID in readback recovery and cannot be replayed or overwritten', (context) => {
  const path = setup(context);
  recordBoundMutation(path, receipt());
  const [target] = deriveCleanupPlan(path, HEADER);
  issueCleanupChallenge(path, target!, 'sha256:cleanup-ambiguous-challenge');
  const intent = beginCleanup(path, target!, {
    currentRevision: 'revision-1', actionChallengeDigest: 'sha256:cleanup-ambiguous-challenge',
  }, HEADER);
  completeChallenge(path, 'sha256:cleanup-ambiguous-challenge', 'sha256:cleanup-ambiguous-operator-receipt');
  recordCleanupReceipt(path, {
    cleanupIntentId: intent.cleanupIntentId,
    receiptId: 'cleanup-ambiguous-receipt',
    actionChallengeDigest: 'sha256:cleanup-ambiguous-challenge',
    operatorReceiptDigest: 'sha256:cleanup-ambiguous-operator-receipt',
    immutableId: target!.immutableId,
    priorRevision: 'revision-1',
    resultingRevision: 'unknown',
    resultingStateDigest: 'sha256:unknown',
    outcome: 'ambiguous',
  }, HEADER);

  const [recovery] = deriveCleanupPlan(path, HEADER);
  assert.equal(recovery?.mutationReceiptId, target?.mutationReceiptId);
  assert.equal(recovery?.resolution, 'authoritative_readback');
  assert.throws(() => beginCleanup(path, recovery!, {
    currentRevision: 'revision-1', actionChallengeDigest: 'sha256:new-cleanup-challenge',
  }, HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'CLEANUP_AMBIGUOUS');
  assert.throws(() => recordCleanupReceipt(path, {
    cleanupIntentId: intent.cleanupIntentId,
    receiptId: 'cleanup-conflicting-receipt',
    actionChallengeDigest: 'sha256:cleanup-ambiguous-challenge',
    operatorReceiptDigest: 'sha256:cleanup-ambiguous-operator-receipt',
    immutableId: target!.immutableId,
    priorRevision: 'revision-1',
    resultingRevision: 'absent',
    resultingStateDigest: 'sha256:absent',
    outcome: 'absent',
  }, HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'DUPLICATE_RECEIPT');

  const unresolved = verifyPostflight(path, {
    identity: {
      targetFingerprint: HEADER.targetFingerprint,
      repositoryRevision: HEADER.repositoryRevision,
      servingVersion: HEADER.servingVersion,
    },
    declaredResourceKinds: ['agent'],
    inventory: [],
  }, HEADER);
  assert.equal(unresolved.status, 'failed');
  assert.deepEqual(unresolved.unresolvedAliases, ['agent:unresolved:1', 'cleanup:ambiguous:1']);

  recordCleanupReadback(path, {
    cleanupIntentId: intent.cleanupIntentId,
    cleanupReceiptId: 'cleanup-ambiguous-receipt',
    readbackId: 'cleanup-readback-001',
    observerId: 'agent.read',
    immutableId: target!.immutableId,
    observedRevision: 'absent',
    observedStateDigest: 'sha256:absent',
    outcome: 'absent',
  }, HEADER);
  assert.deepEqual(deriveCleanupPlan(path, HEADER), []);
});

test('resettable fixtures restore the exact baseline revision and refuse revision drift', (context) => {
  const path = setup(context);
  recordBaselineFact(path, {
    caseId: 'LC01-V2-update-approve',
    stepId: 'baseline-agent',
    targetAlias: 'dedicated-qa',
    immutableId: 'agent_baseline_01',
    revision: 'revision-7',
    stateDigest: 'sha256:agent-before',
    resourceKind: 'agent',
    fixtureClass: 'resettable_fixture',
  }, HEADER);
  recordBoundMutation(path, receipt({
    receiptId: 'receipt-agent-update',
    caseId: 'LC01-V2-update-approve',
    stepId: 'update-agent',
    immutableId: 'agent_baseline_01',
    beforeRevision: 'revision-7',
    beforeStateDigest: 'sha256:agent-before',
    revision: 'revision-8',
    mutation: 'update',
    fixtureClass: 'resettable_fixture',
    cleanupStrategy: 'revision_restore',
    reversalActionId: 'agent.update',
  }));
  const [target] = deriveCleanupPlan(path, HEADER);
  assert.deepEqual(target && {
    expectedRevision: target.expectedRevision,
    restoreRevision: target.restoreRevision,
    restoreStateDigest: target.restoreStateDigest,
  }, {
    expectedRevision: 'revision-8',
    restoreRevision: 'revision-7',
    restoreStateDigest: 'sha256:agent-before',
  });
  assert.throws(() => beginCleanup(path, target!, {
    currentRevision: 'revision-9', actionChallengeDigest: 'sha256:cleanup-challenge-restore',
  }, HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'REVISION_DRIFT');
});

test('immutable baselines cannot be mutated and attributed residue requires exact retained-state proof', (context) => {
  const path = setup(context);
  assert.throws(() => recordMutationReceipt(path, receipt({
    immutableId: 'agent_baseline_immutable',
    fixtureClass: 'immutable_baseline',
    cleanupStrategy: 'not_required',
    reversalActionId: undefined,
  }), HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'IMMUTABLE_MUTATION');

  recordBoundMutation(path, receipt({
    receiptId: 'receipt-residue',
    immutableId: 'agent_tombstone_01',
    resourceKind: 'attributed_residue',
    mutation: 'archive',
    fixtureClass: 'attributed_residue',
    cleanupStrategy: 'attributed_residue',
    reversalActionId: undefined,
    expectedResidueStateDigest: 'sha256:archived-no-route',
  }));
  const [target] = deriveCleanupPlan(path, HEADER);
  assert.equal(target?.operation, 'verify_retained');
  issueCleanupChallenge(path, target!, 'sha256:residue-challenge');
  const intent = beginCleanup(path, target!, {
    currentRevision: 'revision-1', actionChallengeDigest: 'sha256:residue-challenge',
  }, HEADER);
  completeChallenge(path, 'sha256:residue-challenge', 'sha256:residue-operator-receipt');
  assert.throws(() => recordCleanupReceipt(path, {
    cleanupIntentId: intent.cleanupIntentId,
    receiptId: 'cleanup-residue-01',
    actionChallengeDigest: 'sha256:residue-challenge',
    operatorReceiptDigest: 'sha256:residue-operator-receipt',
    immutableId: target!.immutableId,
    priorRevision: 'revision-1',
    resultingRevision: 'revision-1',
    resultingStateDigest: 'sha256:wrong-state',
    outcome: 'retained',
  }, HEADER), (error: unknown) => error instanceof CleanupSafetyError && error.code === 'RESIDUE_MISMATCH');
});

test('partial cleanup remains exact, produces cleanup_failed, and preserves the product verdict', (context) => {
  const path = setup(context);
  recordBoundMutation(path, receipt());
  recordUnresolvedOutcome(path, {
    caseId: VARIANT_ID,
    stepId: 'cleanup-agent',
    attempt: 1,
    referenceId: 'receipt-agent-001',
    category: 'cleanup_ambiguous',
  }, HEADER);
  const ledger = projectProductLedger(readRunJournal(path, {
    runId: HEADER.runId, manifestDigest: HEADER.manifestDigest,
  }));
  assert.deepEqual(ledger.unresolved.map((entry) => entry.referenceId), ['receipt-agent-001']);

  const report = aggregateRunReport({
    suite: 'case',
    manifestDigest: HEADER.manifestDigest,
    targetFingerprint: HEADER.targetFingerprint,
    repositoryRevision: HEADER.repositoryRevision,
    servingVersion: HEADER.servingVersion,
    declaredVariantIds: HEADER.variantIds,
    cases: [{
      variantId: VARIANT_ID,
      primary: { result: 'fail', reason: 'assertion_failed' },
      cleanup: 'failed',
    }],
  });
  assert.equal(report.aggregate, 'cleanup_failed');
  assert.deepEqual(report.cases[0]?.primary, { result: 'fail', reason: 'assertion_failed' });
});

test('postflight rejects target drift, missing baseline, and unmatched run-window effects', (context) => {
  const path = setup(context);
  recordBaselineFact(path, {
    caseId: VARIANT_ID, stepId: 'baseline', targetAlias: 'dedicated-qa',
    immutableId: 'agent_baseline_01', revision: 'revision-1', stateDigest: 'sha256:baseline',
    resourceKind: 'agent', fixtureClass: 'immutable_baseline',
  }, HEADER);
  const failed = verifyPostflight(path, {
    identity: {
      targetFingerprint: 'sha256:changed-target',
      repositoryRevision: HEADER.repositoryRevision,
      servingVersion: HEADER.servingVersion,
    },
    declaredResourceKinds: ['agent'],
    inventory: [{
      resourceKind: 'agent', immutableId: 'agent_unexpected', revision: 'revision-1',
      stateDigest: 'sha256:unexpected', fixtureClass: 'run_owned',
    }],
  }, HEADER);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.targetIdentityMatches, false);
  assert.deepEqual(failed.missingAliases, ['agent:baseline:1']);
  assert.deepEqual(failed.unexpectedAliases, ['agent:unexpected:1']);
  const initiallyPassing = aggregateRunReport({
    suite: 'case', manifestDigest: HEADER.manifestDigest,
    targetFingerprint: HEADER.targetFingerprint, repositoryRevision: HEADER.repositoryRevision,
    servingVersion: HEADER.servingVersion, declaredVariantIds: HEADER.variantIds,
    cases: [{ variantId: VARIANT_ID, primary: { result: 'pass' }, cleanup: 'pass' }],
  });
  const finalized = finalizeRunReport(initiallyPassing, failed);
  assert.equal(finalized.aggregate, 'cleanup_failed');
  assert.equal(finalized.cases[0]?.primary.result, 'pass');
});

test('journal-backed operator challenges survive driver recreation without persisting action text or nonce', (context) => {
  const path = setup(context);
  const ledgerA = new JournalOperatorChallengeLedger(path, HEADER);
  const driverA = new OperatorDriver(ledgerA, {
    now: () => Date.parse('2026-09-01T12:00:01.000Z'),
  });
  const action = driverA.issue({
    runId: HEADER.runId,
    caseId: VARIANT_ID,
    stepId: 'create-agent',
    attempt: 1,
    expectedRevision: 'absent',
    mutation: 'create',
    targetAlias: 'dedicated-qa',
    actorAlias: 'qa-owner',
    expectedRole: 'owner',
    browserProfileAlias: 'qa-owner-profile',
    semanticAction: 'Create a private customer-named Agent.',
    completionSignal: 'The private customer-named Agent exists.',
    expiresAt: Date.parse('2026-09-01T12:05:00.000Z'),
  });
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(action.challengeId), false);
  assert.equal(raw.includes('private customer-named'), false);
  assert.equal(raw.includes('semanticAction'), false);
  assert.equal(raw.includes('completionSignal'), false);

  const driverB = new OperatorDriver(new JournalOperatorChallengeLedger(path, HEADER), {
    now: () => Date.parse('2026-09-01T12:00:02.000Z'),
  });
  driverB.complete({
    challengeId: action.challengeId,
    runId: action.runId,
    caseId: action.caseId,
    stepId: action.stepId,
    attempt: action.attempt,
    expectedRevision: action.expectedRevision,
    mutation: action.mutation,
    actorAlias: action.actorAlias,
    expectedRole: action.expectedRole,
    browserProfileAlias: action.browserProfileAlias,
    receiptId: 'receipt-driver-001',
  });
  assert.equal(readFileSync(path, 'utf8').includes('receipt-driver-001'), false);
  const driverC = new OperatorDriver(new JournalOperatorChallengeLedger(path, HEADER), {
    now: () => Date.parse('2026-09-01T12:00:03.000Z'),
  });
  assert.throws(() => driverC.complete({
    challengeId: action.challengeId,
    runId: action.runId,
    caseId: action.caseId,
    stepId: action.stepId,
    attempt: action.attempt,
    expectedRevision: action.expectedRevision,
    mutation: action.mutation,
    actorAlias: action.actorAlias,
    expectedRole: action.expectedRole,
    browserProfileAlias: action.browserProfileAlias,
    receiptId: 'receipt-driver-002',
  }), (error: unknown) => error instanceof OperatorChallengeError && error.code === 'CHALLENGE_REPLAYED');
});
