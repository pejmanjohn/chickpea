/**
 * Bounded HTTP response-body reading.
 *
 * Every caller that reads an untrusted HTTP body needs the same shape: refuse a
 * declared length that already exceeds the cap, stream the body while counting
 * bytes, stop the moment the cap is crossed, and release the stream. This module
 * is the single implementation of that shape; callers supply their own error
 * values so their externally observable failure modes stay unchanged.
 *
 * Only web-standard APIs are used so the module behaves identically on Node and
 * in Cloudflare Workers.
 */

/**
 * What to do when the body exceeds `maxBytes`: build the caller's error, or
 * stop reading and return whatever was collected before the cap.
 */
export type BoundedBodyOversize = (() => Error) | 'truncate';

export interface BoundedBodyOptions {
  /** Hard cap on the number of body bytes read. */
  maxBytes: number;
  /** Error raised when the body (or its declared length) exceeds `maxBytes`. */
  onOversize: BoundedBodyOversize;
  /**
   * Error raised when the response carries no body at all. Omit to treat a
   * missing body as an empty one.
   */
  onMissingBody?: (() => Error) | undefined;
  /**
   * Reject the declared `content-length` before reading when it already exceeds
   * the cap. Defaults to `true`; disable where the header is untrustworthy (a
   * transparently decompressed hop) or where the caller checks it itself.
   */
  checkContentLength?: boolean | undefined;
  /** Abort the read when this signal fires. */
  signal?: AbortSignal | undefined;
  /** Error raised when `signal` aborts. Defaults to a generic abort error. */
  onAbort?: (() => Error) | undefined;
  /** Text only: use a strict UTF-8 decoder that rejects invalid sequences. */
  fatalDecoder?: boolean | undefined;
  /** Bytes only: preallocate the result when the exact length is known. */
  expectedBytes?: number | undefined;
  /** Bytes only: error raised when the body outgrows `expectedBytes`. */
  onExpectedBytesExceeded?: (() => Error) | undefined;
}

/**
 * The `content-length` header as a trustworthy byte count, or `undefined` when
 * the header is absent or malformed. A malformed header is never trusted — the
 * body is streamed under the cap instead of being waved through by a `NaN`
 * comparison.
 */
export function declaredContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const declared = Number(raw);
  return Number.isSafeInteger(declared) ? declared : undefined;
}

/** Collect the body into a single `Uint8Array`, bounded by `options.maxBytes`. */
export async function readBoundedBytes(
  response: Response,
  options: BoundedBodyOptions,
): Promise<Uint8Array> {
  const preallocated = options.expectedBytes === undefined
    ? undefined
    : new Uint8Array(options.expectedBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of boundedBodyChunks(response, options, { truncated: false })) {
    total += chunk.byteLength;
    if (preallocated) {
      if (total > preallocated.byteLength) {
        throw options.onExpectedBytesExceeded?.() ??
          new Error('bounded body exceeded its expected byte count');
      }
      preallocated.set(chunk, total - chunk.byteLength);
    } else {
      chunks.push(chunk);
    }
  }
  if (preallocated) return preallocated.subarray(0, total);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** Decode the body as UTF-8 text, bounded by `options.maxBytes`. */
export async function readBoundedText(
  response: Response,
  options: BoundedBodyOptions,
): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: options.fatalDecoder === true });
  const state = { truncated: false };
  let text = '';
  for await (const chunk of boundedBodyChunks(response, options, state)) {
    text += decoder.decode(chunk, { stream: true });
  }
  // A truncated read stops mid-stream, so the decoder's pending bytes belong to
  // a character the caller never asked for; flushing them would append U+FFFD.
  return state.truncated ? text : text + decoder.decode();
}

/**
 * Stream the response body under the cap, yielding each accepted chunk. Handles
 * the declared-length check, the missing-body policy, abort signals, and stream
 * disposal — the reader is always cancelled and released, including on the
 * oversize path.
 */
async function* boundedBodyChunks(
  response: Response,
  options: BoundedBodyOptions,
  state: { truncated: boolean },
): AsyncGenerator<Uint8Array, void, void> {
  const { maxBytes, onOversize, signal } = options;
  if (options.checkContentLength !== false) {
    const declared = declaredContentLength(response.headers);
    if (declared !== undefined && declared > maxBytes) {
      await cancelBody(response);
      if (onOversize === 'truncate') {
        state.truncated = true;
        return;
      }
      throw onOversize();
    }
  }
  if (!response.body) {
    if (options.onMissingBody) throw options.onMissingBody();
    return;
  }
  const reader = response.body.getReader();
  const abortError = () => options.onAbort?.() ?? new Error('bounded body read aborted');
  let rejectAborted: ((reason: unknown) => void) | undefined;
  let aborted: Promise<never> | undefined;
  let onSignalAbort: (() => void) | undefined;
  if (signal) {
    aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    // Nothing awaits this promise once the loop exits; keep the rejection handled.
    void aborted.catch(() => undefined);
    onSignalAbort = () => {
      void cancelReader(reader);
      rejectAborted?.(abortError());
    };
    signal.addEventListener('abort', onSignalAbort, { once: true });
  }
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const next = aborted
        ? await Promise.race([reader.read(), aborted])
        : await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        if (onOversize === 'truncate') {
          state.truncated = true;
          return;
        }
        throw onOversize();
      }
      yield next.value;
    }
  } finally {
    if (signal && onSignalAbort) signal.removeEventListener('abort', onSignalAbort);
    await cancelReader(reader);
    releaseReader(reader);
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being discarded; a cancellation failure changes nothing.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stream is being discarded; a cancellation failure changes nothing.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Already released, or the stream errored; either way the lock is gone.
  }
}
