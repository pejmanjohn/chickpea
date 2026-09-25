import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Operator tooling JavaScript helper.
import { parseManifest } from '../scripts/lane-seed.mjs';
// @ts-expect-error Deployment tooling JavaScript helper.
import { resolveLaneAuthorityCredentials } from '../scripts/lib/environment-preflight.mjs';
// @ts-expect-error Deployment tooling JavaScript helper.
import { describeLaneSecrets, readLaneSeedToken, resolveLaneSecrets } from '../scripts/lib/lane-secrets.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/cloud-private-home.mjs', import.meta.url));
const LANE_SECRETS_CLI = fileURLToPath(new URL('../scripts/lib/lane-secrets.mjs', import.meta.url));

// Obviously fake fixture values; the assertions below prove none of them is ever printed.
const SECRETS_ENV = [
  '# standing QA keys',
  'OPENAI_API_KEY=fixture-openai-value-1',
  'COBALT__OPENAI_API_KEY="fixture-openai-value-2"',
  'ASANA_QA_TOKEN=fixture-asana-value-3',
  '',
].join('\n');
const SEED_TOKEN = 'fixture-seed-token-'.padEnd(43, 'x');
const AUTHORITY_TOKEN = 'fixture-authority-value-4';
const CREDENTIALS = {
  'amber-live.json': { origin: 'https://amber.example.test/', authorityReadToken: AUTHORITY_TOKEN },
  'amber-seed.json': { schemaVersion: 'chickpea-lane-seed-token/v1', target: 'amber', seedToken: SEED_TOKEN },
};
const SEED_MANIFEST = `${JSON.stringify({
  schemaVersion: 'chickpea-lane-seed/v1',
  connections: [{ connector: 'asana', secret: 'ASANA_QA_TOKEN' }, { connector: 'gmail' }],
}, null, 2)}\n`;
const VALUES = ['fixture-openai-value-1', 'fixture-openai-value-2', 'fixture-asana-value-3', AUTHORITY_TOKEN, SEED_TOKEN];

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const wrapped = (text: string) => b64(text).replace(/.{60}/gu, '$&\n');
const ALL_VARIABLES = {
  CHICKPEA_QA_SECRETS_ENV_B64: wrapped(SECRETS_ENV),
  CHICKPEA_LANE_CREDENTIALS_B64: b64(JSON.stringify(CREDENTIALS)),
  CHICKPEA_QA_SEED_JSON_B64: b64(SEED_MANIFEST),
};

