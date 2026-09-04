import { createHash } from 'node:crypto';

import type {
  ActionId,
  AssertionToken,
  CleanupStrategy,
  FixtureClass,
  MutationClass,
  ObserverId,
} from '../schema.ts';
import {
  PRODUCT_RESOURCE_KINDS,
  appendRunJournal,
  readRunJournal,
  validateRunJournalEventData,
  type CleanupOperation,
  type CleanupReceiptOutcome,
  type ProductResourceKind,
  type ReadJournalResult,
  type RunJournalEvent,
  type RunJournalEventData,
  type RunJournalHeaderInput,
  type UnresolvedCategory,
} from './journal.ts';

export { PRODUCT_RESOURCE_KINDS } from './journal.ts';

type JournalIdentity = Pick<RunJournalHeaderInput, 'runId' | 'manifestDigest'>;

export type BaselineFact = Extract<RunJournalEventData, { type: 'baseline_fact' }>;
export type MutationReceipt = Extract<RunJournalEventData, { type: 'mutation_receipt' }>;
export type CleanupIntentRecord = Extract<RunJournalEventData, { type: 'cleanup_intent' }>;
export type CleanupReceipt = Extract<RunJournalEventData, { type: 'cleanup_receipt' }>;
export type CleanupReadback = Extract<RunJournalEventData, { type: 'cleanup_readback' }>;
export type AssertionTokenRecord = Extract<RunJournalEventData, { type: 'assertion_tokens' }>;
export type UnresolvedOutcome = Extract<RunJournalEventData, { type: 'unresolved_outcome' }>;

export interface BaselineFactInput {
  caseId: string;
  stepId: string;
  targetAlias: string;
  immutableId: string;
  revision: string;
  stateDigest: string;
  resourceKind: ProductResourceKind;
  fixtureClass: 'immutable_baseline' | 'resettable_fixture';
}

export interface MutationReceiptInput {
  receiptId: string;
  caseId: string;
  stepId: string;
  attempt: number;
  targetAlias: string;
  actionChallengeDigest: string;
  operatorReceiptDigest: string;
  beforeStateDigest: string;
  immutableId: string;
  beforeRevision: string;
  revision: string;
  stateDigest: string;
  resourceKind: ProductResourceKind;
  mutation: MutationClass;
  fixtureClass: FixtureClass;
  cleanupStrategy: CleanupStrategy;
  reversalActionId?: ActionId;
  direction: 'forward' | 'reversal';
  /** This receipt certifies recovery observation, not the interrupted click. */
  recoveryReadback?: true;
  expectedResidueStateDigest?: string;
}

export interface AssertionTokensInput {
  caseId: string;
  stepId: string;
  observerId: ObserverId;
  expectedTokens: AssertionToken[];
  observedTokens: AssertionToken[];
  pollAttempt: number;
  pollElapsedMs: number;
  pending?: boolean;
}

export interface UnresolvedOutcomeInput {
  caseId: string;
  stepId: string;
  attempt: number;
  referenceId: string;
  category: UnresolvedCategory;
}

export interface CleanupTarget {
  mutationReceiptId: string;
  caseId: string;
  stepId: string;
  attempt: number;
  targetAlias: string;
  immutableId: string;
  resourceKind: ProductResourceKind;
  fixtureClass: FixtureClass;
  operation: CleanupOperation;
  mutation: MutationClass;
  expectedRevision: string;
  resolution: 'execute' | 'authoritative_readback';
  restoreRevision?: string;
  restoreStateDigest?: string;
  expectedResidueStateDigest?: string;
}

export interface CleanupReceiptInput {
  cleanupIntentId: string;
  receiptId: string;
  actionChallengeDigest: string;
  operatorReceiptDigest: string;
  immutableId: string;
  priorRevision: string;
  resultingRevision: string;
  resultingStateDigest: string;
  outcome: CleanupReceiptOutcome;
}

export interface CleanupReadbackInput {
  cleanupIntentId: string;
  /** Absent only when the process died before any cleanup receipt was durable. */
  cleanupReceiptId?: string;
  readbackId: string;
  observerId: ObserverId;
  immutableId: string;
  observedRevision: string;
  observedStateDigest: string;
  outcome: CleanupReceiptOutcome;
}

export interface ProductLedgerProjection {
  baselines: BaselineFact[];
  mutations: MutationReceipt[];
  cleanupIntents: CleanupIntentRecord[];
  cleanupReceipts: CleanupReceipt[];
  cleanupReadbacks: CleanupReadback[];
  assertions: AssertionTokenRecord[];
  unresolved: UnresolvedOutcome[];
}

