import type { SettingsStore } from '../config/settings-store.ts';
import { OPENAI_AUTH_METHOD_SETTING_KEY } from '../config/openai-auth.ts';
import { OpenAiSubscriptionError, asOpenAiSubscriptionError } from './errors.ts';
import {
  accountFingerprint,
  decodeOpenAiSubscriptionIdentityKey,
  encodeOpenAiSubscriptionIdentityKey,
  generateOpenAiSubscriptionIdentityKey,
} from './identity.ts';
import {
  refreshOpenAiSubscriptionToken,
} from './protocol.ts';
import type {
  OpenAiSubscriptionFailureCode,
  OpenAiSubscriptionTokenBundle,
} from './types.ts';
import { isOpenAiSubscriptionFailureCode } from './types.ts';
import { clearOpenAiSubscriptionTransport } from './transport.ts';

const REFRESH_SKEW_MS = 60_000;
const REFRESH_LEASE_TTL_MS = 20_000;
const REFRESH_RETRY_MS = 25;
const REFRESH_MAX_RETRY_MS = 400;
const REFRESH_ATTEMPTS = 64;
const AUTHENTICATION_FAILURE_LIMIT = 2;
const credentialRevisions = new WeakMap<ResolvedOpenAiSubscriptionCredentials, string>();

const SETTING_KEYS = {
  pending: 'openai.subscription.pending',
  tokens: 'openai.subscription.tokens',
  refreshLease: 'openai.subscription.refresh-lease',
  identityKey: 'openai.subscription.identity-key',
  status: 'openai.subscription.status',
  modelCatalog: 'openai.subscription.model-catalog',
} as const;

export type OpenAiSubscriptionCredentialState =
  | 'disconnected'
  | 'authorizing'
  | 'connected'
  | 'account_change_confirmation_required'
  | 'reconnect_required'
  | 'error';

export interface OpenAiSubscriptionCredentialStatus {
  state: OpenAiSubscriptionCredentialState;
  updatedAt: number;
  accountFingerprint?: string;
  connectedAt?: number;
  failureCode?: OpenAiSubscriptionFailureCode;
  retryAt?: number;
}

interface StoredStatus extends OpenAiSubscriptionCredentialStatus {
  version: 1;
  credentialRevision?: string;
  consecutiveAuthenticationFailures?: number;
}

interface StoredCredentials extends OpenAiSubscriptionTokenBundle {
  version: 1;
  accountFingerprint: string;
  connectedAt: number;
}

interface StoredRefreshLease {
  version: 1;
  owner: string;
  expiresAt: number;
}

export interface OpenAiSubscriptionCredentialDependencies {
  settings: SettingsStore;
  now?: () => number;
  randomId?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  sleep?: (ms: number) => Promise<void>;
  refresh?: (refreshToken: string) => Promise<OpenAiSubscriptionTokenBundle>;
}

export interface ResolvedOpenAiSubscriptionCredentials {
  accessToken: string;
  accountId: string;
  accountFingerprint: string;
}

export function openAiSubscriptionSettingKeys(): typeof SETTING_KEYS {
  return SETTING_KEYS;
}

export async function getOpenAiSubscriptionCredentialStatus(
  settings: SettingsStore,
): Promise<OpenAiSubscriptionCredentialStatus> {
  const raw = await settings.getSetting(SETTING_KEYS.status);
  return raw ? publicStatus(parseStatus(raw)) : { state: 'disconnected', updatedAt: 0 };
}

export async function getOrCreateOpenAiSubscriptionAccountFingerprint(
  accountId: string,
  dependencies: Pick<OpenAiSubscriptionCredentialDependencies, 'settings' | 'randomBytes'>,
): Promise<string> {
  const identityKey = await getOrCreateIdentityKey(dependencies);
  return accountFingerprint(accountId, identityKey);
}