function temporaryHome(): { path: string; cleanup: () => void } {
  const path = mkdtempSyncCompat();
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function mkdtempSyncCompat(): string {
  const path = join(tmpdir(), `chickpea-cloud-home-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

type Run = { status: number | null; stdout: string; stderr: string };

// `remote: null` leaves CLAUDE_CODE_REMOTE unset.
function run(home: string, variables: Record<string, string>, { args = [] as string[], remote = 'true' as string | null } = {}): Run {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, ...variables };
  if (remote !== null) env.CLAUDE_CODE_REMOTE = remote;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertNoValues(result: Run): void {
  for (const value of VALUES) {
    assert.equal(result.stdout.includes(value), false, `stdout must not carry a value: ${result.stdout}`);
    assert.equal(result.stderr.includes(value), false, `stderr must not carry a value: ${result.stderr}`);
  }
}

const mode = (path: string) => lstatSync(path).mode & 0o777;
const chickpea = (home: string) => join(home, '.chickpea');

test('writes the lane secrets file, lane credentials, and seed manifest owner-only from base64 variables', () => {
  const home = temporaryHome();
  try {
    const result = run(home.path, ALL_VARIABLES);
    assert.equal(result.status, 0, result.stderr);
    assertNoValues(result);
    assert.match(result.stdout, /wrote .*qa-secrets\.env \(3 names\)/u);
    assert.match(result.stdout, /wrote amber-live\.json, amber-seed\.json in .*lane-credentials/u);
    assert.match(result.stdout, /wrote .*qa-seed\.json \(2 connections\)/u);
    assert.equal(result.stderr, '');

    const root = chickpea(home.path);
    const secretsFile = join(root, 'qa-secrets.env');
    const credentialsDir = join(root, 'lane-credentials');
    const manifestFile = join(root, 'qa-seed.json');
    assert.equal(mode(root), 0o700);
    assert.equal(mode(credentialsDir), 0o700);
    for (const file of [secretsFile, join(credentialsDir, 'amber-live.json'), join(credentialsDir, 'amber-seed.json'), manifestFile]) {
      assert.equal(mode(file), 0o600, file);
      assert.equal(lstatSync(file).isSymbolicLink(), false);
    }
    assert.equal(readFileSync(secretsFile, 'utf8'), SECRETS_ENV);
    assert.deepEqual(JSON.parse(readFileSync(join(credentialsDir, 'amber-live.json'), 'utf8')), CREDENTIALS['amber-live.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(credentialsDir, 'amber-seed.json'), 'utf8')), CREDENTIALS['amber-seed.json']);
    assert.equal(readFileSync(manifestFile, 'utf8'), SEED_MANIFEST);
    assert.deepEqual(readdirSync(root).sort(), ['lane-credentials', 'qa-secrets.env', 'qa-seed.json'], 'no temporary files remain');

    // The readers accept the files exactly as they accept the maintainer's own.
    const amber = resolveLaneSecrets('amber', { env: {}, file: secretsFile });
    assert.deepEqual(amber.report.map((entry: { name: string; source: string }) => [entry.name, entry.source]), [['OPENAI_API_KEY', 'shared']]);
    assert.match(amber.report[0].fingerprint, /^sha256:[0-9a-f]{8}$/u);
    assert.deepEqual(amber.held, ['ASANA_QA_TOKEN']);
    const line = describeLaneSecrets(amber);
    for (const value of VALUES) assert.equal(line.includes(value), false);
    assert.equal(readLaneSeedToken('amber', { env: { CHICKPEA_LANE_CREDENTIALS_DIR: credentialsDir } }), SEED_TOKEN);
    assert.deepEqual(resolveLaneAuthorityCredentials('amber', { env: {}, credentialsRoot: credentialsDir }), {
      url: 'https://amber.example.test/internal/environment/authority',
      token: AUTHORITY_TOKEN,
      source: 'lane-credentials',
    });
    assert.equal(parseManifest(readFileSync(manifestFile, 'utf8')).length, 2);

    // `npm run lane:secrets -- amber` against the written HOME reports names and fingerprints only.
    const cli = spawnSync(process.execPath, [LANE_SECRETS_CLI, 'amber'], { env: { PATH: process.env.PATH ?? '', HOME: home.path }, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^amber: Lane secrets from .*qa-secrets\.env: OPENAI_API_KEY \(shared, sha256:[0-9a-f]{8}\); held \(not Worker secrets\): ASANA_QA_TOKEN\n$/u);
    for (const value of VALUES) assert.equal(cli.stdout.includes(value), false);

    // A second session start rewrites the same files in place.
    const again = run(home.path, ALL_VARIABLES);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(secretsFile, 'utf8'), SECRETS_ENV);
    assert.equal(mode(secretsFile), 0o600);
  } finally {
    home.cleanup();
  }
});

test('does nothing outside a cloud session and skips absent or blank variables silently', () => {
  const home = temporaryHome();
  try {
    for (const remote of ['false', '', null]) {
      const result = run(home.path, ALL_VARIABLES, { remote });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(existsSync(chickpea(home.path)), false);
    }
    const absent = run(home.path, {});
    assert.deepEqual([absent.status, absent.stdout, absent.stderr], [0, '', '']);
    assert.equal(existsSync(chickpea(home.path)), false);
    const blank = run(home.path, { CHICKPEA_QA_SEED_JSON_B64: ' \n ', CHICKPEA_LANE_CREDENTIALS_B64: '' });
    assert.deepEqual([blank.status, blank.stdout, blank.stderr], [0, '', '']);
    assert.equal(existsSync(chickpea(home.path)), false);
    const empty = run(home.path, { CHICKPEA_LANE_CREDENTIALS_B64: b64('{}') });
    assert.deepEqual([empty.status, empty.stdout, empty.stderr], [0, '', '']);
  } finally {
    home.cleanup();
  }
});

test('refuses a malformed variable by name, never echoes its value, and leaves no file behind', () => {
  const cases: Array<[string, string, RegExp, string]> = [
    ['CHICKPEA_QA_SECRETS_ENV_B64', 'not base64!!', /is not base64/u, 'not base64!!'],
    ['CHICKPEA_QA_SECRETS_ENV_B64', b64('lower=fixture-lower-value-5'), /not an upper-case name/u, 'fixture-lower-value-5'],
    ['CHICKPEA_QA_SECRETS_ENV_B64', b64('TEAL__OPENAI_API_KEY=fixture-teal-value-6\n'), /unknown lane prefix/u, 'fixture-teal-value-6'],
    ['CHICKPEA_QA_SECRETS_ENV_B64', Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), /UTF-8/u, '\u{fffd}'],
    ['CHICKPEA_LANE_CREDENTIALS_B64', b64('[]'), /JSON object keyed by file name/u, '[]'],
    ['CHICKPEA_LANE_CREDENTIALS_B64', b64('{"production-live.json": {}}'), /entry 1 is not a lane credential file name/u, 'production-live'],
    ['CHICKPEA_LANE_CREDENTIALS_B64', b64('{"amber-live.json": "fixture-string-value-7"}'), /amber-live\.json must be a JSON object/u, 'fixture-string-value-7'],
    ['CHICKPEA_LANE_CREDENTIALS_B64', b64(JSON.stringify({ 'amber-seed.json': { target: 'amber', seedToken: 'fixture-short-value-8' } })), /amber-seed\.json is not a lane seed token file/u, 'fixture-short-value-8'],
    ['CHICKPEA_LANE_CREDENTIALS_B64', b64(JSON.stringify({ 'cobalt-seed.json': { target: 'amber', seedToken: SEED_TOKEN } })), /cobalt-seed\.json is not a lane seed token file/u, SEED_TOKEN],
    ['CHICKPEA_LANE_CREDENTIALS_B64', b64(JSON.stringify({ 'violet-live.json': { origin: 'fixture-origin-value-9', authorityReadToken: 'fixture-token-value-10' } })), /violet-live\.json needs an http\(s\) origin/u, 'fixture-token-value-10'],
    ['CHICKPEA_QA_SEED_JSON_B64', b64('{"schemaVersion":"other","connections":[{"connector":"fixture-connector-11"}]}'), /schemaVersion "chickpea-lane-seed\/v1"/u, 'fixture-connector-11'],
  ];
  for (const [variable, value, expected, secret] of cases) {
    const home = temporaryHome();
    try {
      const result = run(home.path, { ...ALL_VARIABLES, [variable]: value });
      assert.equal(result.status, 1, `${variable} must be refused: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`^cloud-private-home: ${variable}`, 'u'));
      assert.match(result.stderr, expected);
      assert.equal(result.stderr.includes(secret), false, `stderr must not echo the value: ${result.stderr}`);
      assert.equal(result.stdout, '', 'nothing is written before every variable parses');
      assertNoValues(result);
      const root = chickpea(home.path);
      const leftovers = existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((name) => !['lane-credentials'].includes(name)) : [];
      assert.deepEqual(leftovers, [], `${variable}: no file or staging directory may remain`);
    } finally {
      home.cleanup();
    }
  }
});

