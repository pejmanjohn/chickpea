import { createHash } from 'node:crypto';

import type { SettingsStore } from '../config/settings-store.ts';
import {
  getSettingsStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { readSlackIdentityProfile } from './identity-profile.ts';
import {
  invalidateSlackIdentityCredentialCache,
  readActiveSlackCredentialMetadata,
  resolveSlackIdentityCredentials,
  type SlackCredentialResolutionDependencies,
} from './identity-credentials.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import { parseSlackGrantedScopes } from './scopes.ts';

/**
 * Slack credential resolution is backed by one complete encrypted TAG_STATE
 * revision. Environment Slack credentials are never an execution source.
 */

/** Settings-store keys the wizard writes. One place, both sides agree. */
type RemovedSlackSettingKeys = {
  /** @deprecated Team identity is canonical public revision metadata. */
  readonly teamId: never;
  /** @deprecated Token fingerprints were an env-fallback consistency shim. */
  readonly teamTokenFingerprint: never;
  /** @deprecated Removed in U2; no runtime setting exists. */
  readonly connectionRevision: never;
  /** @deprecated Removed in U2; no runtime setting exists. */
  readonly botToken: never;
  /** @deprecated Removed in U2; no runtime setting exists. */
  readonly signingSecret: never;
  /** @deprecated Removed in U2; no runtime setting exists. */
  readonly botUserId: never;
};

export const SLACK_SETTING_KEYS = ({
  // Human-friendly presentation metadata only. The authoritative team ID is
  // public metadata on the active encrypted credential revision.
  teamName: 'slack.teamName',
  // The public origin (scheme+host, no trailing slash) the admin resolves for
  // this install — persisted so reply footers / onboarding can build the
  // "Configure" deep link on a button deploy where SLACK_TAG_PUBLIC_URL is
  // unset. Environment (SLACK_TAG_PUBLIC_URL) still wins at resolution time.
  publicUrl: 'slack.publicUrl',
} as const) as {
  readonly teamName: 'slack.teamName';
  readonly publicUrl: 'slack.publicUrl';
} & RemovedSlackSettingKeys;

/** @deprecated U2 removed token-fingerprint persistence with env fallback. */
export function slackTokenFingerprint(botToken: string): string {
  return createHash('sha256').update(botToken).digest('hex').slice(0, 16);
}

export interface ResolvedSlackCredentials {
  botToken: string | undefined;
  signingSecret: string | undefined;
  /**
   * Configured bot user id. `undefined` means the active encrypted revision did
   * not record one, so the channel may resolve it through `auth.test`.
   */
  botUserId: string | undefined;
}

export type SlackCredentialSource = 'stored' | 'missing';

/** Per-credential provenance for the /admin connection card. */
export interface SlackCredentialSources {
  botToken: SlackCredentialSource;
  signingSecret: SlackCredentialSource;
  botUserId: SlackCredentialSource;
}

const STORED_CACHE_TTL_MS = 60_000;

interface StoredSlackCredentials {
  botToken: string | undefined;
  signingSecret: string | undefined;
  botUserId: string | undefined;
}

type SlackConnectionRevision = string | null;

// An empty-string token/secret is never a usable credential.
function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

export async function resolveSlackCredentials(
  env?: PlatformEnv,
  store?: SettingsStore,
  credentialDependencies?: SlackCredentialResolutionDependencies,
): Promise<ResolvedSlackCredentials> {
  const resolved = await resolveSlackIdentityCredentials(
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    env,
    credentialDependencies ?? store,
  );
  return {
    botToken: resolved.botToken,
    signingSecret: resolved.signingSecret,
    botUserId: resolved.botUserId,
  };
}

/** Provenance of each credential, for the /admin Slack-connection card. */
export async function describeSlackCredentialSources(
  env?: PlatformEnv,
  store?: SettingsStore,
  credentialDependencies?: SlackCredentialResolutionDependencies,
): Promise<SlackCredentialSources> {
  const resolved = await resolveSlackIdentityCredentials(
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    env,
    credentialDependencies ?? store,
  );
  const source: SlackCredentialSource = resolved.connectionRevision
    ? 'stored'
    : 'missing';
  return {
    botToken: resolved.botToken ? source : 'missing',
    signingSecret: resolved.signingSecret ? source : 'missing',
    botUserId: resolved.botUserId !== undefined ? source : 'missing',
  };
}

/**
 * Prime the cache with just-saved values so the isolate that served the
 * wizard save resolves them immediately — the very next signed event must
 * verify with the stored secret, not wait out a stale-cache TTL.
 */
export function primeStoredSlackCredentials(
  values: StoredSlackCredentials,
  revision: SlackConnectionRevision = null,
): void {
  // Retained only as a source-compatible no-op for pre-U2 test harnesses.
  // Promotion primes the encrypted revision cache inside identity-credentials.
  void values;
  void revision;
}

/** Drop the cached stored triple (tests; never needed in production flow). */
export function invalidateStoredSlackCredentials(): void {
  invalidateSlackIdentityCredentialCache();
}

/** Clone-safe revision value used by connection compare-and-swap writes. */
export async function readSlackConnectionRevision(
  store: SettingsStore,
  credentialDependencies?: SlackCredentialResolutionDependencies,
): Promise<SlackConnectionRevision> {
  return (await resolveSlackIdentityCredentials(
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    undefined,
    credentialDependencies ?? store,
  )).connectionRevision;
}

// --- Public URL resolution (env > stored) -----------------------------------
//
// The "Configure" reply-footer / onboarding deep link needs the install's own
// public origin. On a Node deploy the operator usually sets SLACK_TAG_PUBLIC_URL;
// on a Cloudflare button deploy nobody does, so the admin persists the origin it
// resolved for the manifest link (slack.publicUrl) and this resolver reads it as
// the fallback. Env still wins outright. Cached briefly per isolate like the
// cred resolver so the events hot path pays no store read per turn.

let publicUrlCache: { expiresAt: number; value: string | undefined } | undefined;

function envPublicUrl(): string | undefined {
  const raw = process.env.SLACK_TAG_PUBLIC_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : undefined;
}

/**
 * Resolve the install's public origin: `SLACK_TAG_PUBLIC_URL` (env) → stored
 * `slack.publicUrl` → undefined. An explicit `store` bypasses the cache (tests);
 * otherwise the stored read is cached for the TTL. Env is never cached — a
 * process env is already a cheap read and must reflect changes immediately.
 */
export async function resolveSlackPublicUrl(
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<string | undefined> {
  const fromEnv = envPublicUrl();
  if (fromEnv) {
    return fromEnv;
  }
  const now = Date.now();
  if (!store && publicUrlCache && publicUrlCache.expiresAt > now) {
    return publicUrlCache.value;
  }
  const settings = store ?? getSettingsStore(env);
  const stored = await settings.getSetting(SLACK_SETTING_KEYS.publicUrl);
  const value = stored ? stored.replace(/\/+$/, '') : undefined;
  if (!store) {
    publicUrlCache = { expiresAt: now + STORED_CACHE_TTL_MS, value };
  }
  return value;
}

/** Prime the public-URL cache so the isolate that stored it resolves it now. */
export function primeStoredSlackPublicUrl(value: string | undefined): void {
  publicUrlCache = {
    expiresAt: Date.now() + STORED_CACHE_TTL_MS,
    value: value ? value.replace(/\/+$/, '') : undefined,
  };
}

/** Drop the cached public URL (tests; never needed in production flow). */
export function invalidateStoredSlackPublicUrl(): void {
  publicUrlCache = undefined;
}

export interface SlackAuthTestResult {
  ok: boolean;
  /** Slack's machine error code when ok is false (e.g. 'invalid_auth'). */
  error: string | undefined;
  /** Slack-provided retry delay for bounded truth reads, when available. */
  retryAfterMs?: number;
  /** Slack app id for deep-linking install-wide identity settings. */
  appId?: string;
  teamId: string | undefined;
  teamName: string | undefined;
  botName: string | undefined;
  botUserId: string | undefined;
  /** Present for bot installations; dedicated identities reject user tokens. */
  botId?: string;
  /** Slack's live grants from the `x-oauth-scopes` response header. */
  grantedScopes?: string[];
}

/**
 * The Slack Web API base, honoring the `SLACK_API_URL` override the WebClient
 * also respects so every raw call here targets the same (fake, offline) Slack
 * the rest of the app does. Trailing slashes trimmed for clean `${base}/method`
 * joins.
 */
function slackApiBase(): string {
  return (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/+$/, '');
}

/**
 * Live-validate a pasted bot token via `auth.test`. A raw fetch on purpose: the
 * wizard must not disturb the channel's cached WebClient, and needs nothing but
 * this one method. Network failures throw — the caller maps them to a retriable
 * "Slack unreachable" response, distinct from Slack rejecting the token. The
 * plain global `fetch` (no receiver, no `redirect: 'error'`) is what the two
 * workerd fetch quirks solved in `createSlackWebClient` require, so this runs
 * unmodified on the Cloudflare target.
 */
export async function slackAuthTest(botToken: string): Promise<SlackAuthTestResult> {
  const response = await fetch(`${slackApiBase()}/auth.test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken}` },
  });
  const body = (await response.json()) as Record<string, unknown>;
  return parseSlackAuthTest(
    body,
    parseSlackGrantedScopes(response.headers.get('x-oauth-scopes')),
  );
}