export async function commitOpenAiSubscriptionCredentials(
  bundle: OpenAiSubscriptionTokenBundle,
  dependencies: OpenAiSubscriptionCredentialDependencies,
  options: {
    expectedPendingRaw?: string;
    connectedAt?: number;
    selectAuthMethod?: boolean;
  } = {},
): Promise<OpenAiSubscriptionCredentialStatus> {
  validateTokenBundle(bundle);
  const currentTime = now(dependencies);
  const fingerprint = await getOrCreateOpenAiSubscriptionAccountFingerprint(
    bundle.accountId,
    dependencies,
  );
  const connectedAt = options.connectedAt ?? currentTime;
  const stored: StoredCredentials = {
    version: 1,
    ...bundle,
    accountFingerprint: fingerprint,
    connectedAt,
  };
  const storedRaw = JSON.stringify(stored);
  const status: StoredStatus = {
    version: 1,
    state: 'connected',
    updatedAt: currentTime,
    accountFingerprint: fingerprint,
    connectedAt,
    credentialRevision: await credentialRevision(storedRaw),
  };
  const applied = await dependencies.settings.applySettingsPatch({
    ...(options.expectedPendingRaw === undefined
      ? {}
      : { expected: { key: SETTING_KEYS.pending, value: options.expectedPendingRaw } }),
    set: [
      { key: SETTING_KEYS.tokens, value: storedRaw },
      { key: SETTING_KEYS.status, value: JSON.stringify(status) },
      ...(options.selectAuthMethod
        ? [{ key: OPENAI_AUTH_METHOD_SETTING_KEY, value: 'subscription' }]
        : []),
    ],
    delete: [SETTING_KEYS.pending, SETTING_KEYS.refreshLease],
  });
  if (!applied) throw new OpenAiSubscriptionError('authorization_missing');
  // A reconnect or confirmed account replacement must not leave a runtime
  // holding the prior account's bearer. Calls that have not crossed the fetch
  // boundary yet fail closed until their next runtime construction rebinds the
  // newly committed installation credential.
  clearOpenAiSubscriptionTransport();
  return publicStatus(status);
}

export async function resolveOpenAiSubscriptionCredentials(
  dependencies: OpenAiSubscriptionCredentialDependencies,
): Promise<ResolvedOpenAiSubscriptionCredentials> {
  const { raw, bundle, identityRaw } = await readCredentialSnapshot(dependencies.settings);
  await validateStoredIdentity(bundle, raw, identityRaw, dependencies);
  if (!tokenNeedsRefresh(bundle, now(dependencies))) {
    return resolvedCredentials(bundle, raw);
  }

  const owner = (dependencies.randomId ?? (() => crypto.randomUUID()))();
  let retryDelay = REFRESH_RETRY_MS;
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
    const snapshot = await dependencies.settings.getSettings([
      SETTING_KEYS.tokens,
      SETTING_KEYS.identityKey,
      SETTING_KEYS.refreshLease,
    ]);
    const currentRaw = snapshot[0];
    if (!currentRaw) throw new OpenAiSubscriptionError('auth_reconnect_required');
    const currentBundle = parseCredentials(currentRaw);
    await validateStoredIdentity(currentBundle, currentRaw, snapshot[1], dependencies);
    if (!tokenNeedsRefresh(currentBundle, now(dependencies))) {
      return resolvedCredentials(currentBundle, currentRaw);
    }

    const leaseRaw = snapshot[2];
    const lease = leaseRaw ? parseRefreshLease(leaseRaw) : undefined;
    const currentTime = now(dependencies);
    if (!lease || lease.expiresAt <= currentTime) {
      const nextLease = JSON.stringify({
        version: 1,
        owner,
        expiresAt: currentTime + REFRESH_LEASE_TTL_MS,
      } satisfies StoredRefreshLease);
      const acquired = await dependencies.settings.applySettingsPatch({
        expected: { key: SETTING_KEYS.refreshLease, value: leaseRaw ?? null },
        set: [{ key: SETTING_KEYS.refreshLease, value: nextLease }],
      });
      if (acquired) {
        try {
          return await refreshCredentials(currentRaw, currentBundle, dependencies);
        } finally {
          await releaseRefreshLease(owner, dependencies.settings);
        }
      }
    }
    await sleep(dependencies, retryDelay);
    retryDelay = Math.min(retryDelay * 2, REFRESH_MAX_RETRY_MS);
  }
  throw new OpenAiSubscriptionError('provider_unavailable');
}

export async function openAiSubscriptionCredentialsAreCurrent(
  settings: SettingsStore,
  credentials: ResolvedOpenAiSubscriptionCredentials,
): Promise<boolean> {
  const expectedRevision = credentialRevisions.get(credentials);
  if (!expectedRevision) return false;
  const raw = await settings.getSetting(SETTING_KEYS.tokens);
  return raw !== undefined && await credentialRevision(raw) === expectedRevision;
}

