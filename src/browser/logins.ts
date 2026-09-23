import type { EncryptedCredentialStore, SettingsStore } from '../config/settings-store.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';
import { loadCredentialKeyring } from '../slack/credential-keyring.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
  type CredentialKeyring,
  type SlackSecretEnvelopeContext,
  workspaceCredentialContext,
} from '../slack/secret-envelope.ts';
import { updateJsonSetting } from '../config/setting-string-set.ts';

/**
 * Website logins: a person's sign-in to a website, which Agents granted it can
 * use in the hosted browser. Admin-owned metadata (host, label, owner,
 * username) lives in one bounded catalog row; the runtime state the browser
 * tools write (saved context, open hand-off, last use) lives in one small row
 * per login, so a busy login never rewrites the catalog. Each login's password
 * and optional TOTP seed live only as an encrypted credential revision.
 * Nothing here returns or logs a password or TOTP seed except
 * `readWebsiteLoginSecrets`, the call-time reader.
 */

export const WEBSITE_LOGINS_SETTING = 'browser.logins.v1';
export const MAX_WEBSITE_LOGINS = 100;
const STATE_KEY_PREFIX = 'website_login_state.';
const MAX_CAS_ATTEMPTS = 12;
const SECRET_KEY_PREFIX = 'website_login.';
const CREDENTIAL_IDENTITY_ID = 'website_login';
const CREDENTIAL_APP_ID = 'BROWSER';
const LOGIN_ID_PATTERN = /^wl_[a-f0-9]{32}$/;
const MEMBERSHIP_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const BROWSER_CONTEXT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_HOST_LENGTH = 260;
const MAX_LABEL_LENGTH = 80;
const MAX_USERNAME_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1_024;

export type WebsiteLoginOwnerKind = 'team' | 'member';
export type WebsiteLoginMethod = 'credentials' | 'handoff';

/**
 * Metadata only, with the login's runtime state joined in. Secrets are never
 * part of this shape.
 */