export interface ResourceLedgerEntry {
  source: 'baseline' | 'mutation';
  resourceKind: ProductResourceKind;
  immutableId: string;
  fixtureClass: FixtureClass;
  targetAlias: string;
  revision: string;
  sourceRecordId: string;
  state: 'baseline' | 'mutation_recorded' | 'cleanup_pending' | 'cleanup_ambiguous' | 'cleanup_verified';
}

export type CleanupSafetyErrorCode =
  | 'INVALID_EXACT_ID'
  | 'INVALID_CLEANUP_CONTRACT'
  | 'IMMUTABLE_MUTATION'
  | 'MISSING_BASELINE'
  | 'BASELINE_MISMATCH'
  | 'DUPLICATE_RECEIPT'
  | 'CHALLENGE_MISMATCH'
  | 'UNDECLARED_CLEANUP'
  | 'REVISION_DRIFT'
  | 'CLEANUP_RECEIPT_MISMATCH'
  | 'CLEANUP_AMBIGUOUS'
  | 'RESIDUE_MISMATCH';

export class CleanupSafetyError extends Error {
  readonly code: CleanupSafetyErrorCode;

  constructor(code: CleanupSafetyErrorCode) {
    super(code);
    this.name = 'CleanupSafetyError';
    this.code = code;
  }
}

export function recordBaselineFact(
  path: string,
  input: BaselineFactInput,
  identity: JournalIdentity,
): BaselineFact {
  requireExactId(input.immutableId);
  const event: BaselineFact = { type: 'baseline_fact', ...input };
  const journal = read(path, identity);
  const duplicate = eventValues(journal, 'baseline_fact')
    .find((candidate) => candidate.resourceKind === input.resourceKind && candidate.immutableId === input.immutableId);
  if (duplicate !== undefined) {
    if (!same(duplicate, event)) fail('BASELINE_MISMATCH');
    return duplicate;
  }
  appendRunJournal(path, event, identity);
  return event;
}

export function recordMutationReceipt(
  path: string,
  input: MutationReceiptInput,
  identity: JournalIdentity,
): MutationReceipt {
  const event = validateMutationReceipt(path, input, identity, 'completed');
  const duplicate = eventValues(read(path, identity), 'mutation_receipt')
    .find((candidate) => candidate.receiptId === input.receiptId);
  if (duplicate === undefined) appendRunJournal(path, event, identity);
  return event;
}

/** Validates the full resource and baseline binding before consuming/completing its challenge. */
export function validatePendingMutationReceipt(
  path: string,
  input: MutationReceiptInput,
  identity: JournalIdentity,
): void {
  validateMutationReceipt(path, input, identity, 'issued');
}

function validateMutationReceipt(
  path: string,
  input: MutationReceiptInput,
  identity: JournalIdentity,
  phase: 'issued' | 'completed',
): MutationReceipt {
  requireExactId(input.receiptId);
  requireExactId(input.immutableId);
  validateMutationContract(input);
  const journal = read(path, identity);
  const duplicate = eventValues(journal, 'mutation_receipt')
    .find((candidate) => candidate.receiptId === input.receiptId);
  const event: MutationReceipt = optionalEvent({ type: 'mutation_receipt', ...input });
  validateRunJournalEventData(event);
  if (duplicate !== undefined) {
    if (!same(duplicate, event)) fail('DUPLICATE_RECEIPT');
    return duplicate;
  }
  const existingBaseline = eventValues(journal, 'baseline_fact').find((candidate) =>
    candidate.resourceKind === input.resourceKind && candidate.immutableId === input.immutableId
  );
  if (existingBaseline?.fixtureClass === 'immutable_baseline') fail('IMMUTABLE_MUTATION');
  if (existingBaseline !== undefined && input.fixtureClass !== 'resettable_fixture') fail('BASELINE_MISMATCH');
  if (input.fixtureClass === 'resettable_fixture') {
    const baseline = existingBaseline;
    if (baseline === undefined) fail('MISSING_BASELINE');
    const previous = eventValues(journal, 'mutation_receipt').filter((candidate) =>
      candidate.resourceKind === input.resourceKind
      && candidate.immutableId === input.immutableId
      && candidate.fixtureClass === 'resettable_fixture'
      && candidate.direction === 'forward'
    ).at(-1);
    const expectedRevision = previous?.revision ?? baseline.revision;
    const expectedStateDigest = previous?.stateDigest ?? baseline.stateDigest;
    if (expectedRevision !== input.beforeRevision || expectedStateDigest !== input.beforeStateDigest) {
      fail('BASELINE_MISMATCH');
    }
  }
  requireChallengeBinding(journal, {
    challengeDigest: input.actionChallengeDigest,
    operatorReceiptDigest: input.operatorReceiptDigest,
    caseId: input.caseId,
    stepId: input.stepId,
    attempt: input.attempt,
    expectedRevision: input.beforeRevision,
    mutation: input.mutation,
    targetAlias: input.targetAlias,
    resourceBindingDigest: exactResourceBindingDigest(input),
  }, phase);
  return event;
}

