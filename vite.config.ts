import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

// Flue must run first: its project and agent scan feeds the Cloudflare
// plugin's generated Worker configuration during the same config pass.
export default defineConfig({
  plugins: [
    flue({
      providers: ['anthropic', 'openai', 'openrouter', 'cloudflare'],
      tracing: false,
    }),
    cloudflare({ config: flueWorkerConfig() }),
  ],
  build: {
    outDir: 'dist-cf',
  },
});
