import type { SettingsStore } from './settings-store.ts';
import type { OpenAiAuthMethod } from './types.ts';

/** Legacy setting retained so upgrades can normalize old Subscription installs. */
export const OPENAI_AUTH_METHOD_SETTING_KEY = 'provider.openai.authMethod';

/**
 * OpenAI now supports the Platform API-key lane only. Reading this setting is
 * also the upgrade migration: an install that previously selected a ChatGPT
 * Subscription is normalized before any model or runtime routing decision is
 * made.
 */
export async function resolveOpenAiAuthMethod(
  settings: SettingsStore,
): Promise<OpenAiAuthMethod> {
  const stored = await settings.getSetting(OPENAI_AUTH_METHOD_SETTING_KEY);
  if (stored !== undefined && stored !== 'api_key') {
    await settings.setSetting(OPENAI_AUTH_METHOD_SETTING_KEY, 'api_key');
  }
  return 'api_key';
}

export async function saveOpenAiAuthMethod(
  settings: SettingsStore,
  _method: OpenAiAuthMethod,
): Promise<OpenAiAuthMethod> {
  await settings.setSetting(OPENAI_AUTH_METHOD_SETTING_KEY, 'api_key');
  return 'api_key';
}