export function recordAssertionTokens(
  path: string,
  input: AssertionTokensInput,
  identity: JournalIdentity,
): AssertionTokenRecord {
  const event: AssertionTokenRecord = {
    type: 'assertion_tokens',
    ...input,
    expectedTokens: [...input.expectedTokens],
    observedTokens: [...input.observedTokens],
  };
  appendRunJournal(path, event, identity);
  return event;
}

export function recordUnresolvedOutcome(
  path: string,
  input: UnresolvedOutcomeInput,
  identity: JournalIdentity,
): UnresolvedOutcome {
  requireExactId(input.referenceId);
  const event: UnresolvedOutcome = { type: 'unresolved_outcome', ...input };
  appendRunJournal(path, event, identity);
  return event;
}

export function projectProductLedger(journal: ReadJournalResult): ProductLedgerProjection {
  return {
    baselines: eventValues(journal, 'baseline_fact'),
    mutations: eventValues(journal, 'mutation_receipt'),
    cleanupIntents: eventValues(journal, 'cleanup_intent'),
    cleanupReceipts: eventValues(journal, 'cleanup_receipt'),
    cleanupReadbacks: eventValues(journal, 'cleanup_readback'),
    assertions: eventValues(journal, 'assertion_tokens'),
    unresolved: eventValues(journal, 'unresolved_outcome'),
  };
}

/** Rebuildable exact-ID resource view; the run journal remains the only writer. */
export function projectResourceLedger(journal: ReadJournalResult): ResourceLedgerEntry[] {
  const product = projectProductLedger(journal);
  const baselines: ResourceLedgerEntry[] = product.baselines.map((baseline) => ({
    source: 'baseline',
    resourceKind: baseline.resourceKind,
    immutableId: baseline.immutableId,
    fixtureClass: baseline.fixtureClass,
    targetAlias: baseline.targetAlias,
    revision: baseline.revision,
    sourceRecordId: `${baseline.caseId}:${baseline.stepId}`,
    state: 'baseline',
  }));
  const mutations: ResourceLedgerEntry[] = product.mutations.map((mutation) => {
    const intent = product.cleanupIntents.find(({ mutationReceiptId }) => mutationReceiptId === mutation.receiptId);
    const receipt = intent === undefined ? undefined : product.cleanupReceipts
      .find(({ cleanupIntentId }) => cleanupIntentId === intent.cleanupIntentId);
    const readback = intent === undefined ? undefined : product.cleanupReadbacks
      .findLast(({ cleanupIntentId }) => cleanupIntentId === intent.cleanupIntentId);
    const state = cleanupState(intent, receipt, readback);
    return {
      source: 'mutation',
      resourceKind: mutation.resourceKind,
      immutableId: mutation.immutableId,
      fixtureClass: mutation.fixtureClass,
      targetAlias: mutation.targetAlias,
      revision: mutation.revision,
      sourceRecordId: mutation.receiptId,
      state,
    };
  });
  return [...baselines, ...mutations];
}

function cleanupState(
  intent: CleanupIntentRecord | undefined,
  receipt: CleanupReceipt | undefined,
  readback: CleanupReadback | undefined,
): ResourceLedgerEntry['state'] {
  if (intent === undefined) return 'mutation_recorded';
  if (readback !== undefined && readback.outcome !== 'ambiguous') return 'cleanup_verified';
  if (receipt === undefined) return 'cleanup_pending';
  if (receipt.outcome === 'ambiguous'
    && (readback === undefined || readback.outcome === 'ambiguous')) return 'cleanup_ambiguous';
  return 'cleanup_verified';
}

export function deriveCleanupPlan(path: string, identity: JournalIdentity): CleanupTarget[] {
  return deriveCleanupPlanFromJournal(read(path, identity));
}

