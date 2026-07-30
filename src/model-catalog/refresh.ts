import type { SettingsStore } from '../config/settings-store.ts';
import {
  activateBundledModelCatalog,
  activateModelCatalog,
} from './catalog.ts';
import {
  MODEL_CATALOG_MAX_BYTES,
} from './schema.ts';
import {
  acceptModelCatalogCandidate,
  acquireModelCatalogRefreshLease,
  readModelCatalogLkg,
  readModelCatalogMode,
  releaseModelCatalogRefreshLease,
  touchModelCatalogLkg,
  type ModelCatalogLkg,
} from './store.ts';

export const MODEL_CATALOG_PRODUCTION_URL =
  'https://raw.githubusercontent.com/pejmanjohn/chickpea/main/catalog/current.json';

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REFRESH_JITTER_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export type ModelCatalogRefreshResult =
  | { status: 'bundled' | 'fresh' | 'lease_held'; revision: number }
  | { status: 'activated' | 'not_modified' | 'stale'; revision: number }
  | { status: 'restart_required'; revision: number }
  | { status: 'failed'; revision: number; code: string };

export interface RefreshModelCatalogOptions {
  settings: SettingsStore;
  force?: boolean;
  now?: () => number;
  random?: () => number;
  ownerId?: string;
  fetch?: typeof globalThis.fetch;
  /** Test seam only. Production callers use the fixed five-second bound. */
  timeoutMs?: number;
}

interface BoundedCatalogResponse {
  status: number;
  headers: Headers;
  bytes?: Uint8Array;
}

export type ModelCatalogLoadResult =
  | { status: 'bundled' | 'activated'; revision: number }
  | { status: 'restart_required'; revision: number };

/** Activate only persisted, already-validated state. Runtime admission uses
 * this path so an LLM operation can never trigger catalog network traffic. */
export async function loadModelCatalog(
  settings: SettingsStore,
): Promise<ModelCatalogLoadResult> {
  if (await readModelCatalogMode(settings) === 'bundled') {
    const snapshot = activateBundledModelCatalog();
    return { status: 'bundled', revision: snapshot.revision };
  }
  const lkg = await safeReadLkg(settings);
  if (!lkg) {
    const snapshot = activateBundledModelCatalog();
    return { status: 'bundled', revision: snapshot.revision };
  }
  const activation = activateModelCatalog({ document: lkg.document, sha256: lkg.sha256 });
  return activation.status === 'restart_required'
    ? { status: 'restart_required', revision: lkg.document.revision }
    : { status: 'activated', revision: lkg.document.revision };
}

export async function refreshModelCatalog(
  options: RefreshModelCatalogOptions,
): Promise<ModelCatalogRefreshResult> {
  const now = options.now ?? Date.now;
  const checkedAt = now();
  const loaded = await loadModelCatalog(options.settings);
  if (loaded.status === 'bundled' && await readModelCatalogMode(options.settings) === 'bundled') {
    return loaded;
  }
  if (loaded.status === 'restart_required') return loaded;

  let lkg = await safeReadLkg(options.settings);
  if (!options.force && lkg && lkg.nextRefreshAt > checkedAt) {
    return { status: 'fresh', revision: lkg.document.revision };
  }

  const ownerId = options.ownerId ?? crypto.randomUUID();
  const lease = await acquireModelCatalogRefreshLease(options.settings, ownerId, checkedAt);
  if (!lease.acquired) {
    lkg = await safeReadLkg(options.settings);
    if (lkg) {
      const activation = activateModelCatalog({ document: lkg.document, sha256: lkg.sha256 });
      if (activation.status === 'restart_required') {
        return { status: 'restart_required', revision: lkg.document.revision };
      }
    }
    return { status: 'lease_held', revision: lkg?.document.revision ?? 0 };
  }

  try {
    // Re-check under the lease so a waiter does not refetch a winner's fresh LKG.
    lkg = await safeReadLkg(options.settings);
    if (!options.force && lkg && lkg.nextRefreshAt > checkedAt) {
      const activation = activateModelCatalog({ document: lkg.document, sha256: lkg.sha256 });
      if (activation.status === 'restart_required') {
        return { status: 'restart_required', revision: lkg.document.revision };
      }
      return { status: 'fresh', revision: lkg.document.revision };
    }
    const response = await boundedCatalogFetch(
      MODEL_CATALOG_PRODUCTION_URL,
      lkg,
      options.fetch ?? globalThis.fetch,
      options.timeoutMs ?? FETCH_TIMEOUT_MS,
    );
    const nextRefreshAt = jitteredNextRefresh(checkedAt, options.random ?? Math.random);
    if (response.status === 304) {
      if (!lkg) return failure(options.settings, 'not_modified_without_lkg');
      const touched = await touchModelCatalogLkg(options.settings, lkg, {
        checkedAt,
        nextRefreshAt,
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag') as string } : {}),
        ...(response.headers.get('last-modified')
          ? { lastModified: response.headers.get('last-modified') as string }
          : {}),
      });
      const activation = activateModelCatalog({ document: touched.document, sha256: touched.sha256 });
      return activation.status === 'restart_required'
        ? { status: 'restart_required', revision: activation.snapshot.revision }
        : { status: 'not_modified', revision: touched.document.revision };
    }
    if (response.status !== 200) {
      return failure(options.settings, `http_${response.status}`);
    }
    if (!response.bytes) throw new Error('catalog_response_missing_body');
    const acceptance = await acceptModelCatalogCandidate(options.settings, {
      bytes: response.bytes,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag') as string } : {}),
      ...(response.headers.get('last-modified')
        ? { lastModified: response.headers.get('last-modified') as string }
        : {}),
      checkedAt,
      nextRefreshAt,
    });
    if (acceptance.status === 'equivocation') {
      activateModelCatalog({ document: acceptance.lkg.document, sha256: acceptance.lkg.sha256 });
      return { status: 'failed', revision: acceptance.lkg.document.revision, code: 'equivocation' };
    }
    if (acceptance.status === 'stale') {
      activateModelCatalog({ document: acceptance.lkg.document, sha256: acceptance.lkg.sha256 });
      return { status: 'stale', revision: acceptance.lkg.document.revision };
    }
    const activation = activateModelCatalog({
      document: acceptance.lkg.document,
      sha256: acceptance.lkg.sha256,
    });
    return activation.status === 'restart_required'
      ? { status: 'restart_required', revision: activation.snapshot.revision }
      : { status: 'activated', revision: acceptance.lkg.document.revision };
  } catch (error) {
    return failure(options.settings, refreshFailureCode(error));
  } finally {
    await releaseModelCatalogRefreshLease(options.settings, ownerId).catch(() => false);
  }
}

