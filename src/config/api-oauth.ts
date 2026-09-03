import { decodeBase64Url, encodeBase64Url } from '../security/base64url.ts';
import { isRecord } from '../security/content-validation.ts';
import type { SettingsStore } from './settings-store.ts';
import { AGENT_ID_PATTERN } from './agent-id.ts';
import {
  isOAuthAttemptId,
  LEASE_ATTEMPTS,
  LEASE_MAX_RETRY_MS,
  LEASE_RETRY_MS,
  LEASE_TTL_MS,
  oauthNow,
  oauthRandomId,
  oauthSleep,
  parseOAuthLease,
  PENDING_TTL_MS,
  publishFencedOAuthState,
  REFRESH_SKEW_MS,
  type StoredOAuthLease,
  validateOAuthAttemptId,
} from './oauth-shared.ts';
import {
  parseOAuthAuthorizationAuthority,
  type OAuthAuthorizationAuthority,
} from './oauth-authorization.ts';

const FETCH_TIMEOUT_MS = 10_000;
const IDENTITY_TEXT_MAX = 160;
// Agent-scoped connection-account ids include an underscore and carry a generated
// suffix; legacy per-Agent ids remain a strict subset of this bounded shape.
const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,191}$/;

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_IDENTITY_SCOPES = ['openid', 'email'] as const;

export const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive',
] as const;

export type ApiOAuthProvider = 'google';

export interface ApiOAuthRef {
  agentId: string;
  connectionId: string;
}

/**
 * Agent-scoped connection-account OAuth is keyed to the account. The existing
 * ref shape is retained for the provider state codec, with an explicit sentinel
 * identifying this as an account credential instead of a legacy profile lane.
 */
export function connectionAccountOAuthRef(connectionAccountId: string): ApiOAuthRef {
  if (!CONNECTION_ID_PATTERN.test(connectionAccountId) ||
      !connectionAccountId.startsWith('connection_')) {
    throw new ApiOAuthError('connection_missing', 'Connection account id is invalid');
  }
  return { agentId: connectionAccountId, connectionId: 'account' };
}

export function connectionAccountIdFromOAuthRef(ref: ApiOAuthRef): string | undefined {
  return ref.connectionId === 'account' && ref.agentId.startsWith('connection_')
    ? ref.agentId
    : undefined;
}

export interface ApiOAuthDependencies {
  settings: SettingsStore;
  fetchFn?: typeof fetch;
  now?: () => number;
  randomId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  validateConnection?: (
    ref: ApiOAuthRef,
    provider: ApiOAuthProvider,
    accountRevision?: number,
    oauthAttemptId?: string,
  ) => boolean | Promise<boolean>;
  validateAuthorization?: (
    authority: OAuthAuthorizationAuthority | undefined,
    ref: ApiOAuthRef,
  ) => boolean | Promise<boolean>;
  onReauthorizationRequired?: (
    ref: ApiOAuthRef,
    provider: ApiOAuthProvider,
  ) => void | Promise<void>;
}

type ApiOAuthErrorCode =
  | 'authorization_expired'
  | 'client_missing'
  | 'connection_missing'
  | 'invalid_state'
  | 'oauth_attempt_superseded'
  | 'oauth_storage_invalid'
  | 'oauth_unavailable'
  | 'reauthorization_required';

interface ApiOAuthCallbackContext {
  ref: ApiOAuthRef;
  accountRevision?: number;
  oauthAttemptId?: string;
  returnAgentId?: string;
}

interface ApiOAuthErrorOptions extends ErrorOptions {
  callbackContext?: ApiOAuthCallbackContext;
}

export class ApiOAuthError extends Error {
  readonly callbackContext?: ApiOAuthCallbackContext;

  constructor(
    readonly code: ApiOAuthErrorCode,
    message: string,
    options?: ApiOAuthErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiOAuthError';
    if (options?.callbackContext) this.callbackContext = options.callbackContext;
  }
}

interface StoredClient {
  provider: ApiOAuthProvider;
  clientId: string;
  clientSecret: string;
}

