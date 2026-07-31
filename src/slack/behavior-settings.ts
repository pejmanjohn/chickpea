import type { SettingsStore } from '../config/settings-store.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';

export const SLACK_BEHAVIOR_KEYS = [
  'allowDms',
  'unassignedHint',
  'welcomeOnJoin',
  'ambientParticipation',
] as const;

export type SlackBehaviorKey = (typeof SLACK_BEHAVIOR_KEYS)[number];
export type SlackBehaviorSource = 'env' | 'stored' | 'default';

export interface SlackBehaviorSetting {
  value: boolean;
  source: SlackBehaviorSource;
}

export type SlackBehaviorSettings = Record<SlackBehaviorKey, SlackBehaviorSetting>;
export type SlackBehaviorPatch = Partial<Record<SlackBehaviorKey, boolean>>;

export const SLACK_BEHAVIOR_SETTING_KEYS: Record<SlackBehaviorKey, string> = {
  allowDms: 'slack.behavior.allowDms',
  unassignedHint: 'slack.behavior.unassignedHint',
  welcomeOnJoin: 'slack.behavior.welcomeOnJoin',
  ambientParticipation: 'slack.behavior.ambientParticipation',
};

export const SLACK_BEHAVIOR_ENV_KEYS: Record<SlackBehaviorKey, string> = {
  allowDms: 'SLACK_TAG_ALLOW_DMS',
  unassignedHint: 'SLACK_TAG_UNASSIGNED_HINT',
  welcomeOnJoin: 'SLACK_TAG_WELCOME_ON_JOIN',
  ambientParticipation: 'SLACK_TAG_AMBIENT_PARTICIPATION',
};

/**
 * Keep the original env-knob semantics: behavior is on unless the configured
 * value is one of the conventional explicit false spellings.
 */
function defaultOnBoolean(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return !(
    normalized === 'false' ||
    normalized === '0' ||
    normalized === 'off' ||
    normalized === 'no'
  );
}

function envBehaviorValue(key: SlackBehaviorKey): string | undefined {
  const value = process.env[SLACK_BEHAVIOR_ENV_KEYS[key]]?.trim();
  return value ? value : undefined;
}

function fromSources(
  key: SlackBehaviorKey,
  stored: string | undefined,
): SlackBehaviorSetting {
  const fromEnv = envBehaviorValue(key);
  if (fromEnv !== undefined) {
    return { value: defaultOnBoolean(fromEnv), source: 'env' };
  }
  if (stored !== undefined) {
    return { value: defaultOnBoolean(stored), source: 'stored' };
  }
  return { value: true, source: 'default' };
}

/** Resolve env > stored > default for all Slack runtime behavior switches. */
export async function resolveSlackBehaviorSettings(
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<SlackBehaviorSettings> {
  const settings = store ?? getSettingsStore(env);
  const stored = await settings.getSettings(
    SLACK_BEHAVIOR_KEYS.map((key) => SLACK_BEHAVIOR_SETTING_KEYS[key]),
  );
  return {
    allowDms: fromSources('allowDms', stored[0]),
    unassignedHint: fromSources('unassignedHint', stored[1]),
    welcomeOnJoin: fromSources('welcomeOnJoin', stored[2]),
    ambientParticipation: fromSources('ambientParticipation', stored[3]),
  };
}

/** Keys in this patch controlled by environment and therefore browser-read-only. */
export function envManagedSlackBehaviorKeys(patch: SlackBehaviorPatch): SlackBehaviorKey[] {
  return SLACK_BEHAVIOR_KEYS.filter(
    (key) => patch[key] !== undefined && envBehaviorValue(key) !== undefined,
  );
}

/** Persist a validated, env-writable partial patch as stable boolean strings. */
export async function saveSlackBehaviorSettings(
  store: SettingsStore,
  patch: SlackBehaviorPatch,
): Promise<void> {
  await store.applySettingsPatch({
    set: SLACK_BEHAVIOR_KEYS.flatMap((key) => {
      const value = patch[key];
      return value === undefined
        ? []
        : [{ key: SLACK_BEHAVIOR_SETTING_KEYS[key], value: String(value) }];
    }),
  });
}
