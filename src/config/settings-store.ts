import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import { promisify } from '../state/async-facade.ts';
import { schemaInstallRequired, type StateDb } from '../state/state-db.ts';
import type { SlackSecretEnvelope } from '../slack/secret-envelope.ts';
import { modelCredentialRevision, modelCredentialSettingKeys } from './model-credential-settings.ts';

export interface EncryptedCredentialRevision {
  key: string;
  revision: string;
  contextId: string;
  envelope: SlackSecretEnvelope;
  createdAt: number;
  updatedAt: number;
}

export interface ReplaceEncryptedCredentialRevisionInput {
  key: string;
  expectedRevision: string | null;
  revision: string;
  contextId: string;
  envelope: SlackSecretEnvelope;
}

export interface EncryptedCredentialStore {
  /** Dedicated encrypted realm; values never enter ordinary app_settings rows. */
  getEncryptedCredentialRevision(key: string): Promise<EncryptedCredentialRevision | undefined>;
  replaceEncryptedCredentialRevision(
    input: ReplaceEncryptedCredentialRevisionInput,
  ): Promise<EncryptedCredentialRevision | undefined>;
  deleteEncryptedCredentialRevision(key: string, expectedRevision: string): Promise<boolean>;
}

/** One provider's current model credential: version metadata and, while active, its key's envelope. */
export interface ModelCredentialRecord {
  credentialRefId: string;
  version: number;
  active: boolean;
  activeFrom: number;
  /**
   * The current key, encrypted for exactly this reference and version. The
   * store keeps no earlier key: a superseded version has nothing to recover.
   */
  envelope?: SlackSecretEnvelope;
}

export interface PublishModelCredentialInput {
  providerId: string;
  /** The version the caller read and encrypted against; 0 when the provider never had one. */
  expectedVersion: number;
  credentialRefId: string;
  /** Always `expectedVersion + 1`: a version names at most one published key. */
  version: number;
  activeFrom: number;
  /** Save or rotate: the new key, already encrypted for this reference and version. Delete: absent. */
  envelope?: SlackSecretEnvelope;
}

/**
 * The model credentials of an installation of a deployment serving many. Its
 * one write compares the version and publishes metadata and envelope (or
 * removes the envelope) in a single transaction, which the separate settings
 * and encrypted-revision compare-and-sets cannot jointly guarantee.
 */
export interface ModelCredentialStore {
  /** The current metadata and envelope, read in one snapshot. */
  readModelCredential(providerId: string): Promise<ModelCredentialRecord | undefined>;
  /**
   * On a version match, publish everything at once and remove any plaintext
   * key. False, with nothing written, when another writer moved the version.
   */
  publishModelCredential(input: PublishModelCredentialInput): Promise<boolean>;
}

export function isModelCredentialStore(store: SettingsStore): store is SettingsStore & ModelCredentialStore {
  const candidate = store as Partial<ModelCredentialStore>;
  return typeof candidate.readModelCredential === 'function' &&
    typeof candidate.publishModelCredential === 'function';
}

/**
 * Operator settings persisted by the app itself. Customer Slack credential
 * bundles are deliberately excluded: they live only as encrypted revisions in
 * TAG_STATE, while this store retains public presentation/configuration data.
 * Exception: generated_images:v1:* is a private, bounded, expiring image
 * cache. Never expose arbitrary settings or that prefix through Admin/export.
 */
export interface SettingsStore {
  getSetting(key: string): Promise<string | undefined>;
  /** Read related values from one coherent SQLite snapshot, in key order. */
  getSettings(keys: readonly string[]): Promise<(string | undefined)[]>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  /** Atomically compare settings, then apply all writes/deletes on match. */
  applySettingsPatch(patch: SettingsPatch): Promise<boolean>;
  /** Atomically union string members into a JSON-array setting. */
  mergeSettingStringSet(key: string, values: readonly string[]): Promise<string[]>;
  /** Node backend only (closes the SQLite handle); absent on RPC proxies. */
  close?(): void;
}

export interface SettingWrite {
  key: string;
  value: string;
}

export interface SettingsPatch {
  /** `null` is the clone-safe sentinel for an absent setting. */
  expected?: { key: string; value: string | null };
  /** Additional fences for operations whose authority spans related settings. */
  expectedAll?: readonly { key: string; value: string | null }[];
  set?: readonly SettingWrite[];
  delete?: readonly string[];
}

interface SettingRow {
  value: string;
}

interface SettingKeyValueRow extends SettingRow {
  key: string;
}

/**
 * Target-neutral settings logic over the StateDb mini-interface — shared by
 * the Node backend and the Cloudflare Durable Object. Methods are synchronous;
 * the async public interface wraps them.
 */