interface PendingAuthorization {
  state: string;
  provider: ApiOAuthProvider;
  callbackUrl: string;
  scopes: string[];
  codeVerifier: string;
  expiresAt: number;
  returnAgentId?: string;
  accountRevision?: number;
  oauthAttemptId?: string;
  authorizationAuthority?: OAuthAuthorizationAuthority;
}

interface StoredTokenBundle {
  provider: ApiOAuthProvider;
  accessToken: string;
  refreshToken?: string;
  tokenType: 'Bearer';
  expiresIn?: number;
  scope?: string;
  obtainedAt: number;
  accountRevision?: number;
  oauthAttemptId?: string;
}

export function apiOAuthSettingKeys(ref: ApiOAuthRef): [
  client: string,
  pending: string,
  tokens: string,
  refreshLease: string,
] {
  validateRef(ref);
  const prefix = `connector.${ref.agentId}.${ref.connectionId}.oauth`;
  return [
    `${prefix}.client`,
    `${prefix}.pending`,
    `${prefix}.tokens`,
    `${prefix}.refresh-lease`,
  ];
}

export async function saveApiOAuthClient(
  ref: ApiOAuthRef,
  input: { provider: ApiOAuthProvider; clientId: string; clientSecret: string },
  settings: SettingsStore,
): Promise<void> {
  validateRef(ref);
  const client: StoredClient = {
    provider: provider(input.provider),
    clientId: requiredBounded(input.clientId, 512),
    clientSecret: requiredBounded(input.clientSecret, 2_048),
  };
  await settings.setSetting(apiOAuthSettingKeys(ref)[0], JSON.stringify(client));
}

/** Copy only the deployment-owned OAuth client, never personal tokens. */
export async function copyApiOAuthClient(
  source: ApiOAuthRef,
  target: ApiOAuthRef,
  settings: SettingsStore,
): Promise<void> {
  const client = await readClient(source, settings);
  await saveApiOAuthClient(target, client, settings);
}

export async function describeApiOAuthSources(
  ref: ApiOAuthRef,
  settings: SettingsStore,
): Promise<{ client: 'stored' | 'missing'; tokens: 'stored' | 'missing' }> {
  const [client, , tokens] = await settings.getSettings(apiOAuthSettingKeys(ref));
  return {
    client: client ? 'stored' : 'missing',
    tokens: tokens ? 'stored' : 'missing',
  };
}

export async function deleteApiOAuthSettings(
  ref: ApiOAuthRef,
  settings: SettingsStore,
): Promise<void> {
  await settings.applySettingsPatch({ delete: apiOAuthSettingKeys(ref) });
}

/** Clear authorization state while preserving the operator's BYO client. */
export async function invalidateApiOAuthAuthorization(
  ref: ApiOAuthRef,
  settings: SettingsStore,
): Promise<void> {
  const [, pending, tokens, refreshLease] = apiOAuthSettingKeys(ref);
  await settings.applySettingsPatch({ delete: [pending, tokens, refreshLease] });
}

