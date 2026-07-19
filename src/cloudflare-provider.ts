import { registerProvider } from '@flue/runtime';
import type { CloudflareAIBinding } from '@flue/runtime/cloudflare';

/**
 * Register the Workers AI binding without routing prompts through AI Gateway.
 *
 * Importing this module is side-effect free. The Cloudflare-only entry calls
 * this helper with its ambient `env.AI` binding; the shared Node app never
 * imports it or registers a keyless `cloudflare/*` provider.
 */
export function registerCloudflareBindingProvider(binding: CloudflareAIBinding): void {
  registerProvider('cloudflare', {
    api: 'cloudflare-ai-binding',
    binding,
    // Flue otherwise supplies `{ id: 'default' }`, which creates an AI
    // Gateway whose default logs retain request and response payloads.
    gateway: false,
  });
}
