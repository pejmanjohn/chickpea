import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { PlatformEnv } from '../config/state-backend.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveStateDbPath } from '../state/node-state-db.ts';
import {
  encodeCredentialKey,
  type CredentialKeyring,
} from './secret-envelope.ts';

export const WORKER_CREDENTIAL_CURRENT_ID = 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID';
export const WORKER_CREDENTIAL_KEY_PREFIX = 'CHICKPEA_CREDENTIAL_KEY_';
const KEYRING_VERSION = 1;

export interface NodeCredentialKeyringOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export interface StageNodeCredentialKeyRotationOptions extends NodeCredentialKeyringOptions {
  expectedCurrentKeyId: string;
  nextKeyId?: string;
}

/** Generate a new independent 256-bit root; CHICKPEA_AUTH_SECRET is never read. */
export function generateCredentialKeyring(keyId = generateKeyId()): CredentialKeyring {
  const key = new Uint8Array(32);
  globalThis.crypto.getRandomValues(key);
  return { currentKeyId: requireKeyId(keyId), keys: { [keyId]: encodeCredentialKey(key) } };
}

export function resolveNodeCredentialKeyringPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.CHICKPEA_CREDENTIAL_KEYRING_PATH?.trim();
  if (configured) return path.resolve(configured);
  const statePath = resolveStateDbPath(env);
  if (statePath === ':memory:') {
    throw new Error(
      'Node Slack credential encryption requires CHICKPEA_CREDENTIAL_KEYRING_PATH when state is in memory.',
    );
  }
  return `${path.resolve(statePath)}.credential-keyring.json`;
}

/**
 * The first-class Node path creates the keyring once at mode 0600 beside, but
 * never inside, the state database. A later process reads the exact same root.
 */
export function loadOrCreateNodeCredentialKeyring(
  options: NodeCredentialKeyringOptions = {},
): CredentialKeyring {
  const keyringPath = options.path ?? resolveNodeCredentialKeyringPath(options.env);
  if (!existsSync(keyringPath)) createNodeCredentialKeyring(keyringPath);
  const mode = statSync(keyringPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Node Slack credential keyring permissions are unsafe at ${keyringPath}; run chmod 600 and retry.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyringPath, 'utf8'));
  } catch {
    throw new Error(
      `Node Slack credential keyring is unreadable at ${keyringPath}; restore its backup and retry.`,
    );
  }
  return parseKeyringFile(parsed, keyringPath);
}

/**
 * Atomically publish a new current Node key while retaining the prior key for
 * resumable state rewrap. Callers must then advance the TAG_STATE epoch and
 * rewrap before retiring the prior key.
 */
export function stageNodeCredentialKeyRotation(
  options: StageNodeCredentialKeyRotationOptions,
): CredentialKeyring {
  const keyringPath = options.path ?? resolveNodeCredentialKeyringPath(options.env);
  return withNodeKeyringLock(keyringPath, () => {
    const current = loadOrCreateNodeCredentialKeyring({ path: keyringPath });
    const expected = requireKeyId(options.expectedCurrentKeyId);
    const requestedNext = options.nextKeyId ? requireKeyId(options.nextKeyId) : undefined;
    if (current.currentKeyId !== expected) {
      if (requestedNext && current.currentKeyId === requestedNext && current.keys[expected]) {
        return current;
      }
      throw new Error('Node Slack credential keyring changed concurrently.');
    }
    const next = generateCredentialKeyring(requestedNext);
    const staged = {
      currentKeyId: next.currentKeyId,
      keys: { ...current.keys, ...next.keys },
    };
    writeNodeCredentialKeyringAtomically(keyringPath, staged);
    return staged;
  });
}

/**
 * Remove a prior Node key after `rotateSlackCredentialEncryption` reports a
 * fenced zero count. The current key can never be retired by this operation.
 */
export function retireNodeCredentialKey(
  keyId: string,
  options: NodeCredentialKeyringOptions = {},
): CredentialKeyring {
  const keyringPath = options.path ?? resolveNodeCredentialKeyringPath(options.env);
  return withNodeKeyringLock(keyringPath, () => {
    const current = loadOrCreateNodeCredentialKeyring({ path: keyringPath });
    const retiring = requireKeyId(keyId);
    if (retiring === current.currentKeyId) {
      throw new Error('Node Slack credential keyring cannot retire its current key.');
    }
    if (!current.keys[retiring]) return current;
    const keys = { ...current.keys };
    delete keys[retiring];
    const retired = { currentKeyId: current.currentKeyId, keys };
    writeNodeCredentialKeyringAtomically(keyringPath, retired);
    return retired;
  });
}

