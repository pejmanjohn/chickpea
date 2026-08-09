import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { experimental_readRawConfig } from 'wrangler';

// @ts-expect-error The executable deployment helper intentionally has no declaration file.
import { classifyCloudflareDeploymentProfile } from '../scripts/cloudflare-deployment-profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BETA_CLASSES = [
  'FlueRegistry',
  'FlueSlackThreadAgent',
  'FlueRoutineIntentAgent',
  'FlueRoutineWorkflow',
].sort();
const V2_CLASSES = [
  'FlueChickpeaSlackV2Agent',
  'FlueChickpeaRoutineIntentV2Agent',
  'FlueChickpeaRoutineExecutionV2Agent',
].sort();
const V2_BINDINGS = [
  'FLUE_CHICKPEA_SLACK_V2_AGENT/FlueChickpeaSlackV2Agent',
  'FLUE_CHICKPEA_ROUTINE_INTENT_V2_AGENT/FlueChickpeaRoutineIntentV2Agent',
  'FLUE_CHICKPEA_ROUTINE_EXECUTION_V2_AGENT/FlueChickpeaRoutineExecutionV2Agent',
].sort();

interface DurableObjectMigration {
  tag: string;
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: Array<{ from: string; to: string }>;
}

interface AuthoredWranglerConfig {
  compatibility_date?: string;
  observability?: { traces?: { enabled?: boolean } };
  durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
  containers?: Array<{ class_name?: string }>;
  migrations?: DurableObjectMigration[];
}

async function sourceFiles(): Promise<string[]> {
  const roots = ['src', 'scripts'];
  const files: string[] = [];
  for (const root of roots) {
    const absolute = path.join(ROOT, root);
    const entries = await readdir(absolute, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name)) continue;
      if (entry.parentPath.split(path.sep).includes('.flue-vite')) continue;
      files.push(path.join(entry.parentPath, entry.name));
    }
  }
  return files;
}

async function sourceEntries(): Promise<Array<{ file: string; source: string }>> {
  return Promise.all((await sourceFiles()).map(async (file) => ({
    file,
    source: await readFile(file, 'utf8'),
  })));
}

function matchingFiles(
  entries: ReadonlyArray<{ file: string; source: string }>,
  pattern: RegExp,
): string[] {
  return entries.flatMap(({ file, source }) => {
    const matches = pattern.test(source);
    pattern.lastIndex = 0;
    return matches ? [path.relative(ROOT, file)] : [];
  }).sort();
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

async function builtJavaScript(): Promise<string> {
  const artifactRoot = path.join(ROOT, 'dist-cf', 'chickpea');
  const entries = await readdir(artifactRoot, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}

test('dependencies and scripts are pinned to the supported Flue 2 surface', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, 'package.json'), 'utf8'),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.dependencies['@flue/runtime'], '2.0.0');
  assert.equal(packageJson.dependencies['@flue/slack'], '2.0.0');
  assert.equal(packageJson.devDependencies['@flue/cli'], '2.0.0');
  assert.equal(packageJson.devDependencies['@flue/vite'], '2.0.0');
  assert.equal(packageJson.dependencies['@flue/sdk'], undefined);
  assert.equal(packageJson.devDependencies['@flue/sdk'], undefined);
  const scripts = JSON.stringify(packageJson.scripts);
  assert.doesNotMatch(scripts, /patch|staged-types|routines-runtime-spike|wait=result/);
});

