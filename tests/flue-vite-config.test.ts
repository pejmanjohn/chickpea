import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from 'vite';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type FluePluginApi = {
  resolved?: {
    config: { providers?: string[]; tracing?: boolean };
    target: 'node' | 'cloudflare';
    project: { db?: string; app?: string; cloudflare?: string; sourceRoot?: string };
  };
};

test('Node and Cloudflare Vite compositions select distinct truthful targets', async () => {
  const node = await resolveConfig(
    { root: PROJECT_ROOT, configFile: path.join(PROJECT_ROOT, 'vite.node.config.ts') },
    'build',
  );
  const nodeFlue = node.plugins.find((plugin) => plugin.name === 'flue');
  const nodeApi = nodeFlue?.api as FluePluginApi | undefined;
  assert.equal(nodeApi?.resolved?.target, 'node');
  assert.deepEqual(nodeApi?.resolved?.config.providers, ['anthropic', 'openai', 'openrouter']);
  assert.equal(nodeApi?.resolved?.config.tracing, false);
  assert.equal(node.build.outDir, 'dist');
  assert.equal(nodeApi?.resolved?.project.db, path.join(PROJECT_ROOT, 'src', 'db.node.ts'));

  const cloudflare = await resolveConfig(
    { root: PROJECT_ROOT, configFile: path.join(PROJECT_ROOT, 'vite.config.ts') },
    'build',
  );
  const cloudflareFlueIndex = cloudflare.plugins.findIndex((plugin) => plugin.name === 'flue');
  const cloudflarePluginIndex = cloudflare.plugins.findIndex(
    (plugin) => plugin.name === 'vite-plugin-cloudflare',
  );
  const cloudflareApi = cloudflare.plugins[cloudflareFlueIndex]?.api as
    | FluePluginApi
    | undefined;
  assert.equal(cloudflareApi?.resolved?.target, 'cloudflare');
  assert.deepEqual(cloudflareApi?.resolved?.config.providers, [
    'anthropic',
    'openai',
    'openrouter',
    'cloudflare',
  ]);
  assert.equal(cloudflareApi?.resolved?.config.tracing, false);
  assert.equal(cloudflare.build.outDir, 'dist-cf');
  assert.equal(cloudflareApi?.resolved?.project.db, undefined);
  assert.ok(cloudflareFlueIndex >= 0 && cloudflareFlueIndex < cloudflarePluginIndex);
});

test('a host builds the Cloudflare Worker from this checkout with its own entries and output', async (t) => {
  type WorkerConfig = { name?: string; vars?: Record<string, unknown> };
  type ChickpeaWorkerViteConfig = (command: 'build', host: {
    app: string;
    cloudflare: string;
    outDir: string;
    configureWorker(worker: WorkerConfig): void;
  }) => Record<string, unknown>;
  // Loaded by URL so the Vite config stays outside the typecheck, as before.
  const { chickpeaWorkerViteConfig } = await import(new URL('../vite.config.ts', import.meta.url).href) as {
    chickpeaWorkerViteConfig: ChickpeaWorkerViteConfig;
  };
  const hostRoot = mkdtempSync(path.join(os.tmpdir(), 'chickpea-worker-host-'));
  t.after(() => rmSync(hostRoot, { recursive: true, force: true }));
  const app = path.join(hostRoot, 'app.ts');
  const cloudflare = path.join(hostRoot, 'cloudflare.ts');
  writeFileSync(app, "export default { fetch: () => new Response('host') };\n");
  writeFileSync(cloudflare, 'export default {};\n');
  const outDir = path.join(hostRoot, 'dist-cf');
  const seen: Array<{ name: string | undefined; version: unknown }> = [];

  const resolved = await resolveConfig({
    ...chickpeaWorkerViteConfig('build', {
      app,
      cloudflare,
      outDir,
      configureWorker(worker) {
        seen.push({ name: worker.name, version: worker.vars?.CHICKPEA_APP_VERSION });
        worker.name = 'chickpea-host';
      },
    }),
    configFile: false,
  }, 'build');

  const api = resolved.plugins.find((plugin) => plugin.name === 'flue')?.api as FluePluginApi | undefined;
  assert.equal(resolved.root, PROJECT_ROOT);
  assert.equal(api?.resolved?.target, 'cloudflare');
  assert.equal(api?.resolved?.project.sourceRoot, path.join(PROJECT_ROOT, 'src'));
  assert.equal(api?.resolved?.project.app, app);
  assert.equal(api?.resolved?.project.cloudflare, cloudflare);
  assert.equal(resolved.build.outDir, outDir);
  // The host adjusts the Worker last, after Flue and this repository's own settings.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.name, 'chickpea');
  assert.equal(typeof seen[0]!.version, 'string');
});

test('the explicit v2 app shell mounts owned routes without the beta auto-router', () => {
  const appSource = readFileSync(path.join(PROJECT_ROOT, 'src', 'app.ts'), 'utf8');
  assert.doesNotMatch(appSource, /\bflue\s*\(\s*\)/);
  assert.doesNotMatch(appSource, /createAgentRouter\(ChickpeaSlack\)/);
  assert.doesNotMatch(appSource, /createAgentRouter\(ChickpeaRoutineIntent\)/);
  assert.doesNotMatch(appSource, /createAgentRouter\(ChickpeaRoutineExecution\)/);
  assert.doesNotMatch(appSource, /agents\/slack-thread/);
  assert.match(appSource, /app\.route\('\/channels\/slack', channel\.route\(\)\)/);
});

test('Cloudflare tracing is explicit and content-free while generated tracing stays disabled', () => {
  const cloudflareSource = readFileSync(path.join(PROJECT_ROOT, 'src', 'cloudflare.ts'), 'utf8');
  assert.match(cloudflareSource, /createCloudflareTracing\(\{\s*content:\s*false\s*\}\)/);
  assert.match(cloudflareSource, /instrument\(\{\s*\.\.\.cloudflareTracing,/);
  assert.match(cloudflareSource, /emitManagementToolFailure\(observation\)/);
});