export class SettingsStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    if (!schemaInstallRequired(db)) return;
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_encrypted_credential_revisions (
        credential_key TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        context_id TEXT NOT NULL,
        envelope_version INTEGER NOT NULL,
        envelope_algorithm TEXT NOT NULL,
        key_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  }

  getSetting(key: string): string | undefined {
    const row = this.db.get('SELECT value FROM app_settings WHERE key = ?', key) as
      | SettingRow
      | undefined;
    return row?.value;
  }

  getSettings(keys: readonly string[]): (string | undefined)[] {
    if (keys.length === 0) return [];
    const uniqueKeys = [...new Set(keys)];
    const placeholders = uniqueKeys.map(() => '?').join(', ');
    const rows = this.db.all(
      `SELECT key, value FROM app_settings WHERE key IN (${placeholders})`,
      ...uniqueKeys,
    ) as unknown as SettingKeyValueRow[];
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    return keys.map((key) => byKey.get(key));
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      this.now(),
    );
  }

  deleteSetting(key: string): void {
    this.db.run('DELETE FROM app_settings WHERE key = ?', key);
  }

  applySettingsPatch(patch: SettingsPatch): boolean {
    const writes = [...(patch.set ?? [])];
    const writeKeys = new Set<string>();
    for (const write of writes) {
      if (writeKeys.has(write.key)) {
        throw new Error(`Settings patch writes duplicate key: ${write.key}`);
      }
      writeKeys.add(write.key);
    }
    const deletes = [...new Set(patch.delete ?? [])];
    for (const key of deletes) {
      if (writeKeys.has(key)) {
        throw new Error(`Settings patch both writes and deletes key: ${key}`);
      }
    }

    return this.db.transaction(() => {
      for (const expected of [...(patch.expected ? [patch.expected] : []), ...(patch.expectedAll ?? [])]) {
        const current = this.getSetting(expected.key) ?? null;
        if (current !== expected.value) {
          return false;
        }
      }
      for (const key of deletes) {
        this.deleteSetting(key);
      }
      for (const { key, value } of writes) {
        this.setSetting(key, value);
      }
      return true;
    });
  }

  mergeSettingStringSet(key: string, values: readonly string[]): string[] {
    return this.db.transaction(() => {
      const raw = this.getSetting(key);
      const existing = raw === undefined ? [] : parseStringSet(raw);
      const merged = [...new Set([...existing, ...values])];
      this.setSetting(key, JSON.stringify(merged));
      return merged;
    });
  }

  getEncryptedCredentialRevision(key: string): EncryptedCredentialRevision | undefined {
    const normalized = credentialKey(key);
    const row = this.db.get(
      'SELECT * FROM app_encrypted_credential_revisions WHERE credential_key = ?',
      normalized,
    ) as Record<string, unknown> | undefined;
    return row ? encryptedCredentialRevisionFromRow(row) : undefined;
  }

  replaceEncryptedCredentialRevision(
    input: ReplaceEncryptedCredentialRevisionInput,
  ): EncryptedCredentialRevision | undefined {
    const key = credentialKey(input.key);
    const revision = credentialRevision(input.revision);
    const contextId = credentialContextId(input.contextId);
    return this.db.transaction(() => {
      const current = this.getEncryptedCredentialRevision(key);
      if ((current?.revision ?? null) !== input.expectedRevision) return undefined;
      this.writeEncryptedCredentialRevision(key, revision, contextId, input.envelope, current?.createdAt);
      return this.getEncryptedCredentialRevision(key);
    });
  }

  deleteEncryptedCredentialRevision(key: string, expectedRevision: string): boolean {
    return this.db.run(
      `DELETE FROM app_encrypted_credential_revisions
       WHERE credential_key = ? AND revision = ?`,
      credentialKey(key), credentialRevision(expectedRevision),
    ).changes === 1;
  }

  readModelCredential(providerId: string): ModelCredentialRecord | undefined {
    const keys = modelCredentialSettingKeys(modelCredentialProviderId(providerId));
    return this.db.transaction(() => {
      const [credentialRefId, versionRaw, activeRaw, activeFromRaw] = this.getSettings([
        keys.credentialRefId, keys.version, keys.active, keys.activeFrom,
      ]);
      const version = storedModelCredentialVersion(versionRaw);
      const activeFrom = activeFromRaw !== undefined && /^\d+$/.test(activeFromRaw) ? Number(activeFromRaw) : NaN;
      if (!credentialRefId || version === 0 || !Number.isSafeInteger(activeFrom)) return undefined;
      const active = activeRaw === 'true';
      const row = active ? this.getEncryptedCredentialRevision(keys.envelope) : undefined;
      // Only the envelope published with this exact reference and version is this version's key.
      const envelope = row && row.revision === modelCredentialRevision(version) && row.contextId === credentialRefId
        ? row.envelope
        : undefined;
      return { credentialRefId, version, active, activeFrom, ...(envelope ? { envelope } : {}) };
    });
  }

  publishModelCredential(input: PublishModelCredentialInput): boolean {
    const keys = modelCredentialSettingKeys(modelCredentialProviderId(input.providerId));
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
        input.version !== input.expectedVersion + 1 ||
        !Number.isSafeInteger(input.activeFrom) || input.activeFrom < 0) {
      throw new Error('Model credential publication is invalid.');
    }
    const contextId = credentialContextId(input.credentialRefId);
    if (input.envelope) validEnvelope(input.envelope);
    return this.db.transaction(() => {
      if (storedModelCredentialVersion(this.getSetting(keys.version)) !== input.expectedVersion) return false;
      this.setSetting(keys.credentialRefId, input.credentialRefId);
      this.setSetting(keys.version, String(input.version));
      this.setSetting(keys.active, String(Boolean(input.envelope)));
      this.setSetting(keys.activeFrom, String(input.activeFrom));
      // The encrypted revision is the only place this store keeps the key.
      this.deleteSetting(keys.apiKey);
      if (input.envelope) {
        const current = this.getEncryptedCredentialRevision(keys.envelope);
        this.writeEncryptedCredentialRevision(
          keys.envelope, modelCredentialRevision(input.version), contextId, input.envelope, current?.createdAt,
        );
      } else {
        this.db.run('DELETE FROM app_encrypted_credential_revisions WHERE credential_key = ?', keys.envelope);
      }
      return true;
    });
  }

  private writeEncryptedCredentialRevision(
    key: string,
    revision: string,
    contextId: string,
    envelope: SlackSecretEnvelope,
    createdAt: number | undefined,
  ): void {
    const at = this.now();
    this.db.run(
      `INSERT INTO app_encrypted_credential_revisions (
        credential_key, revision, context_id,
        envelope_version, envelope_algorithm, key_id, nonce, ciphertext,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_key) DO UPDATE SET
        revision = excluded.revision,
        context_id = excluded.context_id,
        envelope_version = excluded.envelope_version,
        envelope_algorithm = excluded.envelope_algorithm,
        key_id = excluded.key_id,
        nonce = excluded.nonce,
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at`,
      key, revision, contextId,
      envelope.version, envelope.algorithm, envelope.keyId,
      envelope.nonce, envelope.ciphertext,
      createdAt ?? at, at,
    );
  }
}