export async function startApiOAuthAuthorization(
  input: {
    ref: ApiOAuthRef;
    provider: ApiOAuthProvider;
    callbackUrl: string;
    scopes: readonly string[];
    /** Admin Agent page that initiated this Agent-owned connection flow. */
    returnAgentId?: string;
    /** Agent-owned connection revision that fences this authorization attempt. */
    accountRevision?: number;
    /** Stable attempt identity retained after the account revision advances. */
    oauthAttemptId?: string;
    authorizationAuthority?: OAuthAuthorizationAuthority;
  },
  dependencies: ApiOAuthDependencies,
): Promise<{ authorizationUrl: URL; state: string }> {
  validateRef(input.ref);
  const selectedProvider = provider(input.provider);
  const callbackUrl = validateCallbackUrl(input.callbackUrl).href;
  if (input.returnAgentId !== undefined && !AGENT_ID_PATTERN.test(input.returnAgentId)) {
    throw new ApiOAuthError('oauth_unavailable', 'OAuth return Agent is invalid');
  }
  if (input.accountRevision !== undefined &&
      (!Number.isSafeInteger(input.accountRevision) || input.accountRevision < 1)) {
    throw new ApiOAuthError('oauth_unavailable', 'OAuth account revision is invalid');
  }
  validateOAuthAttemptId(
    input.oauthAttemptId,
    () => new ApiOAuthError('oauth_unavailable', 'OAuth attempt identity is invalid'),
  );
  const scopes = validatedGoogleScopes(input.scopes);
  await requireCurrentAuthorization(input.ref, input.authorizationAuthority, dependencies);
  await requireCurrentConnection(
    input.ref, selectedProvider, dependencies, input.accountRevision, input.oauthAttemptId,
  );

  const client = await readClient(input.ref, dependencies.settings);
  if (client.provider !== selectedProvider) throw invalidStorage();
  const state = encodeState(input.ref, selectedProvider, oauthRandomId(dependencies));
  const codeVerifier = [0, 1, 2, 3, 4, 5, 6, 7]
    .map(() => oauthRandomId(dependencies))
    .join('-')
    .slice(0, 128);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const pending: PendingAuthorization = {
    state,
    provider: selectedProvider,
    callbackUrl,
    scopes,
    codeVerifier,
    expiresAt: oauthNow(dependencies) + PENDING_TTL_MS,
    ...(input.returnAgentId ? { returnAgentId: input.returnAgentId } : {}),
    ...(input.accountRevision !== undefined ? { accountRevision: input.accountRevision } : {}),
    ...(input.oauthAttemptId ? { oauthAttemptId: input.oauthAttemptId } : {}),
    ...(input.authorizationAuthority
      ? { authorizationAuthority: input.authorizationAuthority }
      : {}),
  };
  await publishFencedOAuthState(
    apiOAuthSettingKeys(input.ref)[1],
    pending,
    dependencies.settings,
    {
      parseCurrent: parsePending,
      superseded: attemptSuperseded,
      unavailable: () =>
        new ApiOAuthError('oauth_unavailable', 'Could not publish OAuth authorization state'),
    },
  );
  try {
    await requireCurrentConnection(
      input.ref, selectedProvider, dependencies, input.accountRevision, input.oauthAttemptId,
    );
  } catch (error) {
    if (isConnectionMissing(error)) {
      await deleteApiOAuthSettings(input.ref, dependencies.settings);
    }
    throw error;
  }

  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set('client_id', client.clientId);
  authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', [...GOOGLE_IDENTITY_SCOPES, ...scopes].join(' '));
  authorizationUrl.searchParams.set('access_type', 'offline');
  authorizationUrl.searchParams.set('prompt', 'consent');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  return { authorizationUrl, state };
}

