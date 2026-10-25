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

  assert.equal(packageJson.dependencies['@flue/runtime'], '2.3.0');
  assert.equal(packageJson.dependencies['@flue/slack'], '2.3.0');
  assert.equal(packageJson.devDependencies['@flue/cli'], '2.3.0');
  assert.equal(packageJson.devDependencies['@flue/vite'], '2.3.0');
  assert.equal(packageJson.devDependencies['@modelcontextprotocol/client'], '2.0.0');
  assert.equal(packageJson.dependencies.agents, undefined);
  assert.equal(packageJson.devDependencies.agents, '0.20.1');
  assert.equal(packageJson.dependencies['@earendil-works/pi-ai'], '1.1.0');
  assert.equal(packages['node_modules/@earendil-works/pi-ai']?.version, '1.1.0');
  // Flue is released against one Pi family version. A second copy of any Pi
  // package (a floated pi-agent-core pins its own pi-ai) splits the graph, so
  // every package in the family resolves once, at pi-ai's version.
  const piFamily = Object.entries(packages).filter(([entry]) => /node_modules\/@earendil-works\/[^/]+$/.test(entry));
  const piNames = piFamily.map(([entry]) => entry.slice(entry.lastIndexOf('@earendil-works/')));
  assert.deepEqual(piNames.sort(), [...new Set(piNames)].sort(), 'each Pi package resolves once');
  assert.deepEqual(
    piFamily.filter(([, entry]) => entry.version !== '1.1.0').map(([name]) => name),
    [],
    'every Pi package matches pi-ai',
  );
  assert.ok(piNames.includes('@earendil-works/pi-agent-core'));
  assert.equal(packages['node_modules/agents']?.version, '0.20.1');
  assert.equal(
    Object.keys(packages).filter((entry) => entry.endsWith('node_modules/agents')).length,
    1,
  );
  // agents pins its MCP peers exactly, but its Worker entry imports only
  // sdk/types.js from them, so sdk and server follow Chickpea's patched pins.
  // The client stays on the exact version Flue's runtime pins.
  assert.deepEqual(packageJson.overrides.agents, {
    '@modelcontextprotocol/sdk': '$@modelcontextprotocol/sdk',
    '@modelcontextprotocol/server': '$@modelcontextprotocol/server',
  });
  assert.equal(packages['node_modules/@modelcontextprotocol/sdk']?.version, '1.32.2');
  assert.equal(packages['node_modules/@modelcontextprotocol/client']?.version, '2.0.0');
  assert.equal(packages['node_modules/@modelcontextprotocol/server']?.version, '2.4.0');
  assert.equal(packages['packages/cli/node_modules/@modelcontextprotocol/client']?.version, '2.3.1');
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
    env: { ...process.env },
  });

  // A child that never started or was signalled reports `status: null`; say
  // why, so a lost host race is diagnosable instead of `null !== 1`.
  const detail = JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr.slice(-500) });
  assert.equal(result.status, 1, `verifier exit status ${result.status}: ${detail}`);
  assert.match(result.stderr, /Node target must use HTTPS unless it is an explicit loopback host/);
});
