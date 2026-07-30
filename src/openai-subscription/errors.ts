import type { OpenAiSubscriptionFailureCode } from './types.ts';
import { OpenAiSubscriptionProtocolError } from './protocol.ts';

export type OpenAiSubscriptionErrorCode =
  | OpenAiSubscriptionFailureCode
  | 'account_change_confirmation_required'
  | 'authorization_missing'
  | 'authorization_pending'
  | 'authorization_rate_limited'
  | 'attempt_forbidden'
  | 'storage_invalid';

export class OpenAiSubscriptionError extends Error {
  readonly code: OpenAiSubscriptionErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: OpenAiSubscriptionErrorCode,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(
      `OpenAI subscription operation failed (${code}).`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'OpenAiSubscriptionError';
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function asOpenAiSubscriptionError(error: unknown): OpenAiSubscriptionError {
  if (error instanceof OpenAiSubscriptionError) return error;
  if (error instanceof OpenAiSubscriptionProtocolError) {
    return new OpenAiSubscriptionError(error.code, {
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      cause: error,
    });
  }
  return new OpenAiSubscriptionError('provider_unavailable', { cause: error });
}
