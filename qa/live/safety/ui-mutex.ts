import { randomUUID, createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

interface UiOwner {
  ownership?: undefined;
  runId: string;
  browserAlias: string;
  nonce: string;
  pid: number;
  /** Display metadata, never a local ownership boundary. */
  host: string;
}

interface PortableUiOwner {
  ownership: 'receipt';
  runId: string;
  browserAlias: string;
  nonce: string;
  tokenDigest: string;
  actionDigest: string;
  caseId: string;
  stepId: string;
  acquiredAt: string;
  /** Display metadata, never a local ownership boundary. */
  host: string;
}

type AnyUiOwner = UiOwner | PortableUiOwner;

export interface PortableUiReceipt {
  schemaVersion: 'chickpea-ui-lease-receipt/v1';
  root: string;
  token: string;
  owner: PortableUiOwner;
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
      if (reserved && (isPortableOwner(reserved) || !sameActor(reserved, owner))) throw new UiMutexError('BROWSER_RESERVED');
    };
    assertReservation();
    const lockPath = join(this.root, 'interaction.lock');
    publishOwner(lockPath, owner, 'UI_BUSY');
    try { assertReservation(); } catch (error) { removeOwned(lockPath, owner); throw error; }
    return new UiWindowLease(lockPath, reservationPath, owner);
  }

  acquirePortable(input: { runId: string; browserAlias: string; caseId: string; stepId: string;
    actionDigest: string; token?: string; acquiredAt?: string }): PortableUiReceipt {
    if (![input.runId, input.browserAlias, input.caseId, input.stepId].every(safeAlias)
      || !/^sha256:[a-f0-9]{64}$/u.test(input.actionDigest)) throw new UiMutexError('UNSAFE_UI_LOCK');
    const token = input.token ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/u.test(token)) throw new UiMutexError('UNSAFE_UI_LOCK');
    const owner: PortableUiOwner = {
      ownership: 'receipt', runId: input.runId, browserAlias: input.browserAlias,
      nonce: randomUUID(), tokenDigest: tokenDigest(token), actionDigest: input.actionDigest,
      caseId: input.caseId, stepId: input.stepId,
      acquiredAt: input.acquiredAt ?? new Date().toISOString(), host: hostname(),
    };
    if (!Number.isFinite(Date.parse(owner.acquiredAt))) throw new UiMutexError('UNSAFE_UI_LOCK');
    const reservationPath = browserReservationPath(this.root, input.browserAlias);
    assertPortableReservation(reservationPath, owner);
    const lockPath = join(this.root, 'interaction.lock');
    publishOwner(lockPath, owner, 'UI_BUSY');
    try { assertPortableReservation(reservationPath, owner); }
    catch (error) { removeOwned(lockPath, owner); throw error; }
    return Object.freeze({ schemaVersion: 'chickpea-ui-lease-receipt/v1', root: this.root,
      token, owner: Object.freeze(owner) });
  }

  resumePortable(receipt: PortableUiReceipt): void {
    const owner = validatePortableReceipt(receipt, this.root);
    assertPortableReservation(browserReservationPath(this.root, owner.browserAlias), owner, true);
    publishOwner(join(this.root, 'interaction.lock'), owner, 'UI_BUSY');
  }

  pausePortable(receipt: PortableUiReceipt): void {
    const owner = validatePortableReceipt(receipt, this.root);
    const lockPath = join(this.root, 'interaction.lock');
    assertOwnedByReceipt(lockPath, owner);
    const reservationPath = browserReservationPath(this.root, owner.browserAlias);
    const reserved = readOwner(reservationPath);
    if (reserved && !samePortableOwner(reserved, owner)) throw new UiMutexError('BROWSER_RESERVED');
    if (!reserved) publishOwner(reservationPath, owner, 'BROWSER_RESERVED');
    removeOwned(lockPath, owner);
  }

  releasePortable(receipt: PortableUiReceipt): void {
    const owner = validatePortableReceipt(receipt, this.root);
    assertOwnedByReceipt(join(this.root, 'interaction.lock'), owner);
    removeOwned(join(this.root, 'interaction.lock'), owner);
  }

  finishPortable(receipt: PortableUiReceipt): void {
    const owner = validatePortableReceipt(receipt, this.root);
    const lockPath = join(this.root, 'interaction.lock');
    assertOwnedByReceipt(lockPath, owner);
    const reservationPath = browserReservationPath(this.root, owner.browserAlias);
    const reserved = readOwner(reservationPath);
    if (reserved) {
      if (!samePortableOwner(reserved, owner)) throw new UiMutexError('BROWSER_RESERVED');
      removeOwned(reservationPath, owner);
    }
    removeOwned(lockPath, owner);
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
    for (const { owner } of owned) {
      if (isPortableOwner(owner)) throw new UiMutexError('UI_BUSY');
      assertStoppedLocalOwner(owner);
    }
    for (const { path, owner } of owned) {
      if (isPortableOwner(owner)) throw new UiMutexError('UI_BUSY');
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
    if (reserved && (isPortableOwner(reserved) || !sameActor(reserved, this.owner))) throw new UiMutexError('BROWSER_RESERVED');
    if (!reserved) publishOwner(this.reservationPath, this.owner, 'BROWSER_RESERVED');
    this.release();
  }

  /** Called after the gate visibly advances, while holding the interaction lock. */
  finishReservation(): void {
    this.assertOwned();
    const reserved = readOwner(this.reservationPath);
    if (!reserved) return;
    if (isPortableOwner(reserved) || !sameActor(reserved, this.owner)) throw new UiMutexError('BROWSER_RESERVED');
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

function publishOwner(path: string, owner: AnyUiOwner, busy: 'UI_BUSY' | 'BROWSER_RESERVED'): void {
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

function readOwner(path: string): AnyUiOwner | undefined {
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
  if (!validLegacyOwner(owner) && !validPortableOwner(owner)) {
    throw new UiMutexError('UNSAFE_UI_LOCK');
  }
  return owner as AnyUiOwner;
}

function removeOwned(path: string, owner: AnyUiOwner): void {
  if (JSON.stringify(readOwner(path)) !== JSON.stringify(owner)) throw new UiMutexError('UI_OWNER_CHANGED');
  unlinkSync(path);
}

function sameActor(left: UiOwner, right: UiOwner): boolean {
  return left.runId === right.runId && left.browserAlias === right.browserAlias
    && left.pid === right.pid;
}

function browserReservationPath(root: string, browserAlias: string): string {
  return join(root, `browser-${createHash('sha256').update(browserAlias).digest('hex')}.lock`);
}

function tokenDigest(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function isPortableOwner(owner: unknown): owner is PortableUiOwner {
  return !!owner && typeof owner === 'object' && 'ownership' in owner && owner.ownership === 'receipt';
}

function samePortableOwner(left: AnyUiOwner, right: PortableUiOwner): boolean {
  return isPortableOwner(left) && JSON.stringify(left) === JSON.stringify(right);
}

function assertPortableReservation(path: string, owner: PortableUiOwner, required = false): void {
  const reserved = readOwner(path);
  if (!reserved) {
    if (required) throw new UiMutexError('BROWSER_RESERVED');
    return;
  }
  if (!samePortableOwner(reserved, owner)) throw new UiMutexError('BROWSER_RESERVED');
}

function assertOwnedByReceipt(path: string, owner: PortableUiOwner): void {
  if (!samePortableOwner(readOwner(path) as AnyUiOwner, owner)) throw new UiMutexError('UI_OWNER_CHANGED');
}

function validatePortableReceipt(receipt: PortableUiReceipt, root: string): PortableUiOwner {
  if (!receipt || receipt.schemaVersion !== 'chickpea-ui-lease-receipt/v1'
    || receipt.root !== root || !/^[0-9a-f-]{36}$/u.test(receipt.token)
    || !validPortableOwner(receipt.owner)
    || receipt.owner.tokenDigest !== tokenDigest(receipt.token)) throw new UiMutexError('UNSAFE_UI_LOCK');
  return receipt.owner;
}

function validLegacyOwner(owner: unknown): owner is UiOwner {
  return !!owner && typeof owner === 'object'
    && Object.keys(owner).sort().join(',') === 'browserAlias,host,nonce,pid,runId'
    && safeAlias((owner as UiOwner).runId) && safeAlias((owner as UiOwner).browserAlias)
    && typeof (owner as UiOwner).nonce === 'string' && /^[0-9a-f-]{36}$/u.test((owner as UiOwner).nonce)
    && Number.isSafeInteger((owner as UiOwner).pid) && (owner as UiOwner).pid > 0
    && typeof (owner as UiOwner).host === 'string';
}

function validPortableOwner(owner: unknown): owner is PortableUiOwner {
  if (!owner || typeof owner !== 'object') return false;
  const value = owner as PortableUiOwner;
  return Object.keys(value).sort().join(',') === 'acquiredAt,actionDigest,browserAlias,caseId,host,nonce,ownership,runId,stepId,tokenDigest'
    && value.ownership === 'receipt' && [value.runId, value.browserAlias, value.caseId, value.stepId].every(safeAlias)
    && /^[0-9a-f-]{36}$/u.test(value.nonce) && /^sha256:[a-f0-9]{64}$/u.test(value.tokenDigest)
    && /^sha256:[a-f0-9]{64}$/u.test(value.actionDigest) && Number.isFinite(Date.parse(value.acquiredAt))
    && typeof value.host === 'string';
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
