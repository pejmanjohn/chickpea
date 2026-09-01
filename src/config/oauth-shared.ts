import type { SettingsStore } from './settings-store.ts';

/**
 * State shared by the two OAuth state machines (`api-oauth.ts` for BYO provider
 * clients, `mcp-oauth.ts` for MCP servers): attempt fencing, lease bookkeeping,
 * and the injectable clock seam. Lease *acquisition* deliberately stays per
 * module — the API lane keeps a stale-token short circuit the MCP lane lacks.
 */

export const PENDING_TTL_MS = 10 * 60_000;
export const REFRESH_SKEW_MS = 60_000;
export const LEASE_TTL_MS = 20_000;
export const LEASE_RETRY_MS = 25;
export const LEASE_MAX_RETRY_MS = 400;
export const LEASE_ATTEMPTS = 64;

const OAUTH_ATTEMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLISH_ATTEMPTS = 16;

/** Injectable clock, identity, and backoff seam used by both dependency shapes. */
export interface OAuthRuntimeDependencies {
  now?: () => number;
  randomId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/** Revision/attempt pair that fences one authorization attempt against another. */
export interface OAuthAttemptFence {
  accountRevision?: number;
  oauthAttemptId?: string;
}

export interface StoredOAuthLease {
  owner: string;
  expiresAt: number;
}

export function oauthNow(dependencies: OAuthRuntimeDependencies): number {
  return (dependencies.now ?? Date.now)();
}

export function oauthRandomId(dependencies: OAuthRuntimeDependencies): string {
  return (dependencies.randomId ?? (() => crypto.randomUUID()))();
}

export function oauthSleep(
  dependencies: OAuthRuntimeDependencies,
  ms: number,
): Promise<void> {
  return dependencies.sleep
    ? dependencies.sleep(ms)
    : new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNewerOAuthAttempt(
  current: OAuthAttemptFence,
  next: OAuthAttemptFence,
): boolean {
  return current.accountRevision !== undefined &&
    (next.accountRevision === undefined ||
      current.accountRevision > next.accountRevision ||
      (current.accountRevision === next.accountRevision &&
        current.oauthAttemptId !== next.oauthAttemptId));
}

export function isOAuthAttemptId(value: unknown): value is string {
  return typeof value === 'string' && OAUTH_ATTEMPT_ID_PATTERN.test(value);
}

export function validateOAuthAttemptId(
  value: string | undefined,
  invalid: () => Error,
): void {
  if (value !== undefined && !isOAuthAttemptId(value)) {
    throw invalid();
  }
}

export function parseOAuthLease(
  raw: string,
  parseStoredRecord: (raw: string) => Record<string, unknown>,
  invalidStorage: () => Error,
): StoredOAuthLease {
  const value = parseStoredRecord(raw);
  if (typeof value.owner !== 'string' || typeof value.expiresAt !== 'number') {
    throw invalidStorage();
  }
  return { owner: value.owner, expiresAt: value.expiresAt };
}

/**
 * Publish an attempt-fenced OAuth record under compare-and-set. Stored state
 * belonging to a newer attempt is never overwritten, and a lost swap is retried
 * against the value the winner left behind. The record shape stays with the
 * caller; only the fencing scaffolding is shared.
 */
export async function publishFencedOAuthState<Stored extends OAuthAttemptFence>(
  key: string,
  value: Stored,
  settings: SettingsStore,
  handlers: {
    parseCurrent: (raw: string) => OAuthAttemptFence;
    superseded: () => Error;
    unavailable: () => Error;
  },
): Promise<void> {
  const nextRaw = JSON.stringify(value);
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const currentRaw = await settings.getSetting(key);
    if (currentRaw) {
      const current = handlers.parseCurrent(currentRaw);
      if (isNewerOAuthAttempt(current, value)) throw handlers.superseded();
    }
    const stored = await settings.applySettingsPatch({
      expected: { key, value: currentRaw ?? null },
      set: [{ key, value: nextRaw }],
    });
    if (stored) return;
  }
  throw handlers.unavailable();
}
