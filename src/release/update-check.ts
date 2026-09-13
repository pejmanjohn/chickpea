import type { ApplicationIdentity } from './identity.ts';
import { evaluateUpgradeCompatibility, validateUpgradeManifest } from './upgrade-compatibility.mjs';

export const RELEASE_REPOSITORY = 'https://github.com/pejmanjohn/chickpea';
const RELEASE_API = 'https://api.github.com/repos/pejmanjohn/chickpea';
const RELEASE_ENDPOINT = `${RELEASE_API}/releases/latest`;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
type CheckError = 'network' | 'timeout' | 'rate-limited' | 'invalid-response';
export interface AvailableRelease { version: string; notes: string; url: string; publishedAt: string }
export interface UpdateStatus {
  status: 'available' | 'current' | 'no-release' | 'unversioned' | 'failed';
  checkedAt: string;
  release?: AvailableRelease;
  /** Whether the guarded Cloudflare updater supports this exact installed-to-release transition. */
  guidedUpdate?: 'supported' | 'unsupported' | 'unknown';
  error?: CheckError;
  lastSuccessfulCheckAt?: string;
  /** Earliest retry after a rate limit; manual refresh respects this time. */
  retryAt?: string;
}
class CheckFailure extends Error {
  constructor(readonly code: CheckError, readonly retryAt?: number) { super(code); }
}
interface PublishedRelease { tag: string; release: AvailableRelease }
interface ReleaseLookup { release?: AvailableRelease; guidedUpdate?: UpdateStatus['guidedUpdate']; retryAt?: number }

function rateLimitRetryAt(headers: Headers, now: number): number {
  const retryAfter = headers.get('retry-after')?.trim();
  const reset = headers.get('x-ratelimit-reset')?.trim();
  const candidates: number[] = [];
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    candidates.push(now + Number(retryAfter) * 1_000);
  } else if (retryAfter) {
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && new Date(date).toUTCString() === retryAfter) candidates.push(date);
  }
  // GitHub sends the primary window reset even for secondary limits. It only
  // describes the relevant cooldown when that primary allowance is exhausted.
  if (headers.get('x-ratelimit-remaining') === '0' && reset && /^\d+$/.test(reset)) {
    candidates.push(Number(reset) * 1_000);
  }
  const future = candidates.filter((value) => Number.isFinite(value) && value > now);
  const requested = future.length ? Math.max(...future) : now + 15 * 60_000;
  // Avoid rapid retries and unbounded cooldowns from malformed upstream dates.
  return Math.min(now + 24 * 60 * 60_000, Math.max(now + 60_000, requested));
}