export async function recordOpenAiSubscriptionAuthenticationFailure(
  settings: SettingsStore,
  options: {
    now?: () => number;
    limit?: number;
    credentials?: ResolvedOpenAiSubscriptionCredentials;
  } = {},
): Promise<boolean> {
  const currentTime = (options.now ?? Date.now)();
  const limit = options.limit ?? AUTHENTICATION_FAILURE_LIMIT;
  const expectedRevision = options.credentials
    ? credentialRevisions.get(options.credentials)
    : undefined;
  if (options.credentials && !expectedRevision) return false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [raw, tokenRaw] = await settings.getSettings([SETTING_KEYS.status, SETTING_KEYS.tokens]);
    if (!raw) return false;
    const current = parseStatus(raw);
    if (expectedRevision) {
      const currentRevision = current.credentialRevision ??
        (tokenRaw ? await credentialRevision(tokenRaw) : undefined);
      if (currentRevision !== expectedRevision) return false;
    }
    if (
      current.state === 'reconnect_required' &&
      current.failureCode === 'auth_reconnect_required'
    ) {
      return true;
    }
    const failures = (current.consecutiveAuthenticationFailures ?? 0) + 1;
    const reconnectRequired = failures >= limit;
    const next: StoredStatus = {
      ...current,
      version: 1,
      state: reconnectRequired ? 'reconnect_required' : current.state,
      updatedAt: currentTime,
      failureCode: 'auth_reconnect_required',
      consecutiveAuthenticationFailures: failures,
      ...(expectedRevision ? { credentialRevision: expectedRevision } : {}),
    };
    const applied = await settings.applySettingsPatch({
      expected: { key: SETTING_KEYS.status, value: raw },
      set: [{ key: SETTING_KEYS.status, value: JSON.stringify(next) }],
      ...(reconnectRequired
        ? { delete: [SETTING_KEYS.pending, SETTING_KEYS.tokens, SETTING_KEYS.refreshLease] }
        : {}),
    });
    if (applied) {
      if (reconnectRequired) clearOpenAiSubscriptionTransport();
      return reconnectRequired;
    }
  }
  throw new OpenAiSubscriptionError('provider_unavailable');
}

export async function disconnectOpenAiSubscription(
  settings: SettingsStore,
  options: { now?: () => number } = {},
): Promise<OpenAiSubscriptionCredentialStatus> {
  const status: StoredStatus = {
    version: 1,
    state: 'disconnected',
    updatedAt: (options.now ?? Date.now)(),
  };
  await settings.applySettingsPatch({
    set: [{ key: SETTING_KEYS.status, value: JSON.stringify(status) }],
    delete: [
      SETTING_KEYS.pending,
      SETTING_KEYS.tokens,
      SETTING_KEYS.refreshLease,
      SETTING_KEYS.identityKey,
      SETTING_KEYS.modelCatalog,
    ],
  });
  clearOpenAiSubscriptionTransport();
  return publicStatus(status);
}

async function refreshCredentials(
  expectedRaw: string,
  current: StoredCredentials,
  dependencies: OpenAiSubscriptionCredentialDependencies,
): Promise<ResolvedOpenAiSubscriptionCredentials> {
  let refreshed: OpenAiSubscriptionTokenBundle;
  try {
    refreshed = await (dependencies.refresh ?? refreshOpenAiSubscriptionToken)(current.refreshToken);
  } catch (error) {
    const safeError = asOpenAiSubscriptionError(error);
    if (safeError.code === 'auth_reconnect_required') {
      const invalidated = await markReconnectRequired(expectedRaw, current, safeError.code, dependencies);
      if (!invalidated) return readRefreshWinner(dependencies);
    }
    throw safeError;
  }
  validateTokenBundle(refreshed);
  if (refreshed.accountId !== current.accountId) {
    const invalidated = await markReconnectRequired(
      expectedRaw,
      current,
      'auth_reconnect_required',
      dependencies,
    );
    if (!invalidated) return readRefreshWinner(dependencies);
    throw new OpenAiSubscriptionError('auth_reconnect_required');
  }
  const next: StoredCredentials = {
    version: 1,
    ...refreshed,
    accountFingerprint: current.accountFingerprint,
    connectedAt: current.connectedAt,
  };
  const nextRaw = JSON.stringify(next);
  const status: StoredStatus = {
    version: 1,
    state: 'connected',
    updatedAt: now(dependencies),
    accountFingerprint: current.accountFingerprint,
    connectedAt: current.connectedAt,
    credentialRevision: await credentialRevision(nextRaw),
  };
  const stored = await dependencies.settings.applySettingsPatch({
    expected: { key: SETTING_KEYS.tokens, value: expectedRaw },
    set: [
      { key: SETTING_KEYS.tokens, value: nextRaw },
      { key: SETTING_KEYS.status, value: JSON.stringify(status) },
    ],
    delete: [SETTING_KEYS.refreshLease],
  });
  if (stored) {
    clearOpenAiSubscriptionTransport();
    return resolvedCredentials(next, nextRaw);
  }
  return readRefreshWinner(dependencies);
}

