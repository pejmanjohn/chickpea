import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';

export interface TargetLockOwner {
  runId: string;
  pid: number;
  host: string;
  startedAt: string;
}

export type TargetLockErrorCode =
  | 'INVALID_LOCK'
  | 'LOCK_ACTIVE'
  | 'LOCK_FOREIGN_HOST'
  | 'LOCK_DIFFERENT_RUN'
  | 'LOCK_CHANGED'
  | 'LOCK_MISSING'
  | 'INVALID_JOURNAL'
  | 'UNRESOLVED_INTENT'
  | 'UNRESOLVED_CLEANUP';

export class TargetLockError extends Error {
  readonly code: TargetLockErrorCode;

  constructor(code: TargetLockErrorCode) {
    super(code);
    this.name = 'TargetLockError';
    this.code = code;
  }
}

export interface TargetLockStatus {
  status: 'clear' | 'live' | 'stale' | 'foreign';
  ownerRunId?: string;
  owner?: TargetLockOwner;
}

export interface RunJournalStatus {
  runId: string;
  readonly unresolvedIntentIds: readonly string[];
  readonly unresolvedCleanupIds: readonly string[];
  safeToClear: boolean;
}

export interface TargetLockDependencies {
  isPidActive?: (pid: number) => boolean;
}

export function targetLockPath(evidenceRoot: string): string {
  if (typeof evidenceRoot !== 'string' || evidenceRoot.length === 0) {
    throw new TargetLockError('INVALID_LOCK');
  }
  return join(evidenceRoot, 'target.lock');
}

