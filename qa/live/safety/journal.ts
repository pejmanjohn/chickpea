import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  ACTION_IDS,
  ASSERTION_TOKENS,
  CLEANUP_STRATEGIES,
  CLEANUP_RESULTS,
  FIXTURE_CLASSES,
  MUTATION_CLASSES,
  OBSERVER_IDS,
  PRIMARY_RESULTS,
  SUITES,
  TYPED_REASONS,
  type ActionId,
  type AssertionToken,
  type CleanupStrategy,
  type CleanupResult,
  type FixtureClass,
  type MutationClass,
  type ObserverId,
  type PrimaryResult,
  type Suite,
  type TypedReason,
} from '../schema.ts';
import {
  ACTION_RECEIPT_OUTCOMES,
  READBACK_OUTCOMES,
  RUN_PHASES,
  type ActionReceiptOutcome,
  type RunPhase,
  type RunnerOutputKind,
} from '../state.ts';
import { isNodeError } from './errors.ts';

export const RUN_JOURNAL_SCHEMA = 'chickpea-live-journal/v1' as const;

export const PRODUCT_RESOURCE_KINDS = [
  'agent',
  'grant',
  'memory',
  'connection',
  'skill',
  'routine',
  'route',
  'setup',
  'revision_restoration',
  'attributed_residue',
] as const;
export type ProductResourceKind = typeof PRODUCT_RESOURCE_KINDS[number];

export const UNRESOLVED_CATEGORIES = [
  'forward_ambiguous',
  'cleanup_ambiguous',
  'restoration_mismatch',
  'foreign_effect',
] as const;
export type UnresolvedCategory = typeof UNRESOLVED_CATEGORIES[number];

export const CLEANUP_RECEIPT_OUTCOMES = ['absent', 'restored', 'retained', 'ambiguous'] as const;
export type CleanupReceiptOutcome = typeof CLEANUP_RECEIPT_OUTCOMES[number];

export type CleanupOperation = ActionId | 'verify_retained';

export interface RunJournalHeaderInput {
  runId: string;
  manifestDigest: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
  suite: Suite;
  variantIds: string[];
  createdAt: string;
}

export interface RunJournalHeader extends RunJournalHeaderInput {
  record: 'header';
  schemaVersion: typeof RUN_JOURNAL_SCHEMA;
  seq: 0;
}