function parseSlackAuthTest(
  body: Record<string, unknown>,
  grantedScopes: string[] | undefined = undefined,
): SlackAuthTestResult {
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    ...(typeof body.app_id === 'string' ? { appId: body.app_id } : {}),
    teamId: typeof body.team_id === 'string' ? body.team_id : undefined,
    teamName: typeof body.team === 'string' ? body.team : undefined,
    botName: typeof body.user === 'string' ? body.user : undefined,
    botUserId: typeof body.user_id === 'string' ? body.user_id : undefined,
    ...(typeof body.bot_id === 'string' ? { botId: body.bot_id } : {}),
    ...(grantedScopes === undefined ? {} : { grantedScopes }),
  };
}

export interface SlackBotIdentityResult {
  ok: boolean;
  error: string | undefined;
  displayName: string | undefined;
  avatarUrl: string | undefined;
  appId: string | undefined;
}

/**
 * Read the Slack-owned bot profile shown beside messages. This stays separate
 * from SlackUserFacts: memory authorization only needs classification facts,
 * while the admin identity card needs presentation fields that must never
 * influence trust decisions.
 */
export async function slackBotIdentityInfo(
  botToken: string,
  userId: string,
  options: SlackTruthFetchOptions = {},
): Promise<SlackBotIdentityResult> {
  const result = await fetchSlackTruthJson(`${slackApiBase()}/users.info`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ user: userId }).toString(),
  }, options);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      displayName: undefined,
      avatarUrl: undefined,
      appId: undefined,
    };
  }
  const body = result.body;
  const profile = readSlackIdentityProfile(body.user);
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    appId: profile.appId,
  };
}

