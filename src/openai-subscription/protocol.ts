import { readBoundedText as readBoundedResponseText } from '../http/bounded-body.ts';
import { isRecord } from '../security/content-validation.ts';
import type {
  OpenAiDeviceAuthorizationPending,
  OpenAiDeviceAuthorizationPoll,
  OpenAiSubscriptionFailureCode,
  OpenAiSubscriptionProtocolOptions,
  OpenAiSubscriptionTokenBundle,
} from './types.ts';

// Protocol constants are independently encoded from the OpenCode MIT-licensed
// implementation pinned in the feature plan. Keeping every unstable value in
// this module makes the private surface removable without touching API-key code.
export const OPENAI_SUBSCRIPTION_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_SUBSCRIPTION_ORIGINATOR = 'chickpea';

const OPENAI_AUTH_ORIGIN = 'https://auth.openai.com';
export const OPENAI_SUBSCRIPTION_API_BASE = 'https://chatgpt.com/backend-api';

export const OPENAI_SUBSCRIPTION_ENDPOINTS = {
  deviceStart: `${OPENAI_AUTH_ORIGIN}/api/accounts/deviceauth/usercode`,
  devicePoll: `${OPENAI_AUTH_ORIGIN}/api/accounts/deviceauth/token`,
  deviceVerification: `${OPENAI_AUTH_ORIGIN}/codex/device`,
  deviceCallback: `${OPENAI_AUTH_ORIGIN}/deviceauth/callback`,
  token: `${OPENAI_AUTH_ORIGIN}/oauth/token`,
  responses: `${OPENAI_SUBSCRIPTION_API_BASE}/codex/responses`,
} as const;

export const OPENAI_SUBSCRIPTION_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
] as const;

const DEVICE_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export class OpenAiSubscriptionProtocolError extends Error {
  readonly code: OpenAiSubscriptionFailureCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: OpenAiSubscriptionFailureCode,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(safeFailureMessage(code), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenAiSubscriptionProtocolError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export async function startOpenAiDeviceAuthorization(
  options: OpenAiSubscriptionProtocolOptions = {},
): Promise<OpenAiDeviceAuthorizationPending> {
  const result = await boundedOpenAiSubscriptionFetch(
    OPENAI_SUBSCRIPTION_ENDPOINTS.deviceStart,
    {
      method: 'POST',
      headers: deviceJsonHeaders(),
      body: JSON.stringify({ client_id: OPENAI_SUBSCRIPTION_CLIENT_ID }),
    },
    options,
  );
  const payload = requireSuccessfulJson(result);
  const deviceAuthId = requiredString(payload.device_auth_id);
  const userCode = requiredString(payload.user_code);
  const intervalSeconds = Math.max(numberLike(payload.interval) ?? 5, 1);
  if (!deviceAuthId || !userCode || !Number.isFinite(intervalSeconds)) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  const now = (options.now ?? Date.now)();
  return {
    deviceAuthId,
    userCode,
    verificationUri: OPENAI_SUBSCRIPTION_ENDPOINTS.deviceVerification,
    intervalMs: intervalSeconds * 1000,
    expiresAt: now + DEVICE_AUTHORIZATION_TTL_MS,
  };
}

export async function pollOpenAiDeviceAuthorization(
  pending: OpenAiDeviceAuthorizationPending,
  options: OpenAiSubscriptionProtocolOptions = {},
): Promise<OpenAiDeviceAuthorizationPoll> {
  const result = await boundedOpenAiSubscriptionFetch(
    OPENAI_SUBSCRIPTION_ENDPOINTS.devicePoll,
    {
      method: 'POST',
      headers: deviceJsonHeaders(),
      body: JSON.stringify({
        device_auth_id: pending.deviceAuthId,
        user_code: pending.userCode,
      }),
    },
    options,
  );
  if (result.response.status === 403 || result.response.status === 404) {
    return { state: 'pending' };
  }
  const payload = requireSuccessfulJson(result);
  const authorizationCode = requiredString(payload.authorization_code);
  const codeVerifier = requiredString(payload.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  return { state: 'approved', authorizationCode, codeVerifier };
}

export async function exchangeOpenAiDeviceAuthorization(
  approved: Extract<OpenAiDeviceAuthorizationPoll, { state: 'approved' }>,
  options: OpenAiSubscriptionProtocolOptions = {},
): Promise<OpenAiSubscriptionTokenBundle> {
  const payload = await requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: approved.authorizationCode,
      redirect_uri: OPENAI_SUBSCRIPTION_ENDPOINTS.deviceCallback,
      client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
      code_verifier: approved.codeVerifier,
    }),
    options,
  );
  return normalizeTokenBundle(payload, undefined, options.now ?? Date.now);
}