export async function completeApiOAuthAuthorization(
  input: { code: string; state: string },
  dependencies: ApiOAuthDependencies,
): Promise<{
  ref: ApiOAuthRef;
  provider: ApiOAuthProvider;
  identity?: { accountName?: string };
  accountRevision?: number;
  oauthAttemptId?: string;
  returnAgentId?: string;
  authorizationAuthority?: OAuthAuthorizationAuthority;
}> {
  const { ref, pending } = await consumePending(input.state, dependencies);
  try {
    await requireCurrentAuthorization(ref, pending.authorizationAuthority, dependencies);
    await requireCurrentConnection(
      ref,
      pending.provider,
      dependencies,
      pending.accountRevision,
      pending.oauthAttemptId,
    );
    const client = await readClient(ref, dependencies.settings);
    if (client.provider !== pending.provider) throw invalidStorage();

    const body = new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: requiredBounded(input.code, 8_192),
      code_verifier: pending.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: pending.callbackUrl,
    });
    const response = await providerFetch(
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      dependencies,
    );
    const tokens = await tokenResponse(response, undefined);
    await requireCurrentAuthorization(ref, pending.authorizationAuthority, dependencies);
    const tokenKey = apiOAuthSettingKeys(ref)[2];
    const bundle: StoredTokenBundle = {
      provider: pending.provider,
      ...tokens,
      obtainedAt: oauthNow(dependencies),
      ...(pending.accountRevision !== undefined
        ? { accountRevision: pending.accountRevision }
        : {}),
      ...(pending.oauthAttemptId ? { oauthAttemptId: pending.oauthAttemptId } : {}),
    };
    await publishFencedOAuthState(tokenKey, bundle, dependencies.settings, {
      parseCurrent: parseTokenBundle,
      superseded: attemptSuperseded,
      unavailable: () =>
        new ApiOAuthError('oauth_unavailable', 'Could not publish OAuth credentials'),
    });
    try {
      await requireCurrentConnection(
        ref,
        pending.provider,
        dependencies,
        pending.accountRevision,
        pending.oauthAttemptId,
      );
    } catch (error) {
      if (isConnectionMissing(error)) {
        await deleteApiOAuthSettings(ref, dependencies.settings);
      }
      throw error;
    }

    const identity = await loadGoogleIdentity(tokens.accessToken, dependencies).catch(() => undefined);
    return {
      ref,
      provider: pending.provider,
      ...(identity ? { identity } : {}),
      ...(pending.accountRevision !== undefined
        ? { accountRevision: pending.accountRevision }
        : {}),
      ...(pending.oauthAttemptId ? { oauthAttemptId: pending.oauthAttemptId } : {}),
      ...(pending.returnAgentId ? { returnAgentId: pending.returnAgentId } : {}),
      ...(pending.authorizationAuthority
        ? { authorizationAuthority: pending.authorizationAuthority }
        : {}),
    };
  } catch (error) {
    const oauthError = error instanceof ApiOAuthError
      ? error
      : new ApiOAuthError('oauth_unavailable', 'OAuth completion failed', { cause: error });
    throw new ApiOAuthError(oauthError.code, oauthError.message, {
      cause: oauthError,
      callbackContext: {
        ref,
        ...(pending.accountRevision !== undefined
          ? { accountRevision: pending.accountRevision }
          : {}),
        ...(pending.oauthAttemptId ? { oauthAttemptId: pending.oauthAttemptId } : {}),
        ...(pending.returnAgentId ? { returnAgentId: pending.returnAgentId } : {}),
      },
    });
  }
}

export async function cancelApiOAuthAuthorization(
  state: string,
  dependencies: ApiOAuthDependencies,
): Promise<{ ref: ApiOAuthRef; provider: ApiOAuthProvider; returnAgentId?: string }> {
  const { ref, pending } = await consumePending(state, dependencies);
  return {
    ref,
    provider: pending.provider,
    ...(pending.returnAgentId ? { returnAgentId: pending.returnAgentId } : {}),
  };
}

export function apiOAuthReturnRefFromState(state: string): ApiOAuthRef {
  return decodeState(state).ref;
}

