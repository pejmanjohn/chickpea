import { encodeBase64Url } from '../security/base64url.ts';
import { trimmedNonEmpty } from '../security/content-validation.ts';
import type { SettingsStore } from './settings-store.ts';

export const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_APP_MANAGED_HOSTS = ['api.github.com', 'github.com'] as const;

const GITHUB_APP_MANAGED_HOST_SET = new Set<string>(GITHUB_APP_MANAGED_HOSTS);

export function isGithubAppManagedHost(host: string): boolean {
  return GITHUB_APP_MANAGED_HOST_SET.has(host.trim().toLowerCase().replace(/\.+$/, ''));
}

// Strict owner/repo shapes. These feed URL prefixes in the egress allow-list,
// so anything URL-normalization could collapse (dot segments) or reinterpret
// (metacharacters) must be impossible: `Acme/..` would otherwise normalize
// `https://api.github.com/repos/Acme/..` down to `/repos` and match EVERY
// repository. GitHub logins are alphanumeric+hyphen; repo names allow
// [A-Za-z0-9._-] but never `.` or `..` alone.
export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const GITHUB_REPO_NAME_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

export function isValidRepositoryFullName(fullName: string): boolean {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash !== fullName.lastIndexOf('/')) return false;
  return (
    GITHUB_OWNER_PATTERN.test(fullName.slice(0, slash)) &&
    GITHUB_REPO_NAME_PATTERN.test(fullName.slice(slash + 1))
  );
}

export const GITHUB_SETTING_KEYS = {
  appId: 'github.app.id',
  appSlug: 'github.app.slug',
  privateKey: 'github.app.private_key',
  webhookSecret: 'github.app.webhook_secret',
  // Single-use CSRF state for the manifest setup flow; listed here so a
  // disconnect clears any half-finished setup handshake too.
  setupState: 'github.setup_state',
} as const;

export type GithubConnection =
  | { mode: 'none' }
  | {
      mode: 'app';
      appId: string;
      appSlug?: string;
      privateKeyPem: string;
    };

interface GithubInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
}

interface GithubRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

interface GithubRepositoryPage {
  repositories: GithubRepository[];
  totalCount: number;
  /** True when the page cap stopped enumeration before the account's full repository list. */
  truncated: boolean;
}

interface GithubManifestConversion {
  id: number;
  slug: string;
  privateKeyPem: string;
  // Absent when the created App has no webhook (e.g. a localhost dev install
  // whose manifest omitted hook_attributes). GitHub returns null in that case.
  webhookSecret?: string;
}

interface GithubSetupState {
  state: string;
  mintedAt: number;
  membershipId: string | null;
}

const GITHUB_SETUP_STATE_TTL_MS = 15 * 60 * 1_000;

export async function saveGithubSetupState(
  settings: SettingsStore,
  input: GithubSetupState,
): Promise<void> {
  const membershipIdValid = input.membershipId === null || (
    input.membershipId === input.membershipId.trim() &&
    input.membershipId.length > 0 &&
    input.membershipId.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(input.membershipId)
  );
  if (!/^[a-f0-9]{32}$/.test(input.state) || !Number.isSafeInteger(input.mintedAt) ||
      !membershipIdValid) {
    throw new Error('GitHub setup state is invalid.');
  }
  await settings.setSetting(GITHUB_SETTING_KEYS.setupState, JSON.stringify({
    version: 2,
    ...input,
  }));
}

export async function consumeGithubSetupState(
  settings: SettingsStore,
  candidate: string,
  now = Date.now(),
): Promise<GithubSetupState | undefined> {
  const stored = await settings.getSetting(GITHUB_SETTING_KEYS.setupState);
  if (!stored) return undefined;
  const parsed = parseGithubSetupState(stored);
  if (!parsed || parsed.state !== candidate) return undefined;
  const consumed = await settings.applySettingsPatch({
    expected: { key: GITHUB_SETTING_KEYS.setupState, value: stored },
    delete: [GITHUB_SETTING_KEYS.setupState],
  });
  if (!consumed) return undefined;
  if (now < parsed.mintedAt || now - parsed.mintedAt >= GITHUB_SETUP_STATE_TTL_MS) {
    return undefined;
  }
  return parsed;
}

