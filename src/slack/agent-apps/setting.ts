/**
 * The workspace's choice of how its Agents appear in Slack: `shared`, each
 * through a user group that Chickpea's app answers, or `own_app`, each new
 * Agent as its own Slack app. One record per installation, apart from the
 * configuration token; no record means `shared`.
 */
import * as v from 'valibot';

import type { SettingsStore } from '../../config/settings-store.ts';

export const AGENT_SLACK_APPS_SETTING_KEY = 'slack.agent_apps.v1';

export const AGENT_SLACK_APPS_MODES = ['shared', 'own_app'] as const;
export type AgentSlackAppsMode = (typeof AGENT_SLACK_APPS_MODES)[number];

/** Who chose the mode and when; both are absent only for the default no Owner chose. */
export type AgentSlackAppsSetting =
  | { mode: 'shared'; changedBy?: undefined; changedAt?: undefined }
  | { mode: AgentSlackAppsMode; changedBy: string; changedAt: number };

const storedSchema = v.object({
  mode: v.picklist(AGENT_SLACK_APPS_MODES),
  changedBy: v.pipe(v.string(), v.minLength(1)),
  changedAt: v.pipe(v.number(), v.integer()),
});

const DEFAULT: AgentSlackAppsSetting = { mode: 'shared' };

/** A record that cannot be read is no reason to change how Agents appear, so it reads as the default. */
export async function readAgentSlackAppsSetting(settings: Pick<SettingsStore, 'getSetting'>): Promise<AgentSlackAppsSetting> {
  const raw = await settings.getSetting(AGENT_SLACK_APPS_SETTING_KEY);
  if (raw === undefined) return DEFAULT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const stored = v.safeParse(storedSchema, parsed);
  if (stored.success) return stored.output;
  console.warn({ event: 'chickpea.agent_app.setting_unreadable' });
  return DEFAULT;
}

export async function writeAgentSlackAppsSetting(
  settings: Pick<SettingsStore, 'setSetting'>,
  setting: { mode: AgentSlackAppsMode; changedBy: string; changedAt: number },
): Promise<AgentSlackAppsSetting> {
  const stored = { mode: setting.mode, changedBy: setting.changedBy, changedAt: setting.changedAt };
  await settings.setSetting(AGENT_SLACK_APPS_SETTING_KEY, JSON.stringify(stored));
  return stored;
}
