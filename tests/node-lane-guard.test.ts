import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENAI_SUBSCRIPTION_LIVE = fileURLToPath(
  new URL('../scripts/verify-openai-subscription-live.mjs', import.meta.url),
);

test('Flue 2 has one compatible Pi/Agents/MCP dependency graph', () => {
  const packageJson = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf8'));
  const packages = lock.packages as Record<string, { version?: string }>;

  assert.equal(packageJson.dependencies['@flue/runtime'], '2.0.0');
  assert.equal(packageJson.dependencies['@flue/slack'], '2.0.0');
  assert.equal(packageJson.devDependencies['@flue/vite'], '2.0.0');
  assert.equal(packageJson.dependencies['@earendil-works/pi-ai'], '0.83.0');
  assert.equal(packages['node_modules/@earendil-works/pi-ai']?.version, '0.83.0');
  assert.equal(
    Object.keys(packages).filter((entry) => entry.endsWith('node_modules/@earendil-works/pi-ai')).length,
    1,
  );
  assert.equal(packages['node_modules/agents']?.version, '0.20.1');
  assert.equal(packages['node_modules/@modelcontextprotocol/sdk']?.version, '1.30.0');
  assert.equal(packages['node_modules/@modelcontextprotocol/client']?.version, '2.0.0');
  assert.equal(packages['node_modules/@modelcontextprotocol/server']?.version, '2.0.0');
});

test('the required Agents runtime is present without installing an unused AI SDK', () => {
  const packageJson = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf8'));
  const packages = lock.packages as Record<string, { version?: string }>;
  const agentsPackage = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, 'node_modules', 'agents', 'package.json'), 'utf8'),
  );
  const agentsIndexPath = path.join(PROJECT_ROOT, 'node_modules', 'agents', 'dist', 'index.d.ts');
  const agentsIndex = readFileSync(agentsIndexPath, 'utf8');
  const surfaceFile = agentsIndex.match(/from "\.\/(agent-tool-types-[^"]+)\.js"/)?.[1];

  assert.equal(packageJson.dependencies.ai, undefined);
  assert.equal(packageJson.dependencies['@cloudflare/codemode'], undefined);
  assert.deepEqual(
    Object.keys(packages).filter(
      (entry) => entry.endsWith('node_modules/ai') || entry.includes('node_modules/@ai-sdk/'),
    ),
    [],
  );
  assert.equal(packages['node_modules/@cloudflare/codemode'], undefined);

  assert.equal(agentsPackage.version, packages['node_modules/agents']?.version);
  assert.equal(agentsPackage.peerDependencies.ai, '^6.0.0 || ^7.0.0');
  assert.equal(agentsPackage.peerDependenciesMeta.ai.optional, true);
  assert.match(agentsIndex, /\bAgent\b/);
  assert.match(agentsIndex, /\bgetAgentByName\b/);
  assert.ok(surfaceFile, 'Agents type entry must identify its generated Agent surface');

  const agentsSurface = readFileSync(
    path.join(PROJECT_ROOT, 'node_modules', 'agents', 'dist', `${surfaceFile}.d.ts`),
    'utf8',
  );
  for (const requiredMethod of [
    /schedule<T = string>\(/,
    /runFiber<T>\(/,
    /onFiberRecovered\(/,
    /runWorkflow<P = unknown>\(/,
  ]) {
    assert.match(agentsSurface, requiredMethod);
  }
  assert.match(agentsSurface, /declare function getAgentByName</);
});

test('Node persistence is explicit and no beta patch choreography remains', () => {
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'src', 'db.node.ts')), true);
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'src', 'db.ts')), false);
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'scripts', 'patch-flue-runtime.mjs')), false);
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'scripts', 'preflight-node-lane.mjs')), false);
});

test('OpenAI subscription verifier rejects remote plaintext HTTP before reading admin auth', () => {
  const result = spawnSync(process.execPath, [
    OPENAI_SUBSCRIPTION_LIVE,
    '--live',
    '--target', 'node',
    '--base-url', 'http://example.com',
  ], {
    encoding: 'utf8',
    env: { ...process.env, TAG_ADMIN_TOKEN: '' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node target must use HTTPS unless it is an explicit loopback host/);
  assert.doesNotMatch(result.stderr, /TAG_ADMIN_TOKEN is required/);
});