function parseGithubSetupState(raw: string): GithubSetupState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 2 || typeof parsed.state !== 'string' ||
        typeof parsed.mintedAt !== 'number' ||
        !(typeof parsed.membershipId === 'string' || parsed.membershipId === null)) {
      return undefined;
    }
    return {
      state: parsed.state,
      mintedAt: parsed.mintedAt,
      membershipId: parsed.membershipId,
    };
  } catch {
    // Migration compatibility for setup states minted by the legacy callback.
    const separator = raw.lastIndexOf(':');
    if (separator <= 0) return undefined;
    const state = raw.slice(0, separator);
    const mintedAt = Number(raw.slice(separator + 1));
    return Number.isSafeInteger(mintedAt) ? { state, mintedAt, membershipId: null } : undefined;
  }
}

type FetchImpl = typeof fetch;

interface CachedInstallationToken {
  token: string;
  expiresAt: string;
  validUntilMs: number;
}

const INSTALLATION_TOKEN_EARLY_EXPIRY_MS = 5 * 60 * 1_000;
const INSTALLATION_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const installationTokenCache = new Map<string, CachedInstallationToken>();
const installationTokenInflight = new Map<
  string,
  Promise<{ token: string; expiresAt: string }>
>();

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'chickpea',
} as const;

export function normalizePrivateKeyPem(pem: string): string {
  if (pemBody(pem, 'PRIVATE KEY')) {
    return pem;
  }
  const pkcs1 = pemBody(pem, 'RSA PRIVATE KEY');
  if (!pkcs1) {
    throw new Error('Invalid RSA private key PEM');
  }
  return armorPem('PRIVATE KEY', pkcs1ToPkcs8(pkcs1));
}

export async function mintAppJwt(input: {
  appId: string | number;
  privateKeyPem: string;
  nowSec: number;
}): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto is unavailable');
  }
  const pkcs8 = pemBody(normalizePrivateKeyPem(input.privateKeyPem), 'PRIVATE KEY');
  if (!pkcs8) {
    throw new Error('Invalid PKCS#8 private key PEM');
  }
  const key = await subtle.importKey(
    'pkcs8',
    copiedArrayBuffer(pkcs8),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iat: input.nowSec - 60,
    exp: input.nowSec + 540,
    iss: String(input.appId),
  });
  const signingInput = `${header}.${payload}`;
  const signature = await subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function getGithubConnection(settings: SettingsStore): Promise<GithubConnection> {
  const [storedAppId, storedAppSlug, storedPrivateKey] = await settings.getSettings([
    GITHUB_SETTING_KEYS.appId,
    GITHUB_SETTING_KEYS.appSlug,
    GITHUB_SETTING_KEYS.privateKey,
  ]);
  const appId = trimmedNonEmpty(process.env.GITHUB_APP_ID) ?? trimmedNonEmpty(storedAppId);
  const privateKey =
    trimmedNonEmpty(process.env.GITHUB_APP_PRIVATE_KEY) ?? trimmedNonEmpty(storedPrivateKey);
  if (appId && privateKey) {
    const appSlug = trimmedNonEmpty(storedAppSlug);
    return {
      mode: 'app',
      appId,
      ...(appSlug ? { appSlug } : {}),
      // Deliberately NOT normalized here: connection discovery backs the
      // status route, and a malformed stored key must yield a recoverable
      // "installations unavailable" state, not a 500 that hides the
      // disconnect controls. mintAppJwt normalizes (and throws) at use time.
      privateKeyPem: privateKey,
    };
  }
  return { mode: 'none' };
}

