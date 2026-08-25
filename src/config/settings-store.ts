import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import { promisify } from '../state/async-facade.ts';
import type { StateDb } from '../state/state-db.ts';
import type { SlackSecretEnvelope } from '../slack/secret-envelope.ts';

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

/**
 * Operator settings persisted by the app itself. Customer Slack credential
 * bundles are deliberately excluded: they live only as encrypted revisions in
 * TAG_STATE, while this store retains public presentation/configuration data.
 */
export interface SettingsStore {
  getSetting(key: string): Promise<string | undefined>;
  /** Read related values from one coherent SQLite snapshot, in key order. */
  getSettings(keys: readonly string[]): Promise<(string | undefined)[]>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  /** Atomically compare one setting, then apply all writes/deletes on match. */
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
      if (patch.expected) {
        const current = this.getSetting(patch.expected.key) ?? null;
        if (current !== patch.expected.value) {
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
        input.envelope.version, input.envelope.algorithm, input.envelope.keyId,
        input.envelope.nonce, input.envelope.ciphertext,
        current?.createdAt ?? at, at,
      );
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
}

/** Node backend: the target-neutral logic over `node:sqlite`, async-wrapped. */
export interface SqliteSettingsStore extends SettingsStore, EncryptedCredentialStore {
  close(): void;
}

export class SqliteSettingsStore {
  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    const db = openStateDb(path);
    // The Proxy facade drops the `implements` compile check, so this typed
    // binding is the conformance assertion that keeps it: a logic method that
    // stops matching SettingsStore fails typecheck here.
    const _conforms: SettingsStore & EncryptedCredentialStore = promisify(
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