export function loadWorkerCredentialKeyring(env: PlatformEnv): CredentialKeyring {
  const currentKeyId = typeof env[WORKER_CREDENTIAL_CURRENT_ID] === 'string'
    ? String(env[WORKER_CREDENTIAL_CURRENT_ID]).trim()
    : '';
  if (!currentKeyId) {
    throw new Error(
      'Cloudflare Slack credential encryption is not provisioned; deploy with npm run deploy to mint the versioned Worker key slots.',
    );
  }
  requireKeyId(currentKeyId);
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === WORKER_CREDENTIAL_CURRENT_ID || !name.startsWith(WORKER_CREDENTIAL_KEY_PREFIX)) {
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) continue;
    const keyId = name.slice(WORKER_CREDENTIAL_KEY_PREFIX.length).toLowerCase();
    requireEncodedKey(value);
    keys[keyId] = value;
  }
  // Key IDs are normalized to lower-case in Worker slot names. Reject a
  // current ID that cannot select its exact versioned slot.
  const normalizedCurrent = currentKeyId.toLowerCase();
  if (!keys[normalizedCurrent]) {
    throw new Error(
      `Cloudflare Slack credential key slot ${workerCredentialKeySlot(currentKeyId)} is missing; restore it before serving traffic.`,
    );
  }
  return { currentKeyId: normalizedCurrent, keys };
}

export function loadCredentialKeyring(env?: PlatformEnv): CredentialKeyring {
  return isCloudflareTarget()
    ? loadWorkerCredentialKeyring(env ?? {})
    : loadOrCreateNodeCredentialKeyring();
}

export function workerCredentialKeySlot(keyId: string): string {
  return `${WORKER_CREDENTIAL_KEY_PREFIX}${requireKeyId(keyId).toUpperCase()}`;
}

function createNodeCredentialKeyring(keyringPath: string): void {
  const directory = path.dirname(keyringPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyring = generateCredentialKeyring();
  const serialized = `${JSON.stringify({ version: KEYRING_VERSION, ...keyring }, null, 2)}\n`;
  const temporary = `${keyringPath}.${process.pid}.${randomHex(8)}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    try {
      // A hard link publishes a fully written inode without replacing a
      // keyring created by a concurrent process.
      linkSync(temporary, keyringPath);
      chmodSync(keyringPath, 0o600);
    } catch (error) {
      if (!existsSync(keyringPath)) throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* already absent */ }
  }
}

function writeNodeCredentialKeyringAtomically(
  keyringPath: string,
  keyring: CredentialKeyring,
): void {
  const parsed = parseKeyringFile(
    { version: KEYRING_VERSION, ...keyring },
    keyringPath,
  );
  const serialized = `${JSON.stringify({ version: KEYRING_VERSION, ...parsed }, null, 2)}\n`;
  const temporary = `${keyringPath}.${process.pid}.${randomHex(8)}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, keyringPath);
    chmodSync(keyringPath, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or already absent */ }
  }
}

function withNodeKeyringLock<T>(keyringPath: string, operation: () => T): T {
  const directory = path.dirname(keyringPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${keyringPath}.rotation.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      acquired = true;
    } catch (error) {
      if (attempt === 0 && isStaleNodeKeyringLock(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* another contender will win or retry */ }
        continue;
      }
      throw new Error('Node Slack credential keyring rotation is already in progress.');
    }
  }
  if (!acquired) throw new Error('Node Slack credential keyring rotation is already in progress.');
  try {
    return operation();
  } finally {
    try { unlinkSync(lockPath); } catch { /* best-effort lock cleanup */ }
  }
}

function isStaleNodeKeyringLock(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath, 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function parseKeyringFile(value: unknown, keyringPath: string): CredentialKeyring {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Node Slack credential keyring is invalid at ${keyringPath}.`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== KEYRING_VERSION || typeof record.currentKeyId !== 'string' ||
      !record.keys || typeof record.keys !== 'object' || Array.isArray(record.keys)) {
    throw new Error(`Node Slack credential keyring is invalid at ${keyringPath}.`);
  }
  const currentKeyId = requireKeyId(record.currentKeyId);
  const keys: Record<string, string> = {};
  for (const [keyId, encoded] of Object.entries(record.keys as Record<string, unknown>)) {
    requireKeyId(keyId);
    if (typeof encoded !== 'string') {
      throw new Error(`Node Slack credential keyring is invalid at ${keyringPath}.`);
    }
    requireEncodedKey(encoded);
    keys[keyId] = encoded;
  }
  if (!keys[currentKeyId]) {
    throw new Error(`Node Slack credential keyring is missing its current key at ${keyringPath}.`);
  }
  return { currentKeyId, keys };
}

function requireEncodedKey(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Slack credential encryption key material is invalid.');
  }
}

function requireKeyId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Slack credential encryption key ID is invalid.');
  }
  return value;
}

function generateKeyId(): string {
  return `key_${randomHex(8)}`;
}

function randomHex(size: number): string {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
