import type { Provider } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

// Flue's provider registry has no public getter. Every app-owned Pi provider
// registers through this seam so stateless callers (the Slack interaction
// classifier) can stream against the same provider object Flue dispatches
// with, instead of importing pi-ai's compat surface — which drags every
// built-in provider SDK into the Cloudflare bundle.
const registered = new Map<string, Provider>();

export function registerPiProvider(provider: Provider): void {
  registered.set(provider.id, provider);
  setProvider(provider);
}

export function registeredPiProvider(id: string): Provider | undefined {
  return registered.get(id);
}
