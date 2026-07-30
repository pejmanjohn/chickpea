import type { SettingsStore } from '../config/settings-store.ts';
import {
  commitOpenAiSubscriptionCredentials,
  getOpenAiSubscriptionCredentialStatus,
  getOrCreateOpenAiSubscriptionAccountFingerprint,
  openAiSubscriptionSettingKeys,
  type OpenAiSubscriptionCredentialStatus,
} from './credentials.ts';
import { OpenAiSubscriptionError, asOpenAiSubscriptionError } from './errors.ts';
import {
  constantTimeTextEqual,
  hashOpenAiSubscriptionCapability,
  randomOpenAiSubscriptionCapability,
} from './identity.ts';
import {
  exchangeOpenAiDeviceAuthorization,
  pollOpenAiDeviceAuthorization,
  startOpenAiDeviceAuthorization,
} from './protocol.ts';
import type {
  OpenAiDeviceAuthorizationPending,
  OpenAiDeviceAuthorizationPoll,
  OpenAiSubscriptionTokenBundle,
} from './types.ts';
import { isOpenAiSubscriptionFailureCode } from './types.ts';

export interface OpenAiSubscriptionAuthorizationProtocol {
  start(): Promise<OpenAiDeviceAuthorizationPending>;
  poll(pending: OpenAiDeviceAuthorizationPending): Promise<OpenAiDeviceAuthorizationPoll>;
  exchange(
    approved: Extract<OpenAiDeviceAuthorizationPoll, { state: 'approved' }>,
  ): Promise<OpenAiSubscriptionTokenBundle>;
}

