/**
 * The rate at which one installation may write to GitHub, on a deployment
 * serving many installations. Every installation shares the platform's
 * GitHub App, so one runaway loop must not spend its reputation or its rate
 * limit. Standalone has no such limit.
 *
 * Both of an installation's GitHub paths draw on one budget in its state
 * store: its coding workspaces' container egress (egress-outbound.ts) and its
 * Agents' Worker-side bash connectors (githubConnectorWriteGate). Each judges
 * what a request does with the egress decision's own logic
 * (egress-handler.ts): anything that does not surely read is a write, and
 * one that may open a pull request (the REST create call; GraphQL and the
 * uploads host are not reachable through either path) also counts per day.
 *
 * When GitHub answers one of the installation's requests with a secondary
 * rate limit, its writes are held here until GitHub's wait passes, so they
 * stop before GitHub has cause to ban the App. Two installations held within
 * a minute suggest GitHub counts that limit for the whole App, and an
 * operator event says so.
 */
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConnectorFetchResult, ConnectorForward } from '../config/egress.ts';
import { githubRequestEffect, type GithubRequestEffect } from './egress-handler.ts';

export const GITHUB_WRITES_KEY = 'sandbox.githubWrites';
export const GITHUB_WRITE_WINDOW_MS = 10 * 60_000;
export const GITHUB_WRITES_PER_WINDOW = 60;
export const GITHUB_PULL_REQUEST_WINDOW_MS = 24 * 60 * 60_000;
export const GITHUB_PULL_REQUESTS_PER_WINDOW = 30;
/** GitHub asks for at least a minute when a secondary limit names no wait. */
export const GITHUB_SECONDARY_LIMIT_MIN_SECONDS = 60;
/** The longest wait honoured, whatever GitHub names. */
export const GITHUB_SECONDARY_LIMIT_MAX_SECONDS = 60 * 60;
/** Installations held within this window raise the operator event. */
export const GITHUB_LATCH_ALERT_WINDOW_MS = 60_000;
const MAX_CAS_ATTEMPTS = 12;
const SECONDARY_LIMIT_MESSAGE = /secondary rate limit/i;
/** GitHub's error bodies are short; no more of one is read. */
const MAX_LIMIT_BODY_BYTES = 64 * 1024;

export type GithubWriteAdmission = { admitted: true } | { admitted: false; retryAfterSeconds: number };

interface StoredWrites {
  writes: number[];
  pullRequests: number[];
  /** Until when GitHub's secondary limit holds the installation's writes. */
  latchedUntil?: number;
}

/**
 * Count one write, or refuse it while the installation's writes are held
 * or its ten-minute writes or daily pull requests are spent. A refused write
 * is not counted.
 */
export async function admitGithubWrite(input: {
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>;
  kind: Exclude<GithubRequestEffect, 'read'>;
  now: number;
}): Promise<GithubWriteAdmission> {
  const { store, kind, now } = input;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await store.getSetting(GITHUB_WRITES_KEY);
    const stored = parseWrites(raw);
    if (stored.latchedUntil !== undefined && stored.latchedUntil > now) {
      return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil((stored.latchedUntil - now) / 1_000)) };
    }
    const writes = stored.writes.filter((at) => at > now - GITHUB_WRITE_WINDOW_MS);
    const pullRequests = stored.pullRequests.filter((at) => at > now - GITHUB_PULL_REQUEST_WINDOW_MS);
    const spent: GithubWriteAdmission = { admitted: false, retryAfterSeconds: GITHUB_WRITE_WINDOW_MS / 1_000 };
    if (writes.length >= GITHUB_WRITES_PER_WINDOW) return spent;
    if (kind === 'pull_request' && pullRequests.length >= GITHUB_PULL_REQUESTS_PER_WINDOW) return spent;
    writes.push(now);
    if (kind === 'pull_request') pullRequests.push(now);
    if (await replaceWrites(store, raw, { writes, pullRequests })) return { admitted: true };
  }
  throw new Error('Could not count a GitHub write after concurrent updates');
}