test('refuses to write through a symlink or into a shared directory', () => {
  const home = temporaryHome();
  try {
    const root = chickpea(home.path);
    mkdirSync(root, { mode: 0o700 });
    const elsewhere = join(home.path, 'elsewhere.env');
    writeFileSync(elsewhere, 'OPENAI_API_KEY=fixture-elsewhere-value-12\n', { mode: 0o600 });
    symlinkSync(elsewhere, join(root, 'qa-secrets.env'));
    const linked = run(home.path, { CHICKPEA_QA_SECRETS_ENV_B64: b64(SECRETS_ENV) });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /^cloud-private-home: CHICKPEA_QA_SECRETS_ENV_B64: The lane secrets file must be a private, owner-controlled/u);
    assert.equal(readFileSync(elsewhere, 'utf8'), 'OPENAI_API_KEY=fixture-elsewhere-value-12\n', 'the link target is untouched');
    assertNoValues(linked);

    rmSync(join(root, 'qa-secrets.env'));
    mkdirSync(join(root, 'lane-credentials'), { mode: 0o755 });
    const shared = run(home.path, { CHICKPEA_LANE_CREDENTIALS_B64: b64(JSON.stringify(CREDENTIALS)) });
    assert.equal(shared.status, 1);
    assert.match(shared.stderr, /^cloud-private-home: CHICKPEA_LANE_CREDENTIALS_B64: The lane credentials directory must be a private/u);
    assert.deepEqual(readdirSync(join(root, 'lane-credentials')), []);
    assert.equal(statSync(join(root, 'lane-credentials')).mode & 0o777, 0o755, 'an existing directory is never re-permissioned');
    assertNoValues(shared);
  } finally {
    home.cleanup();
  }
});

test('encode prints the variables from the files on this machine and round-trips through a fresh HOME', () => {
  const source = temporaryHome();
  const target = temporaryHome();
  try {
    const nothing = run(source.path, {}, { args: ['encode'], remote: null });
    assert.equal(nothing.status, 1);
    assert.equal(nothing.stdout, '');
    assert.match(nothing.stderr, /no private files under .*\.chickpea to encode/u);

    assert.equal(run(source.path, ALL_VARIABLES).status, 0);
    const encoded = run(source.path, {}, { args: ['encode'], remote: null });
    assert.equal(encoded.status, 0, encoded.stderr);
    assert.match(encoded.stderr, /carry secrets/u);
    const lines = encoded.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.map((line) => line.slice(0, line.indexOf('='))), [
      'CHICKPEA_QA_SECRETS_ENV_B64', 'CHICKPEA_LANE_CREDENTIALS_B64', 'CHICKPEA_QA_SEED_JSON_B64',
    ]);
    for (const value of VALUES) assert.equal(encoded.stdout.includes(value), false, 'values travel base64-encoded, never in clear');
    const variables = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

    const restored = run(target.path, variables);
    assert.equal(restored.status, 0, restored.stderr);
    for (const relative of ['qa-secrets.env', 'lane-credentials/amber-live.json', 'lane-credentials/amber-seed.json', 'qa-seed.json']) {
      assert.equal(readFileSync(join(chickpea(target.path), relative), 'utf8'), readFileSync(join(chickpea(source.path), relative), 'utf8'), relative);
    }

    const usage = run(source.path, {}, { args: ['encode', 'extra'], remote: null });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^Usage: node scripts\/cloud-private-home\.mjs \[encode\]/u);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});