export interface WebsiteLogin {
  id: string;
  /** Lowercase hostname, with an explicit non-default port when one was given. */
  host: string;
  label: string;
  ownerKind: WebsiteLoginOwnerKind;
  /** Present only on member-owned logins. */
  ownerMembershipId?: string;
  createdByMembershipId: string;
  method: WebsiteLoginMethod;
  /** Display copy of the sign-in name; the encrypted bundle holds its own. */
  username?: string;
  /** Hosted-browser context holding this login's saved session, once one exists. */
  contextId?: string;
  /**
   * A kept-alive hosted-browser session handed to a person to sign in. The
   * next bound session ends it first so its sign-in is saved to the context.
   */
  handoffSessionId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** The runtime fields, stored apart from the catalog row. */
type WebsiteLoginState = Pick<WebsiteLogin, 'contextId' | 'handoffSessionId' | 'lastUsedAt'>;

export interface WebsiteLoginSecrets {
  username: string;
  password: string;
  totpSeed?: string;
}

export interface WebsiteLoginDependencies {
  store: SettingsStore & EncryptedCredentialStore;
  keyring: CredentialKeyring;
}

export interface CreateWebsiteLoginInput {
  host: string;
  label: string;
  ownerKind: WebsiteLoginOwnerKind;
  /** Required for member-owned logins; ignored for team logins. */
  ownerMembershipId?: string;
  createdByMembershipId: string;
  method: WebsiteLoginMethod;
  username?: string;
  /** Required for `credentials`; rejected for `handoff`. */
  password?: string;
  /** Optional base32 TOTP seed; `credentials` only. */
  totpSeed?: string;
  now?: number;
}

export type WebsiteLoginInputErrorCode =
  | 'invalid_host'
  | 'invalid_label'
  | 'invalid_owner'
  | 'invalid_username'
  | 'invalid_password'
  | 'invalid_totp_seed'
  | 'invalid_method'
  | 'invalid_context';

/** The caller supplied an invalid field. Carries a field code, never a value. */
export class WebsiteLoginInputError extends Error {
  readonly name = 'WebsiteLoginInputError';
  constructor(readonly code: WebsiteLoginInputErrorCode) {
    super(`Website login input is invalid: ${code}.`);
  }
}

export class WebsiteLoginLimitError extends Error {
  readonly name = 'WebsiteLoginLimitError';
  constructor() {
    super(`At most ${MAX_WEBSITE_LOGINS} website logins can be saved.`);
  }
}

/** Concurrent writers kept winning, or stored state is inconsistent. */
export class WebsiteLoginStateError extends Error {
  readonly name = 'WebsiteLoginStateError';
  constructor() {
    super('Website login state could not be updated.');
  }
}

/** Production dependencies. The keyring loads lazily, only when a secret is touched. */
export function websiteLoginDependencies(env?: PlatformEnv): WebsiteLoginDependencies {
  const store = getSettingsStore(env);
  let keyring: CredentialKeyring | undefined;
  return {
    store,
    get keyring() {
      keyring ??= loadCredentialKeyring(env);
      return keyring;
    },
  };
}

/**
 * Normalize a host the person typed. Accepts a bare hostname with an optional
 * port; rejects schemes, paths, queries, credentials, and whitespace rather
 * than silently trimming them, so a login is never bound to a surprise host.
 */
export function normalizeWebsiteLoginHost(raw: string): string {
  if (typeof raw !== 'string') throw new WebsiteLoginInputError('invalid_host');
  const host = raw.trim();
  if (!host || host.length > MAX_HOST_LENGTH || /[\s/\\?#@]/.test(host) || host.includes('://')) {
    throw new WebsiteLoginInputError('invalid_host');
  }
  let url: URL;
  try {
    url = new URL(`https://${host}`);
  } catch {
    throw new WebsiteLoginInputError('invalid_host');
  }
  if (!url.hostname || url.pathname !== '/' || url.search || url.hash ||
      url.username || url.password || url.hostname.startsWith('.') ||
      url.hostname.endsWith('.')) {
    throw new WebsiteLoginInputError('invalid_host');
  }
  return url.host.toLowerCase();
}

export async function listWebsiteLogins(store: SettingsStore): Promise<WebsiteLogin[]> {
  const logins = parseLogins(await store.getSetting(WEBSITE_LOGINS_SETTING));
  if (!logins.length) return logins;
  const states = await store.getSettings(logins.map((login) => stateKey(login.id)));
  return logins.map((login, index) => withState(login, states[index]));
}

export async function getWebsiteLogin(
  store: SettingsStore,
  id: string,
): Promise<WebsiteLogin | undefined> {
  if (!LOGIN_ID_PATTERN.test(id)) return undefined;
  const [catalog, state] = await store.getSettings([WEBSITE_LOGINS_SETTING, stateKey(id)]);
  const login = parseLogins(catalog).find((entry) => entry.id === id);
  return login && withState(login, state);
}

/**
 * Create a login. The secret is written first under a fresh key; the metadata
 * row is then compare-and-set. If the metadata cannot be written (list full,
 * contention, or a store failure), the secret is removed again, so an
 * encrypted revision never outlives a failed create.
 */
export async function createWebsiteLogin(
  deps: WebsiteLoginDependencies,
  input: CreateWebsiteLoginInput,
): Promise<WebsiteLogin> {
  const host = normalizeWebsiteLoginHost(input.host);
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new WebsiteLoginInputError('invalid_label');
  }
  if (!MEMBERSHIP_ID_PATTERN.test(input.createdByMembershipId) ||
      (input.ownerKind !== 'team' && input.ownerKind !== 'member') ||
      (input.ownerKind === 'member' &&
        !MEMBERSHIP_ID_PATTERN.test(input.ownerMembershipId ?? ''))) {
    throw new WebsiteLoginInputError('invalid_owner');
  }
  const username = input.username === undefined ? undefined : input.username.trim();
  if (username !== undefined &&
      (username.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/.test(username))) {
    throw new WebsiteLoginInputError('invalid_username');
  }
  let secrets: WebsiteLoginSecrets | undefined;
  if (input.method === 'credentials') {
    if (!username) throw new WebsiteLoginInputError('invalid_username');
    const password = input.password;
    if (typeof password !== 'string' || password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
      throw new WebsiteLoginInputError('invalid_password');
    }
    const totpSeed = input.totpSeed === undefined ? undefined : normalizeTotpSeed(input.totpSeed);
    secrets = { username, password, ...(totpSeed ? { totpSeed } : {}) };
  } else if (input.method === 'handoff') {
    if (input.password !== undefined) throw new WebsiteLoginInputError('invalid_password');
    if (input.totpSeed !== undefined) throw new WebsiteLoginInputError('invalid_totp_seed');
  } else {
    throw new WebsiteLoginInputError('invalid_method');
  }

  const suffix = randomHex();
  const login: WebsiteLogin = {
    id: `wl_${suffix}`,
    host,
    label,
    ownerKind: input.ownerKind,
    ...(input.ownerKind === 'member' ? { ownerMembershipId: input.ownerMembershipId! } : {}),
    createdByMembershipId: input.createdByMembershipId,
    method: input.method,
    ...(username ? { username } : {}),
    createdAt: input.now ?? Date.now(),
  };

  let secretRevision: string | undefined;
  if (secrets) {
    const revision = `wl_rev_${randomHex()}`;
    const contextId = secretContextId(login.id);
    const envelope = await encryptSlackSecretEnvelope(
      deps.keyring,
      credentialContext(contextId, revision),
      { ...secrets },
    );
    const written = await deps.store.replaceEncryptedCredentialRevision({
      key: secretKey(login.id),
      expectedRevision: null,
      revision,
      contextId,
      envelope,
    });
    if (!written) throw new WebsiteLoginStateError();
    secretRevision = revision;
  }

  const rollback = async (): Promise<void> => {
    if (!secretRevision) return;
    try {
      await deps.store.deleteEncryptedCredentialRevision(secretKey(login.id), secretRevision);
    } catch {
      // The metadata row never names this login, so the orphan is unreadable
      // through readWebsiteLoginSecrets; the original error is the useful one.
    }
  };

  try {
    const outcome = await updateLogins(deps.store, (logins) => {
      if (logins.length >= MAX_WEBSITE_LOGINS) return { error: new WebsiteLoginLimitError() };
      return { next: [...logins, login] };
    });
    if (outcome instanceof Error) throw outcome;
  } catch (error) {
    await rollback();
    throw error;
  }
  return login;
}

/**
 * Decrypt one login's secrets for the call-time consumer. Returns undefined
 * when the login is gone, is a hand-off login, or has no stored secret. The
 * envelope context is derived from the login id, so an envelope copied onto
 * another login's key does not decrypt.
 */
export async function readWebsiteLoginSecrets(
  deps: WebsiteLoginDependencies,
  id: string,
): Promise<WebsiteLoginSecrets | undefined> {
  const login = await getWebsiteLogin(deps.store, id);
  if (!login || login.method !== 'credentials') return undefined;
  const active = await deps.store.getEncryptedCredentialRevision(secretKey(id));
  if (!active) return undefined;
  const contextId = secretContextId(id);
  if (active.contextId !== contextId) throw new WebsiteLoginStateError();
  let decrypted: Record<string, string>;
  try {
    decrypted = await decryptSlackSecretEnvelope<Record<string, string>>(
      deps.keyring,
      credentialContext(contextId, active.revision),
      active.envelope,
    );
  } catch {
    throw new WebsiteLoginStateError();
  }
  const { username, password, totpSeed } = decrypted;
  if (!username || !password) throw new WebsiteLoginStateError();
  return { username, password, ...(totpSeed ? { totpSeed } : {}) };
}

/**
 * Delete a login: metadata and runtime state first (so no reader can reach
 * the secret), then its secret. A missing secret is fine. Returns whether
 * metadata existed.
 */
export async function deleteWebsiteLogin(
  deps: Pick<WebsiteLoginDependencies, 'store'>,
  id: string,
): Promise<boolean> {
  if (!LOGIN_ID_PATTERN.test(id)) return false;
  let existed = false;
  const outcome = await updateLogins(deps.store, (logins) => {
    const next = logins.filter((login) => login.id !== id);
    existed = next.length !== logins.length;
    return existed ? { next, delete: [stateKey(id)] } : {};
  });
  if (outcome instanceof Error) throw outcome;
  const active = await deps.store.getEncryptedCredentialRevision(secretKey(id));
  if (active && !await deps.store.deleteEncryptedCredentialRevision(secretKey(id), active.revision)) {
    // A concurrent writer replaced it; nothing else ever writes this key, so retry once.
    const latest = await deps.store.getEncryptedCredentialRevision(secretKey(id));
    if (latest && !await deps.store.deleteEncryptedCredentialRevision(secretKey(id), latest.revision)) {
      throw new WebsiteLoginStateError();
    }
  }
  return existed;
}

/** Record when the login was last used (bound to a session or signed in). Returns false when the login is gone. */
export async function touchWebsiteLoginUsed(
  store: SettingsStore,
  id: string,
  at: number,
): Promise<boolean> {
  return patchLoginState(store, id, (state) => ({ ...state, lastUsedAt: at }));
}

/** Remember the hosted-browser context holding this login's session. */
export async function setWebsiteLoginContext(
  store: SettingsStore,
  id: string,
  contextId: string,
): Promise<boolean> {
  if (!BROWSER_CONTEXT_ID_PATTERN.test(contextId)) {
    throw new WebsiteLoginInputError('invalid_context');
  }
  return patchLoginState(store, id, (state) => ({ ...state, contextId }));
}

/** Remember (or, with undefined, forget) a hand-off session still open for this login. */
export async function setWebsiteLoginHandoff(
  store: SettingsStore,
  id: string,
  sessionId: string | undefined,
): Promise<boolean> {
  if (sessionId !== undefined && !BROWSER_CONTEXT_ID_PATTERN.test(sessionId)) {
    throw new WebsiteLoginInputError('invalid_context');
  }
  return patchLoginState(store, id, (state) => {
    const { handoffSessionId: _previous, ...rest } = state;
    return sessionId === undefined ? rest : { ...rest, handoffSessionId: sessionId };
  });
}

/**
 * A login entry frozen into a runtime plan, as the call-time intersection
 * sees it. Structural so frozen plan rows and live compiled rows both fit.
 */
export interface FrozenWebsiteLoginEntry {
  id: string;
  host: string;
  method: WebsiteLoginMethod;
  level: 'check' | 'act';
}

/**
 * Preserve a turn's frozen website-login ceiling while applying live
 * revocations (clone of intersectFrozenRepositoryGrants). The frozen list caps
 * additions; the live list applies removals and downgrades. An entry survives
 * only while live still grants the same id for the same host and method, and
 * its level is the lower of the frozen and live levels, so `act` granted after
 * the turn froze never widens it, while `act` withdrawn mid-turn narrows it.
 */
export function intersectFrozenWebsiteLogins<T extends FrozenWebsiteLoginEntry>(
  frozen: readonly T[] | undefined,
  live: readonly FrozenWebsiteLoginEntry[] | undefined,
): T[] {
  const liveById = new Map((live ?? []).map((entry) => [entry.id, entry]));
  return (frozen ?? []).flatMap((entry) => {
    const current = liveById.get(entry.id);
    if (!current || current.host !== entry.host || current.method !== entry.method) return [];
    const level = entry.level === 'act' && current.level === 'act' ? 'act' : 'check';
    return [level === entry.level ? entry : { ...entry, level }];
  });
}

function secretKey(id: string): string {
  return `${SECRET_KEY_PREFIX}${id}`;
}

function secretContextId(id: string): string {
  // Deterministic per login: binds the envelope's associated data to its id.
  return `wl_ctx_${id.slice(3)}`;
}

function credentialContext(contextId: string, revision: string): SlackSecretEnvelopeContext {
  return workspaceCredentialContext({
    contextId,
    identityId: CREDENTIAL_IDENTITY_ID,
    appId: CREDENTIAL_APP_ID,
    purpose: 'website_login',
    revision,
  });
}

function stateKey(id: string): string {
  return `${STATE_KEY_PREFIX}${id}`;
}

function normalizeTotpSeed(raw: string): string | undefined {
  if (typeof raw !== 'string') throw new WebsiteLoginInputError('invalid_totp_seed');
  const seed = raw.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  if (!seed) return undefined;
  if (!/^[A-Z2-7]{16,128}$/.test(seed)) throw new WebsiteLoginInputError('invalid_totp_seed');
  return seed;
}

function randomHex(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/**
 * Compare-and-set one login's runtime state row. Returns false when the login
 * is gone. A login whose state still sits in its catalog entry (written before
 * the state row existed) starts from that entry.
 */
async function patchLoginState(
  store: SettingsStore,
  id: string,
  change: (state: WebsiteLoginState) => WebsiteLoginState,
): Promise<boolean> {
  if (!LOGIN_ID_PATTERN.test(id)) return false;
  const login = parseLogins(await store.getSetting(WEBSITE_LOGINS_SETTING)).find((entry) => entry.id === id);
  if (!login) return false;
  const written = await updateJsonSetting<WebsiteLoginState>(
    store,
    stateKey(id),
    (current) => change(current ?? stateOf(login)),
    parseState,
  );
  if (!written) throw new WebsiteLoginStateError();
  return true;
}

/**
 * Compare-and-set the metadata row. `step` returns `next` to write, `error` to
 * stop without writing, or neither to leave the row unchanged.
 */
async function updateLogins(
  store: SettingsStore,
  step: (logins: WebsiteLogin[]) => { next?: WebsiteLogin[]; delete?: string[]; error?: Error },
): Promise<Error | undefined> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await store.getSetting(WEBSITE_LOGINS_SETTING);
    const result = step(parseLogins(raw));
    if (result.error) return result.error;
    if (!result.next) return undefined;
    const applied = await store.applySettingsPatch({
      expected: { key: WEBSITE_LOGINS_SETTING, value: raw ?? null },
      set: [{ key: WEBSITE_LOGINS_SETTING, value: JSON.stringify(result.next) }],
      ...(result.delete ? { delete: result.delete } : {}),
    });
    if (applied) return undefined;
  }
  throw new WebsiteLoginStateError();
}