function deriveCleanupPlanFromJournal(journal: ReadJournalResult): CleanupTarget[] {
  const ledger = projectProductLedger(journal);
  const resolvedReadbackIntentIds = new Set(ledger.cleanupReadbacks
    .filter(({ outcome }) => outcome !== 'ambiguous')
    .map(({ cleanupIntentId }) => cleanupIntentId));
  const completedIntentIds = new Set(ledger.cleanupReceipts
    .filter(({ cleanupIntentId, outcome }) =>
      outcome !== 'ambiguous' || resolvedReadbackIntentIds.has(cleanupIntentId)
    )
    .map(({ cleanupIntentId }) => cleanupIntentId));
  resolvedReadbackIntentIds.forEach((id) => completedIntentIds.add(id));
  const ambiguousIntentIds = new Set(ledger.cleanupReceipts
    .filter(({ cleanupIntentId, outcome }) =>
      outcome === 'ambiguous' && !resolvedReadbackIntentIds.has(cleanupIntentId)
    )
    .map(({ cleanupIntentId }) => cleanupIntentId));
  const ambiguousMutationIds = new Set(ledger.cleanupIntents
    .filter(({ cleanupIntentId }) => ambiguousIntentIds.has(cleanupIntentId)
      || (!completedIntentIds.has(cleanupIntentId)
        && !ledger.cleanupReceipts.some((receipt) => receipt.cleanupIntentId === cleanupIntentId)))
    .map(({ mutationReceiptId }) => mutationReceiptId));
  const finalizedMutationIds = new Set(ledger.cleanupIntents
    .filter(({ cleanupIntentId }) => completedIntentIds.has(cleanupIntentId))
    .map(({ mutationReceiptId }) => mutationReceiptId));
  const latestResettableReceiptByResource = new Map<string, string>();
  for (const mutation of ledger.mutations) {
    if (mutation.fixtureClass === 'resettable_fixture' && mutation.direction === 'forward') {
      latestResettableReceiptByResource.set(resourceKey(mutation), mutation.receiptId);
    }
  }
  const latestResettableReceiptIds = new Set(latestResettableReceiptByResource.values());
  return ledger.mutations
    .filter(({ receiptId, direction, fixtureClass }) => direction === 'forward'
      && !finalizedMutationIds.has(receiptId)
      && (fixtureClass !== 'resettable_fixture' || latestResettableReceiptIds.has(receiptId)))
    .map((mutation) => cleanupTarget(
      mutation,
      ledger.baselines,
      ambiguousMutationIds.has(mutation.receiptId) ? 'authoritative_readback' : 'execute',
    ));
}

export function beginCleanup(
  path: string,
  target: CleanupTarget,
  input: { currentRevision: string; actionChallengeDigest: string },
  identity: JournalIdentity,
): CleanupIntentRecord {
  requireExactId(target.immutableId);
  if (target.resolution === 'authoritative_readback') fail('CLEANUP_AMBIGUOUS');
  const journal = read(path, identity);
  const plan = deriveCleanupPlanFromJournal(journal);
  const declared = plan.find(({ mutationReceiptId }) => mutationReceiptId === target.mutationReceiptId);
  if (declared === undefined || !same(declared, target)) fail('UNDECLARED_CLEANUP');
  if (input.currentRevision !== declared.expectedRevision) fail('REVISION_DRIFT');
  requireChallengeBinding(journal, {
    challengeDigest: input.actionChallengeDigest,
    caseId: target.caseId,
    stepId: `${target.stepId}:cleanup`,
    attempt: target.attempt,
    expectedRevision: target.expectedRevision,
    mutation: target.mutation,
    targetAlias: target.targetAlias,
  }, 'issued');

  const existing = eventValues(journal, 'cleanup_intent')
    .find(({ mutationReceiptId }) => mutationReceiptId === target.mutationReceiptId);
  const event: CleanupIntentRecord = {
    type: 'cleanup_intent',
    cleanupIntentId: `cleanup_${target.mutationReceiptId}`,
    mutationReceiptId: target.mutationReceiptId,
    caseId: target.caseId,
    stepId: `${target.stepId}:cleanup`,
    attempt: target.attempt,
    targetAlias: target.targetAlias,
    actionChallengeDigest: input.actionChallengeDigest,
    immutableId: target.immutableId,
    resourceKind: target.resourceKind,
    fixtureClass: target.fixtureClass,
    operation: target.operation,
    mutation: target.mutation,
    expectedRevision: target.expectedRevision,
    ...(target.restoreRevision === undefined ? {} : { restoreRevision: target.restoreRevision }),
    ...(target.restoreStateDigest === undefined ? {} : { restoreStateDigest: target.restoreStateDigest }),
    ...(target.expectedResidueStateDigest === undefined
      ? {}
      : { expectedResidueStateDigest: target.expectedResidueStateDigest }),
  };
  if (existing !== undefined) {
    if (!same(existing, event)) fail('UNDECLARED_CLEANUP');
    return existing;
  }
  appendRunJournal(path, event, identity);
  return event;
}