test('application and verification sources contain no removed beta runtime surfaces', async () => {
  const entries = await sourceEntries();
  const forbidden = [
    /@flue\/runtime\/routing/,
    /\bdefineAgent\s*\(/,
    /\bdefineWorkflow\s*\(/,
    /\?wait=result/,
    /TAG_AGENT_API_TOKEN/,
    /x-flue-internal-token/,
    /verify-flue-v2-staged-types/,
    /verify-routines-runtime-spike/,
  ];
  for (const pattern of forbidden) {
    assert.deepEqual(matchingFiles(entries, pattern), [], String(pattern));
  }

  const runtimeImport = /import\s*\{([\s\S]*?)\}\s*from\s*['"]@flue\/runtime['"]/g;
  const removedRuntimeExports = /\b(?:defineAgent|defineWorkflow|getRun|listRuns|invoke)\b/;
  for (const { file, source } of entries) {
    for (const match of source.matchAll(runtimeImport)) {
      assert.doesNotMatch(match[1] ?? '', removedRuntimeExports, path.relative(ROOT, file));
    }
  }

  assert.deepEqual(
    entries
      .map(({ file }) => file)
      .filter((file) => file.startsWith(path.join(ROOT, 'src', 'workflows'))),
    [],
  );
  const app = await readFile(path.join(ROOT, 'src', 'app.ts'), 'utf8');
  assert.doesNotMatch(app, /\bflue\s*\(/);
  assert.doesNotMatch(app, /app\.route\(['"]\/agents/);
});

test('authored Cloudflare reset preserves app state, replaces beta Flue classes, and enables traces', async () => {
  const { rawConfig } = await experimental_readRawConfig({
    config: path.join(ROOT, 'wrangler.jsonc'),
  });
  const config = rawConfig as AuthoredWranglerConfig;
  const migrations = config.migrations ?? [];
  const reset = migrations.find((migration) => migration.tag === 'v6');
  assert.ok(reset);
  assert.deepEqual(sorted(reset.new_sqlite_classes ?? []), V2_CLASSES);
  assert.deepEqual(sorted(reset.deleted_classes ?? []), BETA_CLASSES);
  assert.deepEqual(reset.renamed_classes ?? [], []);

  const bindings = config.durable_objects?.bindings ?? [];
  assert.ok(bindings.some((binding) =>
    binding.name === 'TAG_STATE' && binding.class_name === 'TagStateStore'
  ));
  assert.equal(bindings.some((binding) =>
    binding.name === 'SANDBOX' || binding.class_name === 'Sandbox'
  ), false);
  assert.deepEqual(config.containers ?? [], []);
  const sandboxMigration = migrations.find((migration) => migration.tag === 'v3');
  assert.deepEqual(sandboxMigration?.new_sqlite_classes, ['Sandbox']);
  const destructive = migrations.flatMap((migration) => [
    ...(migration.deleted_classes ?? []),
    ...(migration.renamed_classes ?? []).flatMap((rename) => [rename.from, rename.to]),
  ]);
  assert.equal(destructive.includes('TagStateStore'), false);
  assert.equal(destructive.includes('Sandbox'), false);
  assert.equal(destructive.includes('ContainerProxy'), false);
  assert.equal(config.observability?.traces?.enabled, true);
  assert.ok((config.compatibility_date ?? '') >= '2026-04-01');
});

test(
  'generated Cloudflare artifact contains fresh Flue 2 bindings, no workflows, and enabled traces',
  { skip: !existsSync(path.join(ROOT, 'dist-cf', 'chickpea', 'wrangler.json')) },
  async () => {
    const configPath = path.join(ROOT, 'dist-cf', 'chickpea', 'wrangler.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      main?: string;
      compatibility_date?: string;
      observability?: { traces?: { enabled?: boolean } };
      durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
      containers?: Array<{ class_name?: string }>;
      workflows?: unknown[];
      migrations?: Array<{
        tag: string;
        new_sqlite_classes?: string[];
        deleted_classes?: string[];
      }>;
    };
    const bindings = (config.durable_objects?.bindings ?? []).map(
      (binding) => `${binding.name}/${binding.class_name}`,
    );
    const deploymentProfile = classifyCloudflareDeploymentProfile(config);
    assert.deepEqual(
      sorted(bindings.filter((binding) => binding.startsWith('FLUE_'))),
      V2_BINDINGS,
    );
    assert.ok(bindings.includes('TAG_STATE/TagStateStore'));
    assert.equal(
      bindings.includes('SANDBOX/Sandbox'),
      deploymentProfile === 'sandbox',
    );
    assert.deepEqual(config.workflows ?? [], []);
    assert.equal(config.observability?.traces?.enabled, true);
    assert.ok((config.compatibility_date ?? '') >= '2026-04-01');

    const reset = (config.migrations ?? []).find((migration) => migration.tag === 'v6');
    assert.deepEqual(sorted(reset?.new_sqlite_classes ?? []), V2_CLASSES);
    assert.deepEqual(sorted(reset?.deleted_classes ?? []), BETA_CLASSES);
    const sandboxMigration = (config.migrations ?? []).find((migration) => migration.tag === 'v3');
    assert.deepEqual(sandboxMigration?.new_sqlite_classes, ['Sandbox']);

    const mainBundle = await readFile(
      path.join(path.dirname(configPath), config.main ?? 'index.js'),
      'utf8',
    );
    for (const name of [
      'chickpea-slack-v2',
      'chickpea-routine-intent-v2',
      'chickpea-routine-execution-v2',
      'chickpea.response-metadata',
    ]) {
      assert.match(mainBundle, new RegExp(name));
    }
    assert.doesNotMatch(mainBundle, /x-flue-internal-token|\/agents\/slack-thread|\/workflows\//);

    const bundle = await builtJavaScript();
    assert.match(bundle, /#region node_modules\/agents\/dist\/agent-tool-types\.js/);
    assert.match(bundle, /var Agent = class Agent extends Server/);
    assert.match(bundle, /async function getAgentByName\(/);
    assert.match(bundle, /async schedule\(when, callback, payload, options\)/);
    assert.match(bundle, /async runFiber\(name, fn\)/);
    assert.match(bundle, /async onFiberRecovered\(_ctx\)/);
    assert.match(bundle, /async runWorkflow\(workflowName, params, options\)/);
    assert.match(bundle, /class FlueGeneratedAgent extends Base/);
    assert.match(bundle, /return \(await getAgentByName\(binding, instanceId\)\)\.fetch\(request\)/);
    for (const className of V2_CLASSES) {
      assert.equal(
        bundle.includes(`var ${className} = createFlueAgentClass({`),
        true,
        `${className} must be generated from the installed Agents base`,
      );
    }
    assert.doesNotMatch(bundle, /#region node_modules\/(?:ai|@ai-sdk|@cloudflare\/codemode)\//);
  },
);
