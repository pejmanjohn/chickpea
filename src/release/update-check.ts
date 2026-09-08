import type { ApplicationIdentity } from './identity.ts';

export const RELEASE_REPOSITORY = 'https://github.com/pejmanjohn/chickpea';
const RELEASE_ENDPOINT = 'https://api.github.com/repos/pejmanjohn/chickpea/releases/latest';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
type CheckError = 'network' | 'timeout' | 'rate-limited' | 'invalid-response';
export interface AvailableRelease { version: string; notes: string; url: string; publishedAt: string }
export interface UpdateStatus {
  status: 'available' | 'current' | 'no-release' | 'unversioned' | 'failed';
  checkedAt: string;
  release?: AvailableRelease;
  error?: CheckError;
  lastSuccessfulCheckAt?: string;
  /** Earliest retry after a rate limit; manual refresh respects this time. */
  retryAt?: string;
}
class CheckFailure extends Error {
  constructor(readonly code: CheckError, readonly retryAt?: number) { super(code); }
}

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

  async function request(): Promise<AvailableRelease | undefined> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(RELEASE_ENDPOINT, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Chickpea-update-check', 'X-GitHub-Api-Version': '2022-11-28' },
            // Workers supports manual/follow, but rejects redirect: 'error'.
            // Inspect redirects ourselves so release checks never follow them.
            redirect: 'manual', signal: controller.signal,
          });
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new CheckFailure('invalid-response');
          }
          if (response.status === 404) { await response.body?.cancel(); return undefined; }
          if (response.status === 403 || response.status === 429) {
            const retryAt = rateLimitRetryAt(response.headers, now());
            await response.body?.cancel();
            throw new CheckFailure('rate-limited', retryAt);
          }
          if (!response.ok) throw new CheckFailure('network');
          if (!response.headers.get('content-type')?.includes('json') || !response.body) throw new CheckFailure('invalid-response');
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let length = 0; let body = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 64 * 1024) throw new CheckFailure('invalid-response');
            body += decoder.decode(chunk.value, { stream: true });
          }
          body += decoder.decode();
          let release;
          try { release = JSON.parse(body); } catch { throw new CheckFailure('invalid-response'); }
          const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
          if (!VERSION.test(version) || release.draft !== false || release.prerelease !== false ||
              typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at)) ||
              (release.body !== null && typeof release.body !== 'string')) throw new CheckFailure('invalid-response');
          return { version, notes: (release.body ?? '').slice(0, 12_000),
            url: `${RELEASE_REPOSITORY}/releases/tag/v${version}`, publishedAt: new Date(release.published_at).toISOString() };
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new CheckFailure('timeout')); controller.abort(); }, options.timeoutMs ?? 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  }

  async function perform(): Promise<UpdateStatus> {
    const checkedAt = new Date(now()).toISOString();
    try {
      const release = await request();
      const known = VERSION.test(options.identity.version) && options.identity.sourceCommit !== null;
      const newer = release && known && compare(release.version, options.identity.version) > 0;
      cached = { status: !release ? 'no-release' : !known ? 'unversioned' : newer ? 'available' : 'current', checkedAt, ...(release ? { release } : {}) };
      successful = cached;
      expiresAt = now() + 15 * 60_000;
      refreshAfter = now() + 30_000;
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