/** Bounded auth.test for the identity card's best-effort live refresh path. */
export async function slackIdentityAuthTest(
  botToken: string,
  options: SlackTruthFetchOptions = {},
): Promise<SlackAuthTestResult> {
  const result = await fetchSlackTruthJson(`${slackApiBase()}/auth.test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken}` },
  }, options);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      teamId: undefined,
      teamName: undefined,
      botName: undefined,
      botUserId: undefined,
    };
  }
  return {
    ...parseSlackAuthTest(result.body, result.grantedScopes),
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  };
}

/** One Slack channel, mapped to the admin-facing shape the proxy returns. */
export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export interface SlackConversationFacts {
  id: string;
  name: string;
  im?: boolean;
  mpim?: boolean;
  private: boolean;
  archived: boolean;
  frozen: boolean;
  shared: boolean;
  externallyShared: boolean;
  organizationShared: boolean;
  pendingShared: boolean;
  member: boolean;
  teamId: string | undefined;
}

export interface SlackUserFacts {
  id: string;
  teamId: string | undefined;
  timezone?: string | undefined;
  deleted: boolean;
  bot: boolean;
  appUser: boolean;
  restricted: boolean;
  ultraRestricted: boolean;
  stranger: boolean;
}

/** Map a raw Slack conversation object to the admin summary shape. */
function toChannelSummary(raw: unknown): SlackChannelSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const channel = raw as Record<string, unknown>;
  if (typeof channel.id !== 'string') return null;
  return {
    id: channel.id,
    name: typeof channel.name === 'string' ? channel.name : '',
    isPrivate: channel.is_private === true,
    isMember: channel.is_member === true,
  };
}