function parseLogins(raw: string | undefined): WebsiteLogin[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const login = parseLogin(entry);
    return login ? [login] : [];
  }).slice(0, MAX_WEBSITE_LOGINS);
}

/** The catalog entry with its state row applied; no row keeps the entry's own (older) fields. */
function withState(login: WebsiteLogin, raw: string | undefined): WebsiteLogin {
  const state = raw === undefined ? undefined : parseState(raw);
  if (!state) return login;
  const { contextId: _context, handoffSessionId: _handoff, lastUsedAt: _used, ...catalog } = login;
  return { ...catalog, ...state };
}

function stateOf(login: WebsiteLogin): WebsiteLoginState {
  return {
    ...(login.contextId ? { contextId: login.contextId } : {}),
    ...(login.handoffSessionId ? { handoffSessionId: login.handoffSessionId } : {}),
    ...(login.lastUsedAt !== undefined ? { lastUsedAt: login.lastUsedAt } : {}),
  };
}

function parseState(raw: string): WebsiteLoginState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.contextId === 'string' && record.contextId ? { contextId: record.contextId } : {}),
    ...(typeof record.handoffSessionId === 'string' && record.handoffSessionId
      ? { handoffSessionId: record.handoffSessionId }
      : {}),
    ...(typeof record.lastUsedAt === 'number' ? { lastUsedAt: record.lastUsedAt } : {}),
  };
}