export function recordCleanupReceipt(
  path: string,
  input: CleanupReceiptInput,
  identity: JournalIdentity,
): CleanupReceipt {
  requireExactId(input.cleanupIntentId);
  requireExactId(input.receiptId);
  requireExactId(input.immutableId);
  const journal = read(path, identity);
  const existing = eventValues(journal, 'cleanup_receipt')
    .find(({ cleanupIntentId }) => cleanupIntentId === input.cleanupIntentId);
  const event: CleanupReceipt = { type: 'cleanup_receipt', ...input };
  if (existing !== undefined) {
    if (!same(existing, event)) fail('DUPLICATE_RECEIPT');
    return existing;
  }
  const intent = eventValues(journal, 'cleanup_intent')
    .find(({ cleanupIntentId }) => cleanupIntentId === input.cleanupIntentId);
  if (intent === undefined
    || intent.actionChallengeDigest !== input.actionChallengeDigest
    || intent.immutableId !== input.immutableId
    || intent.expectedRevision !== input.priorRevision) fail('CLEANUP_RECEIPT_MISMATCH');
  requireChallengeBinding(journal, {
    challengeDigest: input.actionChallengeDigest,
    operatorReceiptDigest: input.operatorReceiptDigest,
    caseId: intent.caseId,
    stepId: intent.stepId,
    attempt: intent.attempt,
    expectedRevision: intent.expectedRevision,
    mutation: intent.mutation,
    targetAlias: intent.targetAlias,
    resourceBindingDigest: exactResourceBindingDigest({
      targetAlias: intent.targetAlias,
      resourceKind: intent.resourceKind,
      fixtureClass: intent.fixtureClass,
      immutableId: intent.immutableId,
      beforeRevision: intent.expectedRevision,
    }),
  }, 'completed');
  validateCleanupOutcome(intent, input);
  appendRunJournal(path, event, identity);
  return event;
}

export function recordCleanupReadback(
  path: string,
  input: CleanupReadbackInput,
  identity: JournalIdentity,
): CleanupReadback {
  requireExactId(input.cleanupIntentId);
  if (input.cleanupReceiptId !== undefined) requireExactId(input.cleanupReceiptId);
  requireExactId(input.readbackId);
  requireExactId(input.immutableId);
  const journal = read(path, identity);
  const event: CleanupReadback = { type: 'cleanup_readback', ...input };
  const existing = eventValues(journal, 'cleanup_readback')
    .findLast(({ cleanupIntentId }) => cleanupIntentId === input.cleanupIntentId);
  if (existing !== undefined) {
    if (same(existing, event)) return existing;
    if (existing.outcome !== 'ambiguous' || existing.readbackId === input.readbackId) fail('DUPLICATE_RECEIPT');
  }
  const intent = eventValues(journal, 'cleanup_intent')
    .find(({ cleanupIntentId }) => cleanupIntentId === input.cleanupIntentId);
  const receipt = eventValues(journal, 'cleanup_receipt')
    .find(({ cleanupIntentId }) => cleanupIntentId === input.cleanupIntentId);
  if (intent === undefined || intent.immutableId !== input.immutableId
    || (receipt === undefined ? input.cleanupReceiptId !== undefined
      : receipt.outcome !== 'ambiguous' || receipt.receiptId !== input.cleanupReceiptId)) {
    fail('CLEANUP_RECEIPT_MISMATCH');
  }
  validateCleanupState(
    intent,
    input.outcome,
    input.observedRevision,
    input.observedStateDigest,
  );
  appendRunJournal(path, event, identity);
  return event;
}

export interface PostflightInventoryItem {
  resourceKind: ProductResourceKind;
  immutableId: string;
  revision: string;
  stateDigest: string;
  fixtureClass: FixtureClass;
}

export interface PostflightInput {
  identity: {
    targetFingerprint: string;
    repositoryRevision: string;
    servingVersion: string;
  };
  declaredResourceKinds: ProductResourceKind[];
  inventory: PostflightInventoryItem[];
}

export interface PostflightProof {
  status: 'pass' | 'failed';
  targetIdentityMatches: boolean;
  missingAliases: string[];
  unexpectedAliases: string[];
  unresolvedAliases: string[];
}

