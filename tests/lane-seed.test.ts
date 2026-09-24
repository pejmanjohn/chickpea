import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// @ts-expect-error Operator tooling JavaScript helper.
import { buildSeedRequest, describeResults, laneOrigin, parseArguments, parseManifest } from '../scripts/lane-seed.mjs';
// @ts-expect-error Deployment tooling JavaScript helper.
import { ensureLaneSeedToken, laneSecretValue, parseLaneSecrets, readLaneSeedToken } from '../scripts/lib/lane-secrets.mjs';

function privateDirectory(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'chickpea-lane-seed-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test('creates one owner-only seed token per lane and reuses it', () => {
  const directory = privateDirectory();
  try {
    const env = { CHICKPEA_LANE_CREDENTIALS_DIR: directory.path };
    assert.equal(readLaneSeedToken('amber', { env }), undefined);
    const token = ensureLaneSeedToken('amber', { env });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(ensureLaneSeedToken('amber', { env }), token);
    assert.equal(readLaneSeedToken('amber', { env }), token);
    assert.notEqual(ensureLaneSeedToken('cobalt', { env }), token);
    assert.equal(statSync(join(directory.path, 'amber-seed.json')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(directory.path, 'amber-seed.json'), 'utf8')).target, 'amber');
    assert.equal(ensureLaneSeedToken('amber', { env: { ...env, CHICKPEA_LANE_SECRETS: 'off' } }), undefined);
    assert.equal(ensureLaneSeedToken('production', { env }), undefined);
  } finally {
    directory.cleanup();
  }
});

test('refuses a loose or malformed seed token file', () => {
  const directory = privateDirectory();
  try {
    const env = { CHICKPEA_LANE_CREDENTIALS_DIR: directory.path };
    const file = join(directory.path, 'violet-seed.json');
    writeFileSync(file, JSON.stringify({ target: 'amber', seedToken: 'A'.repeat(43) }), { mode: 0o600 });
    assert.throws(() => readLaneSeedToken('violet', { env }), /malformed/);
    writeFileSync(file, JSON.stringify({ target: 'violet', seedToken: 'A'.repeat(43) }));
    chmodSync(file, 0o644);
    assert.throws(() => readLaneSeedToken('violet', { env }), /private, owner-controlled/);
  } finally {
    directory.cleanup();
  }
});

test('builds the request from the manifest and lane-specific secret values', () => {
  const connections = parseManifest(JSON.stringify({
    schemaVersion: 'chickpea-lane-seed/v1',
    connections: [
      { connector: 'asana', secret: 'ASANA_QA_TOKEN' },
      { connector: 'zendesk', secret: 'ZENDESK_QA_TOKEN', fields: { workspaceSubdomain: 'acme' } },
      { connector: 'gmail' },
    ],
  }));
  const entries = parseLaneSecrets('ASANA_QA_TOKEN=shared\nCOBALT__ASANA_QA_TOKEN=cobalt-only\nZENDESK_QA_TOKEN=\n');
  assert.equal(laneSecretValue(entries, 'amber', 'ASANA_QA_TOKEN'), 'shared');
  const { body, missing } = buildSeedRequest({ lane: 'cobalt', agentId: 'qa-agent', connections, entries });
  assert.deepEqual(body, {
    agentId: 'qa-agent',
    connections: [
      { connector: 'asana', credential: 'cobalt-only' },
      { connector: 'zendesk', fields: { workspaceSubdomain: 'acme' } },
      { connector: 'gmail' },
    ],
  });
  assert.deepEqual(missing, ['ZENDESK_QA_TOKEN']);
  assert.throws(() => parseManifest('{"schemaVersion":"other","connections":[]}'), /chickpea-lane-seed\/v1/);
  assert.throws(() => parseManifest(JSON.stringify({ schemaVersion: 'chickpea-lane-seed/v1', connections: [{ connector: 'asana', secret: 'lower' }] })), /invalid secret/);
});

test('validates arguments, the lane origin, and prints results without credentials', () => {
  assert.throws(() => parseArguments(['production', '--agent', 'qa']), /Choose a lane/);
  assert.throws(() => parseArguments(['amber']), /--agent/);
  assert.equal(parseArguments(['amber', '--agent', 'qa-agent', '--dry-run']).dryRun, true);
  const directory = privateDirectory();
  try {
    const env = { CHICKPEA_LANE_CREDENTIALS_DIR: directory.path };
    writeFileSync(join(directory.path, 'amber-live.json'), JSON.stringify({ origin: 'https://amber.example.workers.dev/' }));
    assert.equal(laneOrigin('amber', env), 'https://amber.example.workers.dev');
    writeFileSync(join(directory.path, 'cobalt-live.json'), JSON.stringify({ origin: 'http://cobalt.example' }));
    assert.throws(() => laneOrigin('cobalt', env), /https URL/);
  } finally {
    directory.cleanup();
  }
  const lines = describeResults({ connections: [
    { connector: 'asana', status: 'created', connectionId: 'connection_1' },
    { connector: 'linear', status: 'needs_consent', adminUrl: 'https://lane/admin/x' },
  ] });
  assert.match(lines[0], /asana\s+created\s+connection_1/);
  assert.match(lines[1], /linear\s+needs_consent\s+https:\/\/lane\/admin\/x/);
});

test('--fixtures targets the standing fixtures Agent, --replace is forwarded, and --bind explains why it is absent', () => {
  const fixtures = parseArguments(['cobalt', '--fixtures', '--replace']);
  assert.equal(fixtures.fixtures, true);
  assert.equal(fixtures.replace, true);
  assert.equal(fixtures.agentId, undefined);
  assert.equal(parseArguments(['cobalt', '--agent', 'qa-agent']).fixtures, false);
  assert.throws(() => parseArguments(['cobalt', '--fixtures', '--agent', 'qa-agent']), /either --fixtures or --agent/);
  assert.throws(() => parseArguments(['cobalt', '--fixtures', '--bind', 'run-agent']), /exactly one Agent/);

  const connections = [{ connector: 'asana', secret: 'ASANA_QA_TOKEN' }];
  const entries = parseLaneSecrets('ASANA_QA_TOKEN=token\n');
  assert.deepEqual(
    buildSeedRequest({ lane: 'cobalt', fixtures: true, replace: true, connections, entries }).body,
    { fixtures: true, replace: true, connections: [{ connector: 'asana', credential: 'token' }] },
  );
  assert.deepEqual(
    buildSeedRequest({ lane: 'cobalt', agentId: 'qa-agent', connections, entries }).body,
    { agentId: 'qa-agent', connections: [{ connector: 'asana', credential: 'token' }] },
  );
  const [stale] = describeResults({ connections: [
    { connector: 'asana', status: 'stale', connectionId: 'connection_1', reason: 'changed' },
  ] });
  assert.match(stale, /asana\s+stale\s+connection_1 changed/);
});