export async function resolveApiOAuthAccessToken(
  input: { ref: ApiOAuthRef; provider: ApiOAuthProvider },
  dependencies: ApiOAuthDependencies,
): Promise<string> {
  validateRef(input.ref);
  const selectedProvider = provider(input.provider);
  const [, , tokenKey, leaseKey] = apiOAuthSettingKeys(input.ref);
  let raw = await dependencies.settings.getSetting(tokenKey);
  if (!raw) throw reauthorizationRequired();
  let bundle = parseTokenBundle(raw);
  if (bundle.provider !== selectedProvider) throw invalidStorage();
  await requireCurrentConnection(
    input.ref, selectedProvider, dependencies, undefined, bundle.oauthAttemptId,
  );
  if (!tokenNeedsRefresh(bundle, oauthNow(dependencies))) return bundle.accessToken;
  if (!bundle.refreshToken) throw reauthorizationRequired();

  const owner = oauthRandomId(dependencies);
  let retryDelay = LEASE_RETRY_MS;
  for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt += 1) {
    raw = await dependencies.settings.getSetting(tokenKey);
    if (!raw) throw reauthorizationRequired();
    bundle = parseTokenBundle(raw);
    await requireCurrentConnection(
      input.ref, selectedProvider, dependencies, undefined, bundle.oauthAttemptId,
    );
    if (!tokenNeedsRefresh(bundle, oauthNow(dependencies))) return bundle.accessToken;

    const leaseRaw = await dependencies.settings.getSetting(leaseKey);
    const lease = leaseRaw ? parseLease(leaseRaw) : undefined;
    const currentTime = oauthNow(dependencies);
    if (lease && lease.expiresAt > currentTime && !tokenHardExpired(bundle, currentTime)) {
      // One caller refreshes near-expiry credentials; concurrent turns can use
      // the still-valid token instead of blocking on settings-store polling.
      return bundle.accessToken;
    }
    if (!lease || lease.expiresAt <= currentTime) {
      const nextLease = JSON.stringify({ owner, expiresAt: currentTime + LEASE_TTL_MS });
      const acquired = await dependencies.settings.applySettingsPatch({
        expected: { key: leaseKey, value: leaseRaw ?? null },
        set: [{ key: leaseKey, value: nextLease }],
      });
      if (acquired) {
        try {
          return await refreshAccessToken(
            input.ref,
            selectedProvider,
            raw,
            bundle,
            leaseKey,
            dependencies,
          );
        } finally {
          const currentLease = await dependencies.settings.getSetting(leaseKey);
          if (currentLease) {
            const parsed = parseLease(currentLease);
            if (parsed.owner === owner) {
              await dependencies.settings.applySettingsPatch({
                expected: { key: leaseKey, value: currentLease },
                delete: [leaseKey],
              });
            }
          }
        }
      }
    }
    await oauthSleep(dependencies, retryDelay);
    retryDelay = Math.min(retryDelay * 2, LEASE_MAX_RETRY_MS);
  }
  throw new ApiOAuthError('oauth_unavailable', 'Timed out waiting for OAuth refresh');
}

async function refreshAccessToken(
  ref: ApiOAuthRef,
  selectedProvider: ApiOAuthProvider,
  expectedTokenRaw: string,
  bundle: StoredTokenBundle,
  leaseKey: string,
  dependencies: ApiOAuthDependencies,
): Promise<string> {
  const client = await readClient(ref, dependencies.settings);
  if (client.provider !== selectedProvider || !bundle.refreshToken) throw invalidStorage();
  const response = await providerFetch(
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: bundle.refreshToken,
      }),
    },
    dependencies,
  );
  if (!response.ok) {
    const error = await safeErrorCode(response);
    if (error === 'invalid_grant') {
      const deleted = await dependencies.settings.applySettingsPatch({
        expected: { key: apiOAuthSettingKeys(ref)[2], value: expectedTokenRaw },
        delete: [apiOAuthSettingKeys(ref)[2], leaseKey],
      });
      if (!deleted) {
        const winnerRaw = await dependencies.settings.getSetting(apiOAuthSettingKeys(ref)[2]);
        if (winnerRaw) {
          const winner = parseTokenBundle(winnerRaw);
          if (winner.provider !== selectedProvider) throw invalidStorage();
          await requireCurrentConnection(
            ref, selectedProvider, dependencies, undefined, winner.oauthAttemptId,
          );
          return winner.accessToken;
        }
      }
      await notifyReauthorizationRequired(ref, selectedProvider, dependencies);
      throw reauthorizationRequired();
    }
    throw new ApiOAuthError('oauth_unavailable', 'OAuth refresh failed');
  }
  const refreshed = await tokenResponse(response, bundle.refreshToken);
  const next: StoredTokenBundle = {
    provider: selectedProvider,
    ...refreshed,
    ...(refreshed.scope === undefined && bundle.scope !== undefined ? { scope: bundle.scope } : {}),
    obtainedAt: oauthNow(dependencies),
    ...(bundle.accountRevision !== undefined ? { accountRevision: bundle.accountRevision } : {}),
    ...(bundle.oauthAttemptId ? { oauthAttemptId: bundle.oauthAttemptId } : {}),
  };
  const tokenKey = apiOAuthSettingKeys(ref)[2];
  const stored = await dependencies.settings.applySettingsPatch({
    expected: { key: tokenKey, value: expectedTokenRaw },
    set: [{ key: tokenKey, value: JSON.stringify(next) }],
    delete: [leaseKey],
  });
  if (stored) return next.accessToken;
  const winnerRaw = await dependencies.settings.getSetting(tokenKey);
  if (!winnerRaw) throw reauthorizationRequired();
  const winner = parseTokenBundle(winnerRaw);
  if (winner.provider !== selectedProvider) throw invalidStorage();
  await requireCurrentConnection(
    ref, selectedProvider, dependencies, undefined, winner.oauthAttemptId,
  );
  return winner.accessToken;
}