export function verifyPostflight(
  path: string,
  input: PostflightInput,
  identity: JournalIdentity,
): PostflightProof {
  const journal = read(path, identity);
  const ledger = projectProductLedger(journal);
  const declared = new Set(input.declaredResourceKinds);
  const required = new Set([
    ...ledger.baselines.map(({ resourceKind }) => resourceKind),
    ...ledger.mutations.map(({ resourceKind }) => resourceKind),
    ...ledger.cleanupIntents.map(({ resourceKind }) => resourceKind),
  ]);
  if (declared.size !== input.declaredResourceKinds.length
    || input.declaredResourceKinds.some((kind) => !(PRODUCT_RESOURCE_KINDS as readonly string[]).includes(kind))
    || declared.size !== required.size
    || [...required].some((kind) => !declared.has(kind))) {
    fail('INVALID_CLEANUP_CONTRACT');
  }
  for (const item of input.inventory) requireExactId(item.immutableId);
  const inventory = input.inventory.filter(({ resourceKind }) => declared.has(resourceKind));
  const targetIdentityMatches = input.identity.targetFingerprint === journal.header.targetFingerprint
    && input.identity.repositoryRevision === journal.header.repositoryRevision
    && input.identity.servingVersion === journal.header.servingVersion;

  const expected = new Map<string, { revision?: string; stateDigest: string; role: 'baseline' | 'residue' }>();
  for (const baseline of ledger.baselines.filter(({ resourceKind }) => declared.has(resourceKind))) {
    expected.set(resourceKey(baseline), {
      revision: baseline.revision,
      stateDigest: baseline.stateDigest,
      role: 'baseline',
    });
  }
  for (const mutation of ledger.mutations.filter(({ resourceKind }) => declared.has(resourceKind))) {
    if (mutation.fixtureClass === 'attributed_residue' && mutation.expectedResidueStateDigest !== undefined) {
      expected.set(resourceKey(mutation), {
        revision: mutation.revision,
        stateDigest: mutation.expectedResidueStateDigest,
        role: 'residue',
      });
    }
  }
  for (const receipt of ledger.cleanupReceipts) {
    const intent = ledger.cleanupIntents.find(({ cleanupIntentId }) => cleanupIntentId === receipt.cleanupIntentId);
    if (intent !== undefined
      && (receipt.outcome === 'restored' || receipt.outcome === 'retained')) {
      const item = expected.get(resourceKey(intent));
      if (item !== undefined) item.revision = receipt.resultingRevision;
    }
  }
  for (const readback of ledger.cleanupReadbacks) {
    const intent = ledger.cleanupIntents.find(({ cleanupIntentId }) => cleanupIntentId === readback.cleanupIntentId);
    if (intent !== undefined
      && (readback.outcome === 'restored' || readback.outcome === 'retained')) {
      const item = expected.get(resourceKey(intent));
      if (item !== undefined) item.revision = readback.observedRevision;
    }
  }

  const observed = new Map(inventory.map((item) => [resourceKey(item), item]));
  const missing = [...expected.entries()].filter(([key, value]) => {
    const item = observed.get(key);
    return item === undefined || item.stateDigest !== value.stateDigest
      || (value.revision !== undefined && item.revision !== value.revision);
  });
  const unexpected = inventory.filter((item) => !expected.has(resourceKey(item)));

  const resolvedReadbackIntentIds = new Set(ledger.cleanupReadbacks
    .filter(({ outcome }) => outcome !== 'ambiguous')
    .map(({ cleanupIntentId }) => cleanupIntentId));
  const successfulIntentIds = new Set(ledger.cleanupReceipts
    .filter(({ outcome }) => outcome !== 'ambiguous')
    .map(({ cleanupIntentId }) => cleanupIntentId));
  resolvedReadbackIntentIds.forEach((intentId) => successfulIntentIds.add(intentId));
  const cleanedMutationIds = new Set(ledger.cleanupIntents
    .filter(({ cleanupIntentId }) => successfulIntentIds.has(cleanupIntentId))
    .map(({ mutationReceiptId }) => mutationReceiptId));
  for (const cleanedId of [...cleanedMutationIds]) {
    const cleaned = ledger.mutations.find(({ receiptId }) => receiptId === cleanedId);
    if (cleaned?.fixtureClass !== 'resettable_fixture') continue;
    for (const mutation of ledger.mutations) {
      if (mutation.fixtureClass === 'resettable_fixture'
        && resourceKey(mutation) === resourceKey(cleaned)) cleanedMutationIds.add(mutation.receiptId);
    }
  }
  const unresolvedMutations = ledger.mutations.filter((mutation) =>
    declared.has(mutation.resourceKind)
      && mutation.fixtureClass !== 'immutable_baseline'
      && !cleanedMutationIds.has(mutation.receiptId)
  );
  const unresolvedAmbiguities = ledger.cleanupReceipts.filter(({ cleanupIntentId, outcome }) =>
    outcome === 'ambiguous' && !resolvedReadbackIntentIds.has(cleanupIntentId)
  );
  const unresolvedCount = ledger.unresolved.length + unresolvedMutations.length + unresolvedAmbiguities.length;

  // Aliases intentionally describe the seam, not the private immutable ID.
  const normalizedMissingAliases = missing.map(([key, value], index) =>
    `${key.split(':', 1)[0]}:${value.role}:${index + 1}`
  );
  const unexpectedAliases = unexpected.map(({ resourceKind }, index) => `${resourceKind}:unexpected:${index + 1}`);
  const unresolvedAliases = [
    ...ledger.unresolved.map((_, index) => `journal:unresolved:${index + 1}`),
    ...unresolvedMutations.map(({ resourceKind }, index) => `${resourceKind}:unresolved:${index + 1}`),
    ...unresolvedAmbiguities.map((_, index) => `cleanup:ambiguous:${index + 1}`),
  ];
  const status = targetIdentityMatches && normalizedMissingAliases.length === 0
    && unexpectedAliases.length === 0 && unresolvedCount === 0 ? 'pass' : 'failed';
  return {
    status,
    targetIdentityMatches,
    missingAliases: normalizedMissingAliases,
    unexpectedAliases,
    unresolvedAliases,
  };
}

