import { constantTimeTextEqual } from '../security/constant-time.ts';
import { isRecord } from '../security/content-validation.ts';
import { sha256Hex, toHex } from '../security/digest.ts';
import type { SettingsStore } from '../config/settings-store.ts';

const MANAGED_AUTHORIZATION_TTL_MS = 30 * 60_000;
const MANAGED_AUTHORIZATION_STALE_GRACE_MS = 10 * 60_000;
const SETTING_PREFIX = 'connections.managed.authorization.';
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,256}$/;
const TOOLKIT_PATTERN = /^[a-z0-9_-]{1,128}$/;

interface ManagedAuthorizationInput {
  workspaceId: string;
  agentId: string;
  actorMembershipId: string;
  /** Isolates one setup flow from unrelated authorizations by the same member. */
  attemptScopeId?: string;
  ownerKind: 'team' | 'member';
  providerId: string;
  adapterId: string;
  toolkit: string;
  label: string;
  principalRef: string;
  allowedCapabilities: string[];
  /** Present only for a fresh import; reconnects preserve the existing binding. */
  bindingCapabilities?: string[];
  /** Existing Chickpea account whose remote authorization is being replaced. */
  connectionAccountId?: string;
  /** Installation provider revision that created this remote request. */
  providerGeneration?: number;
  /** One-way project fingerprint. It is safe metadata, never a credential. */
  providerLineage?: string;
}

export type ManagedAuthorizationAttempt = ManagedAuthorizationInput & {
  version: 1;
  status: 'pending' | 'authorized';
  browserSecretHash: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  authorizationRef?: string;
  accountRef?: string;
};