export async function listInstallations(
  conn: GithubConnection,
  fetchImpl: FetchImpl = fetch,
): Promise<GithubInstallation[]> {
  const app = requireAppConnection(conn);
  const jwt = await currentAppJwt(app);
  const installations: GithubInstallation[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await githubFetch(
      `${GITHUB_API_BASE}/app/installations?per_page=100&page=${page}`,
      { headers: githubHeaders(`Bearer ${jwt}`) },
      fetchImpl,
    );
    const raw = await response.json();
    if (!Array.isArray(raw)) {
      throw new Error('GitHub installations response was invalid');
    }
    const pageInstallations = raw.map(parseInstallation);
    installations.push(...pageInstallations);
    if (pageInstallations.length < 100) break;
  }
  return installations;
}

/**
 * Resolve the App installation that can access one exact repository.
 * A 404 is deliberately returned as null: GitHub uses the same status for a
 * missing repository and one the App cannot access, and callers must not claim
 * a more specific cause. Other failures retain githubErrorStatus metadata.
 */
export async function getRepositoryInstallation(
  conn: GithubConnection,
  fullName: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GithubInstallation | null> {
  const app = requireAppConnection(conn);
  if (!isValidRepositoryFullName(fullName)) {
    throw new Error('Invalid GitHub repository');
  }
  const [owner, repo] = fullName.split('/') as [string, string];
  const jwt = await currentAppJwt(app);
  try {
    const response = await githubFetch(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      { headers: githubHeaders(`Bearer ${jwt}`) },
      fetchImpl,
    );
    return parseInstallation(await response.json());
  } catch (error) {
    if (githubErrorStatus(error) === 404) return null;
    throw error;
  }
}

export async function listInstallationRepos(
  conn: GithubConnection,
  installationId: number,
  opts: { q?: string; page?: number } = {},
  fetchImpl: FetchImpl = fetch,
): Promise<GithubRepositoryPage> {
  const app = requireAppConnection(conn);
  const firstPage = opts.page ?? 1;
  if (!Number.isInteger(firstPage) || firstPage < 1) {
    throw new Error('Invalid GitHub repository page');
  }
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new Error('Invalid GitHub installation id');
  }
  let appTotalCount: number | undefined;
  // Listing needs only repository metadata — never mint a broader token for
  // an admin-console enumeration than the endpoint requires.
  const { token } = await createInstallationToken(
    app,
    installationId,
    { permissions: { metadata: 'read' } },
    fetchImpl,
  );

  const repositories: GithubRepository[] = [];
  // A filtered search must reach past the first pages: the q filter applies
  // AFTER fetching, so a shallow cap would make repositories beyond it
  // unfindable even by exact name. Unfiltered listings stay shallow.
  const maxPages = opts.q?.trim() ? 10 : 3;
  let lastPageFull = false;
  for (let offset = 0; offset < maxPages; offset += 1) {
    const page = firstPage + offset;
    const query = new URLSearchParams({ per_page: '100', page: String(page) });
    const response = await githubFetch(
      `${GITHUB_API_BASE}/installation/repositories?${query.toString()}`,
      { headers: githubHeaders(`Bearer ${token}`) },
      fetchImpl,
    );
    const raw: unknown = await response.json();
    if (!isRecord(raw) || !Array.isArray(raw.repositories)) {
      throw new Error('GitHub installation repositories response was invalid');
    }
    const rawRepositories = raw.repositories;
    if (typeof raw.total_count === 'number' && Number.isFinite(raw.total_count)) {
      appTotalCount = raw.total_count;
    }
    repositories.push(...rawRepositories.map(parseRepository));
    lastPageFull = rawRepositories.length >= 100;
    if (rawRepositories.length < 100) break;
    if (appTotalCount !== undefined && repositories.length >= appTotalCount) {
      lastPageFull = false;
      break;
    }
  }

  const query = opts.q?.trim().toLowerCase();
  return {
    repositories: query
      ? repositories.filter((repository) => repository.fullName.toLowerCase().includes(query))
      : repositories,
    totalCount: appTotalCount ?? repositories.length,
    // Callers surface this so a repo beyond the cap reads as "not shown",
    // never as "does not exist".
    truncated: lastPageFull,
  };
}

