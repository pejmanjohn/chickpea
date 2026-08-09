import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

import { applyCloudflareDeploymentProfile } from './scripts/cloudflare-deployment-profile.mjs';

const fluePlugins = flue({
  providers: ['anthropic', 'openai', 'openrouter', 'cloudflare'],
  tracing: false,
});
// Capture the customizer from the same flue() instance during config
// evaluation, then compose the optional deployment overlay after Flue has
// added its generated entry and Durable Object bindings.
const configureFlueWorker = flueWorkerConfig();

// Flue must run first: its project and agent scan feeds the Cloudflare
// plugin's generated Worker configuration during the same config pass.
export default defineConfig({
  plugins: [
    fluePlugins,
    cloudflare({
      config(config) {
        configureFlueWorker(config);
        applyCloudflareDeploymentProfile(config);
      },
    }),
  ],
  build: {
    outDir: 'dist-cf',
  },
});
