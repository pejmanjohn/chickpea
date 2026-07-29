import type { SettingsStore } from './settings-store.ts';
import type { OpenAiAuthMethod } from './types.ts';

/** Non-secret, installation-wide choice for every canonical openai/* model. */
export const OPENAI_AUTH_METHOD_SETTING_KEY = 'provider.openai.authMethod';

/** Existing installs keep their API-key behavior until an operator changes it. */
export async function resolveOpenAiAuthMethod(
  settings: SettingsStore,
): Promise<OpenAiAuthMethod> {
  const stored = await settings.getSetting(OPENAI_AUTH_METHOD_SETTING_KEY);
  if (stored === undefined || stored === 'api_key') return 'api_key';
  if (stored === 'subscription') return 'subscription';
  throw new Error('Stored OpenAI authentication method is invalid');
}

export async function saveOpenAiAuthMethod(
  settings: SettingsStore,
  method: OpenAiAuthMethod,
): Promise<OpenAiAuthMethod> {
  await settings.setSetting(OPENAI_AUTH_METHOD_SETTING_KEY, method);
  return method;
}