async function markReconnectRequired(
  expectedRaw: string,
  current: StoredCredentials,
  failureCode: OpenAiSubscriptionFailureCode,
  dependencies: OpenAiSubscriptionCredentialDependencies,
): Promise<boolean> {
  const status: StoredStatus = {
    version: 1,
    state: 'reconnect_required',
    updatedAt: now(dependencies),
    accountFingerprint: current.accountFingerprint,
    connectedAt: current.connectedAt,
    failureCode,
    credentialRevision: await credentialRevision(expectedRaw),
  };
  const applied = await dependencies.settings.applySettingsPatch({
    expected: { key: SETTING_KEYS.tokens, value: expectedRaw },
    set: [{ key: SETTING_KEYS.status, value: JSON.stringify(status) }],
    delete: [SETTING_KEYS.pending, SETTING_KEYS.tokens, SETTING_KEYS.refreshLease],
  });
  if (applied) clearOpenAiSubscriptionTransport();
  return applied;
}

async function validateStoredIdentity(
  bundle: StoredCredentials,
  expectedRaw: string,
  identityRaw: string | undefined,
  dependencies: OpenAiSubscriptionCredentialDependencies,
): Promise<void> {
  if (identityRaw) {
    try {
      const fingerprint = await accountFingerprint(
        bundle.accountId,
        decodeOpenAiSubscriptionIdentityKey(identityRaw),
      );
      if (fingerprint === bundle.accountFingerprint) return;
    } catch {
      // Invalid identity material is handled as reconnect-required below.
    }
  }
  await markReconnectRequired(expectedRaw, bundle, 'auth_reconnect_required', dependencies);
  throw new OpenAiSubscriptionError('auth_reconnect_required');
}

async function readRefreshWinner(
  dependencies: OpenAiSubscriptionCredentialDependencies,
): Promise<ResolvedOpenAiSubscriptionCredentials> {
  const { raw, bundle, identityRaw } = await readCredentialSnapshot(dependencies.settings);
  await validateStoredIdentity(bundle, raw, identityRaw, dependencies);
  return resolvedCredentials(bundle, raw);
}

async function readCredentialSnapshot(
  settings: SettingsStore,
): Promise<{ raw: string; bundle: StoredCredentials; identityRaw: string | undefined }> {
  const [raw, identityRaw] = await settings.getSettings([
    SETTING_KEYS.tokens,
    SETTING_KEYS.identityKey,
  ]);
  if (!raw) throw new OpenAiSubscriptionError('auth_reconnect_required');
  return { raw, bundle: parseCredentials(raw), identityRaw };
}

async function getOrCreateIdentityKey(
  dependencies: Pick<OpenAiSubscriptionCredentialDependencies, 'settings' | 'randomBytes'>,
): Promise<Uint8Array> {
  const existing = await dependencies.settings.getSetting(SETTING_KEYS.identityKey);
  if (existing) return decodeOpenAiSubscriptionIdentityKey(existing);
  const generated = generateOpenAiSubscriptionIdentityKey(dependencies.randomBytes);
  const encoded = encodeOpenAiSubscriptionIdentityKey(generated);
  const stored = await dependencies.settings.applySettingsPatch({
    expected: { key: SETTING_KEYS.identityKey, value: null },
    set: [{ key: SETTING_KEYS.identityKey, value: encoded }],
  });
  if (stored) return generated;
  const winner = await dependencies.settings.getSetting(SETTING_KEYS.identityKey);
  if (!winner) throw new OpenAiSubscriptionError('storage_invalid');
  return decodeOpenAiSubscriptionIdentityKey(winner);
}

async function releaseRefreshLease(owner: string, settings: SettingsStore): Promise<void> {
  const raw = await settings.getSetting(SETTING_KEYS.refreshLease);
  if (!raw) return;
  const lease = parseRefreshLease(raw);
  if (lease.owner === owner) {
    await settings.applySettingsPatch({
      expected: { key: SETTING_KEYS.refreshLease, value: raw },
      delete: [SETTING_KEYS.refreshLease],
    });
  }
}

