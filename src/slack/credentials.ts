import { createHash } from 'node:crypto';

import type { SettingsStore } from '../config/settings-store.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';

/**
 * Slack credential resolution: environment first, then the operator settings
 * store (written by the /admin Slack-connection wizard), so a `wrangler secret
 * put` / .env value always beats a browser-configured one. This is what lets
 * the app boot and serve /admin with NO Slack credentials anywhere — the
 * events route resolves per request and fails closed (401) until the wizard
 * (or the environment) provides a signing secret, instead of crashing at
 * channel construction like a module-scope `process.env.SLACK_SIGNING_SECRET!`
 * read would.
 *
 * The stored triple is cached for ~60s per isolate: the events hot path must
 * not pay a settings read (a Durable Object round-trip on Cloudflare) per
 * event, while a wizard save still propagates quickly to other isolates and
 * IMMEDIATELY in its own (the save primes this cache).
 */

/** Settings-store keys the wizard writes. One place, both sides agree. */
export const SLACK_SETTING_KEYS = {
  botToken: 'slack.botToken',
  signingSecret: 'slack.signingSecret',
  botUserId: 'slack.botUserId',
  // The connected workspace identity, persisted from auth.test so the admin can
  // (a) show which workspace this install is bound to and (b) reject a channel
  // assignment whose workspace id does not match the connected one.
  teamId: 'slack.teamId',
  teamName: 'slack.teamName',
  // Fingerprint of the bot token that produced the stored team identity.
  // Credential resolution is env-first, so an operator can repoint the install
  // at a DIFFERENT workspace just by setting SLACK_BOT_TOKEN — the stored team
  // id must not outlive the token that earned it, or the workspace-mismatch
  // guard validates against the wrong workspace.
  teamTokenFingerprint: 'slack.teamTokenFingerprint',
  // The public origin (scheme+host, no trailing slash) the admin resolves for
  // this install — persisted so reply footers / onboarding can build the
  // "Configure" deep link on a button deploy where SLACK_TAG_PUBLIC_URL is
  // unset. Environment (SLACK_TAG_PUBLIC_URL) still wins at resolution time.
  publicUrl: 'slack.publicUrl',
} as const;

/** Non-reversible identifier for "which bot token produced this team info". */
export function slackTokenFingerprint(botToken: string): string {
  return createHash('sha256').update(botToken).digest('hex').slice(0, 16);
}

export interface ResolvedSlackCredentials {
  botToken: string | undefined;
  signingSecret: string | undefined;
  /**
   * Configured bot user id. `''` is meaningful: an env `SLACK_BOT_USER_ID=`
   * explicitly set to empty means "no bot user id, do not probe auth.test"
   * (the fail-closed knob, S14). `undefined` means unconfigured everywhere —
   * the channel may then resolve one via auth.test.
   */
  botUserId: string | undefined;
}

export type SlackCredentialSource = 'env' | 'stored' | 'missing';

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

let storedCache: { expiresAt: number; values: StoredSlackCredentials } | undefined;

// An empty-string token/secret is never a usable credential — treat it as
// unset so a blank .env line does not shadow a wizard-stored value.
function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function envCredentials(): ResolvedSlackCredentials {
  return {
    botToken: nonEmpty(process.env.SLACK_BOT_TOKEN),
    signingSecret: nonEmpty(process.env.SLACK_SIGNING_SECRET),
    // Deliberately NOT nonEmpty: defined-but-empty is the explicit
    // "no bot user id" operator choice (see ResolvedSlackCredentials).
    botUserId: process.env.SLACK_BOT_USER_ID,
  };
}

function fullyEnvConfigured(env: ResolvedSlackCredentials): boolean {
  return Boolean(env.botToken) && Boolean(env.signingSecret) && env.botUserId !== undefined;
}

/**
 * Read the wizard-stored triple. An explicit `store` bypasses the cache (the
 * admin card wants fresh provenance and tests want injection); the default
 * path caches for the TTL.
 */
async function readStoredCredentials(
  env: PlatformEnv | undefined,
  store?: SettingsStore,
): Promise<StoredSlackCredentials> {
  const now = Date.now();
  if (!store && storedCache && storedCache.expiresAt > now) {
    return storedCache.values;
  }
  const settings = store ?? getSettingsStore(env);
  const [botToken, signingSecret, botUserId] = await Promise.all([
    settings.getSetting(SLACK_SETTING_KEYS.botToken),
    settings.getSetting(SLACK_SETTING_KEYS.signingSecret),
    settings.getSetting(SLACK_SETTING_KEYS.botUserId),
  ]);
  const values: StoredSlackCredentials = {
    botToken: nonEmpty(botToken),
    signingSecret: nonEmpty(signingSecret),
    botUserId: nonEmpty(botUserId),
  };
  if (!store) {
    storedCache = { expiresAt: now + STORED_CACHE_TTL_MS, values };
  }
  return values;
}

/**
 * Resolve the effective Slack credentials (env > stored, per key). When the
 * environment provides everything, the settings store is never touched — the
 * fully-env-configured node lane keeps its exact pre-wizard behavior and pays
 * no store read per event.
 */
