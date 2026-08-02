import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from 'vite';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type FluePluginApi = {
  resolved?: {
    config: { providers?: string[]; tracing?: boolean };
    target: 'node' | 'cloudflare';
    project: { db?: string };
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

test('the explicit v2 app shell mounts owned routes without the beta auto-router', () => {
  const appSource = readFileSync(path.join(PROJECT_ROOT, 'src', 'app.ts'), 'utf8');
  assert.doesNotMatch(appSource, /\bflue\s*\(\s*\)/);
  assert.doesNotMatch(appSource, /createAgentRouter\(ChickpeaSlack\)/);
  assert.doesNotMatch(appSource, /agents\/slack-thread/);
  assert.match(appSource, /createAgentRouter\(ChickpeaRoutineIntent\)/);
  assert.match(appSource, /app\.route\('\/channels\/slack', channel\.route\(\)\)/);
});