export type RunJournalEventData =
  | { type: 'doctor'; ready: boolean; diagnosticCodes: string[] }
  | { type: 'computer_use_window'; caseId: string; stepId: string; targetAlias: string;
    captureDigest: string; windowDigest: string; observedAt: string }
  | { type: 'postflight_required'; caseId: string }
  | { type: 'postflight_receipt'; caseId: string; result: 'pass' | 'failed';
    targetIdentityMatches: boolean; missingCount: number; unexpectedCount: number; unresolvedCount: number }
  | {
    type: 'intent';
    intentId: string;
    variantId: string;
    actionRef: string;
    actionId: ActionId;
    mutation: MutationClass;
    direction: 'forward' | 'reversal';
  }
  | {
    type: 'receipt';
    intentId: string;
    variantId: string;
    actionRef: string;
    outcome: ActionReceiptOutcome;
  }
  | {
    type: 'readback';
    intentId: string;
    variantId: string;
    actionRef: string;
    outcome: 'applied' | 'absent' | 'ambiguous';
  }
  | {
    type: 'transition';
    from: RunPhase;
    to: RunPhase;
    output: RunnerOutputKind;
    variantId?: string;
    actionRef?: string;
    reason?: TypedReason;
    notBefore?: string;
  }
  | { type: 'assertion'; variantId: string; result: PrimaryResult; reason?: TypedReason }
  | { type: 'case_result'; variantId: string; result: PrimaryResult; reason?: TypedReason }
  | { type: 'cleanup_result'; variantId: string; result: CleanupResult }
  | {
    type: 'baseline_fact';
    caseId: string;
    stepId: string;
    targetAlias: string;
    immutableId: string;
    revision: string;
    stateDigest: string;
    resourceKind: ProductResourceKind;
    fixtureClass: Extract<FixtureClass, 'immutable_baseline' | 'resettable_fixture'>;
  }
  | {
    type: 'mutation_receipt';
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
    expectedResidueStateDigest?: string;
  }
  | {
    type: 'cleanup_intent';
    cleanupIntentId: string;
    mutationReceiptId: string;
    caseId: string;
    stepId: string;
    attempt: number;
    targetAlias: string;
    actionChallengeDigest: string;
    immutableId: string;
    resourceKind: ProductResourceKind;
    fixtureClass: FixtureClass;
    operation: CleanupOperation;
    mutation: MutationClass;
    expectedRevision: string;
    restoreRevision?: string;
    restoreStateDigest?: string;
    expectedResidueStateDigest?: string;
  }
  | {
    type: 'cleanup_receipt';
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
  | {
    type: 'cleanup_readback';
    cleanupIntentId: string;
    cleanupReceiptId: string;
    readbackId: string;
    observerId: ObserverId;
    immutableId: string;
    observedRevision: string;
    observedStateDigest: string;
    outcome: CleanupReceiptOutcome;
  }
  | {
    type: 'assertion_tokens';
    caseId: string;
    stepId: string;
    observerId: ObserverId;
    expectedTokens: AssertionToken[];
    observedTokens: AssertionToken[];
    pollAttempt: number;
    pollElapsedMs: number;
  }
  | {
    type: 'unresolved_outcome';
    caseId: string;
    stepId: string;
    attempt: number;
    referenceId: string;
    category: UnresolvedCategory;
  }
  | {
    type: 'operator_challenge_issued';
    challengeDigest: string;
    caseId: string;
    stepId: string;
    attempt: number;
    expectedRevision: string;
    mutation: MutationClass;
    targetAlias: string;
    actorAlias: string;
    expectedRole: 'owner' | 'admin' | 'member';
    browserProfileAlias: string;
    expiresAt: number;
  }
  | { type: 'operator_challenge_consumed'; challengeDigest: string }
  | {
    type: 'operator_challenge_completed';
    challengeDigest: string;
    operatorReceiptDigest: string;
    resourceBindingDigest: string;
  }
  | { type: 'run_result'; aggregate: string };

export interface RunJournalEvent {
  record: 'event';
  seq: number;
  runId: string;
  manifestDigest: string;
  at: string;
  event: RunJournalEventData;
}

export interface ReadJournalOptions {
  runId: string;
  manifestDigest: string;
  incompleteFinal?: 'reject' | 'preserve' | 'discard';
}

export interface ReadJournalResult {
  header: RunJournalHeader;
  events: RunJournalEvent[];
  nextSeq: number;
  incompleteFinalRecord?: string;
}

export type JournalErrorCode =
  | 'JOURNAL_EXISTS'
  | 'JOURNAL_MISSING'
  | 'INVALID_HEADER'
  | 'MALFORMED_RECORD'
  | 'INCOMPLETE_FINAL_RECORD'
  | 'FOREIGN_RUN'
  | 'WRONG_MANIFEST'
  | 'OUT_OF_SEQUENCE'
  | 'INVALID_EVENT'
  | 'UNSAFE_RECORD';

export class JournalValidationError extends Error {
  readonly code: JournalErrorCode;

  constructor(code: JournalErrorCode) {
    super(code);
    this.name = 'JournalValidationError';
    this.code = code;
  }
}

export function createRunJournal(path: string, input: RunJournalHeaderInput): RunJournalHeader {
  exactKeys(input, [
    'runId', 'manifestDigest', 'targetFingerprint', 'repositoryRevision', 'servingVersion',
    'suite', 'variantIds', 'createdAt',
  ], 'INVALID_HEADER');
  validateHeaderInput(input);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const header: RunJournalHeader = {
    record: 'header',
    schemaVersion: RUN_JOURNAL_SCHEMA,
    seq: 0,
    ...input,
    variantIds: [...input.variantIds],
  };
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') throw new JournalValidationError('JOURNAL_EXISTS');
    throw error;
  }
  try {
    writeSync(descriptor, `${JSON.stringify(header)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return header;
}

export function appendRunJournal(
  path: string,
  event: RunJournalEventData,
  expected: { runId: string; manifestDigest: string; at?: string },
): RunJournalEvent {
  validateRunJournalEventData(event);
  const journal = readRunJournal(path, {
    runId: expected.runId,
    manifestDigest: expected.manifestDigest,
  });
  const record: RunJournalEvent = {
    record: 'event',
    seq: journal.nextSeq,
    runId: expected.runId,
    manifestDigest: expected.manifestDigest,
    at: expected.at ?? new Date().toISOString(),
    event,
  };
  assertContentFree(record);
  const descriptor = openSync(path, 'a', 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return record;
}

/** Read-only validation for callers that must validate before completing a challenge. */
export function validateRunJournalEventData(event: RunJournalEventData): void {
  validateEventData(event);
  assertContentFree(event);
}

export function readRunJournal(path: string, options: ReadJournalOptions): ReadJournalResult {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') throw new JournalValidationError('JOURNAL_MISSING');
    throw error;
  }
  const endsWithNewline = contents.endsWith('\n');
  const parts = contents.split('\n');
  let incompleteFinalRecord: string | undefined;
  if (!endsWithNewline) {
    incompleteFinalRecord = parts.pop();
    if (options.incompleteFinal === 'discard') {
      const byteLength = Buffer.byteLength(`${parts.join('\n')}\n`);
      const descriptor = openSync(path, 'r+');
      try {
        ftruncateSync(descriptor, byteLength);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      incompleteFinalRecord = undefined;
    } else if (options.incompleteFinal !== 'preserve') {
      throw new JournalValidationError('INCOMPLETE_FINAL_RECORD');
    }
  } else {
    parts.pop();
  }

  if (parts.some((line) => line.length === 0)) throw new JournalValidationError('MALFORMED_RECORD');
  const parsed = parts.map(parseCompleteRecord);
  const rawHeader = parsed[0];
  const header = validateHeader(rawHeader);
  assertExpectedIdentity(header.runId, header.manifestDigest, options);
  const events: RunJournalEvent[] = [];
  for (let index = 1; index < parsed.length; index += 1) {
    const event = validateEvent(parsed[index]);
    assertExpectedIdentity(event.runId, event.manifestDigest, options);
    if (event.seq !== index) throw new JournalValidationError('OUT_OF_SEQUENCE');
    events.push(event);
  }
  const result: ReadJournalResult = {
    header,
    events,
    nextSeq: events.length + 1,
  };
  if (incompleteFinalRecord !== undefined) result.incompleteFinalRecord = incompleteFinalRecord;
  return result;
}

function parseCompleteRecord(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new JournalValidationError('MALFORMED_RECORD');
  }
}

function validateHeader(input: unknown): RunJournalHeader {
  if (!isRecord(input) || input.record !== 'header' || input.schemaVersion !== RUN_JOURNAL_SCHEMA || input.seq !== 0) {
    throw new JournalValidationError('INVALID_HEADER');
  }
  exactKeys(input, [
    'record', 'schemaVersion', 'seq', 'runId', 'manifestDigest', 'targetFingerprint',
    'repositoryRevision', 'servingVersion', 'suite', 'variantIds', 'createdAt',
  ], 'INVALID_HEADER');
  validateHeaderInput(input as unknown as RunJournalHeaderInput);
  assertContentFree(input);
  return input as unknown as RunJournalHeader;
}

function validateHeaderInput(input: RunJournalHeaderInput): void {
  if (!isRecord(input)
    || !nonEmpty(input.runId)
    || !nonEmpty(input.manifestDigest)
    || !nonEmpty(input.targetFingerprint)
    || !nonEmpty(input.repositoryRevision)
    || !nonEmpty(input.servingVersion)
    || !(SUITES as readonly unknown[]).includes(input.suite)
    || !Array.isArray(input.variantIds)
    || input.variantIds.length === 0
    || !input.variantIds.every(nonEmpty)
    || !validTimestamp(input.createdAt)) {
    throw new JournalValidationError('INVALID_HEADER');
  }
}

function validateEvent(input: unknown): RunJournalEvent {
  if (!isRecord(input)
    || input.record !== 'event'
    || !Number.isSafeInteger(input.seq)
    || !nonEmpty(input.runId)
    || !nonEmpty(input.manifestDigest)
    || !validTimestamp(input.at)
    || !isRecord(input.event)) {
    throw new JournalValidationError('INVALID_EVENT');
  }
  exactKeys(input, ['record', 'seq', 'runId', 'manifestDigest', 'at', 'event'], 'INVALID_EVENT');
  validateEventData(input.event as RunJournalEventData);
  assertContentFree(input);
  return input as unknown as RunJournalEvent;
}

function validateEventData(event: RunJournalEventData): void {
  if (!isRecord(event) || !nonEmpty(event.type)) throw new JournalValidationError('INVALID_EVENT');
  switch (event.type) {
    case 'postflight_required':
      exactKeys(event, ['type', 'caseId'], 'INVALID_EVENT');
      if (!nonEmpty(event.caseId)) invalidEvent();
      return;
    case 'postflight_receipt':
      exactKeys(event, ['type', 'caseId', 'result', 'targetIdentityMatches', 'missingCount', 'unexpectedCount', 'unresolvedCount'], 'INVALID_EVENT');
      if (!nonEmpty(event.caseId) || !['pass', 'failed'].includes(String(event.result))
        || typeof event.targetIdentityMatches !== 'boolean'
        || !nonNegativeInteger(event.missingCount) || !nonNegativeInteger(event.unexpectedCount)
        || !nonNegativeInteger(event.unresolvedCount)
        || (event.result === 'pass') !== (event.targetIdentityMatches
          && event.missingCount === 0 && event.unexpectedCount === 0 && event.unresolvedCount === 0)) invalidEvent();
      return;
    case 'computer_use_window':
      exactKeys(event, ['type', 'caseId', 'stepId', 'targetAlias', 'captureDigest', 'windowDigest', 'observedAt'], 'INVALID_EVENT');
      if (!nonEmpty(event.caseId) || !nonEmpty(event.stepId) || !nonEmpty(event.targetAlias)
        || !digest(event.captureDigest) || !digest(event.windowDigest)
        || typeof event.observedAt !== 'string' || !Number.isFinite(Date.parse(event.observedAt))) invalidEvent();
      return;
    case 'doctor':
      exactKeys(event, ['type', 'ready', 'diagnosticCodes'], 'INVALID_EVENT');
      if (typeof event.ready !== 'boolean' || !stringArray(event.diagnosticCodes)) invalidEvent();
      return;
    case 'intent':
      exactKeys(event, [
        'type', 'intentId', 'variantId', 'actionRef', 'actionId', 'mutation', 'direction',
      ], 'INVALID_EVENT');
      if (!nonEmpty(event.intentId) || !nonEmpty(event.variantId) || !nonEmpty(event.actionRef)
        || !(ACTION_IDS as readonly unknown[]).includes(event.actionId)
        || !(MUTATION_CLASSES as readonly unknown[]).includes(event.mutation)
        || (event.direction !== 'forward' && event.direction !== 'reversal')) invalidEvent();
      return;
    case 'receipt':
      exactKeys(event, ['type', 'intentId', 'variantId', 'actionRef', 'outcome'], 'INVALID_EVENT');
      if (!nonEmpty(event.intentId) || !nonEmpty(event.variantId) || !nonEmpty(event.actionRef)
        || !(ACTION_RECEIPT_OUTCOMES as readonly unknown[]).includes(event.outcome)) invalidEvent();
      return;
    case 'readback':
      exactKeys(event, ['type', 'intentId', 'variantId', 'actionRef', 'outcome'], 'INVALID_EVENT');
      if (!nonEmpty(event.intentId) || !nonEmpty(event.variantId) || !nonEmpty(event.actionRef)
        || !(READBACK_OUTCOMES as readonly unknown[]).includes(event.outcome)) invalidEvent();
      return;
    case 'transition':
      exactKeys(event, [
        'type', 'from', 'to', 'output', 'variantId', 'actionRef', 'reason', 'notBefore',
      ], 'INVALID_EVENT');
      if (!(RUN_PHASES as readonly unknown[]).includes(event.from)
        || !(RUN_PHASES as readonly unknown[]).includes(event.to)
        || !['action_required', 'waiting', 'assertion', 'terminal'].includes(event.output)
        || (event.variantId !== undefined && !nonEmpty(event.variantId))
        || (event.actionRef !== undefined && !nonEmpty(event.actionRef))
        || (event.reason !== undefined && !(TYPED_REASONS as readonly unknown[]).includes(event.reason))
        || (event.notBefore !== undefined && !validTimestamp(event.notBefore))) invalidEvent();
      return;
    case 'assertion':
    case 'case_result':
      exactKeys(event, ['type', 'variantId', 'result', 'reason'], 'INVALID_EVENT');
      if (!nonEmpty(event.variantId) || !(PRIMARY_RESULTS as readonly unknown[]).includes(event.result)
        || (event.reason !== undefined && !(TYPED_REASONS as readonly unknown[]).includes(event.reason))) invalidEvent();
      return;
    case 'cleanup_result':
      exactKeys(event, ['type', 'variantId', 'result'], 'INVALID_EVENT');
      if (!nonEmpty(event.variantId) || !(CLEANUP_RESULTS as readonly unknown[]).includes(event.result)) invalidEvent();
      return;
    case 'baseline_fact':
      exactKeys(event, [
        'type', 'caseId', 'stepId', 'targetAlias', 'immutableId', 'revision', 'stateDigest',
        'resourceKind', 'fixtureClass',
      ], 'INVALID_EVENT');
      if (!nonEmpty(event.caseId) || !nonEmpty(event.stepId) || !nonEmpty(event.targetAlias)
        || !exactId(event.immutableId) || !nonEmpty(event.revision) || !digest(event.stateDigest)
        || !(PRODUCT_RESOURCE_KINDS as readonly unknown[]).includes(event.resourceKind)
        || !['immutable_baseline', 'resettable_fixture'].includes(event.fixtureClass)) invalidEvent();
      return;
    case 'mutation_receipt':
      exactKeys(event, [
        'type', 'receiptId', 'caseId', 'stepId', 'attempt', 'targetAlias',
        'actionChallengeDigest', 'operatorReceiptDigest', 'beforeStateDigest', 'immutableId', 'beforeRevision',
        'revision', 'stateDigest', 'resourceKind', 'mutation', 'fixtureClass', 'cleanupStrategy',
        'reversalActionId', 'direction', 'expectedResidueStateDigest',
      ], 'INVALID_EVENT');
      if (!exactId(event.receiptId) || !nonEmpty(event.caseId) || !nonEmpty(event.stepId)
        || !positiveInteger(event.attempt) || !nonEmpty(event.targetAlias)
        || !digest(event.actionChallengeDigest) || !digest(event.operatorReceiptDigest)
        || !digest(event.beforeStateDigest)
        || !exactId(event.immutableId) || !nonEmpty(event.beforeRevision) || !nonEmpty(event.revision)
        || !digest(event.stateDigest)
        || !(PRODUCT_RESOURCE_KINDS as readonly unknown[]).includes(event.resourceKind)
        || !(MUTATION_CLASSES as readonly unknown[]).includes(event.mutation)
        || !(FIXTURE_CLASSES as readonly unknown[]).includes(event.fixtureClass)
        || !(CLEANUP_STRATEGIES as readonly unknown[]).includes(event.cleanupStrategy)
        || (event.reversalActionId !== undefined && !(ACTION_IDS as readonly unknown[]).includes(event.reversalActionId))
        || !['forward', 'reversal'].includes(event.direction)
        || (event.expectedResidueStateDigest !== undefined && !digest(event.expectedResidueStateDigest))) invalidEvent();
      return;
    case 'cleanup_intent':
      exactKeys(event, [
        'type', 'cleanupIntentId', 'mutationReceiptId', 'caseId', 'stepId', 'attempt',
        'targetAlias', 'actionChallengeDigest', 'immutableId', 'resourceKind', 'fixtureClass',
        'operation', 'mutation', 'expectedRevision', 'restoreRevision', 'restoreStateDigest',
        'expectedResidueStateDigest',
      ], 'INVALID_EVENT');
      if (!exactId(event.cleanupIntentId) || !exactId(event.mutationReceiptId)
        || !nonEmpty(event.caseId) || !nonEmpty(event.stepId) || !positiveInteger(event.attempt)
        || !nonEmpty(event.targetAlias) || !digest(event.actionChallengeDigest)
        || !exactId(event.immutableId)
        || !(PRODUCT_RESOURCE_KINDS as readonly unknown[]).includes(event.resourceKind)
        || !(FIXTURE_CLASSES as readonly unknown[]).includes(event.fixtureClass)
        || (!(ACTION_IDS as readonly unknown[]).includes(event.operation) && event.operation !== 'verify_retained')
        || !(MUTATION_CLASSES as readonly unknown[]).includes(event.mutation)
        || !nonEmpty(event.expectedRevision)
        || (event.restoreRevision !== undefined && !nonEmpty(event.restoreRevision))
        || (event.restoreStateDigest !== undefined && !digest(event.restoreStateDigest))
        || (event.expectedResidueStateDigest !== undefined && !digest(event.expectedResidueStateDigest))) invalidEvent();
      return;
    case 'cleanup_receipt':
      exactKeys(event, [
        'type', 'cleanupIntentId', 'receiptId', 'actionChallengeDigest', 'immutableId',
        'operatorReceiptDigest', 'priorRevision', 'resultingRevision', 'resultingStateDigest', 'outcome',
      ], 'INVALID_EVENT');
      if (!exactId(event.cleanupIntentId) || !exactId(event.receiptId)
        || !digest(event.actionChallengeDigest) || !digest(event.operatorReceiptDigest)
        || !exactId(event.immutableId)
        || !nonEmpty(event.priorRevision) || !nonEmpty(event.resultingRevision)
        || !digest(event.resultingStateDigest)
        || !(CLEANUP_RECEIPT_OUTCOMES as readonly unknown[]).includes(event.outcome)) invalidEvent();
      return;
    case 'cleanup_readback':
      exactKeys(event, [
        'type', 'cleanupIntentId', 'cleanupReceiptId', 'readbackId', 'observerId',
        'immutableId', 'observedRevision', 'observedStateDigest', 'outcome',
      ], 'INVALID_EVENT');
      if (!exactId(event.cleanupIntentId) || !exactId(event.cleanupReceiptId)
        || !exactId(event.readbackId) || !(OBSERVER_IDS as readonly unknown[]).includes(event.observerId)
        || !exactId(event.immutableId) || !nonEmpty(event.observedRevision)
        || !digest(event.observedStateDigest)
        || !(CLEANUP_RECEIPT_OUTCOMES as readonly unknown[]).includes(event.outcome)) invalidEvent();
      return;
    case 'assertion_tokens':
      exactKeys(event, [
        'type', 'caseId', 'stepId', 'observerId', 'expectedTokens', 'observedTokens',
        'pollAttempt', 'pollElapsedMs',
      ], 'INVALID_EVENT');
      if (!nonEmpty(event.caseId) || !nonEmpty(event.stepId)
        || !(OBSERVER_IDS as readonly unknown[]).includes(event.observerId)
        || !enumArray(event.expectedTokens, ASSERTION_TOKENS)
        || !enumArray(event.observedTokens, ASSERTION_TOKENS)
        || !positiveInteger(event.pollAttempt) || !nonNegativeInteger(event.pollElapsedMs)) invalidEvent();
      return;
    case 'unresolved_outcome':
      exactKeys(event, ['type', 'caseId', 'stepId', 'attempt', 'referenceId', 'category'], 'INVALID_EVENT');
      if (!nonEmpty(event.caseId) || !nonEmpty(event.stepId) || !positiveInteger(event.attempt)
        || !exactId(event.referenceId)
        || !(UNRESOLVED_CATEGORIES as readonly unknown[]).includes(event.category)) invalidEvent();
      return;
    case 'operator_challenge_issued':
      exactKeys(event, [
        'type', 'challengeDigest', 'caseId', 'stepId', 'attempt', 'expectedRevision',
        'mutation', 'targetAlias', 'actorAlias', 'expectedRole', 'browserProfileAlias', 'expiresAt',
      ], 'INVALID_EVENT');
      if (!digest(event.challengeDigest) || !nonEmpty(event.caseId) || !nonEmpty(event.stepId)
        || !positiveInteger(event.attempt) || !nonEmpty(event.expectedRevision)
        || !(MUTATION_CLASSES as readonly unknown[]).includes(event.mutation)
        || !nonEmpty(event.targetAlias) || !nonEmpty(event.actorAlias)
        || !['owner', 'admin', 'member'].includes(event.expectedRole)
        || !nonEmpty(event.browserProfileAlias) || !positiveInteger(event.expiresAt)) invalidEvent();
      return;
    case 'operator_challenge_consumed':
      exactKeys(event, ['type', 'challengeDigest'], 'INVALID_EVENT');
      if (!digest(event.challengeDigest)) invalidEvent();
      return;
    case 'operator_challenge_completed':
      exactKeys(event, [
        'type', 'challengeDigest', 'operatorReceiptDigest', 'resourceBindingDigest',
      ], 'INVALID_EVENT');
      if (!digest(event.challengeDigest) || !digest(event.operatorReceiptDigest)
        || !digest(event.resourceBindingDigest)) invalidEvent();
      return;
    case 'run_result':
      exactKeys(event, ['type', 'aggregate'], 'INVALID_EVENT');
      if (!['pass', 'fail', 'blocked', 'ambiguous', 'infrastructure_error', 'cleanup_failed', 'incomplete'].includes(event.aggregate)) invalidEvent();
      return;
    default:
      invalidEvent();
  }
}

function assertExpectedIdentity(runId: string, manifestDigest: string, expected: ReadJournalOptions): void {
  if (runId !== expected.runId) throw new JournalValidationError('FOREIGN_RUN');
  if (manifestDigest !== expected.manifestDigest) throw new JournalValidationError('WRONG_MANIFEST');
}

function assertContentFree(input: unknown): void {
  if (Array.isArray(input)) {
    for (const value of input) assertContentFree(value);
    return;
  }
  if (!isRecord(input)) {
    if (typeof input === 'string' && /(?:xox[baprs]-|sk-[A-Za-z0-9]|Bearer\s+|-----BEGIN .*PRIVATE KEY-----)/i.test(input)) {
      throw new JournalValidationError('UNSAFE_RECORD');
    }
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (/(?:message|body|url|header|cookie|stack|screenshot|transcript|credential|secret|token)$/i.test(key)) {
      throw new JournalValidationError('UNSAFE_RECORD');
    }
    assertContentFree(value);
  }
}

function invalidEvent(): never {
  throw new JournalValidationError('INVALID_EVENT');
}

function exactKeys(input: object, allowed: readonly string[], code: JournalErrorCode): void {
  const accepted = new Set(allowed);
  if (Object.keys(input).some((key) => !accepted.has(key))) throw new JournalValidationError(code);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function nonEmpty(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 512;
}

function stringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every(nonEmpty);
}

function enumArray<const Value extends string>(input: unknown, values: readonly Value[]): input is Value[] {
  return Array.isArray(input) && input.every((value) => values.includes(value));
}

function exactId(input: unknown): input is string {
  return nonEmpty(input)
    && input.length >= 3
    && !/[\s*?\[\]{}\\/]/u.test(input)
    && input !== '.'
    && input !== '..'
    && !input.startsWith('-');
}

function digest(input: unknown): input is string {
  return typeof input === 'string' && /^sha256:[A-Za-z0-9_-]{3,128}$/u.test(input);
}

function positiveInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) > 0;
}

function nonNegativeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

function validTimestamp(input: unknown): input is string {
  return nonEmpty(input) && Number.isFinite(Date.parse(input));
}