export async function resolveSlackCredentials(
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ResolvedSlackCredentials> {
  const fromEnv = envCredentials();
  if (fullyEnvConfigured(fromEnv)) {
    return fromEnv;
  }
  const stored = await readStoredCredentials(env, store);
  // The bot user id belongs to whichever bot TOKEN won. Honor a STORED bot
  // user id only when the token ALSO resolved from the store (the wizard saved
  // the pair together from one auth.test). An env token with no env
  // SLACK_BOT_USER_ID must fall through to the auth.test probe (undefined) —
  // never adopt a stored id that may belong to a different bot (main's
  // behavior). The env empty-string ('explicit none') is preserved by `??`.
  const tokenFromStore = !fromEnv.botToken && Boolean(stored.botToken);
  return {
    botToken: fromEnv.botToken ?? stored.botToken,
    signingSecret: fromEnv.signingSecret ?? stored.signingSecret,
    botUserId: fromEnv.botUserId ?? (tokenFromStore ? stored.botUserId : undefined),
  };
}

/** Provenance of each credential, for the /admin Slack-connection card. */
export async function describeSlackCredentialSources(
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<SlackCredentialSources> {
  const fromEnv = envCredentials();
  const stored = fullyEnvConfigured(fromEnv)
    ? { botToken: undefined, signingSecret: undefined, botUserId: undefined }
    : await readStoredCredentials(env, store);
  return {
    botToken: fromEnv.botToken ? 'env' : stored.botToken ? 'stored' : 'missing',
    signingSecret: fromEnv.signingSecret ? 'env' : stored.signingSecret ? 'stored' : 'missing',
    botUserId:
      fromEnv.botUserId !== undefined ? 'env' : stored.botUserId ? 'stored' : 'missing',
  };
}

/**
 * Prime the cache with just-saved values so the isolate that served the
 * wizard save resolves them immediately — the very next signed event must
 * verify with the stored secret, not wait out a stale-cache TTL.
 */
export function primeStoredSlackCredentials(values: StoredSlackCredentials): void {
  storedCache = { expiresAt: Date.now() + STORED_CACHE_TTL_MS, values };
}

/** Drop the cached stored triple (tests; never needed in production flow). */
export function invalidateStoredSlackCredentials(): void {
  storedCache = undefined;
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
  teamId: string | undefined;
  teamName: string | undefined;
  botName: string | undefined;
  botUserId: string | undefined;
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
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    teamId: typeof body.team_id === 'string' ? body.team_id : undefined,
    teamName: typeof body.team === 'string' ? body.team : undefined,
    botName: typeof body.user === 'string' ? body.user : undefined,
    botUserId: typeof body.user_id === 'string' ? body.user_id : undefined,
  };
}

/** One Slack channel, mapped to the admin-facing shape the proxy returns. */
export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
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
  options: { cursor?: string; limit?: number } = {},
): Promise<SlackConversationsListPage> {
  const params = new URLSearchParams({
    types: 'public_channel,private_channel',
    exclude_archived: 'true',
    limit: String(options.limit ?? 200),
  });
  if (options.cursor) params.set('cursor', options.cursor);
  const response = await fetch(`${slackApiBase()}/conversations.list`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;
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
}

/**
 * `conversations.info` for one channel id — used to VERIFY an assignment's
 * channel really exists in the connected workspace (and to read its
 * authoritative name + membership). Raw fetch, workerd-safe, same as above.
 */
export async function slackConversationsInfo(
  botToken: string,
  channelId: string,
): Promise<SlackConversationsInfoResult> {
  const response = await fetch(`${slackApiBase()}/conversations.info`, {
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
    channel: toChannelSummary(body.channel) ?? undefined,
  };
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
): Promise<SlackTeamInfo> {
  const settings = store ?? getSettingsStore(env);
  const [teamId, teamName] = await Promise.all([
    settings.getSetting(SLACK_SETTING_KEYS.teamId),
    settings.getSetting(SLACK_SETTING_KEYS.teamName),
  ]);
  return { teamId: nonEmpty(teamId), teamName: nonEmpty(teamName) };
}

/**
 * The connected workspace identity, verified against the bot token actually in
 * effect. The stored team id is trusted only while its recorded token
 * fingerprint matches the RESOLVED token: credential resolution is env-first,
 * so a later `SLACK_BOT_TOKEN` pointing at a different workspace must
 * invalidate the wizard-era team id (or the workspace-mismatch guard would
 * enforce the stale workspace and mis-key assignments). On a fingerprint miss
 * or a pre-fingerprint install, `auth.test` runs once and the result —
 * id, name, and fingerprint — is re-persisted (the self-healing migration).
 * Returns empty fields when no token resolves a team; a fingerprint MISS with
 * Slack unreachable also returns empty rather than the possibly-wrong stored
 * value, so callers skip the check instead of enforcing a stale workspace.
 */
export async function resolveSlackTeamInfo(
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<SlackTeamInfo> {
  const settings = store ?? getSettingsStore(env);
  const stored = await readStoredSlackTeamInfo(env, settings);
  const { botToken } = await resolveSlackCredentials(env, settings);
  if (!botToken) {
    // Display-only contexts (no token resolvable): the stored identity is the
    // best available answer, and no validation path runs without a token.
    return stored;
  }
  const fingerprint = slackTokenFingerprint(botToken);
  if (stored.teamId) {
    const storedFingerprint = nonEmpty(
      await settings.getSetting(SLACK_SETTING_KEYS.teamTokenFingerprint),
    );
    if (storedFingerprint === fingerprint) {
      return stored;
    }
  }
  let auth: SlackAuthTestResult;
  try {
    auth = await slackAuthTest(botToken);
  } catch {
    return { teamId: undefined, teamName: undefined };
  }
  if (!auth.ok || !auth.teamId) {
    return { teamId: undefined, teamName: undefined };
  }
  await settings.setSetting(SLACK_SETTING_KEYS.teamId, auth.teamId);
  if (auth.teamName) {
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, auth.teamName);
  }
  await settings.setSetting(SLACK_SETTING_KEYS.teamTokenFingerprint, fingerprint);
  return { teamId: auth.teamId, teamName: auth.teamName };
}
