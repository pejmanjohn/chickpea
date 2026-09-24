import type { JsonValue } from '@flue/runtime';

import { redactCredentialLikeContent } from '../security/content-validation.ts';

/** Remove the turn's credential values, then anything credential-shaped. */
export function redactConnectionText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.split(secret).join('[credential redacted]');
  }
  return redactCredentialLikeContent(redacted);
}

const TEXT_CONTENT_TYPE = /^text\/|json|xml|csv|javascript|x-www-form-urlencoded/i;

/**
 * The part of a connection's response the model reads back: parsed JSON when
 * it is JSON and fits, otherwise bounded text. Truncated JSON is returned as
 * text, never as a partial parse.
 */
export function readConnectionResponse(
  body: Uint8Array,
  contentType: string | undefined,
  secrets: readonly string[],
  options: { maxChars: number; summarizeBinary?: boolean },
): Record<string, JsonValue> {
  if (body.byteLength === 0) return {};
  if (options.summarizeBinary && contentType && !TEXT_CONTENT_TYPE.test(contentType)) {
    return { binary: true, byteLength: body.byteLength, contentType };
  }
  const text = redactConnectionText(
    new TextDecoder().decode(body.subarray(0, options.maxChars * 4)),
    secrets,
  );
  const truncated = body.byteLength > options.maxChars * 4 || text.length > options.maxChars;
  if (!truncated && /json/i.test(contentType ?? '')) {
    try {
      return { response: JSON.parse(text) as JsonValue };
    } catch {
      // Fall through to text.
    }
  }
  return {
    response: text.slice(0, options.maxChars),
    ...(truncated ? { responseTruncated: true } : {}),
  };
}

/** A refusal the model can act on; `sent: false` means nothing left Chickpea. */
export function connectionRefusal<Reason extends string>(
  reason: Reason,
  message: string,
  extra: Record<string, JsonValue> = {},
): { output: JsonValue } {
  return { output: { ok: false, sent: false, reason, message, ...extra } as JsonValue };
}

/**
 * Map a scoped-fetch failure to a static category. Never the upstream error
 * text: it can echo the URL or headers.
 */
export function connectionFetchFailureReason(
  error: unknown,
): 'method_not_allowed' | 'url_not_allowed' | 'failed' {
  const name = error instanceof Error ? error.name : '';
  if (name === 'MethodNotAllowedError') return 'method_not_allowed';
  // A resolver outage is transient, not a scope restriction the model must
  // never retry.
  if (name === 'NetworkAccessDeniedError' && /DNS resolution failed/i.test((error as Error).message)) {
    return 'failed';
  }
  if (
    name === 'BlockedUrlError' ||
    name === 'NetworkAccessDeniedError' ||
    name === 'RedirectNotAllowedError' ||
    name === 'TooManyRedirectsError'
  ) {
    return 'url_not_allowed';
  }
  return 'failed';
}