function toConversationFacts(raw: unknown): SlackConversationFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const channel = raw as Record<string, unknown>;
  if (typeof channel.id !== 'string') return null;
  return {
    id: channel.id,
    name: typeof channel.name === 'string' ? channel.name : '',
    im: channel.is_im === true,
    mpim: channel.is_mpim === true,
    private: channel.is_private === true,
    archived: channel.is_archived === true,
    frozen: channel.is_frozen === true,
    shared: channel.is_shared === true,
    externallyShared: channel.is_ext_shared === true,
    organizationShared: channel.is_org_shared === true,
    pendingShared: Array.isArray(channel.pending_shared) && channel.pending_shared.length > 0,
    member: channel.is_member === true,
    teamId:
      typeof channel.context_team_id === 'string'
        ? channel.context_team_id
        : typeof channel.team_id === 'string'
          ? channel.team_id
          : undefined,
  };
}

function toUserFacts(raw: unknown): SlackUserFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const user = raw as Record<string, unknown>;
  if (typeof user.id !== 'string') return null;
  return {
    id: user.id,
    teamId: typeof user.team_id === 'string' ? user.team_id : undefined,
    timezone: typeof user.tz === 'string' ? user.tz : undefined,
    deleted: user.deleted === true,
    bot: user.is_bot === true,
    appUser: user.is_app_user === true,
    restricted: user.is_restricted === true,
    ultraRestricted: user.is_ultra_restricted === true,
    stranger: user.is_stranger === true,
  };
}

/** `response_metadata.next_cursor`, treating Slack's empty-string cursor as done. */
function readNextCursor(body: Record<string, unknown>): string | undefined {
  const meta = body.response_metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const cursor = (meta as Record<string, unknown>).next_cursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

export interface SlackConversationsListPage {
  ok: boolean;
  error: string | undefined;
  channels: SlackChannelSummary[];
  nextCursor: string | undefined;
}

/**
 * One page of `conversations.list` (public + private, non-archived). A raw
 * fetch like `slackAuthTest`, so the WebClient cache is never disturbed and the
 * call runs unchanged on workerd. Pagination is the caller's job (channels.ts).
 */
export async function slackConversationsList(
  botToken: string,
  options: { cursor?: string; limit?: number; timeoutMs?: number } = {},
): Promise<SlackConversationsListPage> {
  const params = new URLSearchParams({
    types: 'public_channel,private_channel',
    exclude_archived: 'true',
    limit: String(options.limit ?? 200),
  });
  if (options.cursor) params.set('cursor', options.cursor);
  const result = await fetchSlackTruthJson(`${slackApiBase()}/conversations.list`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  }, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      channels: [],
      nextCursor: undefined,
    };
  }
  const body = result.body;
  const rawChannels = Array.isArray(body.channels) ? body.channels : [];
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    channels: rawChannels
      .map(toChannelSummary)
      .filter((channel): channel is SlackChannelSummary => channel !== null),
    nextCursor: readNextCursor(body),
  };
}

export interface SlackConversationsInfoResult {
  ok: boolean;
  error: string | undefined;
  channel: SlackChannelSummary | undefined;
  facts: SlackConversationFacts | undefined;
  retryAfterMs: number | undefined;
}

export interface SlackTruthFetchOptions {
  timeoutMs?: number;
}

/**
 * Slack API failures that describe a temporary transport or service problem.
 * Keep this policy beside the raw Slack fetch boundary so setup validation and
 * runtime identity execution cannot drift into different retry semantics.
 */
export function isTransientSlackApiError(error: string | undefined): boolean {
  return error === 'ratelimited' ||
    error === 'slack_request_timeout' ||
    error === 'slack_network_error' ||
    error === 'slack_non_json_response' ||
    error === 'internal_error' ||
    error === 'fatal_error' ||
    error === 'service_unavailable' ||
    error === 'request_timeout' ||
    /^slack_http_5\d\d$/.test(error ?? '');
}

const SLACK_TRUTH_FETCH_TIMEOUT_MS = 5_000;

interface SlackTruthJsonResult {
  ok: boolean;
  body: Record<string, unknown>;
  error: string | undefined;
  retryAfterMs: number | undefined;
  grantedScopes?: string[];
}

type DeadlineResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

/**
 * Bound raw Slack authorization reads across both fetch and body consumption.
 * Every failure becomes a typed result so memory can quarantine instead of
 * hanging a turn or throwing an unclassified JSON/network error.
 */
