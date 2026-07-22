import type { SettingsStore } from './settings-store.ts';

export const GITHUB_API_BASE = 'https://api.github.com';

export const GITHUB_SETTING_KEYS = {
  appId: 'github.app.id',
  appSlug: 'github.app.slug',
  privateKey: 'github.app.private_key',
  webhookSecret: 'github.app.webhook_secret',
  pat: 'github.pat',
} as const;

export type GithubConnection =
  | { mode: 'none' }
  | { mode: 'pat'; pat: string }
  | {
      mode: 'app';
      appId: string;
      appSlug?: string;
      privateKeyPem: string;
    };

export interface GithubInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
}

export interface GithubRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GithubRepositoryPage {
  repositories: GithubRepository[];
  totalCount: number;
}

export interface GithubManifestConversion {
  id: number;
  slug: string;
  privateKeyPem: string;
  webhookSecret: string;
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
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

export async function getGithubConnection(settings: SettingsStore): Promise<GithubConnection> {
  const [storedAppId, storedAppSlug, storedPrivateKey, storedPat] = await settings.getSettings([
    GITHUB_SETTING_KEYS.appId,
    GITHUB_SETTING_KEYS.appSlug,
    GITHUB_SETTING_KEYS.privateKey,
    GITHUB_SETTING_KEYS.pat,
  ]);
  const appId = nonEmpty(process.env.GITHUB_APP_ID) ?? nonEmpty(storedAppId);
  const privateKey =
    nonEmpty(process.env.GITHUB_APP_PRIVATE_KEY) ?? nonEmpty(storedPrivateKey);
  if (appId && privateKey) {
    const appSlug = nonEmpty(storedAppSlug);
    return {
      mode: 'app',
      appId,
      ...(appSlug ? { appSlug } : {}),
      privateKeyPem: normalizePrivateKeyPem(privateKey),
    };
  }
  const pat = nonEmpty(process.env.GITHUB_PAT) ?? nonEmpty(storedPat);
  return pat ? { mode: 'pat', pat } : { mode: 'none' };
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

export async function listInstallationRepos(
  conn: GithubConnection,
  installationId: number | null,
  opts: { q?: string; page?: number } = {},
  fetchImpl: FetchImpl = fetch,
): Promise<GithubRepositoryPage> {
  const firstPage = opts.page ?? 1;
  if (!Number.isInteger(firstPage) || firstPage < 1) {
    throw new Error('Invalid GitHub repository page');
  }

  let authorization: string;
  let path: string;
  let appTotalCount: number | undefined;
  if (conn.mode === 'app') {
    if (installationId === null || !Number.isSafeInteger(installationId) || installationId < 1) {
      throw new Error('Invalid GitHub installation id');
    }
    // Listing needs only repository metadata — never mint a broader token for
    // an admin-console enumeration than the endpoint requires.
    const { token } = await createInstallationToken(
      conn,
      installationId,
      { permissions: { metadata: 'read' } },
      fetchImpl,
    );
    authorization = `Bearer ${token}`;
    path = '/installation/repositories';
  } else if (conn.mode === 'pat') {
    authorization = `Bearer ${conn.pat}`;
    path = '/user/repos';
  } else {
    throw new Error('GitHub is not configured');
  }

  const repositories: GithubRepository[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const page = firstPage + offset;
    const query = new URLSearchParams({ per_page: '100', page: String(page) });
    if (conn.mode === 'pat') {
      query.set('affiliation', 'owner,collaborator,organization_member');
    }
    const response = await githubFetch(
      `${GITHUB_API_BASE}${path}?${query.toString()}`,
      { headers: githubHeaders(authorization) },
      fetchImpl,
    );
    const raw: unknown = await response.json();
    let rawRepositories: unknown[];
    if (conn.mode === 'app') {
      if (!isRecord(raw) || !Array.isArray(raw.repositories)) {
        throw new Error('GitHub installation repositories response was invalid');
      }
      rawRepositories = raw.repositories;
      if (typeof raw.total_count === 'number' && Number.isFinite(raw.total_count)) {
        appTotalCount = raw.total_count;
      }
    } else {
      if (!Array.isArray(raw)) {
        throw new Error('GitHub user repositories response was invalid');
      }
      rawRepositories = raw;
    }
    repositories.push(...rawRepositories.map(parseRepository));
    if (rawRepositories.length < 100) break;
    if (appTotalCount !== undefined && repositories.length >= appTotalCount) break;
  }

  const query = opts.q?.trim().toLowerCase();
  return {
    repositories: query
      ? repositories.filter((repository) => repository.fullName.toLowerCase().includes(query))
      : repositories,
    totalCount: appTotalCount ?? repositories.length,
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
 * cap; the cache key intentionally follows GitHub's repository down-scope.
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
  const nowMs = Date.now();
  for (const [key, entry] of installationTokenCache) {
    if (nowMs >= entry.validUntilMs) installationTokenCache.delete(key);
  }
  const cacheKey = installationTokenCacheKey(installationId, options.repositories);
  const cached = installationTokenCache.get(cacheKey);
  if (cached) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }

  const result = await createInstallationToken(conn, installationId, options, fetchImpl);
  const expiresAtMs = Date.parse(result.expiresAt);
  const validUntilMs = expiresAtMs - INSTALLATION_TOKEN_EARLY_EXPIRY_MS;
  if (Number.isFinite(validUntilMs) && validUntilMs > Date.now()) {
    installationTokenCache.set(cacheKey, { ...result, validUntilMs });
  }
  return result;
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
    typeof raw.pem !== 'string' ||
    typeof raw.webhook_secret !== 'string'
  ) {
    throw new Error('GitHub App manifest conversion response was invalid');
  }
  return {
    id: raw.id,
    slug: raw.slug,
    privateKeyPem: raw.pem,
    webhookSecret: raw.webhook_secret,
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
  installationId: number,
  repositories: string[] | undefined,
): string {
  const repositorySet =
    repositories === undefined ? '*' : [...new Set(repositories)].sort().join('\u0000');
  return `${installationId}:${repositorySet}`;
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
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}`);
  }
  return response;
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
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  return base64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