async function notifyReauthorizationRequired(
  ref: ApiOAuthRef,
  selectedProvider: ApiOAuthProvider,
  dependencies: ApiOAuthDependencies,
): Promise<void> {
  try {
    await dependencies.onReauthorizationRequired?.(ref, selectedProvider);
  } catch {
    // Token deletion is authoritative. A cosmetic lifecycle update must never
    // turn a rejected grant into a retry loop or preserve unusable credentials.
    console.warn('[chickpea] Could not update API OAuth reconnection status');
  }
}

async function consumePending(
  state: string,
  dependencies: ApiOAuthDependencies,
): Promise<{ ref: ApiOAuthRef; pending: PendingAuthorization }> {
  const decoded = decodeState(state);
  const pendingKey = apiOAuthSettingKeys(decoded.ref)[1];
  const raw = await dependencies.settings.getSetting(pendingKey);
  if (!raw) throw invalidState();
  const pending = parsePending(raw);
  if (pending.state !== state || pending.provider !== decoded.provider) {
    throw invalidState();
  }
  const consumed = await dependencies.settings.applySettingsPatch({
    expected: { key: pendingKey, value: raw },
    delete: [pendingKey],
  });
  if (!consumed) throw invalidState();
  if (pending.expiresAt <= oauthNow(dependencies)) throw invalidState();
  return { ref: decoded.ref, pending };
}

async function loadGoogleIdentity(
  accessToken: string,
  dependencies: ApiOAuthDependencies,
): Promise<{ accountName: string } | undefined> {
  const response = await providerFetch(
    GOOGLE_USERINFO_ENDPOINT,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    dependencies,
  );
  if (!response.ok) return undefined;
  const value: unknown = await response.json();
  if (!isRecord(value)) return undefined;
  const accountName = boundedLabel(value.email);
  return accountName ? { accountName } : undefined;
}

async function tokenResponse(
  response: Response,
  priorRefreshToken: string | undefined,
): Promise<Omit<StoredTokenBundle, 'provider' | 'obtainedAt'>> {
  if (!response.ok) throw new ApiOAuthError('oauth_unavailable', 'OAuth token exchange failed');
  const value: unknown = await response.json();
  if (
    !isRecord(value) ||
    typeof value.access_token !== 'string' ||
    value.access_token.length === 0 ||
    value.token_type !== 'Bearer' ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== 'string') ||
    (value.expires_in !== undefined &&
      (typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0)) ||
    (value.scope !== undefined && typeof value.scope !== 'string')
  ) {
    throw new ApiOAuthError('oauth_unavailable', 'OAuth token response is invalid');
  }
  const refreshToken = value.refresh_token ?? priorRefreshToken;
  return {
    accessToken: value.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType: 'Bearer',
    ...(value.expires_in !== undefined ? { expiresIn: value.expires_in } : {}),
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
  };
}