export async function refreshOpenAiSubscriptionToken(
  refreshToken: string,
  options: OpenAiSubscriptionProtocolOptions = {},
): Promise<OpenAiSubscriptionTokenBundle> {
  const payload = await requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
    }),
    options,
  );
  return normalizeTokenBundle(payload, refreshToken, options.now ?? Date.now);
}

export function extractOpenAiSubscriptionAccountId({
  idToken,
  accessToken,
  now = Date.now(),
}: {
  idToken?: string;
  accessToken?: string;
  now?: number;
}): string {
  if (idToken) {
    const claims = parseJwtClaims(idToken, now, true);
    const accountId = accountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  if (accessToken) {
    const claims = parseJwtClaims(accessToken, now, false);
    const accountId = accountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  throw new OpenAiSubscriptionProtocolError('protocol_drift');
}

export function buildOpenAiSubscriptionHeaders({
  accessToken,
  accountId,
  sessionId,
  headers,
}: {
  accessToken: string;
  accountId: string;
  sessionId: string;
  headers?: HeadersInit;
}): Headers {
  if (!requiredString(accessToken) || !requiredString(accountId) || !requiredString(sessionId)) {
    throw new OpenAiSubscriptionProtocolError('auth_reconnect_required');
  }
  const result = new Headers(headers);
  result.delete('authorization');
  result.delete('chatgpt-account-id');
  result.set('authorization', `Bearer ${accessToken}`);
  result.set('ChatGPT-Account-Id', accountId);
  result.set('originator', OPENAI_SUBSCRIPTION_ORIGINATOR);
  result.set('session-id', sessionId);
  return result;
}

export function isSafeOpenAiSubscriptionModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

export interface OpenAiSubscriptionBoundedFetchResult {
  response: Response;
  text: string;
}

async function requestToken(
  form: URLSearchParams,
  options: OpenAiSubscriptionProtocolOptions,
): Promise<Record<string, unknown>> {
  const result = await boundedOpenAiSubscriptionFetch(
    OPENAI_SUBSCRIPTION_ENDPOINTS.token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    options,
  );
  return requireSuccessfulJson(result);
}

function normalizeTokenBundle(
  payload: Record<string, unknown>,
  previousRefreshToken: string | undefined,
  now: () => number,
): OpenAiSubscriptionTokenBundle {
  const accessToken = requiredString(payload.access_token);
  const refreshToken = requiredString(payload.refresh_token) ?? previousRefreshToken;
  const idToken = requiredString(payload.id_token);
  const expiresInSeconds = numberLike(payload.expires_in) ?? DEFAULT_TOKEN_TTL_SECONDS;
  if (!accessToken || !refreshToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  const currentTime = now();
  const accountId = extractOpenAiSubscriptionAccountId({
    ...(idToken ? { idToken } : {}),
    accessToken,
    now: currentTime,
  });
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt: currentTime + expiresInSeconds * 1000,
    accountId,
  };
}

export async function boundedOpenAiSubscriptionFetch(
  url: string,
  init: RequestInit,
  options: OpenAiSubscriptionProtocolOptions,
): Promise<OpenAiSubscriptionBoundedFetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      ...init,
      redirect: 'manual',
      signal,
    });
  } catch (cause) {
    clearTimeout(timer);
    throw new OpenAiSubscriptionProtocolError(
      timedOut ? 'request_timeout' : 'provider_unavailable',
      { cause },
    );
  }
  try {
    if (response.status >= 300 && response.status < 400) {
      throw new OpenAiSubscriptionProtocolError('protocol_drift', { status: response.status });
    }
    const text = await readBoundedText(
      response,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    return { response, text };
  } catch (cause) {
    if (cause instanceof OpenAiSubscriptionProtocolError) throw cause;
    throw new OpenAiSubscriptionProtocolError(
      timedOut ? 'request_timeout' : 'provider_unavailable',
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return readBoundedResponseText(response, {
    maxBytes,
    onOversize: () =>
      new OpenAiSubscriptionProtocolError('invalid_response', { status: response.status }),
  });
}

function requireSuccessfulJson(result: OpenAiSubscriptionBoundedFetchResult): Record<string, unknown> {
  if (!result.response.ok) {
    throw mapHttpFailure(result.response, result.text);
  }
  const contentType = result.response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new OpenAiSubscriptionProtocolError('invalid_response', {
      status: result.response.status,
    });
  }
  try {
    const value: unknown = JSON.parse(result.text);
    if (!isRecord(value)) throw new Error('response is not an object');
    return value;
  } catch (cause) {
    throw new OpenAiSubscriptionProtocolError('invalid_response', {
      status: result.response.status,
      cause,
    });
  }
}

function mapHttpFailure(response: Response, body: string): OpenAiSubscriptionProtocolError {
  const lower = body.slice(0, 4096).toLowerCase();
  const retryDelay = response.status === 429 ? retryAfterMs(response.headers) : undefined;
  const options =
    retryDelay === undefined
      ? { status: response.status }
      : { status: response.status, retryAfterMs: retryDelay };
  if (response.status === 429) {
    return new OpenAiSubscriptionProtocolError('subscription_quota_exhausted', options);
  }
  if (response.status === 401 || lower.includes('invalid_grant')) {
    return new OpenAiSubscriptionProtocolError('auth_reconnect_required', options);
  }
  if (response.status === 403) {
    if (lower.includes('originator')) {
      return new OpenAiSubscriptionProtocolError('originator_rejected', options);
    }
    if (lower.includes('client')) {
      return new OpenAiSubscriptionProtocolError('client_rejected', options);
    }
    return new OpenAiSubscriptionProtocolError('entitlement_denied', options);
  }
  if (response.status === 404) {
    return new OpenAiSubscriptionProtocolError('protocol_drift', options);
  }
  if (response.status >= 500) {
    return new OpenAiSubscriptionProtocolError('provider_unavailable', options);
  }
  return new OpenAiSubscriptionProtocolError('invalid_response', options);
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : undefined;
}

function parseJwtClaims(
  token: string,
  now: number,
  requireClientAudience: boolean,
): Record<string, unknown> {
  if (token.length > 32 * 1024) throw new OpenAiSubscriptionProtocolError('protocol_drift');
  const parts = token.split('.');
  const encodedPayload = parts[1];
  if (parts.length !== 3 || !encodedPayload) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64Url(encodedPayload));
  } catch (cause) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift', { cause });
  }
  if (!isRecord(claims) || claims.iss !== OPENAI_AUTH_ORIGIN) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  const audience = claims.aud;
  const audiences =
    typeof audience === 'string'
      ? [audience]
      : Array.isArray(audience) && audience.every((entry) => typeof entry === 'string')
        ? audience
        : undefined;
  if (!audiences || (requireClientAudience && !audiences.includes(OPENAI_SUBSCRIPTION_CLIENT_ID))) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  if (typeof claims.exp !== 'number') {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  if (claims.exp <= Math.floor(now / 1000)) {
    throw new OpenAiSubscriptionProtocolError('auth_reconnect_required');
  }
  return claims;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function accountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = requiredString(claims.chatgpt_account_id);
  if (direct) return direct;
  const namespaced = claims['https://api.openai.com/auth'];
  if (isRecord(namespaced)) {
    const accountId = requiredString(namespaced.chatgpt_account_id);
    if (accountId) return accountId;
  }
  const organizations = claims.organizations;
  if (Array.isArray(organizations)) {
    for (const organization of organizations) {
      if (isRecord(organization)) {
        const id = requiredString(organization.id);
        if (id) return id;
      }
    }
  }
  return undefined;
}

function deviceJsonHeaders(): HeadersInit {
  return {
    'content-type': 'application/json',
    'user-agent': 'chickpea/0.0.0',
  };
}

function safeFailureMessage(code: OpenAiSubscriptionFailureCode): string {
  return `OpenAI subscription request failed (${code}).`;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberLike(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