async function fetchSlackTruthJson(
  url: string,
  init: RequestInit,
  options: SlackTruthFetchOptions = {},
): Promise<SlackTruthJsonResult> {
  const timeoutMs = options.timeoutMs ?? SLACK_TRUTH_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  // AbortSignal.timeout() is deliberately unref'ed on Node. A never-resolving
  // fetch can therefore let an otherwise-idle process exit before the deadline
  // fires. Own a referenced timer so the timeout is an actual runtime bound on
  // every supported target, not just while unrelated handles stay alive.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = controller.signal;
  try {
    const responseResult = await settleBeforeDeadline(
      Promise.resolve().then(() => globalThis.fetch(url, { ...init, signal: deadline })),
      deadline,
    );
    if (responseResult.kind === 'timeout') return slackTruthFailure('slack_request_timeout');
    if (responseResult.kind === 'error') {
      return slackTruthFailure(
        deadline.aborted || isAbortError(responseResult.error)
          ? 'slack_request_timeout'
          : 'slack_network_error',
      );
    }

    const response = responseResult.value;
    const retryAfter = retryAfterMs(response);
    const bodyResult = await settleBeforeDeadline(
      Promise.resolve().then(() => response.json()),
      deadline,
    );
    if (bodyResult.kind === 'timeout') {
      return slackTruthFailure('slack_request_timeout', retryAfter);
    }
    if (
      bodyResult.kind === 'error' ||
      !bodyResult.value ||
      typeof bodyResult.value !== 'object' ||
      Array.isArray(bodyResult.value)
    ) {
      return slackTruthFailure('slack_non_json_response', retryAfter);
    }
    const body = bodyResult.value as Record<string, unknown>;
    if (response.status === 429) {
      return slackTruthFailure(
        typeof body.error === 'string' ? body.error : 'ratelimited',
        retryAfter,
      );
    }
    if (!response.ok) {
      return slackTruthFailure(
        typeof body.error === 'string' ? body.error : `slack_http_${response.status}`,
        retryAfter,
      );
    }
    const grantedScopes = parseSlackGrantedScopes(
      response.headers.get('x-oauth-scopes'),
    );
    return {
      ok: true,
      body,
      error: undefined,
      retryAfterMs: retryAfter,
      ...(grantedScopes === undefined ? {} : { grantedScopes }),
    };
  } finally {
    clearTimeout(timer);
  }
}

function settleBeforeDeadline<T>(
  pending: Promise<T>,
  deadline: AbortSignal,
): Promise<DeadlineResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DeadlineResult<T>): void => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: 'timeout' });
    if (deadline.aborted) {
      finish({ kind: 'timeout' });
      return;
    }
    deadline.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

function slackTruthFailure(
  error: string,
  retryAfter: number | undefined = undefined,
): SlackTruthJsonResult {
  return { ok: false, body: {}, error, retryAfterMs: retryAfter };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * `conversations.info` for one channel id — used to VERIFY an assignment's
 * channel really exists in the connected workspace (and to read its
 * authoritative name + membership). Raw fetch, workerd-safe, same as above.
 */
export async function slackConversationsInfo(
  botToken: string,
  channelId: string,
  options: SlackTruthFetchOptions = {},
): Promise<SlackConversationsInfoResult> {
  const result = await fetchSlackTruthJson(`${slackApiBase()}/conversations.info`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ channel: channelId }).toString(),
  }, options);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      channel: undefined,
      facts: undefined,
      retryAfterMs: result.retryAfterMs,
    };
  }
  const body = result.body;
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    channel: toChannelSummary(body.channel) ?? undefined,
    facts: toConversationFacts(body.channel) ?? undefined,
    retryAfterMs: result.retryAfterMs,
  };
}

export interface SlackUsersInfoResult {
  ok: boolean;
  error: string | undefined;
  user: SlackUserFacts | undefined;
  retryAfterMs: number | undefined;
}

export async function slackUsersInfo(
  botToken: string,
  userId: string,
  options: SlackTruthFetchOptions = {},
): Promise<SlackUsersInfoResult> {
  const result = await fetchSlackTruthJson(`${slackApiBase()}/users.info`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ user: userId }).toString(),
  }, options);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      user: undefined,
      retryAfterMs: result.retryAfterMs,
    };
  }
  const body = result.body;
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    user: toUserFacts(body.user) ?? undefined,
    retryAfterMs: result.retryAfterMs,
  };
}

