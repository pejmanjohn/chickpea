import { assertNodeVersion } from './scripts/lib/node-version.mjs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type UserConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { buildIdentityDefines, readBuildIdentity } from './scripts/lib/build-identity.mjs';

import { applyCloudflareDeploymentProfile } from './scripts/cloudflare-deployment-profile.mjs';
import { localWorkerViteSettings } from './scripts/lib/local-worker-lane.mjs';
import { PUBLIC_ASSET_PATHS } from './src/assets/public-assets.ts';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

type CloudflarePluginOptions = NonNullable<Parameters<typeof cloudflare>[0]>;
type WorkerConfig = Parameters<Extract<CloudflarePluginOptions['config'], (...args: never[]) => unknown>>[0];

/**
 * A host that builds this Worker from an unmodified checkout of this
 * repository, supplying its own entries and output. Without a host, the
 * config is this repository's own build and local Worker lanes.
 */
export interface ChickpeaWorkerHost {
  /** Absolute path of the host's app entry, used instead of src/app.ts. */
  app: string;
  /** Absolute path of the host's non-HTTP handlers entry, used instead of src/cloudflare.ts. */
  cloudflare: string;
  /** Absolute build output directory, outside this checkout. */
  outDir: string;
  /** Adjusts the Worker config after Flue and Chickpea have built it. */
  configureWorker?: (config: WorkerConfig) => void;
}

assertNodeVersion();

export function chickpeaWorkerViteConfig(command: 'build' | 'serve', host?: ChickpeaWorkerHost): UserConfig {
  const fluePlugins = flue({
    providers: ['anthropic', 'openai', 'openrouter', 'cloudflare'],
    tracing: false,
    ...(host ? { app: host.app, cloudflare: host.cloudflare } : {}),
  });
  // Capture the customizer from the same flue() instance during config
  // evaluation, then compose the optional deployment overlay after Flue has
  // added its generated entry and Durable Object bindings. Flue must run
  // first: its project and agent scan feeds the Cloudflare plugin's generated
  // Worker configuration during the same config pass.
  const configureFlueWorker = flueWorkerConfig();
  // Local Worker lanes belong to this repository's own development.
  const local = command === 'serve' && !host ? localWorkerViteSettings() : undefined;
  return {
    // Explicit so a host running Vite from its own directory still resolves
    // this project, its source root and its Worker config.
    root: projectRoot,
    define: {
      ...buildIdentityDefines(projectRoot),
      // Explicit build-time mode: every Vite serve lane is local development,
      // where the committed build identity does not track working-tree schema
      // edits. Local serve must never attach to a persisted schema marker.
      __CHICKPEA_VITE_SERVE__: JSON.stringify(command === 'serve'),
      // How this Worker was built, so Admin can show matching redeploy steps.
      // Cloudflare Workers Builds sets WORKERS_CI=1; a local or generic-CI
      // `npm run deploy` does not. A serve lane is neither.
      __CHICKPEA_CLOUDFLARE_BUILD_SOURCE__: JSON.stringify(
        command === 'serve' ? 'unknown' : process.env.WORKERS_CI === '1' ? 'workers-builds' : 'command',
      ),
    },
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
              id: path.relative(projectRoot, id),
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
          const identity = readBuildIdentity(projectRoot);
          config.vars = {
            ...(config.vars ?? {}),
            CHICKPEA_APP_VERSION: identity.version,
            CHICKPEA_SOURCE_COMMIT: identity.sourceCommit ?? 'unknown',
          };
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
          host?.configureWorker?.(config);
        }
      }),
    ],
    resolve: {
      alias: [
        // Never reached on Chickpea's paths; see src/build-stubs/empty-module.ts.
        { find: /^mimetext$/, replacement: path.join(projectRoot, 'src/build-stubs/empty-module.ts') },
        { find: /^pusher-js$/, replacement: path.join(projectRoot, 'src/build-stubs/empty-module.ts') },
      ],
    },
    build: {
      outDir: host?.outDir ?? 'dist-cf',
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
}

export default defineConfig(({ command }) => chickpeaWorkerViteConfig(command));