function parseLogin(value: unknown): WebsiteLogin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' ? record[key] : undefined;
  const id = text('id');
  const host = text('host');
  const label = text('label');
  const createdByMembershipId = text('createdByMembershipId');
  const ownerKind = record.ownerKind;
  const method = record.method;
  const createdAt = record.createdAt;
  if (!id || !LOGIN_ID_PATTERN.test(id) || !host || !label || !createdByMembershipId ||
      (ownerKind !== 'team' && ownerKind !== 'member') ||
      (method !== 'credentials' && method !== 'handoff') ||
      typeof createdAt !== 'number') {
    return undefined;
  }
  const ownerMembershipId = text('ownerMembershipId');
  if (ownerKind === 'member' && !ownerMembershipId) return undefined;
  const username = text('username');
  // Runtime fields now live in the state row; older catalog entries may still carry them.
  const contextId = text('contextId');
  const handoffSessionId = text('handoffSessionId');
  const lastUsedAt = typeof record.lastUsedAt === 'number' ? record.lastUsedAt : undefined;
  return {
    id,
    host,
    label,
    ownerKind,
    ...(ownerKind === 'member' ? { ownerMembershipId: ownerMembershipId! } : {}),
    createdByMembershipId,
    method,
    ...(username ? { username } : {}),
    ...(contextId ? { contextId } : {}),
    ...(handoffSessionId ? { handoffSessionId } : {}),
    createdAt,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
  };
}