/** Stable UUID-shaped replay key derived from the non-secret attempt hash. */
export function managedAuthorizationAttemptId(
  attempt: Pick<ManagedAuthorizationAttempt, 'browserSecretHash'>,
): string {
  const hash = attempt.browserSecretHash;
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ManagedAuthorizationError('invalid');
  const variant = ((Number.parseInt(hash[15]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(12, 15)}-` +
    `${variant}${hash.slice(16, 19)}-${hash.slice(19, 31)}`;
}

export class ManagedAuthorizationError extends Error {
  constructor(readonly code:
    | 'invalid'
    | 'expired'
    | 'replayed'
    | 'toolkit_mismatch'
    | 'stale_provider'
    | 'in_progress'
    | 'recovery_required') {
    super(
      code === 'expired'
        ? 'expired managed authorization attempt'
        : code === 'recovery_required'
        ? 'managed authorization requires operator recovery'
        : code === 'in_progress'
        ? 'managed authorization is already in progress'
        : code === 'toolkit_mismatch'
        ? 'managed authorization toolkit did not match'
        : code === 'stale_provider'
        ? 'stale managed authorization provider'
        : code === 'replayed'
        ? 'replayed managed authorization attempt'
        : 'invalid managed authorization attempt',
    );
  }
}

export function assertManagedAuthorizationProvider(
  attempt: ManagedAuthorizationAttempt,
  provider: { generation: number; lineage: string },
): void {
  if (attempt.providerGeneration !== provider.generation ||
      attempt.providerLineage !== provider.lineage) {
    throw new ManagedAuthorizationError('stale_provider');
  }
}

export async function beginManagedAuthorization(input: {
  settings: SettingsStore;
  input: ManagedAuthorizationInput;
  now?: () => number;
  randomSecret?: () => string;
}): Promise<{ attempt: ManagedAuthorizationAttempt; browserSecret: string }> {
  validateInput(input.input);
  const browserSecret = (input.randomSecret ?? secureRandomSecret)();
  if (!SECRET_PATTERN.test(browserSecret)) throw new Error('managed authorization secret is invalid');
  const now = (input.now ?? Date.now)();
  const attempt: ManagedAuthorizationAttempt = {
    version: 1,
    status: 'pending',
    ...structuredClone(input.input),
    browserSecretHash: await sha256Hex(browserSecret),
    createdAt: now,
    expiresAt: now + MANAGED_AUTHORIZATION_TTL_MS,
    updatedAt: now,
  };
  const key = await settingKey(input.input.actorMembershipId, input.input.attemptScopeId);
  const current = await input.settings.getSetting(key);
  if (current) {
    try {
      const existing = parseAttempt(current);
      // Once the provider has allocated a connection request, the attempt owns
      // a deletable remote handle until Chickpea imports or explicitly cleans
      // it up. Never replace that handle merely because the browser TTL elapsed.
      if (existing.authorizationRef || existing.status === 'authorized' ||
          now < existing.expiresAt) {
        throw new ManagedAuthorizationError('in_progress');
      }
    } catch (error) {
      if (error instanceof ManagedAuthorizationError && error.code === 'in_progress') throw error;
      // Unknown stored state may still be the only durable handle for a remote
      // Connect Link. Fail closed instead of overwriting it; an operator can
      // use the bounded reference in this event to reconcile the provider.
      console.error(JSON.stringify({
        event: 'chickpea.managed_connection.invalid_authorization_attempt_blocked',
        ...safeRemoteRefFromMalformedAttempt(current),
      }));
      throw new ManagedAuthorizationError('recovery_required');
    }
  }
  const created = await input.settings.applySettingsPatch({
    expected: { key, value: current ?? null },
    set: [{ key, value: JSON.stringify(attempt) }],
  });
  if (!created) throw new ManagedAuthorizationError('in_progress');
  return { attempt, browserSecret };
}

export async function inspectManagedAuthorization(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  now?: () => number;
}): Promise<ManagedAuthorizationAttempt> {
  return (await load(input)).attempt;
}

/** Browser-bound inspection used only to clean up an expired remote grant. */
export async function inspectManagedAuthorizationForCleanup(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  now?: () => number;
}): Promise<ManagedAuthorizationAttempt> {
  return (await load({ ...input, allowExpired: true })).attempt;
}

/**
 * Recover a provider grant after the browser-bound secret is gone. The extra
 * grace window keeps a still-open callback authoritative beyond its nominal
 * TTL while ensuring an abandoned remote grant cannot lock the member's one
 * authorization slot forever.
 */
export async function inspectStaleManagedAuthorization(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  now?: () => number;
}): Promise<ManagedAuthorizationAttempt | undefined> {
  const loaded = await loadForStaleCleanup(input);
  return loaded?.attempt;
}

/**
 * Owner-only reconciliation for an unknown attempt format. Provider accounts
 * are deleted before the exact malformed value is compare-and-set removed.
 */
export async function recoverMalformedManagedAuthorization(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  cleanupRemoteAccount(input: { adapterId: string; accountRef: string }): Promise<boolean>;
}): Promise<{ adapterId: string; deletedRemoteAccounts: number }> {
  if (!ID_PATTERN.test(input.actorMembershipId)) throw new ManagedAuthorizationError('invalid');
  const key = await settingKey(input.actorMembershipId);
  const raw = await input.settings.getSetting(key);
  if (!raw) return { adapterId: 'unknown', deletedRemoteAccounts: 0 };
  try {
    parseAttempt(raw);
    throw new ManagedAuthorizationError('in_progress');
  } catch (error) {
    if (!(error instanceof ManagedAuthorizationError) || error.code !== 'invalid') throw error;
  }
  const refs = safeRemoteRefFromMalformedAttempt(raw);
  const accountRefs = [...new Set([refs.authorizationRef, refs.accountRef].filter(
    (value): value is string => value !== undefined,
  ))];
  if (!refs.adapterId || accountRefs.length === 0) {
    throw new ManagedAuthorizationError('recovery_required');
  }
  let deletedRemoteAccounts = 0;
  for (const accountRef of accountRefs) {
    if (await input.cleanupRemoteAccount({ adapterId: refs.adapterId, accountRef })) {
      deletedRemoteAccounts += 1;
    }
  }
  const changed = await input.settings.applySettingsPatch({
    expected: { key, value: raw },
    delete: [key],
  });
  if (!changed) throw new ManagedAuthorizationError('in_progress');
  return { adapterId: refs.adapterId, deletedRemoteAccounts };
}

/** Delete only the exact stale attempt inspected after its remote grant is safe. */
export async function abandonStaleManagedAuthorization(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  now?: () => number;
}): Promise<void> {
  const loaded = await loadForStaleCleanup(input);
  // A concurrent cleanup may already have deleted the stale attempt or
  // replaced it with a new pending attempt. Both are safe goal states; the
  // caller's subsequent begin will either succeed or report in_progress.
  if (!loaded) return;
  const changed = await input.settings.applySettingsPatch({
    expected: { key: loaded.key, value: loaded.raw },
    delete: [loaded.key],
  });
  // Another request won the cleanup race. The remote grant was already made
  // safe before either caller reached this CAS; beginManagedAuthorization now
  // owns the decision between a fresh 200 and the normal in-progress 409.
  if (!changed) return;
}

/** Bind the pending browser attempt to the exact provider connection request. */
export async function recordManagedAuthorizationRequest(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  authorizationRef: string;
  now?: () => number;
}): Promise<ManagedAuthorizationAttempt> {
  if (!ID_PATTERN.test(input.authorizationRef)) throw new ManagedAuthorizationError('invalid');
  const loaded = await load(input);
  if (loaded.attempt.status !== 'pending') throw new ManagedAuthorizationError('replayed');
  if (loaded.attempt.authorizationRef) {
    if (loaded.attempt.authorizationRef !== input.authorizationRef) {
      throw new ManagedAuthorizationError('replayed');
    }
    return loaded.attempt;
  }
  const updated: ManagedAuthorizationAttempt = {
    ...loaded.attempt,
    authorizationRef: input.authorizationRef,
    updatedAt: (input.now ?? Date.now)(),
  };
  const changed = await input.settings.applySettingsPatch({
    expected: { key: loaded.key, value: loaded.raw },
    set: [{ key: loaded.key, value: JSON.stringify(updated) }],
  });
  if (!changed) throw new ManagedAuthorizationError('replayed');
  return updated;
}

export async function recordManagedAuthorizationAccount(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  accountRef: string;
  toolkit: string;
  now?: () => number;
}): Promise<ManagedAuthorizationAttempt> {
  if (!ID_PATTERN.test(input.accountRef) || !TOOLKIT_PATTERN.test(input.toolkit)) {
    throw new ManagedAuthorizationError('invalid');
  }
  const loaded = await load(input);
  if (!loaded.attempt.authorizationRef ||
      loaded.attempt.authorizationRef !== input.accountRef) {
    throw new ManagedAuthorizationError('replayed');
  }
  if (loaded.attempt.toolkit !== input.toolkit) {
    throw new ManagedAuthorizationError('toolkit_mismatch');
  }
  if (loaded.attempt.status === 'authorized') {
    if (loaded.attempt.accountRef !== input.accountRef) {
      throw new ManagedAuthorizationError('replayed');
    }
    return loaded.attempt;
  }
  const now = (input.now ?? Date.now)();
  const authorized: ManagedAuthorizationAttempt = {
    ...loaded.attempt,
    status: 'authorized',
    accountRef: input.accountRef,
    updatedAt: now,
  };
  const changed = await input.settings.applySettingsPatch({
    expected: { key: loaded.key, value: loaded.raw },
    set: [{ key: loaded.key, value: JSON.stringify(authorized) }],
  });
  if (!changed) throw new ManagedAuthorizationError('replayed');
  return authorized;
}

export async function finalizeManagedAuthorization(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  now?: () => number;
}): Promise<void> {
  const loaded = await load(input);
  if (loaded.attempt.status !== 'authorized') throw new ManagedAuthorizationError('invalid');
  const changed = await input.settings.applySettingsPatch({
    expected: { key: loaded.key, value: loaded.raw },
    delete: [loaded.key],
  });
  if (!changed) throw new ManagedAuthorizationError('replayed');
}

/** Remove the exact browser-bound attempt after a failed remote redemption. */
export async function abandonManagedAuthorization(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  now?: () => number;
  allowExpired?: boolean;
}): Promise<void> {
  const loaded = await load(input);
  const changed = await input.settings.applySettingsPatch({
    expected: { key: loaded.key, value: loaded.raw },
    delete: [loaded.key],
  });
  if (!changed) throw new ManagedAuthorizationError('replayed');
}

/**
 * Restart-only cleanup after the exact remote grant is already safe. A second
 * tab may have deleted the attempt or installed its own pending attempt after
 * the caller inspected the shared cookie; beginManagedAuthorization owns the
 * resulting 200-versus-in-progress decision.
 */
export async function abandonManagedAuthorizationForRestart(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  now?: () => number;
}): Promise<void> {
  try {
    await abandonManagedAuthorization({ ...input, allowExpired: true });
  } catch (error) {
    if (error instanceof ManagedAuthorizationError &&
        (error.code === 'invalid' || error.code === 'replayed')) return;
    throw error;
  }
}

async function load(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  attemptScopeId?: string;
  browserSecret: string;
  now?: () => number;
  allowExpired?: boolean;
}): Promise<{ key: string; raw: string; attempt: ManagedAuthorizationAttempt }> {
  if (!ID_PATTERN.test(input.actorMembershipId) || !SECRET_PATTERN.test(input.browserSecret)) {
    throw new ManagedAuthorizationError('invalid');
  }
  const key = await settingKey(input.actorMembershipId, input.attemptScopeId);
  const raw = await input.settings.getSetting(key);
  if (!raw) throw new ManagedAuthorizationError('invalid');
  const attempt = parseAttempt(raw);
  if (
    attempt.actorMembershipId !== input.actorMembershipId ||
    attempt.attemptScopeId !== input.attemptScopeId ||
    !constantTimeTextEqual(attempt.browserSecretHash, await sha256Hex(input.browserSecret))
  ) {
    throw new ManagedAuthorizationError('invalid');
  }
  if (!input.allowExpired && (input.now ?? Date.now)() >= attempt.expiresAt) {
    throw new ManagedAuthorizationError('expired');
  }
  return { key, raw, attempt };
}

async function loadForStaleCleanup(input: {
  settings: SettingsStore;
  actorMembershipId: string;
  now?: () => number;
}): Promise<{ key: string; raw: string; attempt: ManagedAuthorizationAttempt } | undefined> {
  if (!ID_PATTERN.test(input.actorMembershipId)) throw new ManagedAuthorizationError('invalid');
  const key = await settingKey(input.actorMembershipId);
  const raw = await input.settings.getSetting(key);
  if (!raw) return undefined;
  const attempt = parseAttempt(raw);
  if (attempt.actorMembershipId !== input.actorMembershipId ||
      (!attempt.authorizationRef && attempt.status !== 'authorized') ||
      (input.now ?? Date.now)() < attempt.expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS) {
    return undefined;
  }
  return { key, raw, attempt };
}

function parseAttempt(raw: string): ManagedAuthorizationAttempt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ManagedAuthorizationError('invalid');
  }
  if (!isRecord(value) || value.version !== 1 ||
      (value.status !== 'pending' && value.status !== 'authorized')) {
    throw new ManagedAuthorizationError('invalid');
  }
  const attempt = value as unknown as ManagedAuthorizationAttempt;
  try {
    validateInput(attempt);
  } catch {
    throw new ManagedAuthorizationError('invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(attempt.browserSecretHash) ||
      !Number.isSafeInteger(attempt.createdAt) || !Number.isSafeInteger(attempt.updatedAt) ||
      !Number.isSafeInteger(attempt.expiresAt) || attempt.expiresAt <= attempt.createdAt ||
      (attempt.authorizationRef !== undefined && !ID_PATTERN.test(attempt.authorizationRef)) ||
      (attempt.status === 'authorized' && (
        !attempt.authorizationRef || !attempt.accountRef || !ID_PATTERN.test(attempt.accountRef)
      )) ||
      (attempt.status === 'pending' && attempt.accountRef !== undefined)) {
    throw new ManagedAuthorizationError('invalid');
  }
  return structuredClone(attempt);
}

function safeRemoteRefFromMalformedAttempt(
  raw: string,
): { authorizationRef?: string; accountRef?: string; adapterId?: string } {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return {};
    return {
      ...(typeof value.authorizationRef === 'string' && ID_PATTERN.test(value.authorizationRef)
        ? { authorizationRef: value.authorizationRef }
        : {}),
      ...(typeof value.accountRef === 'string' && ID_PATTERN.test(value.accountRef)
        ? { accountRef: value.accountRef }
        : {}),
      ...(typeof value.adapterId === 'string' && ID_PATTERN.test(value.adapterId)
        ? { adapterId: value.adapterId }
        : {}),
    };
  } catch {
    return {};
  }
}

function validateInput(input: ManagedAuthorizationInput): void {
  if (!ID_PATTERN.test(input.workspaceId) || !ID_PATTERN.test(input.agentId) ||
      !ID_PATTERN.test(input.actorMembershipId) || !ID_PATTERN.test(input.providerId) ||
      (input.attemptScopeId !== undefined && !ID_PATTERN.test(input.attemptScopeId)) ||
      !ID_PATTERN.test(input.adapterId) || !TOOLKIT_PATTERN.test(input.toolkit) ||
      !ID_PATTERN.test(input.principalRef) || input.label !== input.label.trim() ||
      input.label.length < 1 || input.label.length > 256 ||
      (input.connectionAccountId !== undefined &&
        !/^connection_[A-Za-z0-9_-]{1,180}$/.test(input.connectionAccountId)) ||
      (input.ownerKind !== 'team' && input.ownerKind !== 'member') ||
      ((input.providerGeneration === undefined) !== (input.providerLineage === undefined)) ||
      (input.providerGeneration !== undefined && (
        !Number.isSafeInteger(input.providerGeneration) || input.providerGeneration < 1 ||
        !/^[a-f0-9]{24}$/.test(input.providerLineage ?? '')
      )) ||
      !validCapabilities(input.allowedCapabilities) ||
      (input.connectionAccountId === undefined
        ? !validCapabilities(input.bindingCapabilities) || input.bindingCapabilities.some(
            (capability) => !input.allowedCapabilities.includes(capability),
          )
        : input.bindingCapabilities !== undefined)) {
    throw new Error('managed authorization input is invalid');
  }
}

function validCapabilities(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 &&
    new Set(value).size === value.length &&
    value.every((entry) => /^[a-z0-9_.:-]{1,128}$/.test(entry));
}

async function settingKey(actorMembershipId: string, attemptScopeId?: string): Promise<string> {
  const identity = attemptScopeId === undefined
    ? actorMembershipId
    : `${actorMembershipId}\u0000${attemptScopeId}`;
  return `${SETTING_PREFIX}${(await sha256Hex(identity)).slice(0, 32)}`;
}

function secureRandomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