function cleanupTarget(
  mutation: MutationReceipt,
  baselines: readonly BaselineFact[],
  resolution: CleanupTarget['resolution'],
): CleanupTarget {
  const common = {
    mutationReceiptId: mutation.receiptId,
    caseId: mutation.caseId,
    stepId: mutation.stepId,
    attempt: mutation.attempt,
    targetAlias: mutation.targetAlias,
    immutableId: mutation.immutableId,
    resourceKind: mutation.resourceKind,
    fixtureClass: mutation.fixtureClass,
    expectedRevision: mutation.revision,
    resolution,
  };
  if (mutation.fixtureClass === 'run_owned' && mutation.reversalActionId !== undefined) {
    return {
      ...common,
      operation: mutation.reversalActionId,
      mutation: mutationForOperation(mutation.reversalActionId),
    };
  }
  if (mutation.fixtureClass === 'resettable_fixture' && mutation.reversalActionId !== undefined) {
    const baseline = baselines.find((candidate) =>
      candidate.resourceKind === mutation.resourceKind && candidate.immutableId === mutation.immutableId
    );
    if (baseline === undefined) fail('MISSING_BASELINE');
    return {
      ...common,
      operation: mutation.reversalActionId,
      mutation: mutationForOperation(mutation.reversalActionId),
      restoreRevision: baseline.revision,
      restoreStateDigest: baseline.stateDigest,
    };
  }
  if (mutation.fixtureClass === 'attributed_residue' && mutation.expectedResidueStateDigest !== undefined) {
    return {
      ...common,
      operation: mutation.reversalActionId ?? 'verify_retained',
      mutation: mutation.reversalActionId === 'agent.archive' ? 'archive' : 'none',
      expectedResidueStateDigest: mutation.expectedResidueStateDigest,
    };
  }
  fail('INVALID_CLEANUP_CONTRACT');
}

function validateMutationContract(input: MutationReceiptInput): void {
  if (input.fixtureClass === 'immutable_baseline') fail('IMMUTABLE_MUTATION');
  if (input.mutation === 'none') fail('INVALID_CLEANUP_CONTRACT');
  if (input.fixtureClass === 'run_owned') {
    if (input.cleanupStrategy !== 'exact_reversal' || input.reversalActionId === undefined
      || input.expectedResidueStateDigest !== undefined) fail('INVALID_CLEANUP_CONTRACT');
    return;
  }
  if (input.fixtureClass === 'resettable_fixture') {
    if (input.cleanupStrategy !== 'revision_restore' || input.reversalActionId === undefined
      || input.expectedResidueStateDigest !== undefined) fail('INVALID_CLEANUP_CONTRACT');
    return;
  }
  if (input.fixtureClass === 'attributed_residue') {
    if (input.cleanupStrategy !== 'attributed_residue'
      || (input.reversalActionId !== undefined
        && (input.resourceKind !== 'agent' || input.reversalActionId !== 'agent.archive'))
      || input.expectedResidueStateDigest === undefined) fail('INVALID_CLEANUP_CONTRACT');
    return;
  }
  fail('INVALID_CLEANUP_CONTRACT');
}

