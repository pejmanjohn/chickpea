import { createHmac } from 'node:crypto';

import type { IdentityStore } from '../identity/types.ts';

const WINDOW_MS = 15 * 60_000;
const GLOBAL_SCOPE = 'global';
const SPECIFIC_SCOPE = 'specific';

interface AuthRateLimiterOptions {
  pepper: string;
  now?: () => number;
  perKeyLimit?: number;
  globalLimit?: number;
}

export class AuthRateLimitError extends Error {
  readonly name = 'AuthRateLimitError';
  constructor(readonly retryAt: number) { super('Authentication unavailable.'); }
}

export class AuthRateLimiter {
  private readonly now: () => number;
  private readonly perKeyLimit: number;
  private readonly globalLimit: number;
  private readonly pepper: string;

  constructor(
    private readonly identity: IdentityStore,
    options: AuthRateLimiterOptions,
  ) {
    if (options.pepper.length < 32) throw new Error('Rate-limit pepper must be at least 32 characters.');
    this.pepper = options.pepper;
    this.now = options.now ?? Date.now;
    this.perKeyLimit = options.perKeyLimit ?? 10;
    this.globalLimit = options.globalLimit ?? 500;
  }

  async assertAllowed(bucket: string, rawKey: string): Promise<void> {
    const now = this.now();
    const windowStart = currentWindow(now);
    const [specific, global] = await Promise.all([
      this.identity.getAuthRateLimit(bucket, this.keyHash(bucket, SPECIFIC_SCOPE, rawKey)),
      this.identity.getAuthRateLimit(bucket, this.keyHash(bucket, GLOBAL_SCOPE)),
    ]);
    if ((specific?.windowStart === windowStart && specific.failures >= this.perKeyLimit) ||
        (global?.windowStart === windowStart && global.failures >= this.globalLimit)) {
      throw new AuthRateLimitError(windowStart + WINDOW_MS);
    }
  }

  async recordFailure(bucket: string, rawKey: string): Promise<void> {
    const windowStart = currentWindow(this.now());
    await Promise.all([
      this.identity.recordAuthRateFailure(
        bucket,
        this.keyHash(bucket, SPECIFIC_SCOPE, rawKey),
        windowStart,
      ),
      this.identity.recordAuthRateFailure(
        bucket,
        this.keyHash(bucket, GLOBAL_SCOPE),
        windowStart,
      ),
    ]);
  }

  async recordSuccess(bucket: string, rawKey: string): Promise<void> {
    await this.identity.clearAuthRateLimit(bucket, this.keyHash(bucket, SPECIFIC_SCOPE, rawKey));
  }

  private keyHash(bucket: string, scope: string, raw = ''): string {
    return createHmac('sha256', this.pepper)
      .update(bucket)
      .update('\0')
      .update(scope)
      .update('\0')
      .update(raw)
      .digest('hex');
  }
}

function currentWindow(now: number): number {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}