export function createUpdateChecker(options: {
  identity: ApplicationIdentity;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let cached: UpdateStatus | undefined;
  let successful: UpdateStatus | undefined;
  let expiresAt = 0;
  let refreshAfter = 0;
  let pending: Promise<UpdateStatus> | undefined;

  async function request(): Promise<ReleaseLookup> {
    const controller = new AbortController();
    const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
    let timeoutReject!: (reason: CheckFailure) => void;
    const timeout = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
    const timer = setTimeout(() => { timeoutReject(new CheckFailure('timeout')); controller.abort(); }, options.timeoutMs ?? 5_000);

    async function json(url: string, maximumBytes: number, allowNotFound = false, raw = false): Promise<unknown | undefined> {
      let response: Response;
      try {
        response = await fetcher(url, {
          headers: { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'User-Agent': 'Chickpea-update-check', 'X-GitHub-Api-Version': '2022-11-28' },
          // Workers supports manual/follow, but rejects redirect: 'error'.
          // Inspect redirects ourselves so release checks never follow them.
          redirect: 'manual', signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new CheckFailure('timeout');
        throw error;
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new CheckFailure('invalid-response');
      }
      if (allowNotFound && response.status === 404) { await response.body?.cancel(); return undefined; }
      if (response.status === 403 || response.status === 429) {
        const retryAt = rateLimitRetryAt(response.headers, now());
        await response.body?.cancel();
        throw new CheckFailure('rate-limited', retryAt);
      }
      if (!response.ok) { await response.body?.cancel(); throw new CheckFailure('network'); }
      if (!response.headers.get('content-type')?.includes('json') || !response.body) throw new CheckFailure('invalid-response');
      const declaredLength = response.headers.get('content-length');
      if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
        await response.body.cancel();
        throw new CheckFailure('invalid-response');
      }
      const reader = response.body.getReader();
      readers.add(reader);
      try {
        const decoder = new TextDecoder();
        let length = 0; let body = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > maximumBytes) throw new CheckFailure('invalid-response');
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        try { return JSON.parse(body); } catch { throw new CheckFailure('invalid-response'); }
      } finally {
        readers.delete(reader);
        void reader.cancel().catch(() => undefined);
      }
    }

    const withinDeadline = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, timeout]);

    function published(value: unknown, expectedTag?: string): PublishedRelease {
      const input = value as Record<string, unknown> | null;
      const tag = typeof input?.tag_name === 'string' ? input.tag_name : '';
      const version = tag.startsWith('v') ? tag.slice(1) : '';
      const publishedAt = input?.published_at;
      const body = input?.body;
      if (!VERSION.test(version) || (expectedTag !== undefined && tag !== expectedTag) || input?.immutable !== true ||
          input?.draft !== false || input?.prerelease !== false || input?.html_url !== `${RELEASE_REPOSITORY}/releases/tag/${tag}` ||
          typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)) ||
          (body !== null && typeof body !== 'string')) throw new CheckFailure('invalid-response');
      const notes = typeof body === 'string' ? body.slice(0, 12_000) : '';
      return { tag, release: { version, notes,
        url: `${RELEASE_REPOSITORY}/releases/tag/${tag}`, publishedAt: new Date(publishedAt).toISOString() } };
    }

    async function tagCommit(tag: string): Promise<string> {
      const ref = await json(`${RELEASE_API}/git/ref/tags/${tag}`, 16 * 1024) as { object?: { type?: unknown; sha?: unknown } };
      let object = ref?.object;
      for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
        if (typeof object.sha !== 'string' || !SHA.test(object.sha)) throw new CheckFailure('invalid-response');
        const tagObject = await json(`${RELEASE_API}/git/tags/${object.sha}`, 16 * 1024) as { object?: { type?: unknown; sha?: unknown } };
        object = tagObject?.object;
      }
      if (object?.type !== 'commit' || typeof object.sha !== 'string' || !SHA.test(object.sha)) throw new CheckFailure('invalid-response');
      return object.sha;
    }

    async function manifest(commit: string, version: string) {
      const value = await json(`${RELEASE_API}/contents/release.json?ref=${commit}`, 16 * 1024, false, true);
      try {
        const result = validateUpgradeManifest(value);
        if (result.version !== version) throw new Error('version mismatch');
        return result;
      } catch { throw new CheckFailure('invalid-response'); }
    }

    try {
      const latestValue = await withinDeadline(json(RELEASE_ENDPOINT, 64 * 1024, true));
      if (latestValue === undefined) return {};
      const latest = published(latestValue);
      const known = VERSION.test(options.identity.version) && options.identity.sourceCommit !== null && SHA.test(options.identity.sourceCommit);
      if (!known || compare(latest.release.version, options.identity.version) <= 0) return { release: latest.release };
      try {
        const guidedUpdate = await withinDeadline((async () => {
          const installedTag = `v${options.identity.version}`;
          const [destinationCommit, installedCommit] = await Promise.all([
            tagCommit(latest.tag),
            (async () => {
              const installed = published(await json(`${RELEASE_API}/releases/tags/${installedTag}`, 64 * 1024), installedTag);
              return tagCommit(installed.tag);
            })(),
          ]);
          if (installedCommit !== options.identity.sourceCommit) return 'unknown' as const;
          const [before, after] = await Promise.all([
            manifest(installedCommit, options.identity.version),
            manifest(destinationCommit, latest.release.version),
          ]);
          return evaluateUpgradeCompatibility(before, after).status;
        })());
        return { release: latest.release, guidedUpdate };
      } catch (error) {
        return { release: latest.release, guidedUpdate: 'unknown',
          ...(error instanceof CheckFailure && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}) };
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      for (const reader of readers) void reader.cancel().catch(() => undefined);
    }
  }

  async function perform(): Promise<UpdateStatus> {
    const checkedAt = new Date(now()).toISOString();
    try {
      const lookup = await request();
      const release = lookup.release;
      const known = VERSION.test(options.identity.version) && options.identity.sourceCommit !== null && SHA.test(options.identity.sourceCommit);
      const newer = release && known && compare(release.version, options.identity.version) > 0;
      cached = { status: !release ? 'no-release' : !known ? 'unversioned' : newer ? 'available' : 'current', checkedAt,
        ...(release ? { release } : {}), ...(newer && lookup.guidedUpdate ? { guidedUpdate: lookup.guidedUpdate } : {}),
        ...(lookup.retryAt !== undefined ? { retryAt: new Date(lookup.retryAt).toISOString() } : {}) };
      successful = cached;
      expiresAt = lookup.retryAt ?? now() + 15 * 60_000;
      refreshAfter = lookup.retryAt ?? now() + 30_000;
    } catch (error) {
      const retryAt = error instanceof CheckFailure ? error.retryAt : undefined;
      cached = { status: 'failed', checkedAt, error: error instanceof CheckFailure ? error.code : 'network',
        ...(retryAt !== undefined ? { retryAt: new Date(retryAt).toISOString() } : {}),
        ...(successful ? { lastSuccessfulCheckAt: successful.checkedAt, ...(successful.release ? { release: successful.release } : {}) } : {}) };
      expiresAt = retryAt ?? now() + 30_000;
      refreshAfter = expiresAt;
    }
    return cached;
  }
  return (refresh = false): Promise<UpdateStatus> => {
    if (pending) return pending;
    if (cached && now() < expiresAt && (!refresh || now() < refreshAfter)) return Promise.resolve(cached);
    pending = perform().finally(() => { pending = undefined; });
    return pending;
  };
}

function compare(left: string, right: string): number {
  const a = left.split('.').map(BigInt); const b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
