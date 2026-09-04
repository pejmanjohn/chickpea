import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';

import { applyCloudflareDeploymentProfile } from './scripts/cloudflare-deployment-profile.mjs';
import { localWorkerViteSettings } from './scripts/lib/local-worker-lane.mjs';
import { PUBLIC_ASSET_PATHS } from './src/assets/public-assets.ts';

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
export default defineConfig(({ command }) => {
  const local = command === 'serve' ? localWorkerViteSettings() : undefined;
  return {
    // Public images are uploaded as Static Assets, not embedded in Worker code.
    publicDir: 'assets',
    plugins: [
      fluePlugins,
      {
        name: 'chickpea-public-assets',
        apply: 'build',
        async generateBundle() {
          if (this.environment.name !== 'client') return;
          // Keep source/README artwork in the repository, but publish only the
          // images the application uses. publicDir still supports local dev.
          for (const fileName of PUBLIC_ASSET_PATHS) {
            this.emitFile({
              type: 'asset',
              fileName,
              source: await readFile(path.resolve(this.environment.config.publicDir, fileName)),
            });
          }
        },
      },
      {
        name: 'chickpea-bundle-module-report',
        generateBundle(_options, bundle) {
          if (this.environment.name === 'client') return;
          // Build-only provenance for size analysis and contract tests. This is
          // not imported by the Worker or copied into the public assets directory.
          const modules = Object.values(bundle).flatMap((output) => output.type === 'chunk'
            ? Object.entries(output.modules).map(([id, module]) => ({
              id: path.relative(process.cwd(), id),
              renderedLength: module.renderedLength,
            }))
            : []);
          this.emitFile({
            type: 'asset',
            fileName: 'bundle-modules.json',
            source: JSON.stringify(modules),
          });
        },
      },
      cloudflare({
        ...(local ? {
          persistState: { path: local.statePath },
          tunnel: { name: local.tunnelName, autoStart: true },
        } : {}),
        config(config) {
          configureFlueWorker(config);
          applyCloudflareDeploymentProfile(config);
          if (local) {
            const authDb = config.d1_databases?.find((database) => database.binding === 'AUTH_DB');
            if (!authDb) throw new Error('Local Worker development requires the AUTH_DB binding.');
            authDb.database_id = local.d1DatabaseId;
            config.assets = {
              ...(config.assets ?? {}),
              // Static assets normally run before the Worker. Agent avatars
              // are generated from local state, so let the dynamic route own
              // only that namespace while keeping the static asset binding.
              run_worker_first: ['/assets/agents/*'],
            };
            config.ai = { ...(config.ai ?? { binding: 'AI' }), remote: true };
            config.vars = {
              ...(config.vars ?? {}),
              CHICKPEA_LOCAL_LANE: local.lane,
              CHICKPEA_LOCAL_RUNTIME: 'cloudflare-vite/workerd',
              CHICKPEA_LOCAL_TRANSPORT: 'slack-http-events',
              CHICKPEA_LOCAL_SOURCE_SHA: local.sourceSha,
              SLACK_TAG_PUBLIC_URL: local.publicUrl,
              CHICKPEA_TELEMETRY_ENVIRONMENT: 'development',
            };
          }
        }
      }),
    ],
    resolve: {
      alias: [
        // Never reached on Chickpea's paths; see src/build-stubs/empty-module.ts.
        { find: /^mimetext$/, replacement: path.resolve('src/build-stubs/empty-module.ts') },
        { find: /^pusher-js$/, replacement: path.resolve('src/build-stubs/empty-module.ts') },
      ],
    },
    build: {
      outDir: 'dist-cf',
      copyPublicDir: false,
      minify: 'oxc',
    },
    ...(local ? {
      optimizeDeps: {
        // This Worker graph is ESM. Discovery repeatedly invalidates pi-ai's
        // generated provider chunks during workerd boot, so run the source
        // graph directly instead of maintaining a disposable prebundle cache.
        noDiscovery: true,
        include: [],
        exclude: ['@earendil-works/pi-ai'],
      },
      server: {
        host: '127.0.0.1',
        port: local.port,
        strictPort: true,
        allowedHosts: [
          new URL(local.publicUrl).hostname,
          // read.cloudflare.ts uses this non-routable origin when it calls the
          // ASSETS binding from Durable Objects and other requestless paths.
          'chickpea-assets.invalid',
        ],
      },
    } : {}),
  };
});