export async function createInstallationToken(
  conn: GithubConnection,
  installationId: number,
  options: {
    repositories?: string[];
    permissions?: Record<string, string>;
  },
  fetchImpl: FetchImpl = fetch,
): Promise<{ token: string; expiresAt: string }> {
  const app = requireAppConnection(conn);
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new Error('Invalid GitHub installation id');
  }
  const jwt = await currentAppJwt(app);
  const response = await githubFetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: githubHeaders(`Bearer ${jwt}`, true),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(INSTALLATION_TOKEN_REQUEST_TIMEOUT_MS),
    },
    fetchImpl,
  );
  const raw: unknown = await response.json();
  if (!isRecord(raw) || typeof raw.token !== 'string' || typeof raw.expires_at !== 'string') {
    throw new Error('GitHub installation token response was invalid');
  }
  return { token: raw.token, expiresAt: raw.expires_at };
}

/**
 * Runtime-only token cache. Keeping it outside createInstallationToken avoids
 * reusing an admin enumeration token (minted with different permissions) for
 * an agent turn. Runtime callers always supply the fixed repository permission
 * cap; the cache key follows GitHub's repository down-scope, while an omitted
 * repository set intentionally collapses all installation-wide requests.
 */
export async function getCachedInstallationToken(
  conn: GithubConnection,
  installationId: number,
  options: {
    repositories?: string[];
    permissions?: Record<string, string>;
  },
  fetchImpl: FetchImpl = fetch,
): Promise<{ token: string; expiresAt: string }> {
  const app = requireAppConnection(conn);
  const nowMs = Date.now();
  for (const [key, entry] of installationTokenCache) {
    if (nowMs >= entry.validUntilMs) installationTokenCache.delete(key);
  }
  const cacheKey = installationTokenCacheKey(
    app.appId,
    installationId,
    options.repositories,
  );
  const cached = installationTokenCache.get(cacheKey);
  if (cached) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }

  const inflight = installationTokenInflight.get(cacheKey);
  if (inflight) return inflight;

  const mint = (async () => {
    const result = await createInstallationToken(app, installationId, options, fetchImpl);
    const expiresAtMs = Date.parse(result.expiresAt);
    const validUntilMs = expiresAtMs - INSTALLATION_TOKEN_EARLY_EXPIRY_MS;
    if (Number.isFinite(validUntilMs) && validUntilMs > Date.now()) {
      installationTokenCache.set(cacheKey, { ...result, validUntilMs });
    }
    return result;
  })();
  installationTokenInflight.set(cacheKey, mint);
  try {
    return await mint;
  } finally {
    if (installationTokenInflight.get(cacheKey) === mint) {
      installationTokenInflight.delete(cacheKey);
    }
  }
}

export async function exchangeGithubAppManifest(
  code: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GithubManifestConversion> {
  const response = await githubFetch(
    `${GITHUB_API_BASE}/app-manifests/${encodeURIComponent(code)}/conversions`,
    { method: 'POST', headers: githubHeaders() },
    fetchImpl,
  );
  const raw: unknown = await response.json();
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'number' ||
    !Number.isSafeInteger(raw.id) ||
    typeof raw.slug !== 'string' ||
    typeof raw.pem !== 'string'
  ) {
    throw new Error('GitHub App manifest conversion response was invalid');
  }
  // webhook_secret is null when the App has no webhook (localhost dev). Only
  // carry it through when GitHub actually returned one.
  return {
    id: raw.id,
    slug: raw.slug,
    privateKeyPem: raw.pem,
    ...(typeof raw.webhook_secret === 'string' ? { webhookSecret: raw.webhook_secret } : {}),
  };
}

