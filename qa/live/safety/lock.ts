import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { isNodeError } from './errors.ts';

import type { ReadJournalResult } from './journal.ts';

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
  | 'UNRESOLVED_INTENT';

export class TargetLockError extends Error {
  readonly code: TargetLockErrorCode;

  constructor(code: TargetLockErrorCode) {
    super(code);
    this.name = 'TargetLockError';
    this.code = code;
  }
}

export interface TargetLockDependencies {
  isPidActive?: (pid: number) => boolean;
}

export function acquireTargetLock(
  path: string,
  owner: TargetLockOwner,
  dependencies: TargetLockDependencies = {},
): 'acquired' | 'reacquired' {
  validateOwner(owner);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    writeOwner(descriptor, owner);
    return 'acquired';
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }

  const current = readTargetLock(path);
  if (current === undefined) throw new TargetLockError('LOCK_MISSING');
  if (current.host !== owner.host) throw new TargetLockError('LOCK_FOREIGN_HOST');
  if (current.runId !== owner.runId) throw new TargetLockError('LOCK_DIFFERENT_RUN');
  const isPidActive = dependencies.isPidActive ?? defaultPidActive;
  if (isPidActive(current.pid)) throw new TargetLockError('LOCK_ACTIVE');

  // Reacquisition is the one explicit replacement allowed by KTD10. Keep the
  // existing inode open, revalidate its owner, then durably replace its stale
  // same-run contents instead of unlinking a lock another process could steal.
  const descriptor = openSync(path, 'r+');
  try {
    const rechecked = parseOwner(readFileSync(descriptor, 'utf8'));
    if (rechecked.host !== owner.host || rechecked.runId !== owner.runId || rechecked.pid !== current.pid) {
      throw new TargetLockError('LOCK_ACTIVE');
    }
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, `${JSON.stringify(owner)}\n`, 0, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return 'reacquired';
}

export function readTargetLock(path: string): TargetLockOwner | undefined {
  try {
    return parseOwner(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    if (error instanceof TargetLockError) throw error;
    throw new TargetLockError('INVALID_LOCK');
  }
}

export function clearTargetLock(
  path: string,
  input: {
    runId: string;
    host: string;
    journal: ReadJournalResult;
    isPidActive?: (pid: number) => boolean;
  },
): void {
  const owner = readTargetLock(path);
  if (owner === undefined) throw new TargetLockError('LOCK_MISSING');
  if (owner.host !== input.host) throw new TargetLockError('LOCK_FOREIGN_HOST');
  if (owner.runId !== input.runId || input.journal.header.runId !== input.runId) {
    throw new TargetLockError('LOCK_DIFFERENT_RUN');
  }
  const isPidActive = input.isPidActive ?? defaultPidActive;
  if (isPidActive(owner.pid)) {
    throw new TargetLockError('LOCK_ACTIVE');
  }
  if (unresolvedIntentIds(input.journal).length > 0) {
    throw new TargetLockError('UNRESOLVED_INTENT');
  }
  const rechecked = readTargetLock(path);
  if (rechecked === undefined) throw new TargetLockError('LOCK_MISSING');
  if (!sameOwner(owner, rechecked)) throw new TargetLockError('LOCK_CHANGED');
  if (isPidActive(rechecked.pid)) throw new TargetLockError('LOCK_ACTIVE');
  unlinkSync(path);
}

export function unresolvedIntentIds(journal: ReadJournalResult): string[] {
  const unresolved = new Set<string>();
  for (const record of journal.events) {
    const event = record.event;
    if (event.type === 'intent') unresolved.add(event.intentId);
    if (event.type === 'receipt' && event.outcome !== 'ambiguous') unresolved.delete(event.intentId);
    if (event.type === 'readback' && event.outcome !== 'ambiguous') {
      unresolved.delete(event.intentId);
    }
  }
  return [...unresolved].sort();
}

function writeOwner(descriptor: number, owner: TargetLockOwner): void {
  try {
    writeSync(descriptor, `${JSON.stringify(owner)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseOwner(contents: string): TargetLockOwner {
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    throw new TargetLockError('INVALID_LOCK');
  }
  if (!isRecord(input)
    || !exactKeys(input, ['runId', 'pid', 'host', 'startedAt'])
    || typeof input.runId !== 'string'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(input.runId)
    || !Number.isSafeInteger(input.pid)
    || (input.pid as number) <= 0
    || typeof input.host !== 'string'
    || input.host.length === 0
    || input.host.length > 255
    || typeof input.startedAt !== 'string'
    || !Number.isFinite(Date.parse(input.startedAt))) {
    throw new TargetLockError('INVALID_LOCK');
  }
  return input as unknown as TargetLockOwner;
}

function validateOwner(owner: TargetLockOwner): void {
  parseOwner(JSON.stringify(owner));
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
    return isNodeError(error) && error.code === 'EPERM';
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function exactKeys(input: object, expected: readonly string[]): boolean {
  const keys = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}