export function jitteredNextRefresh(now: number, random: () => number = Math.random): number {
  const sample = Math.min(1, Math.max(0, random()));
  return now + REFRESH_INTERVAL_MS + Math.round((sample - 0.5) * 2 * REFRESH_JITTER_MS);
}

async function boundedCatalogFetch(
  url: string,
  lkg: ModelCatalogLkg | undefined,
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<BoundedCatalogResponse> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('source_url_invalid');
  const headers = new Headers();
  if (lkg?.etag) headers.set('if-none-match', lkg.etag);
  if (lkg?.lastModified) headers.set('if-modified-since', lkg.lastModified);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('catalog_timeout');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImplementation(parsed, {
        method: 'GET',
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      }),
      deadline,
    ]);
    // Keep redirects observable and reject them ourselves. This yields the
    // same fail-closed result in Worker and Node fetch implementations and is
    // deterministic under the injected test transport.
    if (response.status !== 304 && response.status >= 300 && response.status < 400) {
      throw new Error('redirect_rejected');
    }
    if (response.status !== 200 && response.status !== 304) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, headers: response.headers };
    }
    const headerBytes = responseHeaderBytes(response.headers);
    if (headerBytes > MODEL_CATALOG_MAX_BYTES) throw new Error('response_oversized');
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) + headerBytes > MODEL_CATALOG_MAX_BYTES) {
      throw new Error('response_oversized');
    }
    // Wrap the response so the caller's body read remains under this same
    // controller and timeout; the timer is cleared only after bytes complete.
    if (response.status === 304) {
      return { status: response.status, headers: response.headers };
    }
    const bytes = await Promise.race([
      readBoundedBody(response, MODEL_CATALOG_MAX_BYTES - headerBytes, controller.signal),
      deadline,
    ]);
    return { status: response.status, headers: response.headers, bytes };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readBoundedBody(
  response: Response,
  limit = MODEL_CATALOG_MAX_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    void reader.cancel('model catalog response timed out').catch(() => undefined);
    rejectAbort?.(new Error('catalog_timeout'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('catalog_timeout');
      const { done, value } = await (signal
        ? Promise.race([reader.read(), aborted])
        : reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel('model catalog response oversized').catch(() => undefined);
        throw new Error('response_oversized');
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseHeaderBytes(headers: Headers): number {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += new TextEncoder().encode(`${name}:${value}\r\n`).byteLength;
  }
  return bytes;
}

async function safeReadLkg(settings: SettingsStore): Promise<ModelCatalogLkg | undefined> {
  try {
    return await readModelCatalogLkg(settings);
  } catch {
    return undefined;
  }
}

async function failure(
  settings: SettingsStore,
  code: string,
): Promise<ModelCatalogRefreshResult> {
  const lkg = await safeReadLkg(settings);
  if (lkg) {
    const activation = activateModelCatalog({ document: lkg.document, sha256: lkg.sha256 });
    if (activation.status === 'restart_required') {
      return { status: 'restart_required', revision: lkg.document.revision };
    }
  }
  else activateBundledModelCatalog();
  return { status: 'failed', revision: lkg?.document.revision ?? 0, code };
}

function refreshFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('timeout') || (error instanceof DOMException && error.name === 'AbortError')) {
    return 'timeout';
  }
  if (message.includes('oversized')) return 'response_oversized';
  if (message.includes('redirect')) return 'redirect_rejected';
  if (message.includes('UTF-8')) return 'invalid_utf8';
  if (message.includes('catalog') || message.includes('Catalog')) return 'invalid_catalog';
  return 'unavailable';
}