async function providerFetch(
  url: string,
  init: RequestInit,
  dependencies: ApiOAuthDependencies,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await (dependencies.fetchFn ?? fetch)(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new ApiOAuthError('oauth_unavailable', 'OAuth provider request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function readClient(ref: ApiOAuthRef, settings: SettingsStore): Promise<StoredClient> {
  const raw = await settings.getSetting(apiOAuthSettingKeys(ref)[0]);
  if (!raw) throw new ApiOAuthError('client_missing', 'OAuth client credentials are missing');
  const value = parseStoredRecord(raw);
  if (
    value.provider !== 'google' ||
    typeof value.clientId !== 'string' ||
    !value.clientId ||
    typeof value.clientSecret !== 'string' ||
    !value.clientSecret
  ) {
    throw invalidStorage();
  }
  return { provider: 'google', clientId: value.clientId, clientSecret: value.clientSecret };
}

function parsePending(raw: string): PendingAuthorization {
  const value = parseStoredRecord(raw);
  let authorizationAuthority: OAuthAuthorizationAuthority | undefined;
  try {
    authorizationAuthority = value.authorizationAuthority === undefined
      ? undefined
      : parseOAuthAuthorizationAuthority(value.authorizationAuthority);
  } catch {
    throw invalidStorage();
  }
  if (
    typeof value.state !== 'string' ||
    value.provider !== 'google' ||
    typeof value.callbackUrl !== 'string' ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === 'string') ||
    typeof value.codeVerifier !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    (value.returnAgentId !== undefined &&
      (typeof value.returnAgentId !== 'string' || !AGENT_ID_PATTERN.test(value.returnAgentId))) ||
    (value.accountRevision !== undefined &&
      (!Number.isSafeInteger(value.accountRevision) || (value.accountRevision as number) < 1)) ||
    (value.oauthAttemptId !== undefined && !isOAuthAttemptId(value.oauthAttemptId))
  ) {
    throw invalidStorage();
  }
  return {
    state: value.state,
    provider: 'google',
    callbackUrl: validateCallbackUrl(value.callbackUrl).href,
    scopes: validatedGoogleScopes(value.scopes),
    codeVerifier: value.codeVerifier,
    expiresAt: value.expiresAt,
    ...(typeof value.returnAgentId === 'string' ? { returnAgentId: value.returnAgentId } : {}),
    ...(typeof value.accountRevision === 'number'
      ? { accountRevision: value.accountRevision }
      : {}),
    ...(typeof value.oauthAttemptId === 'string'
      ? { oauthAttemptId: value.oauthAttemptId }
      : {}),
    ...(authorizationAuthority
      ? { authorizationAuthority }
      : {}),
  };
}

function parseTokenBundle(raw: string): StoredTokenBundle {
  const value = parseStoredRecord(raw);
  if (
    value.provider !== 'google' ||
    typeof value.accessToken !== 'string' ||
    !value.accessToken ||
    value.tokenType !== 'Bearer' ||
    (value.refreshToken !== undefined && typeof value.refreshToken !== 'string') ||
    (value.expiresIn !== undefined &&
      (typeof value.expiresIn !== 'number' || !Number.isFinite(value.expiresIn) || value.expiresIn <= 0)) ||
    (value.scope !== undefined && typeof value.scope !== 'string') ||
    typeof value.obtainedAt !== 'number' ||
    (value.accountRevision !== undefined &&
      (!Number.isSafeInteger(value.accountRevision) || (value.accountRevision as number) < 1)) ||
    (value.oauthAttemptId !== undefined && !isOAuthAttemptId(value.oauthAttemptId))
  ) {
    throw invalidStorage();
  }
  return {
    provider: 'google',
    accessToken: value.accessToken,
    tokenType: 'Bearer',
    ...(value.refreshToken !== undefined ? { refreshToken: value.refreshToken } : {}),
    ...(value.expiresIn !== undefined ? { expiresIn: value.expiresIn } : {}),
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
    obtainedAt: value.obtainedAt,
    ...(typeof value.accountRevision === 'number'
      ? { accountRevision: value.accountRevision }
      : {}),
    ...(typeof value.oauthAttemptId === 'string'
      ? { oauthAttemptId: value.oauthAttemptId }
      : {}),
  };
}

function parseLease(raw: string): StoredOAuthLease {
  return parseOAuthLease(raw, parseStoredRecord, invalidStorage);
}

function tokenNeedsRefresh(bundle: StoredTokenBundle, currentTime: number): boolean {
  if (bundle.expiresIn === undefined) return false;
  return bundle.obtainedAt + bundle.expiresIn * 1_000 <= currentTime + REFRESH_SKEW_MS;
}

function tokenHardExpired(bundle: StoredTokenBundle, currentTime: number): boolean {
  if (bundle.expiresIn === undefined) return false;
  return bundle.obtainedAt + bundle.expiresIn * 1_000 <= currentTime;
}

function encodeState(ref: ApiOAuthRef, selectedProvider: ApiOAuthProvider, nonce: string): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify({ a: ref.agentId, c: ref.connectionId, p: selectedProvider, n: nonce })));
}

