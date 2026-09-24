import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// @ts-expect-error Deployment tooling JavaScript helper.
import { describeLaneSecrets, fingerprint, parseLaneSecrets, resolveLaneSecrets } from '../scripts/lib/lane-secrets.mjs';

// mkdtemp creates an owner-only (0700) directory, which the reader requires.
function withLaneFile(contents: string, mode = 0o600): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-lane-secrets-'));
  const path = join(directory, 'qa-secrets.env');
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const noEnv = {};

test('shares plain names across lanes and lets a lane prefix override one', () => {
  const file = withLaneFile([
    '# standing QA keys',
    'OPENAI_API_KEY=sk-shared',
    'export BROWSERBASE_API_KEY="bb-shared"',
    "COBALT__OPENAI_API_KEY='sk-cobalt'",
    'ANTHROPIC_API_KEY=',
    'ASANA_QA_TOKEN=asana-token',
    '',
  ].join('\n'));
  try {
    const amber = resolveLaneSecrets('amber', { env: noEnv, file: file.path });
    assert.deepEqual(amber.secrets, { BROWSERBASE_API_KEY: 'bb-shared', OPENAI_API_KEY: 'sk-shared' });
    assert.deepEqual(amber.held, ['ASANA_QA_TOKEN']);

    const cobalt = resolveLaneSecrets('cobalt', { env: noEnv, file: file.path });
    assert.equal(cobalt.secrets.OPENAI_API_KEY, 'sk-cobalt');
    assert.equal(cobalt.report.find((entry: { name: string }) => entry.name === 'OPENAI_API_KEY').source, 'cobalt override');
    assert.equal('ANTHROPIC_API_KEY' in cobalt.secrets, false, 'empty values are skipped');
  } finally {
    file.cleanup();
  }
});

test('uploads a Composio key only from its own lane override and warns about a shared one', () => {
  const file = withLaneFile('COMPOSIO_API_KEY=shared-composio\nAMBER__COMPOSIO_API_KEY=amber-composio\n');
  try {
    const amber = resolveLaneSecrets('amber', { env: noEnv, file: file.path });
    assert.equal(amber.secrets.COMPOSIO_API_KEY, 'amber-composio');
    assert.deepEqual(amber.warnings, []);
    const cobalt = resolveLaneSecrets('cobalt', { env: noEnv, file: file.path });
    assert.equal('COMPOSIO_API_KEY' in cobalt.secrets, false);
    assert.equal(cobalt.held.includes('COMPOSIO_API_KEY'), false);
    const line = describeLaneSecrets(cobalt);
    assert.match(line, /WARNING: shared COMPOSIO_API_KEY ignored; set COBALT__COMPOSIO_API_KEY/);
    assert.doesNotMatch(line, /shared-composio|amber-composio/);
  } finally {
    file.cleanup();
  }
});

test('reports names and fingerprints but never values', () => {
  const file = withLaneFile('OPENAI_API_KEY=sk-very-secret\nASANA_QA_TOKEN=asana-secret\n');
  try {
    const line = describeLaneSecrets(resolveLaneSecrets('violet', { env: noEnv, file: file.path }));
    assert.match(line, /OPENAI_API_KEY \(shared, sha256:[0-9a-f]{8}\)/);
    assert.match(line, /not uploaded \(for seeding\): ASANA_QA_TOKEN/);
    assert.doesNotMatch(line, /very-secret|asana-secret/);
    assert.equal(fingerprint('sk-very-secret'), fingerprint('sk-very-secret'));
  } finally {
    file.cleanup();
  }
});

test('does nothing for production, a missing default file, or when turned off', () => {
  const file = withLaneFile('OPENAI_API_KEY=sk-shared\n');
  try {
    assert.equal(resolveLaneSecrets(undefined, { env: noEnv, file: file.path }), undefined);
    assert.equal(resolveLaneSecrets('production', { env: noEnv, file: file.path }), undefined);
    assert.equal(resolveLaneSecrets('amber', { env: { CHICKPEA_LANE_SECRETS: 'off' }, file: file.path }), undefined);
    assert.equal(resolveLaneSecrets('amber', { env: noEnv, file: join(dirname(file.path), 'absent.env') }), undefined);
    assert.throws(
      () => resolveLaneSecrets('amber', { env: { CHICKPEA_LANE_SECRETS_FILE: '/nowhere/qa.env' }, file: '/nowhere/qa.env' }),
      /does not exist/,
    );
  } finally {
    file.cleanup();
  }
});

test('refuses loose permissions, unknown lane prefixes, and malformed lines without echoing values', () => {
  const loose = withLaneFile('OPENAI_API_KEY=sk\n', 0o644);
  try {
    assert.throws(() => resolveLaneSecrets('amber', { env: noEnv, file: loose.path }), /private, owner-controlled/);
  } finally {
    loose.cleanup();
  }
  const typo = withLaneFile('COBALTT__OPENAI_API_KEY=sk\n');
  try {
    assert.throws(() => resolveLaneSecrets('amber', { env: noEnv, file: typo.path }), /unknown lane prefix/);
  } finally {
    typo.cleanup();
  }
  assert.throws(() => parseLaneSecrets('OPENAI_API_KEY sk-leaky'), (error: Error) =>
    /line 1/.test(error.message) && !error.message.includes('sk-leaky'));
  assert.throws(() => parseLaneSecrets('A=1\nA=2'), /twice/);
  assert.throws(() => parseLaneSecrets('lower=1'), /upper-case/);
});
