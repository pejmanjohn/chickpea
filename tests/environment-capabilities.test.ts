import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CAPABILITY_SECTION_BEGIN,
  CAPABILITY_SECTION_END,
  mergeCapabilitySection,
  readEnvironmentCapabilities,
  renderCapabilityTable,
  writeCapabilityMatrix,
  // @ts-expect-error Deployment tooling JavaScript helper.
} from '../scripts/lib/environment-capabilities.mjs';
// @ts-expect-error Deployment tooling JavaScript helper.
import { runEnvironmentCli } from '../scripts/chickpea-environment.mjs';

type Run = { status: number | null; stdout: string; stderr: string; error?: Error };
type Lane = Record<string, unknown>;

const AMBER_VERSION = '3ad70ce3-2456-4f43-ac8d-d311713885b0';
const COBALT_VERSION = 'b9e79052-02e5-4a8b-bdcb-de1f14d63b67';
const VIOLET_VERSION = '3d69034a-c402-4eae-a77f-4e64102ebcf9';
const SECRET_VALUE = 'sk-this-value-must-never-appear';
const NO_CREDENTIALS = { CHICKPEA_LANE_CREDENTIALS_DIR: join(tmpdir(), 'chickpea-capabilities-absent') };

function lane(target: string, workerName: string, servingVersion: string, extra: Lane = {}): Lane {
  return {
    target,
    health: 'ready',
    workerName,
    transport: 'gateway',
    workspaceLabel: `Chickpea ${target.charAt(0).toUpperCase()}${target.slice(1)}`,
    missingActorAliases: [],
    setupFlowUnprovenSince: null,
    servingVersion,
    sourceSha: 'b84d459b2929d59568cc43facb169fee80806734',
    claim: null,
    verifierLock: 'clear',
    ...extra,
  };
}

const LANES = [
  lane('amber', 'amber-worker', AMBER_VERSION, {
    missingActorAliases: ['env-amber-primary-actor'],
    setupFlowUnprovenSince: '59655b2f9227962235c4cb216f8b7b91a7afe5d8',
    claim: { holderId: 'holder-0123456789abcdef', branch: 'claude/some-branch', expiresAt: '2026-09-25T00:00:00.000Z' },
  }),
  lane('cobalt', 'cobalt-worker', COBALT_VERSION),
  lane('violet', 'violet-worker', VIOLET_VERSION),
];

function ok(value: unknown): Run {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' };
}

/** A fake Wrangler: per-Worker secrets, versions, and bindings. */
function fakeWrangler(workers: Record<string, {
  secrets?: string[] | 'fail';
  versions?: string[] | 'fail' | 'missing';
  bindings?: Record<string, unknown[]>;
  unreachable?: boolean;
}>) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<Run> => {
    calls.push(args);
    const name = args[args.indexOf('--name') + 1] ?? '';
    const worker = workers[name];
    if (!worker || worker.unreachable) {
      return { status: 1, stdout: '', stderr: `connect ETIMEDOUT token=${SECRET_VALUE}` };
    }
    if (worker.versions === 'missing') {
      return { status: 1, stdout: '', stderr: `Worker "${name}" not found [code: 10007]` };
    }
    if (args[0] === 'secret') {
      if (worker.secrets === 'fail') return { status: 1, stdout: '', stderr: 'forbidden' };
      return ok((worker.secrets ?? []).map((secretName: string) => ({ name: secretName, type: 'secret_text', value: SECRET_VALUE })));
    }
    if (args[0] === 'deployments') {
      if (worker.versions === 'fail') return { status: 1, stdout: '', stderr: 'boom' };
      const versions = worker.versions ?? [];
      return ok({ versions: versions.map((id: string) => ({ version_id: id, percentage: 100 / versions.length })) });
    }
    if (args[0] === 'versions') {
      const bindings = worker.bindings?.[args[2] ?? ''];
      return bindings ? ok({ resources: { bindings } }) : { status: 1, stdout: '', stderr: 'no version' };
    }
    throw new Error(`unexpected wrangler call ${args.join(' ')}`);
  };
  return { run, calls };
}

const SANDBOX_BINDING = { type: 'durable_object_namespace', name: 'SANDBOX', class_name: 'Sandbox' };
const TAG_STATE_BINDING = { type: 'durable_object_namespace', name: 'TAG_STATE', class_name: 'TagStateStore' };
const SECRET_BINDING = { type: 'secret_text', name: 'OPENAI_API_KEY', text: SECRET_VALUE };

