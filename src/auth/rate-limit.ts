import { createHmac } from 'node:crypto';

import type { IdentityStore } from '../identity/types.ts';

const DEFAULT_WINDOW_MS = 15 * 60_000;
const GLOBAL_SCOPE = 'global';
const SPECIFIC_SCOPE = 'specific';

interface AuthRateLimiterOptions {
  pepper: string;
  now?: () => number;
  perKeyLimit?: number;
  globalLimit?: number;
  windowMs?: number;
}

export class AuthRateLimitError extends Error {
  readonly name = 'AuthRateLimitError';
  constructor(readonly retryAt: number) { super('Authentication unavailable.'); }
}

export class AuthRateLimiter {
  private readonly now: () => number;
  private readonly perKeyLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
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
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  async assertAllowed(bucket: string, rawKey: string): Promise<void> {
    const now = this.now();
    const windowStart = this.currentWindow(now);
    const [specific, global] = await Promise.all([
      this.identity.getAuthRateLimit(bucket, this.keyHash(bucket, SPECIFIC_SCOPE, rawKey)),
      this.identity.getAuthRateLimit(bucket, this.keyHash(bucket, GLOBAL_SCOPE)),
    ]);
    if ((specific?.windowStart === windowStart && specific.failures >= this.perKeyLimit) ||
        (global?.windowStart === windowStart && global.failures >= this.globalLimit)) {
      throw new AuthRateLimitError(windowStart + this.windowMs);
    }
  }

  /**
   * Counts one use against the key's and the bucket's limits before the work
   * it pays for, and returns how many the key has left in this window. Over
   * either limit it throws, and the use still counts.
   */
  async take(bucket: string, rawKey: string): Promise<number> {
    const windowStart = this.currentWindow(this.now());
    const [specific, global] = await Promise.all([
      this.identity.recordAuthRateFailure(bucket, this.keyHash(bucket, SPECIFIC_SCOPE, rawKey), windowStart),
      this.identity.recordAuthRateFailure(bucket, this.keyHash(bucket, GLOBAL_SCOPE), windowStart),
    ]);
    if (specific.failures > this.perKeyLimit || global.failures > this.globalLimit) {
      throw new AuthRateLimitError(windowStart + this.windowMs);
    }
    return this.perKeyLimit - specific.failures;
  }

  async recordFailure(bucket: string, rawKey: string): Promise<void> {
    const windowStart = this.currentWindow(this.now());
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

  private currentWindow(now: number): number {
    return Math.floor(now / this.windowMs) * this.windowMs;
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