function parseCredentials(raw: string): StoredCredentials {
  const value = parseRecord(raw);
  if (
    value.version !== 1 ||
    typeof value.accessToken !== 'string' || !value.accessToken ||
    typeof value.refreshToken !== 'string' || !value.refreshToken ||
    (value.idToken !== undefined && typeof value.idToken !== 'string') ||
    typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) ||
    typeof value.accountId !== 'string' || !value.accountId ||
    typeof value.accountFingerprint !== 'string' || !value.accountFingerprint ||
    typeof value.connectedAt !== 'number' || !Number.isFinite(value.connectedAt)
  ) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  return {
    version: 1,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    idToken: value.idToken as string | undefined,
    expiresAt: value.expiresAt,
    accountId: value.accountId,
    accountFingerprint: value.accountFingerprint,
    connectedAt: value.connectedAt,
  };
}

function parseStatus(raw: string): StoredStatus {
  const value = parseRecord(raw);
  const states: readonly OpenAiSubscriptionCredentialState[] = [
    'disconnected', 'authorizing', 'connected', 'account_change_confirmation_required',
    'reconnect_required', 'error',
  ];
  if (
    value.version !== 1 ||
    typeof value.state !== 'string' || !states.includes(value.state as OpenAiSubscriptionCredentialState) ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) ||
    (value.accountFingerprint !== undefined && typeof value.accountFingerprint !== 'string') ||
    (value.connectedAt !== undefined && typeof value.connectedAt !== 'number') ||
    (value.failureCode !== undefined && !isOpenAiSubscriptionFailureCode(value.failureCode)) ||
    (value.retryAt !== undefined && typeof value.retryAt !== 'number') ||
    (value.credentialRevision !== undefined &&
      (typeof value.credentialRevision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.credentialRevision))) ||
    (value.consecutiveAuthenticationFailures !== undefined &&
      (typeof value.consecutiveAuthenticationFailures !== 'number' ||
        !Number.isInteger(value.consecutiveAuthenticationFailures) ||
        value.consecutiveAuthenticationFailures < 0))
  ) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  return value as unknown as StoredStatus;
}

function parseRefreshLease(raw: string): StoredRefreshLease {
  const value = parseRecord(raw);
  if (
    value.version !== 1 ||
    typeof value.owner !== 'string' || !value.owner ||
    typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
  ) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  return { version: 1, owner: value.owner, expiresAt: value.expiresAt };
}

function publicStatus(status: StoredStatus): OpenAiSubscriptionCredentialStatus {
  return {
    state: status.state,
    updatedAt: status.updatedAt,
    ...(status.accountFingerprint === undefined ? {} : { accountFingerprint: status.accountFingerprint }),
    ...(status.connectedAt === undefined ? {} : { connectedAt: status.connectedAt }),
    ...(status.failureCode === undefined ? {} : { failureCode: status.failureCode }),
    ...(status.retryAt === undefined ? {} : { retryAt: status.retryAt }),
  };
}

async function resolvedCredentials(
  bundle: StoredCredentials,
  raw: string,
): Promise<ResolvedOpenAiSubscriptionCredentials> {
  const credentials = {
    accessToken: bundle.accessToken,
    accountId: bundle.accountId,
    accountFingerprint: bundle.accountFingerprint,
  };
  credentialRevisions.set(credentials, await credentialRevision(raw));
  return credentials;
}

async function credentialRevision(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateTokenBundle(bundle: OpenAiSubscriptionTokenBundle): void {
  if (
    !bundle.accessToken || !bundle.refreshToken || !bundle.accountId ||
    !Number.isFinite(bundle.expiresAt) || bundle.expiresAt <= 0
  ) {
    throw new OpenAiSubscriptionError('protocol_drift');
  }
}

function tokenNeedsRefresh(bundle: StoredCredentials, currentTime: number): boolean {
  return bundle.expiresAt <= currentTime + REFRESH_SKEW_MS;
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Fall through to the bounded safe error.
  }
  throw new OpenAiSubscriptionError('storage_invalid');
}

function now(dependencies: Pick<OpenAiSubscriptionCredentialDependencies, 'now'>): number {
  return (dependencies.now ?? Date.now)();
}

function sleep(
  dependencies: Pick<OpenAiSubscriptionCredentialDependencies, 'sleep'>,
  ms: number,
): Promise<void> {
  return dependencies.sleep
    ? dependencies.sleep(ms)
    : new Promise((resolve) => setTimeout(resolve, ms));
}
