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
  CLEANUP_RESULTS,
  MUTATION_CLASSES,
  PRIMARY_RESULTS,
  SUITES,
  TYPED_REASONS,
  type ActionId,
  type CleanupResult,
  type MutationClass,
  type PrimaryResult,
  type Suite,
  type TypedReason,
} from '../schema.ts';
import {
  RUN_PHASES,
  type ActionReceiptOutcome,
  type RunPhase,
  type RunnerOutputKind,
} from '../state.ts';

export const RUN_JOURNAL_SCHEMA = 'chickpea-live-journal/v1' as const;

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
  validateEventData(event);
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
        || !['completed', 'denied', 'cancelled', 'expired', 'wrong_session', 'provider_error', 'ambiguous', 'not_applied'].includes(event.outcome)) invalidEvent();
      return;
    case 'readback':
      exactKeys(event, ['type', 'intentId', 'variantId', 'actionRef', 'outcome'], 'INVALID_EVENT');
      if (!nonEmpty(event.intentId) || !nonEmpty(event.variantId) || !nonEmpty(event.actionRef)
        || !['applied', 'absent', 'ambiguous'].includes(event.outcome)) invalidEvent();
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
    if (typeof input === 'string' && /(?:xox[baprs]-|Bearer\s+|-----BEGIN .*PRIVATE KEY-----)/i.test(input)) {
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

function validTimestamp(input: unknown): input is string {
  return nonEmpty(input) && Number.isFinite(Date.parse(input));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
