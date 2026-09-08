import {
  closeSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendRunJournal, readRunJournal, type RunJournalHeaderInput } from './journal.ts';
import { assertPrivateEvidencePath } from './evidence.ts';

export interface TargetLockOwner {
  runId: string;
  pid: number;
  /** Historical display metadata only. Locks are local to this laptop. */
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

/**
 * Explicit same-run crash recovery. Acquisition and safe-clear stay unchanged.
 * An immutable transition link fences contenders before atomic replacement of
 * target.lock, so the product target is never unlocked during recovery. If a
 * recoverer dies, a later explicit recovery follows its immutable link and
 * fences that dead owner in turn; it never deletes or steals a transition.
 */
export function recoverTargetLock(path: string, next: TargetLockOwner, input: {
  journalPath: string;
  expected: Pick<RunJournalHeaderInput, 'runId' | 'manifestDigest' | 'targetFingerprint'
    | 'repositoryRevision' | 'servingVersion'>;
}, dependencies: {
  probePid?: (pid: number) => void;
  afterGuardPublished?: () => void;
  afterOwnerPublished?: () => void;
} = {}): void {
  validateOwner(next);
  if (next.pid !== process.pid) throw new TargetLockError('LOCK_CHANGED');
  const root = dirname(path);
  assertPrivateEvidencePath(path, root);
  assertPrivateEvidencePath(input.journalPath, root);
  const journal = readRunJournal(input.journalPath, { ...input.expected, incompleteFinal: 'preserve' });
  if (journal.incompleteFinalRecord !== undefined || Object.entries(input.expected)
    .some(([key, value]) => journal.header[key as keyof typeof journal.header] !== value)) {
    throw new TargetLockError('INVALID_JOURNAL');
  }
  const original = readTargetLock(path);
  if (!original) throw new TargetLockError('LOCK_MISSING');
  if (original.runId !== next.runId || input.expected.runId !== next.runId) {
    throw new TargetLockError('LOCK_DIFFERENT_RUN');
  }
  const guardRoot = `${path}.recovery`;
  assertPrivateEvidencePath(guardRoot, root);
  mkdirSync(guardRoot, { recursive: true, mode: 0o700 });
  const probe = dependencies.probePid ?? ((pid: number) => { process.kill(pid, 0); });
  let previous = original;
  let guardPath = '';
  for (let depth = 0; ; depth += 1) {
    if (depth >= 100) throw new TargetLockError('INVALID_LOCK');
    assertStoppedPid(previous.pid, probe);
    guardPath = join(guardRoot, `${ownerDigest(previous).slice(7)}.json`);
    assertPrivateEvidencePath(guardPath, root);
    let guard: unknown;
    try { guard = JSON.parse(readFileSync(guardPath, 'utf8')); }
    catch (error) {
      if (isNodeError(error, 'ENOENT')) break;
      throw new TargetLockError('INVALID_LOCK');
    }
    if (!isRecord(guard) || !exactKeys(guard, ['previous', 'next'])
      || !sameOwner(validateOwner(guard.previous), previous)) throw new TargetLockError('INVALID_LOCK');
    const successor = validateOwner(guard.next);
    if (successor.runId !== next.runId || sameOwner(successor, previous)) {
      throw new TargetLockError('INVALID_LOCK');
    }
    previous = successor;
  }
  publishOwnerTransition(guardRoot, guardPath, previous, next);
  dependencies.afterGuardPublished?.();
  const current = readTargetLock(path);
  if (!current || !sameOwner(current, original)) throw new TargetLockError('LOCK_CHANGED');
  assertStoppedPid(original.pid, probe);
  const transition = { type: 'target_lock_recovery' as const,
    previousOwnerDigest: ownerDigest(original), guardOwnerDigest: ownerDigest(previous), ownerDigest: ownerDigest(next),
    previousPid: original.pid, pid: next.pid, hostDigest: digest(next.host) };
  appendRunJournal(input.journalPath, { ...transition, stage: 'prepared' }, input.expected);
  const replacement = join(guardRoot, `.owner-${randomUUID()}`);
  writeDurably(replacement, next);
  renameSync(replacement, path);
  syncDirectory(root);
  dependencies.afterOwnerPublished?.();
  appendRunJournal(input.journalPath, { ...transition, stage: 'published' }, input.expected);
}

function assertStoppedPid(pid: number, probe: (pid: number) => void): void {
  try { probe(pid); }
  catch (error) { if (isNodeError(error, 'ESRCH')) return; }
  // EPERM, reused/live PIDs, and every unknown result are not death proof.
  throw new TargetLockError('LOCK_ACTIVE');
}

function ownerDigest(owner: TargetLockOwner): string { return digest(JSON.stringify(owner)); }
function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function publishOwnerTransition(root: string, path: string, previous: TargetLockOwner, next: TargetLockOwner): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new TargetLockError('INVALID_LOCK');
  }
  const candidate = join(root, `.candidate-${randomUUID()}`);
  writeDurably(candidate, { previous, next });
  try { linkSync(candidate, path); }
  catch (error) {
    if (isNodeError(error, 'EEXIST')) throw new TargetLockError('LOCK_ACTIVE');
    throw error;
  } finally { unlinkSync(candidate); }
  syncDirectory(root);
}
function writeDurably(path: string, value: unknown): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, 'utf8'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}
function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Read-only status for environment and doctor consumers. */
export function readTargetLockStatus(
  path: string,
  input: { host: string; isPidActive?: (pid: number) => boolean },
): TargetLockStatus {
  const owner = readTargetLock(path);
  if (owner === undefined) return { status: 'clear' };
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
  // Clearing competes for the same immutable owner transition as recovery.
  // Otherwise a safe-clear process could unlink between a recoverer's check
  // and publication, opening a gap for a different run to acquire the target.
  const guardRoot = `${path}.recovery`;
  publishOwnerTransition(guardRoot, join(guardRoot, `${ownerDigest(owner).slice(7)}.json`), owner,
    { runId: owner.runId, pid: process.pid, host: owner.host, startedAt: new Date().toISOString() });
  const fenced = readTargetLock(path);
  if (!fenced || !sameOwner(fenced, owner)) throw new TargetLockError('LOCK_CHANGED');
  if (isPidActive(fenced.pid)) throw new TargetLockError('LOCK_ACTIVE');
  unlinkSync(path);
}

/** The running coordinator can release only its own cleanup-safe journal. */
export function releaseOwnedTargetLock(path: string, owner: TargetLockOwner, journalPath: string): void {
  if (owner.pid !== process.pid) throw new TargetLockError('LOCK_CHANGED');
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
    return !isNodeError(error, 'ESRCH');
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