/** Node backend: the target-neutral logic over `node:sqlite`, async-wrapped. */
export interface SqliteSettingsStore extends SettingsStore, EncryptedCredentialStore, ModelCredentialStore {
  close(): void;
}

export class SqliteSettingsStore {
  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    const db = openStateDb(path);
    // The Proxy facade drops the `implements` compile check, so this typed
    // binding is the conformance assertion that keeps it: a logic method that
    // stops matching SettingsStore fails typecheck here.
    const _conforms: SettingsStore & EncryptedCredentialStore & ModelCredentialStore = promisify(
      new SettingsStoreLogic(db, now), {
        close: () => db.close(),
      });
    return _conforms as unknown as SqliteSettingsStore;
  }
}

function parseStringSet(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid string-set setting');
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('Invalid string-set setting');
  }
  return parsed;
}

function encryptedCredentialRevisionFromRow(
  row: Record<string, unknown>,
): EncryptedCredentialRevision {
  return {
    key: String(row.credential_key),
    revision: String(row.revision),
    contextId: String(row.context_id),
    envelope: {
      version: Number(row.envelope_version) as SlackSecretEnvelope['version'],
      algorithm: String(row.envelope_algorithm) as SlackSecretEnvelope['algorithm'],
      keyId: String(row.key_id),
      nonce: String(row.nonce),
      ciphertext: String(row.ciphertext),
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function credentialKey(value: string): string {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error('Encrypted credential key is invalid.');
  }
  return value;
}

function credentialRevision(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Encrypted credential revision is invalid.');
  }
  return value;
}

function credentialContextId(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error('Encrypted credential context is invalid.');
  }
  return value;
}

function modelCredentialProviderId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error('Model credential provider is invalid.');
  return value;
}

/** 0 when the provider has no (or no readable) version, as its first publication expects. */
function storedModelCredentialVersion(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const version = Number(raw);
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

function validEnvelope(envelope: SlackSecretEnvelope): void {
  if (envelope.version !== 1 || envelope.algorithm !== 'AES-GCM-256' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(envelope.keyId) ||
      !/^[A-Za-z0-9_-]{16}$/.test(envelope.nonce) ||
      !/^[A-Za-z0-9_-]{1,32768}$/.test(envelope.ciphertext)) {
    throw new Error('Model credential envelope is invalid.');
  }
}