/** A refused write: the caller sees an HTTP "slow down", never a policy denial. */
export function githubWriteRateLimited(retryAfterSeconds = GITHUB_WRITE_WINDOW_MS / 1_000): Response {
  return new Response(null, {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

/**
 * The seconds GitHub asks for when its answer is a secondary rate limit: a
 * 403 or 429 that names a retry-after, or whose body is GitHub's
 * secondary-limit message. At least a minute and at most an hour; undefined
 * for any other answer, a primary limit included. `body` is read only for a
 * 403 or 429 that names no wait.
 */
export async function githubSecondaryLimitSeconds(answer: {
  status: number;
  retryAfter: string | null | undefined;
  body: () => Promise<string>;
}): Promise<number | undefined> {
  if (answer.status !== 403 && answer.status !== 429) return undefined;
  const retryAfter = answer.retryAfter?.trim();
  if (!retryAfter && !SECONDARY_LIMIT_MESSAGE.test(await answer.body().catch(() => ''))) return undefined;
  const named = retryAfter ? retryAfterSeconds(retryAfter) : undefined;
  return Math.min(GITHUB_SECONDARY_LIMIT_MAX_SECONDS, Math.max(GITHUB_SECONDARY_LIMIT_MIN_SECONDS, named ?? 0));
}

/**
 * Hold the installation's GitHub writes for `seconds`, or keep a longer hold
 * already in place, and note it for the operator. Never throws: the answer
 * that caused it still reaches its caller.
 */
export async function latchGithubWrites(input: {
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>;
  installationId: string;
  seconds: number;
  now: number;
}): Promise<void> {
  const { store, installationId, seconds, now } = input;
  noteGithubWriteLatch(installationId, seconds, now);
  try {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const raw = await store.getSetting(GITHUB_WRITES_KEY);
      const stored = parseWrites(raw);
      const latchedUntil = Math.max(stored.latchedUntil ?? 0, now + seconds * 1_000);
      if (await replaceWrites(store, raw, { ...stored, latchedUntil })) return;
    }
  } catch {
    // Reported below.
  }
  console.warn(JSON.stringify({ component: 'hosted_github', event: 'github_writes_latch_failed' }));
}

/**
 * The Worker-side bash connectors' gate, for one installation of many: each
 * write is counted against the installation's budget, shared with container
 * egress, and refused with a 429 before it leaves when the budget is spent
 * or GitHub's secondary limit holds it. A write is sent once, never again
 * after a redirect, so every write that leaves is counted. Any answer that
 * is a secondary limit holds the installation's writes.
 */
export function githubConnectorWriteGate(input: {
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>;
  installationId: string;
  now?: () => number;
}): ConnectorForward {
  const { store, installationId } = input;
  const clock = input.now ?? Date.now;
  return async (request, send) => {
    const effect = githubRequestEffect(new URL(request.url), request.method, request.headers);
    if (effect !== 'read') {
      const admission = await admitGithubWrite({ store, kind: effect, now: clock() });
      if (!admission.admitted) return rateLimitedResult(request.url, admission.retryAfterSeconds);
    }
    const result = await (effect === 'read' ? send() : send({ followRedirects: false }));
    const seconds = await githubSecondaryLimitSeconds({
      status: result.status,
      retryAfter: result.headers['retry-after'],
      body: async () => new TextDecoder().decode(result.body.subarray(0, MAX_LIMIT_BODY_BYTES)),
    });
    if (seconds !== undefined) await latchGithubWrites({ store, installationId, seconds, now: clock() });
    return result;
  };
}

/** The body of a GitHub answer, up to the bytes a limit message needs. */
export async function githubAnswerText(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < MAX_LIMIT_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, MAX_LIMIT_BODY_BYTES));
}

function rateLimitedResult(url: string, retryAfterSeconds: number): ConnectorFetchResult {
  return {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'retry-after': String(retryAfterSeconds) },
    body: new Uint8Array(),
    url,
  };
}

/** Seconds from a Retry-After value, either form; undefined when it names neither. */
function retryAfterSeconds(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.ceil((at - Date.now()) / 1_000) : undefined;
}

/** The installations whose writes this isolate held, and when; for the operator event. */
const recentLatches = new Map<string, number>();
let alertedAt = Number.NEGATIVE_INFINITY;

/**
 * Logs each hold, and the operator event when two or more installations were
 * held within a minute, at most once a minute. Each isolate sees only its own
 * holds; the per-hold line names the installation, so the host can count
 * across isolates too.
 */
function noteGithubWriteLatch(installationId: string, seconds: number, now: number): void {
  console.warn(JSON.stringify({
    component: 'hosted_github', event: 'github_writes_latched', installationId, retryAfterSeconds: seconds,
  }));
  recentLatches.set(installationId, now);
  for (const [id, at] of recentLatches) {
    if (now - at >= GITHUB_LATCH_ALERT_WINDOW_MS) recentLatches.delete(id);
  }
  if (recentLatches.size < 2 || now - alertedAt < GITHUB_LATCH_ALERT_WINDOW_MS) return;
  alertedAt = now;
  console.error(JSON.stringify({
    component: 'hosted_github',
    event: 'github_secondary_limit_installations',
    installations: recentLatches.size,
    windowSeconds: GITHUB_LATCH_ALERT_WINDOW_MS / 1_000,
  }));
}

export function resetGithubWriteLatchesForTests(): void {
  recentLatches.clear();
  alertedAt = Number.NEGATIVE_INFINITY;
}

async function replaceWrites(
  store: Pick<SettingsStore, 'applySettingsPatch'>,
  raw: string | undefined,
  next: StoredWrites,
): Promise<boolean> {
  return store.applySettingsPatch({
    expected: { key: GITHUB_WRITES_KEY, value: raw ?? null },
    set: [{ key: GITHUB_WRITES_KEY, value: JSON.stringify(next) }],
  });
}

function parseWrites(raw: string | undefined): StoredWrites {
  if (raw === undefined) return { writes: [], pullRequests: [] };
  try {
    const parsed = JSON.parse(raw) as { writes?: unknown; pullRequests?: unknown; latchedUntil?: unknown } | null;
    const latchedUntil = parsed?.latchedUntil;
    return {
      writes: timestamps(parsed?.writes),
      pullRequests: timestamps(parsed?.pullRequests),
      ...(typeof latchedUntil === 'number' && Number.isFinite(latchedUntil) ? { latchedUntil } : {}),
    };
  } catch {
    return { writes: [], pullRequests: [] };
  }
}

function timestamps(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)) : [];
}
