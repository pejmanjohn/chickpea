import { nativePasswordPrimitive } from './password.ts';

interface AuthGuardRateRow {
  count: number;
  reset_at: number;
}

export interface AuthGuardSqlCursor {
  toArray(): Array<Record<string, string | number | ArrayBuffer | null>>;
}

export interface AuthGuardStorage {
  sql: {
    exec(query: string, ...bindings: unknown[]): AuthGuardSqlCursor;
  };
}

let activeKdfs = 0;
const kdfWaiters: Array<() => void> = [];

async function withKdfSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeKdfs >= 2) await new Promise<void>((resolve) => kdfWaiters.push(resolve));
  activeKdfs += 1;
  try {
    return await operation();
  } finally {
    activeKdfs -= 1;
    kdfWaiters.shift()?.();
  }
}

/** Compute-only password and throttle logic. It stores no credential material. */
export class AuthGuardLogic {
  readonly #password = nativePasswordPrimitive();

  constructor(private readonly storage: AuthGuardStorage) {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS auth_rate_bucket (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      )`,
    );
  }

  async hashPassword(password: string): Promise<string> {
    return withKdfSlot(() => this.#password.hash(password));
  }

  async verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
    return withKdfSlot(() => this.#password.verify(input));
  }

  allow(bucket: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.storage.sql
      .exec(
        'SELECT count, reset_at FROM auth_rate_bucket WHERE bucket = ?',
        bucket,
      )
      .toArray()[0] as AuthGuardRateRow | undefined;
    if (!existing || existing.reset_at <= now) {
      this.storage.sql.exec(
        `INSERT INTO auth_rate_bucket (bucket, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
        bucket,
        now + windowMs,
      );
      return true;
    }
    const count = existing.count + 1;
    this.storage.sql.exec(
      'UPDATE auth_rate_bucket SET count = ? WHERE bucket = ?',
      count,
      bucket,
    );
    return count <= limit;
  }
}