export function acquireTargetLock(
  path: string,
  owner: TargetLockOwner,
  _dependencies: TargetLockDependencies = {},
): 'acquired' {
  validateOwner(owner);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      const current = readTargetLock(path);
      if (current === undefined) throw new TargetLockError('LOCK_MISSING');
      if (current.host !== owner.host) throw new TargetLockError('LOCK_FOREIGN_HOST');
      if (current.runId !== owner.runId) throw new TargetLockError('LOCK_DIFFERENT_RUN');
      throw new TargetLockError('LOCK_ACTIVE');
    }
    throw error;
  }
  try {
    writeSync(descriptor, `${JSON.stringify(owner)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return 'acquired';
}

export function readTargetLock(path: string): TargetLockOwner | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw new TargetLockError('INVALID_LOCK');
  }
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    throw new TargetLockError('INVALID_LOCK');
  }
  return validateOwner(input);
}

/** Read-only status for environment and doctor consumers. */
export function readTargetLockStatus(
  path: string,
  input: { host: string; isPidActive?: (pid: number) => boolean },
): TargetLockStatus {
  const owner = readTargetLock(path);
  if (owner === undefined) return { status: 'clear' };
  if (owner.host !== input.host) {
    return { status: 'foreign', ownerRunId: owner.runId, owner };
  }
  const active = (input.isPidActive ?? defaultPidActive)(owner.pid);
  return {
    status: active ? 'live' : 'stale',
    ownerRunId: owner.runId,
    owner,
  };
}

/**
 * Read only the content-free recovery state needed for lock release. The
 * environment layer never interprets or mutates verifier journal records.
 */
export function readRunJournalStatus(path: string, expectedRunId?: string): RunJournalStatus {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    throw new TargetLockError('INVALID_JOURNAL');
  }
  const events = lines.map((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new TargetLockError('INVALID_JOURNAL');
    }
  });
  const header = events[0];
  if (header === undefined
    || !((header.record === 'header'
      && header.schemaVersion === 'chickpea-live-journal/v1'
      && header.seq === 0)
      || (header.type === 'run'
        && header.schemaVersion === 'chickpea-live-run-journal/v1'))
    || typeof header.runId !== 'string'
    || !validRunId(header.runId)
    || (expectedRunId !== undefined && header.runId !== expectedRunId)) {
    throw new TargetLockError('INVALID_JOURNAL');
  }
  const eventRecords = events.slice(1);
  const eventRunMismatch = eventRecords.some((event) =>
    event.runId !== undefined && event.runId !== header.runId
  );
  if (eventRunMismatch) throw new TargetLockError('INVALID_JOURNAL');
  const normalizedEvents = eventRecords.map((record) =>
    record.record === 'event' && isRecord(record.event) ? record.event : record
  );
  const unresolvedIntentIds = unresolvedIntentIdsFrom(normalizedEvents);
  const unresolvedCleanupIds = unresolvedCleanupIdsFrom(normalizedEvents);
  return Object.freeze({
    runId: header.runId,
    unresolvedIntentIds: Object.freeze(unresolvedIntentIds),
    unresolvedCleanupIds: Object.freeze(unresolvedCleanupIds),
    safeToClear: unresolvedIntentIds.length === 0 && unresolvedCleanupIds.length === 0,
  });
}

export function clearTargetLock(
  path: string,
  input: {
    runId: string;
    host: string;
    journal: RunJournalStatus;
    isPidActive?: (pid: number) => boolean;
  },
): void {
  const owner = readTargetLock(path);
  if (owner === undefined) throw new TargetLockError('LOCK_MISSING');
  if (owner.host !== input.host) throw new TargetLockError('LOCK_FOREIGN_HOST');
  if (owner.runId !== input.runId || input.journal.runId !== input.runId) {
    throw new TargetLockError('LOCK_DIFFERENT_RUN');
  }
  const isPidActive = input.isPidActive ?? defaultPidActive;
  if (isPidActive(owner.pid)) throw new TargetLockError('LOCK_ACTIVE');
  if (input.journal.unresolvedIntentIds.length > 0) {
    throw new TargetLockError('UNRESOLVED_INTENT');
  }
  if (input.journal.unresolvedCleanupIds.length > 0 || !input.journal.safeToClear) {
    throw new TargetLockError('UNRESOLVED_CLEANUP');
  }
  const rechecked = readTargetLock(path);
  if (rechecked === undefined) throw new TargetLockError('LOCK_MISSING');
  if (!sameOwner(owner, rechecked)) throw new TargetLockError('LOCK_CHANGED');
  if (isPidActive(rechecked.pid)) throw new TargetLockError('LOCK_ACTIVE');
  unlinkSync(path);
}

/** The running coordinator can release only its own cleanup-safe journal. */
export function releaseOwnedTargetLock(path: string, owner: TargetLockOwner, journalPath: string): void {
  if (owner.pid !== process.pid || owner.host !== hostname()) throw new TargetLockError('LOCK_FOREIGN_HOST');
  const current = readTargetLock(path);
  if (!current || !sameOwner(current, owner)) throw new TargetLockError('LOCK_CHANGED');
  const journal = readRunJournalStatus(journalPath, owner.runId);
  if (journal.unresolvedIntentIds.length) throw new TargetLockError('UNRESOLVED_INTENT');
  if (journal.unresolvedCleanupIds.length || !journal.safeToClear) throw new TargetLockError('UNRESOLVED_CLEANUP');
  const rechecked = readTargetLock(path);
  if (!rechecked || !sameOwner(rechecked, owner)) throw new TargetLockError('LOCK_CHANGED');
  unlinkSync(path);
}

function unresolvedIntentIdsFrom(events: readonly Record<string, unknown>[]): string[] {
  const unresolved = new Set<string>();
  for (const event of events) {
    if (event.type === 'intent' && typeof event.intentId === 'string') {
      unresolved.add(event.intentId);
    }
    if ((event.type === 'receipt' || event.type === 'readback')
      && event.outcome !== 'ambiguous'
      && typeof event.intentId === 'string') {
      unresolved.delete(event.intentId);
    }
  }
  return [...unresolved].sort();
}

function unresolvedCleanupIdsFrom(events: readonly Record<string, unknown>[]): string[] {
  const unresolved = new Set<string>();
  const cleanupResources = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'mutation_receipt' && typeof event.receiptId === 'string') {
      unresolved.add(event.receiptId);
    }
    if (event.type === 'cleanup_intent' && typeof event.cleanupIntentId === 'string') {
      unresolved.add(event.cleanupIntentId);
      if (typeof event.mutationReceiptId === 'string') {
        cleanupResources.set(event.cleanupIntentId, event.mutationReceiptId);
      }
    }
    if ((event.type === 'cleanup_receipt' || event.type === 'cleanup_readback')
      && event.outcome !== 'ambiguous'
      && typeof event.cleanupIntentId === 'string') {
      unresolved.delete(event.cleanupIntentId);
      const mutationReceiptId = cleanupResources.get(event.cleanupIntentId);
      if (mutationReceiptId !== undefined) unresolved.delete(mutationReceiptId);
    }
    if (event.type === 'unresolved_outcome' && typeof event.referenceId === 'string') {
      unresolved.add(event.referenceId);
    }
    if (event.type === 'postflight_required' && typeof event.caseId === 'string') {
      unresolved.add(`postflight:${event.caseId}`);
    }
    if (event.type === 'postflight_receipt' && typeof event.caseId === 'string') {
      const key = `postflight:${event.caseId}`;
      if (event.result === 'pass') unresolved.delete(key);
      else unresolved.add(key);
    }
  }
  return [...unresolved].sort();
}

function validateOwner(input: unknown): TargetLockOwner {
  if (!isRecord(input)
    || !exactKeys(input, ['runId', 'pid', 'host', 'startedAt'])
    || typeof input.runId !== 'string'
    || !validRunId(input.runId)
    || !Number.isSafeInteger(input.pid)
    || Number(input.pid) <= 0
    || typeof input.host !== 'string'
    || input.host.length === 0
    || input.host.length > 255
    || typeof input.startedAt !== 'string'
    || !Number.isFinite(Date.parse(input.startedAt))) {
    throw new TargetLockError('INVALID_LOCK');
  }
  return input as unknown as TargetLockOwner;
}

function validRunId(input: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(input) && /[^.]/u.test(input);
}

function sameOwner(left: TargetLockOwner, right: TargetLockOwner): boolean {
  return left.runId === right.runId
    && left.pid === right.pid
    && left.host === right.host
    && left.startedAt === right.startedAt;
}

function defaultPidActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function exactKeys(input: object, expected: readonly string[]): boolean {
  const keys = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length
    && keys.every((key, index) => key === wanted[index]);
}
