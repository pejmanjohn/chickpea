import type { SettingsStore } from '../config/settings-store.ts';

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
const MAX_SESSION_IDS = 1_000;
const MAX_CAS_ATTEMPTS = 12;

export interface BrowserMonthlyUsage {
  month: string;
  sessions: number;
  seconds: number;
}

interface StoredMonthlyUsage {
  sessions: number;
  seconds: number;
  sessionIds: string[];
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function describeBrowserSettings(
  values: {
    storedApiKey?: string | undefined;
    storedProjectId?: string | undefined;
    envApiKey?: string | undefined;
    envProjectId?: string | undefined;
  },
): BrowserSettings {
  const envKey = nonEmpty(values.envApiKey);
  const storedKey = nonEmpty(values.storedApiKey);
  const apiKey = envKey ?? storedKey;
  const source: BrowserKeySource = envKey ? 'env' : storedKey ? 'stored' : 'missing';
  const projectId = nonEmpty(values.envProjectId) ?? nonEmpty(values.storedProjectId);
  return {
    provider: 'browserbase',
    connected: apiKey !== undefined,
    source,
    ...(apiKey ? { apiKey, keyHint: apiKey.slice(-4) } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

export async function resolveBrowserSettings(
  store: SettingsStore,
  env: Record<string, unknown> | NodeJS.ProcessEnv = process.env,
): Promise<BrowserSettings> {
  const [storedApiKey, storedProjectId] = await store.getSettings([
    BROWSER_SETTING_KEYS.apiKey,
    BROWSER_SETTING_KEYS.projectId,
  ]);
  return describeBrowserSettings({
    storedApiKey,
    storedProjectId,
    envApiKey: nonEmpty(env[BROWSER_ENV_VARS.apiKey]),
    envProjectId: nonEmpty(env[BROWSER_ENV_VARS.projectId]),
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
  const projectId = nonEmpty(input.projectId);
  if (projectId) await store.setSetting(BROWSER_SETTING_KEYS.projectId, projectId);
  else await store.deleteSetting(BROWSER_SETTING_KEYS.projectId);
}

export async function clearBrowserSettings(store: SettingsStore): Promise<void> {
  await store.applySettingsPatch({ delete: Object.values(BROWSER_SETTING_KEYS) });
}

export function browserUsageMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseStoredUsage(raw: string | undefined): StoredMonthlyUsage {
  if (!raw) return { sessions: 0, seconds: 0, sessionIds: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredMonthlyUsage>;
    const sessions = Number.isSafeInteger(parsed.sessions) && (parsed.sessions as number) >= 0 ? (parsed.sessions as number) : 0;
    const seconds = Number.isFinite(parsed.seconds) && (parsed.seconds as number) >= 0 ? Math.round(parsed.seconds as number) : 0;
    const sessionIds = Array.isArray(parsed.sessionIds)
      ? parsed.sessionIds.filter((id): id is string => typeof id === 'string')
      : [];
    return { sessions, seconds, sessionIds };
  } catch {
    return { sessions: 0, seconds: 0, sessionIds: [] };
  }
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
  const month = browserUsageMonth(options.now ?? new Date());
  const key = `${MONTHLY_USAGE_PREFIX}${month}`;
  const seconds = Math.max(0, Math.round(options.seconds));
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await options.store.getSetting(key);
    const usage = parseStoredUsage(raw);
    if (usage.sessionIds.includes(options.sessionId)) {
      return { month, sessions: usage.sessions, seconds: usage.seconds };
    }
    const next: StoredMonthlyUsage = {
      sessions: usage.sessions + 1,
      seconds: usage.seconds + seconds,
      sessionIds: [...usage.sessionIds, options.sessionId].slice(-MAX_SESSION_IDS),
    };
    const applied = await options.store.applySettingsPatch({
      expected: { key, value: raw ?? null },
      set: [{ key, value: JSON.stringify(next) }],
    });
    if (applied) return { month, sessions: next.sessions, seconds: next.seconds };
  }
  throw new Error('Could not record browser usage after concurrent updates');
}

export async function readBrowserMonthlyUsage(
  store: SettingsStore,
  now: Date = new Date(),
): Promise<BrowserMonthlyUsage> {
  const month = browserUsageMonth(now);
  const usage = parseStoredUsage(await store.getSetting(`${MONTHLY_USAGE_PREFIX}${month}`));
  return { month, sessions: usage.sessions, seconds: usage.seconds };
}