export interface OpenAiSubscriptionAuthorizationDependencies {
  settings: SettingsStore;
  protocol?: OpenAiSubscriptionAuthorizationProtocol;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export interface OpenAiSubscriptionAuthorizationStarted {
  state: 'authorizing';
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  nextPollAt: number;
  attemptCapability: string;
}

export type OpenAiSubscriptionAuthorizationResult =
  | { state: 'pending'; expiresAt: number; nextPollAt: number }
  | OpenAiSubscriptionCredentialStatus;

interface StoredAuthorization {
  version: 1;
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
  attemptHash: string;
  previousStatus: OpenAiSubscriptionCredentialStatus;
  candidate?: OpenAiSubscriptionTokenBundle;
  candidateFingerprint?: string;
}

const keys = openAiSubscriptionSettingKeys();

export async function startOpenAiSubscriptionAuthorization(
  dependencies: OpenAiSubscriptionAuthorizationDependencies,
): Promise<OpenAiSubscriptionAuthorizationStarted> {
  const currentTime = now(dependencies);
  const existingRaw = await dependencies.settings.getSetting(keys.pending);
  let previousStatus = await getOpenAiSubscriptionCredentialStatus(dependencies.settings);
  if (existingRaw) {
    const existing = parseAuthorization(existingRaw);
    if (existing.expiresAt > currentTime) {
      throw new OpenAiSubscriptionError('authorization_rate_limited');
    }
    previousStatus = existing.previousStatus;
  }
  if (previousStatus.state === 'disconnected' && previousStatus.updatedAt === 0) {
    previousStatus = { state: 'disconnected', updatedAt: currentTime };
  }

  const protocol = resolveProtocol(dependencies);
  let providerPending: OpenAiDeviceAuthorizationPending;
  try {
    providerPending = await protocol.start();
  } catch (error) {
    throw asOpenAiSubscriptionError(error);
  }
  if (
    !providerPending.deviceAuthId || !providerPending.userCode ||
    !providerPending.verificationUri ||
    !Number.isFinite(providerPending.intervalMs) || providerPending.intervalMs <= 0 ||
    !Number.isFinite(providerPending.expiresAt) || providerPending.expiresAt <= currentTime
  ) {
    throw new OpenAiSubscriptionError('protocol_drift');
  }

  const attemptCapability = randomOpenAiSubscriptionCapability(dependencies.randomBytes);
  const attemptHash = await hashOpenAiSubscriptionCapability(attemptCapability);
  const nextPollAt = Math.min(currentTime + providerPending.intervalMs, providerPending.expiresAt);
  const stored: StoredAuthorization = {
    version: 1,
    ...providerPending,
    nextPollAt,
    attemptHash,
    previousStatus,
  };
  const status: OpenAiSubscriptionCredentialStatus = {
    state: 'authorizing',
    updatedAt: currentTime,
    ...(previousStatus.accountFingerprint === undefined
      ? {}
      : { accountFingerprint: previousStatus.accountFingerprint }),
    ...(previousStatus.connectedAt === undefined
      ? {}
      : { connectedAt: previousStatus.connectedAt }),
  };
  const applied = await dependencies.settings.applySettingsPatch({
    expected: { key: keys.pending, value: existingRaw ?? null },
    set: [
      { key: keys.pending, value: JSON.stringify(stored) },
      { key: keys.status, value: serializeStatus(status) },
    ],
  });
  if (!applied) throw new OpenAiSubscriptionError('authorization_rate_limited');
  return {
    state: 'authorizing',
    verificationUri: providerPending.verificationUri,
    userCode: providerPending.userCode,
    expiresAt: providerPending.expiresAt,
    nextPollAt,
    attemptCapability,
  };
}

export async function pollOpenAiSubscriptionAuthorization(
  input: { attemptCapability: string },
  dependencies: OpenAiSubscriptionAuthorizationDependencies,
): Promise<OpenAiSubscriptionAuthorizationResult> {
  const { raw, pending } = await requireAuthorization(input.attemptCapability, dependencies.settings);
  const currentTime = now(dependencies);
  if (pending.expiresAt <= currentTime) {
    const expiredStatus: OpenAiSubscriptionCredentialStatus = pending.previousStatus.state === 'connected'
      ? { ...pending.previousStatus, updatedAt: currentTime, failureCode: 'authorization_expired' }
      : { state: 'disconnected', updatedAt: currentTime, failureCode: 'authorization_expired' };
    await dependencies.settings.applySettingsPatch({
      expected: { key: keys.pending, value: raw },
      set: [{ key: keys.status, value: serializeStatus(expiredStatus) }],
      delete: [keys.pending],
    });
    throw new OpenAiSubscriptionError('authorization_expired');
  }
  if (pending.candidate && pending.candidateFingerprint) {
    return accountChangeStatus(pending, currentTime);
  }
  if (currentTime < pending.nextPollAt) return pendingResult(pending);

  const claimed: StoredAuthorization = {
    ...pending,
    nextPollAt: Math.min(currentTime + pending.intervalMs, pending.expiresAt),
  };
  const claimedRaw = JSON.stringify(claimed);
  const acquired = await dependencies.settings.applySettingsPatch({
    expected: { key: keys.pending, value: raw },
    set: [{ key: keys.pending, value: claimedRaw }],
  });
  if (!acquired) {
    const winner = await requireAuthorization(input.attemptCapability, dependencies.settings);
    return winner.pending.candidate && winner.pending.candidateFingerprint
      ? accountChangeStatus(winner.pending, currentTime)
      : pendingResult(winner.pending);
  }

  const protocol = resolveProtocol(dependencies);
  let polled: OpenAiDeviceAuthorizationPoll;
  try {
    polled = await protocol.poll(providerPending(claimed));
  } catch (error) {
    throw asOpenAiSubscriptionError(error);
  }
  if (polled.state === 'pending') return pendingResult(claimed);

  let bundle: OpenAiSubscriptionTokenBundle;
  try {
    bundle = await protocol.exchange(polled);
  } catch (error) {
    throw asOpenAiSubscriptionError(error);
  }
  const candidateFingerprint = await getOrCreateOpenAiSubscriptionAccountFingerprint(
    bundle.accountId,
    dependencies,
  );
  const previousFingerprint = claimed.previousStatus.accountFingerprint;
  if (previousFingerprint && previousFingerprint !== candidateFingerprint) {
    const candidate: StoredAuthorization = { ...claimed, candidate: bundle, candidateFingerprint };
    const status = accountChangeStatus(candidate, currentTime);
    const stored = await dependencies.settings.applySettingsPatch({
      expected: { key: keys.pending, value: claimedRaw },
      set: [
        { key: keys.pending, value: JSON.stringify(candidate) },
        { key: keys.status, value: serializeStatus(status) },
      ],
    });
    if (!stored) throw new OpenAiSubscriptionError('authorization_missing');
    return status;
  }

  return commitOpenAiSubscriptionCredentials(
    bundle,
    { ...dependencies, settings: dependencies.settings },
    {
      expectedPendingRaw: claimedRaw,
      selectAuthMethod: claimed.previousStatus.state !== 'connected',
      ...(claimed.previousStatus.connectedAt === undefined
        ? {}
        : { connectedAt: claimed.previousStatus.connectedAt }),
    },
  );
}

export async function confirmOpenAiSubscriptionAccountChange(
  input: { attemptCapability: string },
  dependencies: OpenAiSubscriptionAuthorizationDependencies,
): Promise<OpenAiSubscriptionCredentialStatus> {
  const { raw, pending } = await requireAuthorization(input.attemptCapability, dependencies.settings);
  if (!pending.candidate || !pending.candidateFingerprint) {
    throw new OpenAiSubscriptionError('account_change_confirmation_required');
  }
  if (pending.expiresAt <= now(dependencies)) {
    throw new OpenAiSubscriptionError('authorization_expired');
  }
  return commitOpenAiSubscriptionCredentials(
    pending.candidate,
    { ...dependencies, settings: dependencies.settings },
    { expectedPendingRaw: raw },
  );
}

export async function cancelOpenAiSubscriptionAuthorization(
  input: { attemptCapability: string },
  dependencies: OpenAiSubscriptionAuthorizationDependencies,
): Promise<OpenAiSubscriptionCredentialStatus> {
  const { raw, pending } = await requireAuthorization(input.attemptCapability, dependencies.settings);
  const restored = { ...pending.previousStatus, updatedAt: now(dependencies) };
  const cancelled = await dependencies.settings.applySettingsPatch({
    expected: { key: keys.pending, value: raw },
    set: [{ key: keys.status, value: serializeStatus(restored) }],
    delete: [keys.pending],
  });
  if (!cancelled) throw new OpenAiSubscriptionError('authorization_missing');
  return restored;
}

export function getOpenAiSubscriptionAuthorizationStatus(
  settings: SettingsStore,
): Promise<OpenAiSubscriptionCredentialStatus> {
  return getOpenAiSubscriptionCredentialStatus(settings);
}

async function requireAuthorization(
  attemptCapability: string,
  settings: SettingsStore,
): Promise<{ raw: string; pending: StoredAuthorization }> {
  const raw = await settings.getSetting(keys.pending);
  if (!raw) throw new OpenAiSubscriptionError('authorization_missing');
  const pending = parseAuthorization(raw);
  let candidateHash: string;
  try {
    candidateHash = await hashOpenAiSubscriptionCapability(attemptCapability);
  } catch (cause) {
    throw new OpenAiSubscriptionError('attempt_forbidden', { cause });
  }
  if (!constantTimeTextEqual(candidateHash, pending.attemptHash)) {
    throw new OpenAiSubscriptionError('attempt_forbidden');
  }
  return { raw, pending };
}

function resolveProtocol(
  dependencies: OpenAiSubscriptionAuthorizationDependencies,
): OpenAiSubscriptionAuthorizationProtocol {
  return dependencies.protocol ?? {
    start: () => startOpenAiDeviceAuthorization(),
    poll: (pending) => pollOpenAiDeviceAuthorization(pending),
    exchange: (approved) => exchangeOpenAiDeviceAuthorization(approved),
  };
}

function parseAuthorization(raw: string): StoredAuthorization {
  const value = parseRecord(raw);
  if (
    value.version !== 1 ||
    typeof value.deviceAuthId !== 'string' || !value.deviceAuthId ||
    typeof value.userCode !== 'string' || !value.userCode ||
    typeof value.verificationUri !== 'string' || !value.verificationUri ||
    typeof value.intervalMs !== 'number' || !Number.isFinite(value.intervalMs) || value.intervalMs <= 0 ||
    typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) ||
    typeof value.nextPollAt !== 'number' || !Number.isFinite(value.nextPollAt) ||
    typeof value.attemptHash !== 'string' || !value.attemptHash ||
    !isRecord(value.previousStatus)
  ) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  const previousStatus = parseSafeStatus(value.previousStatus);
  const candidate = value.candidate === undefined
    ? undefined
    : parseTokenBundle(value.candidate);
  if (
    (candidate === undefined) !== (value.candidateFingerprint === undefined) ||
    (value.candidateFingerprint !== undefined &&
      (typeof value.candidateFingerprint !== 'string' || !value.candidateFingerprint))
  ) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  return {
    version: 1,
    deviceAuthId: value.deviceAuthId,
    userCode: value.userCode,
    verificationUri: value.verificationUri,
    intervalMs: value.intervalMs,
    expiresAt: value.expiresAt,
    nextPollAt: value.nextPollAt,
    attemptHash: value.attemptHash,
    previousStatus,
    ...(candidate === undefined ? {} : { candidate }),
    ...(value.candidateFingerprint === undefined
      ? {}
      : { candidateFingerprint: value.candidateFingerprint as string }),
  };
}

