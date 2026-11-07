/**
 * The model providers an installation funds with its own API key. A leaf
 * module, so any module can derive a provider list from these at load time
 * without an import cycle.
 */
export const PROVIDER_KEY_IDS = ['anthropic', 'openai', 'openrouter'] as const;

export type ProviderKeyId = (typeof PROVIDER_KEY_IDS)[number];

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKeyId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
};

export function isProviderKeyId(id: string): id is ProviderKeyId {
  return (PROVIDER_KEY_IDS as readonly string[]).includes(id);
}
