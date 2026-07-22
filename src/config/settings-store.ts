import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';

/**
 * Operator settings persisted by the app itself — key/value strings written
 * from /admin (the first-run Slack-connection wizard stores bot token, signing
 * secret, and bot user id here as 'slack.*' keys). Environment variables take
 * precedence over stored settings at the resolution layer, so a `wrangler
 * secret put` / .env value always wins; this store is the fallback for
 * installs configured entirely through the browser.
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
}

/** Node backend: the target-neutral logic over `node:sqlite`, async-wrapped. */
export class SqliteSettingsStore implements SettingsStore {
  private readonly db: NodeStateDb;
  private readonly logic: SettingsStoreLogic;

  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.logic = new SettingsStoreLogic(this.db, now);
  }

  close(): void {
    this.db.close();
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.logic.getSetting(key);
  }

  async getSettings(keys: readonly string[]): Promise<(string | undefined)[]> {
    return this.logic.getSettings(keys);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.logic.setSetting(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.logic.deleteSetting(key);
  }

  async applySettingsPatch(patch: SettingsPatch): Promise<boolean> {
    return this.logic.applySettingsPatch(patch);
  }

  async mergeSettingStringSet(key: string, values: readonly string[]): Promise<string[]> {
    return this.logic.mergeSettingStringSet(key, values);
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
