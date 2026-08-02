import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  // Keep the shared graph deliberately narrow. The Cloudflare Vite config adds
  // the binding-backed `cloudflare` provider; Node must not register it because
  // it has no Workers AI binding.
  providers: ['anthropic', 'openai', 'openrouter'],
  // Chickpea owns tracing configuration explicitly. Keep the generated
  // default off so it cannot broaden the existing metadata-only contract.
  tracing: false,
});