function decodeState(state: string): { ref: ApiOAuthRef; provider: ApiOAuthProvider } {
  try {
    if (!state || state.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(state)) throw new Error('bad state');
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(state)));
    if (!isRecord(value) || typeof value.a !== 'string' || typeof value.c !== 'string' || value.p !== 'google' || typeof value.n !== 'string' || !value.n) {
      throw new Error('bad state');
    }
    const ref = { agentId: value.a, connectionId: value.c };
    validateRef(ref);
    return { ref, provider: 'google' };
  } catch (error) {
    if (error instanceof ApiOAuthError) throw error;
    throw invalidState(error);
  }
}

function validatedGoogleScopes(values: readonly string[]): string[] {
  const allowed = new Set<string>(GOOGLE_WORKSPACE_SCOPES);
  const scopes = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    throw new ApiOAuthError('oauth_unavailable', 'Google OAuth scopes are invalid');
  }
  return scopes;
}

function provider(value: ApiOAuthProvider): ApiOAuthProvider {
  if (value !== 'google') throw new ApiOAuthError('oauth_unavailable', 'OAuth provider is unsupported');
  return value;
}

function validateRef(ref: ApiOAuthRef): void {
  if (!AGENT_ID_PATTERN.test(ref.agentId) || !CONNECTION_ID_PATTERN.test(ref.connectionId)) {
    throw new ApiOAuthError('oauth_unavailable', 'OAuth connection reference is invalid');
  }
}

function validateCallbackUrl(value: string): URL {
  const url = new URL(value);
  const loopbackHttp = url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (
    (url.protocol !== 'https:' && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiOAuthError('oauth_unavailable', 'OAuth callback URL must be HTTPS or local loopback HTTP');
  }
  return url;
}

async function requireCurrentConnection(
  ref: ApiOAuthRef,
  selectedProvider: ApiOAuthProvider,
  dependencies: ApiOAuthDependencies,
  accountRevision?: number,
  oauthAttemptId?: string,
): Promise<void> {
  if (dependencies.validateConnection &&
      !(await dependencies.validateConnection(
        ref, selectedProvider, accountRevision, oauthAttemptId,
      ))) {
    throw new ApiOAuthError('connection_missing', 'OAuth connection is no longer current');
  }
}

async function requireCurrentAuthorization(
  ref: ApiOAuthRef,
  authority: OAuthAuthorizationAuthority | undefined,
  dependencies: ApiOAuthDependencies,
): Promise<void> {
  if (
    dependencies.validateAuthorization &&
    (!authority || !(await dependencies.validateAuthorization(authority, ref)))
  ) {
    throw new ApiOAuthError(
      'authorization_expired',
      'OAuth initiating authority is no longer current',
    );
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

function parseStoredRecord(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidStorage();
  }
  if (!isRecord(value)) throw invalidStorage();
  return value;
}

async function safeErrorCode(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) && typeof value.error === 'string' ? value.error : undefined;
  } catch {
    return undefined;
  }
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, IDENTITY_TEXT_MAX) : undefined;
}

function requiredBounded(value: string, maxLength: number): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ApiOAuthError('oauth_unavailable', 'OAuth client credential is invalid');
  }
  return normalized;
}

function invalidState(cause?: unknown): ApiOAuthError {
  return new ApiOAuthError('invalid_state', 'OAuth state is invalid', cause ? { cause } : undefined);
}

function invalidStorage(): ApiOAuthError {
  return new ApiOAuthError('oauth_storage_invalid', 'Stored OAuth data is invalid');
}

function reauthorizationRequired(): ApiOAuthError {
  return new ApiOAuthError('reauthorization_required', 'OAuth authorization must be renewed');
}

function attemptSuperseded(): ApiOAuthError {
  return new ApiOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
}

function isConnectionMissing(error: unknown): boolean {
  return error instanceof ApiOAuthError && error.code === 'connection_missing';
}
