import type { Context, Next } from 'hono';

export type BoundedRequestBodyResult =
  | { ok: true; body: Uint8Array | null }
  | { ok: false; reason: 'invalid_content_length' | 'body_too_large' };

export async function readBoundedRequestBody(
  request: Request,
  maxSize: number,
): Promise<BoundedRequestBodyResult> {
  if (!Number.isSafeInteger(maxSize) || maxSize < 0) {
    throw new Error('Request body limit must be a non-negative safe integer.');
  }

  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      return { ok: false, reason: 'invalid_content_length' };
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      return { ok: false, reason: 'invalid_content_length' };
    }
    if (declaredBytes > maxSize) {
      return { ok: false, reason: 'body_too_large' };
    }
  }
  if (!request.body) return { ok: true, body: null };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxSize) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'body_too_large' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

export function requestWithBufferedBody(request: Request, body: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.set('content-length', String(body.byteLength));
  return new Request(request, {
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
}

export function actualBodyLimit(options: {
  maxSize: number;
  onError: (
    c: Context,
    reason: Exclude<BoundedRequestBodyResult, { ok: true }>['reason'],
  ) => Response | Promise<Response>;
}) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const result = await readBoundedRequestBody(c.req.raw, options.maxSize);
    if (!result.ok) return options.onError(c, result.reason);
    if (result.body !== null) {
      c.req.raw = requestWithBufferedBody(c.req.raw, result.body);
    }
    await next();
  };
}
