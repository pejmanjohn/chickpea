import { envValue } from '../config/env-value.ts';
import { readMonthlyCounter, updateMonthlyCounter } from '../config/monthly-counter.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { trimmedNonEmpty } from '../security/content-validation.ts';

/**
 * Install-wide Browser settings. One hosted-browser provider per install
 * (Browserbase today), keyed like model-provider keys: an environment variable
 * wins over the stored value, and the stored value is a plain settings row
 * because it is a service API key, not a person's website password.
 */
export const BROWSER_SETTING_KEYS = {
  apiKey: 'browser.browserbase.apiKey',
  projectId: 'browser.browserbase.projectId',
} as const;

export const BROWSER_ENV_VARS = {
  apiKey: 'BROWSERBASE_API_KEY',
  projectId: 'BROWSERBASE_PROJECT_ID',
} as const;

export type BrowserProviderId = 'browserbase';
export type BrowserKeySource = 'env' | 'stored' | 'missing';

export interface BrowserSettings {
  provider: BrowserProviderId;
  connected: boolean;
  source: BrowserKeySource;
  apiKey?: string;
  projectId?: string;
  /** Last four characters of the key, for the Admin card. Never the key. */
  keyHint?: string;
}

const MONTHLY_USAGE_PREFIX = 'browser.monthlyUsage.';

export interface BrowserMonthlyUsage {
  month: string;
  sessions: number;
  seconds: number;
}

export function describeBrowserSettings(
  values: {
    storedApiKey?: string | undefined;
    storedProjectId?: string | undefined;
    envApiKey?: string | undefined;
    envProjectId?: string | undefined;
  },
): BrowserSettings {
  const envKey = trimmedNonEmpty(values.envApiKey);
  const storedKey = trimmedNonEmpty(values.storedApiKey);
  const apiKey = envKey ?? storedKey;
  const source: BrowserKeySource = envKey ? 'env' : storedKey ? 'stored' : 'missing';
  const projectId = trimmedNonEmpty(values.envProjectId) ?? trimmedNonEmpty(values.storedProjectId);
  return {
    provider: 'browserbase',
    connected: apiKey !== undefined,
    source,
    ...(apiKey ? { apiKey, keyHint: apiKey.slice(-4) } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

/**
 * `env` is the platform env (Worker bindings). `envValue` falls back to
 * `process.env` for a name the bindings do not carry, so Node callers may
 * pass undefined.
 */
export async function resolveBrowserSettings(
  store: SettingsStore,
  env: Record<string, unknown> | undefined,
): Promise<BrowserSettings> {
  const [storedApiKey, storedProjectId] = await store.getSettings([
    BROWSER_SETTING_KEYS.apiKey,
    BROWSER_SETTING_KEYS.projectId,
  ]);
  return describeBrowserSettings({
    storedApiKey,
    storedProjectId,
    envApiKey: envValue(env, BROWSER_ENV_VARS.apiKey),
    envProjectId: envValue(env, BROWSER_ENV_VARS.projectId),
  });
}

/** Basic shape check so an obviously wrong paste fails before a network call. */
export function looksLikeBrowserbaseKey(value: string): boolean {
  const trimmed = value.trim();
  return /^bb_(live|test)_[A-Za-z0-9_-]{8,}$/.test(trimmed);
}

export async function saveBrowserSettings(
  store: SettingsStore,
  input: { apiKey: string; projectId?: string | undefined },
): Promise<void> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error('A Browserbase API key is required.');
  await store.setSetting(BROWSER_SETTING_KEYS.apiKey, apiKey);
  const projectId = trimmedNonEmpty(input.projectId);
  if (projectId) await store.setSetting(BROWSER_SETTING_KEYS.projectId, projectId);
  else await store.deleteSetting(BROWSER_SETTING_KEYS.projectId);
}

export async function clearBrowserSettings(store: SettingsStore): Promise<void> {
  await store.applySettingsPatch({ delete: Object.values(BROWSER_SETTING_KEYS) });
}

function parseStoredUsage(
  stored: Record<string, unknown> | undefined,
): { counter: { sessions: number; seconds: number }; ids: string[] } {
  const sessions = stored?.sessions;
  const seconds = stored?.seconds;
  const ids = stored?.sessionIds;
  return {
    counter: {
      sessions: typeof sessions === 'number' && Number.isSafeInteger(sessions) && sessions >= 0 ? sessions : 0,
      seconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : 0,
    },
    ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
  };
}

/**
 * Tally one finished browser session into the month's usage row. Idempotent
 * per session id, so a retried turn cannot double count. Compare-and-set like
 * the sandbox session cap; concurrent turns retry on a lost race.
 */
export async function recordBrowserSessionUsage(options: {
  store: SettingsStore;
  sessionId: string;
  seconds: number;
  now?: Date;
}): Promise<BrowserMonthlyUsage> {
  const seconds = Math.max(0, Math.round(options.seconds));
  return updateMonthlyCounter(options.store, {
    prefix: MONTHLY_USAGE_PREFIX,
    id: options.sessionId,
    ...(options.now ? { now: options.now } : {}),
    idsField: 'sessionIds',
    parse: parseStoredUsage,
    next: (usage, { month, seen }) => {
      if (seen) return { result: { month, ...usage } };
      const counter = { sessions: usage.sessions + 1, seconds: usage.seconds + seconds };
      return { counter, result: { month, ...counter } };
    },
    contendedMessage: 'Could not record browser usage after concurrent updates',
  });
}

export async function readBrowserMonthlyUsage(
  store: SettingsStore,
  now: Date = new Date(),
): Promise<BrowserMonthlyUsage> {
  const { month, counter } = await readMonthlyCounter(store, { prefix: MONTHLY_USAGE_PREFIX, now, parse: parseStoredUsage });
  return { month, ...counter };
}
