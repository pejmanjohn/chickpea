export const OPENAI_SUBSCRIPTION_FAILURE_CODES = [
  'authorization_denied',
  'authorization_expired',
  'auth_reconnect_required',
  'client_rejected',
  'entitlement_denied',
  'invalid_response',
  'originator_rejected',
  'protocol_drift',
  'provider_unavailable',
  'request_timeout',
  'subscription_quota_exhausted',
  'unsupported_model',
] as const;

export type OpenAiSubscriptionFailureCode =
  (typeof OPENAI_SUBSCRIPTION_FAILURE_CODES)[number];

export function isOpenAiSubscriptionFailureCode(
  value: unknown,
): value is OpenAiSubscriptionFailureCode {
  return typeof value === 'string' &&
    (OPENAI_SUBSCRIPTION_FAILURE_CODES as readonly string[]).includes(value);
}

export interface OpenAiDeviceAuthorizationPending {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
}

export type OpenAiDeviceAuthorizationPoll =
  | { state: 'pending' }
  | {
      state: 'approved';
      authorizationCode: string;
      codeVerifier: string;
    };

export interface OpenAiSubscriptionTokenBundle {
  accessToken: string;
  refreshToken: string;
  idToken: string | undefined;
  expiresAt: number;
  accountId: string;
}

export interface OpenAiSubscriptionProtocolOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