function parseSafeStatus(value: Record<string, unknown>): OpenAiSubscriptionCredentialStatus {
  const states = new Set([
    'disconnected', 'authorizing', 'connected', 'account_change_confirmation_required',
    'reconnect_required', 'error',
  ]);
  if (
    typeof value.state !== 'string' || !states.has(value.state) ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) ||
    (value.accountFingerprint !== undefined && typeof value.accountFingerprint !== 'string') ||
    (value.connectedAt !== undefined && typeof value.connectedAt !== 'number') ||
    (value.failureCode !== undefined && !isOpenAiSubscriptionFailureCode(value.failureCode)) ||
    (value.retryAt !== undefined && typeof value.retryAt !== 'number')
  ) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  return value as unknown as OpenAiSubscriptionCredentialStatus;
}

function parseTokenBundle(value: unknown): OpenAiSubscriptionTokenBundle {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== 'string' || !value.accessToken ||
    typeof value.refreshToken !== 'string' || !value.refreshToken ||
    (value.idToken !== undefined && typeof value.idToken !== 'string') ||
    typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) ||
    typeof value.accountId !== 'string' || !value.accountId
  ) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    idToken: value.idToken as string | undefined,
    expiresAt: value.expiresAt,
    accountId: value.accountId,
  };
}

function providerPending(pending: StoredAuthorization): OpenAiDeviceAuthorizationPending {
  return {
    deviceAuthId: pending.deviceAuthId,
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    intervalMs: pending.intervalMs,
    expiresAt: pending.expiresAt,
  };
}

function pendingResult(
  pending: StoredAuthorization,
): Extract<OpenAiSubscriptionAuthorizationResult, { state: 'pending' }> {
  return { state: 'pending', expiresAt: pending.expiresAt, nextPollAt: pending.nextPollAt };
}

function accountChangeStatus(
  pending: StoredAuthorization,
  currentTime: number,
): OpenAiSubscriptionCredentialStatus {
  if (!pending.candidateFingerprint) {
    throw new OpenAiSubscriptionError('storage_invalid');
  }
  return {
    state: 'account_change_confirmation_required',
    updatedAt: currentTime,
    accountFingerprint: pending.candidateFingerprint,
    ...(pending.previousStatus.connectedAt === undefined
      ? {}
      : { connectedAt: pending.previousStatus.connectedAt }),
  };
}

function serializeStatus(status: OpenAiSubscriptionCredentialStatus): string {
  return JSON.stringify({ version: 1, ...status });
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
  } catch {
    // Fall through to the safe storage error.
  }
  throw new OpenAiSubscriptionError('storage_invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function now(dependencies: Pick<OpenAiSubscriptionAuthorizationDependencies, 'now'>): number {
  return (dependencies.now ?? Date.now)();
}