function validateCleanupOutcome(intent: CleanupIntentRecord, input: CleanupReceiptInput): void {
  validateCleanupState(intent, input.outcome, input.resultingRevision, input.resultingStateDigest);
}

function validateCleanupState(
  intent: CleanupIntentRecord,
  outcome: CleanupReceiptOutcome,
  resultingRevision: string,
  resultingStateDigest: string,
): void {
  if (outcome === 'ambiguous') return;
  if (intent.fixtureClass === 'run_owned') {
    if (outcome !== 'absent' || resultingRevision !== 'absent') fail('CLEANUP_RECEIPT_MISMATCH');
    return;
  }
  if (intent.fixtureClass === 'resettable_fixture') {
    if (outcome !== 'restored' || resultingStateDigest !== intent.restoreStateDigest) {
      fail('CLEANUP_RECEIPT_MISMATCH');
    }
    return;
  }
  if (intent.fixtureClass === 'attributed_residue') {
    if (outcome !== 'retained' || resultingStateDigest !== intent.expectedResidueStateDigest) {
      fail('RESIDUE_MISMATCH');
    }
    return;
  }
  fail('CLEANUP_RECEIPT_MISMATCH');
}

function read(path: string, identity: JournalIdentity): ReadJournalResult {
  return readRunJournal(path, identity);
}

function eventValues<Type extends RunJournalEventData['type']>(
  journal: ReadJournalResult,
  type: Type,
): Array<Extract<RunJournalEventData, { type: Type }>> {
  return journal.events.flatMap((record: RunJournalEvent) =>
    record.event.type === type
      ? [record.event as Extract<RunJournalEventData, { type: Type }>]
      : []
  );
}

function optionalEvent<Value extends object>(value: Value): Value {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as Value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resourceKey(value: { resourceKind: ProductResourceKind; immutableId: string }): string {
  return `${value.resourceKind}:${value.immutableId}`;
}

function requireChallengeBinding(
  journal: ReadJournalResult,
  binding: {
    challengeDigest: string;
    operatorReceiptDigest?: string;
    caseId: string;
    stepId: string;
    attempt: number;
    expectedRevision: string;
    mutation: MutationClass;
    targetAlias: string;
    resourceBindingDigest?: string;
  },
  phase: 'issued' | 'completed',
): void {
  const issued = eventValues(journal, 'operator_challenge_issued')
    .find(({ challengeDigest }) => challengeDigest === binding.challengeDigest);
  if (issued === undefined
    || issued.caseId !== binding.caseId
    || issued.stepId !== binding.stepId
    || issued.attempt !== binding.attempt
    || issued.expectedRevision !== binding.expectedRevision
    || issued.mutation !== binding.mutation
    || issued.targetAlias !== binding.targetAlias) fail('CHALLENGE_MISMATCH');
  if (phase === 'completed') {
    const completion = eventValues(journal, 'operator_challenge_completed')
      .find(({ challengeDigest }) => challengeDigest === binding.challengeDigest);
    if (completion === undefined || completion.operatorReceiptDigest !== binding.operatorReceiptDigest
      || (binding.resourceBindingDigest !== undefined
        && completion.resourceBindingDigest !== binding.resourceBindingDigest)) {
      fail('CHALLENGE_MISMATCH');
    }
  }
}

export function exactResourceBindingDigest(input: {
  targetAlias: string;
  resourceKind: ProductResourceKind;
  fixtureClass: FixtureClass;
  immutableId: string;
  beforeRevision: string;
}): string {
  const value = [
    input.targetAlias,
    input.resourceKind,
    input.fixtureClass,
    input.immutableId,
    input.beforeRevision,
  ].map((part) => `${part.length}:${part}`).join('|');
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function mutationForOperation(operation: ActionId): MutationClass {
  if (operation.endsWith('.create') || operation === 'slack.message.send') return 'create';
  if (operation.endsWith('.update') || operation === 'routine.run_now') return 'update';
  if (operation.endsWith('.delete') || operation === 'slack.message.delete') return 'delete';
  if (operation.endsWith('.archive')) return 'archive';
  if (operation.endsWith('.restore')) return 'restore';
  if (operation.endsWith('.authorize')) return 'authorize';
  if (operation.endsWith('.revoke')) return 'revoke';
  return 'none';
}

function requireExactId(input: string): void {
  if (typeof input !== 'string' || input.length < 3 || input.length > 512
    || /[\s*?\[\]{}\\/]/u.test(input) || input === '.' || input === '..' || input.startsWith('-')) {
    fail('INVALID_EXACT_ID');
  }
}

function fail(code: CleanupSafetyErrorCode): never {
  throw new CleanupSafetyError(code);
}