export interface SlackUsersListPage {
  ok: boolean;
  error: string | undefined;
  users: SlackUserFacts[];
  nextCursor: string | undefined;
  retryAfterMs: number | undefined;
}

export async function slackUsersList(
  botToken: string,
  options: { cursor?: string; limit?: number; timeoutMs?: number } = {},
): Promise<SlackUsersListPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 200) });
  if (options.cursor) params.set('cursor', options.cursor);
  const result = await fetchSlackTruthJson(`${slackApiBase()}/users.list`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  }, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      users: [],
      nextCursor: undefined,
      retryAfterMs: result.retryAfterMs,
    };
  }
  const body = result.body;
  const rawUsers = Array.isArray(body.members) ? body.members : [];
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    users: rawUsers.map(toUserFacts).filter((user): user is SlackUserFacts => user !== null),
    nextCursor: readNextCursor(body),
    retryAfterMs: result.retryAfterMs,
  };
}

export interface SlackConversationsMembersPage {
  ok: boolean;
  error: string | undefined;
  memberIds: string[];
  nextCursor: string | undefined;
  retryAfterMs: number | undefined;
}

export async function slackConversationsMembers(
  botToken: string,
  channelId: string,
  options: { cursor?: string; limit?: number; timeoutMs?: number } = {},
): Promise<SlackConversationsMembersPage> {
  const params = new URLSearchParams({
    channel: channelId,
    limit: String(options.limit ?? 200),
  });
  if (options.cursor) params.set('cursor', options.cursor);
  const result = await fetchSlackTruthJson(`${slackApiBase()}/conversations.members`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  }, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      memberIds: [],
      nextCursor: undefined,
      retryAfterMs: result.retryAfterMs,
    };
  }
  const body = result.body;
  const members = Array.isArray(body.members)
    ? body.members.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    memberIds: members,
    nextCursor: readNextCursor(body),
    retryAfterMs: result.retryAfterMs,
  };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

export interface SlackConversationsJoinResult {
  ok: boolean;
  error: string | undefined;
}

/**
 * `conversations.join` — the bot self-joins a PUBLIC channel (needs the
 * `channels:join` bot scope). Slack cannot self-join a PRIVATE channel; a human
 * must invite it, so the caller only reaches here for public not-member
 * channels. Raw fetch, workerd-safe, honoring `SLACK_API_URL` like the others.
 * The caller treats any `ok:false` (notably `missing_scope` on installs that
 * predate the scope) as "could not join" and falls back to the invite reminder.
 */
export async function slackConversationsJoin(
  botToken: string,
  channelId: string,
): Promise<SlackConversationsJoinResult> {
  const response = await fetch(`${slackApiBase()}/conversations.join`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ channel: channelId }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
  };
}

export interface SlackTeamInfo {
  teamId: string | undefined;
  teamName: string | undefined;
}

/**
 * The connected workspace identity as STORED (no network). The admin
 * connection card reads this to name the workspace; it stays empty for installs
 * created before team persistence until a backfill (below) populates it.
 */
export async function readStoredSlackTeamInfo(
  env?: PlatformEnv,
  store?: SettingsStore,
  credentialDependencies?: SlackCredentialResolutionDependencies,
): Promise<SlackTeamInfo> {
  const settings = store ?? getSettingsStore(env);
  const [active, teamName] = await Promise.all([
    readActiveSlackCredentialMetadata(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      env,
      credentialDependencies ?? store,
    ),
    settings.getSetting(SLACK_SETTING_KEYS.teamName),
  ]);
  return {
    teamId: active?.purpose === 'connected_credentials'
      ? active.teamId ?? undefined
      : undefined,
    teamName: nonEmpty(teamName),
  };
}

/**
 * The connected workspace identity from canonical public revision metadata.
 * No token fingerprint or network backfill is needed because the team ID and
 * encrypted bot grant are promoted in the same compare-and-set revision.
 */
export async function resolveSlackTeamInfo(
  env?: PlatformEnv,
  store?: SettingsStore,
  credentialDependencies?: SlackCredentialResolutionDependencies,
): Promise<SlackTeamInfo> {
  return readStoredSlackTeamInfo(env, store, credentialDependencies);
}
