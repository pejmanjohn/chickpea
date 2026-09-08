import { randomUUID, createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

interface UiOwner {
  runId: string;
  browserAlias: string;
  nonce: string;
  pid: number;
  /** Display metadata, never a local ownership boundary. */
  host: string;
}

export class UiMutexError extends Error {
  constructor(readonly code: 'UI_BUSY' | 'BROWSER_RESERVED' | 'UI_OWNER_CHANGED' | 'UNSAFE_UI_LOCK') {
    super(code);
    this.name = 'UiMutexError';
  }
}

/** One host-wide interaction lock; no implicit stale-lock takeover. */
export class HostUiMutex {
  constructor(private readonly root: string) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new UiMutexError('UNSAFE_UI_LOCK');
    safeDirectory(root);
  }

  acquire(runId: string, browserAlias: string): UiWindowLease {
    if (!safeAlias(runId) || !safeAlias(browserAlias)) throw new UiMutexError('UNSAFE_UI_LOCK');
    const owner: UiOwner = { runId, browserAlias, nonce: randomUUID(), pid: process.pid, host: hostname() };
    const reservationPath = join(this.root, `browser-${createHash('sha256').update(browserAlias).digest('hex')}.lock`);
    const assertReservation = () => {
      const reserved = readOwner(reservationPath);
      if (reserved && !sameActor(reserved, owner)) throw new UiMutexError('BROWSER_RESERVED');
    };
    assertReservation();
    const lockPath = join(this.root, 'interaction.lock');
    publishOwner(lockPath, owner, 'UI_BUSY');
    try { assertReservation(); } catch (error) { removeOwned(lockPath, owner); throw error; }
    return new UiWindowLease(lockPath, reservationPath, owner);
  }

  /** Explicit crash recovery only. It never clears a product target lock. */
  clearStoppedOwner(runId: string, browserAlias: string): void {
    if (!safeAlias(runId) || !safeAlias(browserAlias)) throw new UiMutexError('UNSAFE_UI_LOCK');
    safeDirectory(this.root);
    const paths = [join(this.root, 'interaction.lock'),
      join(this.root, `browser-${createHash('sha256').update(browserAlias).digest('hex')}.lock`)];
    const owned = paths.flatMap((path) => {
      const owner = readOwner(path);
      return owner?.runId === runId && owner.browserAlias === browserAlias ? [{ path, owner }] : [];
    });
    if (owned.length === 0) throw new UiMutexError('UI_OWNER_CHANGED');
    for (const { owner } of owned) assertStoppedLocalOwner(owner);
    for (const { path, owner } of owned) {
      assertStoppedLocalOwner(owner);
      removeOwned(path, owner);
    }
  }
}

export class UiWindowLease {
  private released = false;
  constructor(private readonly path: string, private readonly reservationPath: string, private readonly owner: UiOwner) {}

  /** A human gate releases the host interaction lock but keeps its browser. */
  pause(): void {
    this.assertOwned();
    const reserved = readOwner(this.reservationPath);
    if (reserved && !sameActor(reserved, this.owner)) throw new UiMutexError('BROWSER_RESERVED');
    if (!reserved) publishOwner(this.reservationPath, this.owner, 'BROWSER_RESERVED');
    this.release();
  }

  /** Called after the gate visibly advances, while holding the interaction lock. */
  finishReservation(): void {
    this.assertOwned();
    const reserved = readOwner(this.reservationPath);
    if (!reserved) return;
    if (!sameActor(reserved, this.owner)) throw new UiMutexError('BROWSER_RESERVED');
    removeOwned(this.reservationPath, reserved);
  }

  release(): void {
    if (this.released) return;
    this.assertOwned();
    removeOwned(this.path, this.owner);
    this.released = true;
  }

  assertOwned(): void {
    if (this.released || JSON.stringify(readOwner(this.path)) !== JSON.stringify(this.owner)) {
      throw new UiMutexError('UI_OWNER_CHANGED');
    }
  }
}

function publishOwner(path: string, owner: UiOwner, busy: 'UI_BUSY' | 'BROWSER_RESERVED'): void {
  safeDirectory(dirname(path));
  const candidate = join(dirname(path), `.ui-${randomUUID()}.tmp`);
  const descriptor = openSync(candidate, 'wx', 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(owner)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  try { linkSync(candidate, path); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new UiMutexError(busy);
    throw error;
  } finally { unlinkSync(candidate); }
}

function readOwner(path: string): UiOwner | undefined {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new UiMutexError('UNSAFE_UI_LOCK');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new UiMutexError('UNSAFE_UI_LOCK');
  }
  let owner;
  try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new UiMutexError('UNSAFE_UI_LOCK'); }
  if (!owner || typeof owner !== 'object'
    || Object.keys(owner).sort().join(',') !== 'browserAlias,host,nonce,pid,runId'
    || !safeAlias(owner.runId) || !safeAlias(owner.browserAlias)
    || typeof owner.nonce !== 'string' || !/^[0-9a-f-]{36}$/u.test(owner.nonce)
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== 'string') {
    throw new UiMutexError('UNSAFE_UI_LOCK');
  }
  return owner as UiOwner;
}

function removeOwned(path: string, owner: UiOwner): void {
  if (JSON.stringify(readOwner(path)) !== JSON.stringify(owner)) throw new UiMutexError('UI_OWNER_CHANGED');
  unlinkSync(path);
}

function sameActor(left: UiOwner, right: UiOwner): boolean {
  return left.runId === right.runId && left.browserAlias === right.browserAlias
    && left.pid === right.pid;
}

function assertStoppedLocalOwner(owner: UiOwner): void {
  try { process.kill(owner.pid, 0); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
  }
  throw new UiMutexError('UI_BUSY');
}

function safeAlias(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function safeDirectory(path: string): void {
  let ancestor = path;
  while (ancestor !== dirname(ancestor)) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UiMutexError('UNSAFE_UI_LOCK');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    ancestor = dirname(ancestor);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new UiMutexError('UNSAFE_UI_LOCK');
}