function withCredentialsDir(files: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-capabilities-'));
  for (const file of files) writeFileSync(join(directory, file), '{}', { mode: 0o600 });
  return { env: { CHICKPEA_LANE_CREDENTIALS_DIR: directory }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function standardWorkers() {
  return fakeWrangler({
    'amber-worker': {
      secrets: ['OPENAI_API_KEY', 'BROWSERBASE_API_KEY', 'CHICKPEA_ENV_SEED_TOKEN', 'CHICKPEA_AUTH_SECRET'],
      versions: [AMBER_VERSION],
      bindings: { [AMBER_VERSION]: [TAG_STATE_BINDING, SECRET_BINDING] },
    },
    'cobalt-worker': {
      secrets: ['CHICKPEA_AUTH_SECRET'],
      versions: [COBALT_VERSION],
      bindings: { [COBALT_VERSION]: [TAG_STATE_BINDING, SANDBOX_BINDING] },
    },
    'violet-worker': { unreachable: true },
  });
}

test('fills each lane row from registry fields, Worker bindings, secret names, and the seed file', async () => {
  const credentials = withCredentialsDir(['amber-seed.json']);
  const wrangler = standardWorkers();
  try {
    const report = await readEnvironmentCapabilities('all', {
      readLanes: () => LANES,
      runWrangler: wrangler.run,
      env: credentials.env,
      now: () => Date.parse('2026-09-24T12:00:00.000Z'),
      providerContext: ['--profile', 'qa'],
    });
    assert.equal(report.schemaVersion, 'chickpea-environment-capabilities/v1');
    const [amber, cobalt, violet] = report.lanes;

    assert.equal(amber.profile, 'core');
    assert.equal(amber.liveVersion, AMBER_VERSION);
    assert.equal(amber.versionMatchesRegistry, true);
    assert.deepEqual(amber.secrets, {
      OPENAI_API_KEY: true, ANTHROPIC_API_KEY: false, OPENROUTER_API_KEY: false,
      BROWSERBASE_API_KEY: true, COMPOSIO_API_KEY: false, CHICKPEA_ENV_SEED_TOKEN: true,
    });
    assert.equal(amber.seedTokenFile, true);
    assert.deepEqual(amber.missingActorAliases, ['env-amber-primary-actor']);
    assert.equal(amber.claim.branch, 'claude/some-branch');
    assert.equal(amber.defaultChatModel, null);
    assert.equal(amber.modelRoles, 'unknown (check Admin)');
    assert.deepEqual(amber.errors, []);
    assert.equal(amber.reachable, true);

    assert.equal(cobalt.profile, 'sandbox');
    assert.equal(cobalt.secrets.OPENAI_API_KEY, false);
    assert.equal(cobalt.seedTokenFile, false);

    // One unreachable Worker marks only its own row.
    assert.equal(violet.reachable, false);
    assert.equal(violet.profile, 'unknown');
    assert.equal(violet.secrets, null);
    assert.deepEqual(violet.errors, ['WORKER_SECRETS_UNAVAILABLE', 'WORKER_DEPLOYMENT_UNAVAILABLE']);
    assert.equal(violet.transport, 'gateway');

    // Every Wrangler read is scoped to the lane's Worker and provider context.
    for (const call of wrangler.calls) {
      assert.ok(['secret', 'deployments', 'versions'].includes(call[0] ?? ''), call.join(' '));
      assert.deepEqual(call.slice(-4).slice(0, 1), ['--name']);
      assert.deepEqual(call.slice(-2), ['--profile', 'qa']);
    }

    const serialized = JSON.stringify(report) + renderCapabilityTable(report);
    assert.equal(serialized.includes(SECRET_VALUE), false, 'secret values never reach the report');
    assert.equal(serialized.includes('CHICKPEA_AUTH_SECRET'), false, 'only capability secret names are reported');
  } finally {
    credentials.cleanup();
  }
});

test('reports missing Workers, failed version views, split profiles, and registry drift per row', async () => {
  const other = '11111111-2222-4333-8444-555555555555';
  const wrangler = fakeWrangler({
    'amber-worker': { versions: 'missing' },
    'cobalt-worker': { secrets: [], versions: [COBALT_VERSION], bindings: {} },
    'violet-worker': {
      secrets: 'fail',
      versions: [VIOLET_VERSION, other],
      bindings: { [VIOLET_VERSION]: [SANDBOX_BINDING], [other]: [TAG_STATE_BINDING] },
    },
  });
  const drifted = [LANES[0], LANES[1], { ...LANES[2], servingVersion: other }];
  const report = await readEnvironmentCapabilities('all', { readLanes: () => drifted, runWrangler: wrangler.run, env: NO_CREDENTIALS });
  const [amber, cobalt, violet] = report.lanes;
  assert.deepEqual(amber.errors, ['WORKER_NOT_FOUND']);
  assert.deepEqual(cobalt.errors, ['WORKER_VERSION_UNAVAILABLE']);
  assert.equal(cobalt.liveVersion, COBALT_VERSION);
  assert.equal(cobalt.profile, 'unknown');
  assert.equal(violet.profile, 'mixed');
  assert.equal(violet.liveVersion, null, 'a split deployment has no single live version');
  assert.deepEqual(violet.errors, ['WORKER_SECRETS_UNAVAILABLE']);

  const table = renderCapabilityTable(report);
  assert.match(table, /\| Amber \| ready; read errors: WORKER_NOT_FOUND \| unknown \|/u);
  assert.match(table, /\| Violet \| ready; read errors: WORKER_SECRETS_UNAVAILABLE \| mixed \| unknown \| unknown \| unknown \/ no \|/u);
});

test('flags a live version that differs from the registry serving version', async () => {
  const wrangler = fakeWrangler({
    'cobalt-worker': { secrets: [], versions: [COBALT_VERSION], bindings: { [COBALT_VERSION]: [] } },
  });
  const report = await readEnvironmentCapabilities('cobalt', {
    readLanes: (target: string) => {
      assert.equal(target, 'cobalt');
      return [{ ...LANES[1], servingVersion: VIOLET_VERSION }];
    },
    runWrangler: wrangler.run,
    env: NO_CREDENTIALS,
  });
  assert.equal(report.lanes[0].versionMatchesRegistry, false);
  assert.match(renderCapabilityTable(report), /b9e79052 \(registry 3d69034a\)/u);
});

test('refuses unknown targets and invalid provider context', async () => {
  await assert.rejects(readEnvironmentCapabilities('fern', { readLanes: () => [] }), { code: 'INVALID_TARGET' });
  await assert.rejects(
    readEnvironmentCapabilities('all', { readLanes: () => [], providerContext: ['--account', 'x'] }),
    { code: 'INVALID_PROVIDER_CONTEXT' },
  );
});

test('rewrites only the generated section and keeps hand-written notes', () => {
  const report = { generatedAt: '2026-09-24T12:00:00.000Z', lanes: [] };
  const table = (marker: string) => `${CAPABILITY_SECTION_BEGIN}\n${marker}\n${CAPABILITY_SECTION_END}`;
  const handWritten = '# Lane capability matrix (private)\n\nIntro note.\n\n## Update notes\nKeep me.\n';

  const inserted = mergeCapabilitySection(handWritten, table('first'));
  assert.equal(inserted, `# Lane capability matrix (private)\n\n${table('first')}\n\nIntro note.\n\n## Update notes\nKeep me.\n`);

  const replaced = mergeCapabilitySection(inserted, table('second'));
  assert.equal(replaced, inserted.replace('first', 'second'));

  assert.equal(mergeCapabilitySection(undefined, table('new')), `# Lane capability matrix (private)\n\n${table('new')}\n`);
  assert.throws(() => mergeCapabilitySection(`${CAPABILITY_SECTION_BEGIN}\nno end`, table('x')), { code: 'CAPABILITY_MATRIX_SECTION_INVALID' });
  assert.throws(() => mergeCapabilitySection(`${table('a')}\n${table('b')}`, table('x')), { code: 'CAPABILITY_MATRIX_SECTION_INVALID' });
  assert.throws(() => mergeCapabilitySection(`${CAPABILITY_SECTION_END}\n${CAPABILITY_SECTION_BEGIN}`, table('x')), { code: 'CAPABILITY_MATRIX_SECTION_INVALID' });

  const directory = mkdtempSync(join(tmpdir(), 'chickpea-capability-matrix-'));
  try {
    const matrixPath = join(directory, 'lane-capabilities.md');
    writeFileSync(matrixPath, handWritten, { mode: 0o644 });
    const first = writeCapabilityMatrix(report, { matrixPath });
    assert.equal(first.created, false);
    const second = writeCapabilityMatrix(report, { matrixPath });
    assert.equal(second.path, matrixPath);
    const text = readFileSync(matrixPath, 'utf8');
    assert.equal(text.split(CAPABILITY_SECTION_BEGIN).length, 2, 'one generated section after repeated writes');
    assert.match(text, /## Update notes\nKeep me\.\n$/u);
    assert.equal(statSync(matrixPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI prints a table or JSON and writes the matrix only for all lanes', async () => {
  const credentials = withCredentialsDir([]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-capability-cli-'));
  const matrixPath = join(directory, 'lane-capabilities.md');
  const capabilityOptions = () => ({
    readLanes: () => LANES,
    runWrangler: standardWorkers().run,
    env: credentials.env,
    matrixPath,
  });
  try {
    let out = '';
    let err = '';
    const io = () => ({
      stdout: (value: string) => { out += value; },
      stderr: (value: string) => { err += value; },
      capabilityOptions: capabilityOptions(),
    });

    assert.equal(await runEnvironmentCli(['capabilities', 'all'], io()), 0);
    assert.match(out, /^\| Lane \| Health \| Profile \|/u);
    assert.match(out, /\| Cobalt \| ready \| sandbox \|/u);

    out = '';
    assert.equal(await runEnvironmentCli(['capabilities', 'all', '--json', '--write'], io()), 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.lanes.length, 3);
    assert.equal(parsed.matrix.path, matrixPath);
    assert.match(readFileSync(matrixPath, 'utf8'), /\| Amber \| ready \| core \|/u);

    err = '';
    assert.equal(await runEnvironmentCli(['capabilities', 'amber', '--write'], io()), 2);
    assert.deepEqual(JSON.parse(err), { error: 'INVALID_ARGUMENT' });

    err = '';
    assert.equal(await runEnvironmentCli(['capabilities'], io()), 2);
    assert.deepEqual(JSON.parse(err), { error: 'TARGET_REQUIRED' });

    err = '';
    assert.equal(await runEnvironmentCli(['status', '--json'], io()), 2);
    assert.deepEqual(JSON.parse(err), { error: 'INVALID_ARGUMENT' });

    err = '';
    assert.equal(await runEnvironmentCli(['capabilities', 'all', '--worktree', directory], io()), 2);
    assert.deepEqual(JSON.parse(err), { error: 'INVALID_ARGUMENT' });
  } finally {
    credentials.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reads lane model roles from the QA models route with the seed token', async () => {
  // @ts-expect-error Environment tooling JavaScript helper.
  const { readLaneModels } = await import('../scripts/lib/environment-capabilities.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-capabilities-models-'));
  try {
    const token = 'T'.repeat(43);
    writeFileSync(join(directory, 'amber-seed.json'), JSON.stringify({ target: 'amber', seedToken: token }), { mode: 0o600 });
    writeFileSync(join(directory, 'amber-live.json'), JSON.stringify({ origin: 'https://amber.example.workers.dev' }), { mode: 0o600 });
    const env = { CHICKPEA_LANE_CREDENTIALS_DIR: directory };
    const calls: string[] = [];
    const fetchImpl = async (url: URL, init: RequestInit) => {
      calls.push(`${url.href} ${new Headers(init.headers).get('authorization') === `Bearer ${token}`}`);
      return Response.json({
        schemaVersion: 'chickpea-environment-models/v1', target: 'amber',
        defaultChatModel: 'openai/gpt-5.6-terra', imageModel: '<script>',
      });
    };
    const models = await readLaneModels({ target: 'amber' }, env, fetchImpl);
    assert.deepEqual(models, { defaultChatModel: 'openai/gpt-5.6-terra', imageModel: null });
    assert.deepEqual(calls, ['https://amber.example.workers.dev/internal/environment/models true']);
    assert.equal(await readLaneModels({ target: 'amber' }, env, async () => new Response('{}', { status: 404 })), undefined);
    assert.equal(await readLaneModels({ target: 'cobalt' }, env, fetchImpl), undefined, 'no seed token file');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
