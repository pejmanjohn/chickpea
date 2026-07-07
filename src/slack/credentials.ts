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
} as const;

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

export interface SlackAuthTestResult {
  ok: boolean;
  /** Slack's machine error code when ok is false (e.g. 'invalid_auth'). */
  error: string | undefined;
  teamName: string | undefined;
  botName: string | undefined;
  botUserId: string | undefined;
}

/**
 * Live-validate a pasted bot token via `auth.test` against
 * `SLACK_API_URL || https://slack.com/api` (the same override the WebClient
 * honors, so the offline harnesses validate against the fake Slack). A raw
 * fetch on purpose: the wizard must not disturb the channel's cached
 * WebClient, and needs nothing but this one method. Network failures throw —
 * the caller maps them to a retriable "Slack unreachable" response, distinct
 * from Slack rejecting the token.
 */
export async function slackAuthTest(botToken: string): Promise<SlackAuthTestResult> {
  const base = (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/+$/, '');
  const response = await fetch(`${base}/auth.test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken}` },
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
    teamName: typeof body.team === 'string' ? body.team : undefined,
    botName: typeof body.user === 'string' ? body.user : undefined,
    botUserId: typeof body.user_id === 'string' ? body.user_id : undefined,
  };
}