function requireAppConnection(
  conn: GithubConnection,
): Extract<GithubConnection, { mode: 'app' }> {
  if (conn.mode !== 'app') {
    throw new Error('GitHub App is not configured');
  }
  return conn;
}

function installationTokenCacheKey(
  appId: string,
  installationId: number,
  repositories: string[] | undefined,
): string {
  const repositorySet =
    repositories === undefined ? null : [...new Set(repositories)].sort();
  return JSON.stringify(['app', appId, installationId, repositorySet]);
}

async function currentAppJwt(
  conn: Extract<GithubConnection, { mode: 'app' }>,
): Promise<string> {
  return mintAppJwt({
    appId: conn.appId,
    privateKeyPem: conn.privateKeyPem,
    nowSec: Math.floor(Date.now() / 1_000),
  });
}

async function githubFetch(
  url: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
): Promise<Response> {
  // Every GitHub call gets a deadline: a stalled response must not leave the
  // admin status, picker, or setup callback pending indefinitely.
  const signal =
    init.signal ??
    (typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(INSTALLATION_TOKEN_REQUEST_TIMEOUT_MS)
      : undefined);
  const response = await fetchImpl(url, { ...init, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error: Error & { status?: number; rateLimited?: boolean } = new Error(
      `GitHub API request failed with status ${response.status}`,
    );
    // Carried so callers can distinguish a validation rejection (422 — e.g. a
    // stale repository name) from outages they must not retry-amplify.
    error.status = response.status;
    error.rateLimited =
      response.status === 429 ||
      response.headers.get('retry-after') !== null ||
      response.headers.get('x-ratelimit-remaining') === '0';
    throw error;
  }
  return response;
}

export function githubErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function githubErrorIsRateLimited(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { rateLimited?: unknown }).rateLimited === true;
}

function githubHeaders(authorization?: string, json = false): Headers {
  const headers = new Headers(GITHUB_HEADERS);
  if (authorization) headers.set('Authorization', authorization);
  if (json) headers.set('Content-Type', 'application/json');
  return headers;
}

function parseInstallation(raw: unknown): GithubInstallation {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'number' ||
    !Number.isSafeInteger(raw.id) ||
    !isRecord(raw.account) ||
    typeof raw.account.login !== 'string' ||
    typeof raw.account.type !== 'string'
  ) {
    throw new Error('GitHub installation response entry was invalid');
  }
  return {
    id: raw.id,
    accountLogin: raw.account.login,
    accountType: raw.account.type,
  };
}

function parseRepository(raw: unknown): GithubRepository {
  if (
    !isRecord(raw) ||
    typeof raw.full_name !== 'string' ||
    typeof raw.private !== 'boolean' ||
    typeof raw.default_branch !== 'string'
  ) {
    throw new Error('GitHub repository response entry was invalid');
  }
  return {
    fullName: raw.full_name,
    private: raw.private,
    defaultBranch: raw.default_branch,
  };
}

function pemBody(pem: string, label: string): Uint8Array | null {
  const match = pem.match(
    new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`),
  );
  if (!match?.[1]) return null;
  const base64 = match[1].replace(/\s+/g, '');
  if (!base64) return null;
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const algorithm = derSequence(
    Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01),
    Uint8Array.of(0x05, 0x00),
  );
  const privateKey = concatBytes(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  return derSequence(version, algorithm, privateKey);
}

function derSequence(...parts: Uint8Array[]): Uint8Array {
  const body = concatBytes(...parts);
  return concatBytes(Uint8Array.of(0x30), derLength(body.length), body);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function armorPem(label: string, bytes: Uint8Array): string {
  const base64 = base64Bytes(bytes);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function base64UrlJson(value: object): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
